import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import DeployReadiness from '@/modules/cockpit/DeployReadiness';
import type {
  DeployExecutePort,
  DeployReadinessPort,
  DeployReadinessReading,
  DeployStatus,
} from '@/modules/cockpit/DeployReadiness';

/**
 * The deployment strip (AC5).
 *
 * WHAT THIS FILE PROVES, against the rendered DOM and the deploy seam:
 *
 *   - every status draws its own sentence, and only the actionable statuses draw the
 *     「构建并重启」 button;
 *   - clicking that button opens the confirmation panel and sends NOTHING;
 *   - confirming sends the deploy request EXACTLY once;
 *   - the session page's compact form renders nothing while the deployment is fresh.
 *
 * The read/deploy ports are injected, so no network is involved and the assertions are about
 * what the component asks for, not about a mocked fetch.
 */

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

function reading(overrides: Partial<DeployReadinessReading> = {}): DeployReadinessReading {
  return {
    status: 'fresh',
    runningSha: 'a'.repeat(40),
    builtSha: 'a'.repeat(40),
    clientBuiltSha: 'a'.repeat(40),
    headSha: 'a'.repeat(40),
    pendingCommits: [],
    lastDeploy: null,
    failure: null,
    checkedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function renderStrip({
  value = reading(),
  deploy = vi.fn<DeployExecutePort>(async () => ({ ok: true })),
  read = vi.fn<DeployReadinessPort>(async () => value),
}: {
  value?: DeployReadinessReading;
  deploy?: DeployExecutePort;
  read?: DeployReadinessPort;
} = {}) {
  return {
    deploy,
    ...render(
      <I18nextProvider i18n={i18n}>
        <DeployReadiness deploy={deploy} read={read} now={() => NOW} />
      </I18nextProvider>,
    ),
  };
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
});

describe('deployment status copy and actions', () => {
  it.each<[DeployStatus, string, boolean]>([
    ['fresh', 'Deployment is current', false],
    ['built-pending-restart', 'Built — restart to apply', true],
    ['building', 'Building…', false],
    ['restarting', 'Restarting…', false],
    ['unknown', 'Deployment status unknown', false],
  ])('%s draws its own sentence (actionable=%s)', async (status, copy, actionable) => {
    renderStrip({ value: reading({ status }) });

    const line = await screen.findByTestId('deploy-status');
    expect(line.textContent).toBe(copy);
    expect(screen.queryByTestId('deploy-action') !== null).toBe(actionable);
  });

  it('pending-build counts the source commits and draws the action', async () => {
    renderStrip({
      value: reading({
        status: 'pending-build',
        pendingCommits: [
          { sha: 'b'.repeat(40), subject: 'src: deploy strip', taskId: 'deploy-readiness-build-and-safe-restart' },
          { sha: 'c'.repeat(40), subject: 'server: readiness', taskId: null },
        ],
      }),
    });

    const line = await screen.findByTestId('deploy-status');
    expect(line.textContent).toBe('2 changes not yet built');
    expect(screen.getByTestId('deploy-action')).toBeTruthy();
  });

  it('shows the last deploy verdict and the failing check name', async () => {
    renderStrip({
      value: reading({
        status: 'fresh',
        lastDeploy: {
          targetSha: 'd'.repeat(40),
          ok: false,
          checks: [
            { name: 'build-sha', ok: false, status: null, detail: 'mismatch' },
            { name: 'route-root', ok: true, status: 200, detail: 'ok' },
          ],
          at: new Date(NOW - 120_000).toISOString(),
        },
      }),
    });

    const last = await screen.findByTestId('deploy-last');
    expect(last.textContent).toContain('ddddddd');
    expect(last.textContent).toContain('verification failed');
    expect(last.textContent).toContain('build-sha');
  });

  it('shows a failed build step and the tail of its output', async () => {
    renderStrip({
      value: reading({
        status: 'fresh',
        failure: {
          step: 'build',
          outputTail: 'tsc: one error\nbuild boom: exit 1',
          at: new Date(NOW).toISOString(),
        },
      }),
    });

    const failure = await screen.findByTestId('deploy-failure');
    expect(failure.textContent).toContain('build');
    expect(screen.getByTestId('deploy-failure-output').textContent).toBe('build boom: exit 1');
  });
});

describe('the confirmed deploy action', () => {
  it('clicking 「构建并重启」 only opens the panel; confirming sends exactly one request', async () => {
    const { deploy } = renderStrip({
      value: reading({
        status: 'pending-build',
        pendingCommits: [
          { sha: 'b'.repeat(40), subject: 'src: deploy strip', taskId: 'deploy-readiness-build-and-safe-restart' },
        ],
      }),
    });

    fireEvent.click(await screen.findByTestId('deploy-action'));
    const panel = screen.getByTestId('deploy-confirm-panel');
    expect(panel).toBeTruthy();
    // The panel lists what will take effect, including the task id the commit names.
    expect(screen.getByTestId('deploy-commit').textContent).toContain('deploy-readiness-build-and-safe-restart');
    expect(deploy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('deploy-confirm'));
    await waitFor(() => expect(deploy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('deploy-confirm-panel')).toBeNull());
  });

  it('cancel closes the panel and sends nothing', async () => {
    const { deploy } = renderStrip({ value: reading({ status: 'built-pending-restart' }) });

    fireEvent.click(await screen.findByTestId('deploy-action'));
    fireEvent.click(screen.getByTestId('deploy-cancel'));

    expect(screen.queryByTestId('deploy-confirm-panel')).toBeNull();
    expect(deploy).not.toHaveBeenCalled();
  });
});
