/**
 * The e2e-side scripted Realtime upstream: a REAL `ws` server the app server dials over TCP,
 * speaking the SAME event vocabulary the server-side stand-in defines.
 *
 * WHY THIS FILE EXISTS. The four real-browser Live Voice specs each hand-roll a `WebSocketServer`
 * on the port `playwright.config.ts` points the app at (`VOICE_REALTIME_ENDPOINT`), and each one
 * speaks its own subset of DashScope's frames. The endpoint events that actually caused incidents —
 * the endpoint's own `error`, a `response.text.done` where the model answers instead of relaying
 * (`MODEL_TEXT_REPLY`), a requested STOP (`session_interrupt`) — had no stand-in in any of them.
 * `server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts` closed that gap for the
 * in-process criteria; this module is the same vocabulary on a real socket, so a browser scenario can
 * be written against it.
 *
 * IT DOES NOT DEFINE A VOCABULARY OF ITS OWN. The builders, the endpoint url, and the OPTIONAL
 * protocol state machine (`createScriptedProtocolState`, armed per connection through
 * `armProtocol`) are IMPORTED from the server module and re-exported here — a scenario names
 * `functionCall(...)`, never a hand-written `{ type: 'response.function_call_arguments.done', ... }`.
 * The server module's only import is `import type`, which the bundler erases, so pulling it into an
 * e2e run drags no server code with it. There is exactly one definition of each frame shape in the
 * repository.
 *
 * WHAT THE SERVER OWNS. Everything after the handshake, and only what a scenario asks for:
 * `session.update` is still answered with `session.created`/`session.updated` (the transport does
 * not reach `open` without them), a `function_call_output` the app sends back is acknowledged with
 * `response.done` so the model is never left waiting, and every other thing the endpoint says comes
 * from a scenario's own `script`/`emit`.
 *
 * WHAT IT RECORDS, FOR THE CRITERIA TO READ. `dialed` proves the app really dialled THIS server (not
 * the network); `upgradeHeaders` is the handshake a proof of what credential rode with it (the
 * cloud-API criterion reads the ABSENCE of an `authorization` header here); `clientFrames` is every
 * frame the app sent upstream; `functionCallOutputs` is every tool result the app returned.
 */
import { WebSocketServer, type WebSocket } from 'ws';

import {
  audioCommitted,
  captionCompleted,
  captionDelta,
  createScriptedProtocolState,
  endpointError,
  functionCall,
  modelTextReply,
  responseCancelled,
  responseCreated,
  responseDone,
  speechStarted,
  transcriptionFailed,
  upstreamError,
  userItemCreated,
  SCRIPTED_ENDPOINT_URL,
  type ScriptedEndpointEvent,
  type ScriptedProtocolOptions,
} from '../server/modules/voice-realtime/tests/voice-realtime-scripted-upstream';

// The vocabulary is the SERVER module's — re-exported, never re-declared. A scenario written
// against this module writes the same frames the in-process criteria do.
export {
  audioCommitted,
  captionCompleted,
  captionDelta,
  endpointError,
  functionCall,
  modelTextReply,
  responseCancelled,
  responseCreated,
  responseDone,
  speechStarted,
  transcriptionFailed,
  upstreamError,
  userItemCreated,
  SCRIPTED_ENDPOINT_URL,
};
export type { ScriptedEndpointEvent, ScriptedProtocolOptions };

/** What a started scripted upstream exposes to a scenario. */
export type ScriptedUpstreamServer = {
  /** How many upgrade requests the app has dialled. The cloud-guard reading: it must be ≥ 1. */
  dialed(): number;
  /** How many upstream connections are open right now. */
  liveConnectionCount(): number;
  /** Every frame the app sent upstream, in order. */
  clientFrames(): Array<Record<string, unknown>>;
  /**
   * The headers of every upgrade request, in dial order.
   *
   * `authorization` here is the load-bearing one: with the endpoint pointed at this server and the
   * cloud credential blanked, the transport dials with `{}` — so no `authorization` key. A run that
   * somehow carried a real key would show one, which is exactly what the criterion must not see.
   */
  upgradeHeaders(): Array<Record<string, string | string[] | undefined>>;
  /** Every `function_call_output` the app returned upstream, in order. */
  functionCallOutputs(): Array<Record<string, unknown>>;
  /** How many `input_audio_buffer.commit` frames the app has sent (one per committed segment). */
  commitCount(): number;
  /**
   * Observes every frame the app sends upstream, AFTER the server's own answer to it (so a
   * `function_call_output`'s `response.done` is already on the wire when the listener runs). A
   * replay uses it to answer a commit the way a recorded session's endpoint did. Returns an
   * unsubscribe.
   */
  onClientFrame(listener: (frame: Record<string, unknown>) => void): () => void;
  /** Says one frame as the endpoint would, right now, to every live connection. */
  emit(wire: Record<string, unknown>): void;
  /** Says every frame of a script, each after its own delay, in order. Resolves on the last. */
  script(events: readonly ScriptedEndpointEvent[]): Promise<void>;
  /** Ends every live connection as a network loss would — the socket closes without being asked. */
  drop(): void;
  /** Refuses the next `count` dials (each connection is terminated the moment it opens). */
  refuseDials(count?: number): void;
  /**
   * Arms (or, with `null`, disarms) the protocol state machine for connections dialled from now on.
   *
   * Each connection gets its OWN machine, built from the config at dial time, so a reconnect starts
   * from a clean session — the same per-connection ownership `createScriptedUpstream` gives its
   * in-process stand-in. A branch that scripts its own frames calls this never, so its wire is
   * unchanged by the machine's existence.
   */
  armProtocol(config: ScriptedProtocolOptions | null): void;
  close(): Promise<void>;
};

/** A macrotask boundary, so a delivery a previous frame started can settle before the next. */
function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts the scripted upstream on `port`, owned by the caller (the spec) for the whole run.
 *
 * `host: '127.0.0.1'` matches `playwright.config.ts`'s endpoint and keeps the server off every other
 * interface — the run is loopback-only by construction, not by convention.
 */
export function startScriptedUpstream(port: number): Promise<ScriptedUpstreamServer> {
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  let dials = 0;
  let refuseRemaining = 0;
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const frames: Array<Record<string, unknown>> = [];
  const toolOutputs: Array<Record<string, unknown>> = [];
  const listeners = new Set<(frame: Record<string, unknown>) => void>();
  let commits = 0;
  /** The protocol config connections dialled from now on are armed with; `null` = script-only. */
  let armed: ScriptedProtocolOptions | null = null;
  const notify = (frame: Record<string, unknown>): void => {
    for (const listener of listeners) listener(frame);
  };

  server.on('connection', (socket: WebSocket, request) => {
    dials += 1;
    headers.push(request.headers as Record<string, string | string[] | undefined>);
    if (refuseRemaining > 0) {
      refuseRemaining -= 1;
      socket.terminate();
      return;
    }
    const protocol = armed === null ? null : createScriptedProtocolState(armed);
    socket.on('message', (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      frames.push(frame);
      if (frame.type === 'input_audio_buffer.commit') commits += 1;
      // The armed machine answers the frames a real endpoint reacts to (a commit, a
      // `response.create`, a cancel). Disarmed, this loop never runs and the wire below is exactly
      // what it was before the machine existed.
      if (protocol !== null) {
        for (const answer of protocol.receive(frame)) socket.send(JSON.stringify(answer));
      }
      // The endpoint answers the app's `session.update`. The bridge must TOLERATE this — it is the
      // endpoint answering us, not a failure, and a session that never reaches `open` is no session.
      if (frame.type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.created' }));
        socket.send(JSON.stringify({ type: 'session.updated' }));
        notify(frame);
        return;
      }
      // A tool result the app returned for a call the script made: acknowledge it, so the model is
      // never left waiting on a call it made (the same contract the in-process stand-in keeps).
      const item = frame.item as Record<string, unknown> | undefined;
      if (frame.type === 'conversation.item.create' && item?.type === 'function_call_output') {
        toolOutputs.push(frame);
        socket.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_scripted', status: 'completed' } }));
      }
      notify(frame);
    });
  });

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('the scripted upstream never began listening')), 10_000);
    server.once('listening', () => {
      clearTimeout(deadline);
      const sendAll = (wire: Record<string, unknown>): void => {
        const data = JSON.stringify(wire);
        for (const client of server.clients) {
          client.send(data);
        }
      };
      resolve({
        dialed: () => dials,
        liveConnectionCount: () => server.clients.size,
        clientFrames: () => frames,
        upgradeHeaders: () => headers,
        functionCallOutputs: () => toolOutputs,
        commitCount: () => commits,
        onClientFrame: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        emit: sendAll,
        script: async (events) => {
          for (const event of events) {
            await waitFor(event.afterMs ?? 0);
            sendAll(event.wire);
          }
          // One more boundary, so the delivery the LAST frame started has settled before the
          // caller starts asserting.
          await waitFor(0);
        },
        drop: () => {
          for (const client of server.clients) {
            client.terminate();
          }
        },
        refuseDials: (count = 1) => {
          refuseRemaining = count;
        },
        armProtocol: (config) => {
          armed = config;
        },
        close: () =>
          new Promise<void>((done) => {
            // `WebSocketServer.close()` only stops accepting new clients and then waits for every
            // existing one to disconnect — a proxy socket still parked on the upstream would hang
            // teardown. Terminate them, so close always settles.
            for (const client of server.clients) {
              client.terminate();
            }
            server.close(() => done());
          }),
      });
    });
    server.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
}
