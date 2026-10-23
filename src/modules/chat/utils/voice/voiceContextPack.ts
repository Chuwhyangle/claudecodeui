import { shouldHideToolResult } from '@/modules/chat/tools';
import { isWorkSegmentMember } from '@/modules/chat/utils/transcript/workSegments';
import type { ChatMessage, QuayFocusableObject, QuayObjectPos, QuayObjectUri } from '@/shared/types';

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
 * TWO BOUNDS, ONE PACK. The character budget remains the hard cap; a row cap (4 by default) limits
 * how many separate utterances the pack can carry, so four very long rows cannot crowd out the most
 * recent one. The row cap is calibrated from the 24 real C2 packs (2026-10-23) and is a ROW COUNT,
 * not a turn count: D5's objection to a turn window is that turns get longer, and the character
 * budget still does the length limiting. Both bounds are runtime knobs now (the deployment's
 * settings file, delivered through `GET /api/voice/runtime-config`); the constants below are the
 * shipped defaults and {@link VOICE_CONTEXT_PACK_CEILING} is the browser's hard limit.
 */

/**
 * The shipped hard cap on a pack's length, in UTF-16 code units (`String.length`).
 *
 * 1,200 from 2026-10-23: the 24 real C2 packs averaged 1,822 chars / ~9 rows; taking the newest 4
 * rows under 1,200 chars averages 873 chars and retains every observed Latin/number anchor. The
 * deployment can retune this through the settings file; the browser applies
 * {@link VOICE_CONTEXT_PACK_CEILING} on top.
 */
export const VOICE_CONTEXT_BUDGET_CHARS = 1200;

/** The budget for one run's own output — the run-end summary's source. */
export const VOICE_RUN_OUTPUT_BUDGET_CHARS = 2000;

/** The shipped cap on one row, before elision. The elision keeps the row within it. */
export const VOICE_CONTEXT_ROW_CAP_CHARS = 600;

/**
 * The shipped cap on how many conversation rows one pack may carry, newest first.
 *
 * A second bound beside {@link VOICE_CONTEXT_BUDGET_CHARS}: four rows keep the recent-turn structure
 * the referent/term cases use, while the character budget keeps any four rows from becoming
 * arbitrarily long. Not applied to {@link buildVoiceRunOutput}, which is one run's own output
 * rather than a conversation pack.
 */
export const VOICE_CONTEXT_MAX_ROWS = 4;

/**
 * The browser's own hard ceiling on a runtime-configured pack.
 *
 * THE FILE VALUES ONLY TAKE EFFECT INSIDE THIS RANGE, and that is a security property rather than a
 * taste: the page is what renders and sends the pack, so a bogus or compromised reading must not be
 * able to make it build something the protocol was never sized for. A value past the ceiling is
 * clamped here (never silently enlarged); the server's loader/endpoint already rejects such values
 * and answers with the defaults, so this is the second line of the same defence.
 */
export const VOICE_CONTEXT_PACK_CEILING = {
  maxRows: 12,
  budgetChars: 4000,
  rowCapChars: 2000,
} as const;

/** The shipped runtime values, used when no server reading arrived. */
export const VOICE_CONTEXT_PACK_DEFAULTS = {
  maxRows: VOICE_CONTEXT_MAX_ROWS,
  budgetChars: VOICE_CONTEXT_BUDGET_CHARS,
  rowCapChars: VOICE_CONTEXT_ROW_CAP_CHARS,
} as const;

/**
 * A runtime reading from `GET /api/voice/runtime-config`, with every value clamped to the
 * browser's ceiling.
 *
 * Callers pass the cached reading straight through; a missing reading (or any field) falls back to
 * the shipped value. The clamp is the reason a test can hand `99 / 99999` in and read back the
 * ceiling instead of a pack three times the protocol's size.
 */
export type VoiceContextPackRuntime = {
  maxRows: number;
  budgetChars: number;
  rowCapChars: number;
};

/** Resolves one runtime reading against the shipped defaults and the browser ceiling. */
export function resolveVoiceContextPackRuntime(
  values?: Partial<VoiceContextPackRuntime> | null,
): VoiceContextPackRuntime {
  return {
    maxRows: Math.min(values?.maxRows ?? VOICE_CONTEXT_PACK_DEFAULTS.maxRows, VOICE_CONTEXT_PACK_CEILING.maxRows),
    budgetChars: Math.min(values?.budgetChars ?? VOICE_CONTEXT_PACK_DEFAULTS.budgetChars, VOICE_CONTEXT_PACK_CEILING.budgetChars),
    rowCapChars: Math.min(values?.rowCapChars ?? VOICE_CONTEXT_PACK_DEFAULTS.rowCapChars, VOICE_CONTEXT_PACK_CEILING.rowCapChars),
  };
}

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
  /**
   * How many blocks the text was rendered from: conversation rows for {@link buildVoiceContextPack},
   * and those rows plus any draft/voice blocks for {@link buildVoiceInputContextPack}.
   */
  rows: number;
  /**
   * The blocks the text was rendered from, in the order they appear — what a criterion compares
   * against the transcript's own filters, or against the draft segments it handed in.
   */
  entries: VoiceContextPackEntry[];
};

/** Knobs a caller may override; the SPEC's defaults are what ships. */
export type VoiceContextPackOptions = {
  budgetChars?: number;
  rowCapChars?: number;
  /** The newest-N conversation rows the pack may carry; defaults to {@link VOICE_CONTEXT_MAX_ROWS}. */
  maxRows?: number;
  codeHeadLines?: number;
  /** The clock the relative times are read against. Injected so a test's pack is deterministic. */
  now?: number;
};

/** The headings the one-shot dictation's own blocks render under, in priority order. */
export const VOICE_INPUT_DRAFT_BEFORE_HEADING = '【光标前，用户此前输入】';
export const VOICE_INPUT_DRAFT_AFTER_HEADING = '【光标后，用户此前输入】';
export const VOICE_INPUT_VOICE_SO_FAR_HEADING = '【本次语音已经生成的文字（继续整理，不要重复）】';

/** Separates the input pack's own blocks, and the conversation from them. Counted against the budget. */
const VOICE_INPUT_BLOCK_SEPARATOR = '\n\n';

/**
 * What one one-shot dictation hands the recogniser as its context.
 *
 * ONE OBJECT RATHER THAN FOUR PARAMETERS, because the three draft/voice blocks and the conversation
 * are ONE budget: a signature that took them separately could not say which of them the remaining
 * room belongs to, and every caller would have to re-derive that ordering.
 */
export type VoiceInputContextPackOptions = {
  /** The visible conversation rows, oldest first. Optional: a listen can run with none. */
  messages?: readonly ChatMessage[];
  /** The composer draft as it stood when the listen started, up to the caret. */
  draftBefore?: string;
  /** That same snapshot, from the caret on. */
  draftAfter?: string;
  /** What this listen has already committed. */
  voiceSoFar?: string;
  budgetChars?: number;
  /** One row's own cap before elision; defaults to {@link VOICE_CONTEXT_ROW_CAP_CHARS}. */
  rowCapChars?: number;
  /** The newest-N conversation rows the pack may carry; defaults to {@link VOICE_CONTEXT_MAX_ROWS}. */
  maxRows?: number;
  /** The clock the conversation rows' relative times are read against; injected for deterministic tests. */
  now?: number;
};

/**
 * How many times the ASR-output seam has built an input pack in this page.
 *
 * THE SEAM, not a heuristic: {@link buildVoiceInputContextPack} is what the real dictation path
 * calls with a recognised segment's text (`useVoiceInput`'s upload), and it is also the text half
 * of {@link buildVoiceReferencePack}. A dev-only scenario driver that utters text with no audio has
 * to prove it reached the SAME builder rather than a lookalike, so it reads this counter before and
 * after one utterance and asserts a delta of exactly one. The counter is the injectable reading —
 * it is not consulted by any shipping behaviour.
 */
let voiceInputPackBuilds = 0;

/** The seam's build count; see {@link voiceInputPackBuilds}. */
export function readVoiceInputPackBuildCount(): number {
  return voiceInputPackBuilds;
}

/**
 * The dictation pack: the composer's own draft around the caret, what this listen has said so far,
 * then as much of the visible conversation as the remaining budget fits.
 *
 * WHY THE DRAFT COMES FIRST, AHEAD OF THE CONVERSATION. A one-shot dictation is usually an EDIT —
 * 「把这段改短一点」, 「那个函数名改成驼峰」 — so what the person could already see in the box is
 * what a spoken referent points at. The conversation is the fallback for a referent the draft does
 * not contain; spending the budget on session history before the box would make the common case the
 * one that loses.
 *
 * THE DRAFT IS PLACED BY SIDE, NOT AS ONE STRING, because the caret is where the dictation lands:
 * the text before it is what an anaphor most likely refers to, and the text after it is the thing
 * being written into. Each side is elided away from the caret, so a long draft loses its far end
 * rather than the words the person is talking about.
 *
 * AN EMPTY SEGMENT RENDERS NOTHING — not an empty heading. A listen with no draft is the ordinary
 * case, and a pack that announced 【光标前，用户此前输入】 followed by nothing would be telling the
 * model about the absence of something rather than about anything said.
 *
 * THE TOTAL IS THE SAME HARD CAP AS THE CONVERSATION PACK ({@link VOICE_CONTEXT_BUDGET_CHARS}), and
 * the conversation is built with exactly the room the draft blocks left, so this function's `chars`
 * is always ≤ `budgetChars` for every input.
 */
export function buildVoiceInputContextPack(
  options: VoiceInputContextPackOptions = {},
): VoiceContextPack {
  // The seam's one increment: every caller — the real upload path and the dev scenario driver's
  // `utter` — passes through here, so a scenario can assert it exercised the product's builder.
  voiceInputPackBuilds += 1;
  // ONE resolution for the whole pack: the draft blocks and the conversation share a budget, and a
  // caller's runtime reading (from `GET /api/voice/runtime-config`) is clamped here, before either
  // side spends it. `rowCapChars` is forwarded to the conversation builder so the two entries of
  // the voice feature fold rows the same way.
  const runtime = resolveVoiceContextPackRuntime({
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    ...(options.budgetChars === undefined ? {} : { budgetChars: options.budgetChars }),
    ...(options.rowCapChars === undefined ? {} : { rowCapChars: options.rowCapChars }),
  });
  const budgetChars = runtime.budgetChars;
  const parts: string[] = [];
  const entries: VoiceContextPackEntry[] = [];
  let chars = 0;

  /** Appends one heading+body block, elided towards the side the caller keeps when it cannot fit. */
  const addBlock = (heading: string, body: string, keep: 'head' | 'tail') => {
    const text = body.trim();
    if (text === '') return;

    const separator = parts.length === 0 ? '' : VOICE_INPUT_BLOCK_SEPARATOR;
    // One newline between the heading and its body; both are inside the budget like any other text.
    const room = budgetChars - chars - separator.length - heading.length - 1;
    if (room <= 0) return;

    const kept = Math.max(room - 1, 0);
    const fitted = text.length <= room
      ? text
      : keep === 'head'
        ? `${text.slice(0, kept)}…`
        : `…${text.slice(text.length - kept)}`;
    if (fitted === '') return;

    const block = `${heading}\n${fitted}`;
    parts.push(separator + block);
    chars += separator.length + block.length;
    entries.push({ label: heading, text: fitted });
  };

  // Priority order: the text facing the caret on each side, then what this listen already said.
  addBlock(VOICE_INPUT_DRAFT_BEFORE_HEADING, options.draftBefore ?? '', 'tail');
  addBlock(VOICE_INPUT_DRAFT_AFTER_HEADING, options.draftAfter ?? '', 'head');
  addBlock(VOICE_INPUT_VOICE_SO_FAR_HEADING, options.voiceSoFar ?? '', 'head');

  // The conversation gets WHAT IS LEFT, never a share of its own: the budget is one limit, and the
  // existing builder already stops at the newest row that does not fit.
  const separator = parts.length === 0 ? '' : VOICE_INPUT_BLOCK_SEPARATOR;
  const remaining = budgetChars - chars - separator.length;
  if (remaining > 0 && (options.messages?.length ?? 0) > 0) {
    const conversation = buildVoiceContextPack(options.messages ?? [], {
      budgetChars: remaining,
      maxRows: runtime.maxRows,
      rowCapChars: runtime.rowCapChars,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (conversation.text !== '') {
      parts.push(separator + conversation.text);
      chars += separator.length + conversation.text.length;
      entries.push(...conversation.entries);
    }
  }

  const text = parts.join('');
  return { text, chars: text.length, rows: entries.length, entries };
}

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
  const runtime = resolveVoiceContextPackRuntime({
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    ...(options.budgetChars === undefined ? {} : { budgetChars: options.budgetChars }),
    ...(options.rowCapChars === undefined ? {} : { rowCapChars: options.rowCapChars }),
  });
  const budgetChars = runtime.budgetChars;
  const rowCapChars = runtime.rowCapChars;
  const maxRows = runtime.maxRows;
  const codeHeadLines = options.codeHeadLines ?? VOICE_CONTEXT_CODE_HEAD_LINES;
  const now = options.now ?? Date.now();

  // Gathered newest-first, then reversed into the pack's own order (oldest first).
  const taken: Array<{ label: string; time: string | null; text: string }> = [];
  let chars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    // The row cap is checked before the visibility walk: once the newest visible rows are in, no
    // older row may displace them, whether or not it is visible.
    if (taken.length >= maxRows) break;
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

// ── The reference pack: the wall's objects sent as references, not prose ─────────────────────

/**
 * The reference-form input pack: what a wall-aware voice turn hands the recogniser.
 *
 * WHY IT EXISTS. The C2 pack above answers "what could the person see SAID" and renders it as
 * `角色：文本` rows. The wall adds a second kind of visible thing — OBJECTS drawn as tiles —
 * and paraphrasing those into text is exactly what the `quay://` address space exists to
 * avoid: a reference stays stable while the object's content is read back downstream by
 * whoever holds it (「送引用不送内容」).
 *
 * THE FIVE FIELDS, and what each is allowed to carry:
 *  - `utterance` — the person's words (or the words being dictated);
 *  - `focus` — the focused object's reference, or `null`;
 *  - `visible` — the visible set in spatial order, each a `{uri, label, display}` triple;
 *  - `history` — recently viewed VIEW/OBJECT references, as URIs;
 *  - `tray` — objects the person pinned into the input tray, as URIs.
 *
 * ONLY `text` CARRIES TEXT. `focus`/`visible`/`history`/`tray` never carry a title, body or
 * summary, and `history`/`tray` are URI arrays rather than the conversation or draft prose
 * they might appear to be at first glance.
 *
 * THIS PACK DOES NOT DEREFERENCE. A URI here is an opaque reference; reading the object's
 * real data is the separate task `quay-wall-uri-dereference-with-snapshot-fallback` (over the
 * fleet's L1/L2 read port). The pack states what was on the wall and what was said about it,
 * and nothing else.
 */
export type VoiceReferencePack = {
  /** The person's words (or the words being dictated) the references resolve in. */
  utterance: string;
  /** The object the utterance is about — the focused tile — or `null` when nothing is focused. */
  focus: QuayFocusableObject | null;
  /** Every visible wall object in spatial order: the set 「红的那个 / 第二个 / ② / 左上那个」 resolves over. */
  visible: QuayFocusableObject[];
  /** Recently viewed view/object references, oldest first — URIs only, never text. */
  history: QuayObjectUri[];
  /** Objects the person pinned into the input tray — URIs only, never text. */
  tray: QuayObjectUri[];
  /**
   * The C2 conversation pack followed by the composer's draft/voice-so-far blocks — exactly
   * `buildVoiceInputContextPack`'s output, byte for byte. This is the DEGRADATION PATH (and
   * the ASR hotword source): a deployment with no wall sends only this half.
   */
  text: string;
};

/** Knobs for {@link buildVoiceReferencePack}; the text half takes its builder's runtime knobs. */
export type VoiceReferencePackOptions = {
  utterance?: string;
  /** The view contract's focusable objects, in spatial order. */
  focusables?: readonly QuayFocusableObject[];
  /** The `quay://` URI of the focused object; `null`/absent means no focus. */
  focusUri?: string | null;
  /** Recently viewed view/object URIs, oldest first. */
  history?: readonly QuayObjectUri[];
  /** Objects pinned into the input tray, as URIs. */
  tray?: readonly QuayObjectUri[];
  /** The visible conversation rows, handed to the text half. */
  messages?: readonly ChatMessage[];
  /** The composer draft as it stood when the listen started, up to the caret. */
  draftBefore?: string;
  /** That same snapshot, from the caret on. */
  draftAfter?: string;
  /** What this listen has already committed. */
  voiceSoFar?: string;
  budgetChars?: number;
  rowCapChars?: number;
  maxRows?: number;
  now?: number;
};

/**
 * Builds the reference pack for one wall-aware turn.
 *
 * NO CONTENT CROSSES FROM THE FOCUSABLES: the caller's objects are copied as the same
 * `{uri, label, display}` triples, and `history`/`tray` are copied URI lists. `text` is the
 * existing C2 builder's output verbatim, so the fallback path did not change — this pack is a
 * superset of what `useVoiceInput` sends today.
 *
 * A `focusUri` that is not one of the visible objects yields `null` rather than a fabricated
 * reference: a focus the view never declared is not a reference a downstream could resolve.
 */
export function buildVoiceReferencePack(options: VoiceReferencePackOptions = {}): VoiceReferencePack {
  const visible = [...(options.focusables ?? [])];
  const focus = options.focusUri == null
    ? null
    : visible.find((object) => object.uri === options.focusUri) ?? null;

  // ONE text half, not two: `buildVoiceInputContextPack` already renders the C2 conversation
  // and the three draft/voice blocks under one budget, and its output is the byte-for-byte
  // degradation path the recogniser receives today.
  const text = buildVoiceInputContextPack({
    ...(options.messages === undefined ? {} : { messages: options.messages }),
    ...(options.draftBefore === undefined ? {} : { draftBefore: options.draftBefore }),
    ...(options.draftAfter === undefined ? {} : { draftAfter: options.draftAfter }),
    ...(options.voiceSoFar === undefined ? {} : { voiceSoFar: options.voiceSoFar }),
    ...(options.budgetChars === undefined ? {} : { budgetChars: options.budgetChars }),
    ...(options.rowCapChars === undefined ? {} : { rowCapChars: options.rowCapChars }),
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }).text;

  return {
    utterance: options.utterance ?? '',
    focus,
    visible,
    history: [...(options.history ?? [])],
    tray: [...(options.tray ?? [])],
    text,
  };
}

/**
 * Colour words a person says, mapped to the display bucket a view declares.
 *
 * Longer forms come first (`红色` before `红`) so a substring match reports the whole word,
 * and English is matched case-insensitively. This is a closed vocabulary on purpose: a word
 * absent here is not a colour reference, and the resolver says so instead of guessing.
 */
const REFERENCE_COLOR_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['红色', 'red'], ['红的', 'red'], ['红', 'red'], ['red', 'red'],
  ['绿色', 'green'], ['绿的', 'green'], ['绿', 'green'], ['green', 'green'],
  ['黄色', 'amber'], ['黄的', 'amber'], ['黄', 'amber'], ['琥珀', 'amber'], ['amber', 'amber'], ['yellow', 'amber'],
  ['蓝色', 'blue'], ['蓝的', 'blue'], ['蓝', 'blue'], ['blue', 'blue'],
  ['紫色', 'violet'], ['紫的', 'violet'], ['紫', 'violet'], ['violet', 'violet'],
  ['灰色', 'gray'], ['灰的', 'gray'], ['灰', 'gray'], ['gray', 'gray'], ['grey', 'gray'],
];

/**
 * Spoken corner words and the top-left-origin position they name.
 *
 * Only positions a view can actually declare are here; `左上` is the criterion's own phrase,
 * and the other three corners are its siblings. A vertical list can still be addressed as
 * `左上` — its first row IS the top-left cell — so the vocabulary does not assume a 2-column
 * grid.
 */
const REFERENCE_POSITION_WORDS: ReadonlyArray<readonly [string, QuayObjectPos]> = [
  ['左上', { row: 1, column: 1 }],
  ['右上', { row: 1, column: 2 }],
  ['左下', { row: 2, column: 1 }],
  ['右下', { row: 2, column: 2 }],
  ['top-left', { row: 1, column: 1 }],
  ['top left', { row: 1, column: 1 }],
  ['upper left', { row: 1, column: 1 }],
  ['top-right', { row: 1, column: 2 }],
  ['top right', { row: 1, column: 2 }],
  ['upper right', { row: 1, column: 2 }],
  ['bottom-left', { row: 2, column: 1 }],
  ['bottom left', { row: 2, column: 1 }],
  ['lower left', { row: 2, column: 1 }],
  ['bottom-right', { row: 2, column: 2 }],
  ['bottom right', { row: 2, column: 2 }],
  ['lower right', { row: 2, column: 2 }],
];

/** Chinese numerals as the ordinal grammar can see them. */
const CHINESE_NUMERALS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** Parses a Chinese numeral such as `二` / `十二` / `二十` / `二十一`, or `null` when it is not one. */
function parseChineseNumeral(text: string): number | null {
  if (text === '十') return 10;
  if (text.startsWith('十')) {
    const ones = CHINESE_NUMERALS[text.slice(1)];
    return ones === undefined ? null : 10 + ones;
  }
  if (text.endsWith('十')) {
    const tens = CHINESE_NUMERALS[text.slice(0, -1)];
    return tens === undefined ? null : tens * 10;
  }
  if (text.includes('十')) {
    const [tensText, onesText] = text.split('十');
    const tens = CHINESE_NUMERALS[tensText];
    const ones = CHINESE_NUMERALS[onesText];
    return tens === undefined || ones === undefined ? null : tens * 10 + ones;
  }
  return CHINESE_NUMERALS[text] ?? null;
}

/**
 * The ordinal a spoken reference names, or `null` when it names none.
 *
 * `第` is optional in speech, but a bare numeral is NOT an ordinal without `个` or `第`:
 * 「一起」 and 「十二点」 are ordinary words, not "the first/second object". Missing that is
 * the difference between resolving a referent and silently editing something nobody named.
 */
function spokenOrdinal(phrase: string): number | null {
  const digit = /第\s*(\d+)\s*个?|(\d+)\s*个/.exec(phrase);
  if (digit !== null) return Number(digit[1] ?? digit[2]);

  const chinese = /第\s*([一二两三四五六七八九十]+)\s*个?|([一二两三四五六七八九十]+)\s*个/.exec(phrase);
  if (chinese !== null) return parseChineseNumeral(chinese[1] ?? chinese[2]);

  return null;
}

/** The display colour a spoken phrase names, or `null` when it names none. */
function spokenColor(phrase: string): string | null {
  const normalized = phrase.toLowerCase();
  for (const [word, color] of REFERENCE_COLOR_WORDS) {
    if (normalized.includes(word)) return color;
  }
  return null;
}

/** The position a spoken phrase names, or `null` when it names none. */
function spokenPosition(phrase: string): QuayObjectPos | null {
  const normalized = phrase.toLowerCase();
  for (const [word, position] of REFERENCE_POSITION_WORDS) {
    if (normalized.includes(word)) return position;
  }
  return null;
}

/** The circled labels the phrase contains, or `null` when it contains none. */
function spokenLabels(visible: readonly QuayFocusableObject[], phrase: string): string[] | null {
  const labels = visible
    .map((object) => object.label)
    .filter((label) => label !== '' && phrase.includes(label));
  return labels.length === 0 ? null : [...new Set(labels)];
}

/** Which display attribute(s) a resolved phrase used. */
export type VoiceReferenceAttribute = 'color' | 'ordinal' | 'label' | 'pos';

/**
 * The outcome of resolving one spoken reference against a view's visible objects.
 *
 * `none` covers both "the phrase named no attribute we resolve" and "it named attributes no
 * object has"; `ambiguous` means several objects match and the caller must ask rather than
 * pick. Silently choosing a candidate is how a voice edit lands on the wrong object, so
 * ambiguity carries the candidates instead of a winner.
 */
export type VoiceReferenceMatch =
  | { status: 'resolved'; object: QuayFocusableObject; by: VoiceReferenceAttribute[] }
  | {
      status: 'unresolved';
      reason: 'none' | 'ambiguous';
      candidates: QuayFocusableObject[];
    };

/**
 * Resolves a spoken reference — 「第二个」, 「②」, 「红的那个」, 「左上那个」 (or a combination)
 * — against the visible set by its DISPLAY ATTRIBUTES, never by reading object content.
 *
 * ALL NAMED ATTRIBUTES MUST HOLD (logical AND): a phrase naming both a colour and an ordinal
 * matches only objects satisfying both. An ordinal or a label is unique per valid view
 * contract, so those phrases cannot be ambiguous; if a broken contract duplicates one, the
 * ambiguity branch reports it rather than hiding it. Free-form speech is out of scope — this
 * is a deterministic resolver, not an NLU model.
 */
export function resolveVoiceReference(
  visible: readonly QuayFocusableObject[],
  phrase: string,
): VoiceReferenceMatch {
  const color = spokenColor(phrase);
  const ordinal = spokenOrdinal(phrase);
  const position = spokenPosition(phrase);
  const labels = spokenLabels(visible, phrase);
  if (color === null && ordinal === null && position === null && labels === null) {
    return { status: 'unresolved', reason: 'none', candidates: [] };
  }

  const matches = visible.filter(
    (object) =>
      (color === null || object.display.color === color) &&
      (ordinal === null || object.display.ordinal === ordinal) &&
      (position === null ||
        (object.display.pos.row === position.row && object.display.pos.column === position.column)) &&
      (labels === null || labels.includes(object.label)),
  );
  if (matches.length === 0) {
    return { status: 'unresolved', reason: 'none', candidates: [] };
  }
  if (matches.length > 1) {
    return { status: 'unresolved', reason: 'ambiguous', candidates: matches };
  }

  const by: VoiceReferenceAttribute[] = [];
  if (color !== null) by.push('color');
  if (ordinal !== null) by.push('ordinal');
  if (position !== null) by.push('pos');
  if (labels !== null) by.push('label');
  return { status: 'resolved', object: matches[0], by };
}
