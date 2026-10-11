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
import type { VoiceRealtimeCaption, VoiceRealtimeDelivery } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';
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
 * The span the proxy treats as CJK when it joins the pieces of one spoken thought into one message
 * (`voice-realtime-ws-proxy.service.ts`'s `joinParts`), mirrored here so the row the person reads
 * is assembled by the same rule as the message they will be shown as having sent.
 */
const CJK = /[　-鿿＀-￯]/;

/**
 * Joins the pieces of one spoken thought the way the proxy does: no space between two CJK pieces,
 * one space between anything else, and a piece with no words at all skipped entirely — it is
 * neither text nor a separator.
 *
 * Module-private: {@link foldCaptionsIntoTranscriptRow} is its only caller, and the rule is read
 * there through the row's text.
 */
function joinCaptionParts(parts: readonly string[]): string {
  let out = '';
  for (const part of parts) {
    const next = part.trim();
    if (next === '') continue;
    const cjkBoundary = CJK.test(out.slice(-1)) && CJK.test(next.charAt(0));
    out = out === '' ? next : `${out}${cjkBoundary ? '' : ' '}${next}`;
  }
  return out;
}

/**
 * Folds the utterances not yet delivered into the ONE provisional row that stands for what the
 * person is saying right now (AC-326).
 *
 * WHY ONE ROW. The endpoint closes an utterance at every pause, so a sentence that pauses in the
 * middle arrives as several captions. Rendered one row each they read back to the person as "my
 * words appeared three times, got reworded, then vanished": the relay model merges the whole
 * thought into one message at delivery and the caption rows all go at once. One row that GROWS in
 * place makes the delivery a 1-to-1 finalisation of that row rather than an N-to-1 collapse.
 *
 * The utterances a delivery has already claimed are left out. Their words are in the real message
 * the transcript now shows, and this row is rebuilt on every render — a claimed utterance folded
 * back in would be carried along into a row the delivery is about to drop.
 *
 * Returns `null` when there is nothing left to show: before anything is said, once everything
 * spoken has been delivered, and for captions that carry no words at all (the endpoint emits an
 * empty transcription beside its interim text, and a blank row is not something the person said).
 *
 * Consumed by `ChatInterface`, which renders this row among the session's own messages.
 */
export function foldCaptionsIntoTranscriptRow(
  captions: readonly VoiceRealtimeCaption[],
  deliveries: readonly VoiceRealtimeDelivery[],
): ChatMessage | null {
  const claimed = new Set<string>();
  for (const delivery of deliveries) {
    for (const itemId of delivery.itemIds) {
      claimed.add(itemId);
    }
  }
  const pending = captions.filter((caption) => !claimed.has(caption.itemId));
  const text = joinCaptionParts(pending.map((caption) => caption.text));
  if (text === '') {
    return null;
  }
  const first = pending.find((caption) => caption.text.trim() !== '')!;
  return {
    type: 'user',
    content: text,
    displayText: text,
    // Keyed on the utterance the row opened with: stable while the row grows, and the id a
    // delivery claims when it takes this row's words over.
    id: `voice-caption-${first.itemId}`,
    // When the person began the thought, not when the last piece of it was recognised.
    timestamp: first.at,
  };
}

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
