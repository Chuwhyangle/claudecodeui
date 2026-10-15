/**
 * The live relay's own on-disk record — one diagnostic journal PER BROWSER CONNECTION.
 *
 * WHY IT EXISTS. Until this module, a Live Voice connection left NOTHING of its own behind: the
 * server wrote what it knew to stdout, and only the launcher's redirect
 * (`scripts/serve-scoped.sh`'s `StandardOutput=append:…/server.log`) put that on disk. That made two
 * questions unanswerable without grepping a process log — and one of them actively arithmetic:
 *
 *  - "what did THIS connection cost, response by response?" The usage line the proxy printed was a
 *    CONNECTION total, so the per-response text/audio split had to be re-derived from deltas and
 *    character counts;
 *  - "which segment produced which message, and how long did the send take?" The segment and
 *    `session_send` lines existed but only on the process's stdout stream.
 *
 * WHAT THIS MODULE OWNS. A small append-only store (a writer with an injectable directory, so a
 * criterion tests it without touching the real one) plus a RECORDER that tees a connection's live
 * events into it. The recorder is what `server/index.ts` wires into the two seams the proxy already
 * exposes — `log` (plain lines) and `observe` (raw wire frames) — so this is not a second assembly
 * point: the composition root keeps building the seams it always built and hands the recorder's two
 * methods the proxy already accepts.
 *
 * THE SHAPE ON DISK IS THE SHAPE OF THE READER'S QUESTION. One file per connection,
 * `<dir>/<connectionId>.jsonl`, one JSON ENTRY per line. The first entry is the connection
 * header (id, session, tag, segmented/continuous); after it come structured entries for the readings
 * an operator reconciles a bill with — per-response token counts WITH the text/audio split and the
 * estimated CNY, the per-connection running total, each segment's `seq`/duration/frames, each
 * `session_send`'s latency and outcome, each stop's audit record (who asked, on which utterance,
 * why, and how it ended), and each upstream session rotation — interleaved with the
 * proxy's own log lines, kept verbatim so the journal is a superset of the stdout record rather than
 * a summary that dropped what it did not classify.
 *
 * PERMISSIONS AND BOUNDS, following `voice-data.ts` deliberately. The directory is 0700 and every
 * file 0600, applied with an explicit `chmod` after each create (`mode:` alone is a request the
 * kernel applies through the process's umask). The directory is capped (`VOICE_REALTIME_LOG_MAX_BYTES`,
 * default {@link DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES}) and trimmed OLDEST FILE FIRST after each
 * append, so a long-running deployment cannot fill its disk with a journal nobody reads.
 *
 * FAIL-OPEN, AND THE STORE IS THE ONE THAT THROWS. `append` lets an I/O failure out; the RECORDER
 * catches it, reports it ONCE on the stdout stream, and keeps serving the live connection. A journal
 * that cannot be written must never cost the user the call it was describing — the same rule
 * `voice-data.ts` states for recordings, applied to the diagnostic half.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RealtimeSegmentForensics } from './voice-realtime-bridge.service.js';
import { estimateRealtimeCostCny } from './voice-realtime-dashscope-transport.js';
import { summarizeWireObservation } from './voice-realtime-diagnose.service.js';

/**
 * The directory's own name, under the database's parent — `~/.cloudcli/voice-realtime-log` by
 * default. The same SHAPE `voice-data.ts` uses, with its own leaf: a deployment that moved its
 * database moves its relay journal with it, and the two stores sit side by side rather than one
 * reaching for a second reading of the database configuration.
 */
const RELAY_LOG_DIRECTORY_NAME = 'voice-realtime-log';

/** The fallback database path the default directory is derived from, mirroring the other stores. */
const DEFAULT_DATABASE_FILE = '.cloudcli/auth.db';

/** The directory's mode and the files' mode, both applied explicitly (see the header). */
const RELAY_LOG_DIR_MODE = 0o700;
const RELAY_LOG_FILE_MODE = 0o600;

/** The suffix this store owns: one JSONL journal per connection. */
const ENTRY_EXTENSION = '.jsonl';

/**
 * The environment variable that moves the journal, and the one that resizes it.
 *
 * Read by the composition root and handed to the pure resolvers below, in the same
 * "the environment belongs to the assembly point" discipline `VOICE_DATA_DIR` follows.
 */
export const VOICE_REALTIME_LOG_DIR_ENV = 'VOICE_REALTIME_LOG_DIR';
export const VOICE_REALTIME_LOG_MAX_BYTES_ENV = 'VOICE_REALTIME_LOG_MAX_BYTES';

/**
 * The ceiling on the journal directory, in bytes, when the deployment names none: 64 MiB.
 *
 * A SHIPPED DEFAULT rather than a policy — the deployment's own variable overrides it, and the store
 * applies whatever it is told. It exists so a deployment that says nothing still has a bound.
 */
export const DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The smallest ceiling the variable may name: 1 KiB.
 *
 * The same floor, for the same reason, as `voice-data.ts`'s: a ceiling below one entry evicts every
 * file the moment it is written, which reads as "the journal is broken" rather than as "the cap is
 * tiny". A value below it is treated as unset, so a malformed cap cannot be the one that lets the
 * directory grow without a bound.
 */
export const MIN_VOICE_REALTIME_LOG_MAX_BYTES = 1024;

/** Whether the connection declared the segmented relay (`segmented-v1`) or stayed on the old wire. */
export type VoiceRealtimeLogMode = 'segmented' | 'continuous';

/**
 * One entry in a connection's journal.
 *
 * EVERY ENTRY CARRIES `connectionId`, because the store builds the file name from it and nothing else
 * — that is what keeps "one file per connection" a property of the data rather than of a second
 * argument the caller could get wrong.
 *
 * The `line` fields on the classified entries keep the proxy's ORIGINAL text beside the parsed
 * fields, so a reader who wants the human line still has it and a reader who wants the number reads
 * the field rather than re-parsing the line.
 */
export type VoiceRealtimeLogEntry =
  /** The header, written first: which connection this journal belongs to, and how it relayed. */
  | { at: string; kind: 'connection'; connectionId: string; sessionId: string; tag: string; mode: VoiceRealtimeLogMode }
  /** Any log line the classifier did not recognise, kept verbatim. */
  | { at: string; kind: 'log'; connectionId: string; line: string }
  /** The fixed prefix the first `session.update` installed: the tool count and the instructions size. */
  | { at: string; kind: 'prefix'; connectionId: string; tools: number; instructionsChars: number }
  /** One relay segment: the browser's `seq`, its wall-clock duration, and the frames it carried. */
  | { at: string; kind: 'segment'; connectionId: string; line: string; seq: number; durationMs: number; frames: number; reason: string }
  /** One `session_send`: how long it took and how it ended. `message` is the text actually delivered. */
  | {
      at: string;
      kind: 'session_send';
      connectionId: string;
      line: string;
      latencyMs: number;
      outcome: 'delivered' | 'failed' | 'not-delivered';
      message?: string;
      /** Why the relay never reached the session. Present on `not-delivered` only. */
      reason?: string;
      error?: string;
    }
  /** One upstream session rotation (SPEC §C3): which session replaced which, and the measured switch. */
  | { at: string; kind: 'rotation'; connectionId: string; line: string; from: number; to: number; idleMs: number; standbyAgeMs: number; switchMs: number }
  /**
   * One Silence Tail Suppression stage change (decision doc §10). Two per suppression episode: one
   * when the upload stops, one when it resumes.
   *
   * MACHINE-READ, NOT PROSE. The cost phase's question is "how many upstream seconds did this save",
   * and the answer is a subtraction between two connections' `suppressedMs` sums — which a reader
   * cannot do from a sentence. `tailMs` is the real noise the endpoint still received after each
   * utterance (the price), `suppressedMs` the audio withheld (the saving, known in full only at
   * `resumed`), and `preRollFrames` how much of that saving had to be repaid on resume.
   */
  | {
      at: string;
      kind: 'silence_tail';
      connectionId: string;
      event: 'suppressed' | 'resumed';
      tailMs: number;
      suppressedMs: number;
      preRollFrames: number;
    }
  /**
   * One stop the MODEL asked for (SPEC §6.2 / §10.3, C-3's "误停可审计"): which run it ended, which
   * utterance triggered it, what the model said it wanted and heard, what was still waiting behind
   * the stop, and how the stop ended.
   *
   * IT CARRIES NO `line`, unlike `segment` / `session_send` / `rotation`. Those keep the proxy's
   * original text beside the parsed fields because their readings are DERIVED from a human line; this
   * record is the other way round — the proxy prints a JSON payload it has already decided, and the
   * field set IS the reading. A reader answering "was this stop justified?" needs exactly the nine
   * fields, and a `line` here would be a tenth copy of the same nine.
   *
   * `intent` and `heard` are the model's own words about its own judgement, so `null` is a real
   * reading on both (an omitted `heard`; a stop that named no reason) and never a stand-in for "not
   * recorded". `intentMissing` is the flag that keeps those two apart for `intent`: a stop the model
   * sent with no reason is recorded (`null`) and FLAGGED rather than refused, so the reading stays
   * auditable instead of the stop vanishing.
   */
  | {
      at: string;
      kind: 'interrupt';
      connectionId: string;
      /** The run the stop was aimed at, from the L3 aggregator reading; `null` when there was none. */
      runId: string | null;
      /** The `utteranceSeq` of the last NON-EMPTY transcription; `null` before any was heard. */
      triggerSeq: number | null;
      /** The model's own statement of what the user wanted; `null` when it named none. */
      intent: string | null;
      /**
       * `true` when the stop named NO `intent` — the model omitted it, or sent a blank one. It is
       * recorded rather than refused (SPEC §6.2 / §10.3, C-3), and this flag is what tells "the model
       * gave no reason" apart from "a reason was dropped": with it, `intent: null` is a whole reading.
       */
      intentMissing: boolean;
      /** The transcription the judgement was made on, or `null` when the model named none. */
      heard: string | null;
      /** The backlog the stop did NOT throw away, read before the release. */
      queuedStillPending: number;
      /** The tool in flight at the stop, or `null`: the proxy has no reading for one and never guesses. */
      inFlightTool: string | null;
      /**
       * Whether this stop's aftermath note left the proxy ON THIS STOP'S OWN CORRECTION — the reading
       * that keeps the aftermath measurable when the note and the abort come apart (2026-10-16).
       *
       * A stop carrying a correction arms the note before enqueuing it, so the correction is what
       * carries the explanation of the interruption. Two things can then happen to the stop itself:
       * the abort stops a run (`outcome: 'aborted'`), or it finds none (`'no-run'`) / is refused
       * (`'refused'`) — and in the last two the message in the CLI announces an interruption the
       * record does not confirm. `true` beside those outcomes is what makes that visible; `false` is
       * every stop whose note was NOT spent on its own delivery, including every stop that carries no
       * correction at all (whose note is armed after the abort and rides a later message).
       */
      noteCarried: boolean;
      /** Who stopped it. `model` is the only caller of this path today (voice tool surface, D-2). */
      by: 'model';
      /**
       * `aborted` ended a run, `no-run` found none, `refused` never reached the abort, `covered` was
       * the interrupt FENCE turning a repeat away (SPEC §18.4 G2, GOAL-041 AC-343): the trigger
       * utterance's command had already been dequeued into the current run, or the same `triggerSeq`
       * had run once, so no second stop was issued and no `stopped` frame followed — the audit line
       * is the whole of what a covered call leaves behind.
       */
      outcome: 'aborted' | 'no-run' | 'refused' | 'covered';
    }
  /** One `response.done`: its own tokens with the text/audio split, and its own estimated CNY. */
  | {
      at: string;
      kind: 'response';
      connectionId: string;
      index: number;
      inputTokens: number;
      outputTokens: number;
      textTokens: number;
      audioTokens: number;
      costCny: number;
    }
  /** The connection's running total — the readable form of the usage line the proxy prints. */
  | {
      at: string;
      kind: 'usage';
      connectionId: string;
      responses: number;
      inputTokens: number;
      outputTokens: number;
      textTokens: number;
      audioTokens: number;
      costCny: number;
    }
  /**
   * One disconnect-forensics reading (2026-10-13): WHY a relay segment's audio did not come back —
   * the upstream closing the socket, the local replay budget being spent, or a transcript's answer
   * pairing with no commit of the open socket.
   *
   * A `class` ON THE ENTRY rather than only inside the text, because the question the next natural
   * recurrence has to answer is which of the three causes it was, and a reader that had to parse a
   * JSON blob to say so would be re-doing the classifier's job. `line` keeps the proxy's original
   * payload verbatim, so every field the bridge recorded survives even one this entry does not name —
   * the same "the journal is a superset of the lines" rule the unclassified `log` entry follows.
   */
  | {
      at: string;
      kind: 'segment_forensics';
      connectionId: string;
      line: string;
      /** Which of the three causes this reading attributes the loss to. */
      forensicsClass: RealtimeSegmentForensics['kind'];
      /** The socket generation the reading belongs to — the connection a close happened on. */
      socketEpoch: number;
    };

/** What a clear answers: how many connection journals were removed. */
export type VoiceRealtimeLogClearResult = { deleted: number };

/**
 * The store the recorder holds.
 *
 * `append` THROWS on an I/O failure and the recorder catches it — the store deliberately does not
 * swallow, so the failure has one owner (the call site that can keep the connection alive) and the
 * store stays an honest writer. `clear` mirrors `voice-data.ts`: a missing directory is `0`, not an
 * error, because "nothing here to clear" is the success case of a clear.
 */
export type VoiceRealtimeLogStore = {
  append(entry: VoiceRealtimeLogEntry): void;
  clear(): VoiceRealtimeLogClearResult;
  directory(): string;
};

/** What the store is built from: the directory the composition root already resolved, and its cap. */
export type VoiceRealtimeLogStoreOptions = {
  directory: string;
  /** The byte ceiling. Absent (or unusable) reads as {@link DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES}. */
  maxBytes?: number;
};

/**
 * Where the relay journal goes, from the two values the composition root read.
 *
 * The inputs are ARGUMENTS for the same reason `resolveVoiceDataDir`'s are: the environment belongs
 * to the composition root, and a resolver that read a variable itself could not be asked what a
 * given pair of values means without mutating the process first. An explicit directory wins;
 * otherwise the default sits BESIDE THE DATABASE.
 *
 * This only computes a path — the writer creates the directory on the first entry it actually writes.
 */
export function resolveVoiceRealtimeLogDir(raw: string | undefined, databasePath: string | undefined): string {
  const explicit = raw === undefined ? '' : raw.trim();
  if (explicit !== '') {
    return explicit;
  }

  const database =
    databasePath === undefined || databasePath.trim() === ''
      ? path.join(os.homedir(), DEFAULT_DATABASE_FILE)
      : databasePath;
  return path.join(path.dirname(database), RELAY_LOG_DIRECTORY_NAME);
}

/**
 * The byte ceiling to enforce, from the raw `VOICE_REALTIME_LOG_MAX_BYTES` reading.
 *
 * A value the store cannot act on — absent, non-numeric, non-finite, or below
 * {@link MIN_VOICE_REALTIME_LOG_MAX_BYTES} — reads as the shipped default rather than as "unbounded",
 * which is the safe direction: a malformed cap must not be the one that lets the directory grow
 * without a bound. A fraction is floored so the value stays an integer number of bytes.
 */
export function resolveVoiceRealtimeLogMaxBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_VOICE_REALTIME_LOG_MAX_BYTES) {
    return DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES;
  }
  return Math.floor(parsed);
}

/** The start-up line naming where the journal lands, one literal with nothing to construct. */
export function voiceRealtimeLogDirStartupLine(directory: string): string {
  return `voice.realtime.log dir=${directory}`;
}

/** The characters a connection id may keep in a file name. Ids are the module's own `randomUUID`s. */
function pathSafeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** The file one connection's journal lives in. */
function journalPath(directory: string, connectionId: string): string {
  return path.join(directory, `${pathSafeStem(connectionId)}${ENTRY_EXTENSION}`);
}

/** The bytes of every regular file directly under the directory. */
function directoryBytes(directory: string): number {
  let total = 0;
  for (const name of readdirSync(directory)) {
    try {
      const stats = statSync(path.join(directory, name));
      if (stats.isFile()) {
        total += stats.size;
      }
    } catch {
      // A file that vanished between the listing and the stat is not bytes we have to account for.
    }
  }
  return total;
}

/**
 * Trims the directory to the ceiling, OLDEST FILE FIRST.
 *
 * The just-written file is SKIPPED as a deletion candidate, which is what makes "write then trim"
 * leave the connection the caller is in the middle of recording on disk in every case the file fits
 * at all. The order is (`mtimeMs`, then name): two files written in the same millisecond are ordered
 * by name, so the outcome is deterministic on a filesystem with coarse timestamps.
 */
function evictToLimit(directory: string, maxBytes: number, keep: string): void {
  let total = directoryBytes(directory);
  if (total <= maxBytes) {
    return;
  }

  const candidates: Array<{ name: string; mtimeMs: number; size: number }> = [];
  for (const name of readdirSync(directory)) {
    if (name === keep) {
      continue;
    }
    try {
      const stats = statSync(path.join(directory, name));
      if (stats.isFile()) {
        candidates.push({ name, mtimeMs: stats.mtimeMs, size: stats.size });
      }
    } catch {
      // Vanished between listing and stat: nothing to delete, and nothing to subtract.
    }
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));

  for (const candidate of candidates) {
    if (total <= maxBytes) {
      break;
    }
    rmSync(path.join(directory, candidate.name), { force: true });
    total -= candidate.size;
  }
}

/**
 * Writes one entry to its connection's journal, then trims the directory.
 *
 * The directory appears HERE, on the first entry actually written, and not when the store was built:
 * a deployment whose connections never log leaves no directory behind even though one was resolved.
 */
function appendToStore(directory: string, maxBytes: number, entry: VoiceRealtimeLogEntry): void {
  mkdirSync(directory, { recursive: true, mode: RELAY_LOG_DIR_MODE });
  chmodSync(directory, RELAY_LOG_DIR_MODE);

  const file = journalPath(directory, entry.connectionId);
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: RELAY_LOG_FILE_MODE });
  // Re-applied after every write: the first append creates the inode under this process's umask, and
  // the 0600 promise has to hold for the file rather than for the shell that started the server.
  chmodSync(file, RELAY_LOG_FILE_MODE);

  evictToLimit(directory, maxBytes, path.basename(file));
}

/**
 * Removes every file this store owns, and answers how many CONNECTION JOURNALS were among them.
 *
 * Counts `.jsonl` files rather than files, so the number reads as "how many connections' records
 * were removed". A missing directory answers `0` rather than failing: a deployment with no journal
 * yet must be able to clear without an error.
 */
function clearStore(directory: string): VoiceRealtimeLogClearResult {
  if (!existsSync(directory)) {
    return { deleted: 0 };
  }

  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return { deleted: 0 };
  }

  let deleted = 0;
  for (const name of names) {
    if (name.endsWith(ENTRY_EXTENSION)) {
      deleted += 1;
    }
    rmSync(path.join(directory, name), { force: true, recursive: true });
  }
  return { deleted };
}

/** Builds the shipping store. Consumed by the composition root (`server/index.ts`). */
export function createVoiceRealtimeLogStore(options: VoiceRealtimeLogStoreOptions): VoiceRealtimeLogStore {
  const maxBytes =
    typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes >= MIN_VOICE_REALTIME_LOG_MAX_BYTES
      ? Math.floor(options.maxBytes)
      : DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES;

  return {
    append: (entry) => appendToStore(options.directory, maxBytes, entry),
    clear: () => clearStore(options.directory),
    directory: () => options.directory,
  };
}

/** One raw wire frame as the transport observed it — the shape the `observe` seam carries. */
export type VoiceRealtimeWireObservation = { direction: 'sent' | 'received'; atMs?: number; wire: unknown };

/**
 * The two methods the composition root hands to the proxy: `log` for its plain lines and `observe`
 * for the raw wire.
 *
 * They are the proxy's OWN seam shapes, so wiring the recorder into `buildVoiceRealtimeSeams` is a
 * substitution of who receives the events, never a change to the events themselves.
 */
export type VoiceRealtimeLogRecorder = {
  log(line: string): void;
  observe(observation: VoiceRealtimeWireObservation): void;
};

/** The segment line the proxy prints once per relayed segment (SPEC §C4). */
const SEGMENT_LINE = /^segment seq=(\d+) dur=(\d+)ms reason=(\S+) frames=(\d+)/;
/** The `session_send` lines: the start carries the arguments, the others the outcome. */
const SEND_START_LINE = /^session_send start (.*)$/;
const SEND_DELIVERED_LINE = /^session_send delivered in (\d+) ms$/;
const SEND_FAILED_LINE = /^session_send failed after (\d+) ms:?\s?(.*)$/;
/**
 * A relayed instruction the proxy REFUSED — an empty transcript, an empty model message, or an
 * upstream event that arrived after the browser socket was gone. Its own line rather than a
 * `failed`: nothing went wrong, and the operator's question is "did the user see a message", which
 * "not delivered" answers and an absence does not.
 */
const SEND_NOT_DELIVERED_LINE = /^session_send not-delivered \(([^)]*)\)$/;
/** The pool's one rotation line (SPEC §C3). */
const ROTATION_LINE = /^upstream-pool rotate from=(\d+) to=(\d+) idleMs=(\d+) standbyAgeMs=(\d+) switchMs=(\d+)$/;
/**
 * One Silence Tail Suppression stage change (decision doc §10). Structured rather than prose, so the
 * cost reading is arithmetic: `suppressedMs` is what never crossed the wire.
 */
const SILENCE_TAIL_LINE = /^silence_tail event=(suppressed|resumed) tailMs=(\d+) suppressedMs=(\d+) prerollFrames=(\d+)$/;
/**
 * The stop's audit line (SPEC §6.2/§10.3): `session_interrupt audit {json}`, where the object is the
 * record itself. It is matched BEFORE the `log` fallback and it does not collide with the human
 * `session_interrupt: aborted=… backlog=…` line the proxy still prints beside it — that one has a
 * colon where this one has ` audit `, so the two are told apart by the line's own text.
 */
const INTERRUPT_AUDIT_LINE = /^session_interrupt audit (\{.*\})$/;
/**
 * One disconnect-forensics line (2026-10-13): `segment_forensics {json}`, where the object is the
 * bridge's own record (see the bridge's `RealtimeSegmentForensics`). Its own prefix rather than a
 * branch of `session_interrupt`'s: the two are different subjects that happen to share the
 * `{json}` shape, and telling them apart by their leading word is what keeps either classifier from
 * having to know about the other.
 */
const SEGMENT_FORENSICS_LINE = /^segment_forensics (\{.*\})$/;

/** The three causes a forensics reading may name — the payload's `kind`, checked before it is trusted. */
const FORENSICS_CLASSES: ReadonlySet<string> = new Set(['upstream-close', 'replay-exhausted', 'pairing-mismatch']);

/**
 * Reads a forensics line's class and socket generation, or `null` when it is not a complete record.
 *
 * CHECKED FIELD BY FIELD, like {@link parseInterruptAudit}: a truncated line or a future payload that
 * renamed `kind` falls back to the verbatim `log` entry rather than being recorded under a class it
 * does not actually name. The two fields read here are the ones this entry's own shape keys on; the
 * rest of the payload stays in `line` untouched.
 */
function parseSegmentForensics(payload: string): { forensicsClass: RealtimeSegmentForensics['kind']; socketEpoch: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const kind = typeof raw.kind === 'string' && FORENSICS_CLASSES.has(raw.kind) ? raw.kind : undefined;
  const socketEpoch = typeof raw.socketEpoch === 'number' ? raw.socketEpoch : undefined;
  if (kind === undefined || socketEpoch === undefined) {
    return null;
  }
  return { forensicsClass: kind as RealtimeSegmentForensics['kind'], socketEpoch };
}

/** One `response.done`'s usage, reduced to the readings the journal keeps. */
function measureUsage(usage: unknown): { input: number; output: number; text: number; audio: number; cost: number } {
  const u = (usage ?? {}) as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { audio_tokens?: unknown; text_tokens?: unknown };
  };
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  const audio = typeof u.input_tokens_details?.audio_tokens === 'number' ? u.input_tokens_details.audio_tokens : 0;
  // The split is the endpoint's own when it reported one, and `input - audio` when it did not — the
  // same fallback `estimateRealtimeCostCny` applies, so the recorded split and the recorded cost
  // cannot disagree about how much of the input was text.
  const text = typeof u.input_tokens_details?.text_tokens === 'number' ? u.input_tokens_details.text_tokens : Math.max(0, input - audio);
  return { input, output, text, audio, cost: estimateRealtimeCostCny(usage) };
}

/** The `message` a `session_send start` line carried, or `undefined` when the line was truncated. */
function messageFromSendStart(rest: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rest);
    if (parsed !== null && typeof parsed === 'object') {
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === 'string') {
        return message;
      }
    }
  } catch {
    // The proxy truncates the arguments at 200 chars, so a long message is not valid JSON here. The
    // message is a convenience on the entry, not the entry's subject; the latency and outcome are.
  }
  return undefined;
}

/** The ten readings an interrupt audit line must carry, and nothing else, to become a record. */
type InterruptAuditFields = Pick<
  Extract<VoiceRealtimeLogEntry, { kind: 'interrupt' }>,
  | 'runId'
  | 'triggerSeq'
  | 'intent'
  | 'intentMissing'
  | 'heard'
  | 'queuedStillPending'
  | 'inFlightTool'
  | 'noteCarried'
  | 'by'
  | 'outcome'
>;

/**
 * Reads the JSON payload of an interrupt audit line, or `null` when it is not a complete record.
 *
 * CHECKED FIELD BY FIELD rather than trusted. A payload that does not carry all ten readings (a
 * truncated line, a future proxy that renamed one) falls back to the verbatim `log` entry the
 * unknown-line branch already keeps, so the journal never becomes the place a half-record looks like
 * a whole one. The two model-supplied strings and the two `null`s are read as nullish on purpose:
 * `intent: null` is what a stop that named no reason records, and it must survive the round trip as
 * a `null` rather than be dropped for looking absent.
 */
function parseInterruptAudit(payload: string): InterruptAuditFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const runId = raw.runId === null || typeof raw.runId === 'string' ? (raw.runId as string | null) : undefined;
  const triggerSeq = raw.triggerSeq === null || typeof raw.triggerSeq === 'number' ? (raw.triggerSeq as number | null) : undefined;
  const intent = raw.intent === null || typeof raw.intent === 'string' ? (raw.intent as string | null) : undefined;
  const intentMissing = typeof raw.intentMissing === 'boolean' ? raw.intentMissing : undefined;
  const heard = raw.heard === null || typeof raw.heard === 'string' ? (raw.heard as string | null) : undefined;
  const queuedStillPending = typeof raw.queuedStillPending === 'number' ? raw.queuedStillPending : undefined;
  const inFlightTool =
    raw.inFlightTool === null || typeof raw.inFlightTool === 'string' ? (raw.inFlightTool as string | null) : undefined;
  const noteCarried = typeof raw.noteCarried === 'boolean' ? raw.noteCarried : undefined;
  const by = raw.by === 'model' ? ('model' as const) : undefined;
  const outcome =
    raw.outcome === 'aborted' ||
    raw.outcome === 'no-run' ||
    raw.outcome === 'refused' ||
    raw.outcome === 'covered'
      ? raw.outcome
      : undefined;
  if (
    runId === undefined ||
    triggerSeq === undefined ||
    intent === undefined ||
    intentMissing === undefined ||
    heard === undefined ||
    queuedStillPending === undefined ||
    inFlightTool === undefined ||
    noteCarried === undefined ||
    by === undefined ||
    outcome === undefined
  ) {
    return null;
  }
  return { runId, triggerSeq, intent, intentMissing, heard, queuedStillPending, inFlightTool, noteCarried, by, outcome };
}

/**
 * Builds the recorder for ONE connection.
 *
 * `connectionId` is the caller's, so the journal's name and its header agree by construction;
 * `mode` is resolved by the composition root (this module never reads the environment); and `stdout`
 * is injectable so a criterion asserts on the stream the deployment writes rather than on the
 * process's console.
 *
 * The recorder owns the running token totals the proxy used to keep itself, because the usage line
 * and the journal's `usage` entry must be the SAME arithmetic: two accumulators would be two
 * answers waiting to disagree.
 */
export function createVoiceRealtimeRecorder(options: {
  store: VoiceRealtimeLogStore;
  connectionId: string;
  sessionId: string;
  tag: string;
  mode: VoiceRealtimeLogMode;
  stdout?: (line: string) => void;
}): VoiceRealtimeLogRecorder {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const prefixText = `[voice-realtime ${options.tag}]`;
  const at = (): string => new Date().toISOString();

  /** Whether a write failure has already been reported. The report is ONE line per connection. */
  let writeFailed = false;
  const safeAppend = (entry: VoiceRealtimeLogEntry): void => {
    try {
      options.store.append(entry);
    } catch (error) {
      if (!writeFailed) {
        writeFailed = true;
        stdout(
          `${at()} ${prefixText} journal write failed (${
            error instanceof Error ? error.message : String(error)
          }); continuing without the on-disk record`,
        );
      }
    }
  };

  // The header first, so a reader who opens the file knows what connection it is before anything else.
  safeAppend({
    at: at(),
    kind: 'connection',
    connectionId: options.connectionId,
    sessionId: options.sessionId,
    tag: options.tag,
    mode: options.mode,
  });

  /** The fixed prefix, recorded from the first `session.update`; `null` until it goes out. */
  let prefixRecorded = false;
  /** The message the outstanding `session_send` is delivering, paired with its outcome line. */
  let pendingSendMessage: string | undefined;
  let responses = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalText = 0;
  let totalAudio = 0;
  let totalCost = 0;

  const log = (line: string): void => {
    stdout(`${at()} ${prefixText} ${line}`);

    // The start of a send is not its own entry: the outcome line that follows carries the latency and
    // the result, and the message from here rides along with it, so one send is one journal entry.
    const start = SEND_START_LINE.exec(line);
    if (start !== null) {
      pendingSendMessage = messageFromSendStart(start[1] ?? '');
      return;
    }

    const segment = SEGMENT_LINE.exec(line);
    if (segment !== null) {
      safeAppend({
        at: at(),
        kind: 'segment',
        connectionId: options.connectionId,
        line,
        seq: Number(segment[1]),
        durationMs: Number(segment[2]),
        reason: segment[3] ?? 'gap',
        frames: Number(segment[4]),
      });
      return;
    }

    const delivered = SEND_DELIVERED_LINE.exec(line);
    if (delivered !== null) {
      safeAppend({
        at: at(),
        kind: 'session_send',
        connectionId: options.connectionId,
        line,
        latencyMs: Number(delivered[1]),
        outcome: 'delivered',
        ...(pendingSendMessage === undefined ? {} : { message: pendingSendMessage }),
      });
      pendingSendMessage = undefined;
      return;
    }

    const failed = SEND_FAILED_LINE.exec(line);
    if (failed !== null) {
      safeAppend({
        at: at(),
        kind: 'session_send',
        connectionId: options.connectionId,
        line,
        latencyMs: Number(failed[1]),
        outcome: 'failed',
        ...(failed[2] === undefined || failed[2] === '' ? {} : { error: failed[2] }),
        ...(pendingSendMessage === undefined ? {} : { message: pendingSendMessage }),
      });
      pendingSendMessage = undefined;
      return;
    }

    const notDelivered = SEND_NOT_DELIVERED_LINE.exec(line);
    if (notDelivered !== null) {
      safeAppend({
        at: at(),
        kind: 'session_send',
        connectionId: options.connectionId,
        line,
        // No latency: nothing was sent, so there is no round trip to time. The reason is the reading.
        latencyMs: 0,
        outcome: 'not-delivered',
        reason: notDelivered[1] ?? '',
        ...(pendingSendMessage === undefined ? {} : { message: pendingSendMessage }),
      });
      pendingSendMessage = undefined;
      return;
    }

    const rotation = ROTATION_LINE.exec(line);
    if (rotation !== null) {
      safeAppend({
        at: at(),
        kind: 'rotation',
        connectionId: options.connectionId,
        line,
        from: Number(rotation[1]),
        to: Number(rotation[2]),
        idleMs: Number(rotation[3]),
        standbyAgeMs: Number(rotation[4]),
        switchMs: Number(rotation[5]),
      });
      return;
    }

    const silenceTail = SILENCE_TAIL_LINE.exec(line);
    if (silenceTail !== null) {
      safeAppend({
        at: at(),
        kind: 'silence_tail',
        connectionId: options.connectionId,
        event: silenceTail[1] === 'resumed' ? 'resumed' : 'suppressed',
        tailMs: Number(silenceTail[2]),
        suppressedMs: Number(silenceTail[3]),
        preRollFrames: Number(silenceTail[4]),
      });
      return;
    }

    // The stop's audit line. A payload that does not parse as a complete record falls THROUGH to the
    // verbatim `log` entry below rather than being dropped: the line is then still on disk, readable
    // as what it was, instead of vanishing from a journal whose whole job is to be a superset.
    const interrupt = INTERRUPT_AUDIT_LINE.exec(line);
    if (interrupt !== null) {
      const audit = parseInterruptAudit(interrupt[1] ?? '');
      if (audit !== null) {
        safeAppend({ at: at(), kind: 'interrupt', connectionId: options.connectionId, ...audit });
        return;
      }
    }

    // The 2026-10-13 disconnect-forensics line. Same fall-through as the audit above: a payload that
    // does not carry the class and the socket generation is kept verbatim rather than dropped, so the
    // reading is still readable on disk even when this classifier cannot name it.
    const forensics = SEGMENT_FORENSICS_LINE.exec(line);
    if (forensics !== null) {
      const reading = parseSegmentForensics(forensics[1] ?? '');
      if (reading !== null) {
        safeAppend({ at: at(), kind: 'segment_forensics', connectionId: options.connectionId, line, ...reading });
        return;
      }
    }

    safeAppend({ at: at(), kind: 'log', connectionId: options.connectionId, line });
  };

  const observe = (observation: VoiceRealtimeWireObservation): void => {
    const wire = observation.wire as Record<string, unknown> | null;

    if (observation.direction === 'sent' && wire !== null && typeof wire === 'object' && wire.type === 'session.update' && !prefixRecorded) {
      prefixRecorded = true;
      const session = (wire.session ?? {}) as Record<string, unknown>;
      safeAppend({
        at: at(),
        kind: 'prefix',
        connectionId: options.connectionId,
        tools: Array.isArray(session.tools) ? session.tools.length : 0,
        instructionsChars: typeof session.instructions === 'string' ? session.instructions.length : 0,
      });
    }

    if (observation.direction === 'received' && wire !== null && typeof wire === 'object' && wire.type === 'response.done') {
      const usage = (wire.response as Record<string, unknown> | undefined)?.usage;
      if (usage !== undefined && usage !== null) {
        const measured = measureUsage(usage);
        responses += 1;
        totalInput += measured.input;
        totalOutput += measured.output;
        totalText += measured.text;
        totalAudio += measured.audio;
        totalCost += measured.cost;
        safeAppend({
          at: at(),
          kind: 'response',
          connectionId: options.connectionId,
          index: responses,
          inputTokens: measured.input,
          outputTokens: measured.output,
          textTokens: measured.text,
          audioTokens: measured.audio,
          costCny: measured.cost,
        });
        safeAppend({
          at: at(),
          kind: 'usage',
          connectionId: options.connectionId,
          responses,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          textTokens: totalText,
          audioTokens: totalAudio,
          costCny: totalCost,
        });
        // The human line, unchanged from where it used to be printed: the journal's `usage` entry is
        // its structured twin, and this is what an operator tailing the process still reads.
        stdout(
          `${at()} ${prefixText} usage connection total input=${totalInput} output=${totalOutput} cost~CNY${totalCost.toFixed(4)}`,
        );
      }
    }

    const summary = summarizeWireObservation(observation);
    if (summary !== null) {
      const line = `${observation.direction === 'sent' ? '>>' : '<<'} ${summary}`;
      stdout(`${at()} ${prefixText} ${line}`);
      safeAppend({ at: at(), kind: 'log', connectionId: options.connectionId, line });
    }
  };

  return { log, observe };
}
