/**
 * Addressable items inside one assistant reply.
 *
 * A reply's numbered points are what a person points at next — 「第 1 点」,
 * 「执行 1–2」, 「按你的方案」 — but the transcript only holds them as text. This
 * module turns that text into a stable list of items, addresses each one with a
 * `cloudcli://session/<sessionId>/msg/<messageId>#item-<n>` URI, and resolves a
 * typed or dictated reference back to ordinals.
 *
 * Everything here is a pure function of its inputs: the composer preview and
 * the transcript labels both run this module, so they cannot disagree about
 * which item 「1–2」 means. It deliberately knows nothing about React, the
 * message store, or the observation wall's own URI helpers.
 */

/** How many characters of an item's text the preview and labels carry. */
export const REPLY_ITEM_EXCERPT_CHARS = 80;

/** The circled labels used for ordinals 1–20; beyond that the plain fallback. */
const CIRCLED_LABELS = [
  '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
  '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳',
];

/**
 * How an extracted item was written. The renderer uses this to keep headings
 * from matching list items (and the other way round) when it looks an item up
 * by its text.
 */
export type ReplyItemKind = 'ordered' | 'unordered' | 'heading' | 'bold-paragraph';

/** One addressable item of an assistant reply, in document order. */
export type ReplyItem = {
  /** 1-based position among the reply's extracted items. */
  ordinal: number;
  /** The circled label drawn beside the item (①, ②, …). */
  label: string;
  /** The item's text, trimmed to {@link REPLY_ITEM_EXCERPT_CHARS} characters. */
  excerpt: string;
  kind: ReplyItemKind;
};

/** The three parts of a `cloudcli://…/msg/…#item-n` address. */
export type ReplyItemAddress = {
  sessionId: string;
  messageId: string;
  ordinal: number;
};

/** What a reference in the input box resolved to. */
export type ReplyReferenceKind = 'items' | 'reply' | 'none' | 'mismatch';

/**
 * The outcome of resolving a reference.
 *
 * `items` carries the ordinals it named; `reply` means the whole latest reply;
 * `none` means the words are not a reference at all; `mismatch` means the words
 * named something the latest reply does not have — `expected` is the count (or
 * largest ordinal) they named and `total` is how many items the reply really
 * has. A caller that cannot tell must never guess an item.
 */
export type ReplyReference = {
  kind: ReplyReferenceKind;
  ordinals: number[];
  expected?: number;
  total?: number;
};

/** The shape this module needs from a transcript row; `ChatMessage` satisfies it. */
export type ReplyItemSourceMessage = {
  type: string;
  content?: string;
  isThinking?: boolean;
  isToolUse?: boolean;
};

/** The per-message data the transcript renderer needs to label a reply's items. */
export type ReplyItemRenderContext = {
  items: ReplyItem[];
  highlightedOrdinals: ReadonlySet<number>;
  uriFor: (ordinal: number) => string;
};

/**
 * Finds the extracted item a rendered block's text stands for.
 *
 * The renderer sees a `<li>`/`<h2>`/`<p>`'s *rendered* text, which no longer
 * carries the markdown that produced it (and, for a list item, not the marker
 * either). Matching therefore compares the same normalised, number-stripped
 * text the excerpt was built from, restricted to the item kinds that block can
 * legitimately be — so a list item never claims a heading's ordinal.
 */
export function matchReplyItem(
  text: string,
  items: readonly ReplyItem[],
  kinds: readonly ReplyItemKind[],
): ReplyItem | null {
  const normalized = plainText(text).replace(/^\d{1,2}\s*[.、)）:：]\s*/, '');
  if (!normalized) {
    return null;
  }
  return (
    items.find(
      (item) =>
        kinds.includes(item.kind) &&
        (normalized.startsWith(item.excerpt) || item.excerpt.startsWith(normalized)),
    ) ?? null
  );
}

/** The label for one 1-based ordinal, circled up to twenty. */
export function replyItemLabel(ordinal: number): string {
  return CIRCLED_LABELS[ordinal - 1] ?? `(${ordinal})`;
}

/**
 * Builds the address of one item of one reply.
 *
 * Kept deliberately separate from the observation wall's `cloudcli://view/…`
 * syntax: an address here names a message in a transcript, not an object drawn
 * on the wall, and the two grammars must not be made to share a parser.
 */
export function formatReplyItemUri(address: ReplyItemAddress): string {
  return `cloudcli://session/${address.sessionId}/msg/${address.messageId}#item-${address.ordinal}`;
}

/** Parses an address built by {@link formatReplyItemUri}; null for anything else. */
export function parseReplyItemUri(uri: string): ReplyItemAddress | null {
  const match = /^cloudcli:\/\/session\/([^/]+)\/msg\/([^#]+)#item-(\d+)$/.exec(String(uri ?? ''));
  if (!match) {
    return null;
  }
  return { sessionId: match[1], messageId: match[2], ordinal: Number(match[3]) };
}

/** Strips the inline markdown a rendered element no longer carries. */
function plainText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Matches a leading numbered marker (`1.`, `2、`, `3)`), returning the rest. */
function stripNumberPrefix(value: string): { number: number; rest: string } | null {
  const match = /^\s*(\d{1,2})\s*[.、)）:：]\s*(.+)$/.exec(value);
  return match ? { number: Number(match[1]), rest: match[2] } : null;
}

const FENCE_LINE = /^\s{0,3}(?:```|~~~)/;
const TABLE_LINE = /^\s*\|/;
const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;
const BOLD_START_LINE = /^\*\*\s*(\d{1,2})\s*[.、)）:：]\s*(.+)$/;
const ORDERED_LIST_LINE = /^ {0,3}(\d{1,2})[.)、）]\s+(.+)$/;
const UNORDERED_LIST_LINE = /^ {0,3}[-*+]\s+(.+)$/;

type RawReplyItem = { line: number; kind: ReplyItemKind; text: string };

/**
 * Extracts the addressable items of one assistant reply, in document order.
 *
 * Recognised shapes: top-level ordered list items; top-level unordered items
 * (only when the reply has no ordered list); numbered headings (`## 1. …`);
 * and paragraphs that open with a numbered bold run (`**1. …**`). Lines inside
 * fenced code blocks and tables are never items — a numbered shell pipeline or
 * a table's row numbers are not things a person can point at.
 *
 * The ordinal is the item's position, not the number written in the marker: a
 * reply whose list starts at `3.` still addresses its first item as `#item-1`.
 */
export function extractReplyItems(markdown: string): ReplyItem[] {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const ordered: RawReplyItem[] = [];
  const unordered: RawReplyItem[] = [];
  const headings: RawReplyItem[] = [];
  const boldParagraphs: RawReplyItem[] = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || TABLE_LINE.test(line)) {
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      const numbered = stripNumberPrefix(heading[2]);
      if (numbered) {
        headings.push({ line: index, kind: 'heading', text: numbered.rest });
      }
      continue;
    }

    const bold = BOLD_START_LINE.exec(line);
    if (bold) {
      // De-bold the whole line so an emphasised tail (`**1. A**，然后 B`) keeps
      // the item's real text rather than only the bold run.
      boldParagraphs.push({
        line: index,
        kind: 'bold-paragraph',
        text: line.replace(/\*\*/g, '').replace(/^\s*\d{1,2}\s*[.、)）:：]\s*/, ''),
      });
      continue;
    }

    const orderedMatch = ORDERED_LIST_LINE.exec(line);
    if (orderedMatch) {
      ordered.push({ line: index, kind: 'ordered', text: orderedMatch[2] });
      continue;
    }

    const unorderedMatch = UNORDERED_LIST_LINE.exec(line);
    if (unorderedMatch) {
      unordered.push({ line: index, kind: 'unordered', text: unorderedMatch[1] });
    }
  }

  const listItems = ordered.length > 0 ? ordered : unordered;
  return [...listItems, ...headings, ...boldParagraphs]
    .sort((left, right) => left.line - right.line)
    .map((raw, index) => {
      const ordinal = index + 1;
      return {
        ordinal,
        label: replyItemLabel(ordinal),
        excerpt: plainText(raw.text).slice(0, REPLY_ITEM_EXCERPT_CHARS),
        kind: raw.kind,
      };
    });
}

/**
 * Finds the message whose items the composer may point at: the last assistant
 * text reply in the loaded transcript. A reply with no extracted items answers
 * null rather than falling back to an earlier reply — 「最近一条回复」 is the
 * one just above the input box, and pointing past it would be a guess.
 */
export function findLatestReplyItems<T extends ReplyItemSourceMessage>(
  messages: readonly T[],
): { message: T; items: ReplyItem[] } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== 'assistant' || message.isThinking || message.isToolUse) {
      continue;
    }
    const items = extractReplyItems(String(message.content ?? ''));
    return items.length > 0 ? { message, items } : null;
  }
  return null;
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** Parses an Arabic or Chinese count up to 999; null for anything else. */
function parseCount(token: string): number | null {
  if (/^\d{1,3}$/.test(token)) {
    return Number(token);
  }
  if (!/^[零一二两三四五六七八九十百]+$/.test(token)) {
    return null;
  }
  let total = 0;
  let current = 0;
  for (const char of token) {
    if (char in CHINESE_DIGITS) {
      current = CHINESE_DIGITS[char];
    } else if (char === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (char === '百') {
      total += (current || 1) * 100;
      current = 0;
    }
  }
  return total + current;
}

const COUNT_TOKEN = '(\\d{1,3}|[零一二两三四五六七八九十百]+)';
const ITEM_UNIT = '(?:条|点|项|个|句|段|步)';

/** 「上述 5 项」「这 5 条」 — a count of the whole reply's items. */
const ALL_COUNT_PATTERN = new RegExp(`(?:上述|上面|这|那|本|此)\\s*(?:的\\s*)?${COUNT_TOKEN}\\s*${ITEM_UNIT}`);
/** 「前三条」 — the first N items. */
const FIRST_COUNT_PATTERN = new RegExp(`前\\s*${COUNT_TOKEN}\\s*${ITEM_UNIT}`);
/** 「最后一条」「最后两个」 — the last N items. */
const LAST_COUNT_PATTERN = new RegExp(`最后\\s*(?:${COUNT_TOKEN}\\s*)?${ITEM_UNIT}`);
/** 「1–2」「1-3」「一到三」 — an inclusive range. */
const RANGE_PATTERN = /(?<![\d.])(\d{1,2})\s*[–—~〜\-至到]\s*(\d{1,2})(?![\d.])/;
const CHINESE_RANGE_PATTERN = /([一二两三四五六七八九十]+)\s*[–—~〜\-至到]\s*([一二两三四五六七八九十]+)/;
/** 「第 1 点」「第三条」「②」 — explicit single ordinals. */
const NUMBERED_ORDINAL_PATTERN = new RegExp(`第\\s*${COUNT_TOKEN}\\s*${ITEM_UNIT}`, 'g');
/** 「1、3」「1 和 3」「第 1 和第 3 点」 — a run of numbers joined by separators. */
const JOINED_ORDINAL_PATTERN = /(\d{1,2})(?:\s*[、,，和与及]\s*(?:第\s*)?\d{1,2})+/g;
const CIRCLED_PATTERN = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g;

/** 「按你的方案」「按上面的」「上述方案」 — the whole reply. */
const REPLY_PHRASE_PATTERNS = [
  /(?:按|照|依|根据)\s*(?:你的?|您)?\s*(?:方案|建议|思路|计划|想法|意思|说法|办法)/,
  /(?:按|照|依|根据)\s*(?:上面|上述|上文|前面)\s*(?:的)?\s*(?:方案|建议|说法|意思|来|做|办)?/,
  /(?:上述|上面|上文)\s*(?:的)?\s*(?:方案|建议|说法|内容|计划)/,
];

/** Full-width digits and dashes the same phrase can arrive in. */
function normalizeReferenceText(text: string): string {
  return String(text ?? '')
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[～〜]/g, '–');
}

/** A mismatch when any named ordinal falls outside the reply's items. */
function itemsOrMismatch(ordinals: number[], items: readonly ReplyItem[]): ReplyReference {
  const total = items.length;
  const unique = [...new Set(ordinals)].sort((left, right) => left - right);
  const outOfRange = unique.filter((ordinal) => ordinal < 1 || ordinal > total);
  if (outOfRange.length > 0) {
    return { kind: 'mismatch', ordinals: [], expected: Math.max(...outOfRange), total };
  }
  return { kind: 'items', ordinals: unique };
}

/**
 * Resolves a typed or dictated reference against the latest reply's items.
 *
 * Returns `items` only when every named ordinal exists. Words that name more
 * items than the reply has (「上述 5 项」 on a four-item reply, 「执行第 6 点」
 * on a four-item reply) are a `mismatch`, never a silently clamped guess.
 * `reply` names the whole latest reply; `none` means the words are not a
 * reference at all (a time like 「十二点开会」, a verb phrase like 「一起看看」).
 */
export function resolveReplyReference(text: string, items: readonly ReplyItem[]): ReplyReference {
  const normalized = normalizeReferenceText(text);
  if (!normalized.trim()) {
    return { kind: 'none', ordinals: [] };
  }

  // A count of the whole reply: 「上述 5 项」. Checked first because the digits
  // are followed by a unit and would otherwise look like nothing else here.
  const allCount = ALL_COUNT_PATTERN.exec(normalized);
  if (allCount) {
    const count = parseCount(allCount[1]);
    if (count !== null) {
      if (count === items.length) {
        return { kind: 'items', ordinals: items.map((item) => item.ordinal) };
      }
      return { kind: 'mismatch', ordinals: [], expected: count, total: items.length };
    }
  }

  // 「1–2」「一到三」
  const range = RANGE_PATTERN.exec(normalized);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && from <= to) {
      const ordinals: number[] = [];
      for (let ordinal = from; ordinal <= to; ordinal += 1) {
        ordinals.push(ordinal);
      }
      return itemsOrMismatch(ordinals, items);
    }
  }
  const chineseRange = CHINESE_RANGE_PATTERN.exec(normalized);
  if (chineseRange) {
    const from = parseCount(chineseRange[1]);
    const to = parseCount(chineseRange[2]);
    if (from !== null && to !== null && from <= to) {
      const ordinals: number[] = [];
      for (let ordinal = from; ordinal <= to; ordinal += 1) {
        ordinals.push(ordinal);
      }
      return itemsOrMismatch(ordinals, items);
    }
  }

  // 「前三条」
  const firstCount = FIRST_COUNT_PATTERN.exec(normalized);
  if (firstCount) {
    const count = parseCount(firstCount[1]);
    if (count !== null) {
      if (count < 1) {
        return { kind: 'none', ordinals: [] };
      }
      if (count > items.length) {
        return { kind: 'mismatch', ordinals: [], expected: count, total: items.length };
      }
      return { kind: 'items', ordinals: Array.from({ length: count }, (_, index) => index + 1) };
    }
  }

  // 「最后一条」「最后两个」
  const lastCount = LAST_COUNT_PATTERN.exec(normalized);
  if (lastCount) {
    const count = lastCount[1] ? parseCount(lastCount[1]) : 1;
    if (count !== null) {
      if (count < 1) {
        return { kind: 'none', ordinals: [] };
      }
      if (count > items.length) {
        return { kind: 'mismatch', ordinals: [], expected: count, total: items.length };
      }
      const ordinals: number[] = [];
      for (let ordinal = items.length - count + 1; ordinal <= items.length; ordinal += 1) {
        ordinals.push(ordinal);
      }
      return { kind: 'items', ordinals };
    }
  }

  // A run of numbers first: 「第 1 和第 3 点」 only matches the joined form
  // (the first number is followed by 「和」, not by a unit), so it has to be
  // read before the single-ordinal form or it would resolve to [3] alone.
  const joined = normalized.match(JOINED_ORDINAL_PATTERN);
  if (joined) {
    const ordinals = [...joined[0].matchAll(/\d{1,2}/g)].map((match) => Number(match[0]));
    if (ordinals.length > 0) {
      return itemsOrMismatch(ordinals, items);
    }
  }

  // Explicit ordinals: 「第 1 点」「第三条」, then circled marks 「②」.
  const explicit: number[] = [];
  for (const match of normalized.matchAll(NUMBERED_ORDINAL_PATTERN)) {
    const ordinal = parseCount(match[1]);
    if (ordinal !== null) {
      explicit.push(ordinal);
    }
  }
  if (explicit.length > 0) {
    return itemsOrMismatch(explicit, items);
  }

  const circled: number[] = [];
  for (const match of normalized.matchAll(CIRCLED_PATTERN)) {
    const ordinal = CIRCLED_LABELS.indexOf(match[0]) + 1;
    if (ordinal > 0) {
      circled.push(ordinal);
    }
  }
  if (circled.length > 0) {
    return itemsOrMismatch(circled, items);
  }

  for (const pattern of REPLY_PHRASE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { kind: 'reply', ordinals: [] };
    }
  }

  return { kind: 'none', ordinals: [] };
}
