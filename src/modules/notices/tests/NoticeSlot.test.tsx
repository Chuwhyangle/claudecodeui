import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DeployExecutePort, DeployReadinessPort, DeployReadinessReading } from '@/modules/cockpit';
import { i18n } from '@/modules/i18n';
import NoticeSlot from '@/modules/notices/NoticeSlot';
import type {
  Notice,
  NoticeDismissPort,
  NoticeList,
  NoticeListPort,
} from '@/modules/notices/useNotices';

/**
 * The chat page's interrupt slot (N2, N4, N6, N7).
 *
 * WHAT THIS FILE PROVES, against the rendered DOM and the injected ports:
 *
 *   - at most ONE full entry renders, and the rest are folded behind 「另有 N 条」;
 *   - `blocking` outranks `attention`, and same-severity entries take the newest `raisedAt`;
 *   - a `blocking` entry renders no dismiss button (N2);
 *   - dismissing an entry sends its CURRENT revision, and a 409 re-reads instead of erroring;
 *   - the primary action only opens the shared confirmation panel: nothing calls the deploy
 *     port until the panel's own confirm button is pressed (N7);
 *   - the inbox keeps folded entries and dismissed entries reachable (N6).
 */

const NOW = '2026-10-24T12:00:00.000Z';

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: 'deploy:pending-build',
    source: 'deploy',
    lifecycle: 'condition',
    severity: 'attention',
    revision: 'a'.repeat(40),
    scope: 'global',
    title: 'notices.deploy.pendingBuild.title',
    params: { count: 2, headSha: 'a'.repeat(40) },
    raisedAt: NOW,
    ...overrides,
  };
}

function readiness(overrides: Partial<DeployReadinessReading> = {}): DeployReadinessReading {
  return {
    status: 'pending-build',
    runningSha: 'a'.repeat(40),
    builtSha: 'a'.repeat(40),
    clientBuiltSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    pendingCommits: [{ sha: 'b'.repeat(40), subject: 'src: confirm', taskId: 'task-x' }],
    lastDeploy: null,
    failure: null,
    checkedAt: NOW,
    ...overrides,
  };
}

function okResponse(): Response {
  return { ok: true, status: 200 } as unknown as Response;
}

function conflictResponse(): Response {
  return { ok: false, status: 409 } as unknown as Response;
}

type RenderSlotOptions = {
  active?: Notice[];
  dismissed?: Notice[];
  list?: NoticeListPort;
  dismiss?: NoticeDismissPort;
  readDeploy?: DeployReadinessPort;
  deploy?: DeployExecutePort;
};

function renderSlot({
  active = [],
  dismissed = [],
  list,
  dismiss,
  readDeploy,
  deploy,
}: RenderSlotOptions = {}) {
  const listPort = list ?? vi.fn<NoticeListPort>(async (): Promise<NoticeList> => ({ active, dismissed }));
  const dismissPort = dismiss ?? vi.fn<NoticeDismissPort>(async () => okResponse());
  const readDeployPort =
    readDeploy ?? vi.fn<DeployReadinessPort>(async () => readiness());
  const deployPort = deploy ?? vi.fn<DeployExecutePort>(async () => ({ ok: true }));

  render(
    <I18nextProvider i18n={i18n}>
      <NoticeSlot
        list={listPort}
        dismiss={dismissPort}
        readDeploy={readDeployPort}
        deploy={deployPort}
      />
    </I18nextProvider>,
  );

  return { listPort, dismissPort, readDeployPort, deployPort };
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
});

describe('the interrupt slot keeps one full entry (N4)', () => {
  it('renders exactly one entry and folds the remaining count', async () => {
    const blocking = notice({
      id: 'deploy:failed',
      severity: 'blocking',
      title: 'notices.deploy.failed.title',
      params: {},
      raisedAt: '2026-10-24T09:00:00.000Z',
    });
    const older = notice({
      id: 'other:older',
      raisedAt: '2026-10-24T10:00:00.000Z',
      params: { count: 1 },
    });
    const newer = notice({
      id: 'deploy:pending-build',
      raisedAt: '2026-10-24T12:00:00.000Z',
      params: { count: 2 },
    });

    renderSlot({ active: [older, newer, blocking] });

    const entries = await screen.findAllByTestId('notice-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.getAttribute('data-notice-id')).toBe('deploy:failed');
    expect(screen.getByTestId('notice-more').textContent).toBe('2 more');
  });

  it('puts the newest attention entry first when no blocking entry exists', async () => {
    const older = notice({ id: 'notice:older', raisedAt: '2026-10-24T10:00:00.000Z' });
    const newer = notice({ id: 'notice:newer', raisedAt: '2026-10-24T12:00:00.000Z' });

    renderSlot({ active: [older, newer] });

    const entry = await screen.findByTestId('notice-entry');
    expect(entry.getAttribute('data-notice-id')).toBe('notice:newer');
    expect(screen.getByTestId('notice-more').textContent).toBe('1 more');
  });

  it('filters out info-only entries and non-global scopes', async () => {
    renderSlot({
      active: [
        notice({ id: 'notice:info', severity: 'info' }),
        // The server only ships `global` in P1; the filter is still the documented rule.
        notice({ id: 'notice:scoped', scope: 'project' as never }),
      ],
    });

    await waitFor(() => expect(screen.queryByTestId('notice-slot')).toBeNull());
  });
});

describe('dismissing a notice (N2)', () => {
  it('sends the revision the entry was read at', async () => {
    const target = notice({ revision: 'revision-current' });
    const { dismissPort } = renderSlot({ active: [target] });

    fireEvent.click(await screen.findByTestId('notice-dismiss'));

    await waitFor(() =>
      expect(dismissPort).toHaveBeenCalledWith(target.id, 'revision-current'),
    );
  });

  it('renders no dismiss button for a blocking entry', async () => {
    renderSlot({
      active: [
        notice({ id: 'deploy:failed', severity: 'blocking', title: 'notices.deploy.failed.title', params: {} }),
      ],
    });

    await screen.findByTestId('notice-entry');
    expect(screen.queryByTestId('notice-dismiss')).toBeNull();
  });

  it('re-reads on a 409 instead of reporting an error', async () => {
    const target = notice();
    const list = vi.fn<NoticeListPort>(async () => ({ active: [target], dismissed: [] }));
    const dismiss = vi.fn<NoticeDismissPort>(async () => conflictResponse());

    renderSlot({ list, dismiss });

    fireEvent.click(await screen.findByTestId('notice-dismiss'));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    // Nothing was thrown and the entry is still the last reading: no error surface replaced it.
    expect(screen.getByTestId('notice-entry')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the primary action opens the shared confirmation panel (N7)', () => {
  it('opens the panel without calling the deploy port', async () => {
    const withAction = notice({
      primaryAction: { id: 'deploy.build-and-restart', labelKey: 'notices.deploy.pendingBuild.action' },
    });
    const { deployPort, readDeployPort } = renderSlot({ active: [withAction] });

    fireEvent.click(await screen.findByTestId('notice-primary-action'));

    const panel = await screen.findByTestId('deploy-confirm-panel');
    expect(panel).toBeTruthy();
    // The panel lists the same commits the cockpit strip would show.
    expect(screen.getByTestId('deploy-commit').textContent).toContain('src: confirm');
    expect(deployPort).not.toHaveBeenCalled();
    expect(readDeployPort).toHaveBeenCalledTimes(1);
    // The label is translated from the locale bundle, not rendered server prose.
    expect(screen.getByTestId('notice-primary-action').textContent).toBe('Build and restart');
  });
});

describe('the inbox keeps folded and dismissed entries reachable (N6)', () => {
  it('expands the folded entries and the dismissed group', async () => {
    const head = notice({ id: 'notice:head', raisedAt: '2026-10-24T12:00:00.000Z' });
    const folded = notice({ id: 'notice:folded', params: { count: 3 } });
    const dismissed = notice({ id: 'notice:dismissed', params: { count: 4 } });

    renderSlot({ active: [head, folded], dismissed: [dismissed] });

    fireEvent.click(await screen.findByTestId('notice-more'));

    await screen.findByTestId('notices-inbox');
    expect(screen.getByTestId('notice-inbox-entry').textContent).toContain(
      'Deployment changes are built but not running',
    );
    expect(screen.getByTestId('notices-dismissed-group')).toBeTruthy();
    expect(screen.getByTestId('notice-dismissed-entry')).toBeTruthy();
  });

  it('keeps the inbox reachable when every notice is dismissed', async () => {
    const dismissed = notice({ id: 'notice:dismissed' });

    renderSlot({ active: [], dismissed: [dismissed] });

    expect(await screen.findByTestId('notice-inbox-toggle')).toBeTruthy();
    expect(screen.queryByTestId('notice-entry')).toBeNull();

    fireEvent.click(screen.getByTestId('notice-inbox-toggle'));
    const dismissedEntry = await screen.findByTestId('notice-dismissed-entry');
    expect(dismissedEntry).toBeTruthy();
  });
});
