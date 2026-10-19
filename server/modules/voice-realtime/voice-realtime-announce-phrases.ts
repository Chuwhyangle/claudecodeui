/**
 * The fixed sentences the LIVE VOICE ANNOUNCE closing turn speaks.
 *
 * WHY A FIXED TABLE. On the 2026-10-19 live capture (`journal
 * 56278c8d-d0f0-444b-ad6e-8d7b2154275b.jsonl`) all five announcements on one connection were
 * 8–9-character remarks with the same meaning ("好的，测试已记录。" / "正在处理你的反馈。" / …), yet
 * each one was composed by the model and then synthesized over the network (0.66–3.53 s per
 * sentence). A short, semantically fixed sentence does not need a per-utterance model wording or a
 * per-utterance synthesis round trip: this table is the wording, and
 * `voice-realtime-tts-cache.ts` pre-synthesizes every entry when the connection opens.
 *
 * WHAT IT DOES NOT CHANGE. The TRIGGER stays the relay's announce gate (a delivered `session_send`
 * whose follow-up text the bridge observes); `voice-realtime-ws-proxy.service.ts` still decides WHEN
 * to speak. Only the sentence's SOURCE changes: the model's text is ignored for `announce` and the
 * connection speaks the next phrase of this table instead.
 *
 * ROTATION, NOT RANDOMNESS. `pickAnnouncePhrase(seq)` is a pure modulo over the table, so the same
 * sequence number always names the same sentence — the criterion can assert the exact frame and the
 * warm cache's key set is deterministic.
 */

/**
 * The announce closing turn's sentence table.
 *
 * INTERJECTION-LENGTH ON PURPOSE. The announce gate carries the "I heard you and I am on it"
 * meaning by itself; the sentence only has to be a human-like acknowledgement, and the shortest one
 * speaks soonest and overlaps the person least. The 2026-10-19 live test asked for exactly that —
 * "可以用更短……单独用语气词，比如说'哦'" — after the 8-character table still occupied 1.44–2.08 s of
 * audio. Every entry is now 1–3 characters, comfortably inside the announce criterion's
 * 15-character budget.
 * Consumed by `voice-realtime-ws-proxy.service.ts` (which picks one per announcement) and by
 * `server/index.ts` (which hands the whole table to the per-connection TTS cache for warm-up).
 */
export const ANNOUNCE_PHRASES: readonly string[] = [
  '哦。',
  '嗯。',
  '好。',
  '收到。',
];

/**
 * The sentence announcement number `seq` speaks.
 *
 * Deterministic and total: the returned string is always one of {@link ANNOUNCE_PHRASES}, and
 * consecutive sequence numbers rotate through the table in order. Negative or non-integer inputs
 * are folded onto the table rather than indexing out of it, so a caller's counter mistake cannot
 * produce `undefined` speech. Consumed by `voice-realtime-ws-proxy.service.ts`.
 */
export function pickAnnouncePhrase(seq: number): string {
  const count = ANNOUNCE_PHRASES.length;
  const safe = Number.isFinite(seq) ? Math.trunc(seq) : 0;
  const index = ((safe % count) + count) % count;
  return ANNOUNCE_PHRASES[index]!;
}
