import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import { createElement } from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

// Type-only module aliases, so the mock's `importOriginal` can name the module's type without an
// `import()` annotation (which this repo's lint forbids) and without a runtime import (the factory
// is hoisted above every statement in this file). Erased before that hoisting runs.
import type * as SessionHostsModule from '@/shared/hooks/useSessionHosts';
import type { SessionHostsSnapshot } from '@/shared/types';
import enChat from '@/modules/i18n/locales/en/chat.json';

/**
 * The resident controls are reachable from the pill in the header, held in jsdom.
 *
 * They used to be the activity dock's expanded panel, behind an arrow, and this file held that the
 * dock rendered them. That put the facts in the message flow on a phone: opening the panel grew the
 * transcript's content column instead of floating over it, and measured at 390x844 its lower ~140px
 * landed past the bottom of the scroll area with only an edge showing. The pill replaced the arrow;
 * it lives in the header, outside the transcript, and the panel is a portal to `body` anchored under
 * it — so the thing to hold here is no longer "the dock renders it" but **the pill opens a panel that
 * carries the controls, closing it takes them away, and the panel is not inside anything that scrolls**.
 *
 * jsdom lays nothing out, so where the panel lands and whether it moves the transcript stay the
 * browser criteria's job (`e2e/resident-ui-layout.spec.ts -g "resident pill"`); what this file holds is that the panel is
 * *there*, that the pill is what renders it, that it dismisses the ways a popover must, and that
 * nothing else on the page renders a second copy.
 */

const SESSION_ID = 'session-narrow';

/** Shared with the mock below, which is hoisted above every other statement in this file. */
const harness = vi.hoisted(() => ({
  snapshot: null as unknown as SessionHostsSnapshot,
  error: null as string | null,
}));

type HostOptions = { lifecycleMode?: 'resident' | 'per-run'; hostState?: string; closeReason?: string | null; withHost?: boolean };

/** A snapshot for one session, in whichever state the case needs it. */
const makeSnapshot = ({ lifecycleMode = 'resident', hostState = 'idle', closeReason = null, withHost = true }: HostOptions = {}) =>
  ({
    hosts: withHost
      ? [
          {
            hostId: 'host-narrow',
            provider: 'claude',
            mode: 'resident',
            state: hostState,
            pid: 4242,
            startedAt: Date.now() - 60_000,
            closeReason,
            closeDetail: '',
            bindings: [
              {
                appSessionId: SESSION_ID,
                providerSessionId: 'provider-session-narrow',
                state: hostState,
                leases: [],
                lastActivityAt: Date.now(),
                peerName: 'resident@host',
              },
            ],
          },
        ]
      : [],
    sessions: [
      {
        appSessionId: SESSION_ID,
        provider: 'claude',
        lifecycleMode,
        running: false,
        reason: null,
      },
    ],
  }) as unknown as SessionHostsSnapshot;

// The store is a module-scope poller with no test seam, so the snapshot is supplied through the
// hook and the original module's readings (`findSessionHostState`, `readResidentProcessState`, …)
// are kept: this file is exercising the pill's own DOM shape, not a reimplementation of them.
//
// The lifecycle verbs are the production ones: the substitute's `close`/`forceClose` call the real
// `api.sessionHosts.close`, so a press runs the real request path (`fetch` is the only thing the
// payload cases fake) rather than a stub's copy of it.
vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionHostsModule>();
  const { api } = await import('@/shared/api');
  return {
    ...actual,
    useSessionHosts: () => ({
      refresh: async () => {},
      start: async () => {},
      close: async (appSessionId: string) => {
        await api.sessionHosts.close(appSessionId);
      },
      forceClose: async (appSessionId: string) => {
        await api.sessionHosts.close(appSessionId, { force: true });
      },
      snapshot: harness.snapshot,
      error: harness.error,
      loading: false,
    }),
  };
});

const ResidentSessionBadge = (await import('@/modules/chat/transcript/ResidentSessionBadge')).default;

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const BADGE = '[data-resident-badge]';
const PANEL = '[data-resident-badge-panel]';

function renderBadge(sessionId: string | null = SESSION_ID): ReturnType<typeof render> {
  return render(createElement(ResidentSessionBadge, { sessionId }));
}

beforeEach(() => {
  harness.snapshot = makeSnapshot();
  harness.error = null;
});

afterEach(() => {
  cleanup();
});

describe('the pill is how the resident controls are reached', () => {
  it('opens the panel from the pill and takes it away again on the second press', () => {
    const view = renderBadge();
    const badge = view.container.querySelector<HTMLElement>(BADGE);
    assert.ok(badge, `a resident session must draw the pill (${BADGE})`);
    assert.equal(document.querySelector(PANEL), null, 'the panel starts closed: the pill is one word, not a wall of facts');
    assert.equal(badge.getAttribute('aria-expanded'), 'false');

    act(() => {
      fireEvent.click(badge);
    });

    const panel = document.querySelector(PANEL);
    assert.ok(panel, 'the pill must open the panel');
    assert.equal(badge.getAttribute('aria-expanded'), 'true');
    assert.equal(badge.getAttribute('aria-controls'), panel.id, 'the pill must say which element it controls');
    for (const marker of ['[data-resident-address]', '[data-resident-pid-text]', '[data-resident-copy]', '[data-resident-close]']) {
      assert.ok(panel.querySelector(marker), `the open panel must carry ${marker}; it reads ${panel.textContent ?? ''}`);
    }

    act(() => {
      fireEvent.click(badge);
    });
    assert.equal(document.querySelector(PANEL), null, 'a second press must close the panel again');
  });

  it('draws the panel outside the pill\'s own container, so nothing that scrolls or clips can clip it', () => {
    // The reason the panel is a portal. In the dock it was a descendant of the transcript's scroll
    // column; here the pill sits in a header block with `overflow-x-auto`, which clips anything drawn
    // inside it, and the test holds that the panel is not inside the render container at all.
    const view = renderBadge();
    act(() => {
      fireEvent.click(view.container.querySelector(BADGE) as HTMLElement);
    });

    const panel = document.querySelector(PANEL);
    assert.ok(panel, 'premise: the panel must be open');
    assert.equal(view.container.contains(panel), false, 'the panel must be portalled out of the pill\'s container');
    assert.equal(panel.parentElement, document.body, 'and it must be a child of body, outside every overflow and contain');
    assert.equal(document.querySelectorAll(PANEL).length, 1, 'and there must be exactly one of it');
  });

  it('closes on Escape and gives focus back to the pill', () => {
    const view = renderBadge();
    const badge = view.container.querySelector<HTMLElement>(BADGE) as HTMLElement;
    act(() => {
      fireEvent.click(badge);
    });
    assert.ok(document.querySelector(PANEL), 'premise: the panel must be open');

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    assert.equal(document.querySelector(PANEL), null, 'Escape must close the panel');
    assert.equal(document.activeElement, badge, 'and focus must return to the pill that opened it');
  });

  it('closes on a press outside, and stays open on a press inside the panel', () => {
    const view = renderBadge();
    act(() => {
      fireEvent.click(view.container.querySelector(BADGE) as HTMLElement);
    });
    const panel = document.querySelector(PANEL) as HTMLElement;
    assert.ok(panel, 'premise: the panel must be open');

    act(() => {
      fireEvent.pointerDown(panel.querySelector('[data-resident-address]') as HTMLElement);
    });
    assert.ok(document.querySelector(PANEL), 'a press inside the panel must not close it');

    act(() => {
      fireEvent.pointerDown(document.body);
    });
    assert.equal(document.querySelector(PANEL), null, 'a press anywhere else must close it');
  });
});

describe('the pill speaks only for sessions that are resident, and only about the process', () => {
  it('draws nothing for a session that is not resident', () => {
    // The positive control on the stored lifecycle mode: with it per-run there is no process to
    // describe, so the pill is absent — which is what makes the presence above a reading of the mode
    // rather than of the component always rendering something.
    harness.snapshot = makeSnapshot({ lifecycleMode: 'per-run' });
    const view = renderBadge();
    assert.equal(view.container.querySelector(BADGE), null, 'a per-run session has no process: no pill');
  });

  it('draws nothing when there is no session to describe', () => {
    const view = renderBadge(null);
    assert.equal(view.container.querySelector(BADGE), null, 'a new session has no id yet: no pill');
  });

  it('reads the process, not the work: idle and busy are the same word', () => {
    // The sidebar draws five states and the pill draws four, because whether the process is working
    // right now is the activity dock's one answer. A pill that said "busy" as well would be the
    // second answer the status bar was removed for.
    const idle = renderBadge();
    const idleState = idle.container.querySelector(BADGE)?.getAttribute('data-resident-badge');
    cleanup();

    harness.snapshot = makeSnapshot({ hostState: 'busy' });
    const busy = renderBadge();
    const busyState = busy.container.querySelector(BADGE)?.getAttribute('data-resident-badge');

    assert.equal(idleState, 'running');
    assert.equal(busyState, 'running', 'a busy host must read the same as an idle one');
  });

  it('tells the four process states apart, each by its own state and its own words', () => {
    const cases: Array<{ name: string; options: HostOptions; error: string | null; state: string; words: RegExp }> = [
      { name: 'a live process', options: { hostState: 'idle' }, error: null, state: 'running', words: /process running/ },
      { name: 'no process yet', options: { withHost: false }, error: null, state: 'stopped', words: /process not running/ },
      { name: 'a process that exited', options: { hostState: 'closed', closeReason: 'exited' }, error: null, state: 'exited', words: /process exited/ },
      { name: 'a failed read', options: { hostState: 'idle' }, error: 'boom', state: 'unknown', words: /state unknown/ },
    ];

    const seen = new Set<string>();
    for (const entry of cases) {
      harness.snapshot = makeSnapshot(entry.options);
      harness.error = entry.error;
      const view = renderBadge();
      const badge = view.container.querySelector(BADGE);
      assert.ok(badge, `${entry.name}: the pill must be drawn`);
      assert.equal(badge.getAttribute('data-resident-badge'), entry.state, `${entry.name}: wrong state`);
      assert.match(badge.getAttribute('aria-label') ?? '', entry.words, `${entry.name}: the accessible name must say it in words`);
      seen.add(entry.state);
      cleanup();
    }

    assert.equal(seen.size, 4, 'the four states must be four different readings, not one repeated');
  });
});

/**
 * The two close operations, read at the wire.
 *
 * The controls are pressed in a real render, and the verbs the panel presses are the production
 * ones: the substitute hook (substituted here for the same reason every other case in this file
 * substitutes it — the store is a module-scope poller with no test seam) forwards `close` and
 * `forceClose` to the real `api.sessionHosts.close`, so a press runs
 * `ResidentPanel → api.sessionHosts.close → fetch` and the assertion is on the request the browser
 * would actually send. `fetch` is the only thing faked, so the body is the real serialisation.
 *
 * What is held: the plain control sends **no** `force` field, the force control sends a literal
 * `force: true`, neither adds a confirmation dialog, and a server refusal on the plain path is
 * shown rather than swallowed.
 */
describe('the two close operations, and what each one sends', () => {
  const closeCalls: Array<{ url: string; body: string | null }> = [];
  let closeStatus = 200;
  let closeError: unknown = null;
  const realFetch = globalThis.fetch;
  const confirmSpy = vi.fn(() => true);

  /** One `{ success, error, data }` envelope response, shaped as `readApiJson` reads it. */
  function fakeJson(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    } as unknown as Response;
  }

  beforeEach(() => {
    closeCalls.length = 0;
    closeStatus = 200;
    closeError = null;
    // A confirmation step would arrive as a modal `window.confirm` (or a second dialog drawn over
    // the panel), so spying on the modal verbs makes "no confirmation" a reading rather than an
    // absence of evidence.
    vi.stubGlobal('confirm', confirmSpy);
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/close')) {
        closeCalls.push({ url, body: typeof init?.body === 'string' ? init.body : null });
        return closeStatus >= 400 ? fakeJson(closeStatus, closeError) : fakeJson(200, { success: true, data: {} });
      }
      return fakeJson(200, { success: true, data: {} });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  /**
   * Renders the pill and opens its panel; returns the panel element.
   *
   * The render goes first and only the press is wrapped: rendering inside `act` defers the commit
   * in this environment, which leaves the container empty at the moment the press is fired.
   */
  async function openPanel(): Promise<HTMLElement> {
    const view = renderBadge();
    await act(async () => {
      fireEvent.click(view.container.querySelector(BADGE) as HTMLElement);
    });
    const panel = document.querySelector(PANEL) as HTMLElement | null;
    assert.ok(panel, 'premise: the panel is open');
    return panel;
  }

  /**
   * The dialogs on the page that are not the pill's own panel.
   *
   * The panel itself is `role="dialog"`, so a bare `[role="dialog"]` query would always match it;
   * the negative assertion is on *new* dialog nodes, which is what a confirmation step would add.
   */
  function confirmationDialogs(): HTMLElement[] {
    return [
      ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [data-resident-confirm]'),
    ].filter((node) => !node.hasAttribute('data-resident-badge-panel'));
  }

  it('sends no force on the plain close and a literal force:true on the force close, with no dialog', async () => {
    const panel = await openPanel();

    const closeButton = panel.querySelector<HTMLElement>('[data-resident-close]');
    const forceButton = panel.querySelector<HTMLElement>('[data-resident-force-close]');
    assert.ok(closeButton, 'the panel carries a plain close control');
    assert.ok(forceButton, 'and a separate force-close control, its own element');
    assert.notEqual(closeButton, forceButton, 'the two operations are two controls, not one with a flag');

    await act(async () => {
      fireEvent.click(closeButton);
    });
    assert.equal(closeCalls.length, 1, 'the plain close asked the server once');
    assert.equal(closeCalls[0].body, null, 'with no request body at all — so no `force` field on it');
    assert.equal(confirmationDialogs().length, 0, 'the plain close draws no confirmation dialog');
    assert.equal(confirmSpy.mock.calls.length, 0, 'and asks no modal confirmation');

    await act(async () => {
      fireEvent.click(forceButton);
    });
    assert.equal(closeCalls.length, 2, 'the force close asked the server once');
    assert.deepEqual(
      JSON.parse(closeCalls[1].body ?? 'null'),
      { force: true },
      'and its body is a literal force:true — the only shape the server authorises',
    );
    assert.equal(confirmationDialogs().length, 0, 'the force close draws no confirmation dialog either');
    assert.equal(confirmSpy.mock.calls.length, 0, 'and asks no modal confirmation');
  });

  it('shows the server refusal on the plain close, so the user learns why it did not close', async () => {
    const refusal =
      'This resident session holds cron×1; closing it would end that background work — pass force: true to close anyway.';
    closeStatus = 409;
    closeError = { success: false, error: { code: 'SESSION_HAS_ACTIVE_LEASES', message: refusal } };

    const panel = await openPanel();
    await act(async () => {
      fireEvent.click(panel.querySelector('[data-resident-close]') as HTMLElement);
    });

    const errorNode = document.querySelector('[data-resident-action-error]');
    assert.ok(errorNode, 'the refusal is rendered, not swallowed into a silent no-op');
    assert.equal(errorNode.textContent, refusal, "and its sentence is the server's own, verbatim");
  });
});
