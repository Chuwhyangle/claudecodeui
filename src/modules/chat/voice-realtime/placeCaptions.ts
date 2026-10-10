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

/** Letters and digits only, lower-cased: what survives punctuation, spacing and case differences. */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** How far before a caption a real message may be stamped and still be taken as its delivery (clock skew). */
const DELIVERY_SKEW_MS = 30_000;

/**
 * Marks the real user messages that were SPOKEN and removes the caption rows they replace.
 *
 * The person's message — what was delivered to Claude — is the row; the caption was a stand-in while
 * it was in flight. For each confirmed delivery (oldest first) the first real user message whose
 * words contain the delivered text, stamped no earlier than the delivery (less clock skew) and not
 * already claimed, is returned with `voiceTranscript.heard` set. The captions that delivery carried
 * are then dropped. A delivery with no matching message yet (the transcript has not been re-read)
 * leaves its captions on screen, so the words never vanish in between.
 *
 * Consumed by `ChatInterface`.
 */
export function markDeliveredVoiceMessages(
  messages: readonly ChatMessage[],
  captionRows: readonly ChatMessage[],
  deliveries: ReadonlyArray<{ message: string; at: number; heard: string[]; itemIds: string[] }>,
): { messages: ChatMessage[]; captionRows: ChatMessage[] } {
  const marked = [...messages];
  const claimed = new Set<number>();
  const absorbed = new Set<string>();
  for (const delivery of deliveries) {
    const wanted = normalizeForMatch(delivery.message);
    if (wanted === '') continue;
    const index = marked.findIndex((message, position) => {
      if (claimed.has(position) || message.type !== 'user' || typeof message.content !== 'string') return false;
      if (typeof message.id === 'string' && message.id.startsWith('voice-caption-')) return false;
      const at = toEpochMs(message.timestamp);
      if (at !== null && at < delivery.at - DELIVERY_SKEW_MS) return false;
      return normalizeForMatch(message.content).includes(wanted);
    });
    if (index === -1) continue;
    claimed.add(index);
    marked[index] = { ...marked[index]!, voiceTranscript: { heard: delivery.heard } };
    for (const id of delivery.itemIds) absorbed.add(`voice-caption-${id}`);
  }
  return { messages: marked, captionRows: captionRows.filter((row) => !absorbed.has(String(row.id))) };
}

/**
 * Removes the caption rows whose words already appear in a real user message.
 *
 * A caption is the person's words as the model HEARD them; the delivered message is what the model
 * RELAYED. With a relay that repeats them verbatim they are the same sentence, shown twice — once as
 * the provisional row and once as the real message. A caption is hidden only when a real user row
 * stamped at or after it contains its words (ignoring punctuation and case); a caption that DIFFERS
 * from what was sent (the model fixed a recognition slip, or relayed nothing) stays, which is what
 * lets a person see heard-versus-sent.
 *
 * Consumed by `ChatInterface`, before {@link placeCaptionsChronologically}.
 */
export function dropCaptionsDeliveredAsMessages(
  messages: readonly ChatMessage[],
  captionRows: readonly ChatMessage[],
): ChatMessage[] {
  const realUserRows = messages
    .filter((message) => message.type === 'user' && typeof message.content === 'string')
    .map((message) => ({
      at: toEpochMs(message.timestamp),
      text: normalizeForMatch(String(message.content)),
    }));
  return captionRows.filter((caption) => {
    const words = normalizeForMatch(String(caption.content));
    // One or two characters ("端。") match nearly anything; leave those to be shown.
    if (words.length < 3) {
      return true;
    }
    const captionAt = toEpochMs(caption.timestamp);
    return !realUserRows.some(
      (row) =>
        row.text.includes(words) && (row.at === null || captionAt === null || row.at >= captionAt - DELIVERY_SKEW_MS),
    );
  });
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
