/**
 * Which heard sentences a relayed message left out — the proxy's check that a `session_send` was
 * answerable for every sentence the person said since the last one (live 2026-10-15 23:02, journal
 * `8fe60310`).
 *
 * WHY THIS EXISTS. When the person pauses mid-thought, the endpoint commits the first piece and
 * transcribes it; the person resumes, and the model's next response — one `session_send` — carries
 * only the last piece. The earlier piece was captioned, so the page showed it, yet it was never
 * delivered and nothing said so. "Every finished sentence is delivered" (ruling 2026-10-14) was only
 * enforced when the model answered in TEXT; a call that quietly left a piece out had no net.
 *
 * WHY AN OVERLAP TEST AND NOT EQUALITY. The model rewrites: it adds spaces, fixes the endpoint's
 * mishearings ("QQ" → "queue") and drops fillers. A sentence is therefore called covered when most
 * of its adjacent-character pairs appear in the message. Pairs rather than single characters because
 * the common function characters of Chinese ("的", "了", "我") are in nearly every message, while a
 * pair like "涉及" is not. The measure is deliberately mechanical and cheap — it decides only
 * whether to ADD the person's own words, verbatim, in front of what the model wrote.
 *
 * RESTORED 2026-10-17, BEHIND A DEFAULT-OFF SWITCH. The ruling of 2026-10-16 removed this measure
 * from the shipping path because it cannot tell a model's rewrite from a model's omission; task
 * `gap-live-voice-span-guard-flag` brings it back only when `VOICE_REALTIME_SPAN_GUARD=on`, so the
 * behaviour can be measured A/B against the shipped one-text-per-segment rule. With the switch off
 * (the default) nothing in this file runs.
 *
 * Used by: `voice-realtime-ws-proxy.service.ts` (the continuous relay's `session_send` guard, with
 * the span-guard switch on).
 */

/** The share of a sentence's character pairs that must appear in the message for it to count as covered. */
const COVERED_PAIR_SHARE = 0.5;

/**
 * The fewest word characters a heard sentence may have and still be judged at all.
 *
 * Below this the endpoint's reading is more often a mishearing of a word the model then repaired
 * ("李的。" for "里的", "瑞士 T S。" for "server.ts" — both in the real session the replay fixture
 * preserves) than a sentence the model dropped, and a mishearing shares no character pair with its
 * repair. Delivering it verbatim would put garbage in front of a correct message. The price is that a
 * genuinely lost sentence this short ("好的。") is not recovered here; the two sentences actually lost
 * live (2026-10-15 23:02) were fifteen and thirty characters.
 */
const MIN_JUDGED_CHARACTERS = 5;

/** Characters that carry no words: punctuation, symbols and whitespace. */
const NON_WORD = /[\p{P}\p{S}\s]+/gu;

/** The adjacent-character pairs of `text`, ignoring case, spacing and punctuation. Empty under two characters. */
function characterPairs(text: string): string[] {
  const characters = Array.from(text.toLowerCase().replace(NON_WORD, ''));
  return pairsOf(characters);
}

function pairsOf(characters: readonly string[]): string[] {
  const pairs: string[] = [];
  for (let index = 0; index + 1 < characters.length; index += 1) {
    pairs.push(`${characters[index]}${characters[index + 1]}`);
  }
  return pairs;
}

/**
 * The sentences in `fragments` that `message` does not cover, in their original order.
 *
 * A fragment under {@link MIN_JUDGED_CHARACTERS} word characters ("嗯。", "李的。") is never reported:
 * it is a filler or a mishearing of something the message already says, and delivering it would only
 * add noise in front of the message.
 */
export function selectUncoveredFragments(fragments: readonly string[], message: string): string[] {
  const inMessage = new Set(characterPairs(message));
  return fragments.filter((fragment) => {
    const characters = Array.from(fragment.toLowerCase().replace(NON_WORD, ''));
    if (characters.length < MIN_JUDGED_CHARACTERS) {
      return false;
    }
    const pairs = pairsOf(characters);
    const shared = pairs.filter((pair) => inMessage.has(pair)).length;
    return shared / pairs.length < COVERED_PAIR_SHARE;
  });
}
