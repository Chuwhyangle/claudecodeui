/**
 * The live relay's UPLINK AUDIO CAPTURE — the microphone stream itself, on disk, per browser
 * connection, beside the endpoint's own judgement timeline. OFF unless a deployment asks for it.
 *
 * WHY IT EXISTS. The relay journal (`voice-realtime-log.ts`) records what the CONNECTION cost and
 * what the endpoint DECIDED, but it deliberately drops audio frames (`summarizeWireObservation`
 * treats `input_audio_buffer.append` as noise). That makes one question unanswerable on this machine:
 * "would a different endpoint decision — a different VAD — have found the same speech?" Answering it
 * needs the audio AND the decisions, on ONE clock, and nothing produced both.
 *
 * WHAT MAKES A CAPTURE SCORABLE (the decisive constraint). Audio alone grades nothing: a detector's
 * proposals can only be compared against what the endpoint itself decided, so the capture carries a
 * SHARED ORIGIN (`connectionId` + the wall clock of the first frame, `t0`) and then every judgement
 * event as a MONOTONIC millisecond offset from it — `offset_ms(event) = event.wallClock − t0`. The
 * events are the endpoint's own `input_audio_buffer.speech_started` / `.speech_stopped` /
 * `.committed`, and each relay segment's `seq` / duration / frame count. An audio file without that
 * timeline is not a corpus, and this module is not "save the audio to a file".
 *
 * THE SHAPE ON DISK, mirroring the journal deliberately. One WAV per connection,
 * `<dir>/<connectionId>.wav` — a canonical 44-byte RIFF/WAVE header (mono, 16-bit PCM, the REAL
 * sample rate of the first frame) followed by the raw PCM16 payload — and one sidecar beside it,
 * `<dir>/<connectionId>.timeline.jsonl`, whose first line is the origin and whose later lines are the
 * judgement events. Directory 0700 / files 0600, applied with an explicit `chmod` after each create
 * (a `mode:` is only a request the kernel applies through the process's umask) — the same permissions,
 * for the same reason, as `voice-capture.ts` and `voice-realtime-log.ts`.
 *
 * DEFAULT OFF, AND FAIL-CLOSED ABOUT IT. `VOICE_REALTIME_CAPTURE` unset, blank, `off`, or
 * unrecognised writes NOTHING and creates NO directory — an audio store that can turn itself on is a
 * microphone that can turn itself on. The recorder enforces that, not the caller: an OFF recorder's
 * every method is a no-op, so the bytes can never reach the store it was handed.
 *
 * BOUNDED AND CLEARABLE. The directory is capped (`VOICE_REALTIME_CAPTURE_MAX_BYTES`) and trimmed
 * WHOLE-CONNECTION-OLDEST-FIRST after each append, so a long-running deployment cannot fill its disk
 * and an eviction never leaves half a connection behind (the WAV and its sidecar go together).
 * `clearVoiceRealtimeCaptureDir` removes every capture, and is what the module's route exposes.
 *
 * FAIL-OPEN, AND THE STORE IS THE ONE THAT THROWS. `appendFrame` / `timeline` / `finalize` let an I/O
 * failure out; the RECORDER catches it, reports it ONCE on the stdout stream, and keeps serving the
 * live connection. A capture that cannot be written must never cost the user the call it was
 * describing — the same rule `voice-realtime-log.ts` states for its journal.
 *
 * PRIVACY. This is the microphone's raw audio. It is local-only, off by default, one-key clearable,
 * and never forwarded anywhere — the shape the sibling recordings store chose, and the observability
 * goal the segmented-relay SPEC states. It is NOT a change to that SPEC's D8 (no redaction, no
 * verification gate, no default-on switch): it is a second local artifact beside the journal.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The directory's leaf name under the database's parent — `~/.cloudcli/voice-realtime-capture`. */
const CAPTURE_DIRECTORY_NAME = 'voice-realtime-capture';

/** The fallback database path the default directory is derived from, mirroring the other stores. */
const DEFAULT_DATABASE_FILE = '.cloudcli/auth.db';

/** The directory's mode and the files' mode, both applied explicitly (see the header). */
const CAPTURE_DIR_MODE = 0o700;
const CAPTURE_FILE_MODE = 0o600;

/** The two files one connection owns: the audio and its judgement timeline. */
const AUDIO_EXTENSION = '.wav';
const TIMELINE_EXTENSION = '.timeline.jsonl';

/** A canonical mono 16-bit PCM RIFF/WAVE header is exactly this long; the payload starts after it. */
const WAV_HEADER_BYTES = 44;

/**
 * The rate recorded when a frame declares none: 16 kHz, the rate the Realtime session's
 * `input_audio_format: 'pcm16'` is declared at, and the rate the relay's own segmented payload is
 * documented to be (`voiceRealtimeProtocol.ts`'s `wavPcm16Base64`). A frame that DOES declare its
 * rate wins — the header records the rate the payload is actually at, never a guess about it.
 */
export const VOICE_REALTIME_CAPTURE_DEFAULT_SAMPLE_RATE = 16_000;

/** The channels recorded: the wire is mono by construction (`input_audio_format: 'pcm16'`). */
const CAPTURE_CHANNELS = 1;

/**
 * The three switches, read by the composition root and handed to the pure resolvers below — the same
 * "the environment belongs to the assembly point" discipline the other stores follow.
 */
export const VOICE_REALTIME_CAPTURE_ENV = 'VOICE_REALTIME_CAPTURE';
export const VOICE_REALTIME_CAPTURE_DIR_ENV = 'VOICE_REALTIME_CAPTURE_DIR';
export const VOICE_REALTIME_CAPTURE_MAX_BYTES_ENV = 'VOICE_REALTIME_CAPTURE_MAX_BYTES';

/**
 * The ceiling on the capture directory, in bytes, when the deployment names none: 64 MiB — about 34
 * minutes of 16 kHz mono PCM16 across all connections. A SHIPPED DEFAULT rather than a policy; the
 * deployment's own variable overrides it.
 */
export const DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The smallest ceiling the variable may name: 1 KiB. Below it every connection is evicted the moment
 * it is written, which reads as "the capture is broken" rather than as "the cap is tiny" — the same
 * floor, for the same reason, as the journal's.
 */
export const MIN_VOICE_REALTIME_CAPTURE_MAX_BYTES = 1024;

/** Whether the switch is on, and the warning an unrecognised value earns. */
export type VoiceRealtimeCaptureModeResolution = {
  enabled: boolean;
  warning: string | null;
};

/** What a clear answers: how many CONNECTION CAPTURES (one WAV each) were removed. */
export type VoiceRealtimeCaptureClearResult = { deleted: number };

/**
 * One judgement event, as the capture records it.
 *
 * `atMs` is a WALL-CLOCK reading (`Date.now()`); the store turns it into the monotonic `offsetMs` the
 * corpus is read by, against the origin the first frame set. The `segment` member is the relay's own
 * accounting (which `seq`, how long the browser said it was, how many frames carried it), and it is
 * recorded even though a segmented connection sends no continuous audio: it is the endpoint's decision
 * timeline, which is exactly what a detector is graded against.
 */
export type VoiceRealtimeCaptureEvent =
  | { kind: 'speech_started'; atMs: number }
  | { kind: 'speech_stopped'; atMs: number }
  | { kind: 'committed'; atMs: number; itemId?: string }
  | { kind: 'segment'; atMs: number; seq: number; durationMs: number; frames: number };

/**
 * The store ONE connection writes through.
 *
 * `appendFrame` THROWS on an I/O failure and the recorder catches it — the store deliberately does not
 * swallow, so the failure has one owner (the call site that can keep the connection alive). `clear` is
 * DIRECTORY-scoped (see {@link clearVoiceRealtimeCaptureDir}): a connection id belongs to a connection
 * that has already ended, so the operator's action is "start over", not "delete this one".
 */
export type VoiceRealtimeCaptureStore = {
  /**
   * One base64 PCM16 frame. `sourceRate` is what the FRAME declared, and `undefined` means it declared
   * none — the shipped page does not send one, because it decimates to 16 kHz and names no rate on the
   * wire. Only the connection's FIRST frame's rate reaches the header; a later frame's never rewrites it.
   */
  appendFrame(base64: string, sourceRate: number | undefined, atMs: number): void;
  timeline(event: VoiceRealtimeCaptureEvent): void;
  finalize(): void;
  clear(): VoiceRealtimeCaptureClearResult;
  directory(): string;
};

/** What the store is built from: the directory the composition root resolved, the connection, and its cap. */
export type VoiceRealtimeCaptureStoreOptions = {
  directory: string;
  connectionId: string;
  /** The byte ceiling. Absent (or unusable) reads as {@link DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES}. */
  maxBytes?: number;
};

/**
 * Whether the capture is on, from the raw `VOICE_REALTIME_CAPTURE` reading.
 *
 * THE ARGUMENT IS THE RAW VALUE, NOT `process.env`, for the reason `resolveVoiceCaptureMode` states:
 * the root reads the variable once and hands the text over. Blank is the same reading as absent
 * (`off`), `on`/`audio` turn it on, and anything else is OFF **and earns a warning naming the value** —
 * a deployment whose variable is misspelled must not read as a deployment that asked for nothing.
 */
export function resolveVoiceRealtimeCaptureMode(raw: string | undefined): VoiceRealtimeCaptureModeResolution {
  const value = raw === undefined ? '' : raw.trim();
  if (value === '' || value === 'off') {
    return { enabled: false, warning: null };
  }
  if (value === 'on' || value === 'audio') {
    return { enabled: true, warning: null };
  }
  return { enabled: false, warning: voiceRealtimeCaptureWarningLine(value) };
}

/** The warning line an unrecognised switch value earns, quoted so it stays exactly one line. */
export function voiceRealtimeCaptureWarningLine(value: string): string {
  return `voice.realtime.capture invalid value ${JSON.stringify(value)}; capture is off`;
}

/** The start-up line naming where a capture would land and whether one will — one literal. */
export function voiceRealtimeCaptureStartupLine(directory: string, enabled: boolean): string {
  return `voice.realtime.capture dir=${directory} mode=${enabled ? 'on' : 'off'}`;
}

/**
 * Where capture WAVs go, from the two values the composition root read.
 *
 * The inputs are ARGUMENTS for the same reason the journal resolver's are: an explicit directory wins;
 * otherwise the default sits BESIDE THE DATABASE, so a deployment that moved its database moves its
 * capture with it. This only COMPUTES a path — the writer creates the directory on the first frame.
 */
export function resolveVoiceRealtimeCaptureDir(raw: string | undefined, databasePath: string | undefined): string {
  const explicit = raw === undefined ? '' : raw.trim();
  if (explicit !== '') {
    return explicit;
  }

  const database =
    databasePath === undefined || databasePath.trim() === ''
      ? path.join(os.homedir(), DEFAULT_DATABASE_FILE)
      : databasePath;
  return path.join(path.dirname(database), CAPTURE_DIRECTORY_NAME);
}

/**
 * The byte ceiling to enforce, from the raw `VOICE_REALTIME_CAPTURE_MAX_BYTES` reading.
 *
 * A value the store cannot act on — absent, non-numeric, non-finite, or below
 * {@link MIN_VOICE_REALTIME_CAPTURE_MAX_BYTES} — reads as the shipped default rather than as
 * "unbounded": a malformed cap must not be the one that lets the directory grow without a bound.
 */
export function resolveVoiceRealtimeCaptureMaxBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_VOICE_REALTIME_CAPTURE_MAX_BYTES) {
    return DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES;
  }
  return Math.floor(parsed);
}

/** The characters a connection id may keep in a file name. Ids are the module's own `randomUUID`s. */
function pathSafeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** The audio file one connection owns. */
function audioPath(directory: string, stem: string): string {
  return path.join(directory, `${stem}${AUDIO_EXTENSION}`);
}

/** The judgement-timeline sidecar beside it. */
function timelinePath(directory: string, stem: string): string {
  return path.join(directory, `${stem}${TIMELINE_EXTENSION}`);
}

/** The connection a file belongs to: its name with this store's own extension removed. */
function stemOf(name: string): string {
  if (name.endsWith(TIMELINE_EXTENSION)) {
    return name.slice(0, -TIMELINE_EXTENSION.length);
  }
  if (name.endsWith(AUDIO_EXTENSION)) {
    return name.slice(0, -AUDIO_EXTENSION.length);
  }
  return name;
}

/** A sample rate the header can carry, or the wire's own default when the frame declared none. */
function normalizeSampleRate(sourceRate: number | undefined): number {
  return sourceRate !== undefined && Number.isInteger(sourceRate) && sourceRate > 0
    ? sourceRate
    : VOICE_REALTIME_CAPTURE_DEFAULT_SAMPLE_RATE;
}

/**
 * A canonical mono 16-bit PCM RIFF/WAVE header, with the two size fields ZEROED.
 *
 * They are patched in as bytes land ({@link patchWavSizes}), so a capture read while it is still being
 * written — or one whose connection died without `finalize()` — is still a well-formed WAV whose header
 * agrees with the bytes behind it, rather than a file whose header claims a length it does not have.
 */
function createWavHeader(sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(0, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(0, 40);
  return header;
}

/** Writes the two RIFF size fields so the header matches the PCM actually on disk. */
function patchWavSizes(file: string, dataBytes: number): void {
  const fd = openSync(file, 'r+');
  try {
    const riff = Buffer.alloc(4);
    riff.writeUInt32LE(36 + dataBytes, 0);
    writeSync(fd, riff, 0, 4, 4);
    const data = Buffer.alloc(4);
    data.writeUInt32LE(dataBytes, 0);
    writeSync(fd, data, 0, 4, 40);
  } finally {
    closeSync(fd);
  }
}

/** The bytes of every regular file directly under the directory, and which connection it belongs to. */
function groupDirectory(directory: string): Map<string, { bytes: number; mtimeMs: number; names: string[] }> {
  const groups = new Map<string, { bytes: number; mtimeMs: number; names: string[] }>();
  for (const name of readdirSync(directory)) {
    try {
      const stats = statSync(path.join(directory, name));
      if (!stats.isFile()) {
        continue;
      }
      const stem = stemOf(name);
      const group = groups.get(stem) ?? { bytes: 0, mtimeMs: 0, names: [] };
      group.bytes += stats.size;
      group.mtimeMs = Math.max(group.mtimeMs, stats.mtimeMs);
      group.names.push(name);
      groups.set(stem, group);
    } catch {
      // A file that vanished between the listing and the stat is not bytes we have to account for.
    }
  }
  return groups;
}

/**
 * Trims the directory to the ceiling, WHOLE CONNECTION OLDEST FIRST.
 *
 * Grouping by stem is what keeps a connection's audio and its timeline together: evicting the WAV and
 * leaving the sidecar (or the reverse) would leave a corpus that reads as a truncated capture rather
 * than as a removed one. The connection being written is SKIPPED as a deletion candidate, so "write
 * then trim" always leaves the live connection on disk in every case its files fit at all. The order
 * is (`mtimeMs`, then stem): two connections written in the same millisecond are ordered by name, so
 * the outcome is deterministic on a filesystem with coarse timestamps.
 */
function evictToLimit(directory: string, maxBytes: number, keepStem: string): void {
  const groups = groupDirectory(directory);
  let total = 0;
  for (const group of groups.values()) {
    total += group.bytes;
  }
  if (total <= maxBytes) {
    return;
  }

  const candidates = [...groups.entries()]
    .filter(([stem]) => stem !== keepStem)
    .sort(([leftStem, left], [rightStem, right]) => left.mtimeMs - right.mtimeMs || leftStem.localeCompare(rightStem));

  for (const [, group] of candidates) {
    if (total <= maxBytes) {
      break;
    }
    for (const name of group.names) {
      rmSync(path.join(directory, name), { force: true });
    }
    total -= group.bytes;
  }
}

/**
 * Removes every capture under `directory`, and answers how many CONNECTION CAPTURES were among them.
 *
 * Counts WAVs rather than files, so the number reads as "how many connections' audio was removed"
 * (each one's timeline sidecar goes with it). A missing directory answers `0` rather than failing: a
 * deployment with no capture yet must be able to clear without an error.
 *
 * Consumers: this module's store (`clear`) and `server/index.ts`, which wires it to the module route's
 * `DELETE /api/voice-realtime/capture`.
 */
export function clearVoiceRealtimeCaptureDir(directory: string): VoiceRealtimeCaptureClearResult {
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
    if (name.endsWith(AUDIO_EXTENSION)) {
      deleted += 1;
    }
    rmSync(path.join(directory, name), { force: true, recursive: true });
  }
  return { deleted };
}

/** What one connection's writer holds between calls — the origin, the rate, and the byte count. */
type CaptureWriterState = {
  stem: string;
  sampleRate: number;
  /** The wall clock of the first frame — the shared origin every offset is measured from, or null. */
  originMs: number | null;
  headerWritten: boolean;
  dataBytes: number;
  frames: number;
};

/** One timeline line, with the shared-origin offset the corpus is read by. */
function timelineLine(state: CaptureWriterState, event: VoiceRealtimeCaptureEvent): string {
  const offsetMs = state.originMs === null ? null : event.atMs - state.originMs;
  return `${JSON.stringify({ at: new Date().toISOString(), ...event, offsetMs })}\n`;
}

/** The origin line, written the moment the first frame fixes the clock. */
function originLine(state: CaptureWriterState): string {
  return `${JSON.stringify({
    at: new Date().toISOString(),
    kind: 'origin',
    atMs: state.originMs,
    offsetMs: 0,
    sampleRate: state.sampleRate,
    channels: CAPTURE_CHANNELS,
  })}\n`;
}

/** Creates the directory and the file under the modes this store promises, explicitly. */
function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: CAPTURE_DIR_MODE });
  chmodSync(directory, CAPTURE_DIR_MODE);
}

/** Appends one line to a connection's sidecar, creating both directory and file on the first line. */
function appendTimelineLine(directory: string, state: CaptureWriterState, line: string): void {
  ensureDirectory(directory);
  const file = timelinePath(directory, state.stem);
  appendFileSync(file, line, { mode: CAPTURE_FILE_MODE });
  // Re-applied after every write: the first append creates the inode under this process's umask.
  chmodSync(file, CAPTURE_FILE_MODE);
}

/**
 * Appends one base64 PCM16 frame, opening the connection's WAV on the first one.
 *
 * The header is written FIRST, with the first frame's REAL sample rate and mono channel count, then the
 * PCM is appended and the size fields are patched — so the file on disk is a valid WAV at every instant
 * a reader could open it. The wall clock of that first frame is the shared origin; a later frame's rate
 * never rewrites it, because a corpus has ONE rate and the first frame is what defines it.
 */
function appendFrameToStore(directory: string, maxBytes: number, state: CaptureWriterState, base64: string, sourceRate: number | undefined, atMs: number): void {
  const pcm = Buffer.from(base64, 'base64');
  if (pcm.length === 0) {
    return;
  }

  ensureDirectory(directory);
  const file = audioPath(directory, state.stem);
  if (!state.headerWritten) {
    state.sampleRate = normalizeSampleRate(sourceRate);
    state.originMs = atMs;
    writeFileSync(file, createWavHeader(state.sampleRate, CAPTURE_CHANNELS), { mode: CAPTURE_FILE_MODE });
    chmodSync(file, CAPTURE_FILE_MODE);
    state.headerWritten = true;
    appendTimelineLine(directory, state, originLine(state));
  }

  appendFileSync(file, pcm, { mode: CAPTURE_FILE_MODE });
  chmodSync(file, CAPTURE_FILE_MODE);
  state.dataBytes += pcm.length;
  state.frames += 1;
  patchWavSizes(file, state.dataBytes);
  evictToLimit(directory, maxBytes, state.stem);
}

/** Records one judgement event; a timeline line can precede the first frame (its offset is then null). */
function timelineToStore(directory: string, maxBytes: number, state: CaptureWriterState, event: VoiceRealtimeCaptureEvent): void {
  appendTimelineLine(directory, state, timelineLine(state, event));
  evictToLimit(directory, maxBytes, state.stem);
}

/**
 * Closes a connection's capture: the sizes are already patched, so this records the final reading a
 * scorer needs (how many frames, how many bytes, how long that is at the connection's own rate).
 */
function finalizeStore(directory: string, state: CaptureWriterState): void {
  if (!state.headerWritten) {
    return;
  }
  const file = audioPath(directory, state.stem);
  patchWavSizes(file, state.dataBytes);
  const durationMs = Math.round((state.dataBytes / 2 / state.sampleRate) * 1000);
  appendTimelineLine(directory, state, `${JSON.stringify({
    at: new Date().toISOString(),
    kind: 'final',
    frames: state.frames,
    dataBytes: state.dataBytes,
    durationMs,
    offsetMs: state.originMs === null ? null : state.dataBytes > 0 ? durationMs : 0,
  })}\n`);
}

/**
 * Builds one connection's writer. The directory appears HERE, on the first frame actually written, and
 * not when the store was built: a deployment whose connections never send audio leaves no directory
 * behind even though one was resolved — the property AC1's negative control reads.
 *
 * Consumers: `server/index.ts`, which builds one per browser connection with the SAME id the journal
 * recorder used, and this module's criteria, which build it against a temp directory.
 */
export function createVoiceRealtimeCaptureStore(options: VoiceRealtimeCaptureStoreOptions): VoiceRealtimeCaptureStore {
  const maxBytes =
    typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes >= MIN_VOICE_REALTIME_CAPTURE_MAX_BYTES
      ? Math.floor(options.maxBytes)
      : DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES;

  const state: CaptureWriterState = {
    stem: pathSafeStem(options.connectionId),
    sampleRate: VOICE_REALTIME_CAPTURE_DEFAULT_SAMPLE_RATE,
    originMs: null,
    headerWritten: false,
    dataBytes: 0,
    frames: 0,
  };

  return {
    appendFrame: (base64, sourceRate, atMs) => appendFrameToStore(options.directory, maxBytes, state, base64, sourceRate, atMs),
    timeline: (event) => timelineToStore(options.directory, maxBytes, state, event),
    finalize: () => finalizeStore(options.directory, state),
    clear: () => clearVoiceRealtimeCaptureDir(options.directory),
    directory: () => options.directory,
  };
}

/**
 * The three methods the composition root hands the proxy: one frame, one judgement event, and the end
 * of the connection.
 *
 * They are DELIBERATELY not the store's own methods: the proxy says WHAT happened and the store decides
 * what that means on disk, so the proxy never learns about directories, WAV headers or eviction. The
 * seam is optional on {@link VoiceRealtimeProxySeams}, and a caller that passes none gets the previous
 * behaviour byte for byte.
 */
export type VoiceRealtimeAudioCapture = {
  frame(audio: string, sourceRate: number | undefined, atMs: number): void;
  timeline(event: VoiceRealtimeCaptureEvent): void;
  finalize(): void;
};

/**
 * The recorder for ONE connection: the fail-open wrapper the proxy and the transport actually call.
 *
 * `enabled` is the composition root's resolution, and an OFF recorder is a NO-OP — it never touches the
 * store it was handed, so no byte can reach the disk and no directory can appear. That is the switch's
 * whole enforcement, in one place, and it is why the criterion can inject a spy store and prove AC1's
 * "the sink was never delivered a byte".
 *
 * A write failure is reported ONCE (stdout) and swallowed: the capture is a passenger on the call, and
 * a passenger that cannot be recorded must not end it. `observe` is the transport's wire seam, filtered
 * to the three endpoint judgement events — the same `observe` the journal recorder receives, so the two
 * records share a clock and an id without the transport knowing either exists.
 *
 * Consumers: `server/index.ts` wires `frame`/`timeline`/`finalize` onto the proxy's seams, feeds
 * `observe` from the transport's observer alongside the journal recorder, and this module's criteria
 * drive it directly.
 */
export type VoiceRealtimeCaptureRecorder = VoiceRealtimeAudioCapture & {
  observe(observation: { direction: 'sent' | 'received'; atMs?: number; wire: unknown }): void;
};

/** The endpoint events this capture reads off the wire, and the judgement each one records. */
const ENDPOINT_EVENTS: Readonly<Record<string, 'speech_started' | 'speech_stopped' | 'committed'>> = {
  'input_audio_buffer.speech_started': 'speech_started',
  'input_audio_buffer.speech_stopped': 'speech_stopped',
  'input_audio_buffer.committed': 'committed',
};

/**
 * Builds the recorder for one connection.
 *
 * `connectionId` is the caller's (the same value the journal's file name derives from, so the two
 * records are joinable); `enabled` is resolved by the composition root, never read here; and `stdout`
 * is injectable so a criterion asserts on the stream the deployment writes rather than on the
 * process's console.
 */
export function createVoiceRealtimeCaptureRecorder(options: {
  store: VoiceRealtimeCaptureStore;
  connectionId: string;
  enabled: boolean;
  stdout?: (line: string) => void;
}): VoiceRealtimeCaptureRecorder {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const prefixText = `[voice-realtime ${options.connectionId.slice(0, 8)}]`;

  /** Whether a write failure has already been reported. The report is ONE line per connection. */
  let writeFailed = false;
  const safe = (write: () => void): void => {
    if (!options.enabled) {
      return;
    }
    try {
      write();
    } catch (error) {
      if (!writeFailed) {
        writeFailed = true;
        stdout(
          `${new Date().toISOString()} ${prefixText} audio capture write failed (${
            error instanceof Error ? error.message : String(error)
          }); continuing without the recording`,
        );
      }
    }
  };

  return {
    frame: (audio, sourceRate, atMs) => safe(() => options.store.appendFrame(audio, sourceRate, atMs)),
    timeline: (event) => safe(() => options.store.timeline(event)),
    finalize: () => safe(() => options.store.finalize()),
    observe: (observation) => {
      if (!options.enabled || observation.direction !== 'received') {
        return;
      }
      const wire = observation.wire as Record<string, unknown> | null;
      if (wire === null || typeof wire !== 'object') {
        return;
      }
      const kind = typeof wire.type === 'string' ? ENDPOINT_EVENTS[wire.type] : undefined;
      if (kind === undefined) {
        return;
      }
      const atMs = typeof observation.atMs === 'number' ? observation.atMs : Date.now();
      if (kind === 'committed') {
        const itemId = typeof wire.item_id === 'string' ? wire.item_id : undefined;
        safe(() => options.store.timeline({ kind: 'committed', atMs, ...(itemId === undefined ? {} : { itemId }) }));
        return;
      }
      safe(() => options.store.timeline({ kind, atMs }));
    },
  };
}
