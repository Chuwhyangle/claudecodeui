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
 * Module-private: {@link foldCaptionsIntoTranscriptRow} (the row) and
 * {@link collectUndeliveredUtterances} (the backlog) are its callers, so both assemble one spoken
 * thought by the same rule the message the person is shown as having sent was assembled by.
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
 * Whether `message` is the real transcript row a delivery's words became.
 *
 * THE ONE MATCHING RULE the fold and {@link markDeliveredVoiceMessages} share, so a delivery is
 * judged "already shown" by exactly the rule that later marks the row it became: a real user row
 * (never a provisional caption row), carrying text that CONTAINS the delivered words, stamped no
 * earlier than the delivery less clock skew.
 */
function messageIsDeliveryRow(message: ChatMessage, delivery: VoiceRealtimeDelivery): boolean {
  if (message.type !== 'user' || typeof message.content !== 'string') return false;
  const wanted = normalizeForMatch(delivery.message);
  if (wanted === '') return false;
  // A provisional caption row is not the real message even though its words may match.
  if (typeof message.id === 'string' && message.id.startsWith('voice-caption-')) return false;
  const at = toEpochMs(message.timestamp);
  if (at !== null && at < delivery.at - DELIVERY_SKEW_MS) return false;
  return normalizeForMatch(message.content).includes(wanted);
}

/**
 * Whether a delivery's real message is visible in the transcript yet.
 *
 * The window this names: the proxy has ACCEPTED the instruction (its `sent` frame is on the wire)
 * but the session's transcript has not caught up, so the person's words are on screen only as the
 * provisional caption row. Until this is `true` the delivery must not claim its captions — the
 * removal key is "the real message is visible", not "the server said `sent`".
 */
export function deliveryIsShown(
  delivery: VoiceRealtimeDelivery,
  messages: readonly ChatMessage[],
): boolean {
  return messages.some((message) => messageIsDeliveryRow(message, delivery));
}

/**
 * Folds the utterances not yet SHOWN into the ONE provisional row that stands for what the person
 * is saying right now (AC-326).
 *
 * WHY ONE ROW. The endpoint closes an utterance at every pause, so a sentence that pauses in the
 * middle arrives as several captions. Rendered one row each they read back to the person as "my
 * words appeared three times, got reworded, then vanished": the relay model merges the whole
 * thought into one message at delivery and the caption rows all go at once. One row that GROWS in
 * place makes the delivery a 1-to-1 finalisation of that row rather than an N-to-1 collapse.
 *
 * WHICH UTTERANCES ARE LEFT OUT — THE REMOVAL KEY. Only the utterances of a delivery whose real
 * message is ALREADY VISIBLE in `visibleMessages` (see {@link deliveryIsShown}) are dropped. A
 * delivery whose `sent` frame has arrived but whose message is not in the transcript yet — the
 * CLI's own queue window — does NOT claim its words, so they stay on the row. The words may be
 * removed at the one moment the person would not miss them: when the real message replaces them.
 * Rebuilding this row on every render is why a claimed utterance must not fold back in — a claimed
 * utterance folded in would be carried into a row the delivery is about to drop.
 *
 * Returns `null` when there is nothing left to show: before anything is said, once everything
 * spoken has been shown, and for captions that carry no words at all (the endpoint emits an empty
 * transcription beside its interim text, and a blank row is not something the person said).
 *
 * `delivering` is the proxy's own "accepted, not yet delivered" reading (AC-327). It is stamped onto
 * the row as `voiceRowState`: `delivering` while the instruction is in flight OR while an accepted
 * delivery's message is still unshown, `heard` once a closed utterance on this row is waiting to be
 * carried away, and nothing at all while the row only holds words still being spoken. The two
 * states are exclusive, so the row can show one marker, never both.
 *
 * Consumed by `ChatInterface`, which renders this row among the session's own messages.
 */
export function foldCaptionsIntoTranscriptRow(
  captions: readonly VoiceRealtimeCaption[],
  deliveries: readonly VoiceRealtimeDelivery[],
  visibleMessages: readonly ChatMessage[],
  delivering = false,
): ChatMessage | null {
  // A shown delivery takes its words off the row; an accepted-but-unshown one does not, and is what
  // keeps the row reading "in flight" rather than "heard" once the `sent` frame has closed the
  // proxy's own window (AC-327's marker follows the delivery through to `shown`).
  const shown = new Set<string>();
  const unshown = new Set<string>();
  for (const delivery of deliveries) {
    for (const itemId of delivery.itemIds) {
      (deliveryIsShown(delivery, visibleMessages) ? shown : unshown).add(itemId);
    }
  }
  const pending = captions.filter((caption) => !shown.has(caption.itemId));
  const text = joinCaptionParts(pending.map((caption) => caption.text));
  if (text === '') {
    return null;
  }
  const first = pending.find((caption) => caption.text.trim() !== '')!;
  const inFlight = delivering || pending.some((caption) => unshown.has(caption.itemId));
  return {
    type: 'user',
    content: text,
    displayText: text,
    // Keyed on the utterance the row opened with: stable while the row grows, and the id a
    // delivery claims when it takes this row's words over.
    id: `voice-caption-${first.itemId}`,
    // When the person began the thought, not when the last piece of it was recognised.
    timestamp: first.at,
    // In flight takes precedence: the words may still be interim when the proxy accepts them, and
    // "tidying up" is what the person needs to see from the moment they stop talking until the real
    // message is on screen. Otherwise the row is marked `heard` once a CLOSED utterance is waiting
    // on it — an interim-only row is still being spoken, not yet something the model has heard.
    ...(inFlight ? { voiceRowState: 'delivering' as const } : pending.some((caption) => caption.final) ? { voiceRowState: 'heard' as const } : {}),
  };
}

/**
 * How many utterances the person spoke that never reached the screen, counted at the moment a
 * connection closes (P3). Zero means everything they said is accounted for.
 *
 * TWO KINDS, because a word goes missing two ways. A FINAL caption whose delivery was accepted but
 * whose real message never became visible is the first: it is still on the row as a caption, and
 * {@link deliveryIsShown} says no delivery has taken it over. A segment that was handed to the relay
 * for transcription and produced no caption at all is the second: it never reached the fold, so it
 * can only be read as the gap between the segments sent (`segmentsSent`, the hook's own counter) and
 * the utterances those segments account for (`captions.length`).
 */
export function countUnshownUtterances(
  captions: readonly VoiceRealtimeCaption[],
  deliveries: readonly VoiceRealtimeDelivery[],
  visibleMessages: readonly ChatMessage[],
  segmentsSent = 0,
): number {
  const shown = new Set<string>();
  for (const delivery of deliveries) {
    if (!deliveryIsShown(delivery, visibleMessages)) continue;
    for (const itemId of delivery.itemIds) shown.add(itemId);
  }
  const unshownCaptions = captions.filter((caption) => caption.final && !shown.has(caption.itemId)).length;
  const silentSegments = Math.max(0, segmentsSent - captions.length);
  return unshownCaptions + silentSegments;
}

/**
 * The words the person SPOKE that no delivery ever took over — the backlog a Live Voice session
 * drops when the mode is left — joined the way the transcript row joins one spoken thought.
 *
 * A delivery is the proxy's record of one spoken thought it ACCEPTED; an utterance no delivery
 * carries was heard and went nowhere. This is deliberately NOT {@link countUnshownUtterances}: a
 * caption whose delivery was accepted but whose message is not on screen yet is not a loss — that
 * message is still on its way and will appear through the ordinary transcript, so re-typing it into
 * the composer would send it twice. Reading `itemIds` alone (accepted or not), only the utterances
 * NO delivery claims are the backlog. A caption that is not yet final is still being spoken and is
 * not a thought the model was ever offered, so it is left out too — the same boundary the close
 * trace's own count draws.
 *
 * Consumed by `ChatInterface`, which hands the text to the composer's draft when Live Voice is left.
 */
export function collectUndeliveredUtterances(
  captions: readonly VoiceRealtimeCaption[],
  deliveries: readonly VoiceRealtimeDelivery[],
): string {
  const delivered = new Set<string>();
  for (const delivery of deliveries) {
    for (const itemId of delivery.itemIds) delivered.add(itemId);
  }
  return joinCaptionParts(
    captions.filter((caption) => caption.final && !delivered.has(caption.itemId)).map((caption) => caption.text),
  );
}

/**
 * Appends the connection's close trace to the end of the transcript when a connection closed on
 * words the screen never showed, and otherwise returns the rows unchanged.
 *
 * THE BUILDER TAKES NO MODE. The trace is a fact about the CONNECTION, not about which composer
 * happens to be on screen: gating it on Live Voice being the active composer is what made the line
 * vanish the instant the mode was left — the exact moment a person needs to read that what they
 * said did not arrive. It rides at the end of the transcript, is display-only, and like the
 * provisional rows it is never persisted.
 *
 * Consumed by `ChatInterface`.
 */
export function appendVoiceCloseTrace(
  messages: readonly ChatMessage[],
  closedUnshown: number,
): ChatMessage[] {
  if (closedUnshown <= 0) {
    return [...messages];
  }
  return [...messages, { type: 'system', content: '', timestamp: Date.now(), voiceClosedUnshown: closedUnshown }];
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
    const index = marked.findIndex(
      (message, position) => !claimed.has(position) && messageIsDeliveryRow(message, delivery),
    );
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
