/**
 * Places the provisional caption rows of a Live Voice session at the SPOKEN position of each
 * utterance, instead of interleaving them with the real rows by time or stacking them at the bottom.
 *
 * WHY. The captions used to be interleaved with the real rows by TIME, on the reading that a caption
 * belongs beside the real rows stamped around it. Two clocks make that a lie: a caption's time is
 * when the BROWSER first saw the utterance, while a real user row's time is when the CLI TURN began
 * — later by the server's coalescing window and by however long the CLI queue made the turn wait. A
 * caption spoken while Claude was still answering the previous message was therefore stamped EARLIER
 * than that message's own row, and interleaved ABOVE it: the person's live words sitting over the
 * message Claude had not finished.
 *
 * THE PLACE A CAPTION BELONGS IS THE SEGMENT IT WAS SPOKEN IN. Both kinds of row carry one key that
 * says so — the caption its own relay `seq`, and a delivered row the `seq` of the utterances its
 * delivery took over — so the rows can be ordered by what the person actually said, in the order
 * they said it, without either clock being trusted. Only the rows that carry such a key anchor a
 * placement; everything else keeps its place in the real transcript and never pulls a caption past
 * it, which is what makes an unreadable timestamp harmless here. A connection with no seq
 * information at all keeps the placement this module has always used
 * ({@link placeCaptionsChronologically}): every pending row after the whole real transcript.
 *
 * Order within the real rows and within rows that share a position is preserved. Consumed by
 * `ChatInterface` (the pane that renders both), through {@link voiceTranscriptRows}.
 */
import type { VoiceRealtimeCaption, VoiceRealtimeDelivery } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';
import type { ChatMessage, VoiceRealtimeSegmentOutcome } from '@/shared/types';

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

/**
 * Letters and digits only, lower-cased: what survives punctuation, spacing and case differences.
 *
 * The client's counterpart of the proxy's `normalizeRelayText` (which strips whitespace, punctuation
 * and symbols). It is the ONE normalization every "does this text carry those words" question in the
 * client asks — the delivery fold, {@link dropCaptionsDeliveredAsMessages}, and the `sent` frame's
 * own attribution (which must reuse it rather than mint a second rule that could drift).
 */
export function normalizeForMatch(text: string): string {
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
 * `undeliveredItemIds` are the utterances the proxy REFUSED (AC6). They are left out of this row
 * entirely — they are not being spoken, not heard, and not on their way, so folding them in would
 * put words the model refused beside words it may still take, and show refused ones twice. Each gets
 * its own row from {@link undeliveredUtteranceRows}, which is the only place `undelivered` is stamped.
 *
 * Consumed by {@link voiceTranscriptRows}; the pane renders the result.
 */
export function foldCaptionsIntoTranscriptRow(
  captions: readonly VoiceRealtimeCaption[],
  deliveries: readonly VoiceRealtimeDelivery[],
  visibleMessages: readonly ChatMessage[],
  delivering = false,
  undeliveredItemIds: readonly string[] = [],
): ChatMessage | null {
  // An utterance the proxy REFUSED is out of this row entirely: it gets a row of its own (see
  // {@link undeliveredUtteranceRows}), and folding it in here would show the same words twice.
  const undelivered = new Set(undeliveredItemIds);
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
  const pending = captions.filter((caption) => !shown.has(caption.itemId) && !undelivered.has(caption.itemId));
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
 * The relay segment an utterance was SPOKEN in, or `null` when the caption carries no usable one.
 *
 * This is the key the whole placement below is built on: `seq` is assigned by the client when the
 * segment is sent and echoed back on every frame about that segment, so it is the one piece of
 * information about a spoken utterance that the endpoint's own reordering (and the two clocks) cannot
 * touch. A caption without it is a caption this module cannot place by speech, and is never guessed
 * at — see {@link voiceTranscriptRows}.
 */
function captionSpokenSeq(caption: VoiceRealtimeCaption): number | null {
  const seq = caption.seq;
  return typeof seq === 'number' && Number.isInteger(seq) ? seq : null;
}

/**
 * One row per utterance the model HEARD, at the utterance's own place in the conversation.
 *
 * WHY ONE ROW EACH, WHERE {@link foldCaptionsIntoTranscriptRow} FOLDS. Folding exists to stop one
 * spoken thought being read as three thoughts — but it folds EVERYTHING still pending into one row,
 * which has a second, unasked-for consequence: the row carries the delivery state of the whole
 * backlog. When four utterances are pending and the relay is answering one of them, the folded row
 * says `delivering` and every word on it reads as being tidied up — including the three the relay was
 * never given. The person watches their words sit under a spinner that does not apply to them, and
 * cannot tell which of their sentences is the one being handled. One row per utterance keeps the
 * marker on the sentence it is true of.
 *
 * WHICH UTTERANCE IS `delivering`. Only two, and both are facts about the relay rather than about
 * what the client would like to be true: the one whose own delivery the server ACCEPTED but whose
 * real message is not visible yet (see {@link deliveryIsShown}), and — while the proxy says it is
 * delivering — the newest closed utterance still pending, which is the one it was handed. Everything
 * else closed reads `heard`: it is with the model, and nothing is being done about it right now.
 * Words still being spoken carry no state at all, the same boundary the fold draws.
 *
 * Utterances the proxy REFUSED are left out (they get {@link undeliveredUtteranceRows}), as are the
 * ones a visible delivery has taken over, and captions with no words in them.
 *
 * Consumed by {@link voiceTranscriptRows}.
 */
export function heardUtteranceRows(
  captions: readonly VoiceRealtimeCaption[],
  deliveries: readonly VoiceRealtimeDelivery[],
  visibleMessages: readonly ChatMessage[],
  delivering = false,
  undeliveredItemIds: readonly string[] = [],
): ChatMessage[] {
  const refused = new Set(undeliveredItemIds);
  const shown = new Set<string>();
  const unshown = new Set<string>();
  for (const delivery of deliveries) {
    for (const itemId of delivery.itemIds) {
      (deliveryIsShown(delivery, visibleMessages) ? shown : unshown).add(itemId);
    }
  }
  const pending = captions.filter(
    (caption) => !shown.has(caption.itemId) && !refused.has(caption.itemId) && caption.text.trim() !== '',
  );
  // The utterance the relay is answering right now is the LAST one still pending — the newest thing
  // the person closed before the instruction went out. Read off the pending list rather than off a
  // `sent` frame, so it is the same reading whether the window is the proxy's queue or a message that
  // is accepted and still unshown.
  const newest = pending.length > 0 ? pending[pending.length - 1]!.itemId : null;
  return pending.map((caption) => {
    const text = caption.text.trim();
    const inFlight = unshown.has(caption.itemId) || (delivering && caption.final && caption.itemId === newest);
    return {
      type: 'user' as const,
      content: text,
      displayText: text,
      // Keyed on the utterance's own id: stable across renders, printed by the rows that read it
      // ({@link dropCaptionsDeliveredAsMessages}, {@link positionOfRow}) and pre-fixed so
      // `messageIsDeliveryRow` never mistakes this stand-in for the real message.
      id: `voice-caption-${caption.itemId}`,
      timestamp: caption.at,
      ...(inFlight
        ? { voiceRowState: 'delivering' as const }
        : caption.final
          ? { voiceRowState: 'heard' as const }
          : {}),
    };
  });
}

/**
 * One row per segment that reached the relay and came back with NO TRANSCRIPT (AC4).
 *
 * WHAT THIS ROW IS FOR. The endpoint is allowed to drop a segment — it refuses to commit one whose
 * transcription came back empty, and the proxy reports that as `segment_ack` with
 * `state:'dropped'`. Until now the page said nothing at all about it: the segment's audio had been
 * sent, its words were gone, and the transcript simply had a hole in it that only showed up as a
 * turn that answered something other than what was said. A person cannot tell a hole from a pause.
 * The row states the fact at the segment's own place in the conversation, which is where the person
 * can see WHICH of their sentences it was.
 *
 * `seqs` are the client's own segment numbers (see {@link captionSpokenSeq}), ascending and
 * de-duplicated here: a segment can be marked twice (the relay's own `dropped` ack, and the client's
 * deadline for a transcript that never came at all — see `useVoiceRealtimeSession`), and the person
 * needs to read the loss once. A sequence that later does produce a transcript is RETRACTED by the
 * hook before it reaches this function, so a late transcript is never shown as a loss.
 *
 * The rows are `type:'system'` and deliberately carry no `data-message-style`: nothing was said, so
 * they are not the person's rows, and the pane's own row algebra must not count them as messages.
 *
 * Consumed by {@link voiceTranscriptRows}.
 */
export function unrecognizedSegmentRows(seqs: readonly number[]): ChatMessage[] {
  const unique = [...new Set(seqs.filter((seq) => Number.isInteger(seq)))].sort((a, b) => a - b);
  return unique.map((seq) => ({
    type: 'system' as const,
    content: '',
    timestamp: Date.now(),
    voiceUnrecognizedSeq: seq,
  }));
}

/**
 * One row per relay segment the graded segment ACK reported UNCERTAIN or LOST (AC-367).
 *
 * WHAT THIS ROW IS FOR, AND WHY IT IS NOT {@link unrecognizedSegmentRows}. The two read alike on a
 * transcript ("part of what you said is missing") and mean opposite things about the blame. An
 * unrecognised segment is one the endpoint WAS given and answered with no words — the audio arrived
 * and the transcription came back empty. These rows are the connection's own failures: `written`
 * means the audio and its commit left for an upstream socket that died before the endpoint answered
 * (the words may still be replayed, so the honest reading is "retrying", not "lost"), and `lost`
 * means the segment will never be transcribed, either because the connection was closed when it
 * ended (`connection-closed` — nothing was ever sent) or because the bridge spent its replay budget
 * (`upstream-drop` — the words never reached the model). Marking a connection failure as "not
 * recognised" would blame the recogniser for a wire that never carried the audio.
 *
 * A `lost` row is also NOT the person's own words: the segment produced no transcript, so there is
 * nothing they said to show — which is why these are `type:'system'` rows with no text and no
 * `data-message-style`, exactly like the not-recognised rows, and why nothing here can be handed
 * back to the composer as unforwarded speech.
 *
 * `outcomes` is de-duplicated by `seq`, last one wins: a segment can be answered twice (a `written`
 * that a later `lost(upstream-drop)` supersedes, once the bridge gives up replaying it), and the
 * person needs one line per segment, carrying the latest fate. Sorted by `seq`, so the rows land in
 * spoken order.
 *
 * Consumed by {@link voiceTranscriptRows}.
 */
export function segmentOutcomeRows(outcomes: readonly VoiceRealtimeSegmentOutcome[]): ChatMessage[] {
  const bySeq = new Map<number, VoiceRealtimeSegmentOutcome>();
  for (const outcome of outcomes) {
    if (Number.isInteger(outcome.seq)) bySeq.set(outcome.seq, outcome);
  }
  return [...bySeq.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((outcome) => ({
      type: 'system' as const,
      content: '',
      timestamp: Date.now(),
      voiceSegmentOutcome: outcome,
    }));
}

/**
 * One row per utterance the proxy REFUSED and no delivery ever took over (AC6).
 *
 * WHY A ROW EACH, WHERE EVERYTHING ELSE IS ONE ROW. A refusal is a per-utterance outcome: the model
 * tried to relay one thing and the queue was full. Folding refused utterances into the single
 * provisional row (the way words being spoken or waiting are folded) would both hide how many were
 * lost and show them beside words that may still be delivered. One row each keeps them countable —
 * "two sentences did not go" is a reading, "some of this did not go" is not — and each carries the
 * `undelivered` marker so a person scanning the transcript sees exactly which lines never reached
 * Claude.
 *
 * Rows are ordered by when the person began each utterance, and keyed by the utterance's own item
 * id, so the row is stable across renders and cannot collide with the provisional row it was kept
 * out of. An id with no caption, or with no words in its caption, produces nothing: there is no line
 * to show for a silence.
 *
 * Consumed by {@link voiceTranscriptRows}, which places these rows at the segment each was spoken in.
 */
export function undeliveredUtteranceRows(
  captions: readonly VoiceRealtimeCaption[],
  undeliveredItemIds: readonly string[],
  visibleMessages: readonly ChatMessage[],
): ChatMessage[] {
  const wanted = new Set(undeliveredItemIds);
  const rows: ChatMessage[] = [];
  for (const caption of captions) {
    if (!wanted.has(caption.itemId)) continue;
    const text = caption.text.trim();
    if (text === '') continue;
    // A refused utterance that a real message already carries the words of is not undelivered after
    // all — the delivery landed by another path, and a second copy would read as a duplicate.
    if (messageWordsAlreadyVisible(visibleMessages, caption.text)) continue;
    rows.push({
      type: 'user',
      content: text,
      displayText: text,
      id: `voice-undelivered-${caption.itemId}`,
      timestamp: caption.at,
      voiceRowState: 'undelivered',
    });
  }
  // `captions` is already in utterance order, so the rows are too; sorted defensively by the time
  // each utterance began, which is the order the person said them in.
  return rows.sort((a, b) => (toEpochMs(a.timestamp) ?? 0) - (toEpochMs(b.timestamp) ?? 0));
}

/**
 * Whether the delivered words of a real user row already contain `text` (punctuation and case
 * ignored). The one duplicate check {@link undeliveredUtteranceRows} needs, kept local because it
 * has no other caller.
 */
function messageWordsAlreadyVisible(messages: readonly ChatMessage[], text: string): boolean {
  const words = normalizeForMatch(text);
  if (words.length < 3) return false;
  return messages.some(
    (message) =>
      message.type === 'user' &&
      typeof message.content === 'string' &&
      !(typeof message.id === 'string' && message.id.startsWith('voice-caption-')) &&
      normalizeForMatch(message.content).includes(words),
  );
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

/**
 * Places the provisional caption rows of a Live Voice session AFTER the newest real user row and
 * that turn's reply — the bottom of the conversation — instead of interleaving them with the real
 * rows by time.
 *
 * WHY TIME WAS WRONG. The two row kinds carry two clocks. A caption row is stamped when the BROWSER
 * first saw the utterance (`useVoiceRealtimeSession`); a real user row is stamped when the CLI TURN
 * began, later by the server's coalescing window and by however long the CLI queue made the turn
 * wait. The stamps are neither the same quantity nor the same clock, so a caption spoken AFTER a
 * real message can be stamped BEFORE it. Read as "older", that put the person's live words ABOVE the
 * message Claude was still answering (2026-10-11 15:41, journal 57279cc1: caption B stamped 15:41:20
 * sat above user A's real row stamped 15:41:30).
 *
 * WHY AFTER THE NEWEST REAL ROW IS THE ONLY PLACE LEFT. A caption still on screen carries words no
 * real message has taken over yet — the already-delivered ones are removed by
 * {@link markDeliveredVoiceMessages} / {@link dropCaptionsDeliveredAsMessages} before this runs. Its
 * truthful place is therefore the end of the conversation: below the newest real user row and below
 * Claude's reply to it. Order within the real rows and within the captions is preserved.
 *
 * THE ONE EXCEPTION. When a real row's time cannot be read, where the newest real user row sits is
 * not knowable either, so the rows keep the chronological placement of {@link placeCaptionsByTime} —
 * an unreadable row must neither pull a caption ahead of it nor drag one past it.
 *
 * This is now the FALLBACK placement: {@link voiceTranscriptRows} places rows by the segment they
 * were spoken in whenever they carry one, and comes here only for the rows that carry no segment at
 * all. Module-private callers only — {@link voiceTranscriptRows} is the entry point.
 */
export function placeCaptionsChronologically(
  messages: readonly ChatMessage[],
  captionRows: readonly ChatMessage[],
): ChatMessage[] {
  if (captionRows.length === 0) {
    return [...messages];
  }
  if (messages.some((message) => toEpochMs(message.timestamp) === null)) {
    return placeCaptionsByTime(messages, captionRows);
  }
  // Sorted by when each thought began, so several captions keep the order the person said them in;
  // every one of them then rides after the whole real transcript, whose tail is the newest real user
  // row and that turn's reply.
  const pending = [...captionRows].sort((a, b) => (toEpochMs(a.timestamp) ?? 0) - (toEpochMs(b.timestamp) ?? 0));
  return [...messages, ...pending];
}

/**
 * The chronological placement {@link placeCaptionsChronologically} falls back to when a real row's
 * time cannot be read: a caption goes immediately before the first real row stamped later than it,
 * one with no later row goes last, and rows whose time cannot be read keep their place and never move
 * a caption. Module-private — its only caller is the public placement above.
 */
function placeCaptionsByTime(
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

/** The id prefix {@link heardUtteranceRows} keys its rows on, read back by {@link positionOfRow}. */
const CAPTION_ROW_PREFIX = 'voice-caption-';
/** The id prefix {@link undeliveredUtteranceRows} keys its rows on, read back by {@link positionOfRow}. */
const REFUSED_ROW_PREFIX = 'voice-undelivered-';

/**
 * The segment a row was SPOKEN in, or `Infinity` when the row's position in the conversation is not
 * a matter of speech at all — the opening transcript, Claude's replies, the close trace.
 *
 * A provisional caption row and a refused-utterance row carry their own utterance's segment; a real
 * delivered row carries the EARLIEST segment among the utterances its delivery took over, because the
 * turn began when the first of them was spoken; an unrecognized row and a graded-outcome row carry the
 * segment they are about — the one that produced no words, or the one the connection reported
 * uncertain/lost. `Infinity` is not "last" — it is "does not anchor", and {@link voiceTranscriptRows}
 * uses the distinction to let those rows keep the transcript's own order.
 *
 * Module-private: its only caller is the placement below, which owns the seq map it reads through.
 */
function positionOfRow(
  row: ChatMessage,
  deliveries: readonly VoiceRealtimeDelivery[],
  seqByItemId: ReadonlyMap<string, number>,
): number {
  if (typeof row.voiceUnrecognizedSeq === 'number') {
    return row.voiceUnrecognizedSeq;
  }
  if (row.voiceSegmentOutcome) {
    return row.voiceSegmentOutcome.seq;
  }
  const id = typeof row.id === 'string' ? row.id : '';
  for (const prefix of [CAPTION_ROW_PREFIX, REFUSED_ROW_PREFIX]) {
    if (id.startsWith(prefix)) {
      return seqByItemId.get(id.slice(prefix.length)) ?? Number.POSITIVE_INFINITY;
    }
  }
  let earliest = Number.POSITIVE_INFINITY;
  for (const delivery of deliveries) {
    if (!messageIsDeliveryRow(row, delivery)) continue;
    for (const itemId of delivery.itemIds) {
      const seq = seqByItemId.get(itemId);
      if (seq !== undefined && seq < earliest) earliest = seq;
    }
  }
  return earliest;
}

/**
 * The transcript a Live Voice session puts on screen: the real messages, the utterances still on the
 * person's side of the delivery, the segments that came back with no transcript, the segments the
 * graded ACK reported UNCERTAIN or LOST (AC-367), and the connection's close trace — ordered by WHAT
 * WAS SAID, in the order it was said.
 *
 * THE ONE ENTRY POINT. Every rule above is a step of this; the pane calls this and nothing else, so
 * the order of the steps cannot drift between the rows that depend on each other (a delivery must be
 * marked before its caption row is dropped, the caption row must be dropped before what is left is
 * placed, the backlog must be read against the marked rows).
 *
 * WHY POSITION AND NOT TIME OR "THE BOTTOM". `ChatInterface` used to stack everything pending after
 * the whole real transcript, on the true observation that the two row kinds carry two different
 * clocks (see {@link placeCaptionsChronologically}). That is right about the clocks and wrong about
 * the conclusion: stacking is stable, but it reads as though everything still pending was said after
 * everything already delivered, and with several utterances pending it also loses their order. The
 * rows carry a key that says when each was spoken, so they can be placed by it: each row goes where
 * the person said it, and a row that carries no such key (the opening transcript, Claude's replies,
 * the close trace) keeps its place and never pulls a row past it.
 *
 * A CONNECTION WITH NO SEQ INFORMATION — continuous mode, or a proxy built before the pairing — has
 * no position to place by, and gets the placement this module has always used: the pending rows trail
 * the real transcript, in sorted order, through {@link placeCaptionsChronologically}, with the
 * unrecognized rows after them (there is nothing for them to be spoken "between").
 *
 * Consumed by `ChatInterface`.
 */
export function voiceTranscriptRows(input: {
  captions: readonly VoiceRealtimeCaption[];
  deliveries: readonly VoiceRealtimeDelivery[];
  visibleMessages: readonly ChatMessage[];
  delivering?: boolean;
  undeliveredItemIds?: readonly string[];
  unrecognizedSeqs?: readonly number[];
  segmentOutcomes?: readonly VoiceRealtimeSegmentOutcome[];
}): ChatMessage[] {
  const {
    captions,
    deliveries,
    visibleMessages,
    delivering = false,
    undeliveredItemIds = [],
    unrecognizedSeqs = [],
    segmentOutcomes = [],
  } = input;

  const spoken = heardUtteranceRows(captions, deliveries, visibleMessages, delivering, undeliveredItemIds);
  // The real message is the row that stays: a shown delivery marks the message it became and absorbs
  // the caption row carrying the same utterances, so a person's words are never on screen twice.
  const marked = markDeliveredVoiceMessages(visibleMessages, spoken, deliveries);
  // A caption the model relayed verbatim is the same sentence as the real row it precedes: hide it.
  const kept = dropCaptionsDeliveredAsMessages(marked.messages, marked.captionRows);
  const refused = undeliveredUtteranceRows(captions, undeliveredItemIds, marked.messages);
  const unrecognized = unrecognizedSegmentRows(unrecognizedSeqs);
  const graded = segmentOutcomeRows(segmentOutcomes);

  const seqByItemId = new Map<string, number>();
  for (const caption of captions) {
    const seq = captionSpokenSeq(caption);
    if (seq !== null && !seqByItemId.has(caption.itemId)) seqByItemId.set(caption.itemId, seq);
  }
  const pending = [...kept, ...refused, ...unrecognized, ...graded];
  if (!pending.some((row) => Number.isFinite(positionOfRow(row, deliveries, seqByItemId)))) {
    const placed = placeCaptionsChronologically(marked.messages, kept);
    const withRefused = refused.length > 0 ? placeCaptionsChronologically(placed, refused) : placed;
    const withUnrecognized = unrecognized.length > 0 ? [...withRefused, ...unrecognized] : withRefused;
    return graded.length > 0 ? [...withUnrecognized, ...graded] : withUnrecognized;
  }

  // Walk the real transcript; before a row that was spoken in segment N, flush every pending row
  // spoken before segment N. Rows that anchor nothing are never flushed early and never hold a
  // flushed row back, so a reply keeps its own place and the flushed words land immediately above
  // the turn they belong to. `index` is the tie-break, so equal positions keep the order built above
  // (real caption before refused before unrecognized before graded outcome) rather than an arbitrary one.
  const ordered = pending
    .map((row, index) => ({ row, position: positionOfRow(row, deliveries, seqByItemId), index }))
    .sort((a, b) => (a.position === b.position ? a.index - b.index : a.position - b.position));
  const out: ChatMessage[] = [];
  let next = 0;
  for (const message of marked.messages) {
    const at = positionOfRow(message, deliveries, seqByItemId);
    if (Number.isFinite(at)) {
      while (next < ordered.length && ordered[next]!.position < at) {
        out.push(ordered[next]!.row);
        next += 1;
      }
    }
    out.push(message);
  }
  while (next < ordered.length) {
    out.push(ordered[next]!.row);
    next += 1;
  }
  return out;
}
