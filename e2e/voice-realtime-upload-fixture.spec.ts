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

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';

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
const PHASE_STATES: readonly string[] = ['idle', 'connecting', 'listening', 'muted', 'failed'];

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
 * What the fake endpoint reports it HEARD (AC-317), deliberately a different
 * string from {@link PROPOSED_TEXT}: the model's own `session_send` arguments and
 * the transcription of the audio are two separate channels, and a run where they
 * were the same string could not tell them apart.
 */
const HEARD_TEXT = 'what the endpoint transcribed from the uploaded audio';

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
 * Writes a tiny 16 kHz mono 16-bit PCM WAV file — a deterministic, fixed-corpus
 * stand-in for "someone uploaded a short recording" — and returns its path.
 *
 * A real, decodable WAV rather than silence-with-the-right-headers: the samples
 * are a quiet sine tone, so `AudioContext.decodeAudioData` has real audio data
 * to hand back, not an all-zero buffer a decoder could special-case.
 */
function writeFixtureWav(seconds: number): string {
  const sampleRate = 16_000;
  const sampleCount = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.2 * 0x7fff;
    data.writeInt16LE(Math.round(value), index * 2);
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
  close(): Promise<void>;
};

function startFakeUpstream(port: number): Promise<FakeUpstream> {
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  let boundSessionId = '';
  let connections = 0;
  let calls = 0;
  let audioFrames = 0;

  server.on('connection', (socket) => {
    connections += 1;
    let callSent = false;

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

      if (frame.type === 'input_audio_buffer.append') {
        audioFrames += 1;
        if (callSent || boundSessionId.length === 0) {
          return;
        }
        callSent = true;
        calls += 1;
        // AC-317: the endpoint also transcribes the user's OWN audio. Emitted in
        // DashScope's real shape — a `delta` carries its running text in `stash`
        // (with `text` present but empty) and `completed` carries the final text
        // in `transcript`, both grouped by `item_id`. The browser must render this
        // as the user's own message WITHOUT it ever becoming model input.
        const itemId = `item_fake_${calls}`;
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: itemId,
            stash: identicalText ?? HEARD_TEXT,
            text: '',
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: itemId,
            transcript: identicalText ?? HEARD_TEXT,
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.function_call_arguments.done',
            call_id: `call_fake_${calls}`,
            name: 'session_send',
            arguments: JSON.stringify({ session: boundSessionId, message: identicalText ?? PROPOSED_TEXT, waitSeconds: 0.5 }),
          }),
        );
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
  await page.getByTestId('live-voice-enter').click();
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

test.describe.configure({ mode: 'serial' });

test.describe('voice realtime upload fixture', () => {
  let page: Page;
  let api: APIRequestContext;
  let upstream: FakeUpstream;
  let sessionId = '';
  let workspaceName = '';
  let fixturePath = '';

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

    fixturePath = writeFixtureWav(0.6);
    upstream = await startFakeUpstream(upstreamPort);

    const workspace = path.join(fixtureHome, 'voice-realtime-upload-workspace');
    workspaceName = path.basename(workspace);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();

    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    sessionId = await armScenario(api, workspace, SCENARIO);
    upstream.setBoundSessionId(sessionId);

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

    // AC-317, as the person asked for it: the message DELIVERED to Claude is the row, and it is
    // marked as coming from the voice transcript. What the recogniser heard (a different string
    // from the instruction the model chose to send) is kept one hover away, not as a second row.
    const delivered = page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT });
    await expect.poll(() => delivered.count(), { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
    const badge = delivered.first().getByTestId('voice-transcript-badge');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveAttribute('title', new RegExp(HEARD_TEXT));
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

    // History, not this page's live state.
    await page.reload();
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

    await page.reload();
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
});
