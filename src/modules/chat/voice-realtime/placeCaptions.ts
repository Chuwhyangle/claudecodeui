/**
 * Places the HONEST state rows of a Live Voice session at the SPOKEN position of the segment each is
 * about, instead of interleaving them with the real rows by time or stacking them at the bottom.
 *
 * WHAT ROWS. The row that carries a spoken sentence is the real message the model relayed; this
 * module never invents a second copy of words the transcript already shows. What is left for it are
 * the rows that state a fact the real transcript cannot — a segment the proxy REFUSED (never
 * delivered anywhere), a segment the relay answered with no transcript, a segment the graded ACK
 * reported uncertain or lost — and, while the session has not yet written the turn for them, the
 * words of a delivery whose real message the pane is not showing at all. See
 * {@link undeliveredUtteranceRows}, {@link unrecognizedSegmentRows}, {@link segmentOutcomeRows},
 * {@link deliveredMessageRows}.
 *
 * WHY NOT BY TIME. These rows used to be interleaved with the real ones by TIME, on the reading that
 * a row belongs beside the real rows stamped around it. Two clocks make that a lie: a voice row's
 * time is when the BROWSER first saw the segment, while a real user row's time is when the CLI TURN
 * began — later by the server's coalescing window and by however long the CLI queue made the turn
 * wait. A row about a segment spoken while Claude was still answering the previous message was
 * therefore stamped EARLIER than that message's own row, and interleaved ABOVE it.
 *
 * THE PLACE A ROW BELONGS IS THE SEGMENT IT IS ABOUT. Both kinds of row carry one key that says so —
 * an honest row its own relay `seq` (or the utterance's, from the caption it was built from), and a
 * delivered row the `seq` of the utterances its delivery took over — so the rows can be ordered by
 * what the person actually said, in the order they said it, without either clock being trusted. Only
 * the rows that carry such a key anchor a placement; everything else keeps its place in the real
 * transcript and never pulls a row past it, which is what makes an unreadable timestamp harmless
 * here. A connection with no seq information at all keeps the placement this module has always used
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
 * client asks — the delivery's own shown-message match ({@link deliveryIsShown}, and the
 * {@link markDeliveredVoiceMessages} mark it drives), the duplicate check
 * {@link undeliveredUtteranceRows} makes, and the `sent` frame's own attribution (which must reuse it
 * rather than mint a second rule that could drift).
 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** How far before a caption a real message may be stamped and still be taken as its delivery (clock skew). */
const DELIVERY_SKEW_MS = 30_000;

/**
 * The span the proxy treats as CJK when it joins the pieces of one spoken thought into one message
 * (`voice-realtime-ws-proxy.service.ts`'s `joinParts`), mirrored here so the backlog the composer is
 * handed is assembled by the same rule as the message the person will be shown as having sent.
 */
const CJK = /[　-鿿＀-￯]/;

/**
 * Joins the pieces of one spoken thought the way the proxy does: no space between two CJK pieces,
 * one space between anything else, and a piece with no words at all skipped entirely — it is
 * neither text nor a separator.
 *
 * Module-private: {@link collectUndeliveredUtterances} (the backlog the composer is handed) and
 * {@link deliveredMessageRows} (the carrier row of a delivery the transcript has not caught up with)
 * are its callers, so words shown to the person as delivered are assembled by the same rule as the
 * message the proxy composed.
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
 * THE ONE MATCHING RULE {@link deliveryIsShown} and {@link markDeliveredVoiceMessages} share, so a
 * delivery is judged "already shown" by exactly the rule that later marks the row it became: a real
 * user row carrying text that CONTAINS the delivered words, stamped no earlier than the delivery less
 * clock skew.
 */
function messageIsDeliveryRow(message: ChatMessage, delivery: VoiceRealtimeDelivery): boolean {
  if (message.type !== 'user' || typeof message.content !== 'string') return false;
  const wanted = normalizeForMatch(delivery.message);
  if (wanted === '') return false;
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
 * id, so the row is stable across renders and cannot collide with any real row. An id with no
 * caption, or with no words in its caption, produces nothing: there is no line to show for a
 * silence.
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
      normalizeForMatch(message.content).includes(words),
  );
}

/**
 * How many utterances the person spoke that never reached the screen, counted at the moment a
 * connection closes (P3). Zero means everything they said is accounted for.
 *
 * TWO KINDS, because a word goes missing two ways. A FINAL caption whose delivery was accepted but
 * whose real message never became visible is the first: nothing on screen carries its words, and
 * {@link deliveryIsShown} says no delivery has taken it over. A segment that was handed to the relay
 * for transcription and produced no caption at all is the second: it never reached the transcript, so it
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
 * drops when the mode is left — joined the way the proxy joins one spoken thought.
 *
 * A delivery is the proxy's record of one spoken thought it ACCEPTED; an utterance no delivery
 * carries was heard and went nowhere. This is deliberately NOT {@link countUnshownUtterances}: a
 * caption whose delivery was accepted but whose message is not on screen yet is not a loss — that
 * message is still on its way and will appear through the ordinary transcript, so re-typing it into
 * the composer would send it twice. Reading `itemIds` alone (accepted or not), only the utterances
 * NO delivery claims are the backlog. A caption that is not yet final is still being spoken and is
 * not a thought the model was ever offered, so it is left out too — the same boundary
 * {@link countUnshownUtterances} draws.
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
 * Marks the real user messages that were SPOKEN.
 *
 * The person's message — what was delivered to Claude — is the row; there is no provisional row of
 * this client's own standing in for it while it is in flight. For each confirmed delivery (oldest
 * first) the first real user message whose words contain the delivered text, stamped no earlier than
 * the delivery (less clock skew) and not already claimed, is returned with `voiceTranscript.heard`
 * set to the words the model relayed it had heard. A delivery with no matching message yet (the
 * transcript has not been re-read) marks nothing, and the message appears unmarked through the
 * ordinary transcript once it lands.
 *
 * Consumed by {@link voiceTranscriptRows} and `ChatInterface`.
 */
export function markDeliveredVoiceMessages(
  messages: readonly ChatMessage[],
  deliveries: ReadonlyArray<{ message: string; at: number; heard: string[]; itemIds: string[] }>,
): ChatMessage[] {
  const marked = [...messages];
  const claimed = new Set<number>();
  for (const delivery of deliveries) {
    const index = marked.findIndex(
      (message, position) => !claimed.has(position) && messageIsDeliveryRow(message, delivery),
    );
    if (index === -1) continue;
    claimed.add(index);
    marked[index] = { ...marked[index]!, voiceTranscript: { heard: delivery.heard } };
  }
  return marked;
}

/** The id prefix {@link deliveredMessageRows} keys its rows on, read back by {@link positionOfRow}. */
const DELIVERED_ROW_PREFIX = 'voice-delivered-';

/**
 * One carrier row per delivery whose real message the transcript has not caught up with.
 *
 * WHAT THIS ROW IS FOR. A delivery is words that REACHED the session, and the row that normally
 * carries them is the real user message the CLI turn writes: {@link markDeliveredVoiceMessages} marks
 * it, and the person reads their own sentence in the conversation. When the session holds the message
 * but has not begun the turn for it — a queued send behind a running turn, a busy session — there is
 * no such row, and then nothing on screen says the words arrived at all. The 2026-10-13 reading is
 * exactly that gap for the merged `U3+U4` message: `routing.sends` records it as `outcome:'delivered'`
 * and the chat area showed it on no row (`gap-voice-delivered-merged-message-invisible-in-transcript`).
 *
 * WHICH WORDS. The words of the captions the delivery CLAIMED BY ITEM ID (`delivery.itemIds`) whose
 * text the delivered message actually carries, in spoken order, joined by the rule the proxy joins a
 * coalesced message with ({@link joinCaptionParts}). The claim is the attribution — never a search of
 * the transcript for the delivered text — and the intersection is what keeps the row honest: an
 * utterance inside the delivery's span that the model did not relay is NOT this row's words, because
 * a `silent` utterance is owed no row
 * (`gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop`). A delivery whose
 * claimed utterances carry none of its words — the model reworded all of them — draws no row here:
 * this row stands for words the person said, and invents none.
 *
 * WHICH DELIVERIES. Only those {@link deliveryIsShown} reports as NOT shown, read off the same rule
 * the hook uses to retire a delivery's captions: the moment the real message lands, this row must go
 * with it, or the person reads the same sentence twice. The row is keyed by the first carried
 * utterance's item id and carries no `voiceRowState` — it is the person's own delivered words, not a
 * refusal, and the pane's row algebra reads it as the user row it stands in for.
 *
 * Consumed by {@link voiceTranscriptRows}, which places each row at the segment the delivery began in.
 */
export function deliveredMessageRows(
  captions: readonly VoiceRealtimeCaption[],
  deliveries: readonly VoiceRealtimeDelivery[],
  visibleMessages: readonly ChatMessage[],
): ChatMessage[] {
  const byItemId = new Map(captions.map((caption) => [caption.itemId, caption]));
  const rows: ChatMessage[] = [];
  for (const delivery of deliveries) {
    if (deliveryIsShown(delivery, visibleMessages)) continue;
    const delivered = normalizeForMatch(delivery.message);
    if (delivered === '') continue;
    const carried: VoiceRealtimeCaption[] = [];
    for (const itemId of delivery.itemIds) {
      const caption = byItemId.get(itemId);
      if (caption === undefined) continue;
      const normalized = normalizeForMatch(caption.text);
      if (normalized === '' || !delivered.includes(normalized)) continue;
      carried.push(caption);
    }
    const first = carried[0];
    if (first === undefined) continue;
    const heard = carried.map((caption) => caption.text.trim());
    const content = joinCaptionParts(heard);
    rows.push({
      type: 'user',
      content,
      displayText: content,
      id: `${DELIVERED_ROW_PREFIX}${first.itemId}`,
      timestamp: first.at,
      voiceTranscript: { heard },
    });
  }
  return rows;
}

/**
 * Places the honest state rows of a Live Voice session AFTER the newest real user row and that
 * turn's reply — the bottom of the conversation — instead of interleaving them with the real rows by
 * time.
 *
 * WHY TIME WAS WRONG. The two row kinds carry two clocks. A voice row is stamped when the BROWSER
 * first saw the segment (`useVoiceRealtimeSession`); a real user row is stamped when the CLI TURN
 * began, later by the server's coalescing window and by however long the CLI queue made the turn
 * wait. The stamps are neither the same quantity nor the same clock, so a row spoken AFTER a real
 * message can be stamped BEFORE it. Read as "older", that put the person's live words ABOVE the
 * message Claude was still answering (2026-10-11 15:41, journal 57279cc1: caption B stamped 15:41:20
 * sat above user A's real row stamped 15:41:30).
 *
 * WHY AFTER THE NEWEST REAL ROW IS THE ONLY PLACE LEFT. A row still on screen states a fact about a
 * segment no real message stands for yet. Its truthful place is therefore the end of the
 * conversation: below the newest real user row and below Claude's reply to it. Order within the real
 * rows and within the pending rows is preserved.
 *
 * THE ONE EXCEPTION. When a real row's time cannot be read, where the newest real user row sits is
 * not knowable either, so the rows keep the chronological placement of {@link placeCaptionsByTime} —
 * an unreadable row must neither pull a pending row ahead of it nor drag one past it.
 *
 * This is now the FALLBACK placement: {@link voiceTranscriptRows} places rows by the segment they
 * are about whenever they carry one, and comes here only for the rows that carry no segment at all.
 * Module-private callers only — {@link voiceTranscriptRows} is the entry point.
 */
export function placeCaptionsChronologically(
  messages: readonly ChatMessage[],
  pendingRows: readonly ChatMessage[],
): ChatMessage[] {
  if (pendingRows.length === 0) {
    return [...messages];
  }
  if (messages.some((message) => toEpochMs(message.timestamp) === null)) {
    return placeCaptionsByTime(messages, pendingRows);
  }
  // Sorted by when each segment began, so several pending rows keep the order the person said them
  // in; every one of them then rides after the whole real transcript, whose tail is the newest real
  // user row and that turn's reply.
  const pending = [...pendingRows].sort((a, b) => (toEpochMs(a.timestamp) ?? 0) - (toEpochMs(b.timestamp) ?? 0));
  return [...messages, ...pending];
}

/**
 * The chronological placement {@link placeCaptionsChronologically} falls back to when a real row's
 * time cannot be read: a pending row goes immediately before the first real row stamped later than
 * it, one with no later row goes last, and rows whose time cannot be read keep their place and never
 * move a pending row. Module-private — its only caller is the public placement above.
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

/** The id prefix {@link undeliveredUtteranceRows} keys its rows on, read back by {@link positionOfRow}. */
const REFUSED_ROW_PREFIX = 'voice-undelivered-';

/**
 * The segment a row was SPOKEN in, or `Infinity` when the row's position in the conversation is not
 * a matter of speech at all — the opening transcript, Claude's replies, the close trace.
 *
 * A refused-utterance row carries its own utterance's segment; a real delivered row carries the
 * EARLIEST segment among the utterances its delivery took over, because the turn began when the
 * first of them was spoken; an unrecognized row and a graded-outcome row carry the segment they are
 * about — the one that produced no words, or the one the connection reported uncertain/lost.
 * `Infinity` is not "last" — it is "does not anchor", and {@link voiceTranscriptRows} uses the
 * distinction to let those rows keep the transcript's own order.
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
  if (id.startsWith(REFUSED_ROW_PREFIX)) {
    return seqByItemId.get(id.slice(REFUSED_ROW_PREFIX.length)) ?? Number.POSITIVE_INFINITY;
  }
  if (id.startsWith(DELIVERED_ROW_PREFIX)) {
    // A delivered row's carrier stands in for a whole turn, which began with the FIRST utterance the
    // delivery carried — the row is keyed by that utterance's item id.
    return seqByItemId.get(id.slice(DELIVERED_ROW_PREFIX.length)) ?? Number.POSITIVE_INFINITY;
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
 * The transcript a Live Voice session puts on screen: the real messages (the delivered ones marked
 * as spoken), the segments the proxy REFUSED, the segments that came back with no transcript, the
 * segments the graded ACK reported UNCERTAIN or LOST (AC-367), and the connection's close trace —
 * ordered by WHAT WAS SAID, in the order it was said.
 *
 * THE ONE ENTRY POINT. Every rule above is a step of this; the pane calls this and nothing else, so
 * the order of the steps cannot drift between the rows that depend on each other (a delivery must be
 * marked before the refused rows are read against the marked rows).
 *
 * WHAT IS NOT HERE. The person's spoken words are never carried TWICE: an utterance reaches the
 * transcript the one way anything else does, as the real message the model relayed, and the carrier
 * row {@link deliveredMessageRows} draws is the stand-in for that message only while the transcript
 * is not showing it. The rows this adds are otherwise the ones that state a fact the real transcript
 * cannot — a segment the proxy refused, one the relay answered with no words, one the connection
 * reported lost.
 *
 * WHY POSITION AND NOT TIME OR "THE BOTTOM". `ChatInterface` used to stack everything pending after
 * the whole real transcript, on the true observation that the two row kinds carry two different
 * clocks (see {@link placeCaptionsChronologically}). That is right about the clocks and wrong about
 * the conclusion: stacking is stable, but it reads as though everything still pending was said after
 * everything already delivered, and with several segments pending it also loses their order. The
 * rows carry a key that says which segment each is about, so they can be placed by it: each row goes
 * where the person said it, and a row that carries no such key (the opening transcript, Claude's
 * replies, the close trace) keeps its place and never pulls a row past it.
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
  undeliveredItemIds?: readonly string[];
  unrecognizedSeqs?: readonly number[];
  segmentOutcomes?: readonly VoiceRealtimeSegmentOutcome[];
}): ChatMessage[] {
  const {
    captions,
    deliveries,
    visibleMessages,
    undeliveredItemIds = [],
    unrecognizedSeqs = [],
    segmentOutcomes = [],
  } = input;

  // The real message is the row that stays: a shown delivery marks the message it became, so a
  // person's spoken words are never carried by a row of this client's own.
  const marked = markDeliveredVoiceMessages(visibleMessages, deliveries);
  // Each refused utterance, silent segment and graded outcome is a line of its own, placed at the
  // segment it is about — and so is a delivery whose real message the session has not shown yet, so
  // the words the session received are not invisible while the turn that will write them is pending.
  const refused = undeliveredUtteranceRows(captions, undeliveredItemIds, marked);
  const unrecognized = unrecognizedSegmentRows(unrecognizedSeqs);
  const graded = segmentOutcomeRows(segmentOutcomes);
  const delivered = deliveredMessageRows(captions, deliveries, visibleMessages);

  const seqByItemId = new Map<string, number>();
  for (const caption of captions) {
    const seq = captionSpokenSeq(caption);
    if (seq !== null && !seqByItemId.has(caption.itemId)) seqByItemId.set(caption.itemId, seq);
  }
  const pending = [...delivered, ...refused, ...unrecognized, ...graded];
  if (!pending.some((row) => Number.isFinite(positionOfRow(row, deliveries, seqByItemId)))) {
    // No row carries a spoken segment: the honest rows trail the real transcript, in order.
    const placed = placeCaptionsChronologically(marked, [...delivered, ...refused]);
    const withUnrecognized = unrecognized.length > 0 ? [...placed, ...unrecognized] : placed;
    return graded.length > 0 ? [...withUnrecognized, ...graded] : withUnrecognized;
  }

  // Walk the real transcript; before a row that was spoken in segment N, flush every pending row
  // spoken before segment N. Rows that anchor nothing are never flushed early and never hold a
  // flushed row back, so a reply keeps its own place and the flushed lines land immediately above
  // the turn they belong to. `index` is the tie-break, so equal positions keep the order built above
  // (refused before unrecognized before graded outcome) rather than an arbitrary one.
  const ordered = pending
    .map((row, index) => ({ row, position: positionOfRow(row, deliveries, seqByItemId), index }))
    .sort((a, b) => (a.position === b.position ? a.index - b.index : a.position - b.position));
  const out: ChatMessage[] = [];
  let next = 0;
  for (const message of marked) {
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
