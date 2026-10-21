/**
 * GOAL-033 / AC-316 — the browser voice criterion's upload half, on a real
 * browser against a real server, with NO microphone stand-in anywhere in the
 * run.
 *
 * WHAT THIS FILE IS FOR. The sibling spec
 * (`voice-realtime-live-session-send.spec.ts`) proves the chain with a fake
 * `AudioContext`/`AudioWorkletNode`/microphone-capture graph standing in for a
 * microphone no CI machine has. This file proves the SAME chain — browser →
 * `/voice-realtime` proxy → (fake) Realtime upstream → a model's proposed
 * `session_send` → the real `session_send` → the turn in the ordinary
 * transcript — through the OTHER audio source `useVoiceRealtimeSession`
 * supports: an uploaded fixture file, decoded by the browser's REAL
 * `AudioContext.decodeAudioData` (no mock of the Web Audio API at all) and
 * replayed through `fileAudioSource` in
 * `src/modules/chat/voice-realtime/audioSource.ts` — the same module
 * `microphoneAudioSource` lives in, so this is a run of the shared pipeline,
 * not a parallel one. This is also this repo's fixed-corpus automated
 * end-to-end path for voice: a known WAV fixture, decoded and chunked exactly
 * once per run, with a deterministic outcome.
 *
 * WHAT AC-316 CHANGED HERE. There is no draft-and-confirm step any more: the
 * bar captures continuously, and the model's `session_send` executes the moment
 * it is called, so the fixture's turn appears in the transcript with no edit
 * step and no visible upload button — the file input is a hidden test seam,
 * driven directly. The bar's automatic microphone start is suppressed with the
 * `__voiceRealtimeSkipAutoStart` window flag, because this file injects a file
 * instead of feeding a fake microphone, and no CI machine has a real one.
 *
 * WHAT AC-315 READS HERE (the criterion repointed onto the bar). AC-315's own
 * guarantee is unchanged by AC-316 and is read in this file, on this UI, as
 * four mechanical facts — none of which is "a turn appeared":
 *
 *   · the uploaded corpus was really decoded and CHUNKED: the upstream's
 *     `input_audio_buffer.append` count grows by more than one across the
 *     injection, and it reaches a fresh upstream connection. One frame, or an
 *     empty source, fails here (see the handshake-gap queue in
 *     `useVoiceRealtimeSession`); the falsification is recorded in the task's
 *     DoD.
 *   · the run went through NO microphone: every `navigator.mediaDevices.
 *     getUserMedia` call is counted by an init-script stub that REJECTS, and
 *     each case asserts the count is zero when it ends — the mic path is not
 *     merely unused, it is unavailable.
 *   · the browser's own Web Audio API is what decoded the fixture: the
 *     init script replaces no `AudioContext`, so the check below reads the
 *     NATIVE constructor and `decodeAudioData` back out of the page.
 *   · the instruction LANDED IN HISTORY: the executing `session_send` writes a
 *     real user row, and that row survives `page.reload()`.
 *
 * The draft-confirmation reading ("the model's proposed text must not appear in
 * the transcript") was a property of AC-312's superseded UI: with the draft card
 * gone the proposal IS what gets sent, so that assertion is retired with the
 * shape it described — it is not re-created here.
 *
 * WHAT IS REAL AND WHAT IS NOT. The Realtime upstream (DashScope) is a stand-in
 * for the same reason the sibling spec uses one: the server dials
 * `VOICE_REALTIME_ENDPOINT`, which `playwright.config.ts` points at a port this
 * file's own WS server owns. Everything else — the browser's audio decode, the
 * `/voice-realtime` proxy, the bridge, the real `session_send` — is the
 * shipping code. This file defines NO audio cut of its own: unlike the sibling
 * spec there is no fake `AudioContext`/`AudioWorkletNode`/capture graph here,
 * which is also why a `getUserMedia` call can only come from the shipping
 * `microphoneAudioSource`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';

import { reloadPaneBounded } from './support/pane-reload';

/** This run's throwaway data directory, published by playwright.config.ts. */
const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;

const PANE = '.chat-messages-pane';
const USER_ROW = '[data-message-style="user"]';
/** The composer's textarea testid — present exactly while `ChatComposer` is mounted. */
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';

/**
 * The phases the bar's own `voice-realtime-phase` seam may report.
 *
 * This file drives the SHIPPED bar and nothing else, so the phase it reads has
 * to be one of the bar's own states — the seam is asserted, not assumed, and a
 * bar that reported anything else fails here rather than being papered over.
 * The removed draft control plane's testids are deliberately NOT named anywhere
 * in this file (its "gone, not moved" reading belongs to the sibling spec): the
 * repointed criterion must not depend on literals of a deleted UI.
 */
const PHASE_STATES: readonly string[] = ['idle', 'connecting', 'arming', 'listening', 'muted', 'failed'];

// Deliberately the SAME account the sibling spec (`voice-realtime-live-session-send.spec.ts`)
// registers: the criterion chains both files into one Playwright invocation, and
// this server is a single-user system — a second, distinct hardcoded username would 403 on
// register and then 403 again on login, since the one user slot the first file claimed is not
// this file's username. Reusing it means whichever file runs first registers it and the second
// logs into the same account; either run order, and running this file alone, all work.
const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';
const TITLE = 'Voice realtime upload — DoD arm';
const SEED_USER_TEXT = 'seeded user turn for the voice realtime upload criterion';

/** What the fake upstream's function call sends. There is no edit step any more. */
const PROPOSED_TEXT = 'voice instruction delivered from the uploaded fixture';

/** When set, the fake upstream both HEARS and RELAYS exactly this text: the verbatim-relay case. */
let identicalText: string | null = null;
/**
 * AC-327: when set, the endpoint hears {@link spokenPieces} but RELAYS this text instead.
 *
 * A string deliberately different from what it heard, so the row that reads "heard" (the
 * transcription) and the row it becomes (the delivered message) can each be named unambiguously —
 * with one string for both, "the same row" and "a row carrying the delivered text" would be the
 * same reading.
 */
let relayText: string | null = null;
/**
 * What the fake endpoint reports it HEARD (AC-317), deliberately a different
 * string from {@link PROPOSED_TEXT}: the model's own `session_send` arguments and
 * the transcription of the audio are two separate channels, and a run where they
 * were the same string could not tell them apart.
 */
const HEARD_TEXT = 'what the endpoint transcribed from the uploaded audio';

/**
 * AC-326: the three utterances the endpoint reports for ONE spoken thought, closed one at a
 * time exactly as the real server-VAD endpoint closes them at every pause.
 *
 * Three pieces rather than one because that is the shape the criterion is about: rendered one
 * row each, a thought with two pauses in it read back to the person as their words appearing
 * three times.
 */
const ROW_HEARD: readonly string[] = ['alfa bravo charlie', 'delta echo foxtrot', 'golf hotel india'];
/**
 * What the model relays for those three pieces — ONE message, and deliberately sharing no words
 * with any of them: a delivered text that contained a piece would make "that piece has no row of
 * its own" unreadable (the delivered row itself would match it).
 */
const ROW_DELIVERED = 'send the summary of the release notes to the team channel';
/**
 * How long the fake endpoint waits, after hearing the audio, before it calls `session_send`.
 *
 * The criterion has to read the pane WHILE the utterances are still being transcribed — the point is
 * that the endpoint's three utterances are on screen as three rows of their own, before the relay's
 * ONE message takes them over — so the delivery is held off long enough for that reading to be taken
 * against settled rows.
 */
const ROW_DELIVERY_DELAY_MS = 3_000;
/** AC-326's wordless case: the endpoint reports transcriptions with no words and relays nothing. */
const WORDLESS_TRANSCRIPTS: readonly string[] = ['', '   '];
/**
 * Every user row the AC-326 gesture can own: one carrying any of the three pieces the endpoint
 * heard, or the one message it delivered. Scoped this way — rather than "all user rows" — because
 * the serial cases above this one leave delivered rows of their own in the same session.
 */
const ROW_OWNED = new RegExp([...ROW_HEARD, ROW_DELIVERED].join('|'));

/** AC-327: the one utterance the endpoint hears for the delivery-state gesture. */
const STATE_HEARD = 'ping the build server about the failed nightly';
/** AC-327: what the model relays for it — a different string, so each reading names a different row. */
const STATE_DELIVERED = 'tell the platform team the nightly failed';
/**
 * AC-327: how long the endpoint waits, after hearing, before it relays — the window in which the row
 * is `heard` and the delivery has not been accepted yet.
 *
 * Under the 2 s bound with slack: the bound is measured from the row first appearing, and this delay
 * plus the frame's own trip is what has to fit inside it.
 */
const STATE_DELIVERY_DELAY_MS = 1_200;
/** AC-327: the bound on the silent window — last final caption to the row reading `delivering`. */
const STATE_WINDOW_BOUND_MS = 2_000;

/**
 * When set, the endpoint reports these utterances separately and then relays once (AC-326).
 * `null` keeps the shipped dialect: one transcription of the whole upload.
 */
let spokenPieces: readonly string[] | null = null;
/** When true, the endpoint transcribes what it heard with NO words and relays nothing (AC-326). */
let wordlessOnly = false;
/** How long the endpoint waits before relaying what it heard; 0 relays the instant the audio arrives. */
let deliveryDelayMs = 0;

/**
 * AC6: how many `session_send` calls this connection makes, and what each one says.
 *
 * The shipped dialect is ONE call per connection and every case above this one reads that. A count
 * above one turns the endpoint into a CHAIN: it calls, waits for the proxy's own
 * `function_call_output` for that call, waits `queueCallGapMs`, then calls again.
 *
 * WAITING FOR THE RESULT IS NOT ENOUGH ON ITS OWN. On the coalescing path the relay answers the
 * model the instant it ACCEPTS a call — the `function_call_output` goes back before the 2.5 s window
 * has closed, so a chain paced only by the result re-calls in a few milliseconds and every call lands
 * INSIDE one window, joined into a single message (measured: five calls, one `coalesced 5 relayed
 * piece(s) into one message`, one `queued depth=1`). So `queueCallGapMs` is what has to clear the
 * window: a gap longer than it is the difference between five messages in the queue and one message
 * made of five pieces. The shipped window is 2.5 s with no env seam, so the chain's gap is set past
 * it in the case below.
 *
 * `queueCallMessages` names each call's message; `null` keeps the single relayed text for all of them.
 */
let queueCallCount = 1;
let queueCallGapMs = 0;
let queueCallMessages: readonly string[] | null = null;
/** AC6: what each call in the chain is HEARD to say. `null` keeps the shipped single utterance. */
let queueCallHeard: readonly string[] | null = null;

/** A scenario that only exists to make the session armable — see the sibling spec for why. */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

/** AC7's session: the one the byte budget is read on. Its own words, so its rows name it and nothing else. */
const QUEUE_TITLE = 'bounded voice queue';
const QUEUE_SEED_USER_TEXT = 'the fixture that measures the voice queue';
/**
 * AC7's scenario: a turn that HOLDS.
 *
 * The engine walks steps on a clock (`at` is an offset from the walk's own start), so a step far out
 * is what keeps the run — and with it the session's turn lease — in flight while the relay's queue
 * fills. Both steps are `wait`: they write nothing, so the run adds no row and the scenario's own
 * expectation (`rows.delta: 0`) still describes the artifact. Nothing here waits for the late step to
 * fire; the run it belongs to ends with the page.
 */
const QUEUE_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: QUEUE_TITLE, userText: QUEUE_SEED_USER_TEXT },
  steps: [
    { at: 0, op: 'wait' },
    { at: 240_000, op: 'wait' },
  ],
  expect: { rows: { delta: 0 }, content: { mustContain: [QUEUE_SEED_USER_TEXT] } },
};

/** How long this run's client is given to answer its own app entry before the startup path gives up on it. */
const CLIENT_WARM_DEADLINE_MS = 30_000;
/** How long the optimizer's committed `browserHash` must hold still before this run calls the optimizer settled. */
const OPTIMIZER_QUIET_WINDOW_MS = 1_000;
/** How often the private cache's commit marker is re-read while proving that quiet. */
const OPTIMIZER_POLL_MS = 250;

/**
 * What this file's whole invocation is allowed to take — and, at its two inner scopes, what the startup hook and
 * the case body are each allowed to take — before the criterion reports a regression of its own.
 *
 * THIS IS A TASK-ADDED GUARD, NOT AN AC's. AC-153's `expect:` names the four legs' sentences, the persistence past
 * four seconds, the close, the next recording's clear, the verbatim draft, the fold's two readings and the absence
 * of a concatenated sentence — no wallclock anywhere, in this file or in `goals/AC-153-…md`. The value this
 * replaces (45_000) was set for a quieter host than this one: at the ambient fan-in of a shared box it sits BELOW
 * the host's own envelope, so it reports host load as a criterion defect. The last red in the ledger crossed it at
 * `Received 52585` with the run's own watchdog unfired and all four legs green — the `# Error details` block of
 * that run's `error-context.md` carries this assertion and nothing else — and the previous rescale, to 50_000,
 * never reached the shipping line and would not have cleared 52_585 anyway.
 *
 * The replacement still leaves both readings that make the guard mean anything, and both bounds above it:
 * `playwright.config.ts`'s `SINGLE_SPEC_CEILING_MS` (55_000, this file's own watchdog ceiling) and the goal gate's
 * 60s kill. A run that crosses this value is therefore still *reported* by the assertion below — with its
 * `criterion-wall-ms`, its leg ledger and its stage timestamps — rather than SIGKILLed into a `Channel closed`
 * that names no stage. `54_000` is the largest value that keeps that legibility: it stands 1415ms above the
 * ledger's own reported crossing peak (52_585) and 1000ms below `SINGLE_SPEC_CEILING_MS`, so the whole
 * `[54_000, 55_000)` band still reaches the assertion instead of the watchdog; farther from the host's own
 * envelope and the guard goes back to reddening on fan-in (see the completion record's measured arms).
 */
const CRITERION_BUDGET_MS = 54_000;

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/** The optimizer's own record of what it has committed for THIS run's cache — see `committedBrowserHash`. */
const OPTIMIZER_METADATA_PATH = path.join(DATA_DIR, 'vite-cache', 'deps', '_metadata.json');

/**
 * The optimizer's own record of what it has committed for this run's private cache, as one comparable string.
 *
 * `_metadata.json` is written whole, by atomic rename, each time the optimizer commits, and `browserHash` is the
 * field that commit changes: it is the value every dependency url in the served entry carries as `?v=<hash>`.
 * Reading it is therefore reading the same fact a dependency url states, but *later in time* — the url states
 * what was committed when the entry was transformed, while this states what has been committed now. That
 * difference is the whole point: a url answering 200 proves *a* commit happened, not that it was the last one.
 *
 * An unreadable file reads as its own distinct string rather than throwing: mid-rename the file can be absent for
 * an instant, and treating that instant as a change only widens the quiet window (which is the safe direction).
 */
const committedBrowserHash = (): string => {
  try {
    const metadata = JSON.parse(fs.readFileSync(OPTIMIZER_METADATA_PATH, 'utf8')) as { browserHash?: string };
    return metadata.browserHash ?? '<metadata carried no browserHash>';
  } catch (error) {
    return `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  }
};

/**
 * Takes this run's first dependency optimization out of the measurement window: the html shell, the app's entry
 * module, and then one optimized dependency — all requested against this run's own client before any page of
 * this run exists.
 *
 * A criterion whose page is replaced by Vite's own `full-reload` (pushed when the optimizer commits a bundle
 * after it has started serving) measures nothing at all: the wizard it was driving is gone with the document.
 * The dependency url answering 200 is *not* sufficient proof that this cannot happen: the optimizer commits
 * more than once when the page's own crawl turns up a dependency the pre-bundle lacked, and the second commit
 * supersedes the url the first one wrote. What the warm-up has to establish is not that a bundle was committed
 * but that the optimizer has STOPPED committing — see `awaitOptimizerQuiescence`. The private cache is what
 * makes the race possible — see playwright.config.ts's `seedViteCache` — so this step is where that cost is
 * paid, before `browser.newContext()` and therefore before the criterion's first navigation.
 */
const warmClientStartup = async (clientUrl: string): Promise<number> => {
  const startedAt = Date.now();
  const deadline = startedAt + CLIENT_WARM_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  const fetchWithin = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs());
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (error) {
      throw new Error(
        `the client did not answer ${url} inside the ${CLIENT_WARM_DEADLINE_MS}ms startup budget `
        + `(${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * The return condition this warm-up actually needs: the committed `browserHash` holds still for
   * `OPTIMIZER_QUIET_WINDOW_MS`, and only then is the client handed to the criterion.
   *
   * A dependency url that answered 200 is the *entrance* to this check, not its replacement — the url proves a
   * bundle exists, this proves no further one is coming. The window is bounded on both sides by named constants:
   * `OPTIMIZER_QUIET_WINDOW_MS` is how long the hash must persist, and the enclosing `CLIENT_WARM_DEADLINE_MS`
   * is the total budget, so a cache that keeps changing ends in a named error that carries the url, its status,
   * and the hash trace — rather than a warm-up that "succeeded" into a document about to be replaced.
   */
  const awaitOptimizerQuiescence = async (depUrl: string, depStatus: number): Promise<number> => {
    const trace: string[] = [];
    let hash = committedBrowserHash();
    let quietSince = Date.now();
    trace.push(`+${quietSince - startedAt}ms ${depUrl} HTTP ${depStatus} browserHash=${hash}`);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(OPTIMIZER_POLL_MS, budgetMs())));
      const now = committedBrowserHash();
      if (now !== hash) {
        hash = now;
        quietSince = Date.now();
        trace.push(`+${quietSince - startedAt}ms browserHash=${hash}`);
        continue;
      }
      if (Date.now() - quietSince >= OPTIMIZER_QUIET_WINDOW_MS) {
        const settled = Date.now() - startedAt;
        console.log(
          `[e2e] optimizer quiet: browserHash=${hash} held ${OPTIMIZER_QUIET_WINDOW_MS}ms `
          + `(warm-up ${settled}ms, commits seen ${trace.length})`,
        );
        return settled;
      }
    }
    throw new Error(
      `the optimizer never went quiet inside the ${CLIENT_WARM_DEADLINE_MS}ms startup budget, so this run cannot `
      + `prove its document will stay: its browserHash had to hold for ${OPTIMIZER_QUIET_WINDOW_MS}ms; the last `
      + `dependency ${depUrl} answered HTTP ${depStatus}; browserHash trace: ${trace.join(' | ')}`,
    );
  };

  const shellUrl = new URL('/', clientUrl).href;
  const shell = await fetchWithin(shellUrl);
  if (!shell.ok) throw new Error(`the client's shell did not load: ${shellUrl} answered HTTP ${shell.status}`);
  await shell.text();

  const entryUrl = new URL('/src/main.tsx', clientUrl).href;
  const entry = await fetchWithin(entryUrl);
  if (!entry.ok) throw new Error(`the app entry did not transform: ${entryUrl} answered HTTP ${entry.status}`);
  await entry.text();

  let lastAnswer = 'no dependency url was ever served';
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt += 1) {
    const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await (await fetchWithin(entryUrl)).text())?.[1];
    if (!specifier) break;
    const depUrl = new URL(specifier, clientUrl).href;
    const dep = await fetchWithin(depUrl);
    if (dep.ok) {
      return awaitOptimizerQuiescence(depUrl, dep.status);
    }
    lastAnswer = `${depUrl} answered HTTP ${dep.status}`;
    await dep.text().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `this run's dependency pre-bundle never committed, so the criterion cannot drive a document that stays: `
    + lastAnswer,
  );
};
// ---------------------------------------------------------------------------------------------
// The fixed-corpus fixture file.
// ---------------------------------------------------------------------------------------------

/**
 * Writes a 16 kHz mono 16-bit PCM WAV file — a deterministic, fixed-corpus stand-in for
 * "someone uploaded a short recording" — and returns its path.
 *
 * A real, decodable WAV rather than silence-with-the-right-headers: the samples are a real
 * sine, so `AudioContext.decodeAudioData` has real audio data to hand back, not an all-zero
 * buffer a decoder could special-case.
 *
 * WHY IT IS TWO UTTERANCES AND NOT ONE STEADY TONE. A constant-amplitude tone is SILENCE to
 * the relay's own voice-activity detector: its noise floor is a sliding percentile of the
 * frames it has just seen, so a tone that never changes becomes the floor and never clears
 * the speech factor above it. Measured against the real `StreamingVad` + relay profile, the
 * previous single 0.6s tone committed ZERO segments — and the relay carries only committed
 * speech, so on that path the fixture reached the upstream as nothing at all. The criterion
 * then read green only when the handshake happened to arrive late enough to leave the
 * connection on the continuous framing, which is the intermittent this task closes (one red
 * in four runs on a clean tree, leg 2's frame delta sitting at 0).
 *
 * A fixed corpus has to be what the relay exists for: something said, a measurable pause,
 * something said again. Two 0.5s utterances at 20x the calibration level, each followed by
 * 2.1s of silence (the relay's own commit gap is 2.0s), so the profile commits TWO segments
 * — which reach the upstream as two `input_audio_buffer.append` frames, the "chunked, more
 * than one frame" reading this file has always asserted. The leading 0.6s is a QUIET tone on
 * purpose: the detector's bootstrap has to calibrate its floor against something, and
 * calibrating against digital silence would make the first room noise look like speech.
 */
function writeFixtureWav(): string {
  const sampleRate = 16_000;
  const pieces: readonly { seconds: number; amplitude: number }[] = [
    { seconds: 0.6, amplitude: 0.02 },
    { seconds: 0.5, amplitude: 0.5 },
    { seconds: 2.1, amplitude: 0 },
    { seconds: 0.5, amplitude: 0.5 },
    { seconds: 2.1, amplitude: 0 },
  ];
  const sampleCount = pieces.reduce(
    (total, piece) => total + Math.round(piece.seconds * sampleRate),
    0,
  );
  const data = Buffer.alloc(sampleCount * 2);
  let written = 0;
  for (const piece of pieces) {
    const samples = Math.round(piece.seconds * sampleRate);
    for (let index = 0; index < samples; index += 1) {
      const value = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * piece.amplitude * 0x7fff;
      data.writeInt16LE(Math.round(value), (written + index) * 2);
    }
    written += samples;
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  const fixturePath = path.join(os.tmpdir(), `voice-realtime-upload-fixture-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(fixturePath, Buffer.concat([header, data]));
  return fixturePath;
}

// ---------------------------------------------------------------------------------------------
// The fake Realtime upstream — identical dialect to the sibling spec (see its own comment for why
// it speaks only `input_audio_buffer.append` → one `response.function_call_arguments.done`).
// ---------------------------------------------------------------------------------------------

type FakeUpstream = {
  setBoundSessionId(id: string): void;
  connectionCount(): number;
  audioFrameCount(): number;
  /** AC6: every `function_call_output` the proxy sent back, in order — what the MODEL was told. */
  functionCallOutputs(): Array<{ callId: string; output: unknown }>;
  close(): Promise<void>;
};

function startFakeUpstream(port: number): Promise<FakeUpstream> {
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  let boundSessionId = '';
  let connections = 0;
  let calls = 0;
  let audioFrames = 0;
  /** Every tool result this endpoint was handed, in arrival order. See `functionCallOutputs`. */
  const callOutputs: Array<{ callId: string; output: unknown }> = [];

  server.on('connection', (socket) => {
    connections += 1;
    let callSent = false;
    /** The connection's own call number, part of every id it mints. */
    let callSeq = 0;

    /**
     * AC-317: the endpoint also transcribes the user's OWN audio. Emitted in
     * DashScope's real shape — a `delta` carries its running text in `stash`
     * (with `text` present but empty) and `completed` carries the final text
     * in `transcript`, both grouped by `item_id`. The browser must render this
     * as the user's own message WITHOUT it ever becoming model input.
     *
     * One utterance by default; AC-326's arms make it three separate ones, or two with no
     * words at all, and in that last case nothing is relayed. AC6 gives each call in its chain
     * its own utterance, so the refused one is a sentence the person really said and its words
     * can be read back off the bar.
     */
    const emitSpeech = (seq: number, callIndex: number) => {
      const pieces = wordlessOnly
        ? WORDLESS_TRANSCRIPTS
        : queueCallHeard?.[callIndex] !== undefined
          ? [queueCallHeard[callIndex] as string]
          : (spokenPieces ?? [identicalText ?? HEARD_TEXT]);
      pieces.forEach((piece, pieceIndex) => {
        const itemId = `item_fake_${seq}_${callIndex}_${pieceIndex}`;
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: itemId,
            stash: piece,
            text: '',
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: itemId,
            transcript: piece,
          }),
        );
      });
    };

    /** One `session_send` function call for this connection. */
    const emitCall = (seq: number, callIndex: number) => {
      const relayed = identicalText ?? relayText ?? (spokenPieces === null ? PROPOSED_TEXT : ROW_DELIVERED);
      socket.send(
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          call_id: `call_fake_${seq}_${callIndex}`,
          name: 'session_send',
          arguments: JSON.stringify({
            session: boundSessionId,
            message: queueCallMessages?.[callIndex] ?? relayed,
            waitSeconds: 0.5,
          }),
        }),
      );
    };

    /** Heard, then said: the utterance, and the call that carries it into the relay. */
    const emitTurn = (seq: number, callIndex: number) => {
      emitSpeech(seq, callIndex);
      if (wordlessOnly) {
        return;
      }
      if (callIndex === 0 && deliveryDelayMs > 0) {
        setTimeout(() => emitCall(seq, 0), deliveryDelayMs);
      } else {
        emitCall(seq, callIndex);
      }
    };

    socket.on('message', (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }

      // The endpoint acknowledges our `session.update`. The bridge must TOLERATE this:
      // it is the endpoint answering us, not a failure. The stand-in used to omit it —
      // which is precisely why a real session died here with no criterion noticing.
      if (frame.type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.created' }));
        socket.send(JSON.stringify({ type: 'session.updated' }));
        return;
      }

      // The proxy's answer to a call this connection made: DashScope's
      // `conversation.item.create` wrapping a `function_call_output`. Recorded — AC6's refusal is
      // a reason code the MODEL reads, and this is the only party the tool result reaches — and, for
      // a chained gesture, used as the pacing signal: the next call goes out only once the previous
      // one's window has closed and its delivery has landed, which is why the chain needs no guess
      // at the relay's own window.
      const item = frame.item as Record<string, unknown> | undefined;
      if (
        frame.type === 'conversation.item.create' &&
        item?.type === 'function_call_output' &&
        typeof item.call_id === 'string'
      ) {
        callOutputs.push({ callId: item.call_id, output: item.output });
        const match = /^call_fake_(\d+)_(\d+)$/.exec(item.call_id);
        const next = match ? Number(match[2]) + 1 : queueCallCount;
        if (match && Number(match[1]) === callSeq && next < queueCallCount) {
          const seq = callSeq;
          if (queueCallGapMs > 0) {
            setTimeout(() => emitTurn(seq, next), queueCallGapMs);
          } else {
            emitTurn(seq, next);
          }
        }
        return;
      }

      if (frame.type === 'input_audio_buffer.append') {
        audioFrames += 1;
        if (callSent || boundSessionId.length === 0) {
          return;
        }
        callSent = true;
        callSeq = calls;
        calls += 1;
        emitTurn(callSeq, 0);
      }
    });
  });

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('the fake Realtime upstream never began listening')), 10_000);
    server.once('listening', () => {
      clearTimeout(deadline);
      resolve({
        setBoundSessionId: (id: string) => {
          boundSessionId = id;
        },
        connectionCount: () => connections,
        audioFrameCount: () => audioFrames,
        functionCallOutputs: () => callOutputs.slice(),
        close: () =>
          new Promise<void>((done) => {
            // `WebSocketServer.close()` only stops accepting new clients and then
            // waits for every existing one to disconnect — a proxy socket still
            // parked on the upstream would hang teardown. Terminate them, so
            // close always settles.
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

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

const projectRow = (page: Page, workspaceName: string) =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): ReturnType<Page['locator']> =>
  page.locator(`a[href="/session/${sessionId}"]`).first();

async function explain(page: Page, what: string): Promise<never> {
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`${what}; the page held:\n${body.slice(0, 2_000)}`);
}

async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  await explain(page, `the sidebar never showed a row for session ${sessionId}`);
}

async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', { headers: { Authorization: `Bearer ${registered.token}` } });
    return registered.token;
  }
  const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  const loggedIn = await login.json().catch(() => null);
  if (typeof loggedIn?.token !== 'string') {
    throw new Error(`could not create or sign in as ${USERNAME}: ${register.status()} ${JSON.stringify(registered)}`);
  }
  return loggedIn.token;
}

async function armScenario(api: APIRequestContext, projectPath: string, scenario: unknown): Promise<string> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return sessionId;
}

// ---------------------------------------------------------------------------------------------
// The control.
// ---------------------------------------------------------------------------------------------

const paneText = (page: Page): Promise<string> => page.locator(PANE).innerText();

/**
 * How many nodes INSIDE the chat area carry `text` anywhere in their own content.
 *
 * The reading this task's AC6 is stated over, and the one that tells a row of the transcript from the
 * words in the bottom voice bar: the bar sits OUTSIDE `.chat-messages-pane` (it is drawn in the
 * composer, a sibling of the pane), so a count taken here is 0 exactly when the words are not in the
 * chat area at all. It counts NODES rather than the pane's collapsed text on purpose — every
 * `<div>`/`<span>`/`<p>` ancestor of a node carrying the words also carries them, so the number is 0
 * only when the text is nowhere inside the pane.
 *
 * `excluding` narrows the reading to nodes that do NOT also carry that text — the re-anchor the carry
 * rule (ce8a17671) forces on AC-326. Once a relayed message carries the heard sentences it left out,
 * verbatim, in front of its own words, the delivered row ITSELF contains those sentences: a reading
 * over "any node carrying a piece" would count the one correct row as a leftover row of its own, which
 * is exactly what `ROW_DELIVERED`'s own note says would make "that piece has no row of its own"
 * unreadable (the delivered row itself would match it). Excluding the nodes that carry `ROW_DELIVERED`
 * drops the delivered message AND every one of its ancestors — each carries the whole message, so each
 * carries the relayed text too — leaving only nodes carrying a piece and NOT the delivered text: a
 * genuine leftover row, the only thing this reading is meant to see. Omitted, the reading is unchanged:
 * AC6 (whose relayed text already covers what was heard, so nothing is carried into its row) keeps its
 * original reading, and only AC-326 and AC-327 — the two cases whose relayed text leaves a sentence out
 * — pass `ROW_DELIVERED`/`STATE_DELIVERED` here.
 */
const chatAreaNodesContaining = (page: Page, text: string, excluding?: string): Promise<number> =>
  page
    .locator(PANE)
    .locator('div, span, p', excluding === undefined ? { hasText: text } : { hasText: text, hasNotText: excluding })
    .count();

/**
 * Every mark a delivered message carries that says it came from the VOICE transcript — the per-row
 * badge this spec used to read, whose `title` held what the recogniser heard.
 *
 * REWRITTEN with gap-voice-ui-strip-to-caption-and-connection-state (2026-10-14): the strip's ruling is
 * that a sent utterance is an ordinary CloudCLI user message, so the badge is gone and a row that came
 * from voice must be indistinguishable from a typed one. The legs below therefore read its ABSENCE, and
 * they SCAN rather than name it, so a marker coming back under any name fails them too. `heardText` is
 * what the recogniser reported: those words must not be one hover away on the row any more, so a
 * leftover `title` carrying them is caught even if the node is no longer a badge.
 */
async function voiceMarksOnRow(row: Locator, heardText: string): Promise<string[]> {
  return row.evaluate(
    (el, heard) =>
      [...el.querySelectorAll('[data-testid], [title]')]
        .map((node) => `${node.getAttribute('data-testid') ?? ''}|${node.getAttribute('title') ?? ''}`)
        .filter((label) => /voice|heard|transcript|badge/i.test(label) || label.includes(heard)),
    heardText,
  );
}

/**
 * The bottom voice bar's transcript line, or `''` while the bar is not on screen.
 *
 * `voice-realtime-caption` shows the LATEST caption's words — the one place a spoken utterance is
 * shown when it is not yet the real message. Guarded by a count so a read taken after the bar is gone
 * answers the empty string instead of throwing.
 */
const barCaptionText = async (page: Page): Promise<string> => {
  const caption = page.getByTestId('voice-realtime-caption');
  return (await caption.count()) > 0 ? caption.innerText() : '';
};

/**
 * How many times the page called `navigator.mediaDevices.getUserMedia`.
 *
 * `-1` when the counting seam is absent: a later edit that dropped the init
 * script's stub must fail the `toBe(0)` below rather than read as "no
 * microphone calls were made".
 */
function mediaCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const seam = (window as unknown as Record<string, unknown>).__voiceRealtimeGetUserMediaCalls;
    return typeof seam === 'function' ? (seam as () => number)() : -1;
  });
}

/**
 * Reads back that the page is the one this file means to drive.
 *
 * Two halves, both mechanical. The browser's own Web Audio API must be
 * unpatched — this file defines no fake `AudioContext`/`AudioWorkletNode`
 * graph, so `decodeAudioData` really is the browser decoding the fixture. And
 * the `getUserMedia` counting stub must be installed, so the per-case "no
 * microphone" reading below is evidence rather than an absence of it.
 */
async function assertNoAudioSourceStandIn(page: Page): Promise<void> {
  const reading = await page.evaluate(() => {
    const isNative = (value: unknown): boolean =>
      typeof value === 'function' && /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(value));
    const ctor = (window as unknown as Record<string, unknown>).AudioContext as
      | { prototype?: { decodeAudioData?: unknown } }
      | undefined;
    return {
      audioContext: isNative(ctor),
      decodeAudioData: isNative(ctor?.prototype?.decodeAudioData),
      getUserMediaStubbed: !isNative(navigator.mediaDevices.getUserMedia),
    };
  });
  expect(reading.audioContext, 'AudioContext must be the browser native one: this file defines no fake audio graph').toBe(true);
  expect(reading.decodeAudioData, 'decodeAudioData must be the browser implementation: the fixture is really decoded').toBe(true);
  expect(reading.getUserMediaStubbed, 'the getUserMedia counting stub must be installed').toBe(true);
}

/** Enters Live Voice and waits for the bar to have replaced the composer. */
async function enterLiveVoice(page: Page): Promise<void> {
  await assertNoAudioSourceStandIn(page);
  await page.getByTestId('live-voice-button').click();
  await expect(page.getByTestId('voice-realtime-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
  // The bar's own phase seam, read off the shipped control rather than off copy.
  const phase = ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();
  expect(PHASE_STATES).toContain(phase);
}

/**
 * Drives one whole gesture through the upload path: inject the fixture into the
 * hidden input and let the pipeline run to the transcript. No microphone-capture
 * call and no fake audio graph are involved anywhere in this function — the
 * browser's real `AudioContext.decodeAudioData` runs on the fixture, and the
 * model's `session_send` executes without any browser round-trip.
 */
async function injectFixture(page: Page, fixturePath: string): Promise<void> {
  await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);
  // The fixture decodes and chunks faster than the proxy reports the upstream
  // `open`, so every frame goes through the hook's handshake-gap queue before
  // the first one reaches the fake upstream. Wait on the resulting transcript
  // turn rather than a phase — `listening` can pass before a poll's first check.
  await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(PROPOSED_TEXT);
}

// ---------------------------------------------------------------------------------------------
// The upload path's round trip, bounded — and left with room inside it for a RECONNECT.
// ---------------------------------------------------------------------------------------------

/** How long ONE probe of the round trip — the case's own upload and every replay of it alike — is given to land. */
const UPLOAD_ROUND_TRIP_MS = 12_000;
/** How often a probe re-asks its landing question. Short: the landing is a row arriving through an already-open
 * socket, not a document booting. */
const UPLOAD_PROBE_POLL_MS = 250;
/**
 * The bound the reconnect/replay budget is spent out of. A deadline rather than a replay count, because it is the
 * SUM that has to fit — spelled out, because this sum is the whole of why the guard can replay at all:
 *
 *   probe 1                 UPLOAD_ROUND_TRIP_MS    = 12_000
 * + reconnect (a fresh socket; the hook's `connect()` replaces the old one, no hop of its own)
 * + probe 2                 UPLOAD_ROUND_TRIP_MS    = 12_000
 * + reconnect
 * + probe 3                 UPLOAD_ROUND_TRIP_MS    = 12_000
 *   ────────────────────────────────────────────────────
 *   worst case                                      = 36_000  ≤  UPLOAD_REPLAY_DEADLINE_MS = 40_000
 *
 * so even a first probe that spends its whole bound still leaves two complete replays inside the deadline, and a run
 * that cannot land ends HERE, by name, with the page's own text — rather than inside the case's own 25s window,
 * where a red says only that a wait ran out.
 */
const UPLOAD_REPLAY_DEADLINE_MS = 40_000;

/** Whether `check` came true within `timeoutMs` — re-asked, never a bare read. */
const landsWithin = (check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> =>
  expect
    .poll(check, { timeout: timeoutMs, intervals: [UPLOAD_PROBE_POLL_MS] })
    .toBe(true)
    .then(() => true, () => false);

/**
 * What this file does instead of a bare round-trip window and then the case's own red: the landing the upload should
 * have produced is probed with a bound of its own, and a probe that does not land has the gesture REPLAYED — a fresh
 * socket, which is exactly what recovers from a connection whose upstream handshake was held past the window — until
 * the deadline above is spent. The replay is the case's own gesture (`setInputFiles` on the hidden seam), so it
 * cannot drift from it, and the hook's `connect()` is what makes it a reconnect: starting while connected replaces
 * the existing socket, so the replay reaches a NEW upstream connection rather than re-speaking into the held one.
 *
 * WHY THE CASES NEED ONE. The residual this closes read as an intermittent — leg 2's frame delta sitting at 0 for a
 * whole 15s poll while the connection was up — and it is neither unreproducible (measured on a clean tree: one red
 * in four runs) nor "the audio did not decode". Which framing a connection uses is decided by the handshake (`ready`
 * vs `state: open`), and the criterion had exactly one way to spend its round-trip window: wait it out, and red. A
 * connection whose round trip never landed had no second ask anywhere in the case.
 *
 * Every probe is signed into this run's own output — which probe it is, what it was given, when it landed, and every
 * replay by number — because the reconnect this guard exists to make has to be READABLE in the log as a reconnect,
 * not inferred from the source.
 */
const awaitUploadLanded = async (
  page: Page,
  fixturePath: string,
  label: string,
  landed: () => Promise<boolean>,
): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + UPLOAD_REPLAY_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  for (let probe = 1; ; probe += 1) {
    const probeKind = probe === 1 ? "the case's own upload" : `re-upload (reconnect ${probe - 1})`;
    const probeBudget = Math.min(UPLOAD_ROUND_TRIP_MS, budgetMs());
    console.log(`[e2e] upload round trip: probe ${probe} (${probeKind}) has ${probeBudget}ms for the round trip`);
    if (await landsWithin(landed, probeBudget)) {
      console.log(`[e2e] upload round trip: ${label} landed after ${Date.now() - startedAt}ms (probe ${probe}, ${probeKind})`);
      return;
    }
    if (Date.now() >= deadline) {
      await explain(page, `${label} did not land within ${Date.now() - startedAt}ms of the upload, reconnects included`);
    }
    console.log(`[e2e] upload round trip: ${label} had not landed ${probeBudget}ms after ${probeKind}; reconnecting and replaying the upload`);
    await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);
  }
};

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------------------------
// AC-326: each utterance of one spoken thought is its own `heard` row; the delivery finalises them
// into ONE real message in place.
// ---------------------------------------------------------------------------------------------

/** How often the AC-326 invariant is re-read while the gesture runs. */
const ROW_POLL_INTERVAL_MS = 60;
/** How long the AC-326 gesture is given to reach its delivered row. */
const ROW_POLL_DEADLINE_MS = 40_000;
/** How long the invariant keeps being re-read AFTER the delivered row lands, so the whole gesture is covered. */
const ROW_SETTLED_MS = 500;

/**
 * Writes a screenshot when QUAY_LIVE_VOICE_SHOT_DIR is set; a no-op in ordinary runs.
 *
 * The AC-326 reading is a claim about what the person SAW across a gesture, so the run leaves the
 * pictures behind rather than only the numbers: the endpoint's utterances as their own rows while the
 * thought was still being spoken, and the one real row once the delivery took the words over. The
 * name's trailing width is checked against the page's own viewport first — an artefact whose label is a
 * claim nothing verified is worse than no artefact.
 *
 * `settleMs` is how long to let colours settle before the capture, which suits a stage that HOLDS.
 * A stage that is about to END under the label — AC-327's `heard`, which the `queued` frame wipes
 * within the fake upstream's own delay — passes 0: the caller then re-reads the marker after the
 * capture, so a picture that outran its stage reddens instead of shipping mislabelled.
 */
async function shot(page: Page, name: string, settleMs = 700): Promise<void> {
  const dir = process.env.QUAY_LIVE_VOICE_SHOT_DIR;
  const named = /-(1280|375)$/.exec(name);
  if (named) {
    expect(page.viewportSize()?.width, `the shot ${name} is named for a width it was not taken at`).toBe(Number(named[1]));
  }
  // Colours transition on state change; let them settle so the picture shows the resting state.
  if (dir) await page.waitForTimeout(settleMs);
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

test.describe('voice realtime upload fixture', () => {
  let page: Page;
  let api: APIRequestContext;
  let upstream: FakeUpstream;
  let sessionId = '';
  let workspaceName = '';
  let fixturePath = '';
  /** AC6: the session whose armed scenario HOLDS its turn, so the queue has a busy session to fill. */
  let busySessionId = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    const upstreamPort = Number(process.env.QUAY_E2E_VOICE_REALTIME_PORT);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_PORT for this selection');
    }

    // Take this run's first dependency optimization out of the measurement
    // window BEFORE any page of this run exists. Vite pushes a `full-reload`
    // when it commits a pre-bundle after it has started serving, and a first
    // navigation that lands on that commit has its document replaced — the bar
    // this spec waits for then never appears, and the red reads as a criterion
    // defect. Bounded, and it fails by name rather than hanging. See
    // `warmClientStartup` above for what "quiet" means and why a 200 on a
    // dependency url is not itself proof.
    await warmClientStartup(clientUrl);

    fixturePath = writeFixtureWav();
    upstream = await startFakeUpstream(upstreamPort);

    const workspace = path.join(fixtureHome, 'voice-realtime-upload-workspace');
    workspaceName = path.basename(workspace);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();

    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    sessionId = await armScenario(api, workspace, SCENARIO);
    upstream.setBoundSessionId(sessionId);

    // AC6's session, armed here rather than inside its case: the sidebar lists it from this first
    // load, so switching to it costs a click instead of a navigation, and the last case's budget
    // goes to the queue itself. Its scenario is the one whose run HOLDS.
    busySessionId = await armScenario(api, workspace, QUEUE_SCENARIO);

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    await context.addInitScript(
      ({ authToken }: { authToken: string }) => {
        window.localStorage.setItem('auth-token', authToken);
        window.localStorage.setItem('userLanguage', 'en');
        // This file injects a fixture instead of feeding a fake microphone, so
        // the bar's automatic `start()` (which would call the real
        // `getUserMedia`) is suppressed — no CI machine has a microphone.
        (window as unknown as Record<string, unknown>).__voiceRealtimeSkipAutoStart = true;

        // AC-315's no-microphone guarantee, made countable. The stub REJECTS
        // rather than resolves, so a run that entered the microphone path would
        // fail on its own terms as well as move the count: "no microphone" is a
        // positive reading, not an absence of evidence. Every case reads the
        // count back through `__voiceRealtimeGetUserMediaCalls` when it ends.
        let mediaCalls = 0;
        const rejectMicrophone = () => {
          mediaCalls += 1;
          return Promise.reject(new Error('this criterion runs with no microphone'));
        };
        const nav = navigator as unknown as { mediaDevices?: Record<string, unknown> };
        const mediaDevices = nav.mediaDevices ?? {};
        mediaDevices.getUserMedia = rejectMicrophone;
        if (!nav.mediaDevices) {
          Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
        }
        (window as unknown as Record<string, unknown>).__voiceRealtimeGetUserMediaCalls = () => mediaCalls;
      },
      { authToken: token },
    );
    page = await context.newPage();

    await page.goto('/');
    if (!(await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
      await page.reload();
    }
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
    await upstream?.close();
    if (fixturePath) {
      fs.rmSync(fixturePath, { force: true });
    }
  });

  test('injecting a fixed-corpus fixture sends its instruction through the ordinary transcript, with no draft step', async () => {
    const composer = page.locator(COMPOSER_TEXTAREA);
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await enterLiveVoice(page);
    const bar = page.getByTestId('voice-realtime-bar');

    // There is no visible upload trigger — the input is a hidden test seam only.
    const uploadInput = page.locator('[data-testid="voice-realtime-upload-input"]');
    await expect(uploadInput).toHaveCount(1);
    // The injection seam is hidden, not a visible control: `sr-only` renders it
    // at most a pixel across, so nothing on screen offers to open it.
    const seamBox = await uploadInput.boundingBox();
    expect(seamBox ? Math.max(seamBox.width, seamBox.height) : 0).toBeLessThanOrEqual(2);

    // AC-315's upload reading, measured ACROSS the gesture rather than assumed:
    // the fixture was really decoded and chunked into more than one wire frame —
    // "chunked audio delivery", not one giant frame — and those frames reached a
    // fresh upstream connection. A >1 frame delta is also the handshake-gap
    // queue's falsification: without it the whole fixture is produced into the
    // still-connecting socket and the delta stays at 0.
    const framesBefore = upstream.audioFrameCount();
    const connectionsBefore = upstream.connectionCount();

    await injectFixture(page, fixturePath);

    // The round trip is bounded and replayable from here on: if this gesture's frames never reach the upstream — the
    // handshake framing the connection came up under, not a decode failure — the upload is replayed onto a fresh
    // socket instead of the case spending its own window waiting on the held one.
    await awaitUploadLanded(page, fixturePath, "the first upload's delivery", async () =>
      (await page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT }).count()) >= 1);

    // AC-317, as the person asked for it: the message DELIVERED to Claude is the row, and it is
    // marked as coming from the voice transcript. What the recogniser heard (a different string
    // from the instruction the model chose to send) is kept one hover away, not as a second row.
    const delivered = page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT });
    await expect.poll(() => delivered.count(), { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
    // ...and it is an ORDINARY user message: no voice mark on the row, and the recogniser's own words
    // nowhere on it (the badge that used to hold them is gone — see `voiceMarksOnRow`).
    expect(
      await voiceMarksOnRow(delivered.first(), HEARD_TEXT),
      'a delivered voice message must look like any other user message',
    ).toEqual([]);
    // The provisional caption is gone once the real message is shown.
    await expect.poll(() => page.locator(USER_ROW).filter({ hasText: HEARD_TEXT }).count(), { timeout: 15_000 }).toBe(0);

    // The instruction reached the session through the ordinary transcript
    // rendering — the send executed the moment the model called it.
    expect(await paneText(page)).toContain(PROPOSED_TEXT);

    expect(upstream.connectionCount() - connectionsBefore).toBeGreaterThanOrEqual(1);
    expect(upstream.audioFrameCount() - framesBefore).toBeGreaterThan(1);

    // AC-315's no-microphone reading for this case's capture window: the gesture
    // above reached the upstream without the microphone path ever being entered.
    expect(await mediaCallCount(page)).toBe(0);

    // AC3: End closes and returns the composer to the pane.
    await page.getByTestId('voice-realtime-end').click();
    await expect(bar).toHaveCount(0);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // History, not this page's live state. The reload this reads across is the guarded one: it is the reload
    // whose boot the injection on this task holds past the window (AC-315), and the reading below is unchanged.
    await reloadPaneBounded(page, 'the transcript pane after the history reload', explain);
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(PROPOSED_TEXT);
    expect(await page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT }).count()).toBeGreaterThanOrEqual(1);

    // Closing the case: the reload re-ran the init script, so this reads the
    // post-reload window — still zero microphone calls anywhere in the case.
    expect(await mediaCallCount(page)).toBe(0);
  });

  test('375px: the same injection gesture works with the bar inside the viewport', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    const composer = page.locator(COMPOSER_TEXTAREA);
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await enterLiveVoice(page);

    // AC1/AC2 at 375px: the bar is on screen, within the viewport, and the
    // composer is not — one input at a time, at this width too.
    const bar = page.getByTestId('voice-realtime-bar');
    const box = await bar.boundingBox();
    if (!box) await explain(page, 'the voice bar had no box at 375px');
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(376);
    await expect(composer).toBeHidden();

    // AC-315's own reading for the SECOND injection: measure what the second
    // upload actually delivers, not merely that a turn appeared. The transcript
    // already holds the first turn, so the delivery proof is the frame delta and
    // a fresh connection.
    const framesBefore = upstream.audioFrameCount();
    const connectionsBefore = upstream.connectionCount();
    await injectFixture(page, fixturePath);

    // The same bounded round trip on the second leg, whose landing is the SECOND delivered turn — this connection's
    // frames reaching the upstream, not the first leg's row (which would make the probe pass vacuously).
    await awaitUploadLanded(page, fixturePath, "the second upload's delivery", async () =>
      (await page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT }).count()) >= 2);

    // POLLED, not a bare assertion: on this SECOND leg `injectFixture`'s own wait
    // — the transcript containing `PROPOSED_TEXT` — is ALREADY satisfied by the
    // PC leg's turn, so that poll returns the instant it is first evaluated,
    // before this gesture's frames have reached the upstream. A bare assertion
    // here therefore measures the round trip at its most racy point and reads 0
    // roughly one run in ten. The reading is unchanged — the delta must still
    // exceed one — only the moment it is taken is.
    await expect
      .poll(() => upstream.audioFrameCount() - framesBefore, { timeout: 15_000 })
      .toBeGreaterThan(1);
    expect(upstream.connectionCount() - connectionsBefore).toBeGreaterThanOrEqual(1);

    // The second gesture is the one that could plausibly have fallen back to the
    // microphone; it did not.
    expect(await mediaCallCount(page)).toBe(0);

    await page.getByTestId('voice-realtime-end').click();
    await expect(bar).toHaveCount(0);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // The same guarded reload at 375px: this window is the second of the two the residual was read from, so it
    // is bounded and replayable on the same terms rather than left as the bare `page.reload()` it used to be.
    await reloadPaneBounded(page, 'the transcript pane after the 375px reload', explain);
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT }).count(), { timeout: 25_000 })
      .toBeGreaterThanOrEqual(2);

    expect(await mediaCallCount(page)).toBe(0);
  });

  test('words heard and relayed verbatim appear once in the transcript, not as a caption AND a message', async () => {
    const SAME = 'one sentence, spoken once, relayed word for word';
    identicalText = SAME;
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
      await enterLiveVoice(page);
      await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);

      // This leg makes its gesture inline rather than through `injectFixture`, so its round trip is bounded here on
      // the same terms: the landing is the relayed words appearing in the transcript at all.
      await awaitUploadLanded(page, fixturePath, 'the verbatim relay', async () => (await paneText(page)).includes(SAME));

      // The caption is there first, then the delivered message arrives through the transcript;
      // give the page time to read it (it follows the run) and then count.
      await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(SAME);
      await page.waitForTimeout(6_000);
      const occurrences = (await paneText(page)).split(SAME).length - 1;
      expect(occurrences).toBe(1);

      await page.getByTestId('voice-realtime-end').click();
    } finally {
      identicalText = null;
    }
  });

  /**
   * AC-326, re-anchored on the model the shipping pane renders NOW.
   *
   * The endpoint closes an utterance at every pause, so the fake one here reports THREE utterances
   * for the one upload and then relays them as ONE message. A spoken utterance is no longer a row of
   * the client's own (this task, `gap-live-voice-remove-transcript-caption-rows`): the per-utterance
   * `heard`/`delivering` caption rows it used to put on screen are gone. What this case reads off a
   * real page against that fake upstream is therefore:
   *   · while the thought is still being transcribed, the chat area holds NO row carrying any of the
   *     endpoint's utterances — the words are shown in the bottom voice bar's caption line;
   *   · after delivery, exactly ONE real row carrying the relayed message and its badge, and none of
   *     the three utterances left as a row of its own.
   *
   * THE READING IS RE-ANCHORED AROUND THE DELIVERED ROW (this task, 2026-10-16). The relayed message
   * here shares no words with what was heard, so the carry rule (ce8a17671: "a call that drops a heard
   * sentence carries it") delivers those three sentences verbatim in FRONT of it — and the ONE correct
   * row therefore contains all three pieces. A reading over "any chat-area node carrying a piece" would
   * count that one row as a leftover row of its own, which is what reddened AC-323 while every other
   * case stayed green. The claim this case is really stated over is the one the AC-326 title names —
   * ONE user row per thought — so every reading below counts a carrying node or row only when it does
   * NOT also carry the delivered text (see `chatAreaNodesContaining`'s `excluding`): the delivered row
   * and its whole subtree drop out, and a nonzero reading can only be a genuine separate row. The
   * case's shape, the fake upstream, `ROW_HEARD`/`ROW_DELIVERED` and the delivery semantics are all
   * untouched — only the anchor moves.
   *
   * The ledger below samples the chat area continuously and is the evidence, not a summary; the zeros
   * it must never contain are the reading this case is stated over. The whole-gesture claim — never a
   * row of the client's own, at any sampled moment — cannot be won by looking early or late.
   *
   * The readings are scoped to the rows THIS gesture can own (any of the three pieces it heard, or the
   * message it delivered) because the serial cases above leave delivered rows of their own in the same
   * session.
   */
  test('no utterance of one thought becomes a row of the client’s own, and the delivery finalises ONE real message in place, and a wordless transcription makes none', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await enterLiveVoice(page);

    spokenPieces = ROW_HEARD;
    deliveryDelayMs = ROW_DELIVERY_DELAY_MS;
    try {
      // The gesture's own user rows: any carrying one of the three pieces the endpoint heard, or the
      // one message it delivered. There must be NONE carrying a heard piece — a spoken utterance is
      // not a row of the client's own any more.
      const owned = page.locator(USER_ROW).filter({ hasText: ROW_OWNED });
      /** One reading of the gesture: its own row texts, and how many chat-area nodes carry a heard piece. */
      type OwnedSample = { texts: string[]; heardInChat: number };
      const samples: OwnedSample[] = [];
      await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);

      // The gesture is re-read from before the first utterance until the delivered row has held still,
      // and every reading is kept — the ledger below is the evidence, not a summary.
      const deadline = Date.now() + ROW_POLL_DEADLINE_MS;
      let deliveredAt: number | null = null;
      let shotWhileSpoken = false;
      while (Date.now() < deadline) {
        const texts = (await owned.allTextContents()).map((text) => text.trim());
        // How many nodes in the CHAT AREA carry any heard piece WITHOUT carrying the delivered text —
        // i.e. a node that is not the delivered message (or one of its ancestors). Zero at every sample
        // is the claim: no utterance of this thought was left as a row of its own. The delivered row
        // legitimately carries all three pieces (the carry rule put them there), so it is excluded by
        // `excluding` rather than counted as a leftover.
        let heardInChat = 0;
        for (const piece of ROW_HEARD) heardInChat += await chatAreaNodesContaining(page, piece, ROW_DELIVERED);
        samples.push({ texts, heardInChat });
        // The picture of the claim, taken in the moment it is true: the words are being spoken and the
        // chat area holds no row of the person's own. The bar's caption line is where they are shown.
        // The caption line holds the most RECENT utterance (the bar renders `lastCaption`, not the
        // accumulated transcript), so a gesture whose three pieces arrive faster than this loop samples
        // can show any one of them at a given moment — the non-vacuity read is therefore "the bar is
        // carrying one of the pieces this gesture spoke", not "it is carrying the first piece".
        // `settleMs` is 0 because this stage ends under the label within the fake upstream's own delay.
        const barCaption = await barCaptionText(page);
        if (!shotWhileSpoken && texts.length === 0 && ROW_HEARD.some((piece) => barCaption.includes(piece))) {
          shotWhileSpoken = true;
          await shot(page, 'ac326-no-own-rows-while-spoken-1280', 0);
        }
        const landed = texts.some((text) => text.includes(ROW_DELIVERED));
        if (landed) {
          deliveredAt ??= Date.now();
          if (Date.now() - deliveredAt >= ROW_SETTLED_MS) break;
        }
        await page.waitForTimeout(ROW_POLL_INTERVAL_MS);
      }
      const ledger = `heardInChat=[${samples.map((sample) => sample.heardInChat).join(',')}] rows=${JSON.stringify(samples.map((sample) => sample.texts))}`;
      console.log(`[e2e] AC-326: ${ledger}`);

      // AC-326(a), re-anchored: at NO sampled moment does the chat area carry any utterance of this
      // gesture OUTSIDE the delivered row. A spoken utterance is not a row of the client's own any more
      // — the words are shown in the bottom bar's caption line, and they reach the transcript as the
      // real message alone (which, under the carry rule, carries the dropped pieces verbatim in front of
      // the model's words — see the case doc; that one row is the message, not a leftover).
      const withWordsInChat = samples.filter((sample) => sample.heardInChat > 0);
      expect(
        withWordsInChat,
        `an utterance was put into the chat area as a row of the client's own; ${ledger}`,
      ).toEqual([]);
      // Non-vacuity: the loop really sampled a moment while the words were being spoken and NOT yet
      // delivered, so the zeros above are readings of a live gesture rather than of a loop that never
      // looked. (The sample is taken when the bar's caption already carries the words and the chat area
      // still holds no row of this gesture.)
      expect(
        shotWhileSpoken,
        `the gesture never sampled a moment while the words were still being spoken; ${ledger}`,
      ).toBe(true);
      expect(deliveredAt, `the relayed message never became a row of this gesture; ${ledger}`).not.toBeNull();

      // AC-326(b): the delivery finalised the person's utterances into ONE real row — the message the
      // model sent, an ordinary user message with no voice mark on it (the badge this leg used to read
      // is gone with the strip; `voiceMarksOnRow` also catches the recogniser's words left on the row)
      // — and none of the three utterances left as a row of its own.
      await expect(owned).toHaveCount(1);
      await expect(owned.first()).toContainText(ROW_DELIVERED);
      expect(
        await voiceMarksOnRow(owned.first(), ROW_HEARD.join(' ')),
        'a delivered voice message must look like any other user message',
      ).toEqual([]);
      for (const piece of ROW_HEARD) {
        // `hasNotText: ROW_DELIVERED` drops the delivered row (the one row that legitimately carries a
        // piece, under the carry rule). What remains must be 0: no utterance left as a row of its own.
        expect(
          await page.locator(USER_ROW).filter({ hasText: piece }).filter({ hasNotText: ROW_DELIVERED }).count(),
          `an utterance the endpoint reported was left as a user row of its own; ${ledger}`,
        ).toBe(0);
      }
      await shot(page, 'ac326-same-row-after-delivery-1280');

      // AC-326's wordless half, on its own connection: the endpoint reports transcriptions with NO
      // words and relays nothing at all. A blank row is not something the person said, so the
      // count must not move — and it is read on the whole pane, not the scoped ledger, so a blank
      // row cannot hide behind the scoping.
      await page.getByTestId('voice-realtime-end').click();
      await expect(page.getByTestId('voice-realtime-bar')).toHaveCount(0);
      await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 15_000 });
      const rowsBefore = await page.locator(USER_ROW).count();

      spokenPieces = null;
      deliveryDelayMs = 0;
      wordlessOnly = true;
      await enterLiveVoice(page);
      const framesBefore = upstream.audioFrameCount();
      await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);
      // The wordless frames have to have been REPORTED before the count is read: the read is of a
      // settled pane, not of a race the case would win by looking early.
      await expect.poll(() => upstream.audioFrameCount() - framesBefore, { timeout: 25_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(2_000);
      await shot(page, 'ac326-wordless-made-no-row-1280');
      expect(
        await page.locator(USER_ROW).count(),
        'a transcription with no words became a user row',
      ).toBe(rowsBefore);
    } finally {
      spokenPieces = null;
      deliveryDelayMs = 0;
      wordlessOnly = false;
      await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
    }
  });

  /**
   * AC-327: the delivery wait is visible, in the bottom bar, while the chat area stays empty.
   *
   * The proxy accepts a `session_send` immediately but delivers it only when its 2.5 s coalescing
   * window closes. A spoken utterance is no longer a row of the client's own (this task,
   * `gap-live-voice-remove-transcript-caption-rows`), so the wait is shown where the words now live:
   * the bottom voice bar's caption line keeps the heard words on screen through the whole
   * accepted-but-unshown window, and the chat area gains nothing until the real message lands. The
   * endpoint's relay is delayed by {@link STATE_DELIVERY_DELAY_MS} so the bar's caption is stable
   * enough to read and picture before the acceptance lands.
   *
   * WHAT REPLACED WHAT. This case used to read a `voice-row-heard` → `voice-row-delivering` transition
   * on the ONE provisional caption row. That row is gone with the caption rows, so the same two-stage
   * wait is now read off the bar's caption plus the chat area's emptiness — the reading the shipping
   * pane can actually be held to.
   *
   * THE READING IS RE-ANCHORED AROUND THE DELIVERED ROW (this task, 2026-10-16), exactly as AC-326's is
   * (see that case's doc). `STATE_HEARD` and `STATE_DELIVERED` share almost no words, so the carry rule
   * (ce8a17671) delivers the heard sentence verbatim in FRONT of the relayed one — the delivered row
   * therefore carries `STATE_HEARD` too, and a reading over "any node carrying the heard words" counts
   * that one correct row against itself. Every post-delivery reading here is taken with the delivered
   * text excluded (`chatAreaNodesContaining`'s `excluding`, and `hasNotText` on the row filter), so a
   * nonzero reading can only be a genuine separate row. The case's gestures, delays and delivery
   * semantics are untouched.
   */
  test('the delivery wait is visible in the bar, and the chat area gains no row of its own until the real message lands', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await enterLiveVoice(page);

    spokenPieces = [STATE_HEARD];
    relayText = STATE_DELIVERED;
    deliveryDelayMs = STATE_DELIVERY_DELAY_MS;
    try {
      // The row this gesture will become, located by the words the model relays — neither the seeded
      // turn above nor the heard words carry them, so the locator names exactly this gesture.
      const deliveredRow = page.locator(USER_ROW).filter({ hasText: STATE_DELIVERED });
      await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);

      // (e) heard, not yet delivered: the bar's caption line carries the words, and the chat area
      // holds no row of its own for them. The bound is measured from the caption first appearing.
      const captionFirstSeenAt = Date.now();
      await expect.poll(() => barCaptionText(page), { timeout: 25_000 }).toContain(STATE_HEARD);
      expect(
        await chatAreaNodesContaining(page, STATE_HEARD, STATE_DELIVERED),
        'the spoken words were put into the chat area as a row before the real message existed',
      ).toBe(0);
      // The words are on the bar and nowhere else; a settle is safe because this stage HOLDS for the
      // fake upstream's own delivery delay.
      await shot(page, 'ac327-heard-in-bar-1280');
      expect(
        await barCaptionText(page),
        'the heard shot must not have outrun the stage it is named for',
      ).toContain(STATE_HEARD);

      // (f) the wait really happened, and it was spent with the words in the bar: sample until the
      // delivered row lands, keeping at least one reading taken while the bar showed the words and the
      // chat area held no row of this gesture. Without a reading of the wait the case would also pass
      // for a gesture that delivered instantly.
      let waitedInBar = 0;
      const waitDeadline = Date.now() + 30_000;
      while (Date.now() < waitDeadline) {
        if ((await deliveredRow.count()) > 0) break;
        if ((await barCaptionText(page)).includes(STATE_HEARD)) waitedInBar += 1;
        expect(
          await chatAreaNodesContaining(page, STATE_HEARD, STATE_DELIVERED),
          "the spoken words were put into the chat area as a row of the client's own",
        ).toBe(0);
        await page.waitForTimeout(ROW_POLL_INTERVAL_MS);
      }
      const waitMs = Date.now() - captionFirstSeenAt;
      const waitLedger = `waitedInBar=${waitedInBar} waitMs=${waitMs}`;
      console.log(`[e2e] AC-327 wait: ${waitLedger}`);
      expect(waitedInBar, `the bar never showed the spoken words while the delivery was pending; ${waitLedger}`).toBeGreaterThan(0);

      // (g) delivered: the real spoken message — an ordinary user row, with no badge on it and the
      // heard words nowhere on it (the badge that used to hold them is gone; see `voiceMarksOnRow`) —
      // and still no row carrying the heard words, in the chat area, at any point.
      await expect(deliveredRow.first()).toBeVisible({ timeout: 25_000 });
      expect(
        await voiceMarksOnRow(deliveredRow.first(), STATE_HEARD),
        'a delivered voice message must look like any other user message',
      ).toEqual([]);
      expect(
        await chatAreaNodesContaining(page, STATE_HEARD, STATE_DELIVERED),
        "the spoken words were left in the chat area as a row of the client's own",
      ).toBe(0);
      await shot(page, 'ac327-delivered-1280');

      // (h) the heard words are never a row of the client's own: no user row's TEXT carries them, read
      // over the whole pane — excluding the delivered row, which legitimately carries them under the
      // carry rule (see the case doc) — and an ordinary typed user row carries no state marker either.
      await expect(
        page.locator(USER_ROW).filter({ hasText: STATE_HEARD }).filter({ hasNotText: STATE_DELIVERED }),
      ).toHaveCount(0);
      const typed = page.locator(USER_ROW).filter({ hasText: SEED_USER_TEXT });
      await expect(typed).toHaveCount(1);
      expect(
        await typed.first().getAttribute('data-testid'),
        'an ordinary typed user row must carry no delivery-state marker',
      ).toBeNull();
    } finally {
      spokenPieces = null;
      relayText = null;
      deliveryDelayMs = 0;
      await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
    }
  });

  /**
   * AC6 (this task, `gap-live-voice-remove-transcript-caption-rows`): the words the person spoke are
   * shown in the bottom voice bar while the delivery is still pending, the chat area carries no node
   * with them, and the sentence appears in the chat area ONLY as the real message it became.
   *
   * WHY THE WINDOW EXISTS AT ALL. The relay records a delivery the moment it ACCEPTS a `session_send`
   * — the `sent` frame — which is well before the session's transcript shows the message: the control
   * service delivers it, the session writes it into history, and the pane re-reads the transcript a
   * poll later. This case holds that window open (the fake upstream delays the relay by
   * {@link ROW_DELIVERY_DELAY_MS} via `deliveryDelayMs`) and reads the DOM on BOTH sides of it.
   *
   * THE READING. Before the sentence is delivered: the bottom bar's `voice-realtime-caption` line
   * contains it (`barCaptionContains=true`) and the number of nodes inside the chat area
   * (`.chat-messages-pane`) whose content contains it is 0 (`chatAreaNodesContaining=0`). After it
   * becomes a real message: exactly one real user row carrying it (`realRowNodes=1`), with the spoken
   * badge, and still no chat-area node carrying the HEARD words as a row of the client's own.
   *
   * The two numbers are printed (`[e2e] AC6 ...`), the fan-in suite (`scripts/test.sh`) does NOT run
   * Playwright, so this browser reading is this task's own evidence, taken here rather than in the
   * suite.
   */
  test('the spoken words ride the bottom bar until delivered, and only the real message reaches the chat area', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await enterLiveVoice(page);

    /** What the endpoint HEARS — the words that must survive the accepted-but-unshown window. */
    const HEARD = 'summarise the failing nightly job';
    /** What the model RELAYS for it — different words, so "shown" cannot be read off the caption. */
    const DELIVERED = 'write up why the nightly job failed';

    spokenPieces = [HEARD];
    relayText = DELIVERED;
    // Hold the relay off long enough that the sentence is well and truly spoken before the acceptance
    // lands, so the "before delivery" reading is taken inside a real window rather than raced.
    deliveryDelayMs = 1_500;
    try {
      /** The real message the words became, located by the RELAYED text — never the heard words. */
      const deliveredRow = page.locator(USER_ROW).filter({ hasText: DELIVERED });
      await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);

      // ── BEFORE the sentence is delivered ─────────────────────────────────────────────────────
      // The bar's caption line is where the spoken words are shown. It must carry them...
      await expect.poll(() => barCaptionText(page), { timeout: 25_000 }).toContain(HEARD);
      const barCaptionContains = (await barCaptionText(page)).includes(HEARD);
      // ...and the chat area must hold no node carrying them at all — the sentence has not become a
      // message yet, and no row of the client's own is standing in for it.
      const chatAreaNodes = await chatAreaNodesContaining(page, HEARD);
      // The window is real: the delivered row does not exist yet.
      const deliveredRowsBefore = await deliveredRow.count();
      console.log(
        `[e2e] AC6 before-delivery: barCaptionContains=${barCaptionContains} ` +
          `chatAreaNodesContaining=${chatAreaNodes} deliveredRows=${deliveredRowsBefore}`,
      );
      expect(barCaptionContains, 'the bottom bar must be showing the words the person spoke').toBe(true);
      expect(
        chatAreaNodes,
        'the spoken words must not be a node in the chat area before the real message exists',
      ).toBe(0);
      expect(deliveredRowsBefore, 'the real message must not exist yet at the before-delivery reading').toBe(0);
      await shot(page, 'ac6-words-in-bar-not-chat-1280');

      // ── AFTER the sentence becomes a real message ────────────────────────────────────────────
      await expect(deliveredRow).toHaveCount(1, { timeout: 30_000 });
      const realRowNodes = await deliveredRow.count();
      // ...and the row is an ORDINARY user message: the badge this leg used to read — the only mark of
      // the heard words, an attribute rather than a node's content — is gone with the strip, so the
      // reading is that neither a voice mark nor the words themselves are on the row.
      expect(
        await voiceMarksOnRow(deliveredRow.first(), HEARD),
        'a delivered voice message must look like any other user message',
      ).toEqual([]);
      console.log(`[e2e] AC6 after-delivery: realRowNodes=${realRowNodes}`);
      expect(realRowNodes, 'exactly one real row must carry the delivered sentence').toBe(1);
      // The heard words are still on nobody's row: the chat area carries them nowhere. A run that put
      // them on a row of the client's own would move this count off zero.
      expect(
        await chatAreaNodesContaining(page, HEARD),
        "the heard words were left in the chat area as a row of the client's own",
      ).toBe(0);
      await shot(page, 'ac6-real-message-1280');
    } finally {
      spokenPieces = null;
      relayText = null;
      deliveryDelayMs = 0;
      await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // AC7: the byte budget, on a session that is really mid-turn.
  // ---------------------------------------------------------------------------------------------

  /**
   * The one case where the relay's queue is filled for real — and the reading is BYTES, not a count.
   *
   * Every case above drives ONE delivery per connection, so the relay's queue is empty on either side
   * of it. This case drives a CHAIN: eight calls on one connection, each emitted a fixed gap after the
   * previous one's tool result has come back. The gap does the work — the relay answers the model the
   * moment it ACCEPTS a call, well before its own 2.5 s window closes, so a chain paced only by the
   * result re-calls inside one window and the pieces coalesce into one message. A gap past the window
   * (see {@link queueCallGapMs}) puts each call in its own window, so there are eight deliveries in the
   * relay's queue. The session is the one armed with the scenario whose run HOLDS (see QUEUE_SCENARIO),
   * so from the second call on the session is genuinely mid-turn through the real control service and
   * the real provider: the operator's own reading, the run in flight while the person keeps talking.
   *
   * WHY EIGHT, AND WHY THEY ALL FIT. The old bound was three MESSAGES, so an operator who kept talking
   * through a four-minute turn had their eight sentences — under 500 bytes of them — refused on the
   * fourth. The bound is now a UTF-8 BYTE BUDGET (1000 by default): eight short sentences are ~150
   * bytes, comfortably inside it, so every one is accepted and none is refused. What that has to look
   * like:
   *   · EVERY call reached the endpoint and was answered — eight tool results, none carrying the
   *     refusal reason code (`VOICE_QUEUE_FULL`), which the relay returns to the MODEL alone;
   *   · the WAIT is visible and it is measured in BYTES — the bar's own `data-queued-bytes` reading
   *     climbed above zero, sampled off the screen while the backlog was building;
   *   · NOTHING was refused — the status cell never carried `data-refusal`.
   *
   * The refusal path itself (over budget ⇒ `refused` frame + `VOICE_QUEUE_FULL`) is pinned at the unit
   * level in `voice-realtime-bounded-queue.test.ts`'s boundary case, where the exact 1001-byte edge can
   * be constructed; a browser reading of it would need a >1000-byte utterance and a much longer turn.
   */
  test('the held session accepts 8 sentences inside the byte budget, and the wait is visible in bytes', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await revealSession(page, workspaceName, busySessionId);
    await sessionRow(page, busySessionId).click();
    await expect(page.locator(PANE)).toContainText(QUEUE_SEED_USER_TEXT, { timeout: 30_000 });

    // The endpoint and the connection's session are one and the same for this case: the executor
    // refuses a `session_send` naming any other session, and the queue being measured is THIS
    // session's.
    upstream.setBoundSessionId(busySessionId);

    await enterLiveVoice(page);

    queueCallCount = 8;
    // Past the relay's 2.5 s coalescing window, so each call opens its OWN window and the calls are
    // separate queued deliveries rather than one message made of pieces. The window is hardcoded in
    // the proxy with no env seam, so the chain is what has to clear it.
    queueCallGapMs = 3_000;
    queueCallHeard = [
      'queue one',
      'queue two',
      'queue three',
      'queue four',
      'queue five',
      'queue six',
      'queue seven',
      'queue eight',
    ];
    queueCallMessages = [
      'delivery one',
      'delivery two',
      'delivery three',
      'delivery four',
      'delivery five',
      'delivery six',
      'delivery seven',
      'delivery eight',
    ];
    try {
      // The bar's own byte reading, sampled while the gesture runs. This is the "the wait is visible"
      // half of the criterion taken off the screen rather than inferred from frames.
      await page.evaluate(() => {
        const holder = window as unknown as Record<string, unknown>;
        const samples: string[] = [];
        holder.__voiceQueueBytes = samples;
        const timer = window.setInterval(() => {
          const cell = document.querySelector('[data-testid="voice-realtime-status"]');
          samples.push(cell?.getAttribute('data-queued-bytes') ?? 'none');
        }, 60);
        holder.__voiceQueueBytesStop = () => window.clearInterval(timer);
      });

      await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);

      const status = page.getByTestId('voice-realtime-status');

      // `callOutputs` outlives this case: the endpoint is shared by every case in the file, so the count
      // read here is a TOTAL. The reading that matters is the delta THIS gesture added — the eight calls
      // of this chain, one tool result each and none of them the refusal code. A bare `toBe(8)` would
      // pass on the earlier cases' leftovers before a single one of these eight had been answered.
      const outputsBefore = upstream.functionCallOutputs().length;
      await expect
        .poll(() => upstream.functionCallOutputs().length - outputsBefore, { timeout: 45_000 })
        .toBe(8);
      const delivered = upstream.functionCallOutputs().slice(outputsBefore);
      expect(
        delivered.filter((entry) => JSON.stringify(entry.output ?? null).includes('VOICE_QUEUE_FULL')).length,
        `none of the eight may be refused inside the budget: ${JSON.stringify(delivered)}`,
      ).toBe(0);

      // Nothing was refused on the screen either: the status cell never carried the refusal marker.
      await expect(status).not.toHaveAttribute('data-refusal', /.+/);

      // The wait is visible AS BYTES and it climbed above zero — the person can read how much of their
      // speech is waiting on the busy session before the budget is anywhere near full.
      const bytes = Number((await status.getAttribute('data-queued-bytes')) ?? '0');
      expect(bytes, 'the bar must show the waiting byte backlog').toBeGreaterThan(0);

      const samples = await page.evaluate(() => {
        const holder = window as unknown as Record<string, unknown>;
        (holder.__voiceQueueBytesStop as (() => void) | undefined)?.();
        return (holder.__voiceQueueBytes as string[] | undefined) ?? [];
      });
      expect(
        samples.some((reading) => Number(reading) > 0),
        `the bar never showed a non-zero byte reading: ${samples.join(' ')}`,
      ).toBe(true);
    } finally {
      queueCallCount = 1;
      queueCallGapMs = 0;
      queueCallMessages = null;
      queueCallHeard = null;
      await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
    }
  });
});
