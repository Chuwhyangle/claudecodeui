import type {
  QuayCarrierReading,
  QuayFanInAttemptSummary,
  QuayFanInSummary,
  QuaySuiteState,
  QuayTestRoundSummary,
  QuayTestsSummary,
} from '@/shared/types.js';
import { readNullableNumber, readNullableString } from '@/shared/utils.js';

/**
 * The Tests and Fan-in readings, taken through quay's own read-only verbs.
 *
 * Cloudpit used to parse three `.quay/` carrier files itself (`full-suite-state.json`,
 * `verification-round.jsonl`, `worker-outcome.jsonl`) — including a ~100 MB tail scan of the
 * rounds ledger. quay 0.24.0 publishes both readings as bounded JSON instead:
 *
 *   - `quay suite --json --limit 300` → `{ current, rounds, carrier, evaluated }`
 *   - `quay driver log --kind worker --json --limit 300` → `{ attempts, status, reason, window, … }`
 *
 * This module runs those two argv through an injected runner and adapts the documents to the
 * EXISTING `QuayTestsSummary` / `QuayFanInSummary` shapes, so a snapshot consumer cannot tell
 * which source produced the values. Two units need translating:
 *
 *  - `current.finishedAt` is ISO-8601 in the verb's output but Unix epoch SECONDS in
 *    `QuaySuiteState`, so the adapter converts it back (and reports `null` — never 0/NaN — when
 *    the instant is missing or unparseable).
 *  - the fan-in fields live under `attempts[i].mechanical_fan_in`; an attempt without that block
 *    never reached fan-in and is dropped rather than projected as an empty row.
 *
 * A verb that is missing (an older pinned CLI), exits non-zero with no output, returns non-JSON,
 * or omits the keys this adapter reads is reported as a `QuayCarrierReading` with
 * `verb-unavailable` / `failed` and a reason. It never falls back to reading the carrier files,
 * and it never invents an "empty history" in place of "could not read".
 */

/**
 * How many history records one reading keeps.
 *
 * 300 is sized from the pulse strip's widest window: 72h held 216 fan-in attempts on this
 * workspace when the reading was designed, and the round history is a similar order (197).
 * The Quay panel's own cards keep ten rows; the strip needs the window's real density, or its
 * "how active is this project" reading would be capped at the last ten attempts regardless of
 * the selected window.
 */
const QUAY_PULSE_HISTORY_LIMIT = 300;

/** The read-only argv for the Tests card. Kept exact so the service whitelist stays an equality check. */
export const QUAY_SUITE_READ_COMMAND: readonly string[] = [
  'suite',
  '--json',
  '--limit',
  String(QUAY_PULSE_HISTORY_LIMIT),
];

/** The read-only argv for the Fan-in card. Same shape and same window as the suite read. */
export const QUAY_FAN_IN_READ_COMMAND: readonly string[] = [
  'driver',
  'log',
  '--kind',
  'worker',
  '--json',
  '--limit',
  String(QUAY_PULSE_HISTORY_LIMIT),
];

/**
 * The injected process boundary. Structurally the service's `QuayCommandResult`; declared here
 * so this module has no runtime dependency back on `quay.service.ts` (which imports it).
 */
export type QuayVerbResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type QuayVerbRunner = (cwd: string, args: readonly string[]) => Promise<QuayVerbResult>;

/** Both cards' readings from one pair of verb invocations, plus how each reading was obtained. */
export type QuaySuiteFanInReading = {
  tests: QuayTestsSummary;
  fanIn: QuayFanInSummary;
  carrierReadings: {
    suite: QuayCarrierReading;
    fanIn: QuayCarrierReading;
  };
};

/** The carrier states the verbs themselves publish. `verb-unavailable` / `failed` are ours. */
const QUAY_VERB_CARRIER_STATES = ['ok', 'absent', 'unreadable', 'empty-writer-zero-records'] as const;

type QuayVerbCarrierState = (typeof QUAY_VERB_CARRIER_STATES)[number];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function readCarrierState(value: unknown): QuayVerbCarrierState | null {
  return typeof value === 'string' && (QUAY_VERB_CARRIER_STATES as readonly string[]).includes(value)
    ? (value as QuayVerbCarrierState)
    : null;
}

/**
 * The verb's ISO-8601 instant as Unix epoch SECONDS, or `null` when it is absent or unparseable.
 *
 * `null` is deliberate: 0 (`1970-01-01`) and `NaN` both read as a real instant somewhere
 * downstream, and neither is an honest answer to "when did the run finish".
 */
export function isoInstantToEpochSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const epochMs = Date.parse(value);
  if (Number.isNaN(epochMs)) {
    return null;
  }
  return Math.floor(epochMs / 1000);
}

/** Why a verb produced no usable document, in the same vocabulary the panel shows. */
function describeVerbFailure(result: QuayVerbResult, verb: string): string {
  // The panel renders this as one line inside a card. A CLI's "unknown command" path prints a
  // multi-line usage block, so keep the first non-empty line (which names the failure) and cap
  // it: the full text is still in the server log if anyone needs it.
  const raw = result.error || result.stderr.trim() || '';
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) {
    return firstLine.length > 240 ? `${firstLine.slice(0, 239)}…` : firstLine;
  }
  if (result.code !== null) {
    return `${verb} exited ${result.code} with no output`;
  }
  return `${verb} returned no output`;
}

type VerbDocumentRead =
  | { ok: true; document: Record<string, unknown> }
  | { ok: false; reading: QuayCarrierReading };

/**
 * Parses one verb's stdout, requiring the keys this adapter reads.
 *
 * No output at all is `verb-unavailable` when the child exited non-zero (an older CLI's
 * "unknown command" path) and `failed` when it exited zero. A body that is not JSON, or a JSON
 * object missing a required key, is `failed` — the verb answered, but not in its documented
 * shape.
 */
function readVerbDocument(
  result: QuayVerbResult,
  verb: string,
  requiredKeys: readonly string[],
): VerbDocumentRead {
  if (!result.stdout.trim()) {
    return {
      ok: false,
      reading: {
        state: result.ok ? 'failed' : 'verb-unavailable',
        reason: describeVerbFailure(result, verb),
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    return { ok: false, reading: { state: 'failed', reason: `${verb} returned output that is not JSON` } };
  }

  const document = asRecord(parsed);
  if (document === null) {
    return { ok: false, reading: { state: 'failed', reason: `${verb} returned a non-object document` } };
  }

  for (const key of requiredKeys) {
    if (!(key in document)) {
      return { ok: false, reading: { state: 'failed', reason: `${verb} output has no "${key}" key` } };
    }
  }

  return { ok: true, document };
}

/** Projects the verb's `current` object; `null` when it carries no usable `state` string. */
function summarizeSuiteState(value: unknown): QuaySuiteState | null {
  const record = asRecord(value);
  const state = record ? readNullableString(record.state) : null;
  if (!record || !state) {
    return null;
  }

  return {
    state,
    runner: readNullableString(record.runner),
    scope: readNullableString(record.scope),
    startedAt: readNullableString(record.startedAt),
    finishedAt: isoInstantToEpochSeconds(record.finishedAt),
    durationMs: readNullableNumber(record.durationMs),
    laneCount: readNullableNumber(record.laneCount),
    commit: readNullableString(record.commit),
    taskId: readNullableString(record.taskId),
    runId: readNullableString(record.runId),
  };
}

/** Projects the verb's `rounds` array; the heavy per-file detail is not in the document anyway. */
function summarizeTestRounds(value: unknown): QuayTestRoundSummary[] {
  return asArray(value).flatMap((item) => {
    const record = asRecord(item);
    const state = record ? readNullableString(record.state) : null;
    if (!record || !state) {
      return [];
    }

    return [
      {
        round: readCount(record.round),
        startedAt: readNullableString(record.startedAt),
        durationMs: readNullableNumber(record.durationMs),
        pass: readNullableNumber(record.pass),
        fail: readNullableNumber(record.fail),
        tests: readNullableNumber(record.tests),
        state,
      },
    ];
  });
}

/**
 * Keeps only the attempts whose record carries a `mechanical_fan_in` block, projected to the
 * Fan-in card's fields. Both lock instants are read from that NESTED block — the attempt's
 * top-level `outcome`/`step` fields are the same values but the lock readings exist only there.
 */
function summarizeFanInAttempts(value: unknown): QuayFanInAttemptSummary[] {
  return asArray(value).flatMap((item) => {
    const record = asRecord(item);
    const fanIn = record ? asRecord(record.mechanical_fan_in) : null;
    const task = record ? readNullableString(record.task) : null;
    const outcome = fanIn ? readNullableString(fanIn.outcome) : null;
    if (!task || !outcome) {
      return [];
    }

    return [
      {
        task,
        outcome,
        lockAcquireEpoch: readNullableNumber(fanIn?.lockAcquireEpoch),
        lockReleaseEpoch: readNullableNumber(fanIn?.lockReleaseEpoch),
      },
    ];
  });
}

/** Adapts one `quay suite` result, keeping the Tests card's shape unchanged. */
function adaptSuite(result: QuayVerbResult): { reading: QuayCarrierReading; tests: QuayTestsSummary } {
  const read = readVerbDocument(result, 'quay suite', ['current', 'rounds']);
  if (!read.ok) {
    return { reading: read.reading, tests: { current: null, recentRounds: [] } };
  }

  const carrier = asRecord(read.document.carrier);
  const carrierState = carrier ? readCarrierState(carrier.state) : null;
  const reading: QuayCarrierReading = carrierState === null
    ? { state: 'failed', reason: 'quay suite reported no carrier state' }
    : { state: carrierState, reason: readNullableString(carrier?.reason) };

  return {
    reading,
    tests: {
      current: summarizeSuiteState(read.document.current),
      recentRounds: summarizeTestRounds(read.document.rounds),
    },
  };
}

/** Adapts one `quay driver log` result, keeping the Fan-in card's shape unchanged. */
function adaptFanIn(result: QuayVerbResult): { reading: QuayCarrierReading; fanIn: QuayFanInSummary } {
  const read = readVerbDocument(result, 'quay driver log', ['attempts']);
  if (!read.ok) {
    return { reading: read.reading, fanIn: { recent: [] } };
  }

  const status = readCarrierState(read.document.status);
  const reading: QuayCarrierReading = status === null
    ? { state: 'failed', reason: 'quay driver log reported no carrier status' }
    : { state: status, reason: readNullableString(read.document.reason) };

  return { reading, fanIn: { recent: summarizeFanInAttempts(read.document.attempts) } };
}

/**
 * Runs both verbs (concurrently, one child each) and returns the two card readings plus how each
 * was obtained. The caller owns caching: this function always spawns.
 */
export async function readQuaySuiteAndFanIn(
  runner: QuayVerbRunner,
  projectPath: string,
): Promise<QuaySuiteFanInReading> {
  const [suiteResult, fanInResult] = await Promise.all([
    runner(projectPath, QUAY_SUITE_READ_COMMAND),
    runner(projectPath, QUAY_FAN_IN_READ_COMMAND),
  ]);

  const suite = adaptSuite(suiteResult);
  const fanIn = adaptFanIn(fanInResult);

  return {
    tests: suite.tests,
    fanIn: fanIn.fanIn,
    carrierReadings: { suite: suite.reading, fanIn: fanIn.reading },
  };
}
