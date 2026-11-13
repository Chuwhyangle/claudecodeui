import { open, type FileHandle } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';

/**
 * The window a transcript read starts from, and the ceilings it may grow to.
 *
 * Titles are rewritten near the end of a file (`ai-title` on every round, a
 * `/rename`'s `custom-title` appended last), so the tail is where the newest
 * one is; the head holds the ones written once and never revised, and the first
 * prompt a session's name is derived from. Measured over one machine's corpus
 * (1282 transcripts): a 64 KiB tail window reached the last `custom-title` in
 * every file that has one, the deepest sitting 33 KiB from the end, and the
 * head window reached the first prompt of every file with one at 625 KiB, so
 * the ceilings below are the growth the corpus actually asked for rather than a
 * round number chosen in advance. Both are hard: a transcript's size must never
 * decide how much of it a title read costs.
 */
const TRANSCRIPT_TITLE_INITIAL_WINDOW_BYTES = 64 * 1024;
export const TRANSCRIPT_TITLE_TAIL_MAX_WINDOW_BYTES = 512 * 1024;
export const TRANSCRIPT_TITLE_HEAD_MAX_WINDOW_BYTES = 1024 * 1024;

/** Which end of a transcript a window is read from. */
export type TranscriptWindowEnd = 'head' | 'tail';

/** How one bounded window read folds the entries it sees into an answer. */
export type TranscriptWindowFold<S> = {
  /** The state before any entry has been seen. */
  initial: S;
  /** Folds one parsed entry in. Entries arrive in file order, oldest first. */
  fold: (state: S, entry: Record<string, unknown>) => S;
  /**
   * Whether the state already answers the question. Checked between windows,
   * so a caller that has its answer stops the read from growing.
   */
  isComplete: (state: S) => boolean;
};

/**
 * Reads up to `length` bytes at `offset`, however many `read` calls that takes.
 *
 * One `FileHandle.read` may return a short count — and does when another
 * process rewrites a transcript mid-read — so a single call cannot be treated
 * as the whole range. Reading until the range is filled keeps the window's
 * start offset honest; the loop still ends on a real EOF.
 */
async function readBytes(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;

  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead <= 0) {
      break;
    }
    filled += bytesRead;
  }

  return buffer.subarray(0, filled);
}

/**
 * Folds the complete JSON entries of one window's lines, in file order.
 *
 * A window rarely starts and ends on a line boundary, so the caller says which
 * ends are fragments of a line it does not hold: a fragment is dropped rather
 * than parsed, because half a JSON entry is not an entry and the line it
 * belongs to is outside the bound this read is held to.
 */
function foldWindowLines<S>(
  text: string,
  state: S,
  fold: TranscriptWindowFold<S>['fold'],
  trim: { leadingFragment: boolean; trailingFragment: boolean },
): S {
  const lines = text.split('\n');
  if (trim.leadingFragment) {
    lines.shift();
  }
  if (trim.trailingFragment) {
    lines.pop();
  }

  let folded = state;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A transcript can hold a truncated line — a session that was killed
      // mid-write leaves one — and it names nothing whatever it was.
      continue;
    }

    if (parsed === null || typeof parsed !== 'object') {
      continue;
    }

    folded = fold(folded, parsed as Record<string, unknown>);
  }

  return folded;
}

/**
 * Walks one transcript's JSON entries from one end, within a hard byte bound,
 * and returns the caller's folded answer.
 *
 * The window grows from 64 KiB by a factor of four until the answer is complete
 * or the ceiling is reached, reading only the bytes it does not already hold,
 * so a file that needs the ceiling costs one read of the ceiling rather than
 * the sum of every window on the way there. A transcript that fits inside the
 * first window is read once, in full, and never re-read.
 *
 * Both ends are bounded and neither degenerates into a whole-file read: this is
 * the primitive that lets a title be found at the end of a transcript, or at
 * its beginning, without the cost growing with a file that reaches hundreds of
 * megabytes. A caller therefore chooses the end that holds the entry it wants,
 * and a second call for the other end pays its own window.
 *
 * A missing or unreadable file returns the initial state rather than throwing:
 * sync must survive a transcript that disappears between the scan's listing and
 * the read, and so must the `/cost` modal.
 */
export async function readTranscriptWindow<S>(
  filePath: string,
  options: {
    from: TranscriptWindowEnd;
    maxBytes: number;
    initialBytes?: number;
  } & TranscriptWindowFold<S>,
): Promise<S> {
  const initialBytes = Math.min(
    options.initialBytes ?? TRANSCRIPT_TITLE_INITIAL_WINDOW_BYTES,
    options.maxBytes,
  );

  let handle: FileHandle | undefined;
  let state = options.initial;

  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    if (size <= 0) {
      return state;
    }

    const fromTail = options.from === 'tail';
    let windowBytes = Math.min(initialBytes, size);
    let window = fromTail
      ? await readBytes(handle, size - windowBytes, windowBytes)
      : await readBytes(handle, 0, windowBytes);
    let windowStart = fromTail ? size - windowBytes : 0;

    for (;;) {
      // Only the part of the window that was not folded last time is folded
      // now: an entry may not be counted twice, and the state already holds the
      // newer half — widening happens only when that half had nothing to say.
      state = foldWindowLines(window.toString('utf8'), state, options.fold, {
        leadingFragment: windowStart > 0,
        trailingFragment: windowStart + window.length < size,
      });

      if (options.isComplete(state)) {
        return state;
      }

      if (windowStart === 0 && windowStart + window.length >= size) {
        return state;
      }
      if (window.length >= options.maxBytes) {
        return state;
      }

      const widenedBytes = Math.min(windowBytes * 4, options.maxBytes, size);
      if (widenedBytes <= windowBytes) {
        return state;
      }

      if (fromTail) {
        const widenedStart = size - widenedBytes;
        const prefix = await readBytes(handle, widenedStart, windowStart - widenedStart);
        if (prefix.length === 0) {
          // The file shrank under the scan, so there is nothing older to read
          // and the window already searched is all this file has.
          return state;
        }
        window = prefix;
        windowStart = widenedStart;
      } else {
        const suffix = await readBytes(
          handle,
          windowStart + window.length,
          widenedBytes - window.length,
        );
        if (suffix.length === 0) {
          return state;
        }
        windowStart += window.length;
        window = suffix;
      }
      windowBytes = widenedBytes;
    }
  } catch {
    return state;
  } finally {
    try {
      await handle?.close();
    } catch {
      // A close failure cannot change the answer this helper already produced.
    }
  }
}

/**
 * Reads the `ai-title` Claude generated for a session, straight from the
 * transcript that session's row points at.
 *
 * Consumed by the commands module's `/cost` handler, which shows the generated
 * title in the command modal's meta block. It cannot come from the session row:
 * the row's name is whichever name won the precedence order, so a session the
 * user renamed reads back as their word and the generated title is nowhere in
 * the database. And it is the *newest* `ai-title` that is wanted, not the first:
 * Claude revises the title as a conversation goes on, and a caller asking what
 * Claude currently calls this session means the last one it wrote, not an
 * earlier draft it has since replaced.
 *
 * The row is resolved by provider id first and app id second, the same way the
 * websocket module's session-upsert broadcast does, because callers hold
 * either id depending on where they came from. Every state with no answer to
 * give returns null rather than throwing — an unknown session, a non-Claude
 * provider, a row with no transcript, a missing or unreadable file, a
 * transcript that carries no generated title — because the caller is
 * assembling a command result that must not fail over a missing title.
 */
export async function readSessionAiTitle(sessionId: string): Promise<string | null> {
  const row = sessionsDb.getSessionByProviderSessionId(sessionId)
    ?? sessionsDb.getSessionById(sessionId);

  if (!row || row.provider !== 'claude' || !row.jsonl_path) {
    return null;
  }

  // A transcript names its own session, and an app-created row records that id
  // separately from its app-facing one. Rows predating the mapping carry no
  // provider id; for those the two ids are equal anyway.
  const providerSessionId = row.provider_session_id ?? row.session_id;

  return readTranscriptAiTitle(row.jsonl_path, providerSessionId);
}

/**
 * Reads the newest `ai-title` a transcript holds for `providerSessionId`, or
 * null when the transcript carries none.
 *
 * This is the transcript-addressed half of {@link readSessionAiTitle}, split out
 * for the caller that already holds the file: the resident host driver reads the
 * title of the process it is holding straight out of the transcript the CLI is
 * writing, and resolving that path through a session row would make a live
 * reading wait on a scan that may not have reached the file yet.
 *
 * The value is Claude's own generated title, verbatim, and nothing else: the
 * fold keeps only `ai-title` entries belonging to this session (see
 * {@link readAiTitleEntry}), so a transcript with no generated title answers
 * null rather than the caller's ladder falling through to a prompt or a display
 * name. That distinction is the whole contract — a caller that mirrors this
 * value into something a person reads must never be handed a title Claude did
 * not write.
 */
export async function readTranscriptAiTitle(
  transcriptPath: string | null,
  providerSessionId: string,
): Promise<string | null> {
  if (!transcriptPath) {
    return null;
  }

  const readFrom = (from: TranscriptWindowEnd, maxBytes: number) =>
    readTranscriptWindow<string | null>(transcriptPath, {
      from,
      maxBytes,
      initial: null,
      // The last one in the window wins, so the fold keeps every match it sees
      // and the window that holds the newest title is the one that answers.
      fold: (found, entry) => readAiTitleEntry(entry, providerSessionId) ?? found,
      isComplete: (found) => found !== null,
    });

  // The end first: a title revised every round is rewritten there, and one
  // window usually reaches it. A transcript whose only title sits near the
  // beginning — a session that was titled once and then grew — is answered by
  // the head window instead, which costs its own bound and nothing more.
  return (await readFrom('tail', TRANSCRIPT_TITLE_TAIL_MAX_WINDOW_BYTES))
    ?? readFrom('head', TRANSCRIPT_TITLE_HEAD_MAX_WINDOW_BYTES);
}

/**
 * Returns the `ai-title` one parsed transcript entry carries for
 * `providerSessionId`, or null when the entry carries none.
 *
 * Shared with the Claude session synchronizer so that the title it stores on a
 * session row and the title the command modal shows are read by one rule: the
 * entry must be an `ai-title`, must belong to this session — a subagent
 * transcript repeats its parent's entries under its own id — and must carry
 * non-blank text. The text itself is returned verbatim: it is Claude's own
 * wording, and it is the whole point that a rename cannot overwrite it.
 */
export function readAiTitleEntry(
  parsedJson: unknown,
  providerSessionId: string
): string | null {
  const data = parsedJson as Record<string, unknown>;
  if (data.type !== 'ai-title' || data.sessionId !== providerSessionId) {
    return null;
  }

  const title = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
  return title?.trim() ? title : null;
}
