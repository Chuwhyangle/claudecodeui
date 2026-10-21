import { shouldHideToolResult } from '@/modules/chat/tools';
import { isWorkSegmentMember } from '@/modules/chat/utils/transcript/workSegments';
import type { ChatMessage } from '@/shared/types';

/**
 * The C2 ContextPack: the part of the conversation the person could actually SEE
 * SAID, rendered as plain `角色：文本` lines, newest last, inside a character budget.
 *
 * WHY IT EXISTS. The Realtime model that carries a person's words to Claude had no
 * idea what the session was about, so a turn like 「把那个改成三十秒」 reached Claude
 * with no referent (`docs/proposals/voice-realtime-segmented-relay-SPEC.md` §C2).
 * The pack is handed to the model as its `instructions` (the injection P0a-S3
 * validated), so 「那个」 has something to resolve against.
 *
 * WHY IT IS A PURE FUNCTION HERE, ON THE BROWSER SIDE. The rule for "what counts as
 * something said" already exists — the transcript's own work-run and tool-result
 * visibility rules — so this file READS those rules rather than restating them
 * ({@link isWorkSegmentMember}, `shouldHideToolResult`). A second implementation
 * would drift the moment either side changed.
 *
 * NO "LAST N TURNS". The budget is characters, taken newest-first until the next
 * row would not fit; a turn count would silently change what the model sees when
 * turns get longer, which is exactly what the SPEC rejects (D5).
 */

/** The SPEC's hard cap on a pack's length, in UTF-16 code units (`String.length`). */
export const VOICE_CONTEXT_BUDGET_CHARS = 2000;

/** The budget for one run's own output — the run-end summary's source. */
export const VOICE_RUN_OUTPUT_BUDGET_CHARS = 2000;

/** The SPEC's cap on one row, before elision. The elision keeps the row within it. */
export const VOICE_CONTEXT_ROW_CAP_CHARS = 600;

/** How many lines of a fenced code block a row keeps before its elision marker (SPEC: `codeHeadLines`). */
export const VOICE_CONTEXT_CODE_HEAD_LINES = 3;

/**
 * The row types that can carry something said.
 *
 * A whitelist, deliberately: every other row the transcript renders — `error`,
 * the `resident_pending` lifecycle row, an `unattended` turn nobody typed, the
 * divider above it — is about the session rather than said in it, and the SPEC
 * keeps all of them out of the pack.
 */
const SPOKEN_ROW_TYPES: ReadonlySet<string> = new Set(['user', 'assistant']);

/** One conversation row the pack kept. */
export type VoiceContextPackEntry = {
  /** `用户` or `助手` — the label the row is rendered under. */
  label: string;
  /** The row's text, already elided to the row cap. */
  text: string;
};

/** A built pack, in exactly the shape the `context` wire frame carries it. */
export type VoiceContextPack = {
  /** The pack: one `角色（时间）：文本` line per entry, oldest first, newest last. */
  text: string;
  /** `text.length` in UTF-16 code units — the unit the budget is expressed in. */
  chars: number;
  /** How many conversation rows the pack carries. */
  rows: number;
  /** The rows the text was rendered from, oldest first — what a criterion compares against the transcript's own filters. */
  entries: VoiceContextPackEntry[];
};

/** Knobs a caller may override; the SPEC's defaults are what ships. */
export type VoiceContextPackOptions = {
  budgetChars?: number;
  rowCapChars?: number;
  codeHeadLines?: number;
  /** The clock the relative times are read against. Injected so a test's pack is deterministic. */
  now?: number;
};

/**
 * Whether one transcript row is something the person could see said.
 *
 * The two halves are the SAME predicates the transcript itself uses, read from
 * their own modules:
 *
 *  - {@link isWorkSegmentMember} — thinking, tool calls, subagent containers and
 *    task notifications are work rows, not speech;
 *  - `shouldHideToolResult` — a tool result the transcript hides is not part of
 *    what the person read, and the tool row carrying it is already a work row
 *    above; reading the same function here is what keeps the two rules from
 *    drifting apart.
 *
 * The row TYPE whitelist comes first so a lifecycle row (SPEC §C2 「内部生命周期行」)
 * is refused on its own identity rather than on the absence of a work flag.
 */
export function isVoiceContextRow(message: ChatMessage): boolean {
  if (!SPOKEN_ROW_TYPES.has(message.type)) return false;
  if (isWorkSegmentMember(message)) return false;
  if (message.toolResult && shouldHideToolResult(String(message.toolName ?? 'UnknownTool'), message.toolResult)) {
    return false;
  }
  return true;
}

/**
 * Builds the pack for one connection.
 *
 * Rows are taken NEWEST FIRST — from the end of `messages` backwards — and the walk
 * STOPS at the first row that would not fit, so the pack always ends at the newest
 * thing said and never skips an old row to reach the budget. The result's `chars`
 * is therefore always ≤ `budgetChars`, for every input.
 */
export function buildVoiceContextPack(
  messages: readonly ChatMessage[],
  options: VoiceContextPackOptions = {},
): VoiceContextPack {
  const budgetChars = options.budgetChars ?? VOICE_CONTEXT_BUDGET_CHARS;
  const rowCapChars = options.rowCapChars ?? VOICE_CONTEXT_ROW_CAP_CHARS;
  const codeHeadLines = options.codeHeadLines ?? VOICE_CONTEXT_CODE_HEAD_LINES;
  const now = options.now ?? Date.now();

  // Gathered newest-first, then reversed into the pack's own order (oldest first).
  const taken: Array<{ label: string; time: string | null; text: string }> = [];
  let chars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isVoiceContextRow(message)) continue;

    const body = rowText(message, codeHeadLines);
    if (body === '') continue;

    const rowLabel = label(message);
    const time = relativeTime(message.timestamp, now);
    // The ROW cap is the row's own limit, so it is applied to the whole line — the
    // prefix it renders under included — not to the body alone.
    const line = elide(`${time === null ? rowLabel : `${rowLabel}（${time}）`}：${body}`, rowCapChars);
    // The joining newline counts against the budget too, so the rendered pack's
    // length is exactly what the budget check saw.
    const added = line.length + (taken.length === 0 ? 0 : 1);
    if (chars + added > budgetChars) break;

    taken.push({ label: rowLabel, time, text: line });
    chars += added;
  }

  taken.reverse();
  const text = taken.map((row) => row.text).join('\n');
  return {
    text,
    chars: text.length,
    rows: taken.length,
    entries: taken.map((row) => ({
      label: row.label,
      text: row.text.slice(row.text.indexOf('：') + 1),
    })),
  };
}

/**
 * One run's OWN output, rendered on demand as the run-end summary's source.
 *
 * NOT a conversation pack and NOT stored anywhere: the proxy asks for the turn that just ended,
 * this function walks the transcript at that moment, and the result is summarized and discarded.
 * The walk starts at the NEWEST visible assistant row and stops at the first user row, so a
 * message the person has already started in the meantime cannot pull the summary forward into the
 * next turn. Work rows (thinking, tools, subagents) are skipped by the same visibility rule the
 * transcript uses; an empty result means the run produced nothing the person could read.
 */
export function buildVoiceRunOutput(
  messages: readonly ChatMessage[],
  options: VoiceContextPackOptions = {},
): string {
  const budgetChars = options.budgetChars ?? VOICE_RUN_OUTPUT_BUDGET_CHARS;
  const rowCapChars = options.rowCapChars ?? VOICE_CONTEXT_ROW_CAP_CHARS;
  const codeHeadLines = options.codeHeadLines ?? VOICE_CONTEXT_CODE_HEAD_LINES;

  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== 'assistant' || !isVoiceContextRow(message)) continue;
    if (rowText(message, codeHeadLines) === '') continue;
    start = index;
    break;
  }
  if (start < 0) return '';

  const taken: string[] = [];
  let chars = 0;
  for (let index = start; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'user') break;
    if (!isVoiceContextRow(message)) continue;
    const body = rowText(message, codeHeadLines);
    if (body === '') continue;
    const line = elide(body, rowCapChars);
    const added = line.length + (taken.length === 0 ? 0 : 2);
    if (chars + added > budgetChars) break;
    taken.push(line);
    chars += added;
  }
  taken.reverse();
  return taken.join('\n\n');
}

/** The row's label: the two roles the SPEC renders (user, assistant). */
function label(message: ChatMessage): string {
  return message.type === 'user' ? '用户' : '助手';
}/**
 * The row's text: its body, plus one placeholder per attachment.
 *
 * Attachments are placeholders because the pack is TEXT the model reads and the
 * bytes are not in it: `[图片]` says a picture was there, `[文件 x.ts]` says which
 * file, which is what a spoken reference like 「那个截图」 needs to resolve against.
 * A row with neither text nor attachments contributes nothing.
 */
function rowText(message: ChatMessage, codeHeadLines: number): string {
  const parts: string[] = [];
  const body = (message.content || message.displayText || '').trim();
  if (body !== '') parts.push(condenseCodeBlocks(body, codeHeadLines));
  for (let index = 0; index < (message.images?.length ?? 0); index += 1) parts.push('[图片]');
  for (const file of message.files ?? []) {
    const name = typeof file.name === 'string' && file.name.trim() !== '' ? file.name.trim() : '附件';
    parts.push(`[文件 ${name}]`);
  }
  return parts.join(' ');
}

/**
 * Keeps a fenced code block's head and says how much was dropped.
 *
 * A long code block is exactly the shape that eats a character budget while
 * carrying nothing a voice turn refers to; the first lines say what the block IS
 * and the marker says how big it was. An unterminated fence (a reply still
 * streaming) is left alone rather than guessed at.
 */
function condenseCodeBlocks(text: string, codeHeadLines: number): string {
  if (codeHeadLines < 0 || !text.includes('```')) return text;

  const lines = text.split('\n');
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trimStart().startsWith('```')) {
      output.push(line);
      index += 1;
      continue;
    }

    const fence = line;
    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !lines[cursor].trimStart().startsWith('```')) {
      body.push(lines[cursor]);
      cursor += 1;
    }
    const closed = cursor < lines.length;

    if (!closed || body.length <= codeHeadLines) {
      output.push(fence, ...body);
      index = cursor;
      if (closed) {
        output.push(lines[cursor]);
        index = cursor + 1;
      }
      continue;
    }

    output.push(fence, ...body.slice(0, codeHeadLines), `…（省略 ${body.length - codeHeadLines} 行）`, lines[cursor]);
    index = cursor + 1;
  }
  return output.join('\n');
}

/**
 * Elides one over-long row to at most `cap` characters: the head 70%, `…`, the tail 30%.
 *
 * The ellipsis comes out of the tail, so the row is never longer than the cap — a
 * cap that could be overshot by one character would make the pack's own limit a
 * suggestion rather than a limit.
 */
function elide(text: string, cap: number): string {
  if (text.length <= cap) return text;
  if (cap <= 1) return text.slice(0, Math.max(cap, 0));

  const head = Math.floor(cap * 0.7);
  const tail = cap - head - 1;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * A row's age as the pack renders it, or `null` when the row carries no readable time.
 *
 * Coarse on purpose: the model only needs to know the order of what it is reading,
 * and a finer-grained clock would spend budget on seconds.
 */
function relativeTime(timestamp: ChatMessage['timestamp'], now: number): string | null {
  const at = timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp));
  if (!Number.isFinite(at)) return null;

  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
