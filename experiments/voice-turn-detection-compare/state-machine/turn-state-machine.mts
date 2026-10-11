/**
 * Reference implementation of the SPEC's configurable turn state machine
 * (`docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md` §可配置状态机设计).
 *
 * SCOPE — READ THIS FIRST. This is a DESIGN REFERENCE, not runtime code. It is NOT imported by
 * anything under `src/` or `server/`; the SPEC (D5 / 非目标) forbids wiring it in during P0/P0.5.
 * It exists so the transition table in the SPEC can be executed, not merely asserted: the sibling
 * test drives the 「改成三十秒……不对，二十秒」 self-correction sequence through it and fails if the
 * machine ever lets a superseded version reach ACTION_COMMIT.
 *
 * WHAT PROBLEM IT SOLVES. A turn detector decides END/CONTINUE at a candidate silence onset. Two
 * things go wrong if you act on that answer immediately:
 *
 *   1. The speaker resumes inside what looked like a finished turn ("改成三十秒" … pause … "不对，
 *      二十秒"). Committing at the pause sends the SUPERSEDED instruction. The SPEC's answer is a
 *      short `COMMIT_GRACE` window: END does not commit, it starts a timer; only expiry without new
 *      speech commits.
 *   2. Detection is asynchronous, so an answer for an OLD candidate can arrive AFTER the turn has
 *      moved on. Acting on it commits stale content. The SPEC's answer is a monotonic `turnVersion`:
 *      every candidate point and every grace-abort bumps the version, and a result tagged with a
 *      non-current version is VOIDED, never applied. The SPEC calls this out as a real race, not a
 *      hypothetical: `groupBSensitivity.readings` shows the same `atMs` answered twice at two
 *      horizons.
 *
 * THE TRANSITION TABLE (SPEC, verbatim structure):
 *
 *   IDLE         --candidate silence onset--> TURN_PENDING          (issue detection for version v)
 *   TURN_PENDING --END---------------------> COMMIT_GRACE           (deadline = now + graceMs)
 *   TURN_PENDING --CONTINUE----------------> IDLE                   (candidate voided, keep listening)
 *   COMMIT_GRACE --speaker resumes---------> TURN_PENDING, v+1      (pending END voided, speculative
 *                                                                   inference cancelled)
 *   COMMIT_GRACE --deadline reached--------> ACTION_COMMIT          (commit version v's payload)
 *   ACTION_COMMIT--speaker resumes---------> IDLE                   (new round; the committed turn is
 *                                                                   not interrupted — TOOL_LOOP_GUARD
 *                                                                   / merge window handle that, not us)
 *
 * CORRECTION = RETRACTION. The grace-abort edge is, by the SPEC's own framing ("短暂 commit grace
 * window 容许自我纠正"), the moment the speaker revises what the detector had just called finished. So
 * on that edge the text spoken before the candidate is RETRACTED: it moves to `supersededTexts` and
 * the pending utterance restarts from what is said next. That is what makes "the final commit
 * carries the corrected version, not the first one" a property of the machine rather than of the
 * caller's wording. Assembling a well-formed instruction out of the surviving text is the
 * downstream (LLM) layer's job and is out of scope here.
 */

export type TurnState = 'IDLE' | 'TURN_PENDING' | 'COMMIT_GRACE' | 'ACTION_COMMIT';

export type DetectorVerdict = 'END' | 'CONTINUE';

/** A request to the (possibly async) detector. Its `turnVersion` is the version it was issued for. */
export type DetectionRequest = {
  /** Stable id so a late answer can be tied back to the request it answers. */
  id: string;
  turnVersion: number;
  /** The candidate silence onset, in ms. */
  atMs: number;
};

export type CommittedAction = {
  /** The version that survived to ACTION_COMMIT. */
  turnVersion: number;
  atMs: number;
  /** The payload committed — the corrected (post-retraction) utterance text. */
  text: string;
};

/** A detector answer that arrived after its version had moved on; recorded, never applied. */
export type VoidedResult = {
  requestId: string;
  /** The version the request was issued for. */
  issuedVersion: number;
  /** The version the machine was on when the answer arrived. */
  currentVersion: number;
  verdict: DetectorVerdict;
  atMs: number;
  reason: string;
};

export type SpeculativeInference = { turnVersion: number; label: string };

export type TurnStateMachineOptions = {
  /** The COMMIT_GRACE window. SPEC default 900 ms, justified against group B's p90 decision cost. */
  graceMs?: number;
};

const DEFAULT_GRACE_MS = 900;

export class TurnStateMachine {
  readonly graceMs: number;

  #state: TurnState = 'IDLE';
  #turnVersion = 0;
  #requestSeq = 0;
  /** Deadline of the COMMIT_GRACE window, in the caller's clock. */
  #graceDeadlineMs: number | null = null;
  /** The payload of the current turn (post-retraction text). */
  #pendingText = '';
  #supersededTexts: string[] = [];
  #committed: CommittedAction[] = [];
  #voided: VoidedResult[] = [];
  #speculative: SpeculativeInference | null = null;
  /** The request the machine is currently waiting on (set at each candidate point). */
  #outstanding: DetectionRequest | null = null;
  /** The version whose grace window is pending commit (set when END is accepted). */
  #graceVersion: number | null = null;

  constructor(opts: TurnStateMachineOptions = {}) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  }

  get state(): TurnState {
    return this.#state;
  }
  get turnVersion(): number {
    return this.#turnVersion;
  }
  get committed(): readonly CommittedAction[] {
    return this.#committed;
  }
  get voided(): readonly VoidedResult[] {
    return this.#voided;
  }
  get supersededTexts(): readonly string[] {
    return this.#supersededTexts;
  }
  /** The text that will be committed if the current grace window expires. */
  get pendingText(): string {
    return this.#pendingText;
  }
  get speculativeInference(): SpeculativeInference | null {
    return this.#speculative;
  }

  /** A new speech segment began at `atMs` (the speaker is talking again). */
  onSpeechStart(atMs: number): void {
    void atMs;
    if (this.#state === 'COMMIT_GRACE') {
      // The SPEC's correction edge: abort the pending commit, retract the pre-candidate text, bump
      // the version, and cancel any speculative inference that was warming for the dead version.
      this.#supersededTexts.push(this.#pendingText);
      this.#pendingText = '';
      this.#cancelGrace();
      this.#turnVersion += 1;
      this.#state = 'TURN_PENDING';
      return;
    }
    if (this.#state === 'ACTION_COMMIT') {
      // A new turn begins; the already-committed turn is not interrupted (TOOL_LOOP_GUARD territory).
      this.#turnVersion += 1;
      this.#state = 'IDLE';
    }
    // From IDLE / TURN_PENDING a new speech segment is just the speaker continuing: nothing to do.
  }

  /** Text recognised while the speaker is talking. Accumulates onto the current turn's payload. */
  onSpeech(atMs: number, text: string): void {
    void atMs;
    this.#pendingText += text;
  }

  /**
   * A VAD candidate silence onset. Issues the detection request to hand to the detector. Bumping the
   * version here is what makes an earlier, still-in-flight answer stale by construction.
   */
  onCandidatePoint(atMs: number): DetectionRequest {
    this.#turnVersion += 1;
    const request: DetectionRequest = { id: `det-${++this.#requestSeq}`, turnVersion: this.#turnVersion, atMs };
    this.#outstanding = request;
    this.#state = 'TURN_PENDING';
    return request;
  }

  /** The detector answered `request`. A stale (non-current version) answer is voided, never applied. */
  onDetectorResult(request: DetectionRequest, verdict: DetectorVerdict, atMs: number): void {
    if (request.turnVersion !== this.#turnVersion) {
      this.#voided.push({
        requestId: request.id,
        issuedVersion: request.turnVersion,
        currentVersion: this.#turnVersion,
        verdict,
        atMs,
        reason: 'stale result: the turn version advanced (a later candidate point or a grace-abort) before this answer arrived',
      });
      return;
    }
    if (this.#state !== 'TURN_PENDING') {
      this.#voided.push({
        requestId: request.id,
        issuedVersion: request.turnVersion,
        currentVersion: this.#turnVersion,
        verdict,
        atMs,
        reason: `result arrived in state ${this.#state}, not TURN_PENDING — the candidate it answers is no longer the live one`,
      });
      return;
    }
    if (verdict === 'END') {
      this.#state = 'COMMIT_GRACE';
      this.#graceDeadlineMs = atMs + this.graceMs;
      this.#graceVersion = request.turnVersion;
      return;
    }
    // CONTINUE: the pause was within-turn. Void the candidate and keep listening.
    this.#outstanding = null;
    this.#state = 'IDLE';
  }

  /**
   * Speculative inference may be warmed only once END puts the turn into COMMIT_GRACE, and only for
   * the version that owns the window. SPEC's conservative default (open question 4 unresolved): a
   * production build must not do this unless a free "warm-but-discard" path is proven.
   */
  startSpeculative(label: string): boolean {
    if (this.#state !== 'COMMIT_GRACE' || this.#graceVersion === null) return false;
    this.#speculative = { turnVersion: this.#graceVersion, label };
    return true;
  }

  /** Time advanced. Fires ACTION_COMMIT when the grace window expires. */
  onTick(atMs: number): void {
    if (this.#state !== 'COMMIT_GRACE' || this.#graceDeadlineMs === null || this.#graceVersion === null) return;
    if (atMs < this.#graceDeadlineMs) return;
    const version = this.#graceVersion;
    // Re-check the version guard at the last moment: only the live version may commit.
    if (version !== this.#turnVersion) {
      this.#cancelGrace();
      return;
    }
    this.#committed.push({ turnVersion: version, atMs, text: this.#pendingText });
    this.#cancelGrace();
    this.#state = 'ACTION_COMMIT';
  }

  #cancelGrace(): void {
    this.#graceDeadlineMs = null;
    this.#graceVersion = null;
    // Any speculative work was for the version that is no longer committing: dropped, not sent.
    this.#speculative = null;
  }
}
