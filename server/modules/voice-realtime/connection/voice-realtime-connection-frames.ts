// The connection handler's frame and turn-dispatch stages: setup, execution status, the
// transcript bridge, relay delivery, the interrupt fence and the inbound-frame routing. Split out
// of `voice-realtime-ws-proxy.service.ts` (2026-11-03 god-package split); the class there owns the
// state and calls these installers in order.
import { truncateRenderedVoiceContext } from "@shared/voice/voiceContextTruncation.js";
import { VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN, VOICE_REALTIME_STATUS_RATE_MS, createVoiceRealtimeExecStatus, runIdOf } from "./voice-realtime-exec-status.js";
import { buildInterruptAftermathNote } from "./voice-realtime-instructions.js";
import { createVoiceRealtimeNarratorQueue } from "./voice-realtime-narrator-queue.js";
import { readOmissionFillParams } from '../frames/omission-fill-params.js';
import { EMPTY_RELAY_TEXT, SEGMENT_TRANSCRIPT_GRACE_MS, VOICE_QUEUE_FULL_REASON, VOICE_REALTIME_CONTEXT_MAX_CHARS, normalizeRelayText, relayRestatesDelivery, voiceMessageBytes } from '../frames/relay-text.js';
import { clearVoiceSessionActive, markVoiceSessionActive } from "../frames/voice-realtime-active.js";
import { DEFAULT_VOICE_REALTIME_CLOSING_TURN, DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL, acceptedResultTail } from '../frames/voice-realtime-closing-turn.js';
import { applyVoiceRealtimeTransport, describeVoiceRealtimeMode, resolveVoiceRealtimeMode } from '../frames/voice-realtime-mode.js';
import { planOmissionFills } from '../frames/voice-realtime-omission-fill.js';
import type { OmissionFill, OmissionFillExecuted, OmissionFillFinal, OmissionFillParams } from '../frames/voice-realtime-omission-fill.js';
import { voiceRealtimeToolsFor } from '../frames/voice-realtime-tools.js';
import { BUSY_RETRY_INTERVAL_MS, BUSY_RETRY_MAX_MS, VOICE_BUSY_RELEASE_PRIORITY } from '../transport/connection-tuning.js';
import { resolveSegmentSelection } from "../frames/segment-selection.js";
import { errorFrame } from "./voice-realtime-transport-errors.js";
import { createLocalSpeechGate } from '../transport/voice-realtime-local-speech.js';
import type { LocalSpeechBoundary } from '../transport/voice-realtime-local-speech.js';
import { createSilenceTailGate } from '../transport/voice-realtime-silence-tail.js';
import { describeSilenceDurationSource, describeTurnDetection, resolveTurnDetection } from '../transport/voice-realtime-turn-detection.js';
import { VOICE_QUEUE_MAX_BYTES } from './voice-realtime-contract.js';
import type { VoiceRealtimeExecStatusPatch, VoiceRealtimeNarratorQueue, VoiceRealtimeOutboundFrame } from './voice-realtime-contract.js';
import { createDefaultVoiceRealtimeFrameRegistry } from './voice-realtime-frame-handlers.js';
import type { VoiceRealtimeFrameConnectionState, VoiceRealtimeFrameContext } from './voice-realtime-frame-registry.js';
import { composeVoiceRealtimeInstructions, loadVoiceRealtimeSettings, resolveContextPackRuntimeSettings } from './voice-realtime-settings.js';
import { createSpeakerWindowAccumulator } from '../core/voice-realtime-speaker-seam.js';
import type { SpeakerWindowAccumulator } from '../core/voice-realtime-speaker-seam.js';
import { createDefaultVoiceRealtimeTrunkSteps } from './voice-realtime-trunk-step-handlers.js';
import type { VoiceRealtimeTrunkPayloads, VoiceRealtimeTrunkTiming } from './voice-realtime-trunk-steps.js';
import type { VoiceRealtimeConnection } from './voice-realtime-ws-proxy.service.js';



export function installConnectionSetup(this: VoiceRealtimeConnection): void {

  // THE CONNECTION IS ESTABLISHED HERE, so this is where the dispatch hook is turned on for the
  // session: the browser is in Live Voice, and the next prompt that session submits should be told
  // to schedule rather than to work in the foreground. Balanced by the three exits below — the
  // teardown, the raw socket `close`, and the transport-construction failure — because an entry left
  // behind by any one of them keeps injecting rules into a session nobody is talking to.
  markVoiceSessionActive(this.boundSessionId);


  // The tool result's closing sentence, chosen once per connection from the same value that names the
  // transport's declared `respondToToolOutputs` intent and the prompt (see
  // `VoiceRealtimeProxySeams.closingTurn`).
  this.acceptedTail = acceptedResultTail(this.seams.closingTurn ?? DEFAULT_VOICE_REALTIME_CLOSING_TURN);

  this.advertisedTools = voiceRealtimeToolsFor(this.seams.slimSendTool ?? DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL);


  this.send = (frame: VoiceRealtimeOutboundFrame): void => {
    // One line per outbound frame, EXCEPT non-final captions and `tts_audio` slices: the audio
    // frames are a STREAM (one bounded slice each), and a journal line per slice would bury the
    // utterance-level readings that matter — `narrator speak`, `tts_done` and `tts_error`.
    if (frame.type === 'caption' ? frame.final : frame.type !== 'tts_audio') {
      this.seams.log?.(
        `to-browser ${frame.type}${frame.type === 'state' ? ` ${frame.state}` : ''}${
          frame.type === 'error' ? ` ${frame.code}${frame.recoverable === true ? ' (recoverable)' : ''}: ${frame.message}` : ''
        }${frame.type === 'caption' ? ` ${JSON.stringify(frame.text)}` : ''}${
          frame.type === 'queued' || frame.type === 'refused' || frame.type === 'stopped' ? ` depth=${frame.depth}` : ''
        }${frame.type === 'queue_reconcile' ? ` held=${frame.queuedMessageUuids.length}` : ''}${
          frame.type === 'narrator_speak' || frame.type === 'narrator_stop' ? ` utterance=${frame.utteranceId}` : ''
        }`,
      );
    }
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  };


  this.sending = false;

  this.closed = false;

  this.audioFramesFromBrowser = 0;


  // ---- the connection's trunk step table -------------------------------------------------------
  //
  // THE LIFECYCLE'S REGISTRATION SLOT. Everything below that happens at a FIXED moment of this
  // connection's life — the upstream handshake settling, the parse in front of every inbound frame,
  // the interrupt fence, an instruction going upstream, the capture's last words on the way out —
  // is a step in an ordered table (see `voice-realtime-trunk-steps.ts`) rather than another branch
  // here. A fresh table per connection, exactly like the frame registry: the shipped steps come
  // from `voice-realtime-trunk-step-handlers.ts`, a criterion hands in its own.
  //
  // The context is built at RUN time, not here, because `teardown` and `uplinkVad` are initialised
  // further down this function and a step never runs before the connection is fully assembled.
  this.trunkSteps = this.seams.trunkSteps ?? createDefaultVoiceRealtimeTrunkSteps();

  // The context object's `uplinkVad` accessor needs the CONNECTION's field, not its own property:
  // inside an object-literal getter `this` is the context object, so an arrow closure reads the
  // connection without aliasing `this`.
  const readConnectionUplinkVad = (): VoiceRealtimeConnection['uplinkVad'] => this.uplinkVad;
  this.runTrunk = <TTiming extends VoiceRealtimeTrunkTiming>(
    timing: TTiming,
    payload: VoiceRealtimeTrunkPayloads[TTiming],
  ): void => {
    this.trunkSteps.run(timing, {
      timing,
      seams: this.seams,
      send: this.send,
      bridge: this.bridge,
      teardown: () => this.teardown(),
      advertiseInstructions: () => this.advertiseInstructions(),
      get uplinkVad() {
        return readConnectionUplinkVad();
      },
      payload,
    });
  };


  // ---- the narrator's queue (GOAL-047; see `createVoiceRealtimeNarratorQueue`) ------------------
  //
  // Built over THIS connection's downlink, and only when a narrator is wired: with no seam there is
  // no queue, no hook and no change to the wire. The composition root receives the queue through
  // `attach` and its producer (run-end summary, TTS) enqueues text into it.
  this.narratorQueue = this.seams.narrator === undefined
      ? null
      : createVoiceRealtimeNarratorQueue({
          send: this.send,
          log: this.seams.log,
          // The connection's own TTS send. Absent keeps the queue on the text-only wire every
          // pre-TTS criterion was written against.
          ...(this.seams.narrator.tts === undefined ? {} : { tts: this.seams.narrator.tts }),
        });

  if (this.narratorQueue !== null) {
    this.seams.narrator?.attach?.(this.narratorQueue);
  }

  /** The narrator's own utterance-id counter, so the announce remark's `narrator_speak` id is unique. */
  this.announceNarrationSeq = 0;

  /** The EARLY announce's own id family, spoken when the endpoint says the person stopped. */
  this.earlyAnnounceSeq = 0;

  /**
   * Whether this turn still owes an early announce.
   *
   * The endpoint reports the close TWICE — `speech_stopped` and then `committed` — so a naive hook
   * would say "好的" twice for one utterance. Armed at `speech_started`, spent at the first close.
   */
  this.earlyAnnounceArmed = false;

  /** When the last early announce was spoken, so the model's closing turn does not repeat it. */
  this.lastEarlyAnnounceAt = null;

  /**
   * How long after an early announce the model's closing-turn remark is suppressed.
   *
   * The two say the same thing ("I'm starting"). The live 2026-10-21 reading put the closing turn
   * about 0.9 s after `speech_stopped`; the early announce lands there instead, so within this
   * window the closing turn would be a second "好的" for the same utterance.
   */
  this.EARLY_ANNOUNCE_SUPPRESS_MS = 3_000;

  /** The counter for a MODEL TEXT REPLY's narration, kept separate so its ids never collide with an announce's. */
  this.modelReplyNarrationSeq = 0;

  /** The duplex rule's switch. Omitted means enabled — the shipped behaviour. */
  this.narratorInterruptsOnUserSpeech = this.seams.narrator?.interruptOnUserSpeech ?? true;

  /**
   * Whether the COARSE local gate may interrupt the narrator. Omitted means no — see
   * {@link VoiceRealtimeNarratorSeams.narratorInterruptsOnLocalSpeech} for the live capture that
   * made ambient noise mute five announcements in a row.
   */
  this.narratorInterruptsOnLocalSpeech = this.seams.narrator?.narratorInterruptsOnLocalSpeech ?? false;


  /**
   * The person opened their mouth: a narration must not talk over them.
   *
   * Called from the two paths that report a PRECISE new-utterance boundary — the endpoint's own
   * `speech_started` and the browser's `segment_start` — because the two transports see the same
   * fact at different moments and the earliest one wins. NOT called from the local speech gate: its
   * boundary is an energy reading that answers the watchdog's question ("has speech been seen at
   * all?"), not "is this person speaking now", and on the 2026-10-19 capture ambient noise opened it
   * five times while a narration played. Idempotent: a queue with nothing playing and nothing
   * queued drops 0 and sends nothing.
   */
  this.noteUserSpokeForNarrator = (): void => {
    if (this.narratorQueue !== null && this.narratorInterruptsOnUserSpeech) {
      this.narratorQueue.interrupt('user-spoke');
    }
  };


  /**
   * Where the person's utterance began and ended, as heard on THIS side of the wire. One per
   * connection, because a boundary is a transition and the state must not outlive the audio it
   * describes — see `transport/voice-realtime-local-speech.ts`.
   */
  this.localSpeechGate = createLocalSpeechGate();

  /**
   * Hands a local boundary to the bridge, whose stall watchdog is otherwise armed only by the
   * endpoint's own `speech_started`. Deliberately silent on `null`: most frames close no boundary.
   *
   * THE NARRATOR IS NOT STOPPED HERE. This gate is the watchdog's reading and only that: it is
   * documented as coarse on purpose, and its boundary fires on loud non-speech (measured 2026-10-19:
   * RMS 300–470 ambient noise against 1000–10000 speech). Interrupting playback on that reading
   * cleared five complete announcements in one live connection. `narratorInterruptsOnLocalSpeech`
   * exists only so the criterion can re-wire the old behaviour as its false form.
   */
  this.reportLocalSpeechBoundary = (boundary: LocalSpeechBoundary | null): void => {
    if (boundary === 'started') {
      if (this.narratorInterruptsOnLocalSpeech) {
        this.noteUserSpokeForNarrator();
      }
      this.bridge.noteLocalUtteranceStart();
      return;
    }
    if (boundary === 'ended') {
      this.bridge.noteLocalUtteranceEnd();
    }
  };


  // ---- the segmented path: which seq a delivery belongs to, and what was already delivered ----
  //
  // The upstream can be made to repeat a committed segment: the socket drops after the
  // commit and before the response, and the bridge writes that segment once more onto the
  // new one. The MODEL may then call `session_send` a second time for words the session was
  // already given — which, left alone, puts one thought in the conversation twice. So every
  // delivery is attributed to the segment that was in flight, and a delivery that arrives
  // while a segment is being REPLAYED is dropped if that segment already produced one.
  // Dropping it here (and answering the model as though it landed) is what keeps the
  // session at exactly one message.
  // ---- the C2 context pack: what the session was told about the conversation ----
  //
  // Read ONCE, here, and this connection keeps this reading for its whole life: an edit to the
  // settings file reaches the NEXT connection and leaves live ones alone (the criterion reads this
  // as "a new connection gets the new template, an existing one is unaffected").
  //
  // The composition root has already taken this connection's reading for the spend guard, and hands
  // it over as `seams.settings`; using it (rather than reading the file again) is what keeps the
  // cap, the prompt and the pack budget from describing two different file revisions. A criterion
  // that builds the connection itself passes no reading, so the historical per-connection load is
  // the fallback.
  this.settings = this.seams.settings ?? loadVoiceRealtimeSettings({ baseInstructions: this.seams.instructions, settingsPath: this.seams.settingsPath });

  if (this.settings.problems.length > 0) {
    this.seams.log?.(`settings: using the built-in prompt — ${this.settings.problems.join('; ')}`);
  }

  // THE CONTEXT PACK'S EFFECTIVE SIZE FOR THIS CONNECTION: `environment > settings file > default`,
  // resolved once from the same reading. The server-side truncation below and the browser's builder
  // read the same numbers; a pack that arrives larger than this (an older client, a hand-written
  // frame) is trimmed to the newest rows instead of being handed to the model whole.
  this.contextPackRuntime = resolveContextPackRuntimeSettings(process.env, this.settings.contextPack, this.settings.source);

  for (const problem of this.contextPackRuntime.problems) {
    this.seams.log?.(`contextPack: ${problem} — the next source applies`);
  }

  // THE DETECTOR THIS CONNECTION WILL USE, resolved ONCE here so the line below and the gate built further
  // down cannot disagree about it. The line fires only when the SETTINGS FILE named a parameter — the edit
  // an operator is watching for ("I changed the file; did it take?") — and it names the SOURCE, so a value
  // the environment or a diagnosis override won cannot be mistaken for the file's. A deployment that
  // configured nothing still reads no line about a detector it never asked about.
  this.turnDetection = resolveTurnDetection(process.env, {}, this.settings.turnDetection);

  if (Object.keys(this.settings.turnDetection).length > 0) {
    const settingsTurnDetectionNote = describeTurnDetection(
      this.turnDetection,
      describeSilenceDurationSource(process.env, {}, this.settings.turnDetection),
    );
    if (settingsTurnDetectionNote !== null) {
      this.seams.log?.(settingsTurnDetectionNote);
    }
  }

  // ---- the omission-fill producer's parameters (GOAL-046) --------------------------------------
  //
  // The shipped values come from the JSON module beside this file — they travel with the build, so
  // the producer is on in a deployment that has no `experiments/` tree. The settings file's
  // `omissionFill` override (validated there, read once per connection) is applied next, then the
  // seam's partial, so a criterion can shrink one window without inventing the others. The readings
  // go into the journal before any candidate is judged: a replayed journal cannot be checked
  // without them.
  //
  // `seams.omissionFillParams === null` is the criterion-only "not this connection" switch. A
  // malformed shipped block is recorded and leaves the producer off — never guessed.
  this.shippedOmissionFill = readOmissionFillParams();

  this.omissionFillParams = this.seams.omissionFillParams === null
      ? null
      : this.shippedOmissionFill.params === null
        ? null
        : {
            ...this.shippedOmissionFill.params,
            ...(this.settings.omissionFill ?? {}),
            ...(this.seams.omissionFillParams ?? {}),
          };

  if (this.omissionFillParams === null) {
    this.seams.log?.(
      `omission_fill disabled (${
        this.seams.omissionFillParams === null ? 'seam' : this.shippedOmissionFill.problem ?? 'no parameters'
      })`,
    );
  } else {
    this.seams.log?.(`omission_fill params ${JSON.stringify(this.omissionFillParams)}`);
  }
}

export function installConnectionStatus(this: VoiceRealtimeConnection): void {

  /** The pack this connection was sent, or `''` before it arrives (and for a session with nothing said). */
  this.contextText = '';

  this.contextChars = 0;

  this.contextRows = 0;

  /** The (context, status) pair already advertised, so a repeated compose is not a second `session.update`. */
  this.advertisedKey = null;


  // ---- S-A: the execution-status line, folded into this connection's instructions (SPEC §8.3) ----
  //
  // ONE aggregator per connection, driven only by events this proxy already sees: a `session_send`
  // result, a coalescing window opening, a stop. Its reading is the single source the line is
  // rendered from, so the line and any other reader can never disagree (AC6).
  this.execStatus = createVoiceRealtimeExecStatus();

  this.statusRateMs = this.seams.statusRateMs ?? VOICE_REALTIME_STATUS_RATE_MS;

  /** Status lines this run has put on the wire. The cap is on THIS, not on how many changes there were. */
  this.statusInjectionsThisRun = 0;

  /** Distinct dedup keys this run has observed — what the last line's `(+N more)` counts the gap from. */
  this.statusChangesThisRun = 0;

  /** Set once the run's last line has gone out: no further status line until a new run begins. */
  this.statusCapReached = false;

  /** The marker the NEXT line must carry. Set only for the cap notice, cleared as it is sent. */
  this.statusMarker = null;

  /** The open rate window. A change inside it updates the reading but arms nothing second (coalesce). */
  this.statusTimer = null;


  /**
   * Folds one observation in and, when the dedup key moved, opens the rate window.
   *
   * The dedup gate is SPEC §8.3's: a change that leaves the key `(phase, runId, queuedItems,
   * queuedBytes, pendingInteraction.requestId)` where it was is NOT a change, and nothing is sent.
   * A new run resets the per-run counters, which is what makes the cap a property of a run rather
   * than of the connection.
   */
  this.noteStatus = (patch: VoiceRealtimeExecStatusPatch): void => {
    // The phase BEFORE this observation — the run-end transition below is a comparison of two
    // readings, not a second interpretation of the patch.
    const beforePhase = this.execStatus.reading().phase;
    // `queuedKnown` is always written from the current term, so a reading that fell out of a host
    // source says so. The host is sampled by the CALLER before it computes the depth this patch
    // carries (a delivery result, a stop), so the numbers and this flag describe one sample.
    const { changed, newRun } = this.execStatus.update({ ...patch, queuedKnown: this.cliQueueTerm().known });
    // The content-level RunDigest rides BESIDE the change (SPEC §12.5): sampled here, where the run's
    // facts are as current as the line that is about to carry them, and folded OUTSIDE the dedup key
    // so a digest that moves with nothing else does not put a line of its own on the wire (§8.3).
    this.execStatus.update({ digest: this.sampleRunDigest() });
    // The turn-boundary refresh rides every status change: while the status says a run is live, the
    // host is polled once per S-A window so a drain no event announces is still seen (see
    // `hostQueueTurnBoundaryRefresh`). A patch that settles the run drops the poll instead.
    this.armDrainPoll();
    if (newRun) {
      // A new run supersedes any summary still waiting out its settle window: the person has moved
      // on, and that summary describes work the new run has already replaced. Bumping the generation
      // also voids a summarizer call that is already in flight.
      this.runEndGeneration += 1;
      this.clearRunEndSettle();
      // The request (if any) belonged to the run that just got superseded: its answer must not be
      // summarized as if it described the new run.
      this.clearRunOutputRequest();
      this.statusInjectionsThisRun = 0;
      this.statusChangesThisRun = 0;
      this.statusCapReached = false;
      this.statusMarker = null;
    }
    // THE NARRATOR'S TRIGGER: ANY non-idle → idle transition. Initial `idle` never matches, a change
    // that stays within a phase never matches, and `running → queued` (a follow-up superseding the
    // run) is not an end. The stop path and the host watcher both fold their end through this one
    // comparison.
    //
    // `queued → idle` is a real end too (2026-10-26): a burst of short messages leaves the status at
    // `queued`, and a queued message can be drained straight to `idle` with no `running` observation
    // in between — the old `running`-only trigger dropped the ack AND the summary for that whole
    // burst. But a queued delivery is not itself proof of work: the host may have coalesced it away
    // without ever producing a turn, and acking that would be a false confirmation. So on that arm
    // the ack is DEFERRED to the settle wait's `run_output` answer, and only a non-empty answer —
    // the same "real work" reading the summary uses — lets it speak (see `summarizeRunOutput`).
    if (beforePhase !== 'idle' && this.execStatus.reading().phase === 'idle') {
      if (beforePhase === 'queued') {
        // The ack and the summary share the output gate: no output ⇒ neither speaks.
        this.scheduleRunEndSummary({ deferAck: true });
      } else {
        // The ack goes FIRST — at the transition, before the settle timer — and is independent of
        // the summary (see `VoiceRealtimeRunEndAckSeam`). The summary then follows through the same
        // queue. `running` is itself evidence of work, so this arm needs no output gate.
        this.speakRunEndAck();
        this.scheduleRunEndSummary();
      }
    }
    // The host watcher exists exactly while a run is believed live; `pollRunEnd` folds its end back
    // through this same function, so arming it is part of every observation rather than a caller's
    // duty.
    this.armRunEndWatch();
    if (!changed) {
      return;
    }
    this.statusChangesThisRun += 1;
    if (this.statusTimer === null) {
      // No window is open, so this change opens one. A change that arrives while one IS open only
      // updates the reading the window will render — nothing is armed a second time, and nothing is
      // queued behind it, which is what makes a burst coalesce to its latest state (SPEC §8.3).
      this.statusTimer = setTimeout(this.flushStatus, this.statusRateMs);
      this.statusTimer.unref();
    }
  };


  /**
   * Pushes the composed instructions onto the upstream session.
   *
   * Guarded on `bridge.state`, not called-and-hoped: `sendSessionUpdate` throws on a transport that
   * is not open, and the pack can arrive either side of the upstream handshake — the browser sends
   * it the moment its socket opens, which is usually well before the upstream is up. When the
   * bridge is not open this is a no-op and the `whenConnected` path below applies it instead.
   *
   * Returns whether a frame actually went out — the status bookkeeping below counts on that and must
   * not spend a slot on a compose that the dedup (or a closed bridge) swallowed.
   */
  this.advertiseInstructions = (): boolean => {
    if (this.bridge.state !== 'open') {
      return false;
    }
    const status = this.execStatus.render(Date.now(), this.statusMarker ?? undefined);
    const key = `${status.key}\u0000${this.contextText}`;
    if (this.advertisedKey === key) {
      return false;
    }
    this.advertisedKey = key;
    // THE INJECTION ITSELF IS A TRUNK STEP (`status-injection`): this function composes what goes
    // upstream, the table's step puts it on the wire. A `session.update` that does not leave leaves
    // `sent` false, and the caller's bookkeeping reads that rather than assuming the send happened.
    const injection: VoiceRealtimeTrunkPayloads['status-injection'] = {
      instructions: composeVoiceRealtimeInstructions(
        this.settings,
        this.contextText,
        status.text === '' ? undefined : status.text,
      ),
      sent: false,
    };
    this.runTrunk('status-injection', injection);
    if (!injection.sent) {
      return false;
    }
    if (this.contextText !== '') {
      // What was injected, by size and provenance — never the body: this log goes to the server's
      // console, and the body is the user's conversation (SPEC §C2).
      this.seams.log?.(
        `context injected chars=${this.contextChars} rows=${this.contextRows} template=${this.settings.source}${
          this.settings.version === null ? '' : ` version=${this.settings.version}`
        }`,
      );
    }
    if (status.text !== '') {
      // Safe to log whole: §8.4 forbids the line from carrying a body, a path or the user's words,
      // and `voiceStatusField` is what enforces that. The reading is handed out here, beside the
      // send, so a criterion can prove the line and the reading are one source (AC6).
      this.seams.log?.(
        `status injected seq=${status.reading.statusSeq} phase=${status.reading.phase} queued=${status.reading.queuedItems}/${status.reading.queuedBytes}B ageMs=${Math.max(0, Date.now() - status.reading.at)}${
          this.statusMarker === null ? '' : ` more=${this.statusMarker.more}`
        }`,
      );
      this.seams.onExecStatus?.(status.reading);
    }
    this.statusMarker = null;
    return true;
  };


  /**
   * The end of one rate window: put the LATEST reading on the wire, once.
   *
   * The last line of a run carries the `(+N more)` marker and shuts the run down — the cap is on
   * INJECTIONS, so a burst that coalesced into one line has spent one slot, not five.
   */
  this.flushStatus = (): void => {
    this.statusTimer = null;
    if (this.closed || this.bridge.state !== 'open' || this.statusCapReached || !this.execStatus.hasState()) {
      return;
    }
    // Reconcile at the INJECTION, not only when the change was folded in: the CLI can drain its own
    // queue between the event that armed this window and the moment the line goes out, and §18.5's
    // "回合边界深度误差 = 0" is judged on what the line says. This updates the aggregator's stored
    // queued fields from a fresh sample; it arms nothing (only `noteStatus` opens a window), so a
    // drain noticed here is simply the reading this one line carries.
    this.refreshHostQueue();
    this.execStatus.update({
      queuedItems: this.queuedDepth(),
      queuedBytes: this.queuedBytes(),
      queuedKnown: this.cliQueueTerm().known,
    });
    const last = this.statusInjectionsThisRun >= VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN - 1;
    if (last) {
      this.statusMarker = { more: Math.max(1, this.statusChangesThisRun - this.statusInjectionsThisRun) };
    }
    if (this.advertiseInstructions()) {
      this.statusInjectionsThisRun += 1;
      if (last) {
        this.statusCapReached = true;
      }
    }
    this.statusMarker = null;
  };


  this.segmentCommitMode = resolveSegmentSelection(this.seams).mode;


  // ---- the P4 rollout switch: does this connection declare the segmented relay? ------------------
  //
  // Read ONCE per connection, like the settings above: a live connection keeps the answer it was
  // opened with, so flipping the environment variable affects the NEXT connection and leaves the one
  // already in progress alone. When the caller passed no seam, this resolves the shipped default —
  // the same {@link resolveVoiceRealtimeMode} `server/index.ts` calls at the assembly point — and
  // reports a misconfigured variable here, where there is a log sink to report it to. A per-connection
  // transport choice (`seams.transport`) overrides the environment for THIS connection only.
  this.modeResolution = applyVoiceRealtimeTransport(
    resolveVoiceRealtimeMode(process.env),
    this.seams.transport ?? null,
  );

  if (this.seams.segmentedRelay === undefined) {
    const modeNote = describeVoiceRealtimeMode(this.modeResolution);
    if (modeNote !== null) {
      this.seams.log?.(modeNote);
    }
  }

  this.segmentedRelay = this.seams.segmentedRelay ?? (this.modeResolution.mode === 'segmented');

  // ---- Silence Tail Suppression (decision doc §10): the continuous wire's upload state machine ----
  //
  // Built ONCE per connection and only when the deployment asked for it, so an STS-off connection
  // never allocates the state machine and the branch below is byte-identical to before this existed
  // (§10.4 S-6). `segmentedRelay` is read here rather than at the use site because a connection that
  // declares the segmented relay never carries bare `audio` frames at all, and building a gate for it
  // would be state that can never run.
  this.silenceTailOptions = this.seams.silenceTail === undefined || this.segmentedRelay ? null : this.seams.silenceTail;

  this.silenceTail = this.silenceTailOptions === null ? null : createSilenceTailGate(this.silenceTailOptions);

  // ---- Speaker tracking (Phase 1 SHADOW): the read-only speaker observer ----
  //
  // ABSENT IS THE SHIPPED STATE, and it is the only state that matters for byte-neutrality: with no
  // `speakerTracker` seam the accumulator is `null` and the audio branch below is the branch it was
  // before this feature existed. When a seam IS present the accumulator sees a decoded COPY of every
  // audio frame on ARRIVAL — before any gate decides what crosses — and hands completed 2 s windows to
  // the seam. Nothing here can withhold a frame: the forward calls on every path are untouched.
  this.speakerWindows = this.seams.speakerTracker === undefined ? null : createSpeakerWindowAccumulator();

  /** One line if the shadow reader throws, so a broken embedder cannot flood the connection's log. */
  this.speakerObserveFailureLogged = false;
}

export function installTranscriptBridge(this: VoiceRealtimeConnection): void {

  /** The segment a delivery arriving now belongs to, or `null` outside any segment. */
  this.activeSegmentSeq = null;

  /** Whether that segment is being replayed onto a NEW upstream socket. */
  this.activeSegmentIsReplay = false;

  /** Segments that have already produced one delivered message. */
  this.deliveredSegmentSeqs = new Set<number>();


  // ---- continuous mode's duplicate guard: one spoken sentence is one message ----
  //
  // THE DEFECT THIS CLOSES. The endpoint's server-side VAD commits an utterance when the user stops
  // speaking and the model relays it as `session_send`; but the model can then re-issue the SAME
  // call with no new audio behind it — nudged by the tool-resume `response.create`, or by the
  // upstream starting a response on its own. The call ids are fresh, the segmented replay gate above
  // never fires (continuous mode carries no `seq`), and the per-utterance cap is nowhere near, so
  // one sentence was delivered into the session three times (journal 57279cc1, 2026-10-11,
  // 15:40:00 / 15:40:16 / 15:40:33 — the last two with `audioTokens=259`, i.e. no new input audio).
  //
  // THE COUNTER is "user utterances the upstream has begun and not yet accounted for by an accepted
  // delivery". A NEW utterance is signalled two ways and BOTH count — the endpoint's
  // `input_audio_buffer.committed` (through {@link RealtimeBridgeHooks.onUserAudioCommitted}: the
  // proxy cannot see the event itself, the bridge tolerates it) and a FINAL transcription
  // (`onCaption` below — the very signal the bridge uses to end its own per-utterance tool-loop
  // count, `MAX_CALLS_PER_UTTERANCE`). Counting the commit ALONE is not enough: a producer that
  // announces an utterance by its transcript with no `committed` the proxy observed — the scripted
  // stand-in `voice-realtime-status-injection.test.ts` drives its turns exactly that way — would have
  // every genuine repeat swallowed as an echo. The guard only ever reads the count for "== 0", so
  // counting both is strictly safer than either and never masks a phantom (which carries neither).
  // RESET to 0 the moment a call passes every gate and is accepted, NOT at the `flushCoalesced`
  // moment: an utterance that lands INSIDE the 1 s window then belongs to the NEXT one instead of
  // being erased by the flush.
  this.unforwardedUserUtterances = 0;

  /**
   * The L3 `utteranceSeq` (SPEC §10.3 / C-3): a MONOTONE count of the NON-EMPTY final transcriptions
   * this connection has heard, starting at 0 and never reset. A stop's audit record names the value
   * it stood at when the model decided to stop, which is what turns "the model stopped a run" into
   * "the model stopped the run it had just heard *this* utterance for" — the reading C-3's "误停可
   * 审计" needs and the one nothing else on this connection carries (the `stopped` frame counts the
   * backlog, the L3 aggregator counts state CHANGES as `statusSeq`, and neither says which utterance
   * the judgement was made on).
   *
   * AN EMPTY FINAL TRANSCRIPTION DOES NOT ADVANCE IT. The endpoint closing a segment with zero words
   * is not an utterance — it is the endpoint saying nobody spoke — so counting it would let a cough,
   * a door, or a silent segment push `triggerSeq` past the words the model actually answered. It is
   * the same reading `EMPTY_RELAY_TEXT` already makes for the relay guard, applied to the count.
   */
  this.utteranceSeq = 0;

  /**
   * The FENCE's `commandUuid → utteranceSeq` map (SPEC §18.3, GOAL-041 AC-343): what each command
   * the host acknowledged carried, so a `command_lifecycle` `started` event can be turned back into
   * the utterance it dequeued. Filled from the delivery result's `queuedMessageUuid` paired with the
   * `utteranceSeq` standing at the delivery.
   */
  this.deliveredSeqByCommandUuid = new Map<string, number>();

  /**
   * The utterance seqs whose command the host reported `started` — the CURRENT run's `covers`
   * (SPEC §18.3 R-4.3). Accumulated from {@link HostCommandLifecycleReading}, never from a message
   * id this proxy chose. Monotone within a connection, which is what lets the fence compare a
   * `max` against the trigger rather than track run boundaries.
   */
  this.coveredSeqs = new Set<number>();

  /**
   * The text each non-empty utterance carried, keyed by its `utteranceSeq` — what the RunDigest's
   * `covers.last` reads. Filled beside the `utteranceSeq += 1` that mints the key (in `onCaption`),
   * so a covered seq always resolves to the words it stood for; the SANITIZER, not this map, is what
   * keeps those words off the line (see {@link voiceDigestField}).
   */
  this.utteranceTextBySeq = new Map<number, string>();

  /**
   * The last message the session took into its OWN queue (`queued: true`) and has not begun — the
   * RunDigest's `queuedNotStarted.last`. Cleared when a delivery STARTS a run (`queued: false`), the
   * one moment the queue ahead of it is provably drained; `null` when nothing is waiting.
   */
  this.lastQueuedNotStartedText = null;

  /**
   * The endpoint's per-ITEM empty reading on the CONTINUOUS wire, keyed by `item_id`. In continuous
   * mode there is no segment to key the empty guard on (`seq` is `null`), so the guard keys on the
   * item the transcript is ABOUT instead — the one thing the endpoint says that survives the
   * reordering (§10 "按条目自身空转写判定").
   */
  this.itemTranscriptEmpty = new Map<string, boolean>();

  /**
   * The words of each item in {@link transcribedSinceWatermark}, keyed by `item_id` — what the relay
   * delivers verbatim when the model ends a turn in text with those items still unanswered (see the
   * `MODEL_TEXT_REPLY` branch of `onError`). Kept per item like {@link itemTranscriptEmpty}.
   */
  this.itemTranscriptText = new Map<string, string>();

  /**
   * THE CONTINUOUS WIRE'S FORWARDING WATERMARK, read as the SPAN a relay arriving now answers for.
   *
   * The ids in {@link transcribedSinceWatermark}, oldest first, are exactly the FINAL transcriptions
   * that have landed SINCE the last call this guard decided on — so at the moment a relay is judged,
   * "everything transcribed after the watermark" IS this array, and draining it is advancing the
   * watermark. Held that way the watermark needs no number of its own and the array cannot grow with
   * the connection's age.
   *
   * WHY THE SPAN AND NOT THE LAST ITEM (journal `b5d01c21`, 2026-10-13 23:57 CST, the defect this
   * replaced). The model routinely answers SEVERAL of the endpoint's items with ONE `session_send` —
   * here the person's sentence, the fragment after it, and the 0.37 s sliver the endpoint split off
   * behind both — and the merged call's words are the ones that had text. Judged against the LAST
   * item alone, that call was refused whenever the last item happened to be the empty sliver, and the
   * whole sentence was lost. The interval is the honest scope: a call is answerable for exactly the
   * transcriptions that landed since the last call it answered for.
   *
   * ONLY THE TWO VERDICTS BELOW DRAIN IT. A call the wire TRUNCATED never reaches this file at all —
   * the bridge reports it (`TRUNCATED_BY_TURN` for the endpoint's own `turn_detected` cancellation,
   * `MALFORMED_FUNCTION_CALL` when no such cancellation arrives) before any executor runs — so the items
   * transcribed before it are still in the span when the model re-sends the same content, and the
   * re-send's interval covers them. That is the reading the model's own re-send depends on, and it is
   * why nothing here is drained by an error.
   *
   * APPENDED FOR THE CONTINUOUS WIRE ONLY. The segmented wire's guard is keyed by `seq` and never
   * reads this, so appending there would be footprint with no reader.
   */
  this.transcribedSinceWatermark = [];

  /**
   * The id of the last user item the endpoint COMMITTED on this connection — the watermark a delivery
   * reports as "the model had seen at least this far when this instruction was relayed".
   *
   * WHY A COMMIT AND NOT A TRANSCRIPT. A `committed` is the moment the endpoint created the input
   * item, which is the moment it enters the model's conversation; the transcription is a separate,
   * slower read of that same item. The page needs the CONVERSATION boundary (what the model could
   * have acted on), not the display boundary, so this is the earlier and the righter of the two.
   *
   * Consumed by the `sent` frame's `coveredThroughItemId`, which is how a browser attributes the
   * sentences it spoke to the delivery that answered them — see the client's claim step. Without it
   * the page has only the relayed TEXT to match against, and a model that rewords or omits one of
   * several sentences it answered in one call leaves the other on screen as never-delivered.
   */
  this.lastCommittedUserItemId = null;

  /**
   * The items the endpoint has COMMITTED but not yet transcribed, in commit order.
   *
   * The two upstream events are independent: a `committed` creates the input item, and its
   * transcription lands later (sometimes seconds later, and out of order across items). A model
   * response can therefore be produced BEFORE the transcription of the sentence it answers arrives.
   * Without this set, the late transcript would look unanswered and the `MODEL_TEXT_REPLY` net
   * would deliver it verbatim — a duplicate of a sentence the model already carried. See
   * {@link claimOutstandingCommits}.
   */
  this.committedPendingTranscription = new Set<string>();

  /**
   * The committed items a model response has already answered for, waiting for their transcription.
   * A final transcription for one of these is CONSUMED by the response: it is recorded (the digest
   * and the transcript view still read it) and it does not join {@link transcribedSinceWatermark} —
   * so the `MODEL_TEXT_REPLY` net cannot deliver it again. The omission planner still sees it: the
   * rule's coverage question is answered from the executed messages, not from this set.
   */
  this.committedCoveredByResponse = new Set<string>();

  /**
   * Whether any FINAL transcription has landed on this connection. Once it has, the watermark owns
   * the duplicate question: a model response arriving with no new speech since the last accepted
   * delivery is a restatement of a span that is already delivered, and is refused by the watermark
   * rather than by comparing its words. A connection that has never heard a final keeps the
   * pre-watermark behaviour (every call is its own delivery), which is what keeps fixture
   * connections that drive `session_send` directly working unchanged.
   */
  this.finalTranscriptHeard = false;

  /**
   * A monotonic count of "the person said something" events — every `input_audio_buffer.committed`
   * and every final transcription. It is the watermark's clock: a delivery records the epoch it was
   * accepted at, and a model response arriving at the SAME epoch carried no new speech, so the span
   * it would deliver is already in the session.
   *
   * A COMMIT COUNTS, NOT ONLY A TRANSCRIPTION. The endpoint creates the input item at the commit and
   * transcribes it later, sometimes seconds later; a person who speaks and whose transcription is
   * still in flight has really said something, and the model's late forward of those words is a
   * delivery, not an echo (journal `f6166468`). Counting only finals would drop it — the dropped-input
   * class this task exists to close, reached from the other side.
   */
  this.speechEpoch = 0;

  /** The `speechEpoch` the last accepted delivery consumed. See {@link speechEpoch}. */
  this.deliveredEpoch = 0;

  /**
   * The normalized text of the last few accepted deliveries, newest last — the window a no-new-speech
   * call is checked against for RESTATEMENT.
   *
   * WHY A WINDOW AND NOT JUST THE LAST DELIVERY. A span can be delivered verbatim (by the
   * `MODEL_TEXT_REPLY` net or an omission fill) BEFORE the model's response for it arrives (the
   * response lost the race and is a restatement of the endpoint's own words). The last delivery may already be the NEXT span, so
   * comparing only against it would let the earlier sentence through a second time — the active
   * duplicate this task closes. A bounded window keeps that comparison local without keeping the
   * whole conversation.
   *
   * WHY THE RESTATEMENT TEST IS STILL NEEDED AT ALL, given the watermark. The watermark answers "is
   * there a new span?"; it does NOT answer "are these words already in the session?". A call with no
   * new speech can still be the FIRST delivery of words nobody has (the interrupt's next message —
   * the person spoke, the model answered, and the transcription has not landed yet; journal
   * `b33412ea`'s late forward). Refusing those on the watermark alone loses real input, which is the
   * class this task exists to stop. So the rule is: no new span AND a restatement of something
   * recently delivered ⇒ echo; anything that adds words is a delivery.
   */
  this.recentDeliveredTexts = [];

  /**
   * The omission-fill rule's in-memory inputs (GOAL-046): every final transcription `F_i`, every
   * EXECUTED model message `M_k`, and the endpoint's `speech_started` times.
   *
   * THE PLAN IS RECOMPUTED FROM THESE, NEVER INCREMENTALLY. The rule's decision time `T_i` depends
   * on messages that had not arrived when the final did, and the silence branch depends on whether
   * the user speaks again inside `S`; incrementally patching a plan would be a second implementation
   * of §3. The arrays stay small for a voice connection (one entry per final / executed response),
   * and the pure planner is cheap.
   */
  this.omissionFinals = [];

  this.omissionExecuted = [];

  this.omissionSpeechStarts = [];

  /**
   * Item id → the index of that item's final in {@link omissionFinals}. The `MODEL_TEXT_REPLY` net
   * already delivers some finals verbatim; mapping back to the index is what lets it CLOSE the
   * planner's candidate, so the rule does not deliver the same sentence a second time.
   */
  this.omissionIndexByItemId = new Map<string, number>();

  /**
   * The indices whose disposition is final: filled, or skipped for a recorded reason. An item is
   * decided exactly once — a late model message must never un-fill words already delivered, and a
   * fill must never be re-delivered on the next recompute.
   */
  this.omissionSettled = new Set<number>();

  /** The one timer waiting for the earliest undecided `T_i`, or `null`. See `evaluateOmissionFill`. */
  this.omissionTimer = null;

  /**
   * The `triggerSeq` this connection has already interrupted for — the idempotent half of the fence.
   * Set when a model stop RUNS, read by {@link decideModelInterrupt}, and never reset: a repeat of
   * the same trigger is the debounce D-7 forbids, and a NEW utterance always carries a HIGHER seq.
   */
  this.abortedTriggerSeq = null;

  /**
   * Normalized text of the most recent message this connection accepted for delivery (the window's
   * joined text while a window is open). Not the guard's criterion any more — see {@link proceedRelay}
   * — but the reading that says whether there IS a previous delivery to be re-sent at all.
   */
  this.lastAcceptedRelayText = '';

  /** Per-segment frame count, for the log line and the ack. */
  this.segmentFrameCounts = new Map<number, number>();

  /** Fallback mode: segments committed whose transcription has not come back yet, oldest first. */
  this.awaitingTranscriptionSeqs = [];

  /**
   * A committed segment's transcript, once the endpoint has reported one: `false` when it carried
   * words, `true` when it carried none. ABSENT means "not known yet", which is a third state and
   * not the same as empty — the guard holds on absent and drops on `true` (see
   * {@link SEGMENT_TRANSCRIPT_GRACE_MS}).
   */
  this.segmentTranscriptEmpty = new Map<number, boolean>();

  /** Segments already answered with `dropped`/`empty-transcript`, so the ack goes out once. */
  this.emptiedSegmentSeqs = new Set<number>();

  /**
   * Segments already answered `committed` (manual mode), so the ack goes out once.
   *
   * A segment replayed onto a later socket is committed a SECOND time upstream — a second input item
   * for the same audio — and the endpoint answers each with its own `input_audio_buffer.committed`.
   * The page's verdict for that `seq` is already `committed`; a second one would read as a log line
   * rather than a state, and the delivery side already treats the replay as the same segment
   * (`deliveredSegmentSeqs`). One verdict per segment, agreed by both halves.
   */
  this.committedSegmentSeqs = new Set<number>();

  /**
   * WHICH SEGMENT AN INPUT ITEM IS — the endpoint's `item_id` for the utterance a segment's commit
   * created, paired with its `seq`.
   *
   * THE DEFECT THIS CLOSES. A transcription is the endpoint's answer about an ITEM, and the endpoint
   * answers in whatever order it finishes: journal `ef9daacd` (2026-10-12) has seq2's transcript
   * arriving after seq3's commit and seq4's after seq5's. Attributing a transcript by "whichever
   * segment is active when it lands" therefore attributes it to a DIFFERENT segment — and when it is
   * empty, it marks THAT segment empty, which refuses that segment's genuine relay. The item id is the
   * only key that survives the reordering, and the bridge pairs it with the seq whose commit created
   * it ({@link RealtimeBridgeHooks.onUserAudioCommitted}) because the bridge is what writes the commit
   * and reads the answer.
   *
   * AN ABSENT ENTRY IS NOT AN EMPTY ONE. `Map.get` returning `undefined` means "this item belongs to
   * no segment this relay committed" — an item the endpoint's OWN detector created (continuous mode,
   * or the fallback's server VAD), carried by the hook as `seq: null`. Those are exactly the items the
   * old code mis-attributed to the active segment, so absent maps to "no attribution", never to
   * `activeSegmentSeq`.
   */
  this.segmentSeqByItemId = new Map<string, number>();

  /** Segments whose commit the endpoint REFUSED — no item exists for them, so no transcript ever will. */
  this.rejectedSegmentSeqs = new Set<number>();

  /** Segments whose `segment_end` has already been handled, so a repeat cannot close one twice. */
  this.endedSegmentSeqs = new Set<number>();

  /** The one relayed instruction held back because its segment's transcript is not yet known. */
  this.heldDelivery = null;

  this.heldTimer = null;

  this.transcriptGraceMs = this.seams.transcriptGraceMs ?? SEGMENT_TRANSCRIPT_GRACE_MS;


  /**
   * Which segment one input item's transcription belongs to, or `null` for none of them.
   *
   * TWO MODES, TWO DIFFERENT FACTS, and neither of them is "whichever segment is open":
   *
   *  - MANUAL (the shipping path). The item is the one the segment's own `input_audio_buffer.commit`
   *    created, and the bridge pairs them ({@link segmentSeqByItemId}). An item with no entry is one
   *    the endpoint's own detector made — no segment of ours — so `null`.
   *  - SERVER-VAD (the fallback). There is no commit of OURS to pair with: the endpoint's detector
   *    chose the boundary, and the frames went up as they arrived. What orders a transcript to a
   *    segment there is the segment's own closing silence, which is why the queue of segments still
   *    awaiting a transcription holds exactly the ones whose endings the endpoint has read. The OLDEST
   *    of them is the one this transcript closes. That queue — not the active segment — is the anchor,
   *    and it is the reading this function had to change to as well: the active segment in this mode
   *    is set by the same `committed` phase, so a late transcript landed on the next segment here too.
   *
   * AN EMPTY `itemId` MAPS TO NOTHING. A malformed event (no `item_id`) must not be given the benefit
   * of the doubt by falling through to an anchor it does not belong to.
   */
  this.segmentSeqForCaption = (itemId: string): number | null => {
    const mapped = itemId === '' ? undefined : this.segmentSeqByItemId.get(itemId);
    if (mapped !== undefined) {
      return mapped;
    }
    if (this.segmentCommitMode === 'server-vad') {
      return this.awaitingTranscriptionSeqs[0] ?? null;
    }
    return null;
  };


  this.base = this.seams.createExecutor({ boundSessionId: this.boundSessionId });
}

export function installDelivery(this: VoiceRealtimeConnection): void {


  /**
   * Sends one composed instruction and reports it, with the conversation boundary it ANSWERS.
   *
   * `answeredThroughItemId` is the boundary read WHEN THE MODEL PRODUCED THE INSTRUCTION, never the
   * one standing when the frame happens to leave. The two are seconds apart — a busy session holds a
   * send until its turn ends, and a coalescing window holds the pieces for `coalesceMs` — and speech
   * committed during that wait was NOT in front of the model when it decided what to relay. Reading
   * the boundary at the frame made the first delivery claim sentences it had never seen: the page
   * attributes every caption up to this boundary to THIS delivery, so `item_vad_2` (the half of the
   * merged message the model had not been shown yet) was swallowed by the delivery before it and the
   * merged delivery was left owning no sentence at all
   * (`gap-voice-delivered-merged-message-invisible-in-transcript`, 2026-10-13).
   *
   * The default is the boundary as of NOW, which is the relay moment for a call delivered without
   * waiting; a caller that separated the relay from the send passes the boundary it captured then.
   */
  this.deliverSessionSend = async (
    args: Record<string, unknown>,
    answeredThroughItemId: string | null = this.lastCommittedUserItemId,
  ): Promise<unknown> => {
    let answeredThrough = answeredThroughItemId;
    if (this.sending) {
      if (this.waitingForBusySession) {
        // Something more was said while the session is still busy. It joins the waiting message
        // (one delivery, in order) instead of being refused or replacing what was said before it.
        if (typeof args.message === 'string' && args.message.trim() !== '') {
          this.waitingExtraMessages.push(args.message);
          // The joined words were relayed LATER, by a call of their own, so the boundary that covers
          // them is the one standing now rather than the one this send started with.
          answeredThrough = this.lastCommittedUserItemId;
        }
        this.seams.log?.(`session_send joined the instruction waiting for the session`);
        return {
          accepted: true,
          instruction: `The message was accepted and joins the one already waiting. Do not call session_send again for it. ${this.acceptedTail}`,
        };
      }
      throw new Error('A previous voice instruction is still being sent.');
    }
    this.sending = true;
    try {
      const intervalMs = this.seams.busyRetry?.intervalMs ?? BUSY_RETRY_INTERVAL_MS;
      const maxMs = this.seams.busyRetry?.maxMs ?? BUSY_RETRY_MAX_MS;
      const startedAt = Date.now();
      let told = false;
      this.seams.log?.(`session_send start ${JSON.stringify(args).slice(0, 200)}`);
      for (;;) {
        try {
          const composed =
            this.waitingExtraMessages.length === 0
              ? args
              : { ...args, message: [String(args.message ?? ''), ...this.waitingExtraMessages].join(' ') };
          // ── THE INTERRUPT AFTERMATH NOTE (SPEC §0.3 D-8 / §18.5, GOAL-041 AC-344) ──
          // A stop leaves a note for the message that follows it (see `aftermathNote`): the reader of
          // that message is the one that has to be told which tool the previous turn stopped in and
          // that partial changes may remain. Prepended HERE, where the text that actually crosses into
          // the CLI is composed, so a coalesced batch and a release that joined extra messages all
          // carry it — and spent here, for the same reason: "the first message after the interrupt" is
          // a property of the delivery, not of the caller. WHICH message that is — the stop's own
          // correction, or the next thing said after a stop that carried none — is decided by WHEN the
          // note was armed, in `sessionInterrupt`.
          const payload =
            this.aftermathNote !== null && typeof composed.message === 'string' && composed.message.trim() !== ''
              ? { ...composed, message: `${this.aftermathNote}\n\n${composed.message}` }
              : composed;
          if (payload !== composed) {
            this.aftermathNote = null;
            this.lastDeliveryCarriedNote = true;
          }
          const result = await this.base.session_send(payload);
          this.seams.log?.(`session_send delivered in ${Date.now() - startedAt} ms`);
          // The fence's record of what this command carried (SPEC §18.3, GOAL-041 AC-343): the
          // `commandUuid` the host acknowledged, paired with the `utteranceSeq` standing now, so a
          // later `command_lifecycle` `started` for that uuid resolves back to this sentence.
          this.rememberDeliveredCommand(result);
          // The readings the depth and the byte total are made of, updated BEFORE the frame that
          // reports them. A `queued: true` result is one more of the person's messages the session
          // is holding, and its text adds to the bytes it holds; a `queued: false` one started a
          // run, which could only happen with the queue ahead of it drained — so it is the one
          // moment both readings can be reset rather than incremented. The joined messages have just
          // been delivered inside `payload`, so they leave the buffer here rather than a whole turn
          // later in the `finally` below.
          const queuedResult =
            typeof result === 'object' && result !== null && (result as { queued?: unknown }).queued === true;
          // The relay's own guess is only kept when there is no host to ask (see `cliQueueTerm`); a
          // connection with a host samples it HERE, at the delivery result, which is the first moment
          // a drain the CLI performed during the send becomes visible.
          if (this.hostQueueSource === undefined) {
            this.cliQueuedDeliveries = queuedResult ? this.cliQueuedDeliveries + 1 : 0;
            this.cliQueuedBytes = queuedResult ? this.cliQueuedBytes + voiceMessageBytes(payload.message) : 0;
          } else {
            this.refreshHostQueue();
          }
          // The RunDigest's `queuedNotStarted.last`: the last message the session took into its queue
          // and has not begun. A `queued: false` result STARTED a run — the queue ahead of it drained
          // — so the text clears with the count rather than going stale behind it.
          this.lastQueuedNotStartedText = queuedResult && typeof payload.message === 'string' ? payload.message : null;
          this.waitingExtraMessages = [];
          this.send({
            type: 'sent',
            sessionId: this.boundSessionId,
            result,
            depth: this.queuedDepth(),
            bytes: this.queuedBytes(),
            ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
            // The conversation boundary this delivery answers up to, read when the model produced the
            // instruction — see `deliverSessionSend`. Absent only when the endpoint had committed
            // nothing yet AT THAT MOMENT, which is a connection that had heard no speech then: there is
            // nothing to attribute and the browser falls back to its own window.
            ...(answeredThrough === null ? {} : { coveredThroughItemId: answeredThrough }),
          });
          // The host's reconcile account, pushed with each delivery result: a row whose terminal
          // lifecycle frame is lost still clears here once the host stops reporting its command.
          this.pushQueueReconcile();
          // S-A: this result is the one reading that says which run the session is on and whether
          // this message started it or is waiting behind one. Folded in AFTER the frame that reports
          // the same depth/bytes, so the browser sees the delivery and the status line agrees with it.
          this.noteStatus({
            phase: queuedResult ? 'queued' : 'running',
            runId: runIdOf(result),
            queuedItems: this.queuedDepth(),
            queuedBytes: this.queuedBytes(),
          });
          return result;
        } catch (error) {
          // A session that is mid-turn refuses a new run. A person talking to Claude
          // while it works means "after this", not "never": wait for the turn to end
          // (bounded), say so once, and deliver. Without this the instruction was
          // dropped, the model heard nothing back, and the user saw nothing happen.
          const busy = (error as { code?: unknown } | null)?.code === 'SESSION_BUSY';
          if (!busy || this.closed || Date.now() - startedAt >= maxMs) {
            this.seams.log?.(`session_send failed after ${Date.now() - startedAt} ms: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
          if (!told) {
            told = true;
            this.send({
              type: 'error',
              code: 'SESSION_BUSY',
              message: 'Claude is still working in this session; your instruction will be sent as soon as it finishes.',
              recoverable: true,
            });
          }
          this.waitingForBusySession = true;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
    } finally {
      this.sending = false;
      this.waitingForBusySession = false;
      this.waitingExtraMessages = [];
    }
  };


  // ---- coalescing: one spoken thought is one message ----------------------------------------
  this.coalesceMs = this.seams.coalesceMs ?? 0;

  this.pendingParts = [];

  this.pendingExtra = {};

  this.coalesceTimer = null;

  /**
   * The conversation boundary the pieces in the window answer: the boundary the LAST piece saw when
   * the model produced it, stamped at acceptance rather than read at the flush.
   *
   * WHY NOT AT THE FLUSH. The window closes `coalesceMs` after its LAST piece, and a person still
   * talking re-arms it, so a flush can be seconds after the earliest piece was relayed — long enough
   * for the endpoint to commit sentences the model had not been shown when it relayed that piece.
   * The page attributes every caption up to the boundary to the delivery, so a boundary read late
   * hands this delivery sentences it never carried and leaves the next delivery owning none (see
   * `deliverSessionSend`, and the merged message it made invisible).
   */
  this.pendingBoundary = null;


  /**
   * How many of the person's messages are WAITING right now — the COUNT reading the page is shown.
   *
   * Three terms, one per place a message can be waiting, and no term for the delivery being handed
   * over: a delivery in flight is not waiting, it is being delivered.
   *
   *   · the coalescing window, as ONE. However many pieces of a paused sentence landed in
   *     `pendingParts`, they are joined into one message at the flush — counting the pieces would
   *     refuse the tail of a sentence that was always going to be one message.
   *   · the utterances joined into an outstanding busy wait, one each. These are NOT pieces of one
   *     sentence: the window is 1 s and a busy turn can run for two minutes, so a person who keeps
   *     talking into a working session has really said that many things, and each is waiting.
   *   · the session's own queue, read from the host when this connection can ask it
   *     ({@link cliQueueTerm}). When it can and the read fails, the term is UNKNOWN and contributes
   *     nothing — the count the page is shown is then the L3 terms alone, and
   *     {@link VoiceRealtimeExecStatusReading.queuedKnown} says so rather than letting the page read
   *     a partial number as complete.
   *
   * The bound is NOT judged against this any more (see {@link VOICE_QUEUE_MAX_BYTES}); it is kept
   * because the page shows "how many waiting" beside "how much", and the two answer different
   * questions — three short sentences and one long paragraph are both one waiting message to the
   * count.
   */
  this.queuedDepth = (): number =>
    (this.pendingParts.length > 0 ? 1 : 0) + this.waitingExtraMessages.length + this.cliQueueTerm().items;


  this.joinParts = (parts: readonly string[]): string => {
    let out = '';
    for (const part of parts) {
      const next = part.trim();
      if (next === '') continue;
      // No space between two CJK pieces; one between anything else.
      const cjkBoundary = /[\u3000-\u9fff\uff00-\uffef]$/.test(out) && /^[\u3000-\u9fff\uff00-\uffef]/.test(next);
      out = out === '' ? next : `${out}${cjkBoundary ? '' : ' '}${next}`;
    }
    return out;
  };


  /**
   * How many UTF-8 bytes of the person's text are WAITING right now — the reading the bound is
   * judged against, and the one the page shows as "待投递 N 字" (AC1/AC3).
   *
   * The same three terms as {@link queuedDepth}, each measured in bytes rather than counted, and each
   * measured the way it will be delivered: the coalescing window is joined into the one message it
   * will become (so a paused sentence is charged once, at its true length, not piece by piece), and
   * the busy-wait utterances are summed as separate messages (they arrive as separate sends, joined
   * into one payload — the space the join adds between them is not charged, which under-states the
   * pending total by at most a space per seam; that is the safe direction, because it can accept a
   * sliver too much and never refuse a sentence that fits).
   */
  this.queuedBytes = (): number =>
    (this.pendingParts.length > 0 ? voiceMessageBytes(this.joinParts(this.pendingParts)) : 0) +
    this.waitingExtraMessages.reduce((sum, message) => sum + voiceMessageBytes(message), 0) +
    this.cliQueueTerm().bytes;


  /** The open turn-boundary poll, or `null`. Armed while a run is believed active; see {@link armDrainPoll}. */
  this.drainPollTimer = null;


  /**
   * Arms — or disarms — the turn-boundary refresh (SPEC §18.5's 「回合边界深度误差 = 0」, GOAL-041
   * AC-344; see {@link VoiceRealtimeProxySeams.hostQueueTurnBoundaryRefresh} for WHY a bounded poll).
   *
   * Called from {@link noteStatus} after every observation, so the poll is present exactly while the
   * status says a run is live: a patch that moves the phase to `idle` (a stop, a teardown) calls this
   * and the stale timer is dropped rather than left to fire into a settled connection. Idempotent —
   * an already-armed poll is left alone and re-arms itself from {@link pollDrain}.
   */
  this.armDrainPoll = (): void => {
    if (
      this.seams.hostQueueTurnBoundaryRefresh === false ||
      this.hostQueueSource === undefined ||
      this.closed ||
      this.bridge.state !== 'open' ||
      this.execStatus.reading().phase === 'idle'
    ) {
      if (this.drainPollTimer !== null) {
        clearTimeout(this.drainPollTimer);
        this.drainPollTimer = null;
      }
      return;
    }
    if (this.drainPollTimer !== null) {
      return;
    }
    this.drainPollTimer = setTimeout(this.pollDrain, this.statusRateMs);
    this.drainPollTimer.unref?.();
  };


  /**
   * One turn-boundary sample: re-read the host and, if the depth MOVED with no event to say so, put
   * the fresh reading on the wire through the SAME path every other change takes.
   *
   * The move is real only when the number, the byte count or the known/unknown flag differs from the
   * aggregator's stored reading — so a poll over an unchanged queue folds nothing and injects nothing
   * (AC2: the dedup still holds, and no periodic no-change line is ever sent — §8.3). When it HAS
   * moved, {@link noteStatus} folds it and opens a window; the poll then ends that window itself,
   * because a poll IS this window's boundary — the refresh must land within ONE S-A window of the
   * drain, not two. A host that answers `null` moves the reading to UNKNOWN (never back to a zero),
   * which is itself a change the dedup reports.
   */
  this.pollDrain = (): void => {
    this.drainPollTimer = null;
    if (this.closed || this.bridge.state !== 'open') {
      return;
    }
    const before = this.execStatus.reading();
    if (before.phase === 'idle') {
      return;
    }
    this.refreshHostQueue();
    const depth = this.queuedDepth();
    const bytes = this.queuedBytes();
    const known = this.cliQueueTerm().known;
    const moved = depth !== before.queuedItems || bytes !== before.queuedBytes || known !== (before.queuedKnown !== false);
    if (moved) {
      this.send({ type: 'queue_depth', depth, bytes });
      this.noteStatus({ phase: before.phase, runId: before.runId, queuedItems: depth, queuedBytes: bytes });
      if (this.statusTimer !== null) {
        clearTimeout(this.statusTimer);
        this.statusTimer = null;
      }
      this.flushStatus();
    }
    this.armDrainPoll();
  };
}

export function installRelay(this: VoiceRealtimeConnection): void {


  /**
   * The delivery point for a relayed instruction this connection has decided MAY become a message.
   *
   * `segmentSeq`/`segmentIsReplay` are passed in rather than read from the live state because a call
   * released from the transcript hold concludes the segment it was HELD for, which by then may not
   * be the segment that is active.
   */
  this.proceedRelay = async (
    args: Record<string, unknown>,
    segmentSeq: number | null,
    segmentIsReplay: boolean,
  ): Promise<unknown> => {
    // The idempotency gate. A segment being REPLAYED has been sent upstream before, and if
    // it already produced a message the session must not get a second one. The model is
    // answered exactly as a first delivery would answer it, so it does not retry — the
    // words are already where they were meant to go.
    if (segmentSeq !== null && segmentIsReplay && this.deliveredSegmentSeqs.has(segmentSeq)) {
      this.seams.log?.(`segment ${segmentSeq} replayed: the relay repeated an already-delivered call, dropped`);
      return {
        accepted: true,
        instruction: `The message was accepted and has already reached the session. Do not call session_send again for it. ${this.acceptedTail}`,
      };
    }
    // The CONTINUOUS-MODE duplicate gate. A call made while NOTHING NEW HAS BEEN HEARD since the
    // last accepted delivery — `unforwardedUserUtterances === 0`, a counter fed by BOTH of the
    // endpoint's "the user said something" events (`input_audio_buffer.committed` and a final
    // transcription) — is the model re-sending words the session already has, not relaying a new
    // utterance. Answered exactly as a replayed segment above, so the model does not retry, and
    // nothing reaches the session.
    //
    // WHY THE TEXT IS NO LONGER COMPARED FOR EQUALITY OR CONTAINMENT (ruling 2026-10-16; live journal
    // `cae49fed`). The previous criterion was exactly `normalized === lastAcceptedRelayText ||
    // lastAcceptedRelayText.includes(normalized)`, which the model defeats simply by REWRITING what it
    // re-sends: live, a delivery carried "A B" (the relay had prepended A verbatim over a call that
    // carried only B — see the span guard in `sessionSend`), and 44 s later, with zero frames on the
    // wire since, the model re-sent A with its filler words dropped, punctuation added and one phrase
    // reworded. Neither equal nor contained, so the guard let it through and the person was shown a
    // second message they never said. The rewritten form is the NORMAL shape of this echo — the model
    // is reproducing a transcript it read rather than a string it copied — so the comparison is now
    // {@link relayRestatesDelivery}, an elision-tolerant reading of the same question.
    //
    // WHY THE COUNTER IS THE OTHER HALF, AND WHY NEITHER HALF IS ENOUGH ON ITS OWN. The counter alone
    // (drop whenever no new words have been heard) would also drop a sentence the model is still
    // completing: one utterance relayed in two calls — a pause inside a sentence, the tail joining the
    // coalescing window or the busy hold — carries a second call with no `committed` behind it, and
    // that tail must be delivered (the relay's own window and hold rest on it). The text comparison
    // alone cannot see a rewrite. Together they separate the two shapes exactly: a restatement of
    // words already delivered, with nothing new heard in between, is an echo; anything that ADDS
    // words, or any call with a fresh `committed`/transcription behind it, is a delivery.
    //
    // Corpus check over every continuous connection in `~/.cloudcli/voice-realtime-log/*.jsonl`: of
    // 250 `session_send`/`session_interrupt` calls, the 27 made with zero new `committed`/transcript
    // since the previous call split 25 literal repeats (the two earlier recurrences of this defect)
    // and 1 rewritten phantom (the defect this task exists for) — every one an echo — plus 1 whose
    // delivered text was a `session_interrupt` CORRECTION (out of this guard`s scope: the correction
    // path does not advance `lastAcceptedRelayText`, so it stays delivered either way). Zero
    // legitimate relay calls in the population.
    //
    // SCOPED TO `segmentSeq === null`, i.e. the CONTINUOUS path. A delivery that belongs to a
    // segment (segmented relay) is the `seq` dedup gate's job — that gate keys on identity the text
    // comparison cannot see, and applying both here would let this guard mask the other's false
    // forms (the AC8 mutation suite reddens the missing `seq` gate by expecting the replay to land
    // twice). The defect this guard closes is precisely that continuous mode carries no `seq`.
    const normalizedRelay = normalizeRelayText(typeof args.message === 'string' ? args.message : '');
    // ── THE DELIVERY WATERMARK (GOAL-046 keeps it; the settle producer did not) ──
    // On the continuous wire, once a final transcription has been heard, the watermark
    // (`speechEpoch`/`deliveredEpoch`) is what stops the same span from being delivered again — the
    // 2026-10-11 `57279cc1` shape, where one sentence was sent three times, and the `cae49fed`
    // phantom rewrite the old identity/containment comparison missed.
    //
    // The watermark answers "is there a NEW span?", not "are these words already in the session?".
    // A call with no new speech can still be the FIRST delivery of words nobody holds: the
    // interrupt's next message (the person spoke, the model answered, the transcription has not
    // landed — journal `b33412ea`'s late forward), or the first call of a connection whose commits
    // the proxy does not observe. So the refusal needs BOTH halves: no new speech AND a restatement
    // of something recently delivered. Anything that ADDS words is a delivery, which is also what
    // the relay's coalescing window and busy hold depend on (a tail joining an open window must be
    // let through).
    //
    // `unforwardedUserUtterances === 0` is the fallback for a connection that has never heard a final
    // (a direct `session_send` fixture): there is no epoch to compare, and the counter is the same
    // "nothing new happened" reading. SCOPED TO `segmentSeq === null`: a segmented delivery is the
    // `seq` gate's job, and applying both here would mask that gate's own false forms.
    const noNewSpeech = this.finalTranscriptHeard
      ? this.speechEpoch === this.deliveredEpoch
      : this.unforwardedUserUtterances === 0;
    if (
      segmentSeq === null &&
      !this.segmentedRelay &&
      noNewSpeech &&
      this.recentDeliveredTexts.some((previous) => relayRestatesDelivery(normalizedRelay, previous))
    ) {
      // Parens are stripped from the preview: `voice-realtime-log.ts`'s `SEND_NOT_DELIVERED_LINE`
      // reads the reason up to the first `)`, so one in the message would truncate the journal line.
      const preview = String(args.message ?? '').replace(/[\r\n()]/g, ' ').slice(0, 80);
      this.noteNotDelivered(`duplicate: no new speech since the last settled delivery — ${preview}`);
      // No tool-resume: a resume after this answer is what the model re-called the tool on, 7 times
      // live (2026-10-15, connection 71e53da5). The delivered call already had its closing turn.
      return this.withoutToolResume({
        accepted: true,
        instruction: `The message was accepted and has already reached the session. Do not call session_send again for it. ${this.acceptedTail}`,
      });
    }
    // The BOUND (AC1/AC3), judged here — the model's call point, before any await — so a message
    // the relay refuses never reaches the executor at all: `base.session_send` is not called and the
    // session never sees it. Judged AFTER the replay gate, because a replayed segment is not a new
    // message and adds nothing to the queue; and BEFORE the segment bookkeeping, because a refused
    // delivery must not be recorded as one this segment produced.
    //
    // WHO IS REFUSED: a message whose text would push the person's waiting bytes past the budget —
    // `pendingBytes + thisMessageBytes > maxBytes`. A message that FITS is always accepted, however
    // many have come before it (AC1/AC3): the axis is text, not turns.
    //
    // A call that JOINS a window already open adds nothing new to the total — that window is already
    // counted as the one message it will become — so it is let through even at the budget. Without
    // this, the tail of a paused sentence would be refused for the sentence's own head.
    const maxBytes = this.seams.maxQueuedVoiceBytes ?? VOICE_QUEUE_MAX_BYTES;
    // THE HOLD IS BOUNDED (AC1(c)). A piece joining the 1 s window adds nothing new — that window is
    // already charged as the one message it will become — but a piece joining the BUSY HOLD does add:
    // the hold can last a whole turn, so it is the one wait a person can genuinely overrun, and a
    // piece that would push it past the budget is refused (buffer unchanged) rather than admitted.
    const busy = this.readRunBusy() === true;
    const joiningOpenWindow = this.coalesceMs > 0 && this.pendingParts.length > 0 && !busy;
    const incomingBytes = voiceMessageBytes(args.message);
    if (!joiningOpenWindow && this.queuedBytes() + incomingBytes > maxBytes) {
      const bytes = this.queuedBytes() + incomingBytes;
      const depth = this.queuedDepth();
      this.seams.log?.(`session_send refused: ${VOICE_QUEUE_FULL_REASON} bytes=${bytes} max=${maxBytes} depth=${depth}`);
      this.send({ type: 'refused', reason: 'queue-full', depth, bytes });
      // The model reads this. The reason code is stable and the instruction names the number it
      // happened at and the disposition of the words — kept as the caption the person can still
      // see, NOT delivered — and forbids the retry that would otherwise turn one refusal into a
      // stream of them, while still asking the model to keep relaying what the person says next
      // rather than answering them itself (the model must not take over the conversation).
      return {
        accepted: false,
        reason: VOICE_QUEUE_FULL_REASON,
        depth,
        bytes,
        instruction:
          `Refused: the user's undelivered text already waiting for this session plus this message would come to ${bytes} bytes, ` +
          `over the budget of ${maxBytes} bytes (${depth} of their messages are waiting). ` +
          'This message was NOT delivered and will not be. It stays on the user\'s screen as an undelivered line, ' +
          'so the words are not lost. Do not call session_send again for them, and do not retry. ' +
          'Keep passing what the user says next through session_send — do not answer the user yourself: ' +
          'the next thing they say will be carried once the session has caught up.',
      };
    }
    // First delivery of this segment: remember it, so the replay of the same `seq` can be told apart.
    if (segmentSeq !== null) {
      this.deliveredSegmentSeqs.add(segmentSeq);
    }
    // Accepted: this call consumes whatever user utterance upstream has begun so far, and its text
    // becomes the baseline the NEXT no-audio repeat is judged against. Reset HERE, at acceptance —
    // not at the flush — so an utterance arriving inside the window is charged to the next delivery.
    this.unforwardedUserUtterances = 0;
    // The watermark's clock stops here too: everything the person has said up to this acceptance is
    // answered for by this delivery, so a later model response with no NEW speech behind it is a
    // restatement and is refused (`speechEpoch` / `deliveredEpoch`).
    this.deliveredEpoch = this.speechEpoch;
    // The restatement window (see `recentDeliveredTexts`): bounded, newest last. The text is the
    // message this acceptance is for — the composed one, which is what actually reaches the session.
    const acceptedText = normalizeRelayText(typeof args.message === 'string' ? args.message : '');
    if (acceptedText !== '') {
      this.recentDeliveredTexts.push(acceptedText);
      if (this.recentDeliveredTexts.length > 8) {
        this.recentDeliveredTexts.shift();
      }
    }
    // THE CONTINUOUS WIRE'S FORWARDING WATERMARK ADVANCES HERE — the first of its two advance points
    // (the span guard's refusal is the other, and it advances on the same reading: this call has been
    // ANSWERED FOR). Everything transcribed so far belongs to the interval this call just consumed, so
    // the next call's interval starts after it. Advancing at ACCEPTANCE rather than at the flush is
    // deliberate: with a coalescing window open the text is delivered later, but the decision is made
    // here, and a span that stayed open until the flush would let an utterance arriving inside the
    // window be charged to the call before it. Scoped to the continuous path — a delivery keyed by a
    // `seq` is the segmented gate's, and nothing appended to the span for it (see
    // {@link transcribedSinceWatermark}).
    if (!this.segmentedRelay && segmentSeq === null) {
      this.transcribedSinceWatermark.length = 0;
    }
    // ── THE BUSY HOLD (ruling 2026-10-14; release point revised by the X3' replay, 2026-10-15) ──
    // While the host says a turn is in flight, the accepted piece JOINS the one held message and
    // NOTHING is delivered yet: no coalescing timer (the 1 s window would otherwise flush under the
    // busy session and undo the merge), no `sent` frame, no CLI queue entry. The browser is told what
    // the message says right now, and the WHOLE thing goes in as ONE message.
    //
    // TWO WAYS OUT, and the second is the one this task changed. The run ending still releases it
    // (the hold poll, `pollBusy`), which is what the 2026-10-14 ruling had as the ONLY way out — but
    // the replay measured that waiting for the turn end costs a p90 delivery delay of 10.8–18.5 s and
    // routinely lands the words AFTER the model has already answered without them, buying a whole
    // duplicated turn for an instruction the model then reads twice. So the hold ALSO leaves on the
    // QUIET WINDOW: the upstream has closed its turn, the person has said nothing for 2 s, and the
    // merged message goes in under `next` — at the running turn's next tool boundary — instead of
    // queueing behind it. The cap (20 s from the first piece) is the backstop for an upstream that
    // never reports a closed turn at all. A hold that a person overran is bounded exactly like the
    // window is, by the byte check above.
    //
    // Judged BEFORE the `coalesceMs <= 0` fast path below, because a deployment could run with no
    // coalescing window at all and would still want the merge while busy.
    if (busy) {
      if (typeof args.message === 'string' && args.message.trim() !== '') {
        this.pendingParts.push(args.message);
        this.pendingBoundary = this.lastCommittedUserItemId;
        // The quiet window's two stamps, taken at the piece rather than at the flush: the cap is
        // counted from the hold's FIRST piece and the floor from its LAST (see `busyQuietDueAt`).
        const now = Date.now();
        if (this.busyWindowOpenedAt === null) {
          this.busyWindowOpenedAt = now;
        }
        this.lastBusyPieceAt = now;
      }
      this.lastAcceptedRelayText = normalizeRelayText(this.joinParts(this.pendingParts));
      const { message: _held, ...rest } = args;
      this.pendingExtra = { ...this.pendingExtra, ...rest };
      if (this.pendingParts.length > 0) {
        const opening = !this.busyBufferEngaged;
        this.busyBufferEngaged = true;
        if (opening) {
          // The journal's opening bracket, the hold's answer to the window's `queued:` line. No
          // `queued` frame is sent here: that frame's contract is the 1 s window's, and this wait is
          // announced by `pending` (below) instead.
          this.seams.log?.('queued: holding while the session is busy (one merged message, not one per sentence)');
          // S-A: text is waiting without a run of its own having started — the same phase move the
          // window's opening makes.
          this.noteStatus({ phase: 'queued', queuedItems: this.queuedDepth(), queuedBytes: this.queuedBytes() });
        }
        this.emitPending();
        this.armBusyPoll();
        // The hold's own clock, re-armed at every piece: a second piece moves the floor and must move
        // the deadline with it.
        this.armBusyQuietWindow();
      }
      // The same answer every accepted relay gets: DONE from the model's side, and do not re-call.
      return {
        accepted: true,
        instruction: `The message was accepted and will reach the session. Do not call session_send again for it. ${this.acceptedTail}`,
      };
    }
    if (this.coalesceMs <= 0) {
      this.lastAcceptedRelayText = normalizedRelay;
      return this.deliverSessionSend(args);
    }
    // The window OPENS here, and only here: `pendingParts` was empty, so nothing was already
    // waiting and this delivery starts the wait that `flushCoalesced` ends. Tell the browser at
    // this instant (AC-327) — before the timer is armed, so the frame precedes `sent` for certain.
    // A later message that lands INSIDE an open window joins it without a second frame.
    const openingWindow = this.pendingParts.length === 0;
    if (typeof args.message === 'string' && args.message.trim() !== '') {
      this.pendingParts.push(args.message);
      // Stamped HERE, the moment the model's call arrives, not at the flush — see `pendingBoundary`.
      this.pendingBoundary = this.lastCommittedUserItemId;
    }
    // The baseline a repeat is judged against is the WINDOW'S joined text, so a call that joins an
    // open window widens it: a no-audio repeat of any piece already in the window is recognised.
    this.lastAcceptedRelayText = normalizeRelayText(this.joinParts(this.pendingParts));
    const { message: _ignored, ...rest } = args;
    this.pendingExtra = { ...this.pendingExtra, ...rest };
    if (openingWindow && this.pendingParts.length > 0) {
      // The other end of this delivery's journal: `flushCoalesced` writes `coalesced …` when the
      // window closes, this is where it opened and the frame above announced it. An operator
      // reading the log sees the two lines bracketing the wait the browser showed as "tidying up".
      this.seams.log?.(`queued: opening a ${this.coalesceMs} ms coalescing window (the frame precedes the sent)`);
      const depth = this.queuedDepth();
      const bytes = this.queuedBytes();
      this.send({ type: 'queued', depth, bytes });
      // S-A: text is now waiting even though no run has been started for it — the one event that
      // moves the status line to `queued` with a non-zero backlog.
      this.noteStatus({ phase: 'queued', queuedItems: depth, queuedBytes: bytes });
    }
    this.armCoalesce();
    // The model reads this. Wording matters: "will be delivered when the user stops speaking" made it
    // retry the same call every 0.65 s. Say it is DONE from its side, and what to do next.
    return {
      accepted: true,
      instruction: `The message was accepted and will reach the session. Do not call session_send again for it. ${this.acceptedTail}`,
    };
  };


  /**
   * Releases a held instruction: with the transcript now known, deliver it — or, if the segment was
   * transcribed as silence, refuse it and say so.
   */
  this.releaseHeldDelivery = (): void => {
    if (this.heldTimer !== null) {
      clearTimeout(this.heldTimer);
      this.heldTimer = null;
    }
    const held = this.heldDelivery;
    if (held === null) {
      return;
    }
    this.heldDelivery = null;
    if (this.closed) {
      this.noteNotDelivered('socket closed');
      held.resolve(this.handledWithoutDelivery());
      return;
    }
    if (this.segmentTranscriptEmpty.get(held.seq) === true) {
      this.noteNotDelivered('empty-transcript');
      held.resolve(this.handledWithoutDelivery());
      return;
    }
    void this.proceedRelay(held.args, held.seq, held.isReplay).then(held.resolve, (error: unknown) => {
      this.send(
        errorFrame(
          'TOOL_EXECUTION_FAILED',
          `The instruction could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
          true,
        ),
      );
      held.resolve(this.handledWithoutDelivery());
    });
  };


  /**
   * Holds one relayed instruction until its segment's transcription is known, or the grace elapses.
   *
   * The held call is answered only when it is released, which is what makes the ORDERING of the
   * transcription and the model's call irrelevant: both orders end in the same decision.
   */
  this.holdUntilTranscriptKnown = (
    seq: number,
    isReplay: boolean,
    args: Record<string, unknown>,
  ): Promise<unknown> =>
    new Promise((resolve) => {
      if (this.heldDelivery !== null) {
        // A second piece while the first is held is the same utterance relayed in pieces — the shape
        // coalescing exists for. Join them, so the wait costs one message rather than two or none.
        this.heldDelivery.args = {
          ...this.heldDelivery.args,
          message: this.joinParts([String(this.heldDelivery.args.message ?? ''), String(args.message ?? '')]),
        };
        resolve(this.handledWithoutDelivery());
        return;
      }
      this.heldDelivery = { seq, isReplay, args, resolve };
      this.heldTimer = setTimeout(this.releaseHeldDelivery, this.transcriptGraceMs);
      this.heldTimer.unref?.();
    });


  // ---- the omission-fill producer (GOAL-046, rule v2) -----------------------------------------
  //
  // THE MODEL IS STILL THE PRIMARY DELIVERY; THE RELAY IS THE NET FOR WHAT IT DID NOT CARRY. The
  // 2026-10-17 settle producer replaced the model as the delivery judge, and that was one rule too
  // many: it delivered the whole heard span verbatim whenever no response arrived in 2.5 s, even
  // when the model had carried the sentence in its own words. The rule this replaces it with is the
  // one measured on 47 frozen connections (`docs/proposals/voice-realtime-omission-fill-SPEC.md`):
  // a final transcription is delivered VERBATIM only when the model's executed messages do not
  // contain it (`planOmissionFills`, the pure planner this module owns). No settle timer, no span
  // consumption by a model message, no text-side heuristic here — the ordering decisions belong to
  // the planner.
  //
  // THE THREE REGISTRATION POINTS are the planner's whole input: a final transcription, an EXECUTED
  // model message, and `speech_started`. Each recomputes the plan; only `T_i` (the planner's own
  // `dueAt`) decides when a candidate is judged, and an index is decided exactly once.
  this.logOmissionFill = (payload: Record<string, unknown>): void => {
    this.seams.log?.(`omission_fill ${JSON.stringify(payload)}`);
  };


  /** Drops the waiting decision timer. Idempotent, and safe when none is armed. */
  this.clearOmissionTimer = (): void => {
    if (this.omissionTimer !== null) {
      clearTimeout(this.omissionTimer);
      this.omissionTimer = null;
    }
  };


  /**
   * Delivers one planned fill through the EXISTING relay path — busy hold, coalescing window, byte
   * bound and watermark included. It deliberately does not go through {@link sessionSend}: that
   * wrapper registers the call as an EXECUTED MODEL MESSAGE, and a fill is the relay's own words.
   */
  this.deliverOmissionFill = async (message: string): Promise<unknown> =>
    this.proceedRelay({ message }, null, false);


  /**
   * Recomputes the plan and acts on everything whose `T_i` has arrived, then arms the next one.
   *
   * SKIPPED CANDIDATES ARE LOGGED AS SOON AS THE PLAN NAMES THEM. Every skip reason the planner
   * produces is stable once true: weight / empty-grams / wrong-script do not depend on time, and
   * `covered` / `incomparable` only become MORE covered as executed messages arrive (the covering
   * window starts at `t_i − lookback` and its first message is already inside it). Logging them at
   * once is what makes the journal say why a candidate was passed over, instead of leaving a gap.
   *
   * FILLS WAIT FOR THEIR OWN `dueAt`. Fills sharing a `dueAt` are delivered as ONE message, in
   * transcript order; different due times are delivered in order, sequentially, because the send
   * path has a single-flight guard that a concurrent second delivery would trip.
   */
  this.evaluateOmissionFill = (): void => {
    this.clearOmissionTimer();
    if (this.closed || this.segmentedRelay || this.omissionFillParams === null) {
      return;
    }
    const now = Date.now();
    const plan = planOmissionFills(
      this.omissionFinals,
      this.omissionExecuted,
      this.omissionFillParams,
      this.omissionSpeechStarts,
    );

    for (const skip of plan.skipped) {
      if (this.omissionSettled.has(skip.index)) continue;
      this.omissionSettled.add(skip.index);
      this.logOmissionFill({ i: skip.index, reason: skip.reason });
    }

    let earliest: number | null = null;
    const dueByTime = new Map<number, OmissionFill[]>();
    for (const fill of plan.fills) {
      if (this.omissionSettled.has(fill.index)) continue;
      if (fill.dueAt <= now) {
        const group = dueByTime.get(fill.dueAt) ?? [];
        group.push(fill);
        dueByTime.set(fill.dueAt, group);
      } else if (earliest === null || fill.dueAt < earliest) {
        earliest = fill.dueAt;
      }
    }

    const dueTimes = [...dueByTime.keys()].sort((left, right) => left - right);
    if (dueTimes.length > 0) {
      const messages: string[] = [];
      for (const dueAt of dueTimes) {
        const group = (dueByTime.get(dueAt) ?? []).sort((left, right) => left.index - right.index);
        for (const fill of group) {
          this.omissionSettled.add(fill.index);
          this.logOmissionFill({ i: fill.index, dueAt: fill.dueAt, coverage: fill.coverage, reason: 'fill' });
        }
        const message = this.joinParts(group.map((fill) => this.omissionFinals[fill.index].text));
        if (message !== '') messages.push(message);
      }
      void (async (): Promise<void> => {
        for (const message of messages) {
          try {
            await this.deliverOmissionFill(message);
          } catch (error) {
            // One failed fill does not cancel the others, and it is NOT retried: the rule is a
            // single action (SPEC §4.3). The failure is reported the same way a failed relay is.
            this.send(
              errorFrame(
                'TOOL_EXECUTION_FAILED',
                `The omitted speech could not be delivered: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                true,
              ),
            );
          }
        }
      })();
    }

    if (earliest !== null) {
      this.omissionTimer = setTimeout(this.evaluateOmissionFill, Math.max(0, earliest - now));
      this.omissionTimer.unref?.();
    }
  };


  /** Registers one final transcription (`F_i`) and lets the planner re-decide. */
  this.registerOmissionFinal = (text: string, itemId: string): void => {
    if (this.closed || this.segmentedRelay || this.omissionFillParams === null) return;
    if (itemId !== '') this.omissionIndexByItemId.set(itemId, this.omissionFinals.length);
    this.omissionFinals.push({ t: Date.now(), text });
    this.evaluateOmissionFill();
  };


  /**
   * Closes the candidates the `MODEL_TEXT_REPLY` net just delivered verbatim, so the planner does
   * not fill the same words again at `T_i`. The net is the relay's own path, not an executed model
   * message, so the planner cannot see it; this is the relay saying "these are delivered".
   */
  this.closeOmissionFillsDeliveredVerbatim = (itemIds: readonly string[]): void => {
    for (const itemId of itemIds) {
      const index = this.omissionIndexByItemId.get(itemId);
      if (index === undefined || this.omissionSettled.has(index)) continue;
      this.omissionSettled.add(index);
      this.logOmissionFill({ i: index, reason: 'text-reply' });
    }
  };


  /**
   * Registers one EXECUTED model message (`M_k`) — a `session_send` / `session_interrupt` call whose
   * own response completed. A call from a response the endpoint CANCELLED never reaches these
   * executors at all (the bridge reports `TRUNCATED_BY_TURN` before dispatch), which is the input
   * contract `planOmissionFills` requires.
   */
  this.registerOmissionExecuted = (message: unknown): void => {
    if (this.closed || this.segmentedRelay || this.omissionFillParams === null) return;
    if (typeof message !== 'string' || message.trim() === '') return;
    this.omissionExecuted.push({ t: Date.now(), text: message });
    this.evaluateOmissionFill();
  };


  /** Registers one `input_audio_buffer.speech_started` arrival (the planner's silence branch). */
  this.registerOmissionSpeechStart = (): void => {
    if (this.closed || this.segmentedRelay || this.omissionFillParams === null) return;
    this.omissionSpeechStarts.push(Date.now());
    this.evaluateOmissionFill();
  };


  /**
   * Marks every committed-but-untranscribed item as answered by the model response that just went
   * out, so its late transcription does not join the verbatim span the `MODEL_TEXT_REPLY` net
   * delivers.
   *
   * NOTE — THIS IS NOT SPAN CONSUMPTION FOR THE OMISSION RULE. The omission planner sees every final
   * transcription regardless of this set (`registerOmissionFinal` runs before the branch below);
   * this only keeps the MODEL_TEXT_REPLY fallback from delivering words a response already carried.
   */
  this.claimOutstandingCommits = (): void => {
    for (const itemId of this.committedPendingTranscription) {
      this.committedCoveredByResponse.add(itemId);
    }
    this.committedPendingTranscription.clear();
  };


  /**
   * The relay body behind BOTH the model's `session_send` and the relay's own verbatim deliveries
   * (`MODEL_TEXT_REPLY`'s net, and omission fills). It is not exported and not the executor entry
   * point: the difference is that a call arriving here is already known to be a delivery, not the
   * model's response, so it must not register as an EXECUTED model message.
   */
  this.relaySessionSend = async (args: Record<string, unknown>): Promise<unknown> => {
    // A connection the browser has already left has nowhere to deliver to. Without this the relay
    // of a segment that arrived after the socket closed was handed to the session anyway, and the
    // page was never told because there was no page — the "silent disappearance" of 2026-10-11.
    if (this.closed) {
      this.noteNotDelivered('socket closed');
      return this.handledWithoutDelivery();
    }
    // The model's own message, judged on its own: an empty or punctuation-only `message` is not a
    // thought to relay, whatever the segment's transcript said.
    if (EMPTY_RELAY_TEXT.test(typeof args.message === 'string' ? args.message : '')) {
      this.noteNotDelivered('empty-message');
      return this.handledWithoutDelivery();
    }
    // What this call is delivered as: its own arguments, unchanged. The voice plane no longer
    // rewrites the model's words (the deleted span guard was the only thing that did).
    const relayArgs = args;
    if (this.activeSegmentSeq !== null) {
      const empty = this.segmentTranscriptEmpty.get(this.activeSegmentSeq);
      if (empty === true) {
        this.noteNotDelivered('empty-transcript');
        this.markSegmentEmpty(this.activeSegmentSeq);
        return this.handledWithoutDelivery();
      }
      if (empty === undefined) {
        return this.holdUntilTranscriptKnown(this.activeSegmentSeq, this.activeSegmentIsReplay, args);
      }
    } else if (!this.segmentedRelay && this.transcribedSinceWatermark.length > 0) {
      // THE CONTINUOUS WIRE'S SPAN GUARD (SPEC §10, decision doc §12.5「按条目自身空转写判定」).
      // With no segment to key on, the guard asks the endpoint's own per-item reading for EVERY item
      // transcribed since the watermark — the interval this relay is the answer to — and refuses the
      // call only when that whole interval reported zero words, on the SAME journal line a segment's
      // empty transcript uses, so the two wires read alike. ONE item with words is enough to let the
      // call through: a relay that covers several items is a faithful rendering of what was said
      // across them, and the empty sliver at the end of the span is not a reason to drop the sentence
      // in front of it (`b5d01c21` — see {@link transcribedSinceWatermark}).
      //
      // AN EMPTY SPAN IS NOT AN EMPTY TRANSCRIPT. Before any final transcription has landed there is
      // nothing to judge and the call passes through, never held: the continuous caller relays after
      // the endpoint has closed the utterance, and inventing a delay for a genuine delivery is the
      // failure `SEGMENT_TRANSCRIPT_GRACE_MS` names — an unknown is not an empty. An item in the span
      // whose reading is somehow absent reads the same way, for the same reason.
      //
      // Scoped so the segmented path's own seq-keyed guard above stays the one it is.
      if (this.transcribedSinceWatermark.every((itemId) => this.itemTranscriptEmpty.get(itemId) === true)) {
        this.noteNotDelivered('empty-transcript');
        // ANSWERED FOR, so the watermark advances over the span this refusal consumed — the same
        // reading the accepted delivery below makes. The items are behind the guard either way; not
        // advancing would leave them in the next call's interval, where they could only ever make a
        // later, genuinely-empty span look non-empty.
        this.transcribedSinceWatermark.length = 0;
        return this.handledWithoutDelivery();
      }
      // ── THE MODEL'S RESPONSE IS THE PRIMARY DELIVERY (GOAL-046) ──
      // Whether these words cover the span is the omission planner's question, not this path's:
      // the call was registered as an EXECUTED message by {@link sessionSend} before it got here,
      // and the planner judges every final against it at `T_i`. This branch only claims the
      // committed-but-not-yet-transcribed items so their late finals do not enter the
      // `MODEL_TEXT_REPLY` net; `proceedRelay` advances the watermark as before.
      this.claimOutstandingCommits();
    } else if (!this.segmentedRelay) {
      // The response arrived BEFORE the span's transcription. There is nothing to judge here — the
      // endpoint has not said what was heard yet — but the items it has COMMITTED are exactly the
      // ones this response answers for, so they are claimed now: their late final transcriptions
      // must not arm the verbatim `MODEL_TEXT_REPLY` delivery of words the model already carried.
      this.claimOutstandingCommits();
    }
    return this.proceedRelay(relayArgs, this.activeSegmentSeq, this.activeSegmentIsReplay);
  };


  /**
   * `session_send`, executed immediately (AC-316) — the MODEL's call, registered as an executed
   * message before it is relayed.
   *
   * The guard sits HERE, at the delivery point, and not only where the transcription arrives: the
   * endpoint's transcript and the model's relay are independent upstream events and either may land
   * first. Deciding when the call arrives therefore covers both orders, and the hold above makes the
   * decision the same one whichever it was.
   */
  this.sessionSend = async (args: Record<string, unknown>): Promise<unknown> => {
    this.registerOmissionExecuted(args.message);
    return this.relaySessionSend(args);
  };
}

export function installInterrupt(this: VoiceRealtimeConnection): void {


  /**
   * Writes the ONE audit record for a stop (SPEC §6.2, §10.3 / C-3) and answers the three readings
   * the receipt carries.
   *
   * WHY THE JOURNAL GETS A LINE RATHER THAN A NEW SEAM. The proxy's `log` seam is already the
   * connection's on-disk record — `voice-realtime-log.ts`'s recorder tees every line into this
   * connection's journal and classifies the ones it recognises — so a stop that printed nothing
   * structured was the one thing on this connection with no record at all. One `session_interrupt
   * audit {json}` line puts it beside the segment, send and rotation entries the same way they got
   * there, with no second assembly point and no new argument for `server/index.ts` to remember.
   *
   * `intent` and `heard` are the MODEL's words, so both are read as "a string, or nothing": an
   * omitted `heard` is a real reading (`null`), and a stop that named no reason is a real reading too.
   * Neither is invented, and `intent: ''` is never written in place of an absent one — a fabricated
   * reason on an audit line is worse than an empty field.
   *
   * A MISSING `intent` IS RECORDED, NOT REFUSED (this task's whole point). The schema makes `intent`
   * OPTIONAL and the executor does not check it (see `frames/voice-realtime-tools.ts`,
   * `voice-realtime-live-executor.ts`): the real form journal `b5d01c21` shows is a model that
   * called the stop with only a `message`, and refusing it at the transport dropped the stop AND the
   * correction. So an absent or blank `intent` is written as `intent: null` AND FLAGGED with
   * `intentMissing: true`, which is what keeps C-3's "误停可审计" satisfiable — the record says the
   * model gave no reason rather than pretending it gave one.
   *
   * `inFlightTool` is the tool the interrupted run was executing, read ONCE per stop from the host's
   * own activity record ({@link hostRunActivity}) and carried into the journal, the receipt's sibling
   * reading and the next turn's note (`buildInterruptAftermathNote`) so all three name the same tool.
   * When the reading cannot be taken — no host activity for this session, a seam that throws — it is
   * `null` rather than a guess, and the next turn gets the tool-free form of the note (C-3's rule:
   * record what is known, say `null` for the rest). A run that was executing NO tool also reads
   * `null`; the two are the same reading at this seam, which is why the note says "interrupted" and
   * only names a tool when there is one.
   *
   * `noteCarried` says whether THIS stop's aftermath note left with THIS stop's own correction
   * ({@link lastDeliveryCarriedNote}). It is the reading that keeps the two halves of the aftermath
   * honest when they come apart, which is exactly the case a stop-with-correction can produce: a note
   * that went out on the correction while the abort then found NO run (`outcome: 'no-run'`) or was
   * refused (`outcome: 'refused'`) — the message carries an interruption note, and whether it should
   * is only answerable if the audit says the note rode it. A stop that carries no correction is
   * `false` by construction: its note is armed after the abort and rides a LATER message, so this
   * stop's own delivery never carried one.
   */
  this.writeInterruptAudit = (
    args: Record<string, unknown>,
    outcome: 'aborted' | 'no-run' | 'refused' | 'covered',
    queuedStillPending: number,
    inFlightTool: string | null,
    noteCarried: boolean,
  ): { runId: string | null; triggerSeq: number | null; queuedStillPending: number } => {
    const runId = this.execStatus.reading().runId;
    // `0` is "no non-empty utterance has been heard yet", which is not the same reading as "utterance
    // number zero": the count starts at 1, so an absent one is `null` rather than a 0 that could be
    // read as "the first utterance".
    const triggerSeq = this.utteranceSeq === 0 ? null : this.utteranceSeq;
    // `intent` is the model's own statement of why it stopped. A present one is carried verbatim; an
    // ABSENT or blank one is `null` with `intentMissing: true` (SPEC §6.2 / §10.3, C-3) — never `''`,
    // never an invented reason, and never a refusal, because a model that forgot the field still
    // meant to stop and its `message` still has to land.
    const intent = typeof args.intent === 'string' && args.intent.trim() !== '' ? args.intent : null;
    this.seams.log?.(
      `session_interrupt audit ${JSON.stringify({
        runId,
        triggerSeq,
        intent,
        intentMissing: intent === null,
        heard: typeof args.heard === 'string' ? args.heard : null,
        queuedStillPending,
        inFlightTool,
        noteCarried,
        by: 'model',
        outcome,
      })}`,
    );
    return { runId, triggerSeq, queuedStillPending };
  };


  /**
   * `session_interrupt`, the STOP path — the ONE handler that deliberately does not go through
   * {@link deliverSessionSend}.
   *
   * WHY IT BYPASSES THE SEND MACHINERY. A stop has to work precisely when a send is stuck: while a
   * `session_send` is parked in the busy-wait (the single-flight `sending` held) or while the queue
   * is full (`VOICE_QUEUE_FULL`), a stop that queued behind the send it is meant to cancel would
   * never run — the user says stop and the run keeps going. So it does NOT touch `sending`, it does
   * NOT open a coalescing window, and it is NOT judged by the delivery bound. It calls the bound
   * session's own interrupt and answers at once (AC2/AC3).
   *
   * WHAT A STOP IS NOT. It is not a teardown: the voice connection, the microphone and the messages
   * already accepted all survive it (AC4). It ends the ONE run in flight (the control service's
   * abort verb — the SAME one the browser's stop button and the MCP `session_interrupt` reach), and
   * the backlog's first message is released immediately rather than waiting for its coalescing
   * window, so the person's next words are carried without a pause. `depth` is read BEFORE that
   * release, so the number the bar shows still counts everything the stop did not throw away.
   *
   * AND IT IS AUDITED. Every outcome of this path — a run aborted, nothing in flight, or a call the
   * voice plane refused before the abort — goes through {@link writeInterruptAudit}, and the same
   * three readings ride back on the receipt. The stop is the one tool whose whole effect is
   * destructive, so it is the one tool whose reason for firing has to be readable afterwards
   * (SPEC §10.3, C-3).
   *
   * AND IT IS FENCED (SPEC §18.4 G2, GOAL-041 AC-343). This is the MODEL's stop path only — the
   * browser's stop button and Esc reach the control service's abort directly over `chat.abort` and
   * never pass through here, so the fence cannot restrain them (D-7's "UI 停止键不受栅栏约束"). The
   * model's call is first offered to {@link decideModelInterrupt}: an utterance the current run
   * already covers, or the same `triggerSeq` repeated, is answered `{stopped:false, reason:'covered'}`
   * with one `outcome:'covered'` audit line and NO second `stopped` frame — the debounce, not a
   * second stop.
   *
   * AND IT ENQUEUES A CORRECTION BEFORE IT ABORTS (SPEC §18.4 G1, GOAL-041 AC-342). When the call
   * carries a `message` — the corrected instruction for an interrupt the model judged a change of
   * direction (D-6) — that text is delivered into the CLI's own queue FIRST, and the abort waits on
   * the enqueue's confirmation (see {@link enqueueConfirmed}). Only a confirmed enqueue aborts,
   * which is what makes the corrected words and the run they correct land in the SAME turn rather
   * than the correction arriving a turn late (the E10/U1, E10/U2 readings). An enqueue that could
   * not be confirmed answers `{stopped:false, reason:'revision-not-enqueued'}` and aborts nothing.
   *
   * AND THAT CORRECTION IS WHERE THE AFTERMATH NOTE RIDES (ruling 2026-10-16). The note is armed
   * BEFORE the enqueue, so the message the stop's own words go in on is the message that carries the
   * interruption's explanation — see {@link aftermathNote}. A stop with no correction has no such
   * message, keeps its note for whatever is delivered next, and the two are told apart in the audit by
   * `noteCarried`.
   */
  this.sessionInterrupt = async (args: Record<string, unknown>): Promise<unknown> => {
    // The stop's `message` is the model's own words for this utterance, exactly like a
    // `session_send`. It is registered BEFORE the fence, because whether the call is a repeat does
    // not change the fact that the model's response carries those words.
    this.registerOmissionExecuted(args.message);
    // WHAT THE INTERRUPTED RUN WAS DOING, read ONCE for the whole stop (SPEC §0.3 D-8, §18.5). The
    // audit record, the `stopped` frame's run and the note the next MESSAGE carries all name what this
    // one reading answered, so they cannot disagree — and a reading that cannot be taken is `null`
    // here, once, rather than a second attempt later that might answer differently.
    const inFlightTool = this.readInFlightTool();
    // THE FENCE, before any abort. `covered` is the whole of the debounce: no call to the session's
    // own interrupt, no `stopped` frame, no backlog release — just the ONE audit line recording that
    // the model asked again for a sentence the run already has (SPEC §18.4 G2).
    this.refreshInterruptCovers();
    const fenceTriggerSeq = this.utteranceSeq === 0 ? null : this.utteranceSeq;
    // THE DECISION IS A TRUNK STEP (`interrupt-decision`): the fence rule itself lives in the
    // table's shipped step (`decideModelInterrupt`), which writes the verdict back into this payload.
    // A table with no such step leaves it `null` — read as "not covered", the pre-fence path.
    const fence: VoiceRealtimeTrunkPayloads['interrupt-decision'] = {
      triggerSeq: fenceTriggerSeq,
      coveredSeqs: this.coveredSeqs,
      abortedTriggerSeq: this.abortedTriggerSeq,
      decision: null,
    };
    this.runTrunk('interrupt-decision', fence);
    if (fence.decision === 'covered') {
      // Re-sample the host for the depth the receipt reports, for the same reason the success path
      // does: a number carried over from an earlier sample can disagree with what the CLI holds now.
      this.refreshHostQueue();
      const coveredDepth = this.queuedDepth();
      const coveredAudit = this.writeInterruptAudit(args, 'covered', coveredDepth, inFlightTool, false);
      this.seams.log?.(`session_interrupt: covered (no abort) backlog=${coveredDepth}`);
      return { stopped: false, reason: 'covered', ...coveredAudit };
    }
    // ── G1: ENQUEUE THE CORRECTION BEFORE THE ABORT (SPEC §18.4 G1, GOAL-041 AC-342) ──
    // A call the model judged to be a change of direction (SPEC §0.3 D-6) carries the corrected
    // instruction in `message`. It goes into the CLI's own queue FIRST, and the abort WAITS on the
    // enqueue's confirmation. That ordering is the whole fix for F-7's stale-first: E10/U1 reads
    // that at the abort the CLI delivers everything queued behind the run into the interrupt-closing
    // turn, and E10/U2 reads that a correction pushed AFTER the abort (Δ≥50 ms) lands a whole turn
    // late. Enqueued first, the corrected words and the run they correct reach the CLI in the SAME
    // turn, in speech order.
    //
    // A CORRECTION THAT CANNOT BE ENQUEUED DOES NOT ABORT (AC3). If a delivery is already in flight
    // (the single-flight `sending`), or the session does not confirm the correction entered its
    // queue, or the delivery throws, the honest reading is that the correction never reached the
    // session — so the run is left alone and the receipt says `stopped:false` with the reason,
    // rather than stopping a run whose correction was silently dropped.
    const correctionText =
      typeof args.message === 'string' && args.message.trim() !== '' ? args.message : '';
    // ── THE HOLD FOLDS INTO THE INTERRUPT (ruling 2026-10-14) ──
    // A stop that arrives while words are HELD for a busy session is the one case where the hold and
    // the correction are the same utterance: the person said "stop — do this instead" without the
    // held sentence ever reaching the session. The ruling fixes its shape — the held words, the new
    // words and the interruption's explanation go in as ONE message, in speaking order, delivered
    // through the SAME enqueue-then-abort path G1 already runs. So the buffer's text takes the front
    // of the correction (the words were said first), and the note rides that ONE message.
    //
    // AND SO DOES EVERY OTHER CORRECTION (ruling 2026-10-16, this task). The note is armed for every
    // stop that carries a correction, not only for the held one: the reasoning the hold's ruling
    // records — "the note for THIS stop rides THIS message instead of being deferred to the next one"
    // — is true of a plain spoken correction for exactly the same reason. Per G1 the correction is
    // delivered into the CLI's queue BEFORE the abort, and the abort delivers it into the
    // interrupt-closing turn, so it IS the first message into the CLI after the interruption; arming
    // the note afterwards instead put it on the NEXT thing the person said, where "the previous turn
    // was interrupted" describes the wrong turn and "everything after this note takes precedence"
    // demotes the correction that actually answered the interruption (SPEC §18.4 G1, D-6).
    const mergesHold = this.busyBufferEngaged && this.pendingParts.length > 0;
    const held = mergesHold ? this.joinParts(this.pendingParts) : '';
    // ── THE CORRECTION CARRIES THE MODEL'S WORDS AND NOTHING ELSE (ruling 2026-10-16, this task) ──
    // The interrupt's correction used to run the same span guard a `session_send` ran (landed
    // 2026-10-16 for journal `259b51e0`): sentences heard since the watermark whose adjacent-character
    // pairs the correction's words did not cover went in front of it, verbatim. Both consumers of that
    // measure are gone together, for the reason written at the `session_send` guard's former site — it
    // cannot tell a rewrite from a drop, and the live round of 2026-10-16
    // 13:20 (`3d2d3b2c`) is the two cases read out side by side. An interrupt with a `message` is a
    // RESPONSE for the span, so the segment sends ONE text: the model's correction. A sentence the
    // correction does not literally repeat is not lost by that — what no response answered for is still
    // delivered by `onError`'s `MODEL_TEXT_REPLY` arm.
    //
    // THE HELD WORDS ARE NOT A HEARD SENTENCE. `mergesHold` still leads the correction, because the
    // busy hold's words were said by the person and were never delivered: they are that utterance's
    // own text, held instead of dropped, not a transcript spliced in beside the model's.
    const correction = mergesHold
      ? [held, correctionText].filter((piece) => piece.trim() !== '').join('\n\n')
      : correctionText;
    /**
     * Whether the note THIS stop armed left on THIS stop's own correction — the audit's `noteCarried`
     * (see {@link writeInterruptAudit}). `false` for a stop that carries no correction, whose note is
     * armed after the abort and rides a later message; also `false` when the correction never reached
     * the CLI, where the note is revoked rather than spent.
     */
    let noteCarried = false;
    if (correction !== '') {
      // ── THE NOTE IS ARMED BEFORE THE ENQUEUE, SO IT RIDES THE CORRECTION (ruling 2026-10-16) ──
      // Order is the whole mechanism: `deliverSessionSend` prepends an ALREADY-ARMED note, so arming
      // after the enqueue would miss the one message this stop has of its own. Arming it here and
      // letting the delivery spend it is what makes "the note for THIS stop rides THIS message" true
      // for a plain correction and not only for the held one (see `aftermathNote`).
      this.aftermathNote = buildInterruptAftermathNote(inFlightTool);
      // Cleared immediately before the delivery and read immediately after, so the reading belongs to
      // THIS delivery: no other delivery can spend a note while one is in flight (its own single-flight
      // `sending` makes a concurrent call join or throw, never compose).
      this.lastDeliveryCarriedNote = false;
      let enqueueReason: string | null = this.sending
        ? 'a delivery is already in flight, so the correction could not be queued ahead of the abort'
        : null;
      if (enqueueReason === null) {
        try {
          // `next`, the tier the busy hold's release uses: a message the CLI queued earlier at `next`
          // is delivered at the abort, and a correction left to the host's own `later` fallback waits
          // out that whole turn behind it (journal `259b51e0`: the stop arrived 16.8 s after the
          // sentence it was meant to ride with).
          const confirmed = await this.deliverSessionSend({
            message: correction,
            priority: VOICE_BUSY_RELEASE_PRIORITY,
          });
          noteCarried = this.lastDeliveryCarriedNote;
          if (!this.enqueueConfirmed(confirmed)) {
            enqueueReason = 'the session did not confirm the correction entered its queue';
          } else if (!this.segmentedRelay && correctionText !== '') {
            // ANSWERED FOR: the watermark advances over the span this delivery consumed, the same
            // reading `proceedRelay`'s acceptance makes. Only on a confirmed enqueue — a correction
            // that never reached the queue leaves the span for the text-reply net to deliver.
            this.transcribedSinceWatermark.length = 0;
          }
        } catch (error) {
          noteCarried = this.lastDeliveryCarriedNote;
          enqueueReason = error instanceof Error ? error.message : String(error);
        }
      }
      if (enqueueReason !== null) {
        // No abort follows, so no interruption is announced to anyone: the note armed for this
        // correction is REVOKED. When nothing was handed over it is still armed and this is what
        // stops it riding the next message; when the correction did reach the CLI the note went with
        // it and there is nothing left to revoke — `noteCarried` above is then the reading that says
        // so, and the refused audit carries it beside `outcome: 'refused'`.
        this.aftermathNote = null;
        const refusedAudit = this.writeInterruptAudit(args, 'refused', this.queuedDepth(), inFlightTool, noteCarried);
        this.seams.log?.(`session_interrupt: correction not enqueued (${enqueueReason}); not aborting`);
        return { stopped: false, reason: 'revision-not-enqueued', detail: enqueueReason, ...refusedAudit };
      }
      if (mergesHold) {
        // The held words are in the CLI's queue now, as part of the message G1 confirmed: the buffer
        // is spent, so it is emptied (and the card taken down) BEFORE the abort, and the backlog
        // release below cannot deliver the same words a second time.
        this.resetHeldBuffer();
      }
      this.seams.log?.('session_interrupt: correction enqueued; aborting the run it corrects');
    }
    // The backlog a REFUSED stop is audited with, read BEFORE the call: the voice plane can turn the
    // stop away (a missing `intent`, a foreign session, D-2's forbidden verb), and that record still
    // has to carry a reading — the abort answer it would otherwise be read after never arrives. The
    // reading the SUCCESS path reports is taken below instead, once the host has been re-sampled.
    const depthBeforeStop = this.queuedDepth();
    let result: unknown;
    try {
      result = await this.base.session_interrupt(args);
    } catch (error) {
      // A REFUSED stop is written before it is rethrown (SPEC §10.3, C-3). The reading that matters
      // most for "误停可审计" is the stop that did NOT happen — a call the voice plane turned away
      // (a missing `intent`, a foreign session, D-2's forbidden verb) — and it is gone the moment the
      // bridge turns the throw into a `TOOL_EXECUTION_FAILED` frame, so the record is made here.
      //
      // THIS REFUSAL CAN COME AFTER THE CORRECTION WENT OUT (open question, resolved by reading the
      // code: the whitelist lives INSIDE `base.session_interrupt` — `voice-realtime-live-executor.ts`'s
      // `assertBoundSession` — and this proxy calls it BELOW the enqueue, so a stop naming a foreign
      // session still delivers its correction first). The note that rode that correction cannot be
      // recalled, so it is RECORDED rather than pretended away: `noteCarried` sits beside
      // `outcome: 'refused'` and says the message in the CLI carries an interruption note for a stop
      // that never happened. Moving the check above the enqueue was the alternative and was NOT taken:
      // it would have to be duplicated here, a second copy of the whitelist that can drift from the
      // one the executor owns.
      this.writeInterruptAudit(args, 'refused', depthBeforeStop, inFlightTool, noteCarried);
      throw error;
    }
    const aborted =
      typeof result === 'object' && result !== null && (result as { aborted?: unknown }).aborted === true;
    // Sample the host right after the stop: ending the run in flight is the one event that can make
    // the CLI dequeue what was waiting behind it, so the depth reported here has to be re-read rather
    // than carried over from before the stop. Read ONCE, and the log, the audit and the `stopped`
    // frame below all carry this same number: `queuedStillPending` is "what the stop did NOT throw
    // away", so a second reading would let the receipt disagree with the frame.
    this.refreshHostQueue();
    const depth = this.queuedDepth();
    this.seams.log?.(`session_interrupt: aborted=${aborted} backlog=${depth}`);
    // The audit is written from the aggregator BEFORE `noteStatus` below clears the run: after that
    // patch the reading says `idle`/`runId: null`, and a record naming the wrong run (or none) would
    // be an audit of a different stop than the one that happened.
    const audit = this.writeInterruptAudit(args, aborted ? 'aborted' : 'no-run', depth, inFlightTool, noteCarried);
    // The fence's idempotent half: this triggerSeq has now RUN on this connection, so a repeat of the
    // same call is answered `covered` rather than aborting again (SPEC §18.4 G2). Set whether or not
    // the abort found a run to stop — "the same triggerSeq runs once" is the guarantee, and it holds
    // for a session with no lifecycle channel too.
    this.abortedTriggerSeq = fenceTriggerSeq;
    // NO VERBATIM DELIVERY MAY FOLLOW THE STOP (X-5, AC-361). A stop whose correction is only an
    // `intent` (the e2e's U5, journal `19:02:05.781`) carries no message for the omission planner to
    // match, so without this the sentence the stop just disposed of would be filled at `T_i` — a
    // second disposition, after the stop. The span the person had spoken up to this stop is
    // therefore CLOSED: every candidate already known is decided now, with `reason: 'stop'`, and
    // the watermark advances as it always did. A `covered` repeat (fenced above) and a stop that
    // never ran (refused, returned above) do not reach here: they answered nothing.
    if (!this.segmentedRelay) {
      for (let index = 0; index < this.omissionFinals.length; index += 1) {
        if (this.omissionSettled.has(index)) continue;
        this.omissionSettled.add(index);
        this.logOmissionFill({ i: index, reason: 'stop' });
      }
      this.transcribedSinceWatermark.length = 0;
    }
    // The frame names the run the stop ENDED (`audit.runId`, read from the aggregator before the
    // patch below) and the depth it kept — the two readings §18.5 asks the aftermath to carry, taken
    // from the same post-stop host sample as the audit and the status line.
    this.send({ type: 'stopped', aborted, depth, runId: audit.runId });
    // The stop is a state change the page sees, so it is also a reconcile point: after an abort the
    // CLI delivers the backlog into the closing turn, so the host's `started` set has just moved and
    // this push is what clears any backlog row whose terminal frame goes missing.
    this.pushQueueReconcile();
    // S-A: the run in flight just ended, so the status line goes back to `idle`. The backlog the stop
    // did not throw away is still counted, which is why the phase and the counts are one patch rather
    // than two — a line reading `idle queued=0` while text waits would be a lie. The runId STAYS: the
    // line and `session_status` keep naming the run that was just stopped until a new one starts, so
    // "which run did I stop" is answerable for as long as the aftermath is (SPEC §18.5). A stop with
    // no run reported to this connection carries `null` here, unchanged.
    this.noteStatus({ phase: 'idle', runId: audit.runId, queuedItems: depth, queuedBytes: this.queuedBytes() });
    // Release the backlog's first message NOW (its coalescing window would otherwise hold it for up
    // to `coalesceMs`). Only when nothing is mid-delivery: `deliverSessionSend` is single-flight and
    // would refuse a second concurrent call, turning the release into a spurious failure. While a
    // send is in flight the flush is a no-op and the queued message keeps its own timer — the stop
    // has already done its job by aborting the run.
    if (!this.sending) {
      this.flushCoalesced();
    }
    // ── THE NEXT MESSAGE'S NOTE, FOR A STOP THAT CARRIED NO CORRECTION ──
    // Armed AFTER the release above, because the release carries the interrupted turn's own backlog
    // rather than the turn that follows it (see `aftermathNote` and `buildInterruptAftermathNote`).
    // The tool named is the ONE reading taken at the top of this call, so the note, the journal line
    // and the frame all describe the same stop. A stop that aborted nothing arms nothing: there is no
    // interruption to explain, and a note claiming one would be a fabrication.
    // ...and NOT when this stop's note ALREADY left on its own correction (`noteCarried`): that
    // correction is the message this note was owed to, and arming a second one would make the NEXT
    // message repeat an interruption the correction has already explained — the duplication the
    // single-message ruling exists to avoid. Read from the delivery rather than from "did this stop
    // carry a correction": a correction that never reached the CLI leaves no note behind either way,
    // and a correction whose abort then found no run still took the note out with it.
    if (aborted && !noteCarried) {
      this.aftermathNote = buildInterruptAftermathNote(inFlightTool);
    }
    // The receipt the model reads back: the gateway's own payload (untouched — `aborted` and its
    // `message` are the abort's answer, not this plane's) plus the three readings the audit was made
    // from. They are on the receipt for the same reason they are in the journal: the model that
    // decided to stop is the one that can say whether stopping was right, and it cannot do that
    // without knowing WHICH run and WHICH utterance it stopped.
    const gatewayPayload =
      typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
    return { ...gatewayPayload, ...audit };
  };
}

export function installInboundFrameRouting(this: VoiceRealtimeConnection): void {


  // ---- the inbound-frame dispatch seam --------------------------------------------------------
  //
  // Every parsed frame is routed through a registry instead of an inline `if (frame.type === …)`
  // chain. The shipped handlers live in `voice-realtime-frame-handlers.ts`, a sibling file, and are
  // registered there; this connection only assembles the two arguments a handler may see and
  // dispatches. The state view below is accessor-backed on purpose: the rest of this function keeps
  // reading and writing the same locals (`contextText` also feeds `advertiseInstructions`; the
  // audio-frame counter also feeds the teardown/keepalive log lines), so the split changes no
  // variable's lifetime or meaning. `dispatch` returning `null` means "no handler for this kind" —
  // the same silent drop the reader gives an unknown frame.
  this.frameRegistry = this.seams.frameRegistry ?? createDefaultVoiceRealtimeFrameRegistry();

  // The accessor object reads and writes the CONNECTION's fields, not its own properties: inside an
  // object-literal accessor `this` is the object itself, so each accessor delegates to an arrow
  // closure over the connection (no `this` aliasing).
  const readContextText = (): string => this.contextText;
  const writeContextText = (value: string): void => {
    this.contextText = value;
  };
  const readContextChars = (): number => this.contextChars;
  const writeContextChars = (value: number): void => {
    this.contextChars = value;
  };
  const readContextRows = (): number => this.contextRows;
  const writeContextRows = (value: number): void => {
    this.contextRows = value;
  };
  const readAudioFramesFromBrowser = (): number => this.audioFramesFromBrowser;
  const writeAudioFramesFromBrowser = (value: number): void => {
    this.audioFramesFromBrowser = value;
  };
  const readSpeakerObserveFailureLogged = (): boolean => this.speakerObserveFailureLogged;
  const writeSpeakerObserveFailureLogged = (value: boolean): void => {
    this.speakerObserveFailureLogged = value;
  };
  const readRunOutputPending = (): VoiceRealtimeConnection['runOutputPending'] => this.runOutputPending;
  const writeRunOutputPending = (value: VoiceRealtimeConnection['runOutputPending']): void => {
    this.runOutputPending = value;
  };
  this.frameState = {
    get contextText() {
      return readContextText();
    },
    set contextText(value: string) {
      writeContextText(value);
    },
    get contextChars() {
      return readContextChars();
    },
    set contextChars(value: number) {
      writeContextChars(value);
    },
    get contextRows() {
      return readContextRows();
    },
    set contextRows(value: number) {
      writeContextRows(value);
    },
    get audioFramesFromBrowser() {
      return readAudioFramesFromBrowser();
    },
    set audioFramesFromBrowser(value: number) {
      writeAudioFramesFromBrowser(value);
    },
    get speakerObserveFailureLogged() {
      return readSpeakerObserveFailureLogged();
    },
    set speakerObserveFailureLogged(value: boolean) {
      writeSpeakerObserveFailureLogged(value);
    },
    get runOutputPending() {
      return readRunOutputPending();
    },
    set runOutputPending(value) {
      writeRunOutputPending(value);
    },
  };

  this.frameContext = {
    seams: this.seams,
    send: this.send,
    segmentedRelay: this.segmentedRelay,
    contextMaxChars: VOICE_REALTIME_CONTEXT_MAX_CHARS,
    bridge: this.bridge,
    narratorQueue: this.narratorQueue,
    advertiseInstructions: this.advertiseInstructions,
    clearRunOutputRequest: this.clearRunOutputRequest,
    summarizeRunOutput: this.summarizeRunOutput,
    segmentFrameCounts: this.segmentFrameCounts,
    endedSegmentSeqs: this.endedSegmentSeqs,
    noteUserSpokeForNarrator: this.noteUserSpokeForNarrator,
    speakerWindows: this.speakerWindows,
    localSpeechGate: this.localSpeechGate,
    reportLocalSpeechBoundary: this.reportLocalSpeechBoundary,
    silenceTail: this.silenceTail,
    silenceTailOptions: this.silenceTailOptions,
    uplinkVad: this.uplinkVad,
    enqueueUplinkVad: this.enqueueUplinkVad,
    teardown: this.teardown,
    exitUplinkVad: this.exitUplinkVad,
  };


  this.socket.on('message', (raw: unknown) => {
    // THE FRAME'S TWO TRUNK TIMINGS: `before-frame` parses (the shipped step writes the frame into
    // the payload, `null` for anything the reader refuses), `after-frame` runs once the frame
    // registry has taken it. The parse is no longer inline here — it is the table's first step, so
    // a per-frame concern has a registration slot on either side of the routing.
    const inbound: VoiceRealtimeTrunkPayloads['before-frame'] = { raw, frame: null };
    this.runTrunk('before-frame', inbound);
    const parsed = inbound.frame;
    if (!parsed) {
      return;
    }
    // THE SERVER-SIDE SIZE CHECK, applied to the frame BEFORE the registry sees it. The reading is
    // this connection's (`environment > settings file > default`, resolved once above); a pack the
    // browser built at a larger size — an older page, a hand-written frame, an edit racing the
    // connect — is trimmed to the newest rows instead of being refused whole or forwarded at the
    // old size. The browser builder remains the first line of defence; this is the one that cannot
    // be skipped by a client.
    const frame =
      parsed.type === 'context'
        ? (() => {
            const truncated = truncateRenderedVoiceContext(parsed.text, this.contextPackRuntime.values);
            if (truncated.truncated) {
              this.seams.log?.(
                `context truncated from=${truncated.sourceRows} rows/${truncated.sourceChars} chars to=${truncated.rows} rows/${truncated.chars} chars`,
              );
            }
            return {
              ...parsed,
              text: truncated.text,
              chars: truncated.chars,
              rows: truncated.rows,
            };
          })()
        : parsed;
    this.frameRegistry.dispatch(frame.type, this.frameContext, this.frameState, frame);
    this.runTrunk('after-frame', { frame });
  });


  // THE BROWSER LEG'S KEEPALIVE (live 2026-10-15 86559798). Mute stops every browser→server frame,
  // and an idle relay sends nothing back, so an intermediate proxy dropped the socket after ~2.5 min
  // of silence — and the server only noticed 28 s after the replacement had opened. A protocol ping
  // is answered by the browser without page code; a socket that missed a whole interval's pong is
  // ended so the server stops holding a half-open connection.
  this.browserKeepaliveMs = this.seams.browserKeepaliveMs ?? 25_000;

  this.browserAnsweredPing = true;

  this.socket.on('pong', () => {
    this.browserAnsweredPing = true;
  });

  this.browserKeepaliveTimer = this.browserKeepaliveMs > 0 && typeof this.socket.ping === 'function'
      ? setInterval(() => {
          if (this.socket.readyState !== this.socket.OPEN) {
            return;
          }
          if (!this.browserAnsweredPing) {
            this.seams.log?.(`teardown: the browser missed a keepalive pong within ${this.browserKeepaliveMs} ms`);
            this.socket.terminate();
            return;
          }
          this.browserAnsweredPing = false;
          this.socket.ping();
        }, this.browserKeepaliveMs)
      : null;

  this.browserKeepaliveTimer?.unref?.();


  this.socket.on('close', () => {
    if (this.browserKeepaliveTimer !== null) {
      clearInterval(this.browserKeepaliveTimer);
    }
    this.seams.log?.(`teardown: the browser socket closed (audio frames received=${this.audioFramesFromBrowser})`);
    // THE RAW-DROP EXIT CLEARS THE REGISTRY ITSELF, before any early return can skip it. This handler
    // is reached on EVERY way the connection ends — a browser close frame, a keepalive-terminated
    // half-open socket, a network drop — while the teardown below is not: the `uplinkVadExiting`
    // branch returns and leaves the teardown to a bounded wait that a process killed in the meantime
    // never finishes. The registry entry is the one thing that has to be gone the moment the
    // connection is, so it is cleared here rather than relying on the path that a crash can cut short.
    clearVoiceSessionActive(this.boundSessionId);
    if (this.uplinkVadExiting) {
      // The user-explicit exit is mid-flight on its bounded wait; `exitUplinkVad()` will call
      // `teardown()` when the wait resolves. Tearing down here would close the socket the exit still
      // needs for its commit's answer (§6.3). A raw drop never sets this flag, so it still tears down.
      return;
    }
    this.teardown();
  });
}