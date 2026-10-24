/**
 * The session digest's SECOND tier: one cheap model call per finished turn, bounded and
 * annotated, layered on top of the deterministic reading.
 *
 * WHY A SECOND TIER. The deterministic digest (`session-digest.ts`) is read off the transcript:
 * verbatim excerpt, changed files, commands, test counts. It never says what the turn MEANT, nor
 * whether the work has drifted from the session's goal. Those are semantic judgments, so they
 * are produced only by a model, marked `tier: 'llm'`, and labelled 「仅建议」 wherever they show.
 *
 * WHAT BOUNDS IT (the wall must stay smaller than what it observes):
 *   · only a session on somebody's watch list — an automatic attention tile is already covered
 *     by the deterministic reading;
 *   · only a turn whose readable conclusion is at least `minTurnChars` long;
 *   · at most `maxPerHour` calls per process (a sliding hour); past that the object is marked
 *     「本轮未生成（限额）」 instead of paying for another call;
 *   · every call — success or failure — appends one usage record (time, session, model, tokens,
 *     duration) to the reply-suggestions usage ledger, so the spend is auditable.
 *
 * A MODEL FAILURE NEVER LOSES THE DETERMINISTIC READING. The tier re-reads the object the
 * deterministic producer just wrote and rewrites it with an `llm` block that says what happened;
 * the deterministic fields stay exactly as they were. An observation failure never propagates
 * into the chat turn either: `handleTurnEnd` answers the object (or null) and swallows its own
 * exceptions.
 *
 * The LLM conclusion, options and drift note live in the object's digest under `llm`; the UI
 * renders them from there. `driftNote` always carries {@link SESSION_DIGEST_LLM_ADVISORY}.
 *
 * Consumers: `server/modules/observation/index.ts` (it exports the composed producer under the
 * name the run registry already calls) and `tests/session-digest-llm.test.ts` (the criterion,
 * which injects a stub completion and a memory ledger).
 */
import { observationDb } from '@/modules/database/index.js';
import {
  ApiCredential,
  completeReplySuggestions,
  createReplySuggestionsUsageLog,
  type ReplySuggestionsCompletion,
  type ReplySuggestionsCompletionRequest,
} from '@/modules/reply-suggestions/index.js';

import type { ObservedObject, ObservationStore } from './observation-store.js';
import { createObservationStore } from './observation-store.js';
import { createSessionDigestProducer } from './session-digest.producer.js';
import type { SessionDigestProducer, SessionTurnEndEvent } from './session-digest.producer.js';
import {
  createSessionDigestLlmSettingsSource,
  type SessionDigestLlmSettings,
} from './session-digest-llm-settings.js';

/** The producer name stamped on every revision this tier writes. */
export const SESSION_DIGEST_LLM_PRODUCER = 'session-digest-llm';

/** The label that must accompany every semantic judgment this tier writes. */
export const SESSION_DIGEST_LLM_ADVISORY = '语义判断，仅作建议';

/** The stated reason on an object that was skipped because the hour's calls were spent. */
export const SESSION_DIGEST_LLM_LIMIT_REASON = '本轮未生成（限额）';

/** How many suggested reply options one digest may offer. */
export const SESSION_DIGEST_LLM_MAX_OPTIONS = 5;

/** One hour, the window `maxPerHour` is counted over. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/** What the tier writes under `digest.llm`. */
export type SessionDigestLlmReading =
  | {
      state: 'evaluated';
      conclusion: string;
      options: string[];
      driftNote: string | null;
      advisory: typeof SESSION_DIGEST_LLM_ADVISORY;
    }
  | { state: 'skipped'; reason: string }
  | { state: 'unevaluated'; reason: string };

/**
 * The digest tier appends its own `observation.session-digest-llm` rows to the
 * shared reply-suggestions ledger. Those rows are a different shape from the
 * reply-suggestions union (they carry `uri`, token counts and a state), so this
 * seam is deliberately the ledger's broad file-level contract; the concrete
 * reply-suggestions writer is assignable to it.
 */
type SessionDigestUsageLog = {
  readonly path: string;
  write(record: Record<string, unknown>): void;
};

/** What the tier needs from the world; production supplies every default. */
export type SessionDigestLlmTierDeps = {
  /** The deterministic producer whose revision this tier extends. */
  deterministic: SessionDigestProducer;
  /** The store the second revision is written through. */
  store: ObservationStore;
  /** The tier settings, re-read per turn so an edit reaches the next turn. */
  readSettings?: () => SessionDigestLlmSettings;
  /** The completion seam. Defaults to the reply-suggestions client. */
  complete?: (request: ReplySuggestionsCompletionRequest) => Promise<ReplySuggestionsCompletion>;
  /** Whether anyone pinned the object. Defaults to the observation watch entries. */
  isObserved?: (uri: string) => boolean;
  /** The usage ledger. Defaults to the reply-suggestions JSONL ledger. */
  usageLog?: SessionDigestUsageLog;
  /** The clock. Defaults to `Date.now`. */
  now?: () => number;
};

/** The tier's one verb, shaped exactly like the deterministic producer's. */
export type SessionDigestLlmTier = SessionDigestProducer;

/** A non-empty string field, or null. */
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The deterministic conclusion text, or null when the object carries no readable one. */
function deterministicConclusion(digest: Record<string, unknown>): string | null {
  const conclusion = digest.conclusion;
  if (conclusion === null || typeof conclusion !== 'object' || Array.isArray(conclusion)) return null;
  return stringValue((conclusion as Record<string, unknown>).text);
}

/** A string list from the deterministic digest, trimmed and non-empty. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

/** The turn's facts as one prompt block; every line is read off the deterministic digest. */
function buildUserPrompt(object: ObservedObject, conclusion: string): string {
  const digest = object.digest;
  const lines: string[] = [`会话标题（会话目标）：${object.title}`, '', '本轮助手最后一段（原文）：', '"""', conclusion, '"""'];
  const changedFiles = stringList(digest.changedFiles);
  if (changedFiles.length > 0) lines.push('', `本轮改动文件：${changedFiles.join('、')}`);
  const commands = stringList(digest.commands);
  if (commands.length > 0) lines.push(`本轮运行命令：${commands.slice(0, 8).join('；')}`);
  const tests = digest.tests;
  if (tests !== null && typeof tests === 'object' && !Array.isArray(tests)) {
    const reading = tests as Record<string, unknown>;
    if (reading.state === 'evaluated') {
      lines.push(`测试读数：${String(reading.runner ?? '')} 通过 ${String(reading.passed ?? '?')}、失败 ${String(reading.failed ?? '?')}`);
    } else if (typeof reading.reason === 'string') {
      lines.push(`测试读数：未评估（${reading.reason}）`);
    }
  }
  const asking = digest.askingYou;
  if (asking !== null && typeof asking === 'object' && !Array.isArray(asking)) {
    const question = (asking as Record<string, unknown>).question;
    if (typeof question === 'string' && question.trim() !== '') lines.push('', `助手在本轮明确提问：${question.trim()}`);
  }
  return lines.join('\n');
}

/** The system instruction: JSON only, semantic labels, no invention. */
const SYSTEM_PROMPT = [
  '你在为「观察墙」生成一轮会话的第二档摘要。这是语义判断，不是事实：不确定就不写。',
  '不得编造消息里没有的事实、数字、文件或测量值。',
  '只输出 JSON：{"conclusion": "…", "options": ["…"], "driftNote": "…"}',
  '- conclusion：一句话，说明这一轮做了什么、结论是什么。',
  '- options：仅当助手正在向用户提问时，给出 1-3 条用户可直接发送的回复；否则输出空数组。',
  '- driftNote：仅当这一轮明显偏离会话标题所示目标时写一句提示；否则省略该字段。',
].join('\n');

/**
 * Reads the model's answer into the digest's `llm` block.
 *
 * Throws when the answer is not the declared JSON shape; the caller turns that into the
 * ordinary failure path (deterministic digest preserved, reason written).
 */
export function parseLlmDigestAnswer(text: string): { conclusion: string; options: string[]; driftNote: string | null } {
  const withoutFence = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型输出中没有 JSON 对象');
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence.slice(start, end + 1));
  } catch (failure) {
    throw new Error(`模型输出不是合法 JSON: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型输出的 JSON 不是对象');
  }
  const record = parsed as Record<string, unknown>;
  const conclusion = stringValue(record.conclusion);
  if (conclusion === null) throw new Error('模型输出缺少非空的 conclusion');

  const options = Array.isArray(record.options)
    ? record.options
        .filter((option): option is string => typeof option === 'string' && option.trim() !== '')
        .map((option) => option.trim())
        .slice(0, SESSION_DIGEST_LLM_MAX_OPTIONS)
    : [];
  const driftNote = stringValue(record.driftNote);

  return { conclusion, options, driftNote };
}

/** Appends the advisory marker once, so a model that already wrote it is not marked twice. */
function withAdvisory(driftNote: string | null): string | null {
  if (driftNote === null) return null;
  return driftNote.includes(SESSION_DIGEST_LLM_ADVISORY)
    ? driftNote
    : `${driftNote}（${SESSION_DIGEST_LLM_ADVISORY}）`;
}

/** Reads the token counts the upstream reported, as flat ledger fields. */
function tokenFields(completion: ReplySuggestionsCompletion): { inputTokens: number | null; outputTokens: number | null } {
  return { inputTokens: completion.inputTokens, outputTokens: completion.outputTokens };
}

/**
 * Builds the tier over its injected world.
 *
 * The returned producer first awaits the deterministic write, then (only for an observed,
 * long-enough, within-budget turn) makes one model call and writes ONE more revision through
 * the same store. `handleTurnEnd` never rejects.
 */
export function createSessionDigestLlmTier(deps: SessionDigestLlmTierDeps): SessionDigestLlmTier {
  const store = deps.store;
  const readSettings = deps.readSettings ?? defaultSettingsSource().read;
  const complete = deps.complete ?? completeReplySuggestions;
  const isObserved = deps.isObserved ?? ((uri: string) => observationDb.listWatchUserIds(uri).length > 0);
  const usageLog: SessionDigestUsageLog = deps.usageLog ?? createReplySuggestionsUsageLog();
  const now = deps.now ?? (() => Date.now());

  // The sliding hour. It is per-process by design: the ledger is the long-lived record, this
  // array is the cheap gate in front of one more call.
  const callTimes: number[] = [];

  /** Writes the deterministic digest plus an `llm` block, preserving every other field. */
  const writeTierRevision = (
    object: ObservedObject,
    reading: SessionDigestLlmReading,
    event: SessionTurnEndEvent,
  ): ObservedObject => {
    const evaluated = reading.state === 'evaluated';
    return store.writeRevision({
      uri: object.uri,
      kind: 'session',
      title: object.title,
      status: object.status,
      digest: { ...object.digest, llm: reading },
      deltaItems: [],
      provenance: {
        producer: SESSION_DIGEST_LLM_PRODUCER,
        // A success is an LLM-written reading; a skip or a failure keeps the deterministic
        // document, and the tier says so rather than claiming a model produced it.
        tier: evaluated ? 'llm' : 'deterministic',
        evaluatedAt: event.completedAt || now(),
      },
    });
  };

  /** Prunes the sliding hour and answers how many calls it still holds. */
  const callsInTheLastHour = (at: number): number => {
    while (callTimes.length > 0 && at - (callTimes[0] ?? at) >= ONE_HOUR_MS) callTimes.shift();
    return callTimes.length;
  };

  async function handleTurnEnd(event: SessionTurnEndEvent): Promise<ObservedObject | null> {
    let object: ObservedObject | null;
    try {
      object = await deps.deterministic.handleTurnEnd(event);
    } catch {
      return null;
    }
    if (object === null) return object;

    try {
      const settings = readSettings();
      if (!settings.enabled) return object;
      if (!isObserved(object.uri)) return object;

      const conclusion = deterministicConclusion(object.digest);
      if (conclusion === null) return object;
      if (conclusion.length < settings.minTurnChars) return object;

      const at = now();
      if (callsInTheLastHour(at) >= settings.maxPerHour) {
        return writeTierRevision(object, { state: 'skipped', reason: SESSION_DIGEST_LLM_LIMIT_REASON }, event);
      }
      callTimes.push(at);

      const request: ReplySuggestionsCompletionRequest = {
        config: {
          protocol: settings.protocol,
          baseUrl: settings.baseUrl,
          model: settings.model,
          authScheme: settings.authScheme,
          credential: new ApiCredential(settings.apiKey),
          disableThinking: settings.disableThinking,
          timeoutMs: settings.timeoutMs,
        },
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(object, conclusion),
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
      };

      const startedAt = now();
      let completion: ReplySuggestionsCompletion;
      try {
        completion = await complete(request);
      } catch (failure) {
        const reason = failure instanceof Error ? failure.message : String(failure);
        writeUsage({ at: startedAt, object, model: settings.model, state: 'failed', reason, inputTokens: null, outputTokens: null, durationMs: Math.max(0, now() - startedAt) });
        return writeTierRevision(object, { state: 'unevaluated', reason: `模型调用失败：${reason}` }, event);
      }

      let answer: ReturnType<typeof parseLlmDigestAnswer>;
      try {
        answer = parseLlmDigestAnswer(completion.text);
      } catch (failure) {
        const reason = failure instanceof Error ? failure.message : String(failure);
        writeUsage({ at: startedAt, object, model: settings.model, state: 'failed', reason, ...tokenFields(completion), durationMs: Math.max(0, now() - startedAt) });
        return writeTierRevision(object, { state: 'unevaluated', reason: `模型输出不可用：${reason}` }, event);
      }

      const reading: SessionDigestLlmReading = {
        state: 'evaluated',
        conclusion: answer.conclusion,
        options: answer.options,
        driftNote: withAdvisory(answer.driftNote),
        advisory: SESSION_DIGEST_LLM_ADVISORY,
      };
      writeUsage({ at: startedAt, object, model: settings.model, state: 'ok', ...tokenFields(completion), durationMs: Math.max(0, now() - startedAt) });
      return writeTierRevision(object, reading, event);
    } catch {
      // The chat path must not learn that the second tier failed; the deterministic revision
      // (already written) is the reading the wall keeps.
      return object;
    }
  }

  /** One ledger line per call. Token counts and duration are the "用量可查" half of the task. */
  function writeUsage(record: {
    at: number;
    object: ObservedObject;
    model: string;
    state: 'ok' | 'failed';
    reason?: string;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number;
  }): void {
    try {
      usageLog.write({
        type: 'observation.session-digest-llm',
        at: record.at,
        uri: record.object.uri,
        sessionId: record.object.uri.replace(/^cloudcli:\/\/session\//, ''),
        model: record.model,
        state: record.state,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        durationMs: record.durationMs,
      });
    } catch {
      // A full or unwritable ledger must not fail the wall; the reading is already written.
    }
  }

  return { handleTurnEnd };
}

/** The one settings reading the process-wide producer uses (mtime-cached inside the source). */
let processSettingsSource: ReturnType<typeof createSessionDigestLlmSettingsSource> | null = null;

function defaultSettingsSource(): ReturnType<typeof createSessionDigestLlmSettingsSource> {
  if (processSettingsSource === null) processSettingsSource = createSessionDigestLlmSettingsSource();
  return processSettingsSource;
}

/**
 * The process-wide producer the observation barrel exports under the name the run registry
 * already calls: the deterministic write, then the bounded LLM tier.
 *
 * The store is the DB-backed default one and the push seam is not bound here (this writer is
 * reached from the websocket completion path, not from `server/index.ts`'s composition); the
 * wall reads revisions from the database, so the writes are complete without it.
 */
const processObservationStore = createObservationStore();

export const sessionDigestProducer: SessionDigestProducer = createSessionDigestLlmTier({
  deterministic: createSessionDigestProducer({ store: processObservationStore }),
  store: processObservationStore,
  readSettings: () => defaultSettingsSource().read(),
});
