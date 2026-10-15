/**
 * The voice relay's prompt, as a file the deployment can edit without a rebuild — and the ONE place
 * the C2 ContextPack is folded into it.
 *
 * WHY A FILE AT ALL. The relay prompt is the behaviour that gets tuned: P0a measured it, and the
 * next tuning SHOULD NOT need a code change plus a deploy to observe. So the prompt and the block
 * that introduces the pack live behind a path the deployment names
 * ({@link VOICE_REALTIME_SETTINGS_ENV}), and the shipped values are the defaults used when no file
 * is named.
 *
 * READ ONCE PER CONNECTION, AND THAT IS THE CONTRACT. `voice-realtime-ws-proxy.service.ts` calls
 * {@link loadVoiceRealtimeSettings} at the top of a connection and keeps the reading for that
 * connection's whole life. So an edit reaches the NEXT connection and leaves the live ones exactly
 * as they were — a session the user is speaking into must not have its instructions swapped under
 * it, because the Realtime model's behaviour is the thing being tuned and a mid-session swap makes
 * the change unattributable.
 *
 * THE KEY SET. Four top-level keys are read, and NO OTHERS are — an unknown key is ignored, exactly as
 * it always has been, rather than refused:
 *
 *   · `version`         — a non-empty string, logged beside every injection so an edit is visible.
 *   · `instructions`    — the relay prompt, a non-empty string.
 *   · `contextTemplate` — the block that introduces the pack; must carry `{{context}}`.
 *   · `turnDetection`   — the upstream detector's parameters, as the WIRE spells them:
 *                         `{ "type": "server_vad" | "semantic_vad", "threshold": -1…1,
 *                            "silence_duration_ms": 200…6000 }`. Every sub-key is optional and the ones
 *                         left out fall through to the environment, then to the shipped 800 ms window —
 *                         see {@link resolveTurnDetection}, which owns that precedence. Values are
 *                         validated HERE, through the resolver's own validator, so a refused value is
 *                         reported in {@link VoiceRealtimeSettings.problems} and the connection falls
 *                         back to the default rather than shipping a half-applied detector.
 *
 * FAIL OPEN ON I/O, FAIL CLOSED ON SHAPE. A missing, unreadable or unparseable file falls back to
 * the shipped defaults with the reason in {@link VoiceRealtimeSettings.problems}; a file that
 * PARSES but violates the contract (an unknown `{{variable}}`, a block that never carries the pack)
 * is refused the same way. The difference matters: a malformed shape would otherwise ship a prompt
 * that silently drops the pack — the exact thing this task exists to deliver — while a missing file
 * is a deployment that simply wants the defaults.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (the loader and the composer) and this module's
 * tests. Nothing outside the module reads it, so it stays off the barrel.
 */
import { readFileSync } from 'node:fs';

import {
  validateTurnDetection,
  type TurnDetectionValues,
} from './voice-realtime-turn-detection.js';

/**
 * The environment variable naming the settings file this server should read.
 *
 * Unset (or empty) means "use the shipped defaults", which is what a deployment gets today. The
 * seam on `VoiceRealtimeProxySeams` overrides it, so a criterion can point at a file of its own
 * without touching the environment.
 */
export const VOICE_REALTIME_SETTINGS_ENV = 'VOICE_REALTIME_SETTINGS_PATH';

/**
 * The line the pack is introduced under, taken verbatim from the injection P0a-S3 validated
 * (`experiments/voice-realtime-segmented/p0/s3-context-injection.mts`).
 *
 * It is spelled out rather than paraphrased for a reason: the model reads it as the boundary between
 * "how to relay" and "what the session has been about", and a rewording is a new prompt nobody has
 * measured.
 */
export const VOICE_REALTIME_CONTEXT_HEADER = '以下是当前 Claude Code 会话的上下文（用户看得见的内容，最新在后）。';

/**
 * The line the S-A execution-status block is introduced under (SPEC `§8.2`/`§8.3`, Draft-2).
 *
 * Unlike the pack's header, this one is NOT a measured prompt: it is new text this task adds, so it
 * is written to be short. It is stated in the instructions rather than in the injected line because
 * the line is machine-shaped (`[exec] key=value …`) and the model must be told how to use it.
 */
export const VOICE_REALTIME_STATUS_HEADER = '以下是当前 Claude Code 会话执行面的最新状态（仅在状态变化时更新，机器可读）。';

/**
 * SPEC §8.3's staleness threshold, in milliseconds — the age past which the injected line is no
 * longer the present and must not be spoken of as one.
 */
export const VOICE_REALTIME_STATUS_STALE_MS = 4000;

/**
 * The instruction-layer requirement that makes the line's `ageMs` actionable (SPEC §8.3, last row):
 * a line older than {@link VOICE_REALTIME_STATUS_STALE_MS} is HISTORY, and the model must not
 * restate the past as the present.
 *
 * The 2026-10-14 ruling withdrew `session_status` from the tools advertised to the relay model (it
 * is a pen, not an agent — see `VOICE_REALTIME_TOOLS`), so the rule no longer points the model at a
 * tool it can no longer see; it states the stale `ageMs` reading and the prohibition on restating
 * the past, and nothing else.
 *
 * The literal `ageMs > 4000` is written out — not interpolated from the constant — on purpose: the
 * model reads the number, and a criterion asserts the exact token. {@link VOICE_REALTIME_STATUS_STALE_MS}
 * is the same number for the code side.
 */
export const VOICE_REALTIME_STATUS_STALENESS_RULE =
  '该行的 ageMs 是这条状态的年龄；ageMs > 4000 的状态已过期，不得当作现状复述。';

/** The name `{{…}}` carries in {@link VOICE_REALTIME_CONTEXT_VARIABLE}; kept beside it so the two
 * cannot drift. */
const CONTEXT_VARIABLE_NAME = 'context';

/** The ONE template variable a settings file may use. Anything else in braces is refused. */
export const VOICE_REALTIME_CONTEXT_VARIABLE = `{{${CONTEXT_VARIABLE_NAME}}}`;

/** Where a reading came from: the shipped defaults, or a file that was read and accepted. */
export type VoiceRealtimeSettingsSource = 'default' | 'file';

/** One reading of the settings, good for exactly one connection. */
export type VoiceRealtimeSettings = {
  /** The relay prompt the session is opened with, with or without a pack. */
  instructions: string;
  /** The block that introduces the pack; always carries {@link VOICE_REALTIME_CONTEXT_VARIABLE}. */
  contextTemplate: string;
  /**
   * The file's `turnDetection`, VALIDATED: only the fields it named and this loader accepted. Empty when
   * the file named none (or was refused whole), which is what makes "the file said nothing" fall through
   * to the environment and then to the shipped default rather than pinning the shipped value here.
   */
  turnDetection: TurnDetectionValues;
  /** The compiled-in values, or the file's. */
  source: VoiceRealtimeSettingsSource;
  /** The file's own `version`, logged beside every injection so an edit is visible in the log. */
  version: string | null;
  /** The file that was read, or `null` when none was named. */
  path: string | null;
  /**
   * Why the file was refused, oldest first. Empty on success. A non-empty list means the DEFAULTS
   * are what {@link instructions}/{@link contextTemplate} hold, so a caller can log the reason
   * without ever having to decide what a half-valid file means.
   */
  problems: string[];
};

/** The shipped prompt: the relay rules plus the pack, exactly as P0a-S3 injected them. */
export function defaultVoiceRealtimeSettings(baseInstructions: string): {
  instructions: string;
  contextTemplate: string;
  turnDetection: TurnDetectionValues;
} {
  return {
    instructions: baseInstructions,
    contextTemplate: `${VOICE_REALTIME_CONTEXT_HEADER}\n\n${VOICE_REALTIME_CONTEXT_VARIABLE}`,
    // No file, no tuned detector: the empty object means "this source names nothing", so the resolver
    // falls through to the environment and then to its own shipped default.
    turnDetection: {},
  };
}

/** The `{{…}}` names a template uses, in order of appearance, without their braces. */
function templateVariables(template: string): string[] {
  return [...template.matchAll(/\{\{([^{}]*)\}\}/g)].map((match) => match[1] ?? '');
}

/**
 * Reads the settings for ONE connection.
 *
 * `baseInstructions` is the shipped prompt (`VoiceRealtimeProxySeams.instructions`) and is what the
 * defaults are built from; `settingsPath` overrides {@link VOICE_REALTIME_SETTINGS_ENV}, which
 * overrides `null` (the defaults). Never throws: every failure comes back as a default reading with
 * a reason in `problems`.
 */
export function loadVoiceRealtimeSettings(options: {
  baseInstructions: string;
  settingsPath?: string | undefined;
}): VoiceRealtimeSettings {
  const defaults = defaultVoiceRealtimeSettings(options.baseInstructions);
  const named = options.settingsPath ?? process.env[VOICE_REALTIME_SETTINGS_ENV];
  const filePath = typeof named === 'string' && named.trim() !== '' ? named : null;
  if (filePath === null) {
    return { ...defaults, source: 'default', version: null, path: null, problems: [] };
  }

  const refuse = (problem: string, version: string | null = null): VoiceRealtimeSettings => ({
    ...defaults,
    source: 'default',
    version,
    path: filePath,
    problems: [problem],
  });

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (failure) {
    return refuse(`could not read ${filePath}: ${failure instanceof Error ? failure.message : String(failure)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (failure) {
    return refuse(`${filePath} is not valid JSON: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse(`${filePath} must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  let version: string | null = null;
  if (record.version !== undefined) {
    if (typeof record.version !== 'string' || record.version.trim() === '') {
      return refuse(`${filePath}: \`version\` must be a non-empty string`);
    }
    version = record.version;
  }

  const problems: string[] = [];
  let instructions = defaults.instructions;
  if (record.instructions !== undefined) {
    if (typeof record.instructions !== 'string' || record.instructions.trim() === '') {
      problems.push('`instructions` must be a non-empty string');
    } else {
      instructions = record.instructions;
    }
  }

  let contextTemplate = defaults.contextTemplate;
  if (record.contextTemplate !== undefined) {
    if (typeof record.contextTemplate !== 'string' || record.contextTemplate.trim() === '') {
      problems.push('`contextTemplate` must be a non-empty string');
    } else {
      contextTemplate = record.contextTemplate;
    }
  }

  // The upstream detector's parameters. Validated by the RESOLVER'S OWN validator rather than by a
  // second copy of the ranges, so a file naming `silence_duration_ms: 100` and an environment exporting
  // the same 100 are refused with the same sentence — here through `problems`, which is the list this
  // deployment reads in its log. A refused field is DROPPED from the reading, so the connection falls
  // through to the environment and then to the shipped default instead of half-applying a bad file.
  let turnDetection: TurnDetectionValues = {};
  if (record.turnDetection !== undefined) {
    const validated = validateTurnDetection(record.turnDetection);
    turnDetection = validated.values;
    problems.push(...validated.problems);
  }

  // The shape of the block is a contract, not a preference: the pack has to reach the model, and a
  // template that never mentions the variable — or mentions one nobody defined — would either drop
  // the pack or send the model a literal `{{something}}`.
  const variables = templateVariables(contextTemplate);
  const unknownVariables = [...new Set(variables.filter((name) => name !== CONTEXT_VARIABLE_NAME))];
  if (unknownVariables.length > 0) {
    problems.push(`unknown template variable(s): ${unknownVariables.map((name) => `{{${name}}}`).join(', ')}`);
  }
  if (!variables.includes(CONTEXT_VARIABLE_NAME)) {
    problems.push(`\`contextTemplate\` must carry ${VOICE_REALTIME_CONTEXT_VARIABLE}`);
  }

  if (problems.length > 0) {
    return { ...defaults, source: 'default', version, path: filePath, problems };
  }
  return { instructions, contextTemplate, turnDetection, source: 'file', version, path: filePath, problems: [] };
}

/**
 * The session's `instructions` for one pack, and — when S-A has one — one execution-status line.
 *
 * An EMPTY pack leaves the prompt exactly as it was — no header, no blank lines, no "（空）" — so a
 * connection over a session with nothing said yet is byte-for-byte the pre-C2 behaviour. That is
 * also what keeps the no-context case measurable: a criterion can compare the composed string
 * against the base prompt and expect equality.
 *
 * `execStatus` is the S-A line (`[exec] phase=…`, SPEC §8.4) and is ABSENT until the execution
 * plane has something to say — a connection with no run started and nothing waiting composes to the
 * base prompt, which is what keeps the "no status, byte-identical" reading true. When it IS present,
 * the introduction and the staleness rule travel with it: the line is machine-shaped, and the model
 * must be told both what it is and that an old one is not the present.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts`'s `advertiseInstructions` (the one send path) and
 * this module's tests.
 */
export function composeVoiceRealtimeInstructions(
  settings: VoiceRealtimeSettings,
  contextText: string,
  execStatus?: string,
): string {
  const blocks: string[] = [];
  if (contextText.trim() !== '') {
    blocks.push(settings.contextTemplate.replace(VOICE_REALTIME_CONTEXT_VARIABLE, contextText));
  }
  if (execStatus !== undefined && execStatus.trim() !== '') {
    blocks.push(`${VOICE_REALTIME_STATUS_HEADER}\n${VOICE_REALTIME_STATUS_STALENESS_RULE}\n${execStatus}`);
  }
  if (blocks.length === 0) {
    return settings.instructions;
  }
  return `${settings.instructions}\n\n${blocks.join('\n\n')}`;
}
