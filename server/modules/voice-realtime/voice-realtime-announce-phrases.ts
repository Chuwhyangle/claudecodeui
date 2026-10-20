/**
 * The fixed sentences the LIVE VOICE ANNOUNCE closing turn speaks, and the parser that lets a
 * deployment replace the table from `voice-realtime.settings.json`.
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
 * connection speaks the next phrase of the resolved table instead.
 *
 * WHERE THE TABLE COMES FROM (2026-10-20). The compiled-in default below is the shipped table, and
 * `voice-realtime-settings.ts` may replace it per connection with the file's `announcePhrases` key.
 * Both the announce gate and `server/index.ts`'s per-connection TTS cache warm-up read the table
 * through that ONE resolution, so a connection can never speak one table while warming another. The
 * key is deliberately NOT an environment variable: this is the first key of the deployment-knob
 * migration from env into the settings file (see the `turnDetection` precedent).
 *
 * ROTATION, NOT RANDOMNESS. `pickAnnouncePhraseFrom(table, seq)` is a pure modulo over the table, so
 * the same sequence number always names the same sentence — the criterion can assert the exact frame
 * and the warm cache's key set is deterministic.
 */

/**
 * The longest phrase a resolved table may carry, in characters.
 *
 * The announce gate carries the "I heard you and I am on it" meaning by itself, so a phrase only has
 * to be a human-like acknowledgement. The budget is the same 15 characters the announce criterion's
 * own frame check uses; a longer entry would be refused rather than shipped, because the point of
 * this table is to speak soonest and overlap the person least.
 */
export const ANNOUNCE_PHRASE_MAX_CHARS = 15;

/**
 * The fewest phrases a resolved table may carry.
 *
 * A shorter table cannot rotate: three entries are the minimum that makes `pickAnnouncePhraseFrom`'s
 * deterministic cycle observable and keeps one connection from repeating one sentence. A file that
 * names fewer is refused WHOLE (the default table stands) rather than padded.
 */
const ANNOUNCE_PHRASE_MIN_COUNT = 3;

/**
 * The announce closing turn's SHIPPED sentence table, used when no settings file names
 * `announcePhrases`.
 *
 * TWO CHARACTERS OR MORE ON PURPOSE. The 2026-10-19 live test asked for interjection-length phrases
 * ("可以用更短……单独用语气词，比如说'哦'"), but the same capture showed a 1-character interjection cost
 * a synthesis round trip for negligible audio. Every entry here is at least two characters, so the
 * acknowledgement is still short while the utterance is worth speaking.
 * Consumed by `voice-realtime-settings.ts` (as the default of the `announcePhrases` key) and by this
 * module's tests; `server/index.ts` and the proxy read the RESOLVED table, never this constant.
 */
export const ANNOUNCE_PHRASES: readonly string[] = [
  '好的',
  '收到',
  '明白',
  '在办',
];

/**
 * One reading of the `announcePhrases` settings string.
 *
 * `problems` is empty exactly when the file's value was accepted; a non-empty list means `phrases`
 * is the SHIPPED default table, so a caller can log the refusal without deciding what a half-valid
 * table means. Consumers: `voice-realtime-settings.ts` and this module's tests.
 */
export type AnnouncePhraseResolution = {
  /** The table a connection should speak: the file's phrases, or {@link ANNOUNCE_PHRASES}. */
  phrases: readonly string[];
  /** Why the raw value was refused, oldest first. Empty on success. */
  problems: string[];
};

/**
 * Turns a settings file's `announcePhrases` string into the table a connection speaks.
 *
 * The syntax is the one `VOICE_REALTIME_RUN_END_ACK` established: `|`-separated candidates, each
 * trimmed. Empty segments at the two ENDS are dropped — a trailing `|` is a formatting artifact, not
 * a missing sentence — while an empty segment BETWEEN two phrases is refused, because that is a
 * hole where a phrase should be. The result must carry at least {@link ANNOUNCE_PHRASE_MIN_COUNT}
 * phrases, none longer than {@link ANNOUNCE_PHRASE_MAX_CHARS}; any violation returns the shipped
 * table with the reasons in `problems`.
 *
 * Pure and total: a non-string (a number, an object) is a shape error, not a throw. Consumers:
 * `voice-realtime-settings.ts` (the ONLY production caller) and this module's tests.
 */
export function resolveAnnouncePhrases(raw: unknown): AnnouncePhraseResolution {
  if (typeof raw !== 'string') {
    return {
      phrases: ANNOUNCE_PHRASES,
      problems: ['`announcePhrases` must be a `|`-separated string'],
    };
  }

  const segments = raw.split('|').map((segment) => segment.trim());
  // Drop empty segments at the two ends; everything between them is significant.
  let first = 0;
  let last = segments.length;
  while (first < last && segments[first] === '') first += 1;
  while (last > first && segments[last - 1] === '') last -= 1;
  const phrases = segments.slice(first, last);

  const problems: string[] = [];
  if (phrases.length < ANNOUNCE_PHRASE_MIN_COUNT) {
    problems.push(
      `\`announcePhrases\` must name at least ${ANNOUNCE_PHRASE_MIN_COUNT} phrases, got ${phrases.length}`,
    );
  }
  if (phrases.includes('')) {
    problems.push('`announcePhrases` must not contain an empty phrase');
  }
  const tooLong = phrases.filter((phrase) => phrase.length > ANNOUNCE_PHRASE_MAX_CHARS);
  if (tooLong.length > 0) {
    problems.push(
      `\`announcePhrases\` entries must be at most ${ANNOUNCE_PHRASE_MAX_CHARS} characters: ${tooLong.join('、')}`,
    );
  }

  return problems.length > 0 ? { phrases: ANNOUNCE_PHRASES, problems } : { phrases, problems };
}

/**
 * The sentence announcement number `seq` speaks from `phrases`.
 *
 * Deterministic and total: the returned string is always one of `phrases`, and consecutive sequence
 * numbers rotate through the table in order. Negative or non-integer inputs are folded onto the
 * table rather than indexing out of it, so a caller's counter mistake cannot produce `undefined`
 * speech. An empty table (which {@link resolveAnnouncePhrases} never produces) answers `''`, the
 * narrator queue's no-op reading, rather than throwing.
 * Consumed by `voice-realtime-ws-proxy.service.ts` with the connection's resolved table.
 */
export function pickAnnouncePhraseFrom(phrases: readonly string[], seq: number): string {
  if (phrases.length === 0) return '';
  const safe = Number.isFinite(seq) ? Math.trunc(seq) : 0;
  const index = ((safe % phrases.length) + phrases.length) % phrases.length;
  return phrases[index]!;
}

/**
 * The sentence announcement number `seq` speaks from the SHIPPED table.
 *
 * Kept as the default-table reading this module's tests and the cache's default use; production
 * connections go through {@link pickAnnouncePhraseFrom} with the settings-resolved table so a file
 * override is what is spoken. Consumed by this module's tests.
 */
export function pickAnnouncePhrase(seq: number): string {
  return pickAnnouncePhraseFrom(ANNOUNCE_PHRASES, seq);
}
