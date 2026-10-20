/**
 * The on-disk store of what the user dictated — the D1 "local only" data, default ON.
 *
 * SEPARATE FROM THE DIAGNOSTIC CAPTURE (`voice-capture.ts`) IN EVERY DIMENSION THAT MATTERS. That
 * module is a DEPLOYMENT property: `VOICE_CAPTURE` is read once at start-up, defaults off, and an
 * unrecognised value fails closed. This one is a USER property: it defaults ON, the user's own
 * stored setting turns it off, and the user can clear it. The two share a directory SHAPE and the
 * 0700/0600 permission discipline and nothing else — keeping `VOICE_CAPTURE`'s fail-closed
 * semantics untouched is a requirement of this task, not an accident of the split.
 *
 * WHAT IS STORED. One record per successful transcription: a JSON document naming the provider and
 * the recognised text (with the recogniser's per-token facts when it produced them) plus the
 * segment audio that produced them. A record is `{ recordId, ts, providerId, buildId?, segments,
 * finalText?, labels? }`, where each segment is `{ index, audioFile, text, tokens? }`. The first
 * write produces the leading keys; `finalText`/`labels` arrive later, from `label`, when the user
 * sends an edited transcript — see `VoiceDataRecord` for why they are absent rather than empty on a
 * listen that was never corrected. A record may also carry a `flagStats` document beside those
 * segments — the confidence shadow's per-threshold mark counts, written by the service for a
 * recogniser that declared per-token confidence, and absent otherwise. Nothing this module writes is
 * a credential: the audio and the text are the user's own, and the settings document — keys, tokens,
 * request headers — is never a field of a record.
 *
 * NOTHING HERE LEAVES THE PROCESS. The only imports are node builtins (`fs`, `path`, `os`,
 * `crypto`); a record is built from what the caller already holds. That is the "stays on this
 * machine" half of D1, and it is asserted by a criterion that reads this file for transport imports
 * rather than trusted to a promise.
 *
 * THE PERMISSIONS ARE THE REASON THE WRITE IS NOT THREE OBVIOUS LINES. `mkdirSync`'s and
 * `writeFileSync`'s `mode:` is a REQUEST the kernel applies THROUGH the process's umask, so under
 * `umask 0o000` an asked-for 0600 lands 0666. Each create is therefore followed by an explicit
 * `chmod` on the same path, which makes the mode a fact about the file rather than about the shell
 * that started the server; the `mode:` argument is kept as well so the window between create and
 * chmod is not a window in the ordinary case.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { directoryBytes } from '@/shared/fs-bytes.js';
import type { VoiceDataEditLabel, VoiceSettings } from '@/shared/types.js';

import type { AsrToken } from '../../../shared/asr/asrRegistry.js';
import type { ConfidenceFlagStats } from '../../../shared/asr/confidenceFlags.js';

/**
 * The directory's own name, under the database's parent — `~/.cloudcli/voice-data` by default.
 *
 * THE SAME SHAPE `voice-capture` USES, with its own leaf: a deployment that moved its database
 * moves its voice data with it, and the two stores sit side by side under one parent rather than
 * one of them reaching for a second reading of the database configuration.
 */
const VOICE_DATA_DIRECTORY_NAME = 'voice-data';

/** The fallback database path the default directory is derived from, mirroring the capture store. */
const DEFAULT_DATABASE_FILE = '.cloudcli/auth.db';

/** The directory's mode and the files' mode, both applied explicitly (see the header). */
const VOICE_DATA_DIR_MODE = 0o700;
const VOICE_DATA_FILE_MODE = 0o600;

/** The two suffixes this store owns: a record document and one segment's audio. */
const RECORD_EXTENSION = '.json';
const SEGMENT_EXTENSION = '.wav';

/**
 * The ceiling on the directory, in bytes, when the user's settings name none: 2 GiB.
 *
 * A SHIPPED DEFAULT rather than a policy about recordings — the setting is the user's to change
 * (see `voiceDataMaxBytes`), and the store applies whatever it is told. It exists so a deployment
 * that never opens the settings still has a bound rather than growing without one.
 */
export const DEFAULT_VOICE_DATA_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The smallest ceiling a settings document may name: 1 KiB.
 *
 * A bound, not a policy: the user's own setting has to be a number the store can act on, and a
 * ceiling below one record is the same thing as a ceiling of zero — every write is immediately
 * evicted, which reads as "recording is broken" rather than as "the cap is tiny". The criterion
 * that exercises eviction uses 50 KiB, comfortably above this floor.
 */
export const MIN_VOICE_DATA_MAX_BYTES = 1024;

/**
 * One transcribed segment, as it is stored.
 *
 * `tokens` is present only when the selected recogniser actually produced per-token facts — the
 * same absence-means-none rule the service already applies to the response, so a segment written
 * from a recogniser that declares no tokens carries the field nowhere.
 */
export type VoiceDataSegment = {
  /** The segment's ordinal within its record. The first (and, today, only) one is `0`. */
  index: number;
  /** The audio file beside this record that holds this segment, named `<recordId>-<index>.wav`. */
  audioFile: string;
  /** The text the recogniser returned for this segment. */
  text: string;
  tokens?: AsrToken[];
};

/**
 * One transcription, as it is stored.
 *
 * THE FIRST THREE KEYS ARE WRITTEN AT TRANSCRIPTION TIME and the two after them are not: `finalText`
 * and `labels` are the correction loop's, filled by `label` when the user sends an edited transcript,
 * and they are the reason a record is worth keeping at all — they are the `听到 → 想说` pair the
 * recogniser's mistake and the user's repair together produced. They stay absent until that send,
 * which is what makes "this transcription was never corrected" readable off the record rather than
 * inferred from an empty string. `flagStats` is the confidence shadow's own document and IS written
 * — by the service, when the selected recogniser declared per-token confidence — and absent
 * otherwise, the same absence-not-placeholder rule the rest of the record follows.
 */
export type VoiceDataRecord = {
  recordId: string;
  /** When the record was written, in milliseconds since the epoch. The eviction order's key. */
  ts: number;
  providerId: string;
  buildId?: string;
  segments: VoiceDataSegment[];
  /** The text the user actually sent, when it differs from what was recognised. Filled by `label`. */
  finalText?: string;
  /** The `heard → final` pairs `labelsFor` derived at send time. Filled by `label`. */
  labels?: VoiceDataEditLabel[];
  /** The confidence shadow's mark counts, when the recogniser declared per-token confidence. */
  flagStats?: ConfidenceFlagStats;
};

/** What one successful transcription hands the store. */
export type VoiceDataRecordInput = {
  /**
   * The user's stored settings. Recording is off ONLY when this says `false`.
   *
   * ABSENT AND DEFAULTED ARE THE SAME READING: a user who never opened the settings has no such
   * key, and D1 says that user's dictation IS recorded. Anything other than the literal `false`
   * therefore records, which is what makes the default-on promise a property of this gate rather
   * than of a document somebody has to write first.
   */
  settings: VoiceSettings | undefined;
  providerId: string;
  buildId?: string;
  text: string;
  tokens?: AsrToken[];
  /**
   * The confidence shadow's mark counts for this transcription, when one was computed.
   *
   * THE SERVICE DECIDES WHETHER THIS EXISTS, and the store only keeps what it is handed: whether
   * the selected recogniser declared per-token confidence is a fact about the adapter, which this
   * module never sees. Absent therefore means "there was nothing to count" — a recogniser that
   * declared no confidence, or a caller that never computed the shadow — and the field is left off
   * the record rather than written empty, so a reader can tell the two apart from the file alone.
   */
  flagStats?: ConfidenceFlagStats;
  /** The audio this transcription was made from, exactly as it was uploaded. */
  audio: Uint8Array;
};

/** Where a stored record landed: the id the caller returns and the audio file beside it. */
export type VoiceDataRecordResult = { recordId: string; audioFile: string };

/**
 * What the correction loop hands the store: the text the user sent and the pairs derived from the
 * edit that produced it, addressed to the record one transcription already wrote.
 *
 * `finalText` and `labels` are stored VERBATIM rather than interpreted. Whether a pair is a
 * correction or a rewrite is `labelsFor`'s judgement, made on the client where the segment text and
 * the box are both in hand; the store's job is to keep what it is given beside the audio it belongs
 * to. A store that re-derived the labels could disagree with the client that showed the user what
 * was kept.
 */
export type VoiceDataLabelInput = {
  /** The id a previous `record` returned. An id no record carries is refused, not created. */
  recordId: string;
  finalText: string;
  labels: VoiceDataEditLabel[];
};

/** The answer to a clear: how many record documents were removed. */
export type VoiceDataClearResult = { deleted: number };

/**
 * The store the service holds.
 *
 * `record` returns `null` when recording is off — the gate is the store's own switch, read off the
 * passed settings, so the caller does not have to know the setting's name to respect it. I/O
 * failures throw, and the service catches them: a store that cannot write must never cost the user
 * the transcription it was trying to keep.
 */
export type VoiceDataStore = {
  record(input: VoiceDataRecordInput): VoiceDataRecordResult | null;
  /**
   * Writes the sent text and its labels onto an EXISTING record, answering whether it found one.
   *
   * A `false` is the "no such recording" answer rather than an error, and it is the store's to give
   * because the store is the only thing that knows: the record may have been evicted by the capacity
   * ceiling, or cleared by the user, between the transcription and the send. Creating a record here
   * instead would be the wrong repair — audio-less records would accumulate for edits the user made
   * to a listen whose audio is already gone.
   */
  label(input: VoiceDataLabelInput): boolean;
  clear(): VoiceDataClearResult;
  directory(): string;
};

/**
 * Where voice data goes, from the two values the composition root read.
 *
 * THE INPUTS ARE ARGUMENTS, for the same reason `resolveVoiceCaptureDir`'s are: the environment
 * belongs to the composition root, and a resolver that read a variable itself could not be asked
 * what a given pair of values means without mutating the process first. An explicit directory wins;
 * otherwise the default sits BESIDE THE DATABASE, so a deployment that moved its state moved its
 * recordings with it.
 *
 * THIS ONLY COMPUTES A PATH. Nothing is created here — the writer creates the directory on the
 * first record it actually writes — which is why a user who turned recording off leaves no
 * directory behind even though one was resolved.
 */
export function resolveVoiceDataDir(raw: string | undefined, databasePath: string | undefined): string {
  const explicit = raw === undefined ? '' : raw.trim();
  if (explicit !== '') {
    return explicit;
  }

  const database = databasePath === undefined || databasePath.trim() === ''
    ? path.join(os.homedir(), DEFAULT_DATABASE_FILE)
    : databasePath;
  return path.join(path.dirname(database), VOICE_DATA_DIRECTORY_NAME);
}

/** The start-up line naming where records land, one literal with nothing to construct. */
export function voiceDataDirStartupLine(directory: string): string {
  return `voice.data dir=${directory}`;
}

/** The characters a record's file name may keep — the capture module's own alphabet, reused. */
function pathSafeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The ceiling to enforce, from whatever the settings document carried.
 *
 * A value the store cannot act on — absent, non-finite, or below the floor — reads as the shipped
 * default rather than as "unbounded", which is the safe direction: a malformed cap must not be the
 * one that lets a directory grow without a bound. The value is floored so it stays an integer
 * number of bytes even if a client sent a fraction.
 */
function normalizeMaxBytes(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_VOICE_DATA_MAX_BYTES
    ? Math.floor(value)
    : DEFAULT_VOICE_DATA_MAX_BYTES;
}

/** The record's own `ts`, or `null` when the file is unreadable or carries none. */
function readRecordTs(recordPath: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') {
      const ts = (parsed as { ts?: unknown }).ts;
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        return ts;
      }
    }
  } catch {
    // An unreadable record is not a reason to stop: it is still a file on disk (it counts toward
    // the total and is evicted by its mtime below), and it is not a reason to fail the write that
    // is happening now.
  }
  return null;
}

/**
 * One record's files, and the age eviction orders them by.
 *
 * `files` holds every file that belongs to the record — its JSON document and its segment audio —
 * so deleting the group deletes both halves and leaves no orphan audio behind.
 */
type StoredGroup = { ts: number; mtimeMs: number; files: string[] };

/**
 * Every record in the directory, oldest first.
 *
 * The order is (`ts`, then the record file's `mtimeMs`, then its name). `ts` is the semantic
 * timestamp and is what "oldest first" means; the mtime tiebreak matters because two records
 * written in the same millisecond share a `ts`, and the filesystem's own nanosecond timestamp is
 * what keeps their order the order they were written in rather than whatever `readdir` returned.
 *
 * A `.wav` with no matching `.json` — an orphan from a crash between the two writes — is still a
 * group of its own, keyed by its mtime, so it is bounded by the same ceiling as everything else
 * rather than accumulating forever.
 */
function listStoredGroups(directory: string): StoredGroup[] {
  const groups = new Map<string, StoredGroup>();
  const groupFor = (stem: string, ts: number, mtimeMs: number): StoredGroup => {
    const existing = groups.get(stem);
    if (existing) {
      // The record's own document defines the group's age; an audio file only ever raises a group
      // into existence when no document exists (the orphan case).
      return existing;
    }
    const created: StoredGroup = { ts, mtimeMs, files: [] };
    groups.set(stem, created);
    return created;
  };

  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }

    if (name.endsWith(RECORD_EXTENSION)) {
      const stem = name.slice(0, -RECORD_EXTENSION.length);
      const ts = readRecordTs(full);
      groupFor(stem, ts ?? stats.mtimeMs, stats.mtimeMs).files.push(name);
    } else if (name.endsWith(SEGMENT_EXTENSION)) {
      // `<recordId>-<segmentIndex>.wav`; the group stem is everything before the final `-<digits>`.
      const stem = name.slice(0, -SEGMENT_EXTENSION.length).replace(/-\d+$/, '');
      groupFor(stem, stats.mtimeMs, stats.mtimeMs).files.push(name);
    }
  }

  return [...groups.values()].sort((left, right) => (
    left.ts - right.ts || left.mtimeMs - right.mtimeMs || 0
  ));
}

/**
 * Trims the directory to the ceiling, OLDEST RECORD FIRST.
 *
 * Deletes whole records — the JSON document and the audio it names together — so a directory left
 * over the ceiling never holds a record whose audio is gone. The just-written record is the newest
 * and is therefore the last candidate, which is what makes "write then trim" leave the record the
 * caller is about to return on disk in every case the record fits at all.
 */
function evictToLimit(directory: string, maxBytes: number): void {
  let total = directoryBytes(directory);
  if (total <= maxBytes) {
    return;
  }

  for (const group of listStoredGroups(directory)) {
    if (total <= maxBytes) {
      break;
    }
    for (const name of group.files) {
      const full = path.join(directory, name);
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        size = 0;
      }
      rmSync(full, { force: true });
      total -= size;
    }
  }
}

/** Writes one record (and its audio), then trims. `null` when the user turned recording off. */
function recordToStore(directory: string, input: VoiceDataRecordInput): VoiceDataRecordResult | null {
  if (input.settings?.voiceDataRecording === false) {
    return null;
  }
  const maxBytes = normalizeMaxBytes(input.settings?.voiceDataMaxBytes);

  // The directory appears HERE, on the first record that is actually written, and not when the
  // store was built or when a directory was resolved: a user who never records leaves no directory
  // behind even though one was configured for them.
  mkdirSync(directory, { recursive: true, mode: VOICE_DATA_DIR_MODE });
  chmodSync(directory, VOICE_DATA_DIR_MODE);

  // A fresh id rather than anything the request carried: the upload's name is the caller's string,
  // and a name built from it could leave the directory. `randomUUID` is this module's own, so a
  // file name built from it is already safe; `pathSafeStem` is the second lock for the same door.
  const recordId = randomUUID();
  const stem = pathSafeStem(recordId);
  const segmentIndex = 0;
  const audioFile = `${stem}-${segmentIndex}${SEGMENT_EXTENSION}`;
  const audioPath = path.join(directory, audioFile);

  // The audio first, so the file the record names is already on disk when a reader sees the name.
  writeFileSync(audioPath, input.audio, { flag: 'wx', mode: VOICE_DATA_FILE_MODE });
  chmodSync(audioPath, VOICE_DATA_FILE_MODE);

  const record: VoiceDataRecord = {
    recordId,
    ts: Date.now(),
    providerId: input.providerId,
    // Each optional field is OMITTED rather than written as `undefined`/`null`, matching the
    // service's own rule for the response: a key a recogniser did not produce is absent here too.
    ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
    segments: [
      {
        index: segmentIndex,
        audioFile,
        text: input.text,
        ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
      },
    ],
    // Kept verbatim when the caller computed it, omitted when it did not — the same
    // absence-not-placeholder rule the segment's `tokens` and the record's `buildId` follow.
    ...(input.flagStats === undefined ? {} : { flagStats: input.flagStats }),
  };

  const recordPath = path.join(directory, `${stem}${RECORD_EXTENSION}`);
  writeFileSync(recordPath, JSON.stringify(record), { mode: VOICE_DATA_FILE_MODE });
  chmodSync(recordPath, VOICE_DATA_FILE_MODE);

  evictToLimit(directory, maxBytes);

  return { recordId, audioFile };
}

/**
 * Writes the sent text and its labels onto an existing record; `false` when there is no such record.
 *
 * A READ-MODIFY-WRITE OF THE ONE DOCUMENT, and deliberately nothing more: the audio beside it is
 * untouched (it is what the labels are ABOUT), the record's `ts` is not refreshed (it is the
 * eviction order's key, and a correction does not make the recording new — an edit to an old listen
 * must not push it in front of recordings the user made since), and the record's other keys are
 * carried through by the spread rather than rebuilt, so a key a later task adds survives a label
 * write without this function having to know about it.
 *
 * THE PATH IS BUILT FROM THE ID rather than searched for, which is why a wrong id is a `false` and
 * not a match against some other record's file: `pathSafeStem` reduces the id to one safe file-name
 * component, so an id carrying `/` or `..` addresses a file that cannot exist rather than one
 * outside the directory. The record's own `recordId` is compared as well, which is what makes a stem
 * collision — two ids that sanitise to one name — a miss instead of a write to the wrong record.
 *
 * The mode is re-applied after the write for the same reason the original write applies it: a
 * rewrite is a create of a new inode under this process's umask, and the 0600 promise has to hold
 * for the document the labels land in.
 */
function labelRecord(directory: string, input: VoiceDataLabelInput): boolean {
  const recordPath = path.join(directory, `${pathSafeStem(input.recordId)}${RECORD_EXTENSION}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    // Absent, unreadable or not JSON: in every case there is no record here to label, which is the
    // `false` the caller turns into a 404. An eviction and a bad id are the same answer to a client.
    return false;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return false;
  }
  const record = parsed as VoiceDataRecord;
  if (record.recordId !== input.recordId) {
    return false;
  }

  const labelled: VoiceDataRecord = {
    ...record,
    finalText: input.finalText,
    labels: input.labels,
  };
  writeFileSync(recordPath, JSON.stringify(labelled), { mode: VOICE_DATA_FILE_MODE });
  chmodSync(recordPath, VOICE_DATA_FILE_MODE);
  return true;
}

/**
 * Removes every file this store owns, and answers how many RECORDS were among them.
 *
 * A missing directory answers `0` rather than failing: "there is nothing here to clear" is the
 * success case of a clear, and a user who turned recording off — who therefore has no directory —
 * must be able to clear without an error. The count is the record documents, not the files, so it
 * reads as "how many recordings were removed" rather than double-counting each one's audio.
 */
function clearStore(directory: string): VoiceDataClearResult {
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
    if (name.endsWith(RECORD_EXTENSION)) {
      deleted += 1;
    }
    rmSync(path.join(directory, name), { force: true, recursive: true });
  }
  return { deleted };
}

/** What the store is built from: the directory the composition root has already resolved. */
export type VoiceDataStoreOptions = {
  directory: string;
};

/**
 * The shipping store: the write, the clear, and the directory's creation and permissions.
 *
 * THE DIRECTORY IS DISTRIBUTED IN, not read here, for the same reason the capture sink takes one:
 * the environment belongs to the composition root, so "where does voice data go" has one answer
 * produced by the deployment's own configuration.
 */
export function createVoiceDataStore(options: VoiceDataStoreOptions): VoiceDataStore {
  return {
    record: (input) => recordToStore(options.directory, input),
    label: (input) => labelRecord(options.directory, input),
    clear: () => clearStore(options.directory),
    directory: () => options.directory,
  };
}
