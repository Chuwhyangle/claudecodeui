// The connection handler's upstream-wire stages: uplink VAD wiring, transport construction and
// the teardown/exit path. Split out of `voice-realtime-ws-proxy.service.ts` (2026-11-03).
import { EMPTY_RELAY_TEXT } from '../frames/relay-text.js';
import { clearVoiceSessionActive } from "../frames/voice-realtime-active.js";
import { pickAnnouncePhraseFrom } from "../core/voice-realtime-announce-phrases.js";
import type { RealtimeBridge, RealtimeBridgeHooks, RealtimeBridgeOptions, RealtimeSegmentPhaseEvent, RealtimeToolExecutor, RealtimeTransport } from '../frames/voice-realtime-bridge.service.js';
import { DEFAULT_VOICE_REALTIME_CLOSING_TURN } from '../frames/voice-realtime-closing-turn.js';
import { markUplinkVadFailed, readUplinkVadState } from '../frames/voice-realtime-uplink-vad-arm-point.js';
import { UPLINK_VAD_HOLD_OPEN_MAX_MS, createUplinkVadGate } from '../frames/voice-realtime-uplink-vad-gate.js';
import type { UplinkVadGate, UplinkVadGateStats } from '../frames/voice-realtime-uplink-vad-gate.js';
import { UPLINK_VAD_EXIT_WAIT_MS } from '../transport/connection-tuning.js';
import { RECOVERABLE_ERROR_CODES, UPSTREAM_CANCELLED_BY_NEW_INPUT, describeBridgeError, describeTransportError, errorFrame, formatSegmentForensics } from "./voice-realtime-transport-errors.js";
import { describeTurnDetection } from '../transport/voice-realtime-turn-detection.js';
import { describeUplinkVadBackend, readUplinkVadBackend } from '../transport/voice-realtime-uplink-vad.js';
import type { UplinkVadClassifier } from '../transport/voice-realtime-uplink-vad.js';
import { SPEAKER_WINDOW_MS, SPEAKER_WINDOW_SAMPLE_RATE, describeSpeakerShadowSummary } from '../core/voice-realtime-speaker-seam.js';
import { createUpstreamPool } from '../core/voice-realtime-upstream-pool.js';
import type { VoiceRealtimeConnection } from './voice-realtime-ws-proxy.service.js';



export function installUplinkVadWiring(this: VoiceRealtimeConnection): void {

  // ---- Uplink VAD (scheme §5): the continuous wire's per-frame speech / non-speech gate ----
  //
  // SAME SHAPE AS STS: built once per connection and only when the deployment asked for it, so an
  // `uplinkVad === undefined` connection never allocates a gate and the branch below keeps the
  // pre-feature `=== null` fast path (AC1/AC2). `a` is derived from the RESOLVED silence window, read
  // here from the SAME `transport/voice-realtime-turn-detection.ts` the transport's own default comes from, so a
  // deployment that moves the window moves this gate's with it (AC8).
  //
  // AC6 — THE STS RELATIONSHIP IS DECIDED HERE, NOT LEFT UNDEFINED. Both gates rewrite the uplink frame
  // stream, and the scheme says they are orthogonal and must not be coupled (§7); running both would be
  // exactly that coupling (the VAD's kept frames feeding STS's silence estimate, or STS's withheld
  // frames feeding the VAD's index space). So exactly one runs: when BOTH seams are present the
  // INCUMBENT wins — STS is the shipped, measured gate — and the uplink VAD is refused OUT LOUD, so a
  // deployment that turned both on gets a working connection and a log line saying which gate ran,
  // never a silent, undefined mixture.
  this.uplinkVadRequested = this.seams.uplinkVad !== undefined && !this.segmentedRelay;

  this.uplinkVad = null;

  /**
   * The classifier the gate consults, kept beside the gate because the FAIL-SAFE BYPASS is the proxy's,
   * not the gate's: the connection-level state it carries (`loading`/`ready`/`bypassed`/`failed`) is what
   * decides whether a frame may go through the gate at all. `null` whenever no gate was built.
   */
  this.uplinkVadClassifier = null;

  this.uplinkVadExitWaitMs = UPLINK_VAD_EXIT_WAIT_MS;

  if (this.uplinkVadRequested && this.silenceTail !== null) {
    this.seams.log?.(
      'uplink_vad refused: silence tail suppression is also enabled, and the two uplink gates do not ' +
        'compose (scheme §7) — the incumbent STS gate wins and the uplink VAD is off for this connection',
    );
  } else if (this.uplinkVadRequested && this.seams.uplinkVad !== undefined) {
    // The detector was resolved ONCE, above, so the value the gate derives `a` from and the value logged
    // at connect time are the same one. Only a REFUSAL is reported here (`describeTurnDetection`'s
    // historical contract): the resolved values are already in the line above when the settings file named
    // them, and the `uplink_vad:` line below carries the EFFECTIVE window — `silenceDurationMs`, the seam
    // override included — so nothing is said twice.
    const turnDetectionNote = describeTurnDetection(this.turnDetection);
    if (turnDetectionNote !== null) {
      this.seams.log?.(turnDetectionNote);
    }
    const silenceDurationMs =
      this.seams.uplinkVad.silenceDurationMs ?? this.turnDetection.turnDetection.silence_duration_ms;
    this.uplinkVadClassifier = this.seams.uplinkVad.classifier;
    this.uplinkVad = createUplinkVadGate({ classifier: this.uplinkVadClassifier, silenceDurationMs });
    this.uplinkVadExitWaitMs = this.seams.uplinkVad.exitWaitMs ?? UPLINK_VAD_EXIT_WAIT_MS;
    // `state=` is the connection-level reading; a production arm point is `loading` here (its backend is
    // constructed asynchronously) while a hand-injected classifier reads `ready`. The whole point of the
    // two fields is that a reader can tell "filtering, found no speech" from "not filtering at all".
    this.seams.log?.(
      `uplink_vad: ${describeUplinkVadBackend(readUplinkVadBackend(this.uplinkVadClassifier))} ` +
        `state=${readUplinkVadState(this.uplinkVadClassifier)} silenceMs=${silenceDurationMs} aFrames=${this.uplinkVad.aFrames}`,
    );
  }

  /**
   * The uplink VAD's per-connection serialisation. `observe` is async and the classifier answers in
   * frame order, so each browser frame chains onto the previous and whatever a call lets through is
   * forwarded as it settles. The chain is ALSO the exit path's drain point — awaiting it is how the exit
   * knows every ARRIVED frame has been judged.
   */
  this.uplinkVadChain = Promise.resolve();

  /** The exit path's wait signals: bit 1 = `input_audio_buffer.committed`, bit 2 = a FINAL transcription. */
  this.uplinkVadExitSignals = 0;

  /** Resolves the exit wait early once BOTH signals have arrived; `null` outside a wait. */
  this.uplinkVadExitResolve = null;

  this.signalUplinkVadExit = (bit: number): void => {
    this.uplinkVadExitSignals |= bit;
    if (this.uplinkVadExitSignals === 3 && this.uplinkVadExitResolve !== null) {
      this.uplinkVadExitResolve();
    }
  };

  /**
   * The gate's latest cumulative reading, plus the proxy's own byte counters — the material for the ONE
   * summary line a connection logs when it closes.
   *
   * The gate's numbers count what IT decided (per frame); the byte counters count what actually crossed
   * the wire and what did not, which is the reading that answers "did this gate save anything". Bytes are
   * the DECODED PCM sizes, so a deployment compares them against the audio it sent, not against base64's
   * 4/3 expansion.
   */
  this.uplinkVadStats = null;

  this.uplinkVadBytesIn = 0;

  this.uplinkVadBytesOut = 0;

  /**
   * Frames this connection has FORWARDED UPSTREAM since the endpoint last committed an input item.
   *
   * The exit path's second reading (see {@link exitUplinkVad}): a count of `0` says the audio the
   * endpoint holds is exactly the audio it has already accounted for — its own last `committed`
   * drained everything this connection sent, so a commit now has nothing to close.
   *
   * COUNTED AT THE FORWARD, NOT AT THE ARRIVAL. `audioFramesFromBrowser` is the browser's reading and
   * is deliberately the wrong one here: the gate withholds silence, and a frame the gate never sent is
   * not audio a commit could reach. Reset on every upstream `committed` (`onUserAudioCommitted`), and
   * only there — that is the event the reading is defined against.
   */
  this.uplinkVadFramesSinceCommit = 0;

  /**
   * How many turn-close notifications the bridge has delivered (`onUpstreamTurn(false)`), and the
   * value that stood when THIS relay sent its own forced commit.
   *
   * WHY A COUNT RATHER THAN `upstreamTalking`. The bridge reports BOTH `speech_stopped` and
   * `committed` as a turn close, and it reports the committed's close BEFORE it calls
   * {@link onUserAudioCommitted} — so by the time this proxy may react, `upstreamTalking` has already
   * been cleared by the very frame being judged. Counting closes keeps the distinction the recovery
   * needs: a forced commit answered by a `committed` with NO `speech_stopped` in between produces
   * exactly ONE close notification on top of the snapshot (the committed's own); a turn the endpoint
   * closed itself produces TWO (`speech_stopped`, then `committed`) — the live 71e53da5 shape where a
   * second `response.create` re-sent the sentence. A new `speech_started` retires the snapshot:
   * whatever the next committed answers, it is no longer the turn this relay closed.
   */
  this.upstreamTurnCloseCount = 0;

  this.forcedCommitCloseSnapshot = null;


  /**
   * The hold-open cap was reached with the upstream's turn still open: commit it ourselves. A refused
   * commit ("buffer too small") means the turn was already closed.
   *
   * COMMIT ONLY HERE, unlike the exit path's pair. The uplink VAD runs only on continuous connections
   * (server_vad), and live, the commit made the upstream close the turn itself and its server_vad
   * answered it; a `response.create` sent unconditionally beside the commit was a second response for
   * the same utterance, which re-sent the sentence and looped on the duplicate guard (2026-10-15,
   * connection 71e53da5). The other live shape is why this is not the whole story: when the endpoint
   * answers `committed` WITHOUT ever emitting `speech_stopped`, its server_vad will not open a
   * response and the sentence waits for the next utterance (2026-10-17, 22.5 s / 49.6 s late). The
   * recovery is state-driven, not a pair sent up front: the snapshot below lets the `committed` tell
   * the two shapes apart — see `onUserAudioCommitted`.
   */
  this.closeUplinkVadHeldTurn = (): void => {
    const transport = this.lastSendingTransport;
    if (transport === null) {
      return;
    }
    this.seams.log?.(
      `uplink_vad: upstream turn still open after ${UPLINK_VAD_HOLD_OPEN_MAX_MS} ms of quiet — committing it`,
    );
    transport.send({ type: 'input_audio_buffer.commit' });
    // SNAPSHOT AFTER THE SEND, before any answer can arrive: the committed that answers THIS commit
    // is recognised by a single turn-close notification on top of this value (see the field doc and
    // `onUserAudioCommitted`'s recovery block).
    this.forcedCommitCloseSnapshot = this.upstreamTurnCloseCount;
  };

  /** Feeds one browser frame through the VAD path and forwards whatever it lets through, in order. */
  this.enqueueUplinkVad = (audio: string): void => {
    const gate = this.uplinkVad as UplinkVadGate;
    this.uplinkVadBytesIn += Buffer.byteLength(audio, 'base64');
    this.uplinkVadChain = this.uplinkVadChain
      .then(async () => {
        // FAIL-SAFE BYPASS. Once the backend has thrown, this connection never consults it again: this
        // frame — and every frame after it — crosses unjudged. The chain is still the path rather than a
        // bare `sendAudioFrame` so a frame queued behind an in-flight classification cannot overtake it.
        if (readUplinkVadState(this.uplinkVadClassifier) === 'failed') {
          this.uplinkVadBytesOut += Buffer.byteLength(audio, 'base64');
          this.uplinkVadFramesSinceCommit += 1;
          this.bridge.sendAudioFrame(audio);
          return;
        }
        const decision = await gate.observe(audio);
        this.uplinkVadStats = decision;
        for (const forwarded of decision.frames) {
          this.uplinkVadBytesOut += Buffer.byteLength(forwarded, 'base64');
          this.uplinkVadFramesSinceCommit += 1;
          this.bridge.sendAudioFrame(forwarded);
        }
        if (decision.closeTurn) {
          this.closeUplinkVadHeldTurn();
        }
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        // THE BACKEND IS DONE FOR THIS CONNECTION, AND THE AUDIO IT WAS HOLDING IS NOT LOST. The frame
        // whose classification threw is still inside the gate — it was pushed before `classify` ran — so
        // `flush` releases it (and anything older still pending) BYPASSED, in order: the audio crosses
        // unjudged at the moment it failed, rather than disappearing the way a log-only catch let it.
        markUplinkVadFailed(this.uplinkVadClassifier, message);
        this.seams.log?.(`uplink_vad: failed — ${message}; every frame from here passes through unjudged`);
        try {
          const tail = await gate.flush();
          this.uplinkVadStats = tail;
          for (const forwarded of tail.frames) {
            this.uplinkVadBytesOut += Buffer.byteLength(forwarded, 'base64');
            this.uplinkVadFramesSinceCommit += 1;
            this.bridge.sendAudioFrame(forwarded);
          }
        } catch (flushError) {
          // Resolved rather than rethrown: a rejected chain would also swallow every LATER frame's
          // forward, turning one backend failure into a connection that stops relaying audio entirely.
          this.seams.log?.(
            `uplink_vad: the post-failure flush failed — ${
              flushError instanceof Error ? flushError.message : String(flushError)
            }`,
          );
        }
      });
  };
}

export function installConnectionTransport(this: VoiceRealtimeConnection): boolean {


  this.executor = {
    ...this.base,
    session_send: this.sessionSend,
    session_interrupt: this.sessionInterrupt,
  };


  this.reportTransportError = (error: { code: string } & Record<string, unknown>): void => {
    // Every transport failure is logged with its human sentence — a MISSING_API_KEY or a
    // MASKED_API_KEY is a server-side misconfiguration, and the log is where the operator reads
    // WHICH one without the browser's copy (which deliberately never names the key's value).
    if (error.code !== 'SPEND_LIMIT') {
      this.seams.log?.(`to-browser transport error ${error.code}: ${describeTransportError(error)}`);
    }
    this.send(errorFrame(error.code, describeTransportError(error)));
    if (error.code === 'SPEND_LIMIT') {
      // Not recoverable: a connection spending at this rate is not left running. The pending
      // instruction (if any) is still delivered by the teardown flush; nothing more is asked of the model.
      this.seams.log?.(`teardown: spend guard tripped (${JSON.stringify({ ...error, code: undefined })})`);
      this.teardown();
    }
  };


  /**
   * One segment phase transition from the bridge: which `seq` a delivery belongs to now, and whether
   * it is a replay.
   *
   * NO ACK IS SENT FROM HERE IN EITHER MODE, and that is the change this frame's grading rests on.
   * A phase says what the APP did (the commit went out; the audio was written again) — not what the
   * endpoint did with it. Manual mode used to answer `committed` at this point, which made the ack a
   * statement about the app's own write and let it say "committed" for segments whose commit was lost
   * with the socket (journal `e22ac831`: six segments answered `committed` with nothing on the wire).
   * The ack now comes from the two places the ENDPOINT is heard from: its own
   * `input_audio_buffer.committed` (manual mode, {@link onUserAudioCommitted}) and the segment's final
   * transcription (fallback mode, `onCaption` — the endpoint's VAD closed it, which is what proves the
   * segment was taken). What the app knows on its own — the socket died, the budget is spent — is
   * reported as `written`/`lost` instead (see the bridge's `onSegmentOutcome`).
   *
   * The bookkeeping here is about DELIVERIES, and stays: `activeSegmentSeq` is the segment a call
   * arriving now belongs to, which is a fact about the segment's window rather than about its ack.
   */
  this.onSegmentPhase = (event: RealtimeSegmentPhaseEvent): void => {
    // A held instruction belongs to the segment it was relayed for, and any transition that ends
    // that segment's window releases it: the segment settled (its response is over, nothing more is
    // coming), or a DIFFERENT segment's audio is now the active one. The release re-reads the
    // transcript, so a segment that was never transcribed fails open rather than waiting forever.
    if (this.heldDelivery !== null && (event.phase === 'settled' || event.seq !== this.heldDelivery.seq)) {
      this.releaseHeldDelivery();
    }
    this.activeSegmentSeq = event.phase === 'settled' ? null : event.seq;
    this.activeSegmentIsReplay = event.phase === 'replayed';
    if (event.phase === 'settled') {
      return;
    }
    // Fallback mode's ack is owed at the ENDPOINT's own signal, not here: the segment only closed at
    // all once the endpoint's detector read its trailing silence as the end of speech, so the queue is
    // what orders the segment to the transcription that proves it — see `onCaption`.
    if (this.segmentCommitMode === 'server-vad' && event.phase === 'committed') {
      this.awaitingTranscriptionSeqs.push(event.seq);
    }
  };

  /**
   * The upstream transport the exit path writes its closing commit to — the session the relay last WROTE
   * to. The bridge's public surface exposes no raw `send` (the exit needs one), so the proxy captures it
   * here; under the upstream pool, "the active session" is the one that last received a frame, not the
   * last one created (the newest transport is the standby), which is why the wrapper below records the
   * SENDER rather than creation order.
   */
  this.lastSendingTransport = null;

  /**
   * Opens one upstream transport. WITH the uplink VAD on the transport is wrapped so the exit path can
   * name the session that received the audio; WITHOUT it this is the plain `createTransport` call the
   * relay has always made, so an `uplinkVad === null` connection is unwrapped and byte-identical (AC2).
   */
  this.openTransport = (): RealtimeTransport => {
    // THIS connection's settings reading, handed to the transport that opens the wire. The proxy
    // resolved the same reading above for its gate and log line; passing it here is what makes the
    // endpoint's `session.update` carry the same detector instead of the file-less shipped default
    // (live, 2026-10-20: the log said 1500 ms, the frame said 800 ms).
    const inner = this.seams.createTransport(this.reportTransportError, this.settings.turnDetection);
    if (this.uplinkVad === null) {
      return inner;
    }
    const wrapper: RealtimeTransport = {
      open: () => inner.open(),
      close: () => inner.close(),
      send: (message) => {
        this.lastSendingTransport = wrapper;
        inner.send(message);
      },
      subscribe: (handler) => inner.subscribe(handler),
      onClose: (handler) => inner.onClose(handler),
    };
    const synthesized = inner.onSynthesizedToolResume;
    if (synthesized !== undefined) {
      wrapper.onSynthesizedToolResume = (handler) => synthesized(handler);
    }
    return wrapper;
  };

  try {
    const bridgeOptions: RealtimeBridgeOptions = {
      ...(this.seams.stallMs === undefined ? {} : { stallMs: this.seams.stallMs }),
      segment: {
        commitMode: this.segmentCommitMode,
        ...(this.seams.commitGapMs === undefined ? {} : { commitGapMs: this.seams.commitGapMs }),
      },
    };
    const bridgeHooks: RealtimeBridgeHooks = {
      onSegmentPhase: this.onSegmentPhase,
      // Continuous mode's duplicate guard's signal (see `unforwardedUserUtterances`): every user
      // utterance the endpoint COMMITS is one the model may yet relay. The bridge tolerates the
      // event itself, so this hook is the proxy's only view of it; the guard's other signal, a final
      // transcription (`onCaption`), is already on this side.
      //
      // The same event carries the seq↔itemId pairing (`segmentSeqByItemId`), because it is the only
      // place the endpoint says which item a segment's commit created. A `seq` of `null` means the
      // endpoint's OWN detector created the item: counted like any other utterance, deliberately NOT
      // recorded in the map — the map's absence is what says "attribute this to no segment", and an
      // entry here would recreate exactly the mis-attribution this closes.
      onUpstreamTurn: (open) => {
        this.uplinkVad?.noteUpstreamTurn(open);
        // The busy quiet window's OTHER reading (X3' replay, 2026-10-15): "the person is still
        // talking" is the endpoint's own turn being open, so the window may only release while this
        // is `false`, and its 2 s is counted from the moment the turn closed. Both are recorded here
        // and nowhere else — the caption path cannot answer this question, because a caption can
        // arrive for a segment long after the person stopped speaking.
        this.upstreamTalking = open;
        if (!open) {
          this.upstreamTurnCloseCount += 1;
          this.lastUpstreamSilenceAt = Date.now();
          // THE EARLY ANNOUNCE (2026-10-21). The endpoint says the person just stopped, and this is
          // the earliest honest moment to acknowledge: transcription has not run yet, the model has
          // not seen the words, and the closing turn is still ~0.9 s away. The queue is free here —
          // user speech cleared it at `speech_started`. One remark per closed turn, from the same
          // settings table the closing turn uses (so the TTS cache already holds the clip).
          //
          // NOT fired on the local energy gate: ambient noise opened it over narrations five times
          // in the 2026-10-19 live connection (see the duplex note below), and an announce for noise
          // is worse than a late one.
          if (
            this.earlyAnnounceArmed &&
            (this.seams.closingTurn ?? DEFAULT_VOICE_REALTIME_CLOSING_TURN) === 'announce' &&
            this.narratorQueue !== null
          ) {
            this.earlyAnnounceArmed = false;
            const earlySeq = this.earlyAnnounceSeq;
            this.earlyAnnounceSeq += 1;
            this.lastEarlyAnnounceAt = Date.now();
            this.narratorQueue.enqueue({
              utteranceId: `announce-early-${earlySeq}`,
              text: pickAnnouncePhraseFrom(this.settings.announcePhrases, earlySeq),
            });
          }
        } else {
          // A new turn is open: it owes one early announce when it closes (see the close branch).
          this.earlyAnnounceArmed = true;
          // A NEW turn starting retires any pending forced-commit snapshot: whatever the next
          // `committed` answers, it no longer answers the turn this relay closed itself.
          this.forcedCommitCloseSnapshot = null;
          // THE DUPLEX RULE'S ENDPOINT READING (AC-406): the endpoint heard the person start a new
          // utterance, so the narrator stops and its queue is cleared. This path is the one the
          // deployed `server_vad` always fires; the browser's segment boundary is the OTHER precise
          // reading of the same fact (see `noteUserSpokeForNarrator`). The local speech gate is
          // deliberately NOT one of them — it is an energy reading for the watchdog, and ambient
          // noise opened it five times over narrations in the 2026-10-19 live connection.
          this.noteUserSpokeForNarrator();
          // THE OMISSION PLANNER'S SILENCE BRANCH. `speech_started` inside `(t_i, t_i + S]` means the
          // model may still answer for `x_i` in its response to the newer speech, so the decision
          // waits the full H instead of confirming at S (SPEC §3). The planner needs the ARRIVAL
          // TIME, which is why the time is recorded here rather than only the boolean above.
          this.registerOmissionSpeechStart();
        }
        this.armBusyQuietWindow();
      },
      onUserAudioCommitted: ({ itemId, seq }) => {
        // The exit path's first signal (§6.3): the endpoint accepted the exit's commit into an input
        // item. Set unconditionally; only a live exit wait reads it (see `signalUplinkVadExit`).
        this.signalUplinkVadExit(1);
        // The exit path's READING, not a signal: the endpoint has just accounted for everything this
        // connection sent it, so the frames forwarded since the PREVIOUS commit stop being "audio the
        // endpoint has not yet been asked to close". See `uplinkVadFramesSinceCommit`.
        this.uplinkVadFramesSinceCommit = 0;
        this.unforwardedUserUtterances += 1;
        // The watermark's clock: a commit is the person having said something, whether or not its
        // transcription has landed yet (see `speechEpoch`).
        this.speechEpoch += 1;
        if (itemId !== '') {
          // The conversation boundary moves HERE, on the commit, whether or not this relay asked for
          // it (`seq === null` is the endpoint's own detector committing a piece of speech): the item
          // exists and is the user's either way, and it is in front of the model from this moment.
          this.lastCommittedUserItemId = itemId;
          // This item exists but has not been transcribed yet, so a model response from now on
          // answers for it even if its final lands afterwards (the `MODEL_TEXT_REPLY` net's input).
          if (!this.segmentedRelay) {
            this.committedPendingTranscription.add(itemId);
          }
        }
        if (seq !== null && itemId !== '') {
          this.segmentSeqByItemId.set(itemId, seq);
        }
        // MANUAL MODE'S `committed` ACK, sent here and only here — the endpoint saying, in its own
        // frame, that this segment's commit created an input item. Everything the app knew earlier
        // (the commit went out, the audio was written again after a reconnect) is a statement about
        // the app, and those segments get `written`/`lost` from `onSegmentOutcome` instead.
        //
        // ONCE PER SEGMENT. A segment replayed onto a later socket is committed AGAIN (a second item
        // for the same audio), and the page's display for that `seq` has already moved past
        // "committed" — a second frame would be a log line, not a verdict. The delivery side treats a
        // replayed segment the same way (`deliveredSegmentSeqs`), so the segment's whole story stays
        // one-verdict-per-seq.
        if (this.segmentCommitMode === 'manual' && seq !== null && !this.committedSegmentSeqs.has(seq)) {
          this.committedSegmentSeqs.add(seq);
          this.send({ type: 'segment_ack', seq, state: 'committed' });
        }
        // THE FORCED COMMIT'S RECOVERY — the 2026-10-17 dropped-sentence defect. When the relay
        // commits a turn the endpoint left open, the endpoint may answer `committed` + a transcript but
        // never `speech_stopped`: its server_vad only fires on a speech→silence transition INSIDE one
        // uncommitted buffer, and the commit froze the buffer, so nothing will open a response and the
        // sentence waits for the next utterance (measured 22.5 s / 49.6 s late). The state says whether
        // the endpoint will answer on its own: a `committed` that is the ONLY turn close since our
        // snapshot had no `speech_stopped` before it, so nothing else is coming and the relay asks for
        // the response. Any `speech_stopped` (fast or same-batch close) adds a second close and leaves
        // the endpoint to answer exactly as it did on 2026-10-15 (connection 71e53da5, where a pair sent
        // unconditionally caused a second response and a duplicate-delivery loop). NO TIMER: this is a
        // reading of events already delivered, and a new `speech_started` retires the snapshot.
        //
        // Segmented connections never reach here in practice — the uplink VAD is not built for them
        // (`uplinkVadRequested`), so no forced commit exists — but the guard is stated, not implied.
        const forcedCommit = this.forcedCommitCloseSnapshot;
        this.forcedCommitCloseSnapshot = null;
        if (!this.segmentedRelay && forcedCommit !== null && this.upstreamTurnCloseCount === forcedCommit + 1) {
          this.seams.log?.(
            'uplink_vad: forced commit answered with no speech_stopped — asking for the response the endpoint will not open',
          );
          this.lastSendingTransport?.send({ type: 'response.create' });
        }
      },
      /**
       * What the bridge knows and the endpoint never said: a segment whose audio it wrote but whose
       * answer died with the socket (`written`), or one it will never be able to answer for
       * (`lost`, with the reason). Forwarded as `segment_ack` — the same vocabulary the two
       * endpoint-driven verdicts use, so the page has ONE place to read a segment's fate — and
       * journalled, because the page may be gone by the time the socket dies and the absence of this
       * record is what made the 2026-10-11 "silent disappearance" undiagnosable.
       */
      onSegmentOutcome: (event) => {
        this.seams.log?.(
          event.state === 'written'
            ? `segment ${event.seq} written, not yet acknowledged by the endpoint`
            : `segment ${event.seq} lost: ${event.reason}`,
        );
        this.send(
          event.state === 'written'
            ? { type: 'segment_ack', seq: event.seq, state: 'written' }
            : { type: 'segment_ack', seq: event.seq, state: 'lost', reason: event.reason },
        );
      },
      // The endpoint REFUSED a commit: no item exists for that segment and none ever will, so its
      // transcript can never arrive to say whether it was empty. Recorded rather than merely logged —
      // `answerSegmentDropped` skips a seq already answered, and a refusal is the one case where the
      // page is owed an answer even though the endpoint never said anything about the segment's words.
      onSegmentCommitRejected: ({ seq, message }) => {
        this.rejectedSegmentSeqs.add(seq);
        this.seams.log?.(`segment ${seq} refused by the endpoint: ${message}`);
        this.answerSegmentDropped(seq, 'commit-refused');
      },
      /**
       * The 2026-10-13 forensics reading: WHY a segment's audio did not come back. LOG-ONLY — the page
       * is owed the segment's FATE, which `onSegmentOutcome` already sends as a `segment_ack`; this
       * carries the close code, the socket generation and the replay spend, which the page has no use
       * for and a `segment_ack` frame has no room for.
       *
       * Recorded here rather than in `onError` on purpose: a forensic reading must not reach the error
       * channel, because an error frame is a session failure the browser renders — routing a
       * measurement through it would tell the person their voice session is broken every time the
       * upstream redials, which is exactly the "只加读数" line this task is not allowed to cross.
       */
      onSegmentForensics: (event) => {
        this.seams.log?.(formatSegmentForensics(event));
      },
      onStateChange: (next) => this.send({ type: 'state', state: next }),
        // A dropped upstream the bridge is already redialling is a hiccup, not the end: the
        // `state: open` that follows the redial restores the page, and a fatal frame here
        // would flash "Voice control stopped" over a session that is about to recover.
        //
        // A STALL IS NOT AN ERROR AT ALL. It used to travel this channel like any other failure,
        // which put it in the same slot as a malformed call and left the page with a sentence and
        // no state: the turn the person had just spoken was neither answered nor ended. It gets its
        // own frame — the utterance's disposition — and the human reading still goes to the log, so
        // a reported incident stays diagnosable from the server side alone.
        onError: (error) => {
          if (error.code === 'UPSTREAM_STALLED') {
            this.seams.log?.(`to-browser turn_unanswered: ${describeBridgeError(error)}`);
            this.send({ type: 'turn_unanswered', seconds: error.seconds });
            return;
          }
          // A MODEL TEXT REPLY IS "HEARD, NOT FORWARDED", NOT A FAILURE (SPEC §12.5, decision doc
          // §12.6 B-8). The model answering in words instead of calling a function is the "nothing
          // to do" disposition. It used to be silent under continuous — logged and then RETURNED
          // with the browser told nothing — which turned a failure from visible into invisible: the
          // person's words reached neither the session nor the screen, over a bar that looked exactly
          // like one where the model had relayed. It now has its own frame, `heard_not_forwarded`
          // (§12.5's reserved disposition), so the bar can say the utterance was heard and set aside.
          // Deliberately NOT the `error` channel: an error frame flashes "Voice control stopped" over
          // a session that is working exactly as it should. SCOPED TO THE CONTINUOUS RELAY — the
          // segmented wire keeps its `error` frame, the reading its own criteria pin (streaming-stages
          // P6, the segmented replay e2e), where a text reply is the retired relay's regression rather
          // than this disposition. The reading goes to the journal either way.
          if (error.code === 'MODEL_TEXT_REPLY' && !this.segmentedRelay) {
            // SPEAK THE MODEL'S OWN WORDS (2026-10-19). A text reply is not only a disposition to
            // report — it is the model talking to the person, and the person should HEAR it. The
            // sentence is enqueued verbatim into the narrator (the queue the announce remark and the
            // run-end summary share), so a connection with the narrator wired speaks exactly what the
            // model said. A connection without a narrator still gets the disposition below unchanged.
            if (this.narratorQueue !== null && error.text.trim() !== '') {
              this.narratorQueue.enqueue({ utteranceId: `model-reply-${this.modelReplyNarrationSeq}`, text: error.text.trim() });
              this.modelReplyNarrationSeq += 1;
            }
            // EVERY FINISHED SENTENCE IS DELIVERED (ruling 2026-10-14, "a pen, not an agent"; live
            // 2026-10-15 b33412ea). When the person speaks again within a beat of finishing, the
            // endpoint opens no response for the sentence just committed, and the next response's
            // text reply sets the whole run aside — the sentences before it got no disposition at all.
            // The relay delivers what no `session_send` answered for, verbatim, through the model's
            // own path (hold, window, bound and watermark included).
            const unansweredItemIds = this.transcribedSinceWatermark.filter(
              (itemId) => this.itemTranscriptEmpty.get(itemId) === false,
            );
            const unanswered = unansweredItemIds.map((itemId) => this.itemTranscriptText.get(itemId) ?? '');
            if (unanswered.some((text) => text.trim() !== '')) {
              const message = this.joinParts(unanswered);
              this.seams.log?.(`relayed verbatim after a text reply: ${unanswered.length} unanswered sentence(s)`);
              // These sentences are delivered by THIS net, so the planner must not fill them
              // again at `T_i` — it cannot see a relay delivery (only executed model messages).
              this.closeOmissionFillsDeliveredVerbatim(unansweredItemIds);
              // THE RELAY'S OWN WORDS, NOT THE MODEL'S: the body is used directly so the net's
              // delivery is not recorded as an executed model message for the omission planner.
              void this.relaySessionSend({ message });
              return;
            }
            this.seams.log?.(`to-browser heard-not-forwarded: ${describeBridgeError(error)}`);
            this.send({ type: 'heard_not_forwarded' });
            return;
          }
          // A CALL THE ENDPOINT'S DETECTOR CUT OFF IS A MEASUREMENT, NOT A FAILURE (2026-10-14,
          // journal `d4c9bfc4`). The person spoke while the model was still writing `session_send`'s
          // arguments, the response was cancelled `turn_detected`, and the model re-sent the whole call
          // on its next turn — an error frame here put "A function call from the upstream was malformed"
          // in front of the person, five times in two minutes, for turns that all worked. The bridge
          // already told the two apart (see its `TRUNCATED_BY_TURN`), so this side does exactly what it
          // does for a stall: writes the reading to the journal and tells the browser NOTHING. The
          // journal line is the count — one per truncation, each naming its call — so the recurrence
          // stays visible on the server side without the page rendering it.
          if (error.code === 'TRUNCATED_BY_TURN') {
            this.seams.log?.(`to-browser truncated-by-turn: ${describeBridgeError(error)}`);
            return;
          }
          // AN UPSTREAM "CANCELLED BY NEW INPUT" IS THE INTERRUPT WORKING, NOT A FAILURE (2026-10-14
          // evening reading). The endpoint cancels the response in flight when the person speaks over
          // the model and reports it this way; a frame here put a red bar over a session that was fine.
          // Same disposition as a stall or a truncated call: the reading goes to the journal, and the
          // browser is told NOTHING. Every OTHER upstream error falls through to the frame below.
          if (error.code === 'UPSTREAM_ERROR' && UPSTREAM_CANCELLED_BY_NEW_INPUT.test(error.message)) {
            this.seams.log?.(`to-browser upstream-cancelled-by-new-input: ${describeBridgeError(error)}`);
            return;
          }
          this.send(
            errorFrame(
              error.code,
              describeBridgeError(error),
              error.code === 'CONNECTION_LOST' ? error.willRetry : RECOVERABLE_ERROR_CODES.has(error.code),
            ),
          );
        },
        // Forwarded verbatim: the caption channel exists so the browser can SHOW
        // what the model heard, and it deliberately shares no path with the
        // `session_send` executor above. The one field this side adds is the `seq` the transcript
        // belongs to — the page needs it to place the words at the segment they were spoken in, and
        // `null` is the honest answer for a transcript that belongs to no segment this relay closed.
        onCaption: (caption) => {
          if (caption.final) {
            // The exit path's second signal (§6.3): a FINAL transcription is the endpoint having
            // committed AND transcribed the utterance the exit's `input_audio_buffer.commit` asked for,
            // so once it lands beside the `committed` the connection can close rather than wait out the
            // bound. Set unconditionally; only a live exit wait reads it.
            this.signalUplinkVadExit(2);
          }
          const seq = this.segmentSeqForCaption(caption.itemId);
          this.send({ type: 'caption', ...caption, seq });
          if (caption.final) {
            // A FINAL transcription is a user utterance begun upstream — the same reading the bridge
            // takes when it resets `callsSinceUtterance` on this event. Counting it here, beside
            // `onUserAudioCommitted`, is what keeps the duplicate guard from treating a legitimate
            // repeat as an echo when the utterance reached us by transcript rather than by a
            // `committed` the proxy saw. See `unforwardedUserUtterances`.
            this.unforwardedUserUtterances += 1;
            // The watermark's clock (see `speechEpoch`): a final transcription is also "the person
            // said something" — the endpoint's own statement, for a connection whose commit the proxy
            // may not have observed.
            this.speechEpoch += 1;
            // The segment's transcript, finally known. `true` means the endpoint reported ZERO
            // words for it — the one mechanical fact the guard acts on — and the segment is
            // answered as refused here, where the fact arrives, whether or not the model relays it.
            const empty = EMPTY_RELAY_TEXT.test(caption.text);
            // The stop audit's `triggerSeq` (see {@link utteranceSeq}): a segment that carried WORDS
            // is one more utterance the model can be stopping FOR. Counted here, beside the `empty`
            // reading it is decided from, so the count and the guard can never disagree about what
            // "the endpoint reported no words" means.
            if (!empty) {
              this.utteranceSeq += 1;
              // The words that seq stood for, for the RunDigest's `covers.last` (see `utteranceTextBySeq`).
              this.utteranceTextBySeq.set(this.utteranceSeq, caption.text);
            }
            // THE OMISSION PLANNER'S `F_i` (GOAL-046). Every final with words is registered,
            // including one a response already claimed (`coveredByResponse` below): the rule's
            // coverage question is answered by `planOmissionFills` from the executed messages, not
            // by this wire's span accounting. Silence is not a candidate (the SPEC excludes it).
            if (!this.segmentedRelay && !empty) {
              this.registerOmissionFinal(caption.text, caption.itemId);
            }
            // THE CONTINUOUS WIRE'S SPAN (SPEC §10, decision doc §12.5「按条目自身空转写判定」). With no
            // segment to key on, the guard keys on the ITEMS transcribed since its watermark: the
            // endpoint's own per-item reading is recorded beside the `empty` it is decided from, and
            // the item joins the span a relay arriving now will be judged against. Appending in
            // ARRIVAL order is what makes the span an interval rather than a set — a relay covers the
            // transcriptions that landed since the last one it answered for, in the order the endpoint
            // finished them, which is the only order this wire has. `itemId === ''` is a malformed
            // event and is given no anchor.
            if (caption.itemId !== '') {
              this.itemTranscriptEmpty.set(caption.itemId, empty);
              if (!this.segmentedRelay) {
                // The item's final has arrived, so it is no longer "committed but untranscribed".
                this.committedPendingTranscription.delete(caption.itemId);
                // A response already answered for this item (it was produced before the
                // transcription landed): consume the transcription rather than settling it again.
                const coveredByResponse = this.committedCoveredByResponse.delete(caption.itemId);
                if (coveredByResponse) {
                  this.itemTranscriptText.set(caption.itemId, caption.text);
                } else {
                  this.transcribedSinceWatermark.push(caption.itemId);
                  this.itemTranscriptText.set(caption.itemId, caption.text);
                  // A final with words is the reading the duplicate guard needs; whether it becomes a
                  // verbatim delivery is the omission planner's decision, made at `T_i`.
                  if (!empty) {
                    this.finalTranscriptHeard = true;
                  }
                }
              }
            }
            // THE SEGMENT THIS TRANSCRIPT IS ABOUT — its OWN, never the one that happens to be active.
            // The endpoint answers in whatever order it finishes, so a transcript for seq N regularly
            // lands after seq N+1's commit (journal `ef9daacd`: seq2's after seq3's, seq4's after
            // seq5's). Reading `activeSegmentSeq` here is what made a late EMPTY transcript for N mark
            // N+1 empty and refuse N+1's genuine relay — see `segmentSeqByItemId`, and
            // `segmentSeqForCaption` for what a `null` means.
            if (seq !== null) {
              this.segmentTranscriptEmpty.set(seq, empty);
              if (empty) {
                this.markSegmentEmpty(seq);
              }
              // The relay held for THIS segment is the one this answers — the hold was opened for
              // `seq` because its transcript was not yet known, and this is that transcript arriving.
              if (this.heldDelivery !== null && this.heldDelivery.seq === seq) {
                this.releaseHeldDelivery();
              }
            }
            // Fallback mode's ack: a FINAL caption is the endpoint having closed the oldest
            // segment still waiting on one, because the segment only closed at all once its
            // trailing silence was read as the end of speech. In order, one caption per ack.
            // An empty one was already answered `dropped` above, so it is not acked twice.
            if (this.segmentCommitMode === 'server-vad' && this.awaitingTranscriptionSeqs.length > 0) {
              const vadSeq = this.awaitingTranscriptionSeqs.shift() as number;
              if (!this.emptiedSegmentSeqs.has(vadSeq)) {
                this.send({ type: 'segment_ack', seq: vadSeq, state: 'committed' });
              }
            }
          }
          // The person is still talking: the quiet window starts over.
          this.armCoalesce();
        },
      // The announce closing turn's "I'm starting" remark. The trigger stays the model's follow-up
      // text after a delivered session_send, but the SENTENCE is now this connection's fixed
      // announce phrase (see `frames/voice-realtime-announce-phrases.ts`) rather than the model's wording:
      // the five remarks in the 2026-10-19 capture were 8–9 characters and semantically identical,
      // so per-utterance wording bought nothing while every one of them paid a separate synthesis
      // round trip. The model's own prompt contract is unchanged (still "one short sentence"), so
      // this wiring change is independent of it.
      //
      // The TABLE is the settings reading resolved once at the top of this connection
      // (`settings.announcePhrases`), not the compiled-in constant: a deployment's
      // `voice-realtime.settings.json` can replace it, and `server/index.ts` warms the TTS cache from
      // the same resolution, so the spoken sentence is always one the cache pre-synthesized.
      //
      // Still routed into the narrator queue and ONLY for `announce`: `silent` produces no text,
      // `respond`'s "OK" must not be spoken, and a text the model said in answer to the user is
      // MODEL_TEXT_REPLY (a different path). No queue (no narrator wired) is a no-op, not an error.
      onFollowUpText: () => {
        if ((this.seams.closingTurn ?? DEFAULT_VOICE_REALTIME_CLOSING_TURN) !== 'announce') return;
        if (this.narratorQueue === null) return;
        // The early announce already said this turn's "I'm starting" at `speech_stopped`; a second
        // utterance of the same phrase for the same turn is noise, not acknowledgment.
        if (
          this.lastEarlyAnnounceAt !== null &&
          Date.now() - this.lastEarlyAnnounceAt < this.EARLY_ANNOUNCE_SUPPRESS_MS
        ) {
          return;
        }
        const seq = this.announceNarrationSeq;
        this.narratorQueue.enqueue({ utteranceId: `announce-${seq}`, text: pickAnnouncePhraseFrom(this.settings.announcePhrases, seq) });
        this.announceNarrationSeq += 1;
      },
    };
    this.bridge =
      this.seams.upstreamPool === undefined
        ? this.connect(this.openTransport(), this.advertisedTools, this.executor, { ...bridgeOptions, hooks: bridgeHooks })
        : // SPEC §C3. `createTransport` is called once per SESSION, so the standby is a
          // second upstream connection rather than a second view of the first; the pool
          // owns both, and closing the pool closes both.
          createUpstreamPool({
            createSession: (sessionHooks) =>
              this.connect(this.openTransport(), this.advertisedTools, this.executor, {
                ...bridgeOptions,
                hooks: sessionHooks,
              }),
            idleRotateMs: this.seams.upstreamPool.idleRotateMs,
            hooks: { ...bridgeHooks, onRotate: this.seams.upstreamPool.onRotate },
            log: this.seams.log,
          });
  } catch (error) {
    // `createTransport()` is the only call above that can throw synchronously
    // (a missing upstream credential is refused at construction). The bridge
    // itself reports every later failure through `onError`/the state hook.
    //
    // THE REGISTRY GOES FIRST, and here rather than through a teardown: this return is above every
    // socket handler below, so the `close` this is about to fire has no listener to catch it — and
    // the connection just died without ever having a teardown. Left here, the entry would arm the
    // dispatch hook for a session whose voice connection failed to exist.
    clearVoiceSessionActive(this.boundSessionId);
    this.send({ type: 'error', code: 'TRANSPORT', message: error instanceof Error ? error.message : String(error) });
    this.socket.close();
    return false;
  }
  return true;
}

export function installConnectionTeardown(this: VoiceRealtimeConnection): void {


  /**
   * Whether the uplink VAD's exit sequence is under way. While it is, the socket `'close'` handler must
   * NOT tear the connection down: the browser sends its close FRAME and then closes the socket, so the
   * `'close'` event arrives while the exit is still waiting, and a teardown there would close the
   * bridge before the exit's commit pair was written (the exact defect §6.3 names).
   */
  this.uplinkVadExiting = false;

  /** Whether the exit sequence has been entered, so the close frame and the socket close cannot both run it. */
  this.uplinkVadExitStarted = false;


  this.teardown = (): void => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // The session stops being in Live Voice at exactly this point, so the dispatch hook stops being
    // armed with it. The socket `close` handler below clears it too, and the two race by design —
    // `clearVoiceSessionActive` is idempotent.
    clearVoiceSessionActive(this.boundSessionId);
    if (this.statusTimer !== null) {
      // A status window armed just before the end would fire into a connection that no longer
      // exists. `flushStatus` guards on `closed` too; this is the cheaper half of the same rule.
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.drainPollTimer !== null) {
      // Same rule for the turn-boundary poll: a sample into a torn-down connection is dropped.
      clearTimeout(this.drainPollTimer);
      this.drainPollTimer = null;
    }
    // The narrator's two timers and any summarizer call in flight: a summary injected after the
    // connection is gone has no queue to land in, and the generation guard drops a late resolve.
    if (this.runEndWatchTimer !== null) {
      clearTimeout(this.runEndWatchTimer);
      this.runEndWatchTimer = null;
    }
    this.clearRunEndSettle();
    this.clearRunOutputRequest();
    this.runEndGeneration += 1;
    // A due omission fill has nowhere to go once the connection is gone: `evaluateOmissionFill`
    // guards on `closed` too, but dropping the timer is the cheaper half of the same rule.
    this.clearOmissionTimer();
    // The narrator has no page to speak to any more. Dropped with NO stop frame: the socket is
    // going, and the page's own teardown discards playback with it.
    this.narratorQueue?.close();
    this.armReconcilePoll(false);
    // An instruction still waiting on its segment's transcript will never get it now: releasing it
    // here records the non-delivery instead of leaving it held until the grace timer fires into a
    // connection that no longer exists.
    this.releaseHeldDelivery();
    // Ending the session right after speaking must not drop the last thing said — and
    // ending it mid-segment must not either. A segment that was started and never ended is
    // closed here with the frames that did arrive, upstream and all: the user stopped
    // talking by ending the session, not by pausing, and that is a segment end too.
    const flushedSeq = this.bridge.flushOpenSegment();
    if (flushedSeq !== null) {
      this.seams.log?.(`teardown: closed the open segment seq=${flushedSeq} with the frames received`);
    }
    this.flushCoalesced();
    // THE CONNECTION'S WAY OUT IS A TRUNK TIMING (`before-close`). The shipped step is the capture's
    // last words: the recorder patches the WAV's size fields and appends the final frame/byte/duration
    // reading. A no-op with no capture wired, and fail-open with one — a capture that cannot be closed
    // must not keep a dead connection's microphone open (why this runs before the socket close, with
    // the rest of the teardown).
    this.runTrunk('before-close', { audioFramesFromBrowser: this.audioFramesFromBrowser });
    // THE SPEAKER TRACKER'S ONE SUMMARY LINE (AC7): windows, accepted, coverage, first-vs-core and the
    // re-anchor/provisional counts, written on the connection's own way out. Readings only — no audio,
    // no per-sample PCM. Absent with no seam, so a default connection's log is unchanged.
    if (this.speakerWindows !== null && this.seams.speakerTracker !== undefined) {
      const speakerSummary = this.seams.speakerTracker.summary();
      // ONE line, with the accumulator readings appended rather than logged separately: a partial
      // window at the end was never observed, and a rate-skipped frame never entered a window, so both
      // belong beside `windows` where a reader can see what the coverage denominator means.
      const windowSamples = (SPEAKER_WINDOW_MS / 1000) * SPEAKER_WINDOW_SAMPLE_RATE;
      this.seams.log?.(
        `${describeSpeakerShadowSummary(speakerSummary)} ` +
          `partialWindowSamples=${this.speakerWindows.pendingSamples}/${windowSamples} ` +
          `rateSkippedFrames=${this.speakerWindows.skippedFrames}`,
      );
    }
    // THE UPLINK VAD'S ONE SUMMARY LINE, on the connection's own way out and only when a gate was built
    // (`uplinkVad === null` ⇒ no line, so a default connection's log is unchanged). The frame counts are
    // the gate's own cumulative reading; `browserFrames` is the count of frames the BROWSER sent, which
    // is never the forwarded count while the gate is withholding anything; the byte figures are the
    // decoded PCM sizes of what crossed and what did not.
    if (this.uplinkVad !== null) {
      const stats = this.uplinkVadStats ?? { sent: 0, headKept: 0, heldOpen: 0, dropped: 0, bypassed: 0, preRoll: 0 };
      this.seams.log?.(
        `uplink_vad summary: browserFrames=${this.audioFramesFromBrowser} sent=${stats.sent} ` +
          `headKept=${stats.headKept} dropped=${stats.dropped} bypassed=${stats.bypassed} ` +
          `preRoll=${stats.preRoll} heldOpen=${stats.heldOpen} ` +
          `forwardedBytes=${this.uplinkVadBytesOut} droppedBytes=${Math.max(0, this.uplinkVadBytesIn - this.uplinkVadBytesOut)}`,
      );
    }
    // Release the uplink VAD's classifier if one was built — the connection owned it (see
    // `UplinkVadSeam`). Off the `void` path, like the bridge's close: a classifier that cannot release
    // must not keep a dead connection's socket open. Exactly one `close()` reaches the backend on every
    // exit path: this is the only call site, `teardown` is guarded once, and the gate's own `close` is
    // idempotent.
    void this.uplinkVad?.close().catch(() => undefined);
    void this.bridge.close().catch(() => undefined);
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.close();
    }
  };


  /**
   * The uplink VAD's exit path (scheme §6.3): drain the gate, then `input_audio_buffer.commit` →
   * `response.create` → a bounded wait → teardown.
   *
   * TRIGGERED BY THE USER'S OWN EXIT — the browser's close frame and nothing else (a raw socket drop is a
   * disconnect, where §6 says the relay has no choice of teardown order and the browser is gone anyway).
   * This is §0's ONLY, BOUNDED exception to "never send `response.create`": the scope is this one path,
   * and the normal-flow send decision is never driven by any upstream VAD event.
   *
   * The ORDER is the whole point. A bare commit into an immediate close drops the answer the commit just
   * flushed, because the endpoint had not yet committed, transcribed and relayed it (§6.3; the shipped
   * manual path sends the SAME pair, `frames/voice-realtime-bridge.service.ts`'s `writeSegmentClose`).
   *
   * WHY THE PAIR IS SKIPPED WHEN THERE IS NOTHING TO COMMIT. The reason for the pair — "do not let an
   * immediate close swallow the tail the flush just released" — only holds while there IS a tail. With
   * nothing flushed, nothing sent since the endpoint's last commit, and no turn open upstream, the commit
   * can only be refused ("buffer too small, or have no audio") and the `response.create` still opens a
   * whole response over the history: live 2026-10-16 01:06 (journal `cae49fed`), 44 s of zero frames
   * after a delivery ended with the endpoint re-answering an utterance it had already been given, its
   * `session_send` this time carrying the SAME sentence REWRITTEN (the model's own retelling of a
   * transcript the relay had forwarded verbatim). That is a message the person never said, and a whole
   * context's worth of spend to produce it. So the pair is omitted — TOGETHER, never one of the two —
   * only when all three readings below say there is nothing to close:
   *
   *   1. the gate's flush released no frames ({@link UplinkVadGate.flush});
   *   2. this connection has forwarded no frame upstream since the endpoint's last `committed`
   *      ({@link uplinkVadFramesSinceCommit} — the flush's own frames are (1)'s reading, so they are
   *      deliberately not added to this one);
   *   3. the upstream has no unclosed `speech_started` (`upstreamTalking`).
   *
   * Any one of them false ⇒ the original behaviour, unchanged and in the original order. What is
   * omitted is the whole pair on a connection that has nothing to say; what is NEVER omitted is the
   * commit of a tail that exists — the old "never short-circuit the commit" warning is about that
   * order, and it still holds.
   */
  this.exitUplinkVad = async (): Promise<void> => {
    if (this.uplinkVadExitStarted) {
      return;
    }
    this.uplinkVadExitStarted = true;
    this.uplinkVadExiting = true;
    const gate = this.uplinkVad as UplinkVadGate;
    try {
      // 1. Drain: every ARRIVED frame has been judged once the chain settles; `flush` then judges the
      //    frames still inside the lagging classifier's window, and both go out before the commit.
      await this.uplinkVadChain;
      const tail = await gate.flush();
      this.uplinkVadStats = tail;
      for (const forwarded of tail.frames) {
        this.uplinkVadBytesOut += Buffer.byteLength(forwarded, 'base64');
        this.bridge.sendAudioFrame(forwarded);
      }
      // 2. The exit pair, on the session the audio actually went to.
      const transport = this.lastSendingTransport;
      if (transport !== null) {
        const nothingToCommit =
          tail.frames.length === 0 && this.uplinkVadFramesSinceCommit === 0 && !this.upstreamTalking;
        if (nothingToCommit) {
          // The journal's record of the omission, so an operator reading a connection that ends with a
          // bare close can tell "there was nothing to commit" from "the pair was lost".
          this.seams.log?.(
            'uplink_vad exit: nothing to commit (no flushed tail, no frame since the endpoint`s last ' +
              'commit, no open turn upstream) — closing without the commit/response pair',
          );
        } else {
          this.uplinkVadExitSignals = 0; // Only signals arriving DURING this wait count (see the hooks).
          transport.send({ type: 'input_audio_buffer.commit' });
          transport.send({ type: 'response.create' });
          // 3. Bounded wait for the endpoint's `committed` + transcription (§6.3), or the bound.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              this.uplinkVadExitResolve = null;
              resolve();
            }, this.uplinkVadExitWaitMs);
            this.uplinkVadExitResolve = () => {
              clearTimeout(timer);
              this.uplinkVadExitResolve = null;
              resolve();
            };
          });
        }
      }
    } catch (error) {
      this.seams.log?.(
        `uplink_vad exit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.teardown();
  };


  // `whenConnected()` never rejects — it resolves on `open` or once the bridge
  // has exhausted its attempts and closed — so the state is what decides whether
  // there is a session to advertise. Sending an update on a closed bridge would
  // be dropped silently and leave the browser listening to nothing.
  //
  // WHAT TO DO ABOUT IT IS THE TABLE'S `after-handshake` STEP (the shipped one answers the page
  // with a `TRANSPORT` error and ends the connection, or advertises the instructions as they stand).
  void this.bridge.whenConnected().then(() => {
    this.runTrunk('after-handshake', { connected: this.bridge.state === 'open' });
  });
}