/**
 * GOAL-035 / AC-323 — the browser criterion for the Live Voice bar INSIDE the
 * composer box, on a real browser against a real server.
 *
 * WHAT THIS FILE IS FOR. `voice-realtime-live-session-send.spec.ts` (AC-316)
 * proves the mode swap, the continuous capture and the immediate `session_send`.
 * Four claims of the human requirement behind AC-323 were argued structurally
 * there and never measured in a browser: that a caption longer than its cell
 * truncates instead of growing the bar, that the bar never covers the last
 * transcript row, that the in-bar model selector exists at all (the fixture
 * provider carried no model options, so the menu was `null`), and that a socket
 * the SERVER closed leaves the user a Retry that really reconnects. This file
 * reads each of them as a DOM or protocol fact:
 *
 *   · the default composer carries the dictation mic and, right of it, the
 *     submit button doubled as the Live Voice entry (empty draft) inside
 *     `[data-slot="prompt-input"]` — at 1280px and at 375px;
 *   · the bar's height AND its top edge are the same (within 2px) while
 *     listening, while muted, and while a model call is executing;
 *   · a ≥400-character interim caption is truncated by its own cell
 *     (`scrollWidth > clientWidth`) and leaves the bar's height alone;
 *   · the bar's top edge is at or below the transcript pane's bottom edge and
 *     the newest user row's bottom edge — it distinguishes itself from the
 *     transcript instead of covering it;
 *   · a provider WITH model options puts a working selector in the bar;
 *   · a socket the server closed reads "Voice disconnected" (not "Connecting"),
 *     offers NO way back — the reconnect control the strip deleted
 *     (`gap-voice-ui-strip-to-caption-and-connection-state`, 2026-10-14) — and
 *     re-dials nothing on its own, so a drop is something the person leaves
 *     rather than something the client retries behind them.
 *
 * WHAT IS REAL AND WHAT IS NOT. The microphone is a stand-in because no CI
 * machine has one: an init script replaces `AudioContext`, `AudioWorkletNode`
 * and `getUserMedia` with an inert graph this file pushes PCM into
 * (`__voiceFake.speak(0.6)`). The Realtime upstream (DashScope) is a stand-in
 * too: the server dials `VOICE_REALTIME_ENDPOINT`, which `playwright.config.ts`
 * points at a port this file's own WS server owns. Everything else — the
 * browser hook, the `/voice-realtime` proxy, the bridge, the real `session_send`
 * and the transcript write — is the shipping code.
 *
 * WHY THE HELPERS ARE COPIED, NOT IMPORTED. The task's proposal says so: a spec
 * that imports another spec's fixture couples two criteria to one file's
 * exports, and this one needs a different upstream (it must be able to REFUSE a
 * handshake, and to emit a caption this file chooses) than that one has.
 *
 * WHY IT SIGNS IN AS THE SIBLINGS' ACCOUNT. AC-323's criterion runs this file
 * together with the two beside it against one server and one data directory,
 * and that server is single-user — the first registration takes the only seat.
 * Sharing `USERNAME` is what makes the three runnable in any order; see the
 * constant for the failure that a private account produced.
 */

import { createServer } from 'node:http';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';

const PANE = '.chat-messages-pane';
const USER_ROW = '[data-message-style="user"]';
/** The composer's textarea testid — present exactly while `ChatComposer` is mounted. */
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';
const BAR = '[data-testid="voice-realtime-bar"]';
const CAPTION = '[data-testid="voice-realtime-caption"]';

/**
 * The answerable panel's header copy — the one string unique to the surface this file's
 * last case is about, so "the pending question is on screen" is read off the panel itself
 * rather than off something the bar would show anyway.
 */
const PANEL_HEADER = 'Claude needs your input';
/** The option the last case picks; it must match the label the injected frame carries. */
const ASK_OPTION_LABEL = 'Narrow the change';

/**
 * AC4's tolerance for the bar's own box across the banner appearing and disappearing.
 *
 * The criterion names 4px. This file's other state-to-state readings use 2px — a stricter
 * number, and one that still holds here, because the composer is bottom-anchored: content
 * ABOVE the bar grows the shell upward and leaves the bar's own top edge and height alone.
 * The looser criterion number is the one asserted, so a reader comparing against the AC
 * sees the same bound the AC states rather than a number this file quietly tightened.
 */
const BANNER_GEOMETRY_TOLERANCE_PX = 4;

/**
 * The SAME fixture account the two voice-realtime specs beside this one use.
 *
 * The criterion runs all three against one server and one data directory, and the
 * server is single-user: the first `register` creates the account and every later
 * one answers 403 `AUTH_USER_ALREADY_CONFIGURED`. Sharing the credentials is what
 * makes the three order-independent — whoever starts first registers, the others
 * sign in. A file with an account of its own would take the only seat, and the
 * sibling that then failed `login` would look like a broken spec rather than a
 * registration that never had a chance.
 */
const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';
const TITLE = 'Voice bar — AC-323 arm';
const SEED_USER_TEXT = 'seeded user turn for the composer-embedded bar criterion';

/** What the fake upstream's function call tells the model to send. */
const PROPOSED_TEXT = 'voice instruction behind the compact bar';

/**
 * The row the HELD run writes only once it is finally let past its own delay — the proof, at the
 * browser level, that clicking Exit did not abort the run.
 *
 * The last case reads it twice: absent from the transcript while the run is in flight, present after
 * the mode was left. Only a run that outlives the leave can produce that order, so the row landing is
 * the reading — not an argument — that exiting Live Voice leaves the turn alone.
 */
const FINAL_TURN_TEXT = 'the turn finished after the mode was left';

/**
 * How long the fake microphone is asked to speak. `speak()` wraps it in a calibration lead-in and a
 * trailing pause (see its own comment in the init script) and hands the whole thing to the page as
 * ONE message, so on the continuous path it is one `audio` frame and on the default (segmented) path
 * it is exactly one committed sentence — which is why the two frame-count assertions below, each of
 * which reads a burst as one more `input_audio_buffer.append`, hold on either framing.
 */
const SPEECH_SECONDS = 0.6;
/** How long the real `session_send` is asked to take, so the executing window is observable. */
const SEND_WAIT_SECONDS = 2.5;

/**
 * The over-long interim caption of case (c): the same sentence repeated past the
 * 400 characters the criterion names. Built rather than typed so the length is a
 * fact the spec can assert instead of a number a reader has to count.
 */
const LONG_CAPTION = 'the model keeps hearing a much longer utterance than this cell can ever show '.repeat(6);

/** The model this file adds so the bar has a selector to show, and its label. */
const CUSTOM_MODEL_ID = 'e2e-voice-bar-model';
const CUSTOM_MODEL_LABEL = 'claude-voice-bar-e2e';

/**
 * A scenario that only exists to make the session armable.
 *
 * `armDebugAgentScenario` refuses a document whose `steps` is empty and whose
 * `expect` is absent, so this is the smallest valid one: its walk writes nothing
 * (`wait` at t=0) and finishes at once. The run the voice send opens is a carrier
 * for the typed-turn row the PROVIDER writes, and the clock is never advanced here.
 */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

// ---------------------------------------------------------------------------------------------
// The fake Realtime upstream.
// ---------------------------------------------------------------------------------------------

type FakeUpstream = {
  /** Arms the stand-in: it answers audio with a call only once the bound session is known. */
  setBoundSessionId(id: string): void;
  /**
   * The session the stand-in currently answers, `''` while none is bound.
   *
   * `pushFirstCaptureFrame` needs it to clear the binding across the first captured frame: that
   * frame is uploaded like any other, and if the endpoint answered it the connection's
   * once-only `session_send` budget would be spent before the spec's own burst.
   */
  getBoundSessionId(): string;
  /**
   * Makes the endpoint unreachable: every handshake is dropped before it completes.
   *
   * This is how the criterion's "the server closed the socket" is produced from
   * the outside. The app server dials this endpoint while opening a session; with
   * the dial refused three times its connect budget is spent, the bridge settles
   * `closed`, and the `/voice-realtime` proxy — reading that as "there is no
   * session to advertise" — closes the BROWSER's socket. Nothing else in the
   * shipping code closes a browser socket on the server's side, so this is the
   * path the requirement's own words describe.
   */
  setRefusing(refusing: boolean): void;
  /** One interim transcription of the user's audio, carrying the text this file chooses. */
  emitInterimCaption(text: string): void;
  /** How many upstream handshakes have COMPLETED (a refused one is not a connection). */
  connectionCount(): number;
  /** How many `input_audio_buffer.append` frames the upstream has received. */
  audioFrameCount(): number;
  /** How many `session_send` proposals the upstream has emitted. */
  callCount(): number;
  close(): Promise<void>;
};

/**
 * Starts the DashScope stand-in on `port` and returns the handle the spec drives.
 *
 * The dialect is the endpoint's `session_send` delivery and nothing else: the
 * FIRST audio frame of a connection is answered with a `session_send` function
 * call. The call's `arguments` carry `waitSeconds`, so the send resolves only
 * after the debug run has written the transcript row — which is what gives the
 * spec a visible in-flight window to measure the bar through.
 *
 * The upgrade is handled by hand (`noServer`) rather than by `new
 * WebSocketServer({ port })` for one reason: {@link FakeUpstream.setRefusing}
 * has to be able to drop a handshake while the listener stays up, so the retry
 * later dials the SAME listener — the port is never released, and the connection
 * count is never reset by a rebind.
 */
function startFakeUpstream(port: number): Promise<FakeUpstream> {
  const http = createServer();
  const server = new WebSocketServer({ noServer: true });
  let boundSessionId = '';
  let refusing = false;
  let connections = 0;
  let calls = 0;
  let audioFrames = 0;
  let captions = 0;

  http.on('upgrade', (req, socket, head) => {
    if (refusing) {
      // Dropped before the handshake completes: the dial fails, and no
      // `connection` event fires, so this attempt is not counted as a connection.
      socket.destroy();
      return;
    }
    server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws, req));
  });

  const broadcast = (frame: Record<string, unknown>): void => {
    for (const client of server.clients) {
      client.send(JSON.stringify(frame));
    }
  };

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
      // it is the endpoint answering us, not a failure.
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
        // The endpoint also transcribes the user's OWN audio, in DashScope's real
        // shape: a `delta` carries its running text in `stash` (with `text` present
        // but empty) and `completed` carries the final text in `transcript`, both
        // grouped by `item_id`.
        const itemId = `item_bar_${calls}`;
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: itemId,
            stash: SEED_USER_TEXT,
            text: '',
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: itemId,
            transcript: SEED_USER_TEXT,
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.function_call_arguments.done',
            call_id: `call_bar_${calls}`,
            name: 'session_send',
            // NO `session`: the instructions tell the model "the session is fixed by the
            // connection; never name one", and the real model obeys.
            arguments: JSON.stringify({ message: PROPOSED_TEXT, waitSeconds: SEND_WAIT_SECONDS }),
          }),
        );
      }
    });
  });

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('the fake Realtime upstream never began listening')), 10_000);
    http.once('listening', () => {
      clearTimeout(deadline);
      resolve({
        setBoundSessionId: (id: string) => {
          boundSessionId = id;
        },
        getBoundSessionId: () => boundSessionId,
        setRefusing: (value: boolean) => {
          refusing = value;
        },
        emitInterimCaption: (text: string) => {
          captions += 1;
          broadcast({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: `caption_bar_${captions}`,
            stash: text,
            text: '',
          });
        },
        connectionCount: () => connections,
        audioFrameCount: () => audioFrames,
        callCount: () => calls,
        close: () =>
          new Promise<void>((done) => {
            // `WebSocketServer.close()` only stops accepting new clients and then waits
            // for every existing one to disconnect — a proxy socket still parked on the
            // upstream would hang teardown. Terminate them, so close always settles.
            for (const client of server.clients) {
              client.terminate();
            }
            server.close(() => http.close(() => done()));
          }),
      });
    });
    http.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    http.listen(port, '127.0.0.1');
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

/** Expands the fixture project until the session's row is on screen. Bounded, and never silent. */
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

/** Creates (or signs in) the fixture account and returns its bearer token. */
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

/** Arms one scenario and returns the session id the rest of this file addresses it by. */
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
// The transport double for the last case.
// ---------------------------------------------------------------------------------------------

/**
 * Wraps `window.WebSocket` and exposes a way to hand the app ONE frame on its own chat socket.
 *
 * The debug fixture's scenario has no approval step, so a pending question is not something
 * this file's real run can produce. What is doubled is therefore the TRANSPORT, never the
 * consumer: after the frame lands, the app's own realtime → store → React path renders the
 * panel and the decision path posts the answer — the shipping code end to end. Only sockets
 * whose url carries `/ws` are addressed; the Live Voice socket is a different one and is left
 * untouched, which is also why the connection it holds survives the injection.
 */
const installWireDouble = () => {
  const page = window as unknown as {
    __wireSockets: { url: string; socket: WebSocket }[];
    __injectFrame: (frame: unknown) => number;
  };
  page.__wireSockets = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      page.__wireSockets.push({ url: String(args[0]), socket: this as WebSocket });
    }
  } as unknown as typeof WebSocket;
  page.__injectFrame = (frame: unknown) => {
    const data = JSON.stringify(frame);
    let delivered = 0;
    for (const entry of page.__wireSockets) {
      if (!entry.url.includes('/ws')) continue;
      if (entry.socket.readyState !== 1) continue;
      entry.socket.dispatchEvent(new MessageEvent('message', { data }));
      delivered += 1;
    }
    return delivered;
  };
};

/**
 * Hands the app one `permission_request` for an `AskUserQuestion`, in the shape the server sends.
 *
 * No `seq` and no `complete`: no provider run is in flight, so there is no sequence to resume
 * and nothing for the client to re-fetch — either field would make the client retract the very
 * prompt this case measures.
 */
const injectAskUserQuestion = (page: Page, sessionId: string, requestId: string) =>
  page.evaluate(
    ({ sid, rid }: { sid: string; rid: string }) =>
      (window as unknown as { __injectFrame: (frame: unknown) => number }).__injectFrame({
        id: `e2e-voice-ask-${rid}`,
        kind: 'permission_request',
        requestId: rid,
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which approach should this change take?',
              header: 'Approach',
              multiSelect: false,
              options: [
                { label: 'Narrow the change', description: 'Touch only the surface that misbehaves.' },
                { label: 'Widen the change', description: 'Also rework the surrounding composer rows.' },
              ],
            },
          ],
        },
        sessionId: sid,
        timestamp: new Date().toISOString(),
        provider: 'claude',
        role: 'assistant',
      }),
    { sid: sessionId, rid: requestId },
  );

/**
 * Waits until the app's own chat socket is open, so a frame injected now has somewhere to land.
 *
 * The socket opens after the document loads, so waiting for the pane to be visible is too early.
 * Bounded, because a socket that never opens is a reading about this run, not a reason to hang.
 */
const waitForChatSocket = async (page: Page): Promise<void> => {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const sockets = (window as unknown as { __wireSockets?: { url: string; socket: WebSocket }[] }).__wireSockets ?? [];
          return sockets.filter((entry) => entry.url.includes('/ws') && entry.socket.readyState === 1).length;
        }),
      { timeout: 30_000, message: 'the app never opened its chat socket, so no frame could be delivered' },
    )
    .toBeGreaterThan(0);
};

// ---------------------------------------------------------------------------------------------
// The control.
// ---------------------------------------------------------------------------------------------

const phase = async (page: Page): Promise<string> =>
  ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();

const waitForPhase = (page: Page, wanted: string) =>
  expect.poll(() => phase(page), { timeout: 25_000 }).toBe(wanted);

/** The transcript's own text, read straight off the pane. */
const paneText = (page: Page): Promise<string> => page.locator(PANE).innerText();

/** One spoken burst — the fake microphone's only action. */
const speak = (page: Page, seconds: number): Promise<void> =>
  page.evaluate((value: number) => {
    (window as unknown as { __voiceFake: { speak(seconds: number): void } }).__voiceFake.speak(value);
  }, seconds);

/** The page-side capture probe `pushFirstCaptureFrame` drives (installed in the init script). */
type CaptureProbe = {
  /** The most recently constructed worklet — the one the next `start()` adopts and wires. */
  node: { port: { onmessage: ((message: unknown) => void) | null } } | null;
  /** Constructed worklets, and how many of them the last push satisfied. */
  constructed: number;
  pushed: number;
  /** Pushes the one frame that makes `listening` reachable; `false` until the graph is wired. */
  pushFirstFrame: () => boolean;
};

/**
 * Pushes the one captured frame that makes `listening` reachable — WITHOUT spending the endpoint's call.
 *
 * WHY IT IS NEEDED. Upstream `state: open` only takes the bar to `arming`; `listening` is set when
 * capture delivers its FIRST frame (`c99a0eaba`). The fake graph is inert — frames only leave it via
 * `__voiceFake.speak()` — so every initial `waitForPhase(page, 'listening')` below would poll
 * `arming` until it timed out. This is the same contract `e2e/voice-realtime-live-session-send.spec.ts`
 * and `e2e/voice-realtime-intent-control.spec.ts` satisfy with their own helpers.
 *
 * WHY THE BINDING IS CLEARED ACROSS IT. The stand-in answers the FIRST audio frame of each connection
 * with a `session_send` — and only the first (`callSent`). That frame is uploaded exactly like any
 * other, so if the endpoint were bound while it arrived, the arming frame would spend the connection's
 * once-only call budget and the spec's own `speak()` would never produce the call it measures
 * (case 6's `callCount() >= callsBefore + 1`). It is cleared, the frame is pushed, and the binding is
 * restored only once the frame has REACHED the upstream (`audioFrameCount`), so the append is
 * processed while unbound rather than racing the restore.
 */
async function pushFirstCaptureFrame(page: Page, upstream: FakeUpstream): Promise<void> {
  const boundSessionId = upstream.getBoundSessionId();
  const framesBefore = upstream.audioFrameCount();
  upstream.setBoundSessionId('');
  try {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const capture = (window as unknown as { __voiceCaptureProbe?: CaptureProbe }).__voiceCaptureProbe;
            return capture?.pushFirstFrame() ?? false;
          }),
        {
          timeout: 20_000,
          message: 'the capture graph never wired a worklet to receive the first captured frame',
        },
      )
      .toBe(true);
    // The browser uploads that frame asynchronously. Wait for the upstream to have SEEN it, so the
    // restore below cannot beat the append and hand the arming frame a `session_send` after all.
    await expect
      .poll(() => upstream.audioFrameCount(), {
        timeout: 20_000,
        message: 'the first captured frame never reached the fake upstream',
      })
      .toBeGreaterThanOrEqual(framesBefore + 1);
  } finally {
    upstream.setBoundSessionId(boundSessionId);
  }
}

/**
 * Writes a screenshot when QUAY_LIVE_VOICE_SHOT_DIR is set; a no-op in ordinary runs.
 *
 * The name's trailing width is checked against the page's own viewport first. The five
 * artefacts are named for a viewport, and a case that changed the viewport without the
 * name following it (or the reverse) would file a 375px picture under a `-1280` name —
 * an artefact whose label is a claim nothing verified.
 */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.QUAY_LIVE_VOICE_SHOT_DIR;
  const named = /-(1280|375)$/.exec(name);
  if (named) {
    expect(page.viewportSize()?.width, `the shot ${name} is named for a width it was not taken at`).toBe(Number(named[1]));
  }
  // Colours transition on state change; let them settle so the picture shows the resting state.
  if (dir) await page.waitForTimeout(700);
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** The bar's own box, as the four numbers every geometry claim in this file is made of. */
async function barBox(page: Page): Promise<{ height: number; top: number; bottom: number; left: number; right: number }> {
  const box = await page.locator(BAR).boundingBox();
  if (!box) await explain(page, 'the voice bar had no box');
  return { height: box!.height, top: box!.y, bottom: box!.y + box!.height, left: box!.x, right: box!.x + box!.width };
}

/**
 * Enters Live Voice and waits for the bar to have replaced the composer.
 *
 * The entry lives INSIDE the composer, as its own control beside the dictation
 * mic — never in a strip above the box. The old external button's id must be
 * gone, and both entries must be on one row at whatever width is current.
 *
 * `width` IS the viewport, not just the label: it is set here, so a case that
 * asks for 1280 measures and photographs 1280 no matter what the case before it
 * left behind.
 */
async function enterLiveVoice(page: Page, width: number, upstream: FakeUpstream): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await expect(page.getByTestId('live-voice-enter')).toHaveCount(0);
  const entry = page.getByTestId('live-voice-button');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-slot="prompt-input"]').getByTestId('live-voice-button')).toHaveCount(1);
  const mic = page.getByTestId('voice-input-button');
  await expect(mic).toBeVisible({ timeout: 15_000 });
  const micBox = await mic.boundingBox();
  const entryBox = await entry.boundingBox();
  expect(
    micBox && entryBox && entryBox.x > micBox.x && Math.abs(entryBox.y - micBox.y) < 8,
    'the dictation mic and the Live Voice entry are two controls on one row, mic first',
  ).toBeTruthy();
  await expect(entry).toHaveAttribute('aria-label', /Live Voice/);
  await shot(page, `composer-embedded-default-${width}`);
  await entry.click();
  await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
  await pushFirstCaptureFrame(page, upstream);
  await waitForPhase(page, 'listening');
}

/** Ends Live Voice and waits for the ordinary composer to come back. */
async function leaveLiveVoice(page: Page): Promise<void> {
  await page.getByTestId('voice-realtime-end').click();
  await expect(page.locator(BAR)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 15_000 });
}

/**
 * The bar's top edge against the transcript it sits under.
 *
 * The pane is scrolled to its own bottom first, so the newest row is the one
 * being read rather than whichever row happened to be in the viewport. Both
 * numbers the criterion names are returned: the pane's bottom edge and the
 * newest user row's bottom edge.
 */
async function transcriptClearance(page: Page) {
  const pane = page.locator(PANE);
  await pane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(200);
  const paneBox = await pane.boundingBox();
  const rows = page.locator(`${PANE} ${USER_ROW}`);
  const count = await rows.count();
  const lastBox = count > 0 ? await rows.nth(count - 1).boundingBox() : null;
  const bar = await barBox(page);
  return { paneBottom: paneBox ? paneBox.y + paneBox.height : Number.NaN, paneTop: paneBox?.y ?? Number.NaN, lastBottom: lastBox ? lastBox.y + lastBox.height : null, rowCount: count, barTop: bar.top };
}

test.describe.configure({ mode: 'serial' });

test.describe('voice realtime composer embedded bar', () => {
  let page: Page;
  let api: APIRequestContext;
  let upstream: FakeUpstream;
  let sessionId = '';
  let workspaceName = '';
  let workspacePath = '';
  let modelRecordId = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    const upstreamPort = Number(process.env.QUAY_E2E_VOICE_REALTIME_PORT);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_PORT for this selection');
    }

    upstream = await startFakeUpstream(upstreamPort);

    const workspace = path.join(fixtureHome, 'voice-realtime-workspace');
    workspaceName = path.basename(workspace);
    workspacePath = workspace;

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();

    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    sessionId = await armScenario(api, workspace, SCENARIO);
    upstream.setBoundSessionId(sessionId);

    // Case (e): the bar's model selector is only rendered when the active provider HAS
    // model options, and the fixture provider ships none. Adding one to the user's model
    // library is what makes the selector exist at all; the row is removed in `afterAll`
    // so no other spec's row count sees it.
    const created = await api.post('/api/providers/claude/models', {
      data: { id: CUSTOM_MODEL_ID, model: CUSTOM_MODEL_LABEL },
    });
    const createdBody = await created.json().catch(() => null);
    if (created.status() !== 201) {
      throw new Error(`creating the bar's model answered ${created.status()}: ${JSON.stringify(createdBody)}`);
    }
    modelRecordId = createdBody?.data?.model?.recordId ?? '';

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    await context.addInitScript(
      ({ authToken }: { authToken: string }) => {
        window.localStorage.setItem('auth-token', authToken);
        window.localStorage.setItem('userLanguage', 'en');
        // Dictation enabled, so the default composer carries both voice entries.
        const preferences = { voiceEnabled: true };
        window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
        window.localStorage.setItem('user-preferences', JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }));

        // The fake audio graph. `speak` is the driver the spec uses; `node` is
        // where the hook attaches its `onmessage`, captured at construction.
        //
        // WHAT `speak` EMITS, AND WHY IT IS NOT A FLAT TONE. The shipping relay's
        // voice-activity detector measures its noise floor as the sliding 15th percentile of
        // the frames it has just seen, so a constant-amplitude burst BECOMES that floor and
        // never clears the speech factor above it — a flat `samples.fill(0.3)` is silence to
        // the detector, so under the default (segmented) relay the client released no segment
        // and the fake upstream's `callCount()` sat at zero while `:644` waited for it. One
        // burst is therefore built like a spoken sentence: a quiet lead-in for the detector's
        // half-second bootstrap to calibrate against, a syllable-shaped run (a 3 Hz envelope
        // over a 180 Hz carrier) that reads as speech, and a trailing pause longer than the
        // relay's own 2.0 s commit gap. The pause is what makes the sentence COMMIT and reach
        // the upstream while the spec is still listening, rather than waiting inside the
        // segmenter for Mute or End to flush it. This is the same fixture the two sibling
        // voice-realtime specs carry; see `voice-realtime-live-session-send.spec.ts`.
        const buildSpeechBurst = (seconds: number): Float32Array => {
          const rate = 16_000;
          const lead = Math.round(0.6 * rate);
          const body = Math.round(Math.max(0.2, seconds) * rate);
          const tail = Math.round(2.2 * rate);
          const samples = new Float32Array(lead + body + tail);
          for (let i = 0; i < lead; i += 1) {
            samples[i] = 0.02 * Math.sin((2 * Math.PI * 220 * i) / rate);
          }
          for (let i = 0; i < body; i += 1) {
            const envelope = 0.5 + 0.5 * Math.sin((2 * Math.PI * 3 * i) / rate);
            samples[lead + i] = 0.5 * envelope * Math.sin((2 * Math.PI * 180 * i) / rate);
          }
          return samples;
        };
        type Port = { port: { onmessage: ((m: unknown) => void) | null } };
        // `constructed`/`pushed` make "exactly one first frame per capture session" a page-side
        // fact rather than a caller's promise; they are shared with `__voiceCaptureProbe` below.
        const state: {
          node: Port | null;
          atSample: number;
          constructed: number;
          pushed: number;
          speak: (seconds: number) => void;
          pushFirstFrame: () => boolean;
        } = {
          node: null,
          atSample: 0,
          constructed: 0,
          pushed: 0,
          speak(seconds) {
            const node = state.node;
            if (!node) throw new Error('the fake capture was not connected yet');
            const samples = buildSpeechBurst(seconds);
            node.port.onmessage?.({ data: { type: 'pcm', samples, atSample: state.atSample } });
            state.atSample += samples.length;
          },
          /**
           * The one captured frame that takes the bar from `arming` to `listening`.
           *
           * Upstream `state: open` only reaches `arming`; `listening` is set by the first frame
           * capture delivers (`c99a0eaba`). This graph is inert — frames only leave it through
           * `speak()` — so `waitForPhase(page, 'listening')` would poll `arming` until it timed out.
           *
           * WHEN IT LANDS. Only once `start()` has WIRED the most recently constructed worklet:
           * `port.onmessage` is assigned after the asynchronous acquisition, and a frame pushed
           * before that is dropped. And only once per worklet, so a later capture session's first
           * frame cannot be satisfied by an earlier one.
           */
          pushFirstFrame() {
            const node = state.node;
            if (!node || node.port.onmessage === null) return false;
            if (state.pushed >= state.constructed) return false;
            const samples = new Float32Array(3_200); // 200 ms at 16 kHz
            for (let index = 0; index < samples.length; index += 1) {
              samples[index] = 0.2 * Math.sin((2 * Math.PI * 180 * index) / 16_000);
            }
            node.port.onmessage({ data: { type: 'pcm', samples, atSample: state.atSample } });
            state.atSample += samples.length;
            state.pushed = state.constructed;
            return true;
          },
        };
        (window as unknown as { __voiceFake: typeof state }).__voiceFake = state;
        // The probe `pushFirstCaptureFrame` drives. Same object, so the first-frame push keeps the
        // segmenter's `atSample` ledger contiguous with `speak`'s bursts.
        (window as unknown as { __voiceCaptureProbe: typeof state }).__voiceCaptureProbe = state;

        class FakeWorkletNode {
          port: { onmessage: ((m: unknown) => void) | null; postMessage: () => void };
          constructor() {
            this.port = { onmessage: null, postMessage: () => undefined };
            state.node = this as unknown as typeof state.node;
            state.constructed += 1;
          }

          connect() {
            /* the graph is inert; the spec drives the port directly */
          }
        }

        // The capture `AudioContext`. `audioSource.ts` subscribes with `addEventListener('statechange')`
        // and calls `resume()`, so both members must exist or the microphone source throws inside its
        // own async body (`activeContext.addEventListener is not a function`) — a `TypeError` the
        // session hook catches and renders as a bar error in the caption cell, which `:778` then reads
        // instead of the model's caption. The shape matches `e2e/voiceRealtimeFakeMic.ts`'s same-named
        // fake; no statechange is driven here, so `state` stays `running` and `resume()` resolves.
        class FakeAudioContext {
          sampleRate = 16_000;
          destination = {};
          state = 'running';
          audioWorklet = { addModule: async () => undefined };
          private readonly stateChangeListeners: Array<() => void> = [];
          createGain() {
            return { gain: { value: 0 }, connect: () => undefined };
          }

          createMediaStreamSource() {
            return { connect: () => undefined };
          }

          close() {
            return Promise.resolve();
          }

          addEventListener(type: string, listener: () => void) {
            if (type === 'statechange') this.stateChangeListeners.push(listener);
          }

          resume() {
            return Promise.resolve();
          }
        }

        (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
        (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
        });
      },
      { authToken: token },
    );
    page = await context.newPage();
    // Dictation reads as available, so the default composer carries BOTH voice entries.
    await page.route('**/api/voice/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) }),
    );

    await page.goto('/');
    if (!(await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
      await page.reload();
    }
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    // The model library spec asserts how many rows it finds, so the row this file
    // added has to be gone before any other file runs.
    if (modelRecordId) {
      const removed = await api
        .delete(`/api/providers/claude/models/${modelRecordId}`)
        .catch(() => null);
      expect(removed?.status() ?? 0, 'deleting the bar model has to answer 2xx').toBeLessThan(300);
    }
    await page?.close();
    await api?.dispose();
    await upstream?.close();
  });

  test('1280px: the bar holds one geometry through listening, mute and an executing call, truncates a long caption, and carries the model selector', async () => {
    expect(LONG_CAPTION.length, 'the criterion names a ≥400-character caption').toBeGreaterThanOrEqual(400);
    const bar = page.locator(BAR);
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });

    await enterLiveVoice(page, 1280, upstream);

    // (b) state one — listening.
    const listening = await barBox(page);
    await expect(page.getByTestId('voice-realtime-elapsed')).toHaveText(/^\d\d:\d\d$/);
    await expect(page.getByTestId('voice-realtime-wave')).toBeVisible();
    await expect(page.getByTestId('voice-realtime-mute')).toBeVisible();
    await expect(page.getByTestId('voice-realtime-end')).toBeVisible();
    await shot(page, 'composer-embedded-listening-1280');

    // (e) is read on its own session — see the case below: this fixture's session runs
    // the debug provider, which has no model catalog to put in the bar.

    // (c) a caption no cell can hold: it truncates, and the bar does not grow.
    upstream.emitInterimCaption(LONG_CAPTION);
    await expect(page.getByTestId('voice-realtime-caption')).toHaveText(LONG_CAPTION, { timeout: 15_000 });
    const clipped = await page.locator(CAPTION).evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      whiteSpace: getComputedStyle(element).whiteSpace,
    }));
    expect(
      clipped.scrollWidth > clipped.clientWidth,
      `the caption cell has to clip ${LONG_CAPTION.length} characters rather than widen: ${JSON.stringify(clipped)}`,
    ).toBeTruthy();
    expect(Math.abs((await barBox(page)).height - listening.height)).toBeLessThanOrEqual(2);

    // (b) state two — muted.
    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'muted');
    const muted = await barBox(page);
    await shot(page, 'composer-embedded-muted-1280');
    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'listening');

    // (b) state three — a model call actually executing. The burst is what makes the
    // fake endpoint propose one; the send is asked to take seconds, so the window is
    // wide enough that the geometry is read WHILE the call is in flight.
    await speak(page, SPEECH_SECONDS);
    await expect.poll(() => upstream.callCount(), { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
    const executing = await barBox(page);
    await shot(page, 'composer-embedded-executing-1280');

    for (const [name, state] of [['muted', muted], ['executing', executing]] as const) {
      expect(Math.abs(state.height - listening.height), `the bar's height moved while ${name}`).toBeLessThanOrEqual(2);
      expect(Math.abs(state.top - listening.top), `the bar's top edge moved while ${name}`).toBeLessThanOrEqual(2);
    }

    // (d) the bar distinguishes itself from the transcript instead of covering it.
    await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(PROPOSED_TEXT);
    const clearance = await transcriptClearance(page);
    expect(clearance.rowCount, 'the transcript has to have a newest row to be clear of').toBeGreaterThanOrEqual(1);
    expect(clearance.paneBottom, `the transcript pane runs under the bar: ${JSON.stringify(clearance)}`)
      .toBeLessThanOrEqual(clearance.barTop + 1);
    expect(clearance.lastBottom, `the newest row's bottom edge is below the bar's top edge: ${JSON.stringify(clearance)}`)
      .not.toBeNull();
    expect(clearance.lastBottom!).toBeLessThanOrEqual(clearance.barTop + 1);
    expect(clearance.lastBottom!).toBeGreaterThanOrEqual(clearance.paneTop);

    // (b) at this width the bar is inside the viewport and its controls are real targets.
    expect(listening.left).toBeGreaterThanOrEqual(0);
    expect(listening.right).toBeLessThanOrEqual(1281);
    for (const id of ['voice-realtime-mute', 'voice-realtime-end']) {
      const control = await page.getByTestId(id).boundingBox();
      expect(control && control.height >= 36, `${id} is a ≥36px target`).toBeTruthy();
    }

    await expect(bar).toBeVisible();
    await leaveLiveVoice(page);
  });

  test('1280px: a socket the server closed reads disconnected, offers no way back, and re-dials nothing', async () => {
    // A healthy connection first, so the drop below is a connection that really opened and then
    // ended, not one that never started.
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
    await enterLiveVoice(page, 1280, upstream);
    const framesOnHealthy = upstream.audioFrameCount();
    await speak(page, SPEECH_SECONDS);
    await expect.poll(() => upstream.audioFrameCount(), { timeout: 20_000 }).toBe(framesOnHealthy + 1);
    await leaveLiveVoice(page);

    // The endpoint goes unreachable: the app server's dial fails, its connect budget is
    // spent, and it closes the browser's socket — the server-side close the criterion names.
    upstream.setRefusing(true);
    await page.getByTestId('live-voice-button').click();
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });

    // The bar has to SAY so. Before this criterion the phase fell back to `idle` and the
    // bar read "Connecting voice…" — the copy the requirement singles out as wrong.
    await expect(page.getByTestId('voice-realtime-status')).toContainText(/disconnected/i, { timeout: 25_000 });
    await expect(page.getByTestId('voice-realtime-status')).not.toContainText(/connecting/i);
    await expect.poll(() => phase(page), { timeout: 10_000 }).toBe('idle');
    // The bar replaced the composer and STAYS: a disconnected session is still a mode the
    // user is in — they leave it with Exit — not a silent fall back to the text box.
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
    // AND IT OFFERS NO WAY BACK. The strip deleted the reconnect control, so this is read as an
    // absence by SCAN rather than by name: anything inside the bar whose testid or label promises a
    // reconnection fails here whatever it is called, which a query for the old testid could not do.
    const wayBack = await page.evaluate(() => {
      const promises = /retry|reconnect|resume|dial-again|reopen/i;
      const bar = document.querySelector('[data-testid="voice-realtime-bar"]');
      if (!bar) return ['the bar is not on screen'];
      return [...bar.querySelectorAll('[data-testid], button, [role="button"]')]
        .map((el) => `${el.getAttribute('data-testid') ?? ''}|${(el.textContent ?? '').trim()}`)
        .filter((label) => promises.test(label));
    });
    expect(wayBack, 'a disconnected bar must offer no way back').toEqual([]);
    await shot(page, 'composer-embedded-disconnected-1280');

    // NO AUTO-RECONNECT EITHER: the dial count does not move on its own. Waited out rather than
    // sampled, because a retry loop would need a moment to come round.
    const connectionsAtDrop = upstream.connectionCount();
    await page.waitForTimeout(6_000);
    expect(
      upstream.connectionCount(),
      'a dropped connection must not be re-dialled behind the person’s back',
    ).toBe(connectionsAtDrop);
    await expect(page.locator(BAR)).toBeVisible();
    await expect(page.getByTestId('voice-realtime-status')).toContainText(/disconnected/i);

    upstream.setRefusing(false);
    await leaveLiveVoice(page);
  });

  test('375px: both entries and the same bar hold inside the viewport', async () => {
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });

    await enterLiveVoice(page, 375, upstream);
    const bar = page.locator(BAR);
    const listening = await barBox(page);
    expect(listening.left).toBeGreaterThanOrEqual(0);
    expect(listening.right).toBeLessThanOrEqual(376);
    for (const id of ['voice-realtime-mute', 'voice-realtime-end']) {
      const control = await page.getByTestId(id).boundingBox();
      expect(
        control && control.x >= 0 && control.x + control.width <= 376 && control.height >= 36,
        `${id} stays an on-screen ≥36px target at 375px`,
      ).toBeTruthy();
    }
    await shot(page, 'composer-embedded-listening-375');

    upstream.emitInterimCaption(LONG_CAPTION);
    await expect(page.getByTestId('voice-realtime-caption')).toHaveText(LONG_CAPTION, { timeout: 15_000 });
    const clipped = await page.locator(CAPTION).evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(clipped.scrollWidth > clipped.clientWidth, `the caption clips at 375px too: ${JSON.stringify(clipped)}`).toBeTruthy();
    expect(Math.abs((await barBox(page)).height - listening.height)).toBeLessThanOrEqual(2);

    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'muted');
    const muted = await barBox(page);
    await shot(page, 'composer-embedded-muted-375');
    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'listening');

    await speak(page, SPEECH_SECONDS);
    await expect.poll(() => upstream.callCount(), { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
    const executing = await barBox(page);
    await shot(page, 'composer-embedded-executing-375');

    for (const [name, state] of [['muted', muted], ['executing', executing]] as const) {
      expect(Math.abs(state.height - listening.height), `the bar's height moved while ${name} at 375px`).toBeLessThanOrEqual(2);
      expect(Math.abs(state.top - listening.top), `the bar's top edge moved while ${name} at 375px`).toBeLessThanOrEqual(2);
    }

    await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(PROPOSED_TEXT);
    const clearance = await transcriptClearance(page);
    expect(clearance.rowCount).toBeGreaterThanOrEqual(1);
    expect(clearance.paneBottom).toBeLessThanOrEqual(clearance.barTop + 1);
    expect(clearance.lastBottom).not.toBeNull();
    expect(clearance.lastBottom!).toBeLessThanOrEqual(clearance.barTop + 1);

    await leaveLiveVoice(page);
  });

  test('375px: the controls a disconnected bar still offers hold inside the viewport', async () => {
    // This case enters with a bare click rather than through `enterLiveVoice`, so it
    // states its own width instead of inheriting whichever one ran before it.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByTestId('live-voice-button').click();
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
    // The bare-click leg owns its own first frame, as `enterLiveVoice` does for the others.
    await pushFirstCaptureFrame(page, upstream);
    await waitForPhase(page, 'listening');
    await leaveLiveVoice(page);

    upstream.setRefusing(true);
    await page.getByTestId('live-voice-button').click();
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('voice-realtime-status')).toContainText(/disconnected/i, { timeout: 25_000 });

    // REWRITTEN with gap-voice-ui-strip-to-caption-and-connection-state (2026-10-14). This leg used to
    // place the Retry button inside 375px; the button is gone, so what the narrow layout has to hold is
    // the controls that remain — Mute and Exit, the only two the mode offers — the same ≥36px targets
    // the 1280px leg reads.
    for (const id of ['voice-realtime-mute', 'voice-realtime-end']) {
      const control = await page.getByTestId(id).boundingBox();
      expect(
        control && control.x >= 0 && control.x + control.width <= 376,
        `${id} is on screen at 375px`,
      ).toBeTruthy();
      expect(control && control.height >= 36, `${id} is a ≥36px target`).toBeTruthy();
    }
    await shot(page, 'composer-embedded-disconnected-375');

    upstream.setRefusing(false);
    await leaveLiveVoice(page);
  });

  /**
   * (e) The in-bar model selector — read on a session of its own.
   *
   * The bar draws whatever `ChatInterface` hands it, and `ChatInterface` hands it the
   * composer's own `ComposerModelMenu`, which renders NOTHING when the active provider
   * has no model options. The fixture session above runs the `debug` provider — a
   * provider with no model catalog at all — so a second reading there could only ever
   * find nothing. `POST /api/providers/sessions` is the same call the New Session
   * button makes, and an empty `initialMessage` means no provider is ever asked to
   * run: all this case needs is a session whose provider HAS the catalog, which is
   * what the model row `beforeAll` added is for.
   */
  test('a session whose provider has model options shows a working selector inside the bar', async () => {
    const created = await page.evaluate(async (targetPath: string) => {
      const response = await fetch('/api/providers/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}`,
        },
        body: JSON.stringify({ provider: 'claude', projectPath: targetPath, initialMessage: '' }),
      });
      return { status: response.status, body: await response.text() };
    }, workspacePath);
    expect(created.status, `the app did not create a session: ${created.body}`).toBe(201);
    const claudeSessionId = (JSON.parse(created.body) as { data?: { sessionId?: string } }).data?.sessionId ?? '';
    expect(claudeSessionId, `the app created a session without an id: ${created.body}`).not.toBe('');

    await page.goto(`/session/${claudeSessionId}`);
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });

    await enterLiveVoice(page, 1280, upstream);

    // The selector is INSIDE the bar — not a second copy beside it — and it is the
    // composer's own menu: opening it lists the model the user's library holds.
    const selector = page.locator(BAR).locator('button[aria-haspopup="menu"]');
    await expect(selector).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(BAR).locator('button[aria-haspopup="menu"]')).toHaveCount(1);
    await selector.click();
    // This menu keeps its model list one click away (the composer's own convention:
    // the section opens collapsed), so the row that opens it is what the menu shows
    // first. Expanding it is what lists the catalog.
    const modelSection = page.getByRole('menu').getByRole('menuitem');
    await expect(modelSection).toHaveCount(1);
    await modelSection.click();
    await expect(page.getByRole('menuitemradio', { name: CUSTOM_MODEL_LABEL })).toBeVisible({ timeout: 10_000 });
    await shot(page, 'composer-embedded-model-selector-1280');
    await selector.click();
    await expect(page.getByRole('menuitemradio', { name: CUSTOM_MODEL_LABEL })).toHaveCount(0);

    await leaveLiveVoice(page);
  });

  /**
   * The leave control and the running turn's Stop are two different controls, and leaving does not
   * stop the run (AC1/AC4 at the browser level).
   *
   * The unit criterion reads the bar's markup and the pane's rows in jsdom. This case reads the same
   * two facts off a REAL browser against the real server, with the fake upstream driving a real
   * `session_send`: while that call is executing, the running turn's OWN Stop and the bar's Exit are
   * both on screen, they do NOT draw the same glyph (and Exit says what it is in words), and a click
   * on Exit takes the mode away while the turn keeps running to completion — the row the session was
   * writing lands AFTER the leave, which is the proof the leave did not abort it.
   *
   * WHY THIS CASE ARMS ITS OWN SCENARIO. The Stop is drawn only when the client knows the session is
   * processing, and the client learns that from its own running-sessions poll — whose period is five
   * seconds. The scenario the cases above share writes one row at `at: 0` and finishes in
   * milliseconds, so a run it opens is over long before the poll looks; a criterion that read that
   * run would be reading a window no client could ever see. This case therefore arms a walk that
   * SLEEPS to a far offset before writing its closing row, so the run is genuinely running for the
   * whole window the two controls are read in. The other cases keep the instant scenario (and their
   * own session), and the fake upstream is re-bound to this case's session because the executor
   * refuses a `session_send` that names any session but the bound one.
   */
  test("the leave control and the running turn's stop are told apart, and leaving lets the run finish", async () => {
    const heldScenario = {
      ...SCENARIO,
      steps: [
        { at: 0, op: 'wait' },
        // The walk sleeps to this offset (the engine's clock is absolute), so the run is RUNNING for
        // the whole window below. The row is written only after the sleep, which is what makes "it is
        // absent before the leave and present after" a reading rather than a coincidence.
        { at: 20_000, op: 'row', role: 'assistant', text: FINAL_TURN_TEXT },
      ],
      expect: { rows: { delta: 1 }, content: { mustContain: [SEED_USER_TEXT, FINAL_TURN_TEXT] } },
    };
    const heldSessionId = await armScenario(api, workspacePath, heldScenario);
    upstream.setBoundSessionId(heldSessionId);

    await page.goto(`/session/${heldSessionId}`);
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });

    await enterLiveVoice(page, 1280, upstream);

    // A model call in flight: the session is processing, so the turn's own Stop is on the row. The
    // call is counted from BEFORE the burst, because earlier cases have already spent calls.
    const callsBefore = upstream.callCount();
    await speak(page, SPEECH_SECONDS);
    await expect.poll(() => upstream.callCount(), { timeout: 25_000 }).toBeGreaterThanOrEqual(callsBefore + 1);

    // The Stop appears once the client's own poll has observed the run the voice send opened, so the
    // wait spans the poll period plus the send's coalescing window — not the run's own length, which
    // the held scenario keeps open well past this reading.
    const stop = page.getByTestId('running-turn-stop');
    await expect(stop).toBeVisible({ timeout: 30_000 });
    const leave = page.getByTestId('voice-realtime-end');
    await expect(leave).toBeVisible();

    // (a) two controls, told apart: the running row's Stop draws the square, and the leave control is
    // a pure icon square carrying a leaving glyph — never the Stop's own square, and no visible text.
    const stopIcon = (await stop.locator('svg').getAttribute('class')) ?? '';
    const leaveIcon = (await leave.locator('svg').getAttribute('class')) ?? '';
    expect(stopIcon, `the running row's Stop draws the stop glyph: "${stopIcon}"`).toContain('square');
    expect(leaveIcon, `the leave control draws a leaving glyph: "${leaveIcon}"`).toContain('log-out');
    expect(leaveIcon, "the leave control must not draw the Stop's own glyph").not.toContain('square');
    await expect(page.getByTestId('voice-realtime-exit-label')).toHaveCount(0);
    await shot(page, 'composer-embedded-stop-vs-exit-1280');

    // (b) leaving is not stopping. The closing row is not on screen yet — the run is still inside its
    // sleep — and only the leave moves the mode off; the row then lands on its own clock, after it.
    expect(await paneText(page), 'the held run wrote its closing row before the leave').not.toContain(FINAL_TURN_TEXT);
    await leave.click();
    await expect(page.locator(BAR)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => paneText(page), { timeout: 30_000 }).toContain(FINAL_TURN_TEXT);
  });

  /**
   * A pending question stays ANSWERABLE while Live Voice is active — and the bar does not move.
   *
   * Entering Live Voice replaces the whole composer subtree, and the only strip that can answer a
   * permission/question request lived inside `ChatComposer`. So the moment voice mode came on, the
   * prompt was a read-only record in the transcript and nothing on screen could be clicked; the
   * reported run recorded the question as Skipped. Both halves of the fix are read here in a real
   * browser: the panel really appears and a real click really takes the decision (AC2/AC3 at the
   * browser level), and the bar's own box is the same before, during and after it (AC4/AC1 — the
   * geometry criterion AC-316 owns must not go red because a row appeared above the bar).
   *
   * It is the LAST case on purpose: it installs the transport double on this page, which the cases
   * above must not see. Everything else — the bar, the panel, the decision path — is the shipping
   * code.
   */
  test('a pending question answered above the bar leaves the bar geometry alone', async () => {
    // Back to the voice fixture session, booted with the wrapper in place, so the app's chat
    // socket is one this case can inject into.
    await page.addInitScript(installWireDouble);
    await page.goto(`/session/${sessionId}`);
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
    await waitForChatSocket(page);

    await enterLiveVoice(page, 1280, upstream);
    const before = await barBox(page);
    await expect(page.getByText(PANEL_HEADER)).toHaveCount(0);

    // The prompt the debug fixture cannot produce is delivered over the app's own socket. It is
    // re-sent on a bounded retry because the session-subscription ack REPLACES the pending set
    // with `[]` — a prompt that lands before that ack is wiped by it. Re-delivery is safe: the
    // client dedupes on `requestId`, so a second copy is not a second prompt.
    const requestId = 'e2e-voice-banner-1';
    await expect(async () => {
      const delivered = await injectAskUserQuestion(page, sessionId, requestId);
      expect(delivered, 'the prompt frame reached no open chat socket').toBeGreaterThan(0);
      await expect(page.getByText(PANEL_HEADER)).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    // It is drawn ABOVE the bar — the bar's top edge is at or below the panel's bottom edge.
    const withBanner = await barBox(page);
    const panelBox = await page.getByText(PANEL_HEADER).first().boundingBox();
    expect(
      panelBox && panelBox.y < withBanner.top && panelBox.y + panelBox.height <= withBanner.top + 1,
      `the pending question must sit above the bar, not over it or under it: ${JSON.stringify({ panel: panelBox, bar: withBanner })}`,
    ).toBeTruthy();

    // AC4: the bar's own height AND top edge are unchanged by the banner's arrival.
    expect(
      Math.abs(withBanner.height - before.height),
      `the bar grew by ${Math.abs(withBanner.height - before.height)}px when the question appeared`,
    ).toBeLessThanOrEqual(BANNER_GEOMETRY_TOLERANCE_PX);
    expect(
      Math.abs(withBanner.top - before.top),
      `the bar moved by ${Math.abs(withBanner.top - before.top)}px when the question appeared`,
    ).toBeLessThanOrEqual(BANNER_GEOMETRY_TOLERANCE_PX);
    await shot(page, 'composer-embedded-pending-question-1280');

    // A real click takes the decision: pick the option, then submit.
    await page.getByRole('button', { name: new RegExp(ASK_OPTION_LABEL) }).click();
    await page.getByRole('button', { name: /Submit/ }).click();
    await expect(page.getByText(PANEL_HEADER)).toHaveCount(0, { timeout: 15_000 });

    // AC4, other side: the bar is back to exactly the box it had before the question existed.
    const after = await barBox(page);
    expect(
      Math.abs(after.height - before.height),
      `the bar's height is not what it was before the question: ${JSON.stringify({ before, after })}`,
    ).toBeLessThanOrEqual(BANNER_GEOMETRY_TOLERANCE_PX);
    expect(
      Math.abs(after.top - before.top),
      `the bar's top edge is not what it was before the question: ${JSON.stringify({ before, after })}`,
    ).toBeLessThanOrEqual(BANNER_GEOMETRY_TOLERANCE_PX);

    // AC3/AC1 at the browser level: answering neither left voice mode nor brought the text
    // composer back — the bar is still the composer, and the connection is still listening.
    await expect(page.locator(BAR)).toBeVisible();
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
    await waitForPhase(page, 'listening');

    await leaveLiveVoice(page);
  });
});
