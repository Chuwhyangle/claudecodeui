import type { HostRunActivityReading, VoiceRealtimeOutboundFrame } from './voice-realtime-contract.js';
import { DEFAULT_VOICE_REALTIME_CLOSING_TURN, afterStopSentence, type VoiceRealtimeClosingTurn } from '../frames/voice-realtime-closing-turn.js';

// The relay's instruction text and the connection's independent note composers. Moved out of
// the ws proxy service so the wire handler keeps orchestration, not prompt text.


/**
 * The session instructions the proxy installs once the Realtime connection is up.
 *
 * A RELAY, deliberately. The first version told the model to call `session_send` only for
 * "something to be done" and not "to answer questions you can answer yourself"; measured against
 * the real model that forwarded 7 of 12 test utterances, and the other 5 were answered in a TEXT
 * reply nothing displays — so the user spoke, saw their words transcribed, and then saw nothing
 * (`experiments/voice-realtime-prompt/`). Claude is the one who reasons; this model only carries
 * the words over.
 *
 * Kept here rather than in a UI string table because it is a PROMPT, not copy:
 * it names the function the model must call and the argument the server's
 * whitelist reads back, so it has to agree with `VOICE_REALTIME_TOOLS`' `session_send`
 * schema rather than with anything the browser renders.
 *
 * THE MODEL IS A PEN, NOT AN AGENT (2026-10-14 ruling, journal `e650117b`; replay measured in
 * `experiments/voice-realtime-relay-mode-replay/`). The prompt used to spend a whole paragraph
 * opening a four-way choice for what to do about the work that is running — let it continue by
 * calling no function, add to it, change where it goes, or stop it — and the real model took the
 * first arm literally: while Claude was running it judged that nothing new needed carrying and
 * answered in text, so four utterances from the 2026-10-14 morning session never reached the
 * session. The ruling fixes the role: this model tidies the person's words and passes them on, and
 * whether they are worth passing on is never its call. The paragraph is gone, replaced by one
 * sentence that leaves the model no no-op arm and forbids a text reply. On the three most recent
 * real captures the shipped four-arm prompt produced 31 text replies to the person's speech and
 * lost or materially cut ≈22 message units; the reworded prompt produced 0 of each.
 *
 * THE STOP JUDGEMENT CARRIES NO WORD LIST, and that half predates the ruling. The sentence used to
 * spell out the words that counted as a stop (the list is preserved in SPEC §18.1 F-5; it is
 * deliberately NOT repeated in this file, so the prompt is not one grep away from being a keyword
 * table again), which is a CONDITIONAL MAPPING from words to an abort: it makes the model a matcher
 * rather than a reader, and it fails on exactly the utterance that motivated this — the user asked
 * for the in-flight work to be cancelled without using any of those words, so the model relayed it
 * as ordinary speech and the run kept going (SPEC C-2 forbids the mapping; SPEC §18.1 F-5 records
 * the journal). The exception is stated as the JUDGEMENT it always was: the model reads what the
 * person meant, and a stop is whatever reads that way. The `intent` field is the audit of that
 * reading, so the instructions name it and the reason it is owed (SPEC §6.2).
 *
 * THE INTERRUPT ALWAYS CARRIES THE PERSON'S WORDS (2026-10-14 ruling, Q1). The interrupt stays the
 * model's own judgement, but the call now states their words in `message` and the reading behind
 * the judgement in `intent`; the words are always present, even when all they asked for was the
 * stop. The second live test lost exactly that case — the person asked to interrupt and only the
 * intent reached the CLI (journal `e650117b`). The replay measured the change: interrupts that
 * carried the person's words went 5/6 → 6/6, and the ones that should have interrupted 6/10 →
 * 8/10. The proxy enqueues the carried `message` BEFORE it aborts (`sessionInterrupt`, E10/U2), so
 * the words and the run they correct reach the CLI in the same turn rather than a turn late.
 *
 * THE SEMANTIC WIDENING (SPEC §0.3 D-6, §18.4 G1, GOAL-041 AC-342). The exception names two
 * judgements — "stop", and "correct the direction of what is running" — and a correction travels as
 * the `message` field of the SAME `session_interrupt` call rather than as a second `session_send`.
 * It stays a semantic judgement over what the person meant, so the keyword list that used to sit
 * here must not come back (the negative-control scan in
 * `voice-realtime-instructions-no-stop-words.test.ts` holds that; AC-340 stays green).
 *
 * THE RELIABILITY PASS (2026-10-14 ruling; task `gap-voice-busy-preemption-instruction-reliability`).
 * A word list is not the only way this prompt can make the model a matcher; §1.4 of the proposal
 * measured the SAME sentence judged `session_send` on the live session and `session_interrupt` on
 * replay — "该抢不抢" — and the shape of the failing window is that the wish to stop or redirect
 * arrives wrapped in words the person is ALSO adding (a pause plus a fresh request). The model read
 * the added words as an addition and queued the whole thing behind the run. The clauses kept here
 * are the whole of that reading: the wish is read from the WHOLE utterance rather than from the part
 * that looks like a command, added words are the correction to carry rather than a reason to queue,
 * and one sentence names that exact failure so the model has the mistake in view. It adds no
 * threshold, no duration and no relatedness gate (SPEC D-6 stands): it is instruction text only, and
 * the negative-control scan in `voice-realtime-instructions-no-stop-words.test.ts` still holds it to
 * the same form.
 *
 * AC7 CORRECTED THE WORDING (2026-10-14, task `gap-voice-relay-mode-a-prompt-drop-continue-arm-and-session-status`).
 * The first draft of this text stated the rule without the framing below and the replay's arm B —
 * which replays THIS array — measured 4 text replies to the person's speech on `e650117b`, twice, so
 * not a flake; the experiment's arm A measured 0 on the same capture in the same session. The clauses
 * that close the gap are arm A's: the relay opens by saying it tidies the person's words and passes
 * them on rather than taking part, the pass-on sentence keeps the fragment-joining and the
 * no-paraphrase limit, and the rule ends by naming the only choice the model has as HOW a thing is
 * delivered. With them the same three-capture replay reads 0/0/0 text replies. Nothing was dropped
 * from the reliability pass above.
 *
 * This array is the text the replay's arm B replays verbatim, so the measured prompt and the shipped
 * one are the same bytes.
 */
/**
 * The relay's instructions for one closing-turn mode.
 *
 * ONE SENTENCE MOVES. After a stop the shipped prompt tells the model to "reply with the single word
 * OK"; with no closing turn that request has nowhere to land and the model spends the NEXT
 * utterance's response on it (the first rollback attempt, 2026-10-10: three of five spoken
 * instructions heard and never relayed). So `silent` replaces that sentence and nothing else, and
 * `respond` is the shipped text byte for byte — {@link VOICE_REALTIME_INSTRUCTIONS}.
 *
 * Consumed by `server/index.ts` (the `instructions` seam) and by the criteria.
 */
export function voiceRealtimeInstructionsFor(closingTurn: VoiceRealtimeClosingTurn): string {
  return [
    'You are a voice relay for one Claude Code session: you tidy up what the user says and pass it on.',
    'You are not a participant. You never answer, comment, judge or reason about what was said, and',
    'you never reply in text.',
    'EVERYTHING the user says — instructions, questions, remarks, feedback, acknowledgements,',
    'complaints, even a single word — must be passed on by calling the `session_send` function',
    'with `{ message }`, where message is what the user said, kept in their own words (fix obvious',
    'speech-recognition slips, and join the fragments of one sentence; do not paraphrase, summarise or',
    'add anything). Always call the function; never produce a text reply.',
    'There is no case in which you call no function: deciding that something does not need to be',
    'passed on is never your call. The only choice you make is HOW it is delivered, never whether.',
    'The ONE exception is a stop, or a request to correct the direction of what is running:',
    'judge for yourself whether the user wants the work that is running right now to stop —',
    'or wants it taken a different way — reading what they MEANT rather than looking for any',
    'particular word; there is no list of words to match, and what they said may not look',
    'like a stop at all. Read the WHOLE wish, not the shape of the sentence: a wish for the',
    'running work to stop, or to be taken a different way, is very often wrapped inside new',
    'words the person is adding, and those added words do NOT turn it back into an addition —',
    'they are the correction to carry, not a reason to queue behind the run. When you judge',
    'that they do want it stopped or redirected, call the `session_interrupt` function instead of `session_send`,',
    'with their words in `message` — kept exactly as you would for `session_send`, and always',
    'present, even when all they asked for was the stop — and the reason you read it that way',
    'in `intent`; their words reach the session right after the stop.',
    afterStopSentence(closingTurn),
    ...(closingTurn === 'announce'
      ? [
          'One more exception to the no-reply rule: right after you deliver a `session_send`, say ONE short sentence (in the user’s language, at most 15 words) telling them you are starting — for example “好的，我来查一下”. It reports your action only: never an answer to what they said, never their words repeated, never Claude Code’s output read back. This is the only thing you may ever say aloud; then wait for the user to speak again.',
        ]
      : []),
    'The mistake this exception exists to prevent is relaying such a wish as an ordinary',
    '`session_send`, so it sits in the queue and the running work carries on as if the person',
    'had said nothing — that answer is wrong whenever the person was asking for the running',
    'work to stop or to go somewhere else, however ordinary their words sounded.',
    'The session is fixed by the connection; never name one.',
  ].join(' ');
}

/**
 * The shipped relay instructions as they were measured: the `respond` closing turn. The text the
 * replay's arm B replays verbatim, and the rollback value of `VOICE_REALTIME_CLOSING_TURN`.
 *
 * Consumed by `server/index.ts` (diagnosis path), the settings composer and many criteria. Where the
 * closing turn is switchable the caller uses {@link voiceRealtimeInstructionsFor} instead.
 */
export const VOICE_REALTIME_INSTRUCTIONS = voiceRealtimeInstructionsFor('respond');



/**
 * Composes one host run-activity reading from its two halves: the host's own rounds and the activity
 * store's turn.
 *
 * THE PREFERENCE LIVES HERE, IN ONE PLACE. `roundsBusy` is the resident driver's own account of
 * whether a turn is in flight (`runInFlight`); `turn` is the process-wide activity store's snapshot
 * of the same session, `null` when it holds none. When the driver can answer — `roundsBusy` is a
 * boolean — that answer IS `busy`, and the phase is not consulted; the phase is a REDUCTION of stream
 * traffic that leaves `idle` mid-turn (a tool's execution, the gap after a `tool_result`), and
 * letting it decide is exactly the 2026-10-14 evening defect (a hold released mid-turn, the words
 * dropped into the CLI's own queue). Only when the driver cannot answer (`null` — a per-run session, a
 * host that is gone, a driver with no turn model) does the phase reading decide, which keeps every
 * non-hosted path byte-identical to before this reading existed.
 *
 * `inFlightTool` is ALWAYS the activity store's half — the rounds reading says a turn is in flight,
 * never which tool it is inside — so a `null` turn answers a tool-free reading and so does a turn
 * outside `phase: 'tool'`.
 *
 * `null` for the whole reading is returned only when NEITHER half can speak (`roundsBusy === null &&
 * turn === null`) — the honest "cannot say" the relay reads as "no claim", never as "idle". Consumed
 * by the composition root's `hostRunActivity` (`server/index.ts`), and by the criteria that drive the
 * proxy over the same composition.
 */
export function composeHostRunActivityReading(input: {
  roundsBusy: boolean | null;
  turn: { phase: string; toolName: string | null } | null;
}): HostRunActivityReading | null {
  const { roundsBusy, turn } = input;
  if (roundsBusy === null && turn === null) {
    return null;
  }
  const inFlightTool = turn !== null && turn.phase === 'tool' ? turn.toolName : null;
  if (roundsBusy !== null) {
    return { inFlightTool, busy: roundsBusy, source: 'host-rounds' };
  }
  // Only reachable with a non-null `turn`: the guard above rejected the both-`null` case.
  return { inFlightTool, busy: turn !== null && turn.phase !== 'idle', source: 'turn-phase' };
}

/** Why a model-initiated interrupt does or does not run — the two outcomes the FENCE can produce. */
export type ModelInterruptDecision = 'abort' | 'covered';

/**
 * The interrupt FENCE (SPEC §0.3 D-7 / §18.4 G2, GOAL-041 AC-343): does this model-initiated stop
 * run, or is it the debounce `covered`?
 *
 * THE RULE MOVED to `voice-realtime-trunk-step-handlers.ts` with the `interrupt-decision` step
 * that runs it; it is re-exported above, so the body and its reasoning are one edit away. The
 * decision is what the connection reads back out of that timing's payload.
 */

/**
 * The fixed sentence prepended to the FIRST message that enters the CLI after an interrupt (SPEC §0.3
 * D-8, §18.5; GOAL-041 AC-344).
 *
 * WHY THE MODEL HAS TO BE TOLD. An interrupt ends the run, not its side effects: a `Bash` call that
 * wrote a file or started a background listener is NOT undone by the abort (the 2026-10-12 transcript
 * `c6493eb6` ran `nohup … & disown` and the process outlived the turn). Without a word about it the
 * next turn answers as if the previous one had simply ended, and the model re-runs or contradicts
 * work that is half-done. One sentence, carried by the proxy itself, is what makes the next turn
 * honest — the model is told what stopped, what tool it stopped in, and that the words that follow
 * are the current instruction.
 *
 * TWO FORMS, ONE RULE. With a tool name the sentence names it (`inFlightTool` read from the host's
 * activity record at the stop); with no readable tool it says only that the turn was interrupted and
 * that partial changes may remain — it never invents a tool. The unreadable case is the whole of
 * AC-344's fourth reading, and `null` there is a reading rather than a gap (C-3).
 *
 * WHAT THE SENTENCE MUST NOT SAY. SPEC §11.4 forbids the interruption path from claiming it undid
 * anything: no `revert` / `rollback` / `undo`，no 「撤销」/「回滚」. The words are "may still be
 * present" because that is exactly what the proxy knows — it never inspected the changed state, so
 * it cannot say the changes exist, only that the tool was mid-flight when it was cut off. A criterion
 * asserts the absence of those words on the text that actually entered the CLI.
 */
export function buildInterruptAftermathNote(inFlightTool: string | null): string {
  const head =
    inFlightTool === null
      ? 'The previous turn was interrupted before it finished.'
      : `The previous turn was interrupted while it was running the \`${inFlightTool}\` tool.`;
  // The partial-change sentence follows the SAME split: with no readable tool it must not refer to
  // "that tool", or the tool-free form would point at a tool it never named.
  const partial =
    inFlightTool === null
      ? 'Any partial changes the interrupted turn had already made may still be present.'
      : 'Any partial changes that tool had already made may still be present.';
  return (
    `[${head} ${partial} ` +
    'Everything after this note is your current instruction and takes precedence over any ' +
    'conflicting thing said earlier.]'
  );
}
