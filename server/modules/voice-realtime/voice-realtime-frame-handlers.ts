/**
 * The shipped inbound-frame handlers for the `/voice-realtime` proxy.
 *
 * Every body in this file was moved here from `voice-realtime-ws-proxy.service.ts`'s
 * one `socket.on('message')` callback (the eight `if (frame.type === …)` arms). The
 * move is a pure displacement: the expressions, the field reads, the writes and the
 * `null`/early-return arms are the originals, with the enclosing function's locals
 * now reached through the explicit context/state arguments the registry defines. The
 * criterion `tests/voice-realtime-frame-registry.test.ts` spot-checks the moved bodies
 * against the old answers and compares each handler's `source` with the proxy's own path.
 *
 * Registration lives here rather than in the proxy:
 * {@link createDefaultVoiceRealtimeFrameRegistry} builds a fresh registry and registers
 * every handler below, so the shipped set is assembled by a file beside the proxy. The
 * proxy imports only the factory — it never names a frame body.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (its per-connection registry defaults
 * to {@link createDefaultVoiceRealtimeFrameRegistry}) and the criterion above (which
 * drives both the shipped handlers and a probe registered from the test file).
 */
import { fileURLToPath } from 'node:url';

import { SEGMENTED_RELAY_PROTOCOL, VOICE_REALTIME_MODE_ENV } from './voice-realtime-mode.js';
import { describeSpeakerShadowObservation } from './voice-realtime-speaker-seam.js';
import {
  VoiceRealtimeFrameRegistry,
  type VoiceRealtimeFrameConnectionState,
  type VoiceRealtimeFrameContext,
  type VoiceRealtimeFrameHandler,
  type VoiceRealtimeFramePayload,
} from './voice-realtime-frame-registry.js';

/**
 * The file this handler set was defined in.
 *
 * Read off the module's own URL rather than spelled as a literal, so the criterion can
 * compare it with the proxy's own source path without either side hard-coding a checkout
 * location.
 */
const HANDLERS_SOURCE = fileURLToPath(import.meta.url);

/**
 * The segmented-relay offer (P4 / AC-322).
 *
 * THE WHOLE PROTOCOL SWITCH, one branch. The browser offered a token; answering with the
 * same token is what lets it start cutting speech into segments. Anything else — the mode
 * turned off, or an offer this proxy does not speak — is answered with silence, and
 * silence is a MEANINGFUL answer here: the page keeps sending the continuous frames it
 * always did, so a rollback needs no browser release. Only the exact token is echoed: a
 * page offering a protocol this proxy does not implement is told nothing rather than told
 * the wrong thing.
 */
function handleHello(
  context: VoiceRealtimeFrameContext,
  _state: VoiceRealtimeFrameConnectionState,
  frame: VoiceRealtimeFramePayload<'hello'>,
): void {
  if (context.segmentedRelay && frame.protocol === SEGMENTED_RELAY_PROTOCOL) {
    context.send({ type: 'ready', protocol: SEGMENTED_RELAY_PROTOCOL });
    context.seams.log?.(`hello: declaring ${SEGMENTED_RELAY_PROTOCOL}`);
  } else {
    // WHY the relay stayed silent, named: the log must tell "the deployment turned it off" apart
    // from "this connection asked for the continuous transport" (the per-connection opt-in), so an
    // operator reading one connection's journal is not sent looking at a variable that is fine.
    const relayOffBecause =
      context.seams.transport === 'continuous'
        ? 'continuous transport requested for this connection'
        : `relay off via ${VOICE_REALTIME_MODE_ENV}`;
    context.seams.log?.(
      `hello: not declaring (offered ${JSON.stringify(frame.protocol)}${
        context.segmentedRelay ? '' : `, ${relayOffBecause}`
      })`,
    );
  }
}

/**
 * The C2 ContextPack (`VoiceRealtimeContextFrame` in the browser's protocol module).
 *
 * The browser built this from its own transcript's visibility rules; what the proxy owns is
 * the size it is willing to hand upstream. Refusing the WHOLE frame rather than trimming it is
 * deliberate: a pack cut anywhere but its own oldest-row boundary is a conversation with a
 * hole in it, and the injection would then be evidence of nothing. The builder already holds
 * the budget, so this only fires on a client that ignored it — and it says so.
 */
function handleContext(
  context: VoiceRealtimeFrameContext,
  state: VoiceRealtimeFrameConnectionState,
  frame: VoiceRealtimeFramePayload<'context'>,
): void {
  if (frame.text.length > context.contextMaxChars) {
    context.seams.log?.(
      `context refused: ${frame.text.length} chars exceeds the ${context.contextMaxChars}-char cap (rows=${frame.rows})`,
    );
    return;
  }
  state.contextText = frame.text;
  state.contextChars = frame.chars;
  state.contextRows = frame.rows;
  context.seams.log?.(`context received chars=${state.contextChars} rows=${state.contextRows}`);
  context.advertiseInstructions();
}

/**
 * The narrator queue's pacing ack.
 *
 * Handled before the speech branches: it is a statement about PLAYBACK, never about the person
 * having spoken (an ack arriving while they talk must not look like a new utterance, and a stale
 * one is ignored by the queue itself).
 */
function handleNarratorDone(
  context: VoiceRealtimeFrameContext,
  _state: VoiceRealtimeFrameConnectionState,
  frame: VoiceRealtimeFramePayload<'narrator_done'>,
): void {
  context.narratorQueue?.completed(frame.utteranceId);
}

/**
 * The page's answer to the run-end output request.
 *
 * Only the ONE outstanding request may be answered: a late reply for a superseded run is dropped
 * by the id check, not summarized late.
 */
function handleRunOutput(
  context: VoiceRealtimeFrameContext,
  state: VoiceRealtimeFrameConnectionState,
  frame: VoiceRealtimeFramePayload<'run_output'>,
): void {
  const pending = state.runOutputPending;
  if (pending === null || pending.requestId !== frame.requestId) return;
  context.clearRunOutputRequest();
  void context.summarizeRunOutput(pending.generation, pending.runId, frame.text);
}

/**
 * A segment opens.
 *
 * THE SEGMENTED PATH'S READING of "they started talking" — the browser's own boundary. On this
 * wire there is no endpoint `speech_started` to clear the narrator (the relay runs
 * `turn_detection: null`), so this is the only early signal, and clearing here is what keeps
 * a narration from talking over the first segment.
 *
 * The boundary is handed to the same watchdog the continuous path feeds. It needs its own: this
 * wire runs `turn_detection: null`, so the endpoint never sends the `speech_started` the
 * watchdog's timer is otherwise armed from — a committed segment nobody answered was silently
 * unanswered, which is exactly this path's stall to report.
 */
function handleSegmentStart(
  context: VoiceRealtimeFrameContext,
  _state: VoiceRealtimeFrameConnectionState,
  frame: VoiceRealtimeFramePayload<'segment_start'>,
): void {
  context.segmentFrameCounts.set(frame.seq, 0);
  context.noteUserSpokeForNarrator();
  context.bridge.startSegment(frame.seq);
  context.bridge.noteLocalUtteranceStart();
}

/**
 * One base64 PCM frame from the browser.
 *
 * Two wires share this handler: with a `seq` the frame belongs to that relay segment, without one
 * it is the continuous path. Everything before the split (the sparse heartbeat, the speaker-shadow
 * feed, the capture feed and the local speech gate) runs on ARRIVAL for both, because those
 * readings are about what the browser sent rather than what was forwarded.
 */
function handleAudio(
  context: VoiceRealtimeFrameContext,
  state: VoiceRealtimeFrameConnectionState,
  frame: VoiceRealtimeFramePayload<'audio'>,
): void {
  state.audioFramesFromBrowser += 1;
  // A sparse heartbeat, so the log can say whether the page is sending audio at all
  // (and for how long) without a line per 20 ms frame.
  if (state.audioFramesFromBrowser === 1 || state.audioFramesFromBrowser % 250 === 0) {
    context.seams.log?.(`from-browser audio frames=${state.audioFramesFromBrowser}`);
  }
  // THE SPEAKER TRACKER'S FEED (Phase 1 SHADOW). It reads a decoded COPY of the frame on ARRIVAL —
  // before the branch below decides how to forward it — and does nothing else: the frame is still
  // forwarded on every path, unchanged, and the observation can never reach the browser. `?.` is not
  // enough here because the accumulator also has to be absent for a default connection, so the
  // whole block is guarded; when it is absent this is the branch it always was (AC6).
  if (context.speakerWindows !== null && context.seams.speakerTracker !== undefined) {
    try {
      const completed = context.speakerWindows.push(Buffer.from(frame.audio, 'base64'), {
        ...(frame.sourceRate === undefined ? {} : { sourceRate: frame.sourceRate }),
        atMs: Date.now(),
      });
      for (const window of completed) {
        context.seams.log?.(describeSpeakerShadowObservation(context.seams.speakerTracker.observe(window, Date.now())));
      }
    } catch (error) {
      // A broken shadow reader degrades to NO READINGS, never to a broken relay: this is a side
      // channel, so its failure is a line, not a throw.
      if (!state.speakerObserveFailureLogged) {
        state.speakerObserveFailureLogged = true;
        context.seams.log?.(
          `speaker_shadow observe failed: ${error instanceof Error ? error.message : String(error)} ` +
            `— after ${context.speakerWindows.windows} window(s); voice is unaffected`,
        );
      }
    }
  }
  if (frame.seq === undefined) {
    // THE UPLINK CAPTURE'S ONE FEED (see `voice-realtime-audio-capture.ts`). The continuous path is
    // the full microphone stream — silence included — which is the material an offline VAD study
    // needs; the segmented path below is deliberately NOT captured, because a segmenter has already
    // dropped its silence and a corpus of speech-only clips cannot answer a detector question.
    //
    // Sees the frame on ARRIVAL, before the forward, so the audio and the endpoint's judgement
    // timeline are read against one origin. A SIDE CHANNEL: the frame is forwarded unconditionally,
    // and with no capture wired (`?.`) this branch is the bytes it was before the seam existed.
    context.seams.audioCapture?.frame(frame.audio, frame.sourceRate, Date.now());
    // THE WATCHDOG'S READING FOR THE CONTINUOUS WIRE, where the endpoint's own `server_vad` is
    // what endpoints this audio — so if it goes silent, nothing else can tell the relay that an
    // utterance happened (measured 2026-10-12: 118.4 s of total upstream silence, and no report).
    // The segmented path needs no energy gate because it already HAS precise boundaries, the
    // browser's own segmenter's; it hands those to the same watchdog instead (see the
    // `segment_start`/`segment_end` branches). Running this gate there as well would be a
    // second, competing endpointing over audio the segmenter has already decided.
    context.reportLocalSpeechBoundary(context.localSpeechGate.observe(frame.audio));
    // THE `=== null` FAST PATH. With NEITHER gate built this is the exact relay the continuous wire
    // was before either existed — same call, same bytes, same order (AC1/AC2). Checked before any
    // gate work so a default connection never pays for a feature it did not ask for.
    if (context.silenceTail === null && context.uplinkVad === null) {
      context.bridge.sendAudioFrame(frame.audio);
      return;
    }
    // `noteLocalActivity` is called for EVERY browser frame, forwarded or not: the upstream pool
    // reads it as the connection's activity clock, and neither suppressed nor VAD-dropped audio is
    // an idle connection. Called with EITHER gate on, and its count is the BROWSER's frame count,
    // never the forwarded one (AC4).
    context.bridge.noteLocalActivity?.();
    if (context.silenceTail !== null) {
      // SILENCE TAIL SUPPRESSION (decision doc §10). The browser keeps streaming at full rate; what
      // crosses the wire is the gate's decision, not the frame's arrival. The local speech gate
      // above is fed FIRST and unconditionally, so the watchdog's boundaries are unchanged by
      // suppression — which is what keeps a long quiet stretch from ever arming a stall (AC-363
      // V-2: the endpoint's silence clock is AUDIO-time, so it cannot advance on audio nobody sent).
      const decision = context.silenceTail.observe(frame.audio, Date.now());
      for (const forwarded of decision.frames) {
        context.bridge.sendAudioFrame(forwarded);
      }
      if (decision.transition !== null) {
        // The cost phase's structured reading (see `voice-realtime-log.ts`): one line in, one out.
        context.seams.log?.(
          `silence_tail event=${decision.transition} tailMs=${context.silenceTailOptions?.tailMs ?? 0} suppressedMs=${Math.round(
            decision.suppressedMs,
          )} prerollFrames=${decision.preRollFrames}`,
        );
      }
      return;
    }
    // UPLINK VAD (scheme §5). The gate is ASYNC — the classifier answers in frame order with a lag —
    // so frames are chained rather than awaited here, and whatever a call lets through is forwarded
    // as it settles. `localSpeechGate` was fed the frame on ARRIVAL above, unconditionally, so the
    // watchdog's boundaries are the browser's own and never the gate's surviving subset (AC3).
    context.enqueueUplinkVad(frame.audio);
    return;
  }
  context.segmentFrameCounts.set(frame.seq, (context.segmentFrameCounts.get(frame.seq) ?? 0) + 1);
  context.bridge.sendSegmentAudio(frame.seq, frame.audio);
}

/**
 * A segment closes: the pause, the max length, or the end of the stream.
 *
 * An end for a segment this connection never saw open is refused rather than committed: there is
 * no audio to close, and inventing an empty utterance would ask the endpoint for a response to
 * nothing. A repeat of an end already handled is DROPPED rather than committed again: closing one
 * segment twice would put the same audio upstream a second time and ask the endpoint for a second
 * response to it — one utterance billed and relayed twice. Idempotent, and silent on the ack channel
 * because the page already has this segment's answer.
 */
function handleSegmentEnd(
  context: VoiceRealtimeFrameContext,
  _state: VoiceRealtimeFrameConnectionState,
  frame: VoiceRealtimeFramePayload<'segment_end'>,
): void {
  if (!context.segmentFrameCounts.has(frame.seq)) {
    context.seams.log?.(`segment seq=${frame.seq} dropped: no matching segment_start`);
    context.send({ type: 'segment_ack', seq: frame.seq, state: 'dropped', reason: 'unknown-segment' });
    return;
  }
  if (context.endedSegmentSeqs.has(frame.seq)) {
    context.seams.log?.(`segment seq=${frame.seq} end repeated for an already-closed segment, dropped`);
    return;
  }
  context.endedSegmentSeqs.add(frame.seq);
  // SPEC §C4's one line per segment, with the wall clock the log is read against.
  context.seams.log?.(
    `segment seq=${frame.seq} dur=${frame.durationMs ?? 0}ms reason=${frame.reason ?? 'gap'} frames=${
      context.segmentFrameCounts.get(frame.seq) ?? 0
    } at=${new Date().toISOString()}`,
  );
  // The segment's own accounting joins the capture's judgement timeline — the endpoint's decision
  // (which utterance it closed, how long the browser said it ran, how many frames carried it) is
  // exactly what an offline detector's proposals are graded against. Recorded even though the
  // segmented path sends no continuous audio: the timeline is the point, not a rider on the WAV.
  context.seams.audioCapture?.timeline({
    kind: 'segment',
    atMs: Date.now(),
    seq: frame.seq,
    durationMs: frame.durationMs ?? 0,
    frames: context.segmentFrameCounts.get(frame.seq) ?? 0,
  });
  context.bridge.endSegment(frame.seq);
  // The segment is closed and its commit asks the endpoint for an answer. If the endpoint said
  // nothing during the segment, that answer is now owed and the clock starts — see
  // `noteLocalUtteranceEnd`. A DROPPED or repeated end returns above and deliberately does not
  // reach here: no commit left, so no answer is owed and nothing may be reported missing.
  context.bridge.noteLocalUtteranceEnd();
}

/**
 * The browser's own teardown frame.
 *
 * With no uplink VAD built the default connection has no exit pair to flush, so the close frame is
 * the teardown it always was — byte-identical to before that seam existed (AC1/AC5). With the gate
 * on, this close frame is the user's explicit exit, the ONLY trigger for the `commit`+`response.create`
 * pair — NOT the socket's own `close` event, which also fires on a raw drop. The async exit owns the
 * teardown; the socket handler is guarded so the imminent `close` cannot race it.
 */
function handleClose(
  context: VoiceRealtimeFrameContext,
  state: VoiceRealtimeFrameConnectionState,
  _frame: VoiceRealtimeFramePayload<'close'>,
): void {
  context.seams.log?.(
    `teardown: the browser sent a close frame (audio frames received=${state.audioFramesFromBrowser})`,
  );
  if (context.uplinkVad === null) {
    context.teardown();
    return;
  }
  void context.exitUplinkVad();
}

/**
 * Every shipped inbound-frame handler, keyed by the frame kind it answers.
 *
 * Exported as data (rather than only through the factory) so the criterion can enumerate the
 * shipped set and assert each handler's `source` is this file — the registration is a list a
 * reader can see, not a side effect hidden in an import.
 */
export const VOICE_REALTIME_FRAME_HANDLERS: readonly VoiceRealtimeFrameHandler[] = [
  { name: 'hello', label: 'voice-realtime.frame.hello', source: HANDLERS_SOURCE, handle: handleHello },
  { name: 'context', label: 'voice-realtime.frame.context', source: HANDLERS_SOURCE, handle: handleContext },
  {
    name: 'narrator_done',
    label: 'voice-realtime.frame.narrator-done',
    source: HANDLERS_SOURCE,
    handle: handleNarratorDone,
  },
  {
    name: 'run_output',
    label: 'voice-realtime.frame.run-output',
    source: HANDLERS_SOURCE,
    handle: handleRunOutput,
  },
  {
    name: 'segment_start',
    label: 'voice-realtime.frame.segment-start',
    source: HANDLERS_SOURCE,
    handle: handleSegmentStart,
  },
  { name: 'audio', label: 'voice-realtime.frame.audio', source: HANDLERS_SOURCE, handle: handleAudio },
  {
    name: 'segment_end',
    label: 'voice-realtime.frame.segment-end',
    source: HANDLERS_SOURCE,
    handle: handleSegmentEnd,
  },
  { name: 'close', label: 'voice-realtime.frame.close', source: HANDLERS_SOURCE, handle: handleClose },
];

/**
 * Builds the registry a connection ships with.
 *
 * A fresh registry per connection (not a module-level singleton): a criterion's probe
 * registration must not leak into another connection, and the shipped set is re-registered from
 * {@link VOICE_REALTIME_FRAME_HANDLERS} so the default dispatch path is exactly this file's list.
 */
export function createDefaultVoiceRealtimeFrameRegistry(): VoiceRealtimeFrameRegistry {
  const registry = new VoiceRealtimeFrameRegistry();
  for (const handler of VOICE_REALTIME_FRAME_HANDLERS) {
    registry.register(handler);
  }
  return registry;
}
