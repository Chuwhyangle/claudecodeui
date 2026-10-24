/**
 * The decision queue's 「反方」(counter-voice): one model call per pending ruling, produced from
 * a FRESH context, cached, bounded, and never in the way of the ruling itself.
 *
 * WHY IT EXISTS. A person's value in a ruling is a sharper, more oblique judgment, not a more
 * complete one. A model is agreeable by nature, and liaison sessions tend to agree with each
 * other too, so a system built out of a person's beliefs amplifies those beliefs — including
 * their mistakes. When the person rules, the system's job is therefore not to agree: it is to
 * cover the breadth the person is not responsible for. This module supplies that breadth as a
 * counter-voice: what the leaning direction ignores, the strongest counter-example, and what
 * result would falsify the preferred option.
 *
 * A FRESH CONTEXT, BY CONSTRUCTION. The model receives the question, the typed options and the
 * evidence references — never a conversation transcript, never a session history. There is no
 * field on {@link CounterVoiceSubject} that could carry one, so the isolation is a property of
 * the input shape rather than a prompt instruction a later edit could forget.
 *
 * NOT IN THE WAY OF THE DECISION. A read answers from the cache when it can; otherwise it makes
 * one call and caches the answer, keyed by the queue item's `attentionId`. The cockpit asks for
 * it on a separate request, so the ruling buttons never wait for it, and a failure or a spent
 * budget leaves the ruling fully usable.
 *
 * WHAT BOUNDS IT.
 *   · `cockpit.counterVoice.enabled` must be on AND a gateway, a model and a key resolved;
 *   · at most `maxPerHour` calls per process (a sliding hour); past that a read answers
 *     「未生成：限额」 without paying for a call;
 *   · every call — success or failure — appends one usage record to the reply-suggestions
 *     usage ledger, so the spend is auditable alongside the other model tiers.
 *
 * Consumers: `quay.routes.ts` (the `GET /initiatives/:attentionId/counter-voice` route) and the
 * counter-voice criterion in `tests/counter-voice.test.ts`.
 */
import {
  ApiCredential,
  completeReplySuggestions,
  createReplySuggestionsUsageLog,
  type ReplySuggestionsCompletion,
  type ReplySuggestionsCompletionRequest,
} from '@/modules/reply-suggestions/index.js';

import {
  createCounterVoiceSettingsSource,
  type CounterVoiceSettings,
} from './counter-voice-settings.js';

/** The label that accompanies every model-written counter-voice. */
export const COUNTER_VOICE_ADVISORY = '仅作建议';

/** The stated reason on a read that found the hour's calls already spent. */
export const COUNTER_VOICE_LIMIT_REASON = '未生成：限额';

/** The stated reason on a read whose feature is switched off (or has no gateway/model/key). */
export const COUNTER_VOICE_DISABLED_REASON = '未生成：未启用';

/** How many ready counter-voices one process keeps; the oldest is dropped past this. */
const MAX_CACHED_COUNTER_VOICES = 500;

/** One hour, the window `maxPerHour` is counted over. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/** One typed option, as the queue carries it. */
export type CounterVoiceOption = {
  id: string;
  label: string;
};

/**
 * The ONLY input a counter-voice call may see: the question, the options and the evidence
 * references. There is deliberately no transcript, conversation, session or history field.
 *
 * Consumers: `quay.routes.ts` (built from the queue item) and the counter-voice criterion.
 */
export type CounterVoiceSubject = {
  attentionId: string;
  /** The initiative the ruling belongs to; used for the usage ledger and the cache address. */
  initiative: string;
  question: string;
  options: readonly CounterVoiceOption[];
  /** `uri` / `uri@locator` references the card showed; never their resolved contents. */
  evidence: readonly string[];
};

/**
 * One read's answer: a model-written counter-voice, or the reason none was produced.
 *
 * `kind` is the provenance marker the card shows: `llm` for a model-written reading, `none`
 * when no model output stands behind it (disabled, over budget or failed).
 *
 * Consumers: `quay.routes.ts` (relayed verbatim) and the cockpit's `DecisionQueue.tsx`.
 */
export type CounterVoiceReading =
  | {
      state: 'ready';
      kind: 'llm';
      /** What the leaning direction ignores. At least one line. */
      ignored: string[];
      /** The strongest counter-example or objection to the preferred option. */
      strongestCounter: string;
      /** The result that would falsify the preferred option. */
      falsifier: string;
      advisory: typeof COUNTER_VOICE_ADVISORY;
    }
  | {
      state: 'unavailable';
      kind: 'none';
      /** The card states this verbatim, e.g. 「未生成：限额」. */
      reason: string;
    };

/**
 * The ledger seam. Rows are a different shape from the reply-suggestions union, so this is the
 * ledger's broad file-level contract; the concrete reply-suggestions writer is assignable to it.
 */
type CounterVoiceUsageLog = {
  readonly path: string;
  write(record: Record<string, unknown>): void;
};

/**
 * What the service needs from the world; production supplies every default.
 *
 * Consumers: `quay.routes.ts` (no options — the process-wide defaults) and the criterion (a
 * stub completion, a memory ledger, an injected clock and its own settings).
 */
export type CounterVoiceDependencies = {
  /** The settings reading, re-read per request so an edit reaches the next question. */
  readSettings?: () => CounterVoiceSettings;
  /** The completion seam. Defaults to the reply-suggestions client. */
  complete?: (request: ReplySuggestionsCompletionRequest) => Promise<ReplySuggestionsCompletion>;
  /** The usage ledger. Defaults to the reply-suggestions JSONL ledger. */
  usageLog?: CounterVoiceUsageLog;
  /** The clock. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * The seam the routes call.
 *
 * Consumers: `quay.routes.ts` and the counter-voice criterion.
 */
export type CounterVoiceService = {
  read(subject: CounterVoiceSubject): Promise<CounterVoiceReading>;
};

/** A non-empty string field, or null. */
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The system instruction: a counter-voice from a fresh context, JSON only, no invention.
 *
 * Kept here (not in settings) because it is the feature's shape, not an operator knob.
 */
const SYSTEM_PROMPT = [
  '你在为一个等待人裁定的问题充当「反方」。你只有这个问题、它的选项和证据引用，没有此前的对话。',
  '你的职责不是附和，而是补上人不负责的那部分广度：指出所倾向方向忽略了什么、给出最强的反例、说明什么结果会证伪它。',
  '不得编造问题、选项或证据引用里没有的事实、数字、文件或测量值。不确定就明说。',
  '只输出 JSON：{"ignored": ["…"], "strongestCounter": "…", "falsifier": "…"}',
  '- ignored：这个方向忽略了什么（1-4 条，每条一句）。',
  '- strongestCounter：最强的反例或反对理由（一句）。',
  '- falsifier：什么结果或观察会证伪所倾向的选项（一句）。',
].join('\n');

/**
 * Builds the user turn from the subject's three fields and nothing else.
 *
 * `ignored` etc. are produced by the model; this function only lays the allowed input out. A
 * transcript or a session summary has no place here, and adding one would have to change the
 * {@link CounterVoiceSubject} shape first.
 */
function buildUserPrompt(subject: CounterVoiceSubject): string {
  const lines: string[] = [`问题：${subject.question}`, '', '选项：'];
  if (subject.options.length === 0) {
    lines.push('- （没有给出选项）');
  } else {
    for (const option of subject.options) {
      lines.push(`- ${option.label}（id: ${option.id}）`);
    }
  }
  lines.push('', '证据引用：');
  if (subject.evidence.length === 0) {
    lines.push('- （没有证据引用）');
  } else {
    for (const evidence of subject.evidence) {
      lines.push(`- ${evidence}`);
    }
  }
  return lines.join('\n');
}

/**
 * Reads the model's answer into the three declared segments.
 *
 * Throws when the answer is not the declared JSON shape; the caller turns that into the
 * ordinary failure path (the card states the reason, the ruling stays available).
 */
function parseCounterVoiceAnswer(text: string): {
  ignored: string[];
  strongestCounter: string;
  falsifier: string;
} {
  const withoutFence = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型输出中没有 JSON 对象');
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence.slice(start, end + 1));
  } catch (failure) {
    throw new Error(`模型输出不是合法 JSON：${failure instanceof Error ? failure.message : String(failure)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型输出的 JSON 不是对象');
  }
  const record = parsed as Record<string, unknown>;

  const ignored = Array.isArray(record.ignored)
    ? record.ignored
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim())
    : [];
  if (ignored.length === 0) throw new Error('模型输出缺少非空的 ignored 列表');

  const strongestCounter = stringValue(record.strongestCounter);
  if (strongestCounter === null) throw new Error('模型输出缺少非空的 strongestCounter');

  const falsifier = stringValue(record.falsifier);
  if (falsifier === null) throw new Error('模型输出缺少非空的 falsifier');

  return { ignored, strongestCounter, falsifier };
}

/**
 * Builds the counter-voice service over its injected world.
 *
 * A ready reading is cached per `attentionId`; a concurrent read of the same item joins the
 * in-flight call instead of paying for a second one. Failures and budget skips are NOT cached:
 * both are transient, and a cached 「未生成：限额」 would outlive the hour that caused it.
 *
 * Consumers: `quay.routes.ts` (production defaults) and the counter-voice criterion.
 */
export function createCounterVoice(dependencies: CounterVoiceDependencies = {}): CounterVoiceService {
  const readSettings = dependencies.readSettings ?? createCounterVoiceSettingsSource().read;
  const complete = dependencies.complete ?? completeReplySuggestions;
  const usageLog: CounterVoiceUsageLog = dependencies.usageLog ?? createReplySuggestionsUsageLog();
  const now = dependencies.now ?? (() => Date.now());

  // The ready readings, oldest first, so the map's insertion order doubles as the eviction order.
  const cache = new Map<string, CounterVoiceReading>();
  const inFlight = new Map<string, Promise<CounterVoiceReading>>();

  // The sliding hour. Per-process by design: the ledger is the long-lived record, this array
  // is the cheap gate in front of one more call.
  const callTimes: number[] = [];

  /** Prunes the sliding hour and answers how many calls it still holds. */
  const callsInTheLastHour = (at: number): number => {
    while (callTimes.length > 0 && at - (callTimes[0] ?? at) >= ONE_HOUR_MS) callTimes.shift();
    return callTimes.length;
  };

  /** One ledger line per call. Token counts and duration make the spend auditable. */
  const writeUsage = (record: {
    at: number;
    subject: CounterVoiceSubject;
    model: string;
    state: 'ok' | 'failed';
    reason?: string;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number;
  }): void => {
    try {
      usageLog.write({
        type: 'cockpit.counter-voice',
        at: record.at,
        attentionId: record.subject.attentionId,
        initiative: record.subject.initiative,
        model: record.model,
        state: record.state,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        durationMs: record.durationMs,
      });
    } catch {
      // A full or unwritable ledger must not fail the card; the reading is already decided.
    }
  };

  /** One read that is allowed to call the model. Never rejects. */
  const generate = async (subject: CounterVoiceSubject): Promise<CounterVoiceReading> => {
    try {
      const settings = readSettings();
      if (!settings.enabled) {
        return { state: 'unavailable', kind: 'none', reason: COUNTER_VOICE_DISABLED_REASON };
      }

      const at = now();
      if (callsInTheLastHour(at) >= settings.maxPerHour) {
        return { state: 'unavailable', kind: 'none', reason: COUNTER_VOICE_LIMIT_REASON };
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
        user: buildUserPrompt(subject),
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
      };

      const startedAt = now();
      let completion: ReplySuggestionsCompletion;
      try {
        completion = await complete(request);
      } catch (failure) {
        const detail = failure instanceof Error ? failure.message : String(failure);
        writeUsage({
          at: startedAt,
          subject,
          model: settings.model,
          state: 'failed',
          reason: detail,
          inputTokens: null,
          outputTokens: null,
          durationMs: Math.max(0, now() - startedAt),
        });
        return { state: 'unavailable', kind: 'none', reason: `未生成：模型调用失败：${detail}` };
      }

      let answer: ReturnType<typeof parseCounterVoiceAnswer>;
      try {
        answer = parseCounterVoiceAnswer(completion.text);
      } catch (failure) {
        const detail = failure instanceof Error ? failure.message : String(failure);
        writeUsage({
          at: startedAt,
          subject,
          model: settings.model,
          state: 'failed',
          reason: detail,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          durationMs: Math.max(0, now() - startedAt),
        });
        return { state: 'unavailable', kind: 'none', reason: `未生成：模型输出不可用：${detail}` };
      }

      writeUsage({
        at: startedAt,
        subject,
        model: settings.model,
        state: 'ok',
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        durationMs: Math.max(0, now() - startedAt),
      });
      return {
        state: 'ready',
        kind: 'llm',
        ignored: answer.ignored,
        strongestCounter: answer.strongestCounter,
        falsifier: answer.falsifier,
        advisory: COUNTER_VOICE_ADVISORY,
      };
    } catch (failure) {
      // The settings reader is designed not to throw, but a card must never be the place the
      // server first learns otherwise.
      const detail = failure instanceof Error ? failure.message : String(failure);
      return { state: 'unavailable', kind: 'none', reason: `未生成：${detail}` };
    }
  };

  return {
    read(subject: CounterVoiceSubject): Promise<CounterVoiceReading> {
      const cached = cache.get(subject.attentionId);
      if (cached !== undefined) return Promise.resolve(cached);

      const running = inFlight.get(subject.attentionId);
      if (running !== undefined) return running;

      const generation = generate(subject).then((reading) => {
        inFlight.delete(subject.attentionId);
        if (reading.state === 'ready') {
          cache.set(subject.attentionId, reading);
          while (cache.size > MAX_CACHED_COUNTER_VOICES) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
        }
        return reading;
      });
      inFlight.set(subject.attentionId, generation);
      return generation;
    },
  };
}
