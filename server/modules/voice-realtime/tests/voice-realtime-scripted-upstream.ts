/**
 * A SCRIPTED stand-in for the DashScope Realtime endpoint — the shared, offline upstream a
 * Live Voice scenario is written against.
 *
 * WHY IT EXISTS. The repository had two stand-ins and neither could carry a scenario. The
 * frozen fixture (`voice-realtime-dashscope-harness.ts`) answers each client frame with ONE
 * fixed reaction, and each real-browser e2e spec hand-rolls its own upstream. So the endpoint
 * events that actually caused production incidents — the endpoint's own `error`, a
 * `response.text.done` where the model answers instead of calling the tool
 * (`MODEL_TEXT_REPLY`), a session that drops — had no stand-in at all, which is why they were
 * only ever found in a journal. This module makes those events scriptable.
 *
 * WHAT IT IS NOT. It never opens a socket and never reads a credential. It is a
 * {@link DashscopeSocketFactory} — exactly the seam the transport's own guard treats as "no
 * real endpoint, no credential": a transport handed this factory and an empty api key dials
 * without complaint, while the same transport WITHOUT the factory refuses with
 * `MISSING_API_KEY`. `dialedUrl` below records which address it dialled, so a scenario can
 * prove the frames it saw came from this script and not from the network.
 *
 * WHAT THE SCRIPT OWNS. Everything after the handshake. `session.update` is still answered
 * with `session.created`/`session.updated` (the transport does not reach `open` without
 * them, and every scenario needs an open session), and every other thing the endpoint says
 * comes from {@link ScriptedUpstream.runScript}. A tool result is acknowledged with
 * `response.done` by default, so the model is never left waiting on a call it made.
 *
 * Consumed by `voice-realtime-scripted-scenarios.test.ts`.
 */
import type { DashscopeSocket, DashscopeSocketFactory } from '../index.js';

/**
 * The address a scripted run dials. Deliberately unroutable: nothing resolves `.invalid`, so
 * even a mistaken real dial could not leave the host.
 */
export const SCRIPTED_ENDPOINT_URL = 'ws://scripted.invalid/api-ws/v1/realtime';

/** One step of a scenario's endpoint script. */
export type ScriptedEndpointEvent = {
  /** The DashScope wire frame to hand the transport, verbatim. */
  wire: Record<string, unknown>;
  /**
   * How long to wait before it, measured from the previous event. The wait is a real
   * macrotask boundary even at 0, so a delivery the previous event started can settle before
   * the next one is announced — the endpoint's own spacing, in miniature.
   */
  afterMs?: number;
};

/** What a scripted run exposes: the factory the transport dials, both traffic logs, the script. */
export type ScriptedUpstream = {
  /** Inject this as the transport's `socketFactory`. */
  readonly socketFactory: DashscopeSocketFactory;
  /** Every client frame the transport emitted, in order. */
  readonly clientFrames: Array<Record<string, unknown>>;
  /** Every endpoint frame this stand-in emitted, in order. */
  readonly endpointFrames: Array<Record<string, unknown>>;
  /** The URL the transport dialled, or `null` before it dialled. */
  readonly dialedUrl: string | null;
  /** The headers the transport dialled with — proof of what credential (if any) was used. */
  readonly dialedHeaders: Readonly<Record<string, string>> | null;
  /** The armed protocol state machine, or `null` when this connection was left to its own script. */
  readonly protocol: ScriptedProtocolState | null;
  /**
   * The armed acoustic detector, or `null` when this connection has none.
   *
   * A GETTER for the same reason {@link protocol} is: the detector is built inside `socketFactory`,
   * one per connection, so a plain property would freeze this at `null`.
   */
  readonly vad: ScriptedVadDetector | null;
  /**
   * Moves the armed detector's clock to `nowMs` — the injected clock, from outside.
   *
   * The stand-in never reads a real clock, so a `wall-clock` detector has no way to notice the
   * client going quiet unless its caller says what time it is. A test steps this directly; the e2e
   * server ticks it from a real interval. A no-op when no detector is armed.
   */
  tick(nowMs: number): void;
  /** Says one frame as the endpoint would, right now. */
  emit(wire: Record<string, unknown>): void;
  /** Says every frame of a script, each after its own delay, in order. Resolves on the last. */
  runScript(events: readonly ScriptedEndpointEvent[]): Promise<void>;
  /** Ends the connection as a network loss would — the socket closes without being asked to. */
  drop(): void;
  /**
   * The fault plan's own reading: how many sockets were dialled and which faults actually fired.
   *
   * A GETTER-backed recorder, like {@link protocol} and {@link vad} — the per-dial counters it reads
   * live inside `socketFactory`, so a plain object would freeze them at their pre-dial values.
   */
  readonly faults: ScriptedFaultRecorder;
};

/** The stand-in's knobs. */
export type ScriptedUpstreamOptions = {
  /** The session id this endpoint claims. */
  sessionId?: string;
  /** Acknowledge a tool result with `response.done`, as the real endpoint does. Default `true`. */
  answerToolResults?: boolean;
  /** Dial attempts that fail before one opens, so a reconnect path can be driven. Default 0. */
  failOpens?: number;
  /**
   * Arms the {@link ScriptedProtocolState} for this connection (see
   * {@link createScriptedProtocolState}). ABSENT BY DEFAULT, and that is the contract: with no
   * `protocol` every frame below is byte-for-byte what this stand-in said before the machine
   * existed, so every existing scenario keeps its own script and its own reading.
   */
  protocol?: ScriptedProtocolOptions;
  /**
   * Arms the endpoint's ACOUSTIC detector for this connection (see {@link createScriptedVad}) — the
   * continuous mode, where the endpoint hears the utterance end by itself and opens the response
   * opportunity without the client asking.
   *
   * ABSENT BY DEFAULT, the same contract as `protocol`: with no `vad` this stand-in answers no
   * `input_audio_buffer.append` at all, so every scenario written against the protocol machine keeps
   * its own reading. The two are alternatives, not layers — a session whose detector the endpoint
   * runs is a session where the client sends no commit (decision doc §5 P-3), and arming both would
   * script two different answers for the same frame.
   */
  vad?: ScriptedVadOptions;
  /**
   * Arms the endpoint's FAULT PLAN (see {@link ScriptedFaultPlan}) — the drops, refusals and
   * lost-event windows a reconnect scenario is written against.
   *
   * ABSENT BY DEFAULT, the same contract as `protocol` and `vad`: with no `faults` every frame below
   * is byte-for-byte what this stand-in said before the plan existed, and the recorder
   * ({@link ScriptedUpstream.faults}) counts nothing but the dials it always dialled.
   */
  faults?: ScriptedFaultPlan;
};

// ------------------------------- F1–F6: the endpoint's fault plan -------------------------------
//
// WHAT THIS IS. The protocol machine above makes the endpoint REACT correctly; it never makes it
// FAIL. Every defect this repository has found in the reconnect path was found in a journal because
// there was no way to make an offline endpoint drop at the third commit, replay a segment and drop
// again 1.15 s later, or lose the events of an item it had already created — so the reading was only
// ever taken from a real incident, after the fact, once.
//
// The plan below is that missing half: a small, DECLARATIVE script of what the endpoint does on each
// DIAL (dial #1, dial #2, … — one entry per socket the transport opens), covering the six shapes the
// 2026-10-12 double-drop journal (`e22ac831`) needs:
//
//   · F1 `disposition`         — this dial accepts / refuses / accepts-then-drops;
//   · F2 `dropBeforeCommit`    — drop when the Nth commit arrives, BEFORE it is answered;
//     `dropOnReplay`           — drop when a segment REPLAYED from an earlier dial arrives;
//     `dropAfterCommitMs`      — drop X ms (on the injected clock) after the Nth commit;
//   · F3 `loseEventsOfCommit`  — the Nth commit is PROCESSED (item created, `committed` advanced) but
//                                none of the frames it would say are delivered; the endpoint goes on
//                                losing answers for the rest of the dial;
//     `dropAfterFunctionCall`  — answer up to and including the model's `function_call`, then drop,
//                                so `response.done` and everything after it is lost;
//   · F4 `dropOnAppendBytesOver` — one `append` larger than N bytes ends the connection;
//   · F5 `clock`               — the injected clock every `afterMs` is measured on (never a real one);
//   · F6 — the SAME plan object is what `e2e/voiceRealtimeScriptedUpstream.ts` reads, so a browser
//          scenario and an in-process criterion can be written against one fault vocabulary.
//
// WHAT IT IS NOT. It never opens a socket, never reads a real clock and never touches a credential.
// The clock is INJECTED: `tick(nowMs)` is the only place time moves, so "206 ms later" and "1.15 s
// later" are exact and instant instead of a real wait.

/** F5: the injected clock every `afterMs` in a fault plan is measured on. */
export type ScriptedFaultClock = {
  /** The current reading — whatever the last {@link tick} said, never a real clock. */
  now(): number;
  /** Moves the clock to `nowMs`. Monotonic readings only; an earlier one is ignored. */
  tick(nowMs: number): void;
};

/** Builds an injected clock, so a scenario's timed drops are exact rather than wall-clock guesses. */
export function createScriptedFaultClock(originMs = 0): ScriptedFaultClock {
  let current = originMs;
  return {
    now: () => current,
    tick(nowMs) {
      if (nowMs > current) current = nowMs;
    },
  };
}

/** F1: what one DIAL of the endpoint does. */
export type ScriptedDialDisposition =
  /** The ordinary dial: it opens and behaves as the protocol machine says. */
  | { action: 'accept' }
  /** The dial is refused — the transport sees `onerror` and the bridge retries. */
  | { action: 'refuse' }
  /** It opens, then the ENDPOINT drops it after `afterMs` (injected clock; `0` = on the next tick). */
  | { action: 'accept-then-drop'; afterMs?: number };

/**
 * F1–F5 applied to ONE dial. Every field is optional; `{}` is a dial with no faults at all.
 *
 * The ordinals (`dropBeforeCommit`, `loseEventsOfCommit`, `dropAfterCommitMs.ordinal`) are 1-based
 * and count the `input_audio_buffer.commit` frames THIS DIAL receives — a reconnect starts the
 * count over, exactly as a fresh socket's endpoint would.
 */
export type ScriptedDialFaults = {
  /** F1 — what this dial does before anything else. Default `accept`. */
  disposition?: ScriptedDialDisposition;
  /** F2 — drop when this dial's Nth commit arrives, BEFORE the endpoint answers it (no `committed`). */
  dropBeforeCommit?: number;
  /** F2 — drop when a commit whose audio this endpoint already saw on an EARLIER dial arrives. */
  dropOnReplay?: boolean;
  /** F2(c)/F5 — drop `ms` (on the injected clock) after this dial's Nth commit. */
  dropAfterCommitMs?: { ordinal: number; ms: number };
  /** F3 — process this dial's Nth commit, deliver none of its frames (and lose later answers too). */
  loseEventsOfCommit?: number;
  /** F3 — answer up to and including a `function_call`, then drop (the lost `response.done`). */
  dropAfterFunctionCall?: boolean;
  /** F4 — drop when ONE `input_audio_buffer.append`'s decoded audio exceeds this many bytes. */
  dropOnAppendBytesOver?: number;
};

/** F1–F6: the endpoint's whole fault plan, one entry per dial. */
export type ScriptedFaultPlan = {
  /** The faults for dial N (1-based). Dials past the end behave as `{}` — accepted, fault-free. */
  dials: readonly ScriptedDialFaults[];
  /** F5 — the clock `afterMs` is measured on. A private one is built when absent. */
  clock?: ScriptedFaultClock;
};

/** One fault the plan actually fired, for a scenario to read back what happened. */
export type ScriptedFaultRecord = {
  /** Which dial it fired on (1-based). */
  dial: number;
  /** What the endpoint did, in the plan's own terms. */
  reason: string;
};

/**
 * The plan's reading, taken while the scenario runs.
 *
 * `dials()` is the number of sockets the transport has opened — the reconnect count a criterion about
 * "it must redial" is written against, without counting anything else. `fired()` is the fault script
 * itself, in order, so a criterion can say WHICH drop it is reading rather than inferring it from a
 * frame's absence.
 */
export type ScriptedFaultRecorder = {
  /** How many sockets the transport has dialled so far. */
  dials(): number;
  /** Every fault that actually fired, in order. */
  fired(): readonly ScriptedFaultRecord[];
  /**
   * F5 — moves the injected clock and fires every drop whose deadline has passed.
   *
   * The ONLY place time moves for a fault plan: a `dropAfterCommitMs` is exact and instant, never a
   * real wait. A no-op (and nothing fires) when no plan is armed.
   */
  tick(nowMs: number): void;
  /** The plan as armed, or `null` — what the stand-in was actually told to do. */
  plan(): ScriptedFaultPlan | null;
};

const DEFAULT_SCRIPTED_SESSION_ID = 'sess_scripted_0000000000000000';

/** A macrotask boundary, so pending deliveries settle between two scripted events. */
function yieldToEventLoop(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds the scripted stand-in. */
export function createScriptedUpstream(options: ScriptedUpstreamOptions = {}): ScriptedUpstream {
  const sessionId = options.sessionId ?? DEFAULT_SCRIPTED_SESSION_ID;
  const answerToolResults = options.answerToolResults ?? true;

  const clientFrames: Array<Record<string, unknown>> = [];
  const endpointFrames: Array<Record<string, unknown>> = [];
  let socket: DashscopeSocket | null = null;
  let dialedUrl: string | null = null;
  let dialedHeaders: Readonly<Record<string, string>> | null = null;
  let createdAnnounced = false;
  let remainingFailingOpens = options.failOpens ?? 0;
  /**
   * The armed machine for the CURRENT connection. Rebuilt on every dial, so a reconnect starts
   * from a clean session — its own `turn_detection` reading is re-established by the `session.update`
   * the transport replays. `null` when no `protocol` was configured.
   */
  let protocol: ScriptedProtocolState | null = null;
  /** The armed acoustic detector for the CURRENT connection — rebuilt on every dial, like `protocol`. */
  let vad: ScriptedVadDetector | null = null;

  /** Says one frame, recording it whether or not a socket is attached yet. */
  function emit(wire: Record<string, unknown>): void {
    endpointFrames.push(wire);
    socket?.onmessage?.({ data: JSON.stringify(wire) });
  }

  // ---------------------------- the fault plan's own state (F1–F6) ----------------------------
  //
  // Every line below is inert while `options.faults` is undefined: `faultsPlan` stays null, so the
  // branches that consult it never run and the stand-in says exactly what it said before the plan
  // existed. That is the contract `protocol` and `vad` carry too, and it is what lets a scenario
  // written against the old stand-in keep its old reading.
  const faultsPlan = options.faults ?? null;
  /** F5: the injected clock — a private one unless the scenario shares its own. */
  const faultClock = faultsPlan?.clock ?? createScriptedFaultClock();
  const faultRecords: ScriptedFaultRecord[] = [];
  /** Dials the transport has opened. 1-based; the plan's `dials[0]` is dial #1. */
  let faultDial = 0;
  /** Commit frames THIS dial has received — a reconnect starts the ordinal count over. */
  let dialCommits = 0;
  /** The append audio seen on THIS dial since its last commit — the replay fingerprint. */
  let dialAudio: string[] = [];
  /** Fingerprints of every committed segment this endpoint has ever seen, across every dial. */
  const seenSegments = new Set<string>();
  /** F3: this dial's state advances but nothing is said — the "processed, then lost" window. */
  let losingAnswers = false;
  /** F2(c)/F5: the injected-clock reading a pending timed drop fires at, or `null`. */
  let dropDueAt: { at: number; reason: string } | null = null;

  function recordFault(reason: string): void {
    faultRecords.push({ dial: faultDial, reason });
  }

  /** Ends the CURRENT connection the way a network loss does, recording why it happened. */
  function faultDrop(reason: string): void {
    dropDueAt = null;
    recordFault(reason);
    socket?.onclose?.({ code: 1006, reason: 'the scripted endpoint dropped the connection' });
  }

  /** The plan's faults for dial `dial` (1-based). Past the end: no faults — accepted, ordinary. */
  function dialFaultsFor(dial: number): ScriptedDialFaults {
    return faultsPlan?.dials[dial - 1] ?? {};
  }

  /**
   * F2/F3/F4 — applies the plan to one incoming frame, BEFORE the machine is asked what it would say.
   *
   * A drop is the endpoint refusing to answer at all, so it cannot be decided after the answer has
   * already been emitted. Returns `true` when the connection was dropped and the caller must stop.
   */
  function applyPlan(frame: Record<string, unknown>, dialFaults: ScriptedDialFaults): boolean {
    if (frame.type === 'input_audio_buffer.append') {
      const audio = typeof frame.audio === 'string' ? frame.audio : '';
      if (dialFaults.dropOnAppendBytesOver !== undefined) {
        const bytes = Buffer.from(audio, 'base64').length;
        if (bytes > dialFaults.dropOnAppendBytesOver) {
          faultDrop(`one append of ${bytes} bytes is over the ${dialFaults.dropOnAppendBytesOver}-byte ceiling`);
          return true;
        }
      }
      dialAudio.push(audio);
      return false;
    }
    if (frame.type !== 'input_audio_buffer.commit') return false;

    dialCommits += 1;
    const ordinal = dialCommits;
    const fingerprint = dialAudio.join('|');
    dialAudio = [];
    const isReplay = fingerprint !== '' && seenSegments.has(fingerprint);
    seenSegments.add(fingerprint);

    if (dialFaults.dropOnReplay === true && isReplay) {
      faultDrop('a segment whose audio this endpoint already answered on an earlier dial was replayed');
      return true;
    }
    if (dialFaults.dropBeforeCommit === ordinal) {
      faultDrop(`commit #${ordinal} arrived while the endpoint was not answering`);
      return true;
    }
    if (dialFaults.dropAfterCommitMs?.ordinal === ordinal) {
      const { ms } = dialFaults.dropAfterCommitMs;
      dropDueAt = { at: faultClock.now() + ms, reason: `commit #${ordinal} plus ${ms} ms` };
    }
    if (dialFaults.loseEventsOfCommit === ordinal) {
      // F3 — the endpoint takes the audio and advances its own state, and the client is told
      // nothing: no `committed`, no item, no transcript. It goes on losing answers this dial.
      losingAnswers = true;
    }
    return false;
  }

  /** F5 — moves the injected clock and fires any drop whose deadline it has passed. */
  function tickFaults(nowMs: number): void {
    if (faultsPlan === null) return;
    faultClock.tick(nowMs);
    if (dropDueAt !== null && faultClock.now() >= dropDueAt.at) {
      faultDrop(dropDueAt.reason);
    }
  }

  const socketFactory: DashscopeSocketFactory = (url, headers) => {
    dialedUrl = url;
    dialedHeaders = headers;
    faultDial += 1;
    dialCommits = 0;
    dialAudio = [];
    losingAnswers = false;
    const dialFaults = dialFaultsFor(faultDial);
    const disposition = dialFaults.disposition ?? { action: 'accept' };
    if (remainingFailingOpens > 0 || disposition.action === 'refuse') {
      if (remainingFailingOpens > 0) remainingFailingOpens -= 1;
      if (faultsPlan !== null) {
        recordFault(
          disposition.action === 'refuse' ? 'the plan refused this dial' : 'a dial the stand-in was told to fail',
        );
      }
      // A refused dial: the failure arrives on the next tick, as a real socket's would.
      const refused: DashscopeSocket = {
        send() {},
        close() {},
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      queueMicrotask(() => refused.onerror?.(new Error(`scripted endpoint: dial refused`)));
      return refused;
    }
    const active: DashscopeSocket = {
      send(data: string) {
        // Record the transport's own frame first, then answer the two frames the endpoint
        // must answer for a session to exist at all. Everything else is the script's to say.
        const frame = JSON.parse(data) as Record<string, unknown>;
        clientFrames.push(frame);
        // The fault plan is consulted FIRST: a drop means the endpoint never answers, which is
        // invisible if the answer has already been said. Disarmed, this block never runs.
        if (faultsPlan !== null && applyPlan(frame, dialFaults)) return;
        // The armed machine answers the frames a real endpoint reacts to (a commit, a
        // `response.create`, a cancel). Disarmed, this loop never runs and nothing below changes.
        const answers: Array<Record<string, unknown>> = [];
        if (protocol !== null) {
          for (const answer of protocol.receive(frame)) answers.push(answer);
        }
        // The acoustic detector answers the frames only IT can answer — an append carrying sound,
        // and the frames a client sends only when the endpoint's detector is off. Disarmed, this
        // loop never runs and an append is met with silence, exactly as before it existed.
        if (vad !== null) {
          for (const answer of vad.receive(frame)) answers.push(answer);
        }
        // F3's first shape: this dial is losing its answers, so the machine's state advances and
        // none of it is said. The handshake below still runs — a reconnect has to be able to open.
        if (losingAnswers) {
          answers.length = 0;
        } else if (faultsPlan !== null && dialFaults.dropAfterFunctionCall === true) {
          // F3's second shape: answer up to and including the model's call, then drop, so
          // `response.done` and everything after it is lost — the reconnect then replays a
          // segment whose tool call the session already made.
          const callAt = answers.findIndex(
            (answer) => (answer as { type?: unknown }).type === 'response.function_call_arguments.done',
          );
          if (callAt >= 0) {
            for (const answer of answers.slice(0, callAt + 1)) emit(answer);
            faultDrop("the connection was lost right after the model's function call");
            return;
          }
        }
        for (const answer of answers) emit(answer);
        if (frame.type === 'session.update') {
          if (!createdAnnounced) {
            createdAnnounced = true;
            emit({
              type: 'session.created',
              session: { id: sessionId, object: 'realtime.session', model: 'scripted-model', modalities: ['text'] },
            });
          }
          emit({ type: 'session.updated', session: { id: sessionId, object: 'realtime.session', modalities: ['text'] } });
          return;
        }
        if (answerToolResults && frame.type === 'conversation.item.create') {
          const item = frame.item as Record<string, unknown> | undefined;
          if (item?.type === 'function_call_output') {
            emit({ type: 'response.done', response: { id: 'resp_scripted_0000', status: 'completed' } });
          }
        }
      },
      close() {
        active.onclose?.({ code: 1000, reason: 'the client closed the connection' });
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    socket = active;
    protocol = options.protocol === undefined ? null : createScriptedProtocolState(options.protocol);
    vad = options.vad === undefined ? null : createScriptedVad(options.vad);
    if (faultsPlan !== null && disposition.action === 'accept-then-drop') {
      const afterMs = disposition.afterMs ?? 0;
      dropDueAt = {
        at: faultClock.now() + afterMs,
        reason: `the dial was dropped ${afterMs} ms after it opened`,
      };
    }
    // The transport attaches its handlers synchronously after the factory returns, so opening
    // on the next microtask is after they are attached.
    queueMicrotask(() => active.onopen?.({}));
    return active;
  };

  return {
    socketFactory,
    clientFrames,
    endpointFrames,
    get dialedUrl(): string | null {
      return dialedUrl;
    },
    get dialedHeaders(): Readonly<Record<string, string>> | null {
      return dialedHeaders;
    },
    // A GETTER, not a copy: the machine is built inside `socketFactory`, so a plain property would
    // freeze this at `null` and say a reconnected run has no machine when it has a fresh one.
    get protocol(): ScriptedProtocolState | null {
      return protocol;
    },
    get vad(): ScriptedVadDetector | null {
      return vad;
    },
    tick(nowMs: number): void {
      // The endpoint frames a wall-clock close produces are said exactly as any other frame is, so
      // they land in `endpointFrames` and reach the transport like the rest of the script.
      // One reading drives both armed clocks — the detector's and the fault plan's — so a scenario
      // says what time it is once.
      tickFaults(nowMs);
      if (vad === null) return;
      for (const answer of vad.advance(nowMs)) emit(answer);
    },
    emit,
    async runScript(events: readonly ScriptedEndpointEvent[]): Promise<void> {
      for (const event of events) {
        await yieldToEventLoop(event.afterMs ?? 0);
        emit(event.wire);
      }
      // One more boundary, so the delivery the LAST event started has settled before the
      // caller starts asserting.
      await yieldToEventLoop(0);
    },
    drop(): void {
      socket?.onclose?.({ code: 1006, reason: 'the scripted endpoint dropped the connection' });
    },
    // The plan's own reading, built from the per-dial counters that live in `socketFactory` — so
    // these are FUNCTIONS, not values, for the same reason `protocol` and `vad` are getters.
    faults: {
      dials: () => faultDial,
      fired: () => faultRecords.slice(),
      tick: tickFaults,
      plan: () => faultsPlan,
    },
  };
}

// --------------------------- the endpoint's own event vocabulary ---------------------------

/**
 * One interim transcription. The running words travel in `stash` while `text` stays EMPTY —
 * that asymmetry is the real endpoint's, and reading `text` here would produce an empty
 * caption on every interim event (`voice-realtime-bridge.service.ts`'s `handleCaption`).
 */
export function captionDelta(itemId: string, stash: string): Record<string, unknown> {
  return { type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, text: '', stash };
}

/** One closed utterance. The final words travel in `transcript`. */
export function captionCompleted(itemId: string, transcript: string): Record<string, unknown> {
  return { type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript };
}

/** The model's tool call. `arguments` is a JSON STRING on the wire, never an object. */
export function functionCall(name: string, args: Record<string, unknown>, callId: string): Record<string, unknown> {
  return { type: 'response.function_call_arguments.done', call_id: callId, name, arguments: JSON.stringify(args) };
}

/**
 * The model's tool call with `arguments` it never managed to finish — a call the endpoint really does
 * put on the wire when a generation is cut off mid-arguments.
 *
 * WHY IT IS A SEPARATE BUILDER AND NOT `functionCall` WITH A BAD OBJECT. {@link functionCall} takes a
 * Record and stringifies it, so the only thing it can produce is valid JSON of an object; a stand-in
 * written with it can never reach the bridge's `MALFORMED_FUNCTION_CALL` throw. This one takes the
 * RAW string, so the caller states the broken shape itself — `'{"intent": '` (not JSON at all) or
 * `'[]'` (JSON, but not an object) — which are the two shapes the bridge refuses
 * (`voice-realtime-bridge.service.ts`). The transport deliberately does NOT report either one
 * (`validateDeclaredCall` answers `null` for both), so the bridge is the single reporter and the page
 * sees exactly one `recoverable: true` error frame.
 *
 * Its consumers are the criteria that inject that fault: `e2e/voiceRealtimeScriptedUpstream.ts`
 * re-exports this vocabulary verbatim for the browser specs, and
 * `e2e/voice-realtime-intent-control.spec.ts` (case 6) is the one that sends both shapes at a
 * correction.
 */
export function malformedFunctionCall(
  name: string,
  rawArguments: string,
  callId: string,
): Record<string, unknown> {
  return { type: 'response.function_call_arguments.done', call_id: callId, name, arguments: rawArguments };
}

/** The endpoint reporting its own failure — the shape the bridge turns into `UPSTREAM_ERROR`. */
export function endpointError(code: string, message: string): Record<string, unknown> {
  return { type: 'error', error: { code, message } };
}

/**
 * The endpoint's own failure as the REAL upstream frames it: the KIND travels in `error.type`
 * (`invalid_request_error`, `InternalError.Algo.InvalidParameter`, …), not in `error.code`.
 *
 * The distinction is load-bearing. `endpointError` above writes `code`, which the bridge's
 * `UPSTREAM_ERROR` handler DOES read — so a stand-in written with it proves nothing about the
 * frames the real endpoint sends. The 2026-10-12 journal (`ef9daacd`) logged the empty-buffer
 * refusal as `{"type":"invalid_request_error","message":"Error committing input audio buffer: …"}`:
 * a `type`, and no `code` at all. A stand-in that has to reproduce that frame needs the same field.
 *
 * `code` is optional and additive, for a frame that carries both.
 */
export function upstreamError(type: string, message: string, code?: string): Record<string, unknown> {
  return { type: 'error', error: { type, ...(code === undefined ? {} : { code }), message } };
}

/** The endpoint acknowledging a `response.cancel`: the response it stopped, and nothing else. */
export function responseCancelled(responseId: string | null = null): Record<string, unknown> {
  return { type: 'response.cancelled', response: { id: responseId } };
}

/**
 * The model REPLYING IN TEXT instead of calling the tool — `MODEL_TEXT_REPLY`.
 *
 * Not a hypothetical: on 2026-10-11 a real Live Voice session lost six of seven utterances
 * this way (the model answered "OK" instead of calling `session_send`, even with
 * `tool_choice: required`). The bridge treats a non-empty reply as a fault, and no stand-in
 * could produce it before this builder.
 */
export function modelTextReply(text: string, responseId?: string): Record<string, unknown> {
  // `responseId` is optional and additive: a reply that names the response it closes is how the
  // bridge tells the model's expected remark on a tool result (a follow-up) from a real reply.
  return responseId === undefined ? { type: 'response.text.done', text } : { type: 'response.text.done', text, response_id: responseId };
}

/** A spoken segment the endpoint could not transcribe — `TRANSCRIPTION_FAILED`. */
export function transcriptionFailed(itemId: string, message: string): Record<string, unknown> {
  return { type: 'conversation.item.input_audio_transcription.failed', item_id: itemId, error: { message } };
}

// ------------------- the endpoint's turn narration (replay of a recorded session) -------------------
//
// The frames below are TOLERATED by the bridge (it does not act on most of them), but their ORDER
// relative to the commit, the transcript and the model's call is what a recorded session's journal
// shows — so a replay of that journal has to be able to say them. Shapes follow the real wire as the
// 2026-10-12 journal (`ef9daacd`) logged it.

/** The endpoint accepting a commit: the audio is now an input item. */
export function audioCommitted(itemId: string, previousItemId: string | null = null): Record<string, unknown> {
  return { type: 'input_audio_buffer.committed', item_id: itemId, previous_item_id: previousItemId };
}

/** A user audio item entering the conversation (`conversation.item.created`, role `user`). */
export function userItemCreated(itemId: string, previousItemId: string | null = null): Record<string, unknown> {
  return {
    type: 'conversation.item.created',
    previous_item_id: previousItemId,
    item: { id: itemId, object: 'realtime.item', type: 'message', role: 'user', status: 'completed', content: [{ type: 'input_audio' }] },
  };
}

/** The endpoint's own detector announcing speech — on a manual-commit wire, a sign its VAD is on. */
export function speechStarted(itemId: string | null = null): Record<string, unknown> {
  return { type: 'input_audio_buffer.speech_started', audio_start_ms: 0, item_id: itemId };
}

/**
 * The endpoint's own detector announcing the end of speech — the frame the WHOLE continuous path
 * hinges on, because the auto-commit and the automatic response follow it.
 *
 * It exists as its own builder rather than as a variant of {@link speechStarted} because the two
 * are read apart: a scenario that only ever saw `speech_started` cannot tell "the detector opened a
 * turn" from "the detector closed one", and a stand-in whose detector never closes leaves the
 * client waiting for a commit that its own protocol forbids it to send (decision doc §5 P-3).
 */
export function speechStopped(itemId: string | null = null, audioEndMs = 0): Record<string, unknown> {
  return { type: 'input_audio_buffer.speech_stopped', audio_end_ms: audioEndMs, item_id: itemId };
}

/** A model response beginning. */
export function responseCreated(responseId: string): Record<string, unknown> {
  return { type: 'response.created', response: { id: responseId, object: 'realtime.response', status: 'in_progress' } };
}

/** A model response finishing. `usage`, when given, rides inside `response` — the endpoint's own cost block. */
export function responseDone(responseId: string, usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'response.done',
    response: {
      id: responseId,
      object: 'realtime.response',
      status: 'completed',
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

// --------------------------- the endpoint's protocol state machine ---------------------------
//
// WHAT THIS IS. The builders above let a scenario SAY a frame. They cannot make a scenario REACT,
// and the endpoints that caused incidents react to what the client actually sent: a commit lands on
// a buffer the endpoint's own detector was already holding and is refused; an item is transcribed
// three commits after it was created. Replaying a journal by hand-writing every frame cannot show
// whether the CLIENT caused the endpoint's answer, because the answer is chosen by the scenario.
//
// The machine below is the endpoint's own side of the protocol, as a PURE reducer: hand it a client
// frame, get back the endpoint frames to say. It opens no socket, reads no clock and touches no
// credential, so the same object drives the in-process stand-in ({@link createScriptedUpstream}'s
// `protocol` option) and the real `ws` server in `e2e/voiceRealtimeScriptedUpstream.ts`.
//
// WHAT MAKES IT A FALSIFIABLE STAND-IN AND NOT ANOTHER SCRIPT. Its reactions are a function of the
// session's CURRENT `turn_detection`, read off every `session.update` the client sends. A session
// that keeps its own detector off (the segmented path's switch, `session.turn_detection: null`)
// gets manual commits; a session whose detector is on gets the endpoint's VAD — the refusal, the
// `speech_started`, and the item the endpoint created by itself. So a scenario that arms the machine
// and sends nothing but its own real frames reproduces the 2026-10-12 defect EXACTLY WHEN the
// client re-opens the detector, and reproduces the fixed wire when it does not. That is what makes
// `e2e/voice-realtime-segmented-replay-20261012.spec.ts`'s variant R a reading of the product
// rather than a reading of its own script.

/**
 * When one input item's transcript reaches the client.
 *
 * The real endpoint transcribes asynchronously, and the ledger at
 * `~/.cloudcli/voice-realtime-log/ef9daacd-*.jsonl` shows all five shapes: a `completed` beside the
 * commit that created the item; one several commits later; one arriving after a LATER item's own
 * transcript (what an out-of-order relay looks like from the wire); one that never comes; and a
 * `transcription.failed`.
 */
export type ScriptedTranscriptPlan =
  /** Lands in the same answer as the commit that created the item. */
  | { kind: 'on-time'; text: string }
  /** Lands `commits` commits after its own (`1` = with the next commit). */
  | { kind: 'after'; commits: number; text: string }
  /** Lands with the commit whose zero-based ordinal is `ordinal` — earlier or later than its own. */
  | { kind: 'at-commit'; ordinal: number; text: string }
  /** Never transcribed at all. */
  | { kind: 'never' }
  /** The endpoint reports it could not transcribe the item. */
  | { kind: 'failed'; message: string };

/** What an answered `response.create` says — the three shapes the model's turn takes. */
export type ScriptedAnswer =
  /** A tool call: `response.created` · `response.function_call_arguments.done` · `response.done`. */
  | { kind: 'function_call'; name: string; args: Record<string, unknown> }
  /** The model replying in text — the `response.text.done` the bridge reports as `MODEL_TEXT_REPLY`. */
  | { kind: 'text'; text: string }
  /** The endpoint opens and closes the response saying nothing at all. */
  | { kind: 'none' };

/** Whether a `response.create` is answered, and whether the session's own detector can swallow it. */
export type ScriptedResponsePolicy =
  /** Answered with the plan's (or the machine's) {@link ScriptedAnswer}. */
  | 'answer'
  /** No frame at all — the response the client asked for is silently dropped. */
  | 'withhold'
  /** Answered only while the session's detector is OFF; swallowed (nothing) while it is ON. */
  | 'swallow-under-vad';

/** One commit's script: the item it creates, its transcript, and the response that follows it. */
export type ScriptedCommitPlan = {
  /** The item id this commit creates. Default `item_scripted_<ordinal>`. */
  itemId?: string;
  /** When (and whether) the item is transcribed. Default: never. */
  transcript?: ScriptedTranscriptPlan;
  /** What the `response.create` that follows this commit gets. Default: the machine's policy. */
  response?: ScriptedResponsePolicy;
  /** What an answered response says. Default: the machine's answer. */
  answer?: ScriptedAnswer;
  /** Announce `input_audio_buffer.speech_started` for this commit, as a live detector would. */
  speechStarted?: boolean;
};

/** The knobs of the endpoint's protocol state machine. Every one is optional. */
export type ScriptedProtocolOptions = {
  /** The detector the session starts with, before any `session.update`. Default `'server_vad'`. */
  initialTurnDetection?: 'server_vad' | null;
  /**
   * Whether a commit made while the session's own detector is ON is refused with the endpoint's
   * `buffer too small, or have no audio` error. Default `true` — the real refusal, verbatim from
   * the 2026-10-12 journal.
   */
  refuseEmptyBufferUnderVad?: boolean;
  /** The per-commit script, consumed one entry per `input_audio_buffer.commit`. */
  commits?: readonly ScriptedCommitPlan[];
  /** The policy for a `response.create` no commit plan claims. Default `'answer'`. */
  response?: ScriptedResponsePolicy;
  /** The answer for a `response.create` no commit plan claims. Default `{ kind: 'none' }`. */
  answer?: ScriptedAnswer;
  /**
   * What a `function_call_output`'s synthesized resume `response.create` is answered with. Default
   * `{ kind: 'none' }` — the endpoint closes the turn without the model saying anything, which is
   * NOT the journal's `"OK"` (`MODEL_TEXT_REPLY`): a scenario that wants that reply asks for it.
   */
  toolResumeAnswer?: ScriptedAnswer;
  /** Attached to every `response.done` the machine emits — the endpoint's own usage block. */
  responseUsage?: Record<string, unknown>;
};

/** The endpoint's protocol, as an object a transport-agnostic caller drives by handing it frames. */
export type ScriptedProtocolState = {
  /** Hands one client frame in; returns the endpoint frames to say back, in order. */
  receive(frame: Record<string, unknown>): Array<Record<string, unknown>>;
  /** The `turn_detection` the session currently has, read off every `session.update` it received. */
  readonly turnDetection: 'server_vad' | null;
  /** How many `input_audio_buffer.commit` frames the machine has answered. */
  readonly committed: number;
  /** Every input item id the machine has created, in order. */
  readonly items: ReadonlyArray<string>;
};

/**
 * The real endpoint's refusal, verbatim, when a commit lands on a buffer its own detector was
 * already holding — the message the 2026-10-12 journal logged (07:47:49.034Z).
 */
const EMPTY_BUFFER_MESSAGE = 'Error committing input audio buffer: buffer too small, or have no audio.';

/** Whether a `turn_detection` value off the wire means the session's own detector is on. */
const detectorIsOn = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'server_vad';

/**
 * Builds the endpoint's protocol state machine.
 *
 * Consumed by {@link createScriptedUpstream} (its `protocol` option), directly by
 * `voice-realtime-scripted-upstream-state.test.ts`, and re-exported for
 * `e2e/voiceRealtimeScriptedUpstream.ts`.
 */
export function createScriptedProtocolState(options: ScriptedProtocolOptions = {}): ScriptedProtocolState {
  const plans = options.commits ?? [];
  const defaultPolicy = options.response ?? 'answer';
  const defaultAnswer = options.answer ?? ({ kind: 'none' } as const);
  const toolResumeAnswer = options.toolResumeAnswer ?? ({ kind: 'none' } as const);
  const refuseUnderVad = options.refuseEmptyBufferUnderVad ?? true;

  // `=== undefined`, NOT `??`: an explicit `null` is the whole point of this option — a session that
  // starts with its detector OFF — and `null ?? 'server_vad'` would silently turn it back on.
  let turnDetection: 'server_vad' | null =
    options.initialTurnDetection === undefined ? 'server_vad' : options.initialTurnDetection;
  let committed = 0;
  let responseSeq = 0;
  let lastResponseId: string | null = null;
  /** Set by a tool result the client returned; the NEXT `response.create` is its synthesized resume. */
  let awaitingToolResume = false;
  /** The plan of the commit most recently created — what the next non-resume `response.create` is about. */
  let current: ScriptedCommitPlan | undefined;
  const items: string[] = [];
  /** Transcripts a plan placed on a LATER commit's answer (a late/out-of-order relay). */
  const deferred: Array<{ at: number; itemId: string; plan: ScriptedTranscriptPlan }> = [];

  /**
   * The frames one transcript plan says when it comes DUE, or `[]` for a plan that never speaks.
   *
   * `after`/`at-commit` are scheduling kinds — the caller stores them until their ordinal arrives
   * and then calls this — so they land here, not below: a deferred plan that rendered as `[]` would
   * schedule a transcript and then say nothing, which is the `never` case by accident.
   */
  function transcriptNow(itemId: string, plan: ScriptedTranscriptPlan): Array<Record<string, unknown>> {
    if (plan.kind === 'on-time' || plan.kind === 'after' || plan.kind === 'at-commit') {
      return [captionCompleted(itemId, plan.text)];
    }
    if (plan.kind === 'failed') return [transcriptionFailed(itemId, plan.message)];
    return [];
  }

  /** The frames one `response.create` gets, and the `response.id` it opened (for a later cancel). */
  function answerCreate(policy: ScriptedResponsePolicy, answer: ScriptedAnswer): Array<Record<string, unknown>> {
    if (policy === 'withhold') return [];
    if (policy === 'swallow-under-vad' && turnDetection !== null) return [];
    const id = `resp_scripted_${responseSeq}`;
    responseSeq += 1;
    lastResponseId = id;
    const frames: Array<Record<string, unknown>> = [responseCreated(id)];
    if (answer.kind === 'function_call') frames.push(functionCall(answer.name, answer.args, `call_scripted_${responseSeq}`));
    else if (answer.kind === 'text') frames.push(modelTextReply(answer.text, id));
    frames.push(responseDone(id, options.responseUsage));
    return frames;
  }

  /** The endpoint's answer to one `input_audio_buffer.commit`. */
  function onCommit(): Array<Record<string, unknown>> {
    const ordinal = committed;
    committed += 1;
    const plan = plans[ordinal] ?? {};
    current = plan;
    const itemId = plan.itemId ?? `item_scripted_${ordinal}`;
    const previous = items.length > 0 ? items[items.length - 1]! : null;
    items.push(itemId);

    const frames: Array<Record<string, unknown>> = [];
    if (turnDetection !== null && refuseUnderVad) {
      // The detector owns the buffer. The client's commit lands on an utterance the endpoint is
      // still holding and is refused; the endpoint then says the item its OWN detector created for
      // the audio it kept — the exact three frames the 2026-10-12 journal logged after seq1.
      frames.push(upstreamError('invalid_request_error', EMPTY_BUFFER_MESSAGE));
      frames.push(speechStarted(itemId));
      frames.push(userItemCreated(itemId, previous));
    } else {
      frames.push(audioCommitted(itemId, previous));
      frames.push(userItemCreated(itemId, previous));
      if (plan.speechStarted) frames.push(speechStarted(itemId));
    }

    // This commit's own transcript (if it is due now), then anything an EARLIER item parked on this
    // ordinal — so a plan's late transcript follows the transcript of the item created here.
    const transcript = plan.transcript ?? ({ kind: 'never' } as const);
    if (transcript.kind === 'on-time' || transcript.kind === 'failed') frames.push(...transcriptNow(itemId, transcript));
    else if (transcript.kind === 'after') deferred.push({ at: ordinal + transcript.commits, itemId, plan: transcript });
    else if (transcript.kind === 'at-commit') deferred.push({ at: transcript.ordinal, itemId, plan: transcript });
    for (let i = deferred.length - 1; i >= 0; i -= 1) {
      if (deferred[i]!.at === ordinal) {
        const due = deferred.splice(i, 1)[0]!;
        frames.push(...transcriptNow(due.itemId, due.plan));
      }
    }
    return frames;
  }

  function receive(frame: Record<string, unknown>): Array<Record<string, unknown>> {
    switch (frame.type) {
      case 'session.update': {
        const session = frame.session as Record<string, unknown> | undefined;
        if (session !== undefined && 'turn_detection' in session) {
          turnDetection = detectorIsOn(session.turn_detection) ? 'server_vad' : null;
        }
        return [];
      }
      case 'input_audio_buffer.commit':
        return onCommit();
      case 'conversation.item.create': {
        const item = frame.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call_output') awaitingToolResume = true;
        return [];
      }
      case 'response.create': {
        if (awaitingToolResume) {
          awaitingToolResume = false;
          return answerCreate('answer', toolResumeAnswer);
        }
        return answerCreate(current?.response ?? defaultPolicy, current?.answer ?? defaultAnswer);
      }
      case 'response.cancel':
        return [responseCancelled(lastResponseId)];
      default:
        return [];
    }
  }

  return {
    receive,
    get turnDetection(): 'server_vad' | null {
      return turnDetection;
    },
    get committed(): number {
      return committed;
    },
    get items(): ReadonlyArray<string> {
      return items;
    },
  };
}

// ------------------- the endpoint's ACOUSTIC VAD (a detector-driven continuous session) -------------------
//
// WHAT THIS IS. The protocol machine above reacts to what the CLIENT sends. The real `server_vad`
// endpoint additionally reacts to the SOUND: it hears an utterance begin and end by itself, and the
// response opportunity that follows an utterance is one the CLIENT never asked for (decision doc §4
// R-1: "说完 → response 机会最短、不依赖我方 commit 时序"). A stand-in that could not hear would make
// every continuous-mode reading a reading of the scenario author's beliefs rather than of the wire.
//
// SO THIS DETECTOR LISTENS. It decodes the PCM16 the client appends, measures each frame's peak
// amplitude against `threshold`, and closes an utterance once the silence AFTER speech reaches
// `silence_duration_ms` — then says the four frames the real endpoint says (`speech_stopped`, the
// commit, the user item with its transcript) and opens the model's opportunity on its own.
//
// THE TIME BASE IS A SWITCH, AND IT IS NOT ASSUMED. Whether the real endpoint measures that silence
// in RECEIVED SAMPLES (`audio-time`) or in ELAPSED TIME (`wall-clock`) is an OPEN QUESTION — AC-363
// V-1 answers it on the real endpoint, and the decision doc forbids presupposing it. The two behave
// differently in exactly the case Silence Tail Suppression is built around, a client that STOPS
// TRANSMITTING: an audio-time detector's clock is frozen while no frames arrive, so its tail alone
// must be long enough to trigger the close; a wall-clock detector keeps counting and can end the
// turn with no further audio at all. Both are implemented below, `timeBase` is a REQUIRED option,
// and no caller can get one of them by forgetting to choose — which is what makes the criterion's
// false form (both bases sharing one implementation) a reading that can go red.
//
// WHAT IT IS NOT. It never opens a socket, never reads a real clock and never touches a credential.
// Its clock is INJECTED: `receive()` reads no clock at all and `advance(nowMs)` is the only place
// time moves, so an in-process criterion steps it and the e2e server ticks it from a real interval.

/** Which clock the endpoint's silence detector runs on — the unknown of decision doc §10.3 V-1. */
export type ScriptedVadTimeBase = 'audio-time' | 'wall-clock';

/**
 * What the model does at one response opportunity — the five shapes decision doc §3 X-2/X-4/X-5
 * measure, as ONE value a scenario sets per utterance.
 *
 *  · `forward`   — calls `session_send` with this utterance's text (plus anything a previous
 *                  `wait` deferred). The only policy that delivers.
 *  · `silent`    — the model says nothing and calls no tool (E-2's 不转发): an unforwarded item.
 *  · `wait`      — says nothing NOW and defers this text into the NEXT opportunity's `forward`
 *                  (E-2's 稍后再转发 / X-4's 防抖). A `wait` on the last utterance never delivers.
 *  · `interrupt` — calls `session_interrupt` with `intent` (X-5's semantic stop).
 *  · `text`      — replies in text instead of calling the tool — the `MODEL_TEXT_REPLY` the bridge
 *                  treats as a fault.
 */
export type ScriptedModelPolicy = 'forward' | 'silent' | 'wait' | 'interrupt' | 'text';

/** One utterance of an acoustic-VAD scenario: what was said, and what the model does with it. */
export type ScriptedVadTurn = {
  /**
   * The words of this utterance. It is BOTH the transcript the endpoint completes and the text a
   * `forward` would send, so a scenario writes the sentence once. Default `utterance <ordinal>`.
   */
  text?: string;
  /** What the model does at this utterance's opportunity. Default `'forward'`. */
  policy?: ScriptedModelPolicy;
  /** `session_interrupt`'s mandatory `intent` — only read by the `interrupt` policy. */
  intent?: string;
  /**
   * The CORRECTED instruction an `interrupt` carries — `session_interrupt`'s optional `message`.
   *
   * Read only by the `interrupt` policy, and absent by default so every scenario written before this
   * option existed scripts the correction-free stop it always did. Present, it makes the call the
   * "change of direction" shape SPEC §0.3 D-6 describes: the relay must enqueue these words BEFORE
   * it aborts the run they correct (G1), which is what the continuous criteria read the ordering of.
   */
  correction?: string;
};

/** The knobs of the endpoint's acoustic detector. `timeBase` is the one option with no default. */
export type ScriptedVadOptions = {
  /** Which clock the silence is measured on. REQUIRED: V-1 is an open question, not a preference. */
  timeBase: ScriptedVadTimeBase;
  /**
   * How long the silence after speech must be, in milliseconds, before the endpoint closes the
   * utterance — the real `session.turn_detection.silence_duration_ms`. This default is the HARNESS's
   * own (`DEFAULT_SILENCE_DURATION_MS`, 400), not the repository's shipped value, which is 800 since
   * 2026-10-15; a criterion that wants the shipped window passes it explicitly.
   */
  silenceDurationMs?: number;
  /**
   * Peak amplitude, as a fraction of full scale in [0, 1], at or above which a frame counts as
   * speech — the real `session.turn_detection.threshold` (this repository sets 0.5).
   */
  threshold?: number;
  /** The appended PCM16's sample rate. Default 16 000, the rate the bridge encodes at. */
  sampleRate?: number;
  /** What the model does at each opportunity, consumed one entry per closed utterance. */
  turns?: readonly ScriptedVadTurn[];
};

/** How one utterance of a detector-driven session was disposed of — X-1's per-sentence reading. */
export type ScriptedVadDisposition =
  /** A `session_send` carried it (alone, or merged with deferred text). */
  | 'forwarded'
  /** The model left it unforwarded at its own opportunity and no later opportunity merged it. */
  | 'unforwarded'
  /**
   * The model deferred it at its own opportunity (X-4's 防抖). A later `forward` carrying it turns
   * this into `forwarded`; a record still reading `merged` when the session ends is one whose
   * deferral never landed — the text was heard and never delivered, so X-2 counts it unforwarded.
   */
  | 'merged'
  /** `session_interrupt` was called at this opportunity (X-5). */
  | 'interrupted'
  /** The model answered in text instead (MODEL_TEXT_REPLY). */
  | 'text';

/** One utterance's fate, as the criteria read it. */
export type ScriptedVadRecord = {
  /** The item id the endpoint created for it. */
  readonly itemId: string;
  /** The words of the utterance. */
  readonly text: string;
  /**
   * How it ended up. NOT readonly, and deliberately: a `wait` cannot know at its own opportunity
   * whether a LATER `forward` will carry its text, so the record is written as `merged` and
   * back-filled to `forwarded` when that forward happens. The getter still hands the array out
   * `readonly`, so a scenario can only read the mutation, never cause it.
   */
  disposition: ScriptedVadDisposition;
  /** The text a `forward` actually sent, back-filled with the same message that flips `merged`. */
  sentText: string | null;
};

/** The detector's own readings — what a criterion asserts on instead of re-parsing the frame list. */
export type ScriptedVadDetector = {
  /**
   * Hands one client frame in; returns the endpoint frames it makes due, in order.
   *
   * An `input_audio_buffer.append` is where the detector hears: the frame is decoded and measured,
   * `speech_started` is opened on the first loud frame, and the utterance is closed the moment the
   * silence reaches the configured duration — but ONLY on the audio-time base, whose clock moves
   * with the samples this call delivers. A wall-clock close cannot happen here, because nothing
   * about the passage of time is known until {@link advance} is called.
   */
  receive(frame: Record<string, unknown>): Array<Record<string, unknown>>;
  /**
   * Moves the detector's clock to `nowMs` and returns whatever that made due with NO frame
   * arriving — the wall-clock base's whole reason to exist, and the only way a `speech_stopped`
   * can land during a client's silence.
   *
   * On the audio-time base this is deliberately a no-op past the clock update: its silence is
   * measured in received samples, which no reading of the wall clock can advance. That asymmetry
   * is exactly what a stand-in missing the switch gets wrong.
   */
  advance(nowMs: number): Array<Record<string, unknown>>;
  /** The `turn_detection` the session currently has, read off every `session.update` it received. */
  readonly turnDetection: 'server_vad' | null;
  /** How many utterances the detector has CLOSED by itself (each one is a response opportunity). */
  readonly speechStopped: number;
  /** How many `input_audio_buffer.speech_started` frames it has announced. */
  readonly speechStarted: number;
  /** How many response opportunities it opened — one per closed utterance, plus client `response.create`s. */
  readonly opportunities: number;
  /** Every `session_send` message the model sent, in order — the DELIVERED set (X-1/X-2). */
  readonly forwarded: ReadonlyArray<string>;
  /** Every utterance's fate, in spoken order — the disposition table (X-1) and the unforwarded set (X-2). */
  readonly records: ReadonlyArray<ScriptedVadRecord>;
  /** Every input item id the detector created, in order. */
  readonly items: ReadonlyArray<string>;
};

/** The endpoint's own detector settings, mirroring the real `session.turn_detection` defaults. */
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_SILENCE_DURATION_MS = 400;
const DEFAULT_VAD_SAMPLE_RATE = 16_000;

/**
 * How much audio one analysis step covers. A frame is walked in these windows rather than scored by
 * a single peak, because ONE append can carry a whole timeline: the browser's fake capture pushes a
 * burst per `speak()` call, and a detector that only scored the burst's peak would hear a
 * speech-then-silence burst as one unbroken utterance and never close it. Window-by-window is also
 * what the real detector's `silence_duration_ms` is measured in.
 */
const ANALYSIS_WINDOW_MS = 20;

/**
 * One `input_audio_buffer.append` payload as raw little-endian bytes, or `null` when it has no
 * reading as audio at all.
 *
 * `null` (rather than an all-silent buffer) is the one direction this detector refuses to guess:
 * a payload it cannot decode is not evidence of silence, and counting it as silence would let a
 * malformed frame close an utterance and lose the words in it.
 */
function pcm16BytesOf(audio: unknown): Buffer | null {
  if (typeof audio !== 'string' || audio.length === 0) return null;
  try {
    const bytes = Buffer.from(audio, 'base64');
    return bytes.length >= 2 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * The PEAK amplitude, as a fraction of full scale, over the 16-bit samples in `[from, to)`.
 *
 * Peak, not RMS: `threshold` is a gate on "is there speech in this window", and a window that is
 * mostly quiet with one loud onset is exactly the case an average would miss — the misjudge that
 * loses the first syllable after a pause (decision doc §10.3 V-3).
 */
function peakOver(bytes: Buffer, from: number, to: number): number {
  let peak = 0;
  for (let offset = from; offset + 1 < to; offset += 2) {
    const sample = bytes.readInt16LE(offset);
    const magnitude = sample < 0 ? -sample : sample;
    if (magnitude > peak) peak = magnitude;
  }
  return peak / 32_768;
}

/**
 * The detector a `session.update` body asks for, or `undefined` when that body says nothing about
 * it — in which case the caller keeps the detector it already had.
 *
 * A named function rather than the inline read the protocol machine above writes, because this
 * module now hosts BOTH machines and `voice-realtime-scripted-upstream-state.test.ts` pins the
 * protocol machine's read as the module's ONLY one: its AC1 false form copies this file and deletes
 * that single line to get a stand-in deaf to the client's detector switch. A byte-identical second
 * line anywhere in the file makes that pin count two, and the form could then no longer say WHICH
 * read it took away.
 */
function detectorAskedBy(session: Record<string, unknown> | undefined): 'server_vad' | null | undefined {
  if (session === undefined || !('turn_detection' in session)) return undefined;
  return detectorIsOn(session.turn_detection) ? 'server_vad' : null;
}

/**
 * Builds the endpoint's acoustic detector.
 *
 * Consumed by {@link createScriptedUpstream} (its `vad` option), directly by
 * `voice-realtime-fake-vad-upstream.test.ts`, and re-exported for
 * `e2e/voiceRealtimeScriptedUpstream.ts` — the same three consumers, and the same one definition,
 * the protocol machine above has.
 */
export function createScriptedVad(options: ScriptedVadOptions): ScriptedVadDetector {
  const timeBase = options.timeBase;
  const silenceDurationMs = options.silenceDurationMs ?? DEFAULT_SILENCE_DURATION_MS;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const sampleRate = options.sampleRate ?? DEFAULT_VAD_SAMPLE_RATE;
  const turns = options.turns ?? [];

  /** The detector's clock in ms. Set ONLY by {@link advance}, so nothing here reads a real clock. */
  let clockMs = 0;
  /** The clock reading at the last loud sample — the wall-clock base's origin. */
  let lastSpeechAtMs = 0;
  /** Silent samples received since the last loud one. Frozen while the client is not sending. */
  let silentSamples = 0;
  /** Whether the detector currently believes an utterance is open. */
  let inSpeech = false;
  /** The `turn_detection` the session has; `null` means the client turned the detector OFF. */
  let turnDetection: 'server_vad' | null = 'server_vad';

  let speechStartedCount = 0;
  let speechStoppedCount = 0;
  let opportunities = 0;
  let responseSeq = 0;
  let lastResponseId: string | null = null;
  let closedTurns = 0;
  const items: string[] = [];
  const records: ScriptedVadRecord[] = [];
  const forwarded: string[] = [];
  /** Text the model deferred at an earlier opportunity, to ride the next `forward` (X-4). */
  let deferred: string[] = [];

  /** Milliseconds of silence this detector has seen, on the audio-time clock. */
  const audioTimeSilenceMs = (): number => (silentSamples / sampleRate) * 1000;
  /** The same, on the wall clock: time since the last loud sample, whether or not frames arrive. */
  const wallClockSilenceMs = (): number => clockMs - lastSpeechAtMs;

  // THE SWITCH, AND THE ONLY PLACE THE TWO CLOCKS ARE CHOSEN BETWEEN (decision doc §10.3 V-1).
  // `silenceElapsedMs` starts on the audio-time clock; the single line below hands it to the wall
  // clock for a `wall-clock` run. Removing that line leaves BOTH bases measuring received samples —
  // a stand-in that never had the switch — and the criterion's cross-base contrast leg goes red,
  // which is the false form AC1 requires the test file to demonstrate rather than assert.
  let silenceElapsedMs = audioTimeSilenceMs;
  if (timeBase === 'wall-clock') silenceElapsedMs = wallClockSilenceMs;

  /** The item id an utterance announced by `speech_started` will be committed as. */
  const itemIdOfTurn = (ordinal: number): string => `item_vad_${ordinal}`;

  /** The frames one response opportunity says, and the disposition it leaves behind. */
  function openOpportunity(turn: ScriptedVadTurn, ordinal: number): Array<Record<string, unknown>> {
    const id = `resp_vad_${responseSeq}`;
    responseSeq += 1;
    lastResponseId = id;
    opportunities += 1;
    const own = turn.text ?? `utterance ${ordinal}`;
    const policy = turn.policy ?? 'forward';
    const frames: Array<Record<string, unknown>> = [responseCreated(id)];

    if (policy === 'forward') {
      // Anything a previous `wait` deferred rides THIS message — E-2's 稍后再转发, and the merged
      // delivery X-4 measures. The order is spoken order, so the deferred text comes first.
      const message = [...deferred, own].join('');
      // The back-fill: a record parked as `merged` was deferred at its own opportunity, and only
      // NOW is it known what carried it. Its `sentText` is this same message, because that is the
      // one message the session actually received — a criterion reading per-sentence delivery has
      // to see the deferred sentence inside it, not `null`.
      for (const record of records) {
        if (record.disposition !== 'merged') continue;
        record.disposition = 'forwarded';
        record.sentText = message;
      }
      deferred = [];
      forwarded.push(message);
      frames.push(functionCall('session_send', { message }, `call_vad_${ordinal}`));
    } else if (policy === 'wait') {
      deferred.push(own);
    } else if (policy === 'interrupt') {
      frames.push(
        functionCall(
          'session_interrupt',
          {
            intent: turn.intent ?? `第 ${ordinal + 1} 句改变了方向`,
            // The correction rides the SAME call as the intent — one decision, one call, as the real
            // model makes it. Omitted entirely when the scenario scripts a bare cancel, so the two
            // shapes stay distinguishable on the wire.
            ...(turn.correction === undefined ? {} : { message: turn.correction }),
          },
          `call_vad_${ordinal}`,
        ),
      );
    } else if (policy === 'text') {
      frames.push(modelTextReply(own, id));
    }
    frames.push(responseDone(id));

    const disposition: ScriptedVadDisposition =
      policy === 'forward'
        ? 'forwarded'
        : policy === 'wait'
          ? 'merged'
          : policy === 'interrupt'
            ? 'interrupted'
            : policy === 'text'
              ? 'text'
              : 'unforwarded';
    records.push({ itemId: itemIdOfTurn(ordinal), text: own, disposition, sentText: policy === 'forward' ? forwarded[forwarded.length - 1]! : null });
    return frames;
  }

  /**
   * Closes the open utterance the way the endpoint's own detector does: `speech_stopped`, the
   * commit, the user item with its transcript, and then — without the client asking — the model's
   * response opportunity.
   */
  function closeUtterance(): Array<Record<string, unknown>> {
    inSpeech = false;
    silentSamples = 0;
    const ordinal = closedTurns;
    closedTurns += 1;
    speechStoppedCount += 1;
    const turn = turns[ordinal] ?? {};
    const itemId = itemIdOfTurn(ordinal);
    const previous = items.length > 0 ? items[items.length - 1]! : null;
    items.push(itemId);
    return [
      speechStopped(itemId),
      audioCommitted(itemId, previous),
      userItemCreated(itemId, previous),
      captionCompleted(itemId, turn.text ?? `utterance ${ordinal}`),
      ...openOpportunity(turn, ordinal),
    ];
  }

  /** Whatever the current clock says is due right now — the one place a close is decided. */
  function dueFrames(): Array<Record<string, unknown>> {
    if (!inSpeech || turnDetection === null) return [];
    if (silenceElapsedMs() < silenceDurationMs) return [];
    return closeUtterance();
  }

  return {
    receive(frame: Record<string, unknown>): Array<Record<string, unknown>> {
      switch (frame.type) {
        case 'session.update': {
          const asked = detectorAskedBy(frame.session as Record<string, unknown> | undefined);
          if (asked !== undefined) turnDetection = asked;
          return [];
        }
        case 'input_audio_buffer.append': {
          if (turnDetection === null) return [];
          const bytes = pcm16BytesOf(frame.audio);
          // A payload with no reading as audio is not evidence: it moves neither clock and cannot
          // close an utterance (see `pcm16BytesOf`). Returning here, rather than counting it as
          // silence, is what keeps a malformed frame from ending a turn and losing its words.
          if (bytes === null) return [];
          const windowBytes = Math.max(2, Math.round((sampleRate * ANALYSIS_WINDOW_MS) / 1000) * 2);
          const frames: Array<Record<string, unknown>> = [];
          // Walked in windows, not scored once: ONE append can carry a whole timeline (the fake
          // capture pushes a speech+silence burst per `speak()`), and the close is tested after
          // EVERY window so a burst ending in enough silence closes inside the same call — which
          // is exactly the case a per-frame peak reading would hear as one unbroken utterance.
          for (let offset = 0; offset < bytes.length; offset += windowBytes) {
            const end = Math.min(offset + windowBytes, bytes.length);
            if (peakOver(bytes, offset, end) >= threshold) {
              if (!inSpeech) {
                inSpeech = true;
                speechStartedCount += 1;
                frames.push(speechStarted(itemIdOfTurn(closedTurns)));
              }
              silentSamples = 0;
              lastSpeechAtMs = clockMs;
            } else if (inSpeech) {
              silentSamples += Math.floor((end - offset) / 2);
            }
            frames.push(...dueFrames());
          }
          return frames;
        }
        case 'input_audio_buffer.commit': {
          // Under an ON detector the client's own commit is the frame the real endpoint REFUSES
          // (decision doc §5 P-3), and the refusal is what an empty-buffer commit gets. A session
          // whose detector the client switched off is a manual one, and its commits are accepted.
          if (turnDetection !== null) {
            return [upstreamError('invalid_request_error', EMPTY_BUFFER_MESSAGE)];
          }
          const ordinal = closedTurns;
          closedTurns += 1;
          const turn = turns[ordinal] ?? {};
          const itemId = itemIdOfTurn(ordinal);
          const previous = items.length > 0 ? items[items.length - 1]! : null;
          items.push(itemId);
          return [
            audioCommitted(itemId, previous),
            userItemCreated(itemId, previous),
            captionCompleted(itemId, turn.text ?? `utterance ${ordinal}`),
            ...openOpportunity(turn, ordinal),
          ];
        }
        case 'response.create': {
          // Under continuous the client should never send this — the detector opens the
          // opportunities. A scenario that does gets an empty response, so the model is not left
          // waiting on a turn that will never close.
          const id = `resp_vad_client_${responseSeq}`;
          responseSeq += 1;
          lastResponseId = id;
          opportunities += 1;
          return [responseCreated(id), responseDone(id)];
        }
        case 'conversation.item.create': {
          const item = frame.item as Record<string, unknown> | undefined;
          if (item?.type === 'function_call_output') {
            // The app returned a tool result; the endpoint closes that turn without the model
            // speaking. Emitted so the bridge's follow-up credit is claimed rather than leaked.
            const id = `resp_vad_resume_${responseSeq}`;
            responseSeq += 1;
            lastResponseId = id;
            opportunities += 1;
            return [responseCreated(id), responseDone(id)];
          }
          return [];
        }
        case 'response.cancel':
          return [responseCancelled(lastResponseId)];
        default:
          return [];
      }
    },
    advance(nowMs: number): Array<Record<string, unknown>> {
      clockMs = nowMs;
      return dueFrames();
    },
    get turnDetection(): 'server_vad' | null {
      return turnDetection;
    },
    get speechStopped(): number {
      return speechStoppedCount;
    },
    get speechStarted(): number {
      return speechStartedCount;
    },
    get opportunities(): number {
      return opportunities;
    },
    get forwarded(): ReadonlyArray<string> {
      return forwarded;
    },
    get records(): ReadonlyArray<ScriptedVadRecord> {
      return records;
    },
    get items(): ReadonlyArray<string> {
      return items;
    },
  };
}
