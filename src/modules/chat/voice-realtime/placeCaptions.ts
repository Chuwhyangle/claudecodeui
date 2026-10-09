/**
 * Places the provisional caption rows of a Live Voice session among the real transcript rows by
 * TIME instead of appending them at the end.
 *
 * WHY. The captions used to be appended after every real message. The moment the instruction was
 * delivered and Claude began answering, the person's own words (the caption) sat BELOW Claude's reply,
 * repeating the user message above it, and each new caption pushed the reply up the screen — read by
 * the user as "the reasoning appeared and then went away".
 *
 * A caption goes immediately before the first real row stamped later than it; one with no later row
 * goes last; rows whose time cannot be read keep their place and never move a caption. Order within
 * the real rows and within the captions is preserved.
 *
 * Consumed by `ChatInterface` (the pane that renders both).
 */
import type { ChatMessage } from '@/shared/types';

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function placeCaptionsChronologically(
  messages: readonly ChatMessage[],
  captionRows: readonly ChatMessage[],
): ChatMessage[] {
  const result: ChatMessage[] = [];
  const pending = [...captionRows].sort((a, b) => (toEpochMs(a.timestamp) ?? 0) - (toEpochMs(b.timestamp) ?? 0));
  let next = 0;
  for (const message of messages) {
    const at = toEpochMs(message.timestamp);
    if (at !== null) {
      while (next < pending.length && (toEpochMs(pending[next]!.timestamp) ?? Infinity) < at) {
        result.push(pending[next]!);
        next += 1;
      }
    }
    result.push(message);
  }
  while (next < pending.length) {
    result.push(pending[next]!);
    next += 1;
  }
  return result;
}
