/**
 * Prompt construction for the two draw shapes: an ordinary first draw/redraw and
 * an expansion draw (variants of a picked reply, or responses to a quoted
 * passage).
 *
 * Every function here is pure: it takes the already-clipped tail/focus/seed and
 * the chips to avoid, and returns a string. A settings `systemPrompt` replaces
 * the built-in instruction block whole; the user prompt always names the
 * delivery-side context, so a custom system prompt cannot silently drop it.
 *
 * Consumers: `reply-suggestions-draw.ts` (both prompts and both built-in system
 * prompts) and the service criterion in
 * `tests/reply-suggestions-service.test.ts`, which reads the built-in rules off
 * the prompt the service sends.
 */
import type { ReplySuggestionsExpansionSource } from './reply-suggestions-usage-log.js';

/**
 * How many previously shown chips a redraw prompt may list as "do not repeat".
 *
 * Consumers: `reply-suggestions-draw.ts` (`draw`), which slices the shown list
 * to this bound before handing it to the builders below.
 */
export const REPLY_SUGGESTIONS_REDRAW_MEMORY = 12;

/**
 * The built-in system prompt; `generation.systemPrompt` replaces it whole when
 * non-empty.
 *
 * Consumers: `reply-suggestions-draw.ts` (`composeRequest`).
 */
export function builtInSystemPrompt(maxChipChars: number): string {
  return [
    '你在为用户起草聊天输入框里可直接发送的回复。用户刚看完助手最后一条消息，要从中挑一条。',
    '给出 3 条互不相同的完整回复：第 1 条用「；」分隔、简要回答所有待答点，助手给了推荐就采纳；',
    '单个要点时不要以分隔符结尾。',
    '第 2、3 条是真正的备选（不同的决定，或更短的确认），不是第 1 条的改写。',
    `用用户的语言和简短风格，每条不超过 ${maxChipChars} 个字符。`,
    '不得编造消息里没有的事实、数字或测量值：可以替人做决定，不可以编造事实。',
    '没有待答点时，建议最可能的下一条指令。',
    '只输出 JSON：{"chips": ["…", "…", "…"]}',
  ].join('\n');
}

/**
 * The built-in system prompt for an expansion draw.
 *
 * Consumers: `reply-suggestions-draw.ts` (`composeRequest`).
 */
export function builtInExpansionSystemPrompt(
  maxChipChars: number,
  source: ReplySuggestionsExpansionSource,
): string {
  return [
    '你在为用户起草聊天输入框里可直接发送的回复。',
    source === 'seed'
      ? '用户已经选定了一条回复；请给出同话题的另一种写法（变体），保持它的决定与意图。'
      : '用户选中了助手消息里的一段；请给出针对这一段的回应。',
    '给出 2 到 3 条互不相同的完整回复，用用户的语言和简短风格，第 2、3 条必须在措辞或详略上与第 1 条不同。',
    `每条不超过 ${maxChipChars} 个字符。`,
    '不得编造消息里没有的事实、数字或测量值：可以替人做决定，不可以编造事实。',
    '只输出 JSON：{"chips": ["…", "…", "…"]}',
  ].join('\n');
}

/**
 * The built-in instruction block plus the delivery-side context, as one request.
 *
 * Consumers: `reply-suggestions-draw.ts` (`composeRequest`).
 */
export function buildUserPrompt(options: {
  tail: string;
  focus: string;
  avoid: readonly string[];
  redraw: boolean;
}): string {
  const lines: string[] = ['助手最后一条消息（末尾节选，可能被截断）：', '"""', options.tail, '"""'];
  if (options.focus !== '') {
    lines.push('', '用户选中了消息里的这一段，想回应它：', '"""', options.focus, '"""');
  }
  const avoid = options.avoid.slice(-REPLY_SUGGESTIONS_REDRAW_MEMORY);
  if (options.redraw && avoid.length > 0) {
    lines.push('', '不要重复以下已经展示过的回复：');
    for (const chip of avoid) lines.push(`- ${chip}`);
  }
  return lines.join('\n');
}

/**
 * The user prompt for an expansion draw: the same assistant tail, the quoted
 * passage when there is one, and either the picked reply (seed, variants) or the
 * instruction to respond to the quotation. `avoid` lists the chips already shown
 * in this draw, exactly as the redraw prompt does, so a supplement never repeats
 * the first answer.
 *
 * Consumers: `reply-suggestions-draw.ts` (`composeRequest`).
 */
export function buildExpansionPrompt(options: {
  tail: string;
  focus: string;
  seed: string;
  avoid: readonly string[];
}): string {
  const lines: string[] = ['助手最后一条消息（末尾节选，可能被截断）：', '"""', options.tail, '"""'];
  if (options.focus !== '') {
    lines.push('', '用户选中了消息里的这一段：', '"""', options.focus, '"""');
  }
  if (options.seed !== '') {
    lines.push('', '用户选定的回复（seed）：', '"""', options.seed, '"""');
    lines.push('', '请基于这条 seed 给出同话题的变体：保持它的决定与意图，只在措辞或详略上不同。');
  } else {
    lines.push('', '请针对上面选中的这一段给出 2 到 3 条回应。');
  }
  const avoid = options.avoid.slice(-REPLY_SUGGESTIONS_REDRAW_MEMORY);
  if (avoid.length > 0) {
    lines.push('', '不要重复以下已经展示过的回复：');
    for (const chip of avoid) lines.push(`- ${chip}`);
  }
  return lines.join('\n');
}
