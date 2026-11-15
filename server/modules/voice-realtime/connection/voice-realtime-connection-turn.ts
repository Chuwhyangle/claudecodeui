// The connection handler's run-boundary stages: host-queue sampling, the run-end summary and
// the busy quiet window. Split out of `voice-realtime-ws-proxy.service.ts` (2026-11-03).
import { VOICE_MAX_TIMER_DELAY_MS } from "./voice-realtime-exec-status.js";
import { voiceMessageBytes } from '../frames/relay-text.js';
import { DEFAULT_RUN_END_SUMMARY_POLL_MS, DEFAULT_RUN_END_SUMMARY_SETTLE_MS, DEFAULT_RUN_OUTPUT_WAIT_MS, RUN_END_SUMMARY_MAX_VERBATIM_TAIL, readVoiceRealtimeSummaryQuality } from '../frames/run-end-quality.js';
import { VOICE_BUSY_QUIET_CAP_MS, VOICE_BUSY_QUIET_SINCE_PIECE_MS, VOICE_BUSY_QUIET_WINDOW_MS, VOICE_BUSY_RELEASE_PRIORITY, VOICE_REALTIME_BUSY_POLL_MS, VoiceBusyRelease } from '../transport/connection-tuning.js';
import { errorFrame } from "./voice-realtime-transport-errors.js";
import type { HostCommandLifecycleReading, HostQueueReading, VoiceRealtimeRunDigestPatch } from './voice-realtime-contract.js';
import type { VoiceRealtimeConnection } from './voice-realtime-ws-proxy.service.js';



export function installHostQueue(this: VoiceRealtimeConnection): void {


  /**
   * `session_send`, executed immediately — no browser confirmation (AC-316).
   *
   * DashScope's server-side VAD can start a second response (and so a second
   * `session_send` call) before the first real call has returned — AC-308's
   * real trace already proved that race happens. `sending` is a single-flight
   * guard, not a queue: a second call while one is outstanding is refused
   * outright rather than running concurrently against the same bound session
   * (AC-315's protocol-simulation suite regresses this).
   */
  /** True while an instruction is waiting out a busy session — the only state a newer call may join. */
  this.waitingForBusySession = false;

  /** What was said while the first instruction was waiting; delivered with it, in order. */
  this.waitingExtraMessages = [];

  /**
   * Deliveries the bound session's OWN queue accepted (`queued: true`) and has not drained yet.
   *
   * THE RELAY'S OWN GUESS, and it is only used when this connection has no host to ask (see
   * {@link hostQueueSource}). It can only ever grow: once `session_send` resolves with `queued: true`
   * the message is the session's, and nothing here is told when the turn ahead of it ends — the next
   * send's own result is the sole reset (a `queued: false` send could only start its run because
   * everything ahead had drained). Measured 2026-10-12 (SPEC §18.1 F-3): that guess reached 10 while
   * the CLI's real depth peaked at 7 and then fell to 2, so a connection that CAN ask the host does
   * not use this at all.
   */
  this.cliQueuedDeliveries = 0;

  /**
   * The UTF-8 bytes those same `queued: true` deliveries carried, moving with
   * {@link cliQueuedDeliveries} — see that field for when this is read at all.
   */
  this.cliQueuedBytes = 0;

  /** Whether this connection reconciles its CLI term against a host reading. Set once, at construction. */
  this.hostQueueSource = this.seams.hostQueueReading;

  /**
   * The last host sample for the bound session, or `null` when the last read failed.
   *
   * Only meaningful when {@link hostQueueSource} is set: `null` there is UNKNOWN depth, which is a
   * reading of its own — never the relay's own count, and never zero.
   */
  this.hostQueueSample = null;


  /**
   * Samples the host's own queue reading for this connection's bound session.
   *
   * Called at each point the proxy REPORTS a depth — each delivery result, before each status line,
   * after a stop — because those are the only moments a fresh number is shown, and the CLI can drain
   * its queue between any two of them. A missing seam is a no-op; a seam that throws, or answers
   * `null`, leaves {@link hostQueueSample} at `null` so the depth reads as UNKNOWN rather than stale
   * (the failure §18.5 forbids is reusing the last count as if it were current).
   */
  this.refreshHostQueue = (): void => {
    if (this.hostQueueSource === undefined) {
      return;
    }
    try {
      this.hostQueueSample = this.hostQueueSource(this.boundSessionId) ?? null;
    } catch {
      this.hostQueueSample = null;
    }
  };


  /**
   * The aftermath note waiting to ride the next message into the CLI, or `null`.
   *
   * Set by {@link sessionInterrupt} and consumed by {@link deliverSessionSend} when it composes a
   * message — see {@link buildInterruptAftermathNote} for why the turn has to be told at all. One per
   * connection and spent once: a second stop before the next message REPLACES it, because the newest
   * interruption is the one the next message needs to know about.
   *
   * WHICH MESSAGE IT RIDES (ruling 2026-10-16, this task). A stop that CARRIES A CORRECTION arms the
   * note BEFORE the correction is enqueued, so it rides THAT message: the correction is the message
   * the stop's own words go in on, and — per SPEC §18.4 G1 — at the abort the CLI delivers it into
   * the interrupt-closing turn, the very turn the note is about. It is the FIRST message into the CLI
   * after the interruption, which is the property AC-344 asks for, and it is the message whose reader
   * most needs to know ("Everything after this note is your current instruction" is true of the
   * correction and of nothing that was said before it).
   *
   * A stop that carries NO correction has no such message of its own, so the note is armed AFTER the
   * abort and after the backlog release, and rides whatever is delivered next. WHY AFTER THE RELEASE
   * THERE: that release delivers the message the stop did not throw away, which belongs to the turn
   * the stop closed rather than to the turn that follows it (SPEC §18.4: at an abort the CLI delivers
   * everything queued behind the run into the interrupt-closing turn). Attaching the note there would
   * announce an interruption to the very turn it interrupted.
   */
  this.aftermathNote = null;


  /**
   * Whether the MOST RECENT {@link deliverSessionSend} prepended an armed {@link aftermathNote} to
   * the message it handed the CLI — the reading {@link sessionInterrupt} turns into the audit's
   * `noteCarried`.
   *
   * WHY A SEPARATE READING AND NOT "is the note still armed". A correction whose enqueue is not
   * confirmed has the note REVOKED ({@link sessionInterrupt}), which is the same `null` a spent note
   * leaves — the two are different facts and the audit has to tell them apart: "the note went out with
   * this correction and the stop was then refused / found no run" is measurable only if the delivery
   * says so. Written by the ONE place a note is spent, read by the stop that armed it; the caller
   * clears it immediately before its own delivery, and no other delivery can spend the note in
   * between (a second {@link deliverSessionSend} while one is in flight joins or throws — see the
   * single-flight `sending` there — and never reaches the compose step).
   */
  this.lastDeliveryCarriedNote = false;


  /**
   * Reads the tool the run is executing right now, or `null` when that cannot be read.
   *
   * A missing seam, a seam that throws and a `null` reading are ONE answer: the stop records
   * `inFlightTool: null` and the note is the tool-free form. Guessing here would put a tool name into
   * the next turn's instruction that nothing observed, which is the failure C-3 exists to forbid.
   */
  this.readInFlightTool = (): string | null => {
    const source = this.seams.hostRunActivity;
    if (source === undefined) {
      return null;
    }
    try {
      return source(this.boundSessionId)?.inFlightTool ?? null;
    } catch {
      return null;
    }
  };


  /**
   * Whether the bound session has a turn IN FLIGHT — the reading that decides whether the relay holds
   * one merged message or keeps the 1 s coalescing window (ruling 2026-10-14).
   *
   * THREE ANSWERS, AND THE THIRD IS THE IMPORTANT ONE. `true`/`false` are the host saying busy/idle;
   * `null` is no answer at all — no seam, a seam that throws, a `null` reading, or a reading that
   * leaves {@link HostRunActivityReading.busy} out. `null` is NOT false: the relay cannot hold words
   * on a guess about a session it cannot see, and a deployment whose activity record does not speak
   * (or a bare proxy) must keep the behaviour it had before this reading existed. So the caller gates
   * the hold on `=== true` and treats every other answer as "carry on as before".
   */
  this.readRunBusy = (): boolean | null => {
    const source = this.seams.hostRunActivity;
    if (source === undefined) {
      return null;
    }
    try {
      const reading = source(this.boundSessionId);
      return typeof reading?.busy === 'boolean' ? reading.busy : null;
    } catch {
      return null;
    }
  };


  /**
   * Which reading decided {@link readRunBusy}'s last answer, or `null` when there was none.
   *
   * THE AUDIT HALF OF THE SAME READING. A hold's release is the moment the 2026-10-14 evening defect
   * was invisible: the `busy hold released` line said the words were going in, never which reading
   * said the run was over. `'host-rounds'` means the resident driver's own `rounds` FIFO answered;
   * `'turn-phase'` means it could not and the activity phase did (see
   * {@link composeHostRunActivityReading}). Sampled once per release, together with `busy`, so the
   * two fields of the log suffix can never disagree.
   */
  this.sampleRunBusy = (): { busy: boolean | null; source: 'host-rounds' | 'turn-phase' | null } => {
    const source = this.seams.hostRunActivity;
    if (source === undefined) {
      return { busy: null, source: null };
    }
    try {
      const reading = source(this.boundSessionId);
      return {
        busy: typeof reading?.busy === 'boolean' ? reading.busy : null,
        source: reading?.source ?? null,
      };
    } catch {
      return { busy: null, source: null };
    }
  };


  /**
   * The CLI term of the depth and byte readings: the session's own queue, and whether it is known.
   *
   * Three-way on purpose. A connection with NO host source reports its own optimistic count (the
   * pre-seam behaviour, kept for a bare proxy); one with a source whose last read failed reports
   * UNKNOWN, contributing nothing to the numbers and setting `known: false`; one with a live reading
   * reports it verbatim.
   */
  this.cliQueueTerm = (): { known: boolean; items: number; bytes: number } => {
    if (this.hostQueueSource === undefined) {
      return { known: true, items: this.cliQueuedDeliveries, bytes: this.cliQueuedBytes };
    }
    if (this.hostQueueSample === null) {
      return { known: false, items: 0, bytes: 0 };
    }
    return { known: true, items: this.hostQueueSample.items, bytes: this.hostQueueSample.bytes };
  };


  /**
   * The `queuedMessageUuid` a delivery result carries, or `null` when it has none. Read as "a string
   * or nothing": a gateway that reports no uuid leaves the command unjoinable to a later `started`
   * event, and a fabricated key would join the wrong sentence.
   */
  this.queuedMessageUuidOf = (result: unknown): string | null => {
    if (typeof result !== 'object' || result === null) {
      return null;
    }
    const uuid = (result as { queuedMessageUuid?: unknown }).queuedMessageUuid;
    return typeof uuid === 'string' && uuid !== '' ? uuid : null;
  };


  /**
   * Whether a delivery result CONFIRMS the message entered the CLI's OWN queue — the confirmation
   * the enqueue-then-abort half of G1 requires before it lets an abort run (SPEC §18.4 G1, GOAL-041
   * AC-342).
   *
   * `queued: true` is the gateway saying the run in flight took the message into its queue behind
   * it; a `queuedMessageUuid` is the per-command id the fence already keys on, and it stands as a
   * confirmation in its own right. EITHER counts, and nothing else does: a `queued: false` result
   * means the send STARTED A RUN rather than joining one — there was nothing in flight for the
   * correction to correct — and a result carrying neither is a delivery that never reached the
   * queue. Aborting on either would stop the very run the correction had just become.
   */
  this.enqueueConfirmed = (result: unknown): boolean =>
    this.queuedMessageUuidOf(result) !== null ||
    (typeof result === 'object' && result !== null && (result as { queued?: unknown }).queued === true);


  /**
   * Records what command a delivery carried, for the fence's `commandUuid → utteranceSeq` map
   * (SPEC §18.3, GOAL-041 AC-343). The seq is the one STANDING at the delivery — the sentence the
   * model was answering when it relayed this message — so when the host later reports that command
   * `started`, the fence knows which utterance entered the run. No transcription heard yet (`0`)
   * means there is no utterance to name, so nothing is remembered.
   */
  this.rememberDeliveredCommand = (result: unknown): void => {
    const uuid = this.queuedMessageUuidOf(result);
    if (uuid !== null && this.utteranceSeq > 0) {
      this.deliveredSeqByCommandUuid.set(uuid, this.utteranceSeq);
    }
  };


  /**
   * Folds the host's latest `command_lifecycle` `started` reading into {@link coveredSeqs}.
   *
   * The join the fence needs and the relay cannot make alone: the host names the `commandUuid`s it
   * dequeued; this connection maps each back to the utterance its delivery carried. A missing seam is
   * a no-op (the fence then has only its idempotent half); a seam that throws, or answers `null`,
   * adds nothing, so an unreadable lifecycle never looks like "nothing has started".
   */
  this.refreshInterruptCovers = (): void => {
    const source = this.seams.hostCommandLifecycle;
    if (source === undefined) {
      return;
    }
    let reading: HostCommandLifecycleReading | null;
    try {
      reading = source(this.boundSessionId) ?? null;
    } catch {
      return;
    }
    if (reading === null) {
      return;
    }
    for (const uuid of reading.started) {
      const seq = this.deliveredSeqByCommandUuid.get(uuid);
      if (seq !== undefined) {
        this.coveredSeqs.add(seq);
      }
    }
  };


  /**
   * The person's delivered commands the host's queue has NOT yet dequeued — the reconcile set pushed
   * as {@link VoiceRealtimeOutboundFrame} `queue_reconcile`.
   *
   * THE JOIN THE PAGE CANNOT MAKE. This connection's own delivered `commandUuid`s
   * ({@link deliveredSeqByCommandUuid}) minus the host's `started` set: a command the host has taken
   * up (started, or started-then-completed) has left the queue, so it is NOT in this set and the row
   * it backs may clear; one the host still holds IS. A host reading that is absent, `null`, or throws
   * contributes no `started` uuid, so every delivered command reads as still waiting — which KEEPS
   * rows, the safe direction (only the host's own word clears a row, never the relay's silence).
   */
  this.pendingQueueUuids = (): string[] => {
    const started = new Set<string>();
    const source = this.seams.hostCommandLifecycle;
    if (source !== undefined) {
      try {
        const reading = source(this.boundSessionId) ?? null;
        if (reading !== null) {
          for (const uuid of reading.started) {
            started.add(uuid);
          }
        }
      } catch {
        // Unreadable ⇒ no `started` reported ⇒ nothing is cleared. See the doc above.
      }
    }
    const pending: string[] = [];
    for (const uuid of this.deliveredSeqByCommandUuid.keys()) {
      if (!started.has(uuid)) {
        pending.push(uuid);
      }
    }
    return pending;
  };


  /**
   * Pushes the reconcile set to the page. Called at each state change the browser sees anyway — a
   * delivery result, a stop — so the row clears on the NEXT such event when a terminal lifecycle
   * frame was lost (the 2026-10-14 case), rather than needing a timer of its own.
   */
  this.pushQueueReconcile = (): void => {
    const held = this.pendingQueueUuids();
    this.send({ type: 'queue_reconcile', queuedMessageUuids: held });
    this.lastReconcileKey = held.join('\u0000');
    this.armReconcilePoll(held.length > 0);
  };


  /** The held set the page was last told, joined — what the watch below compares a fresh read to. */
  this.lastReconcileKey = '';

  /** The watch on a held command, or `null`. Armed only while the page shows one (see below). */
  this.reconcilePollTimer = null;


  /**
   * While the page draws a held command as its waiting card, re-read the host once per status window
   * and push the set again the moment it moves (live 2026-10-15 86559798: the host took the command up
   * seconds after the stop, and the card stayed for minutes because only the NEXT delivery pushed a
   * reconcile). An unchanged set is not re-sent; an empty one ends the watch.
   */
  this.armReconcilePoll = (watch: boolean): void => {
    if (this.reconcilePollTimer !== null) {
      clearTimeout(this.reconcilePollTimer);
      this.reconcilePollTimer = null;
    }
    if (!watch || this.closed) {
      return;
    }
    this.reconcilePollTimer = setTimeout(() => {
      this.reconcilePollTimer = null;
      if (this.closed) {
        return;
      }
      const held = this.pendingQueueUuids();
      if (held.join('\u0000') !== this.lastReconcileKey) {
        this.pushQueueReconcile();
        return;
      }
      this.armReconcilePoll(true);
    }, this.statusRateMs);
    this.reconcilePollTimer.unref?.();
  };


  /**
   * One RunDigest sample, from execution-plane facts this connection already holds (SPEC §12.5).
   *
   * The fence's own covers first ({@link refreshInterruptCovers}, so the digest and the stop fence
   * can never disagree about what the run has taken up), then the depth the line already shows, then
   * the tool the run is executing. `covers.last` is the LAST covered utterance's words; the line's
   * sanitiser is what keeps them from being the person's words verbatim (§8.4). Every term is a
   * reading of a seam that may answer `null`/throw — the honest "unreadable", never a guess.
   */
  this.sampleRunDigest = (): VoiceRealtimeRunDigestPatch => {
    this.refreshInterruptCovers();
    let lastCoveredSeq = 0;
    for (const seq of this.coveredSeqs) {
      if (seq > lastCoveredSeq) {
        lastCoveredSeq = seq;
      }
    }
    const queued = this.cliQueueTerm();
    return {
      covers: {
        count: this.coveredSeqs.size,
        last: lastCoveredSeq === 0 ? null : (this.utteranceTextBySeq.get(lastCoveredSeq) ?? null),
      },
      queuedNotStarted: { count: queued.known ? queued.items : null, last: this.lastQueuedNotStartedText },
      lastCliActivity: { tool: this.readInFlightTool() },
    };
  };
}

export function installRunEndSummary(this: VoiceRealtimeConnection): void {


  // ---- the narrator's run-end summary (TEXT layer) ---------------------------------------------
  //
  // Gated on the seam: no narrator means no timer, no host sample, no behaviour change. See
  // `VoiceRealtimeProxySeams.runEndSummary` for the contract and the settle wait's purpose.
  this.runEndSummary = this.seams.runEndSummary;

  this.runEndAck = this.seams.runEndAck;

  this.runEndSettleMs = this.runEndSummary?.settleMs ?? DEFAULT_RUN_END_SUMMARY_SETTLE_MS;

  this.runEndOutputWaitMs = this.runEndSummary?.outputWaitMs ?? DEFAULT_RUN_OUTPUT_WAIT_MS;

  this.runEndPollMs = this.runEndSummary?.pollMs ?? DEFAULT_RUN_END_SUMMARY_POLL_MS;

  this.runEndVerbatimTailMax = this.runEndSummary?.verbatimTailMax ?? RUN_END_SUMMARY_MAX_VERBATIM_TAIL;

  /** The open run-end watcher, or `null`. Armed only while the status says a run is live. */
  this.runEndWatchTimer = null;

  /** The open settle wait between a transition and the output request, or `null`. */
  this.runEndSettleTimer = null;

  /** The one `run_output` request outstanding for this connection, or `null`. */
  this.runOutputPending = null;

  /** The wait for that request's answer, or `null`. */
  this.runOutputTimer = null;

  /** Monotonic per connection: every request is named, so a late reply cannot answer a newer ask. */
  this.runOutputSeq = 0;

  /**
   * Bumped by every transition and by teardown, so an ASYNC summarizer that resolves after a newer
   * run ended (or after the connection died) cannot inject a stale summary. `null` of the two is
   * "exactly once per transition" across the one await this machinery has.
   */
  this.runEndGeneration = 0;

  /**
   * The generation whose ack is waiting on the `run_output` gate, or `null`.
   *
   * Set only by a `queued → idle` transition (the queued delivery is not yet evidence of work).
   * {@link summarizeRunOutput} clears and speaks it when the answer is non-empty; a generation
   * comparison keeps a later run's answer from releasing an earlier arm.
   */
  this.runEndAckDeferredGeneration = null;


  /** Drops the settle wait. Idempotent; the summarizer's own generation guard is the other half. */
  this.clearRunEndSettle = (): void => {
    if (this.runEndSettleTimer !== null) {
      clearTimeout(this.runEndSettleTimer);
      this.runEndSettleTimer = null;
    }
  };


  /**
   * Speaks the fixed run-end confirmation, if this deployment wired one.
   *
   * For `running → idle` it is called at the transition, BEFORE the settle timer is armed. For
   * `queued → idle` it is called later, from {@link summarizeRunOutput}, once the page's non-empty
   * `run_output` answer has confirmed the queued message really produced work — hence the optional
   * `runId`: the deferred call would otherwise re-read a reading the settle wait has since moved on
   * from. Deliberately reads nothing but the run id: no context pack, no summarizer, no quality
   * gate — the ack must arrive even when the summary has nothing to say. Absence of the seam is the
   * pre-ack wire.
   */
  this.speakRunEndAck = (runId?: string | null): void => {
    if (this.runEndAck === undefined || this.closed) return;
    const id = runId === undefined ? this.execStatus.reading().runId : runId;
    this.runEndAck.speak({ runId: id });
    this.seams.log?.(`run-end ack run=${id ?? '-'}`);
  };


  /** Drops an outstanding output request and its wait. Idempotent. */
  this.clearRunOutputRequest = (): void => {
    if (this.runOutputTimer !== null) {
      clearTimeout(this.runOutputTimer);
      this.runOutputTimer = null;
    }
    this.runOutputPending = null;
  };


  /**
   * Asks the PAGE for the output THIS run produced — the summary's only source.
   *
   * The turn is rendered by the page at request time from its own transcript, so nothing is
   * cached here and no pack can go stale. `requestId` names the ask; a reply for an older id is
   * ignored, and a page that never answers costs one logged silence.
   */
  this.requestRunOutput = (generation: number, runId: string | null): void => {
    if (this.runEndSummary === undefined || this.closed) return;
    this.clearRunOutputRequest();
    const requestId = `run-output-${(this.runOutputSeq += 1)}`;
    this.runOutputPending = { requestId, generation, runId };
    this.send({ type: 'run_output_request', requestId });
    this.runOutputTimer = setTimeout(() => {
      this.runOutputTimer = null;
      if (this.runOutputPending?.requestId !== requestId) return;
      this.runOutputPending = null;
      // No answer is no evidence of work: a deferred (queued → idle) ack stays unspoken too.
      this.runEndAckDeferredGeneration = null;
      this.seams.log?.(`run-end summary skipped: the page did not answer ${requestId}`);
    }, this.runEndOutputWaitMs);
    this.runOutputTimer.unref?.();
  };


  /**
   * Summarizes exactly the text the page returned for one run, judges the answer, and injects it.
   *
   * THE ACK GATE LIVES HERE for the `queued → idle` arm: a non-empty answer is the "real work"
   * reading, so it releases the deferred ack (before the summary, through the same queue) and an
   * empty one releases nothing. For `running → idle` the ack already spoke at the transition and
   * {@link runEndAckDeferredGeneration} does not name this generation, so this is a no-op there.
   *
   * A summary that breaks the narrator's readings (Markdown glyphs, or the output's own tail read
   * back) is NOT injected — a violation is logged rather than voiced. LENGTH is a reading, not a
   * refusal: `qwen-flash` answers run 42–44 chars and are still plain speech.
   */
  this.summarizeRunOutput = async (
    generation: number,
    runId: string | null,
    output: string,
  ): Promise<void> => {
    if (this.runEndSummary === undefined || this.closed) return;
    const source = output.trim();
    if (source === '') {
      this.seams.log?.('run-end summary skipped: the run produced no visible output');
      // A queued delivery that produced nothing is exactly the false confirmation the gate exists
      // to suppress: no ack either.
      this.runEndAckDeferredGeneration = null;
      return;
    }
    if (this.runEndAckDeferredGeneration === generation) {
      this.runEndAckDeferredGeneration = null;
      this.speakRunEndAck(runId);
    }
    let raw: string | null;
    try {
      raw = await this.runEndSummary.summarize({ output: source, runId });
    } catch (error) {
      this.seams.log?.(
        `run-end summary failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    // A newer run ended (or the connection died) while the side model was thinking: this answer is
    // about a run the person has already moved past. Dropped, not injected late.
    if (generation !== this.runEndGeneration || this.closed) return;
    // ONE line of speech: the model's newlines/indentation are not a spoken structure.
    const text = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (text === '') {
      this.seams.log?.('run-end summary skipped: the narrator returned nothing');
      return;
    }
    const quality = readVoiceRealtimeSummaryQuality(text, source);
    if (quality.markdown.length > 0 || quality.verbatimTail > this.runEndVerbatimTailMax) {
      this.seams.log?.(
        `run-end summary refused: chars=${quality.chars} ` +
          `markdown=[${quality.markdown.join('')}] verbatimTail=${quality.verbatimTail}/${this.runEndVerbatimTailMax}`,
      );
      return;
    }
    this.runEndSummary.inject(text, { runId });
    this.seams.log?.(
      `run-end summary injected chars=${quality.chars} verbatimTail=${quality.verbatimTail} run=${runId ?? '-'}`,
    );
  };


  /**
   * Arms the settle wait for one `non-idle → idle` transition.
   *
   * `deferAck` is set by the `queued → idle` arm: the queued delivery is not yet proof of work, so
   * the ack waits for the page's non-empty `run_output` answer (see {@link summarizeRunOutput}).
   * A pending wait is DROPPED and its generation invalidated: two transitions inside one settle
   * window describe two runs, and only the later one is still what the person is looking at.
   */
  this.scheduleRunEndSummary = ({ deferAck = false }: { deferAck?: boolean } = {}): void => {
    if (this.runEndSummary === undefined) {
      // No summary machinery ⇒ no `run_output` round trip ⇒ no way to prove a queued delivery did
      // real work. A deferred ack therefore stays silent rather than guess; the `running` arm has
      // already spoken at the transition and never reaches here dependent on this seam.
      return;
    }
    if (this.closed) return;
    const generation = (this.runEndGeneration += 1);
    const runId = this.execStatus.reading().runId;
    this.runEndAckDeferredGeneration = deferAck ? generation : null;
    this.clearRunEndSettle();
    this.runEndSettleTimer = setTimeout(() => {
      this.runEndSettleTimer = null;
      this.requestRunOutput(generation, runId);
    }, this.runEndSettleMs);
    this.runEndSettleTimer.unref?.();
  };


  /**
   * Samples the host's activity while a run is believed live; `busy: false` settles the status.
   *
   * The relay is never told a run ended, so this bounded poll is how `running → idle` (and the
   * `queued → idle` edge a drained queue leaves) is observed at all. Only an EXPLICIT `false` ends the run — an absent seam, a throw, a `null` reading or a
   * reading without `busy` all mean "cannot say" and leave the watcher waiting (the same three-way
   * reading the busy hold uses, see `readRunBusy`).
   */
  this.pollRunEnd = (): void => {
    this.runEndWatchTimer = null;
    if (this.closed || this.bridge.state !== 'open') return;
    const current = this.execStatus.reading();
    if (current.phase === 'idle') return;
    if (this.readRunBusy() !== false) {
      this.armRunEndWatch();
      return;
    }
    // The transition itself: `noteStatus` detects the non-idle → idle edge and arms the settle
    // wait (an ack deferred or spoken by which phase it came from), so the stop path and this
    // natural end share one trigger rather than two.
    this.noteStatus({
      phase: 'idle',
      runId: current.runId,
      queuedItems: this.queuedDepth(),
      queuedBytes: this.queuedBytes(),
    });
  };


  /**
   * Arms — or drops — the run-end watcher from the status reading standing now.
   *
   * Idempotent, and called after every status observation so the timer exists exactly while a run is
   * live. A transition to `idle` clears it; a connection torn down clears it (see `teardown`).
   */
  this.armRunEndWatch = (): void => {
    if (this.runEndSummary === undefined || this.seams.hostRunActivity === undefined) return;
    if (this.closed || this.bridge.state !== 'open' || this.execStatus.reading().phase === 'idle') {
      if (this.runEndWatchTimer !== null) {
        clearTimeout(this.runEndWatchTimer);
        this.runEndWatchTimer = null;
      }
      return;
    }
    if (this.runEndWatchTimer !== null) return;
    this.runEndWatchTimer = setTimeout(this.pollRunEnd, this.runEndPollMs);
    this.runEndWatchTimer.unref?.();
  };


  /**
   * Delivers the merged message and empties the buffer.
   *
   * `busyRelease` names WHICH way a busy hold ended, and is `null` for every release that is not one
   * (the 1 s coalescing window, the teardown, the interrupt fold). It decides two things and nothing
   * else: the journal's wording, and — for {@link VoiceBusyRelease} `'quiet-window'` alone — the tier
   * the frame is written under. See {@link VOICE_BUSY_RELEASE_PRIORITY}.
   */
  this.flushCoalesced = (busyRelease: VoiceBusyRelease | null = null): void => {
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    if (this.pendingParts.length === 0) {
      // Nothing to deliver, but the two timers a hold armed and has since been spent are dropped here
      // too — this is the single exit every release runs through (the flush, the stop, the teardown).
      this.clearBusyPoll();
      this.clearBusyQuiet();
      return;
    }
    const engaged = this.busyBufferEngaged;
    const message = this.joinParts(this.pendingParts);
    const extra = this.pendingExtra;
    // What the window's last piece answered, captured when the model relayed it — see
    // `pendingBoundary`. Taken before the buffers are cleared, so the join is delivered with the
    // boundary it was produced against rather than the one standing `coalesceMs` later.
    const boundary = this.pendingBoundary;
    // Only the quiet window's release names a tier. Every other release — including the run ending
    // one — writes the frame exactly as it did before this feature existed, so "which release asked
    // for `next`" stays a property of THIS branch rather than of `flushCoalesced` as a whole.
    const priority = busyRelease === 'quiet-window' ? VOICE_BUSY_RELEASE_PRIORITY : null;
    // The release's own readings, appended AFTER the original wording (which is left byte-for-byte —
    // the journal and the criteria read it): what `busy` said and which source said it, so a mid-turn
    // release (the 2026-10-14 evening defect) can be attributed afterwards instead of guessed at (AC3).
    // Sampled only when a hold is really being released; the coalescing window's line pays nothing.
    let releaseLine = `coalesced ${this.pendingParts.length} relayed piece(s) into one message`;
    if (engaged) {
      const { busy: releaseBusy, source: releaseSource } = this.sampleRunBusy();
      const why = busyRelease === 'quiet-window' ? 'busy quiet window released' : 'busy hold released';
      releaseLine =
        `${why}: delivering the ONE merged message (${this.pendingParts.length} relayed piece(s))` +
        ` busy=${releaseBusy === null ? 'null' : String(releaseBusy)} source=${releaseSource ?? 'null'}` +
        (priority === null ? '' : ` priority=${priority}`);
    }
    this.seams.log?.(releaseLine);
    // Clears `pendingParts`/`pendingExtra`/`pendingBoundary`, drops the hold poll, and takes the card
    // down (the clear frame) when this buffer was the busy hold's. Done BEFORE the delivery so the
    // card is gone by the time `sent` confirms the words landed.
    this.resetHeldBuffer();
    void this.deliverSessionSend({ ...extra, message, ...(priority === null ? {} : { priority }) }, boundary).catch((error: unknown) => {
      // The model has already been told the call was accepted; a late failure surfaces here.
      this.send(
        errorFrame(
          'TOOL_EXECUTION_FAILED',
          `The instruction could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
          true,
        ),
      );
    });
  };


  this.armCoalesce = (): void => {
    // A HELD MESSAGE IS NOT ON THE COALESCING WINDOW'S CLOCK. While the busy hold is engaged the 1 s
    // window must not reopen under it. The caption path below ("the person is still talking: the quiet
    // window starts over") arms this timer on EVERY final transcription, so without this guard an
    // utterance transcribed a moment after a held piece put the hold back on the window's clock and
    // flushed it about a second later — delivering the merged message into the CLI's queue while the
    // session was still busy, which is exactly the mid-turn release the 2026-10-14 evening defect was,
    // reached from the caption side instead of the phase side. A connection with no live hold
    // (`busyBufferEngaged` false — every deployment whose activity record cannot say, and every
    // criterion written before the ruling) is unchanged.
    //
    // THE HOLD HAS ITS OWN CLOCK INSTEAD (X3' replay, 2026-10-15). The busy hold is released by the
    // QUIET WINDOW — the upstream having stopped speaking for {@link VOICE_BUSY_QUIET_WINDOW_MS} —
    // and never by the run ending alone; but that window is armed off the upstream's own turn
    // reporting and the buffer's own pieces (see `armBusyQuietWindow`), never off `coalesceMs`. So a
    // caption re-arms the HOLD's window here rather than the coalescing one: same guard, two clocks.
    if (this.busyBufferEngaged) {
      this.armBusyQuietWindow();
      return;
    }
    if (this.pendingParts.length === 0) return;
    if (this.coalesceTimer !== null) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = setTimeout(this.flushCoalesced, this.coalesceMs);
    this.coalesceTimer.unref?.();
  };
}

export function installBusyWindow(this: VoiceRealtimeConnection): void {


  // ---- the ONE merged pending message (ruling 2026-10-14) -----------------------------------
  //
  // WHAT THIS IS FOR. Until this ruling a sentence spoken while Claude was busy became a command in
  // the CLI's own queue the moment the model relayed it, and the CLI merged those commands into one
  // only at the turn boundary — so the page drew one row per sentence and the person watched a stack
  // of them (the 2026-10-14 morning reading: two registries disagreeing and a row that would not go).
  // Under this ruling the merge happens HERE, one layer earlier: while the session is busy every
  // relayed piece joins the SAME buffer, nothing reaches the CLI until the run ends, and the whole
  // thing goes in as ONE message. The buffer is the proxy's, not the page's — the page is only told
  // what it says (the `pending` frame), and the person gets ONE read-only card instead of a stack.
  //
  // WHY THE HOST'S `busy` READING GATES IT. `readRunBusy()` answering `true` is a CLAIM the host makes
  // about a turn in flight; every other answer (no seam, a throw, a `null`, a reading without `busy`)
  // leaves the relay exactly as it was. So a deployment whose activity record cannot say, and every
  // criterion written before this ruling, keep the 1 s coalescing window and the delivery into the
  // CLI's queue — and this connection never speaks a `pending` frame.
  /** How often a held message re-reads the host; see {@link VoiceRealtimeProxySeams.busyPollMs}. */
  this.busyPollMs = this.seams.busyPollMs ?? VOICE_REALTIME_BUSY_POLL_MS;

  /** The busy hold's own three numbers; see {@link VoiceRealtimeProxySeams.busyQuietWindowMs}. */
  this.busyQuietWindowMs = this.seams.busyQuietWindowMs ?? VOICE_BUSY_QUIET_WINDOW_MS;

  this.busyQuietSincePieceMs = this.seams.busyQuietSincePieceMs ?? VOICE_BUSY_QUIET_SINCE_PIECE_MS;

  this.busyQuietCapMs = this.seams.busyQuietCapMs ?? VOICE_BUSY_QUIET_CAP_MS;

  /** The open hold poll, or `null`. Armed only while {@link pendingParts} is non-empty. */
  this.busyPollTimer = null;

  /** The open quiet-window timer, or `null`. The other way a hold ends; see `armBusyQuietWindow`. */
  this.busyQuietTimer = null;

  /**
   * When the FIRST piece of the hold now in progress joined the buffer, or `null` when nothing is
   * held. {@link VOICE_BUSY_QUIET_CAP_MS} is counted from here, so a person who talked over the whole
   * window cannot push the release out with every new piece.
   */
  this.busyWindowOpenedAt = null;

  /**
   * When the LAST piece joined the buffer, or `null` when nothing is held. The floor under the quiet
   * window ({@link VOICE_BUSY_QUIET_SINCE_PIECE_MS}) is counted from here: a piece relayed into an
   * already-quiet session must still be given the merge window the 1 s coalescing path would give it.
   */
  this.lastBusyPieceAt = null;

  /**
   * Whether the UPSTREAM's own turn is open — `speech_started` seen, no `speech_stopped`/commit
   * since (`onUpstreamTurn`). This is the relay's reading of "the person is still talking", and the
   * quiet window is only allowed to release while it is `false`.
   */
  this.upstreamTalking = false;

  /**
   * When the upstream last CLOSED its turn, or `null` if it has not done so since this connection
   * opened. The window's {@link VOICE_BUSY_QUIET_WINDOW_MS} is counted from here.
   *
   * `null` is load-bearing: an endpoint that has never reported a closed turn gives the quiet window
   * nothing to count from, so the hold then waits for the run to end (what `pollBusy` alone did) or
   * for the cap — never for a quiet that was never observed.
   */
  this.lastUpstreamSilenceAt = null;

  /**
   * Whether this connection is HOLDING a merged message for a busy session — which is also the
   * question "does this connection speak the `pending` frame at all?".
   *
   * Set the first time the busy branch below puts a piece in the buffer and cleared wherever the
   * buffer is spent. It is what keeps the two waits apart: the 1 s coalescing window announces
   * itself with `queued` and is unchanged by this feature, and only a hold emits `pending`.
   */
  this.busyBufferEngaged = false;


  /** Tells the browser what the held message says right now (one frame per change; AC1/AC2). */
  this.emitPending = (): void => {
    if (this.closed) return;
    const text = this.joinParts(this.pendingParts);
    this.send({ type: 'pending', text, bytes: voiceMessageBytes(text) });
  };


  /** Drops the hold poll. Idempotent, and safe to call when none is armed. */
  this.clearBusyPoll = (): void => {
    if (this.busyPollTimer !== null) {
      clearTimeout(this.busyPollTimer);
      this.busyPollTimer = null;
    }
  };


  /** Drops the quiet window's timer. Idempotent, and safe to call when none is armed. */
  this.clearBusyQuiet = (): void => {
    if (this.busyQuietTimer !== null) {
      clearTimeout(this.busyQuietTimer);
      this.busyQuietTimer = null;
    }
  };


  /**
   * The instant the held message is due to leave on the quiet window, from the readings standing
   * right now — `null` when this connection has no quiet window at all (both numbers non-positive).
   *
   * THE REPLAY'S OWN ARITHMETIC (`experiments/voice-now-priority/x3-replay.mts`, the D arm):
   * `due = max(lastPiece + 800, lastStop + 2000)`, capped at `buf[0] + 20_000`, and released only
   * while the person is NOT talking. Every term is a reading this side already has: the last piece's
   * arrival (`lastBusyPieceAt`), the last turn close (`lastUpstreamSilenceAt`, from `onUpstreamTurn`)
   * and the hold's first piece (`busyWindowOpenedAt`). While the upstream's turn is OPEN — or has
   * never closed — only the cap applies, so "still talking" can never be read as "quiet".
   *
   * The cap is applied with `Math.min`, so the window can only ever pull the release EARLIER than the
   * cap; an upstream quiet longer than the cap releases at the cap, not later.
   */
  this.busyQuietDueAt = (now: number): number | null => {
    if (this.busyQuietWindowMs <= 0 && this.busyQuietCapMs <= 0) {
      return null;
    }
    const capDue = (this.busyWindowOpenedAt ?? now) + this.busyQuietCapMs;
    if (this.busyQuietCapMs <= 0) {
      // The cap is switched off; the window alone decides, and only once the upstream has gone quiet.
      return !this.upstreamTalking && this.lastUpstreamSilenceAt !== null
        ? Math.max((this.lastBusyPieceAt ?? now) + this.busyQuietSincePieceMs, this.lastUpstreamSilenceAt + this.busyQuietWindowMs)
        : Number.POSITIVE_INFINITY;
    }
    if (this.upstreamTalking || this.lastUpstreamSilenceAt === null || this.busyQuietWindowMs <= 0) {
      return capDue;
    }
    return Math.min(
      capDue,
      Math.max((this.lastBusyPieceAt ?? now) + this.busyQuietSincePieceMs, this.lastUpstreamSilenceAt + this.busyQuietWindowMs),
    );
  };


  /**
   * Arms — or drops — the quiet window's release timer from the readings standing now.
   *
   * Called from the three places a term of {@link busyQuietDueAt} can change: the upstream closing
   * its turn, the upstream opening it again, a piece joining the hold, and the caption path's own
   * re-arm (see `armCoalesce`). It is idempotent — re-arming with unchanged readings computes the
   * same deadline — so being called more often than strictly necessary costs a timer, never a release.
   */
  this.armBusyQuietWindow = (): void => {
    this.clearBusyQuiet();
    if (!this.busyBufferEngaged || this.closed || this.bridge.state !== 'open') {
      return;
    }
    const due = this.busyQuietDueAt(Date.now());
    if (due === null) {
      return;
    }
    // `setTimeout` wraps a delay past 2^31-1 ms back to 1 ms, so a window configured "infinite" (the
    // AC's false form) is clamped to the ceiling rather than fired immediately.
    const delay = Math.min(Math.max(0, due - Date.now()), VOICE_MAX_TIMER_DELAY_MS);
    this.busyQuietTimer = setTimeout(this.releaseBusyQuiet, delay);
    this.busyQuietTimer.unref?.();
  };


  /**
   * The quiet window's deadline arrived. Releases the hold, or re-arms when the deadline moved under
   * the timer — the SAME re-judgement `pollBusy` makes of `busy`, done here against the window's own
   * three readings so a piece that arrived (or speech that resumed) after the timer was armed is not
   * flushed under.
   */
  this.releaseBusyQuiet = (): void => {
    this.busyQuietTimer = null;
    if (!this.busyBufferEngaged || this.closed || this.bridge.state !== 'open') {
      return;
    }
    const now = Date.now();
    const due = this.busyQuietDueAt(now);
    if (due === null) {
      return;
    }
    if (now < due) {
      const delay = Math.min(due - now, VOICE_MAX_TIMER_DELAY_MS);
      this.busyQuietTimer = setTimeout(this.releaseBusyQuiet, delay);
      this.busyQuietTimer.unref?.();
      return;
    }
    this.flushCoalesced('quiet-window');
  };


  /**
   * Empties the held message: the parts, their extra/boundary, the poll, and — when a hold was
   * actually shown — the `pending{text:''}` frame that takes the card down.
   *
   * The ONE reset every way of spending the buffer goes through (the flush, the interrupt fold, the
   * teardown), so the state and the page can never disagree about whether something is held.
   */
  this.resetHeldBuffer = (): void => {
    this.clearBusyPoll();
    this.clearBusyQuiet();
    const wasEngaged = this.busyBufferEngaged;
    this.pendingParts = [];
    this.pendingExtra = {};
    this.pendingBoundary = null;
    this.busyBufferEngaged = false;
    // The hold's own two stamps belong to the hold that just ended: the next one opens its own window
    // from its own first piece, and carrying these over would let a spent window's cap release a hold
    // that had only just begun.
    this.busyWindowOpenedAt = null;
    this.lastBusyPieceAt = null;
    if (wasEngaged && !this.closed) {
      this.send({ type: 'pending', text: '', bytes: 0 });
    }
  };


  /**
   * Arms — or drops — the hold poll. Called each time the buffer changes, so the poll exists exactly
   * while something is held and the connection is live.
   */
  this.armBusyPoll = (): void => {
    if (this.busyPollMs <= 0 || this.closed || this.bridge.state !== 'open' || this.pendingParts.length === 0) {
      this.clearBusyPoll();
      return;
    }
    if (this.busyPollTimer !== null) {
      return;
    }
    this.busyPollTimer = setTimeout(this.pollBusy, this.busyPollMs);
    this.busyPollTimer.unref?.();
  };


  /**
   * One hold sample: has the run ended? If it has, the whole merged message goes in NOW.
   *
   * FAIL-OPEN ON AN UNREADABLE HOST, deliberately: only an explicit `true` keeps the hold, and a
   * reading that stopped answering (`null`) releases it just as `false` does. Words delivered a
   * moment late are recoverable; words held until the person gives up and leaves are not.
   */
  this.pollBusy = (): void => {
    this.busyPollTimer = null;
    if (this.closed || this.bridge.state !== 'open' || this.pendingParts.length === 0) {
      return;
    }
    if (this.readRunBusy() === true) {
      this.armBusyPoll();
      return;
    }
    this.flushCoalesced();
  };


  /**
   * The answer a relayed call gets when it will NOT become a message: the raw text carried nothing,
   * the segment it belonged to was transcribed as silence, or the connection is already gone.
   *
   * Said as "handled", never as "reached the session": the model must not re-call, and it must not
   * be told a falsehood it could act on. The wording is the same shape as the other replies so the
   * model's single behaviour — reply `OK` and stop — stays one instruction rather than three.
   */
  this.handledWithoutDelivery = (): unknown => ({
    accepted: true,
    instruction: `The message was accepted and has already been handled. Do not call session_send again for it. ${this.acceptedTail}`,
  });


  /**
   * Records that a relayed instruction did NOT reach the session, with why.
   *
   * The journal line is the point of this call: the 2026-10-11 defect ended with a segment's reply
   * arriving after the browser had gone and simply vanishing, leaving the operator unable to tell
   * "dropped on purpose" from "never happened". `voice-realtime-log.ts` recognises the line, so the
   * absence is a recorded outcome rather than a gap in the record.
   */
  this.noteNotDelivered = (reason: string): void => {
    this.seams.log?.(`session_send not-delivered (${reason})`);
  };


  /**
   * Answers one segment `dropped` — the ONE place that verdict is sent, so a segment can never be
   * answered twice however many ways the app learns it produced nothing.
   *
   * Two facts answer a segment this way, and they reach here from opposite directions: the endpoint
   * reporting ZERO words for it ({@link markSegmentEmpty}, from a transcription), and the endpoint
   * REFUSING its commit (`onSegmentCommitRejected`, from an error). Both mean the same thing to the
   * page — this segment produced no words — so they share a frame type and differ in `reason`.
   */
  this.answerSegmentDropped = (seq: number, reason: 'empty-transcript' | 'commit-refused'): void => {
    if (this.emptiedSegmentSeqs.has(seq)) {
      return;
    }
    this.emptiedSegmentSeqs.add(seq);
    this.send({ type: 'segment_ack', seq, state: 'dropped', reason });
  };


  /** Answers one segment as refused because the endpoint reported no words for it (once per seq). */
  this.markSegmentEmpty = (seq: number): void => {
    if (this.emptiedSegmentSeqs.has(seq)) {
      return;
    }
    this.seams.log?.(`segment ${seq} dropped: the endpoint reported no words for it`);
    this.answerSegmentDropped(seq, 'empty-transcript');
  };
}