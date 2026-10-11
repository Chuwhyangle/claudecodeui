/**
 * The Live Voice entry, in a brand-new conversation, allocates the session it
 * needs — on a real browser against a real server (AC4).
 *
 * WHAT THIS FILE IS FOR. A conversation that has no session row yet has no id,
 * and the server keys both an ordinary `chat.send` and the voice connection's
 * `session_send` whitelist on that id. Before this task the entry answered such
 * a tap with a notice ("send a message first") and nothing else, so Live Voice
 * was dead in the one conversation a reader most wants it in — the one they are
 * about to start. The entry now asks the SAME session gateway the composer's
 * first send uses (`POST /api/providers/sessions`) for the id, and enters voice
 * mode on the id it returned. This file reads that as a protocol fact:
 *
 *   · from the fixture project, the app's own "New Session" entry point is
 *     pressed, so the pane really stands on a conversation with no session id;
 *   · one tap on `live-voice-button` produces exactly one
 *     `POST /api/providers/sessions`, whose 2xx body carries a session id this
 *     spec reads off the wire and then finds in the URL the app navigated to;
 *   · the voice bar (`[data-testid="voice-realtime-bar"]`) replaces the text
 *     composer, and NO `voice.realtime.needsSession` notice is left behind.
 *
 * WHAT IS REAL AND WHAT IS NOT. The account, the project, the session gateway
 * and the transcript are the shipping code and the run's real server. The
 * microphone is a stand-in, because no CI machine has one: an init script
 * replaces `AudioContext`, `AudioWorkletNode` and `getUserMedia` with an inert
 * graph (the same fixture the two sibling `voice-realtime-*` specs carry). The
 * Realtime upstream is deliberately NOT stood up — this criterion's criteria is
 * the ALLOCATION, and its readings only ever assert "the bar appeared + the
 * allocation happened + no notice", which holds on whatever phase the bar lands
 * in (the bar stays mounted in every reachable phase, disconnected included: see
 * `e2e/voice-realtime-composer-embedded.spec.ts`). The spec therefore declares no
 * fixture home and binds no upstream port, and `playwright.config.ts` is
 * untouched.
 *
 * WHY IT SIGNS IN AS THE SIBLINGS' ACCOUNT. The voice-realtime criteria run
 * against one single-user server, where the first `register` takes the only
 * seat. Sharing `USERNAME` is what keeps this file runnable beside the others
 * in any order — whoever starts first registers, the rest sign in.
 */

import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

const PANE = '.chat-messages-pane';
/** The composer's textarea testid — present exactly while `ChatComposer` is mounted. */
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';
const BAR = '[data-testid="voice-realtime-bar"]';
/** Both notice producers (the composer's tap reply and this pane's failed-allocation reply) share this id. */
const NOTICE = '[data-testid="live-voice-notice"]';
/** The account the two sibling voice-realtime specs use — see the file header for why it is shared. */
const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';

/** The seeded project this spec starts from. A plain-claude fixture, indexed at boot like a developer's own. */
const WORKSPACE_NAME = 'mobile-send-key-workspace';

/** Creates (or signs in) the fixture account and returns its bearer token. Same helper as the sibling voice specs. */
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

/** The seeded project's own row, named by its basename the way the sidebar draws it. */
const projectRow = (page: Page, workspaceName: string) =>
  page
    .getByRole('heading', { name: workspaceName })
    .or(page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }))
    .first();

const composer = (page: Page) => page.locator(COMPOSER_TEXTAREA);

/**
 * Stands the pane on a brand-new conversation: a project selected, the composer
 * drawn, and NO session id in the address bar.
 *
 * The click sequence is the one `e2e/resident-enable-consent.spec.ts` uses and
 * for the same reason — the project row is a toggle, and the app auto-selecting
 * a project on a one-project run is not something a reading may assume.
 */
async function openComposer(page: Page, workspaceName: string): Promise<void> {
  const textarea = composer(page);
  const row = projectRow(page, workspaceName);
  const newSession = page.getByRole('button', { name: 'New Session' }).first();

  await expect(row).toBeVisible({ timeout: 20_000 }).catch(() => undefined);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await textarea.isVisible().catch(() => false)) return;
    if (!(await page.getByRole('button', { name: 'Close sidebar' }).isVisible().catch(() => false))) {
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible().catch(() => false)) {
        await menu.click().catch(() => undefined);
        await newSession.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined);
      }
    }
    if (!(await newSession.isVisible().catch(() => false))) {
      await row.click().catch(() => undefined);
      await newSession.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined);
    }
    if (await newSession.isVisible().catch(() => false)) {
      await newSession.click().catch(() => undefined);
      await textarea.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined);
    }
  }
  await expect(textarea).toBeVisible({ timeout: 15_000 });
}

/** {@link openComposer}, then the app's own "New Session" entry point if the pane opened on an existing session. */
async function openNewConversation(page: Page, workspaceName: string): Promise<void> {
  await openComposer(page, workspaceName);
  if (/^\/session\//.test(new URL(page.url()).pathname)) {
    await page.getByRole('button', { name: 'New Session' }).first().click();
    await expect.poll(() => new URL(page.url()).pathname).not.toMatch(/^\/session\//);
  }
  await expect(composer(page)).toBeVisible({ timeout: 15_000 });
  expect(
    new URL(page.url()).pathname,
    'a brand-new conversation has no session id yet — this is the state the entry has to allocate from',
  ).not.toMatch(/^\/session\//);
}

test.describe.configure({ mode: 'serial' });
// One case, bounded under the config's 55s single-file watchdog so a case that
// outruns it fails naming itself rather than being killed from outside. Same
// shape and value as `e2e/resident-enable-consent.spec.ts`.
test.describe.configure({ timeout: 45_000 });

test.describe('live voice new-session entry allocates a session', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspacePath = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const dataDir = process.env.QUAY_E2E_DATA_DIR;
    if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
    workspacePath = path.join(dataDir, WORKSPACE_NAME);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();

    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    await context.addInitScript(
      ({ authToken }: { authToken: string }) => {
        window.localStorage.setItem('auth-token', authToken);
        window.localStorage.setItem('userLanguage', 'en');

        // The fake audio graph: an inert stand-in for the microphone so entering
        // Live Voice does not fail on `getUserMedia`. Same fixture as
        // `e2e/voice-realtime-composer-embedded.spec.ts`; nothing here speaks
        // into it, because this criterion reads the ALLOCATION, not the audio.
        class FakeWorkletNode {
          port = { onmessage: null as ((m: unknown) => void) | null, postMessage: () => undefined };

          connect() {
            /* the graph is inert */
          }
        }

        class FakeAudioContext {
          sampleRate = 16_000;
          destination = {};
          audioWorklet = { addModule: async () => undefined };
          createGain() {
            return { gain: { value: 0 }, connect: () => undefined };
          }

          createMediaStreamSource() {
            return { connect: () => undefined };
          }

          close() {
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

    await page.goto('/');
    if (!(await projectRow(page, WORKSPACE_NAME).waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
      await page.reload();
    }
    await projectRow(page, WORKSPACE_NAME).waitFor({ state: 'visible', timeout: 25_000 });
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('1280px: a brand-new conversation enters Live Voice by allocating a session first, with no needsSession notice', async () => {
    await openNewConversation(page, WORKSPACE_NAME);

    const entry = page.getByTestId('live-voice-button');
    await expect(entry).toBeVisible({ timeout: 15_000 });
    // Premise: the bar is not already up and nothing has been allocated.
    await expect(page.locator(BAR)).toHaveCount(0);
    console.log(`[ac4] pre-entry pathname=${new URL(page.url()).pathname}`);

    // Arm the wire read BEFORE the tap: the allocation is the very first thing the
    // entry does, so a listener registered after the click could miss it.
    const allocation = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/providers/sessions',
    );

    await entry.click();
    const response = await allocation;

    // ── the allocation really happened, and it is a NEW session ─────────────────────────────
    expect(
      response.status(),
      `entering Live Voice in a brand-new conversation must allocate a session; the gateway answered ${response.status()}`,
    ).toBeLessThan(300);
    const body = (await response.json()) as { data?: { sessionId?: string; sessionName?: string } };
    const allocatedId = body.data?.sessionId ?? '';
    expect(allocatedId, `the gateway answered 2xx without a session id: ${JSON.stringify(body)}`).not.toBe('');
    console.log(`[ac4] allocation.status=${response.status()} sessionId=${allocatedId}`);

    const payload = (response.request().postDataJSON() ?? {}) as Record<string, unknown>;
    expect(payload.provider, "the allocation must name the composer's own provider").toBeTruthy();
    expect(payload.projectPath, 'the allocation must name the project the pane stands on').toBe(workspacePath);
    expect(
      'initialMessage' in payload,
      'entering voice mode allocates a session; it does not send a first message',
    ).toBe(false);

    // ── the bar appears, on the id the gateway just returned ────────────────────────────────
    const bar = page.locator(BAR);
    await expect(bar).toBeVisible({ timeout: 30_000 });
    console.log('[ac4] bar.visible=true');

    // The pane navigated to the id it allocated: the address bar is the app's own record of it.
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${allocatedId}`);
    console.log(`[ac4] navigated.pathname=${new URL(page.url()).pathname}`);

    // ── the needsSession copy is NOT on screen ──────────────────────────────────────────────
    const notices = await page.locator(NOTICE).count();
    console.log(`[ac4] notice.count=${notices}`);
    expect(notices, 'the successful entry must leave no needsSession notice behind').toBe(0);
    const bodyText = await page.locator('body').innerText();
    expect(
      bodyText.includes('Send a message first'),
      'the needsSession copy must not appear when the entry succeeded',
    ).toBe(false);

    // End the mode so the case leaves no live socket behind (the page is closed in `afterAll`).
    await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
  });
});
