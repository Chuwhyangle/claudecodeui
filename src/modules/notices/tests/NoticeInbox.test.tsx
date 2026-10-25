import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import NoticeInbox from '@/modules/notices/NoticeInbox';
import type { Notice } from '@/modules/notices/useNotices';

/**
 * The notices inbox (N6): the entries folded out of the interrupt slot plus the ones the user
 * already dismissed. WHAT THIS FILE PROVES: dismissed entries stay findable in their own group,
 * the remaining active entries are listed, and a blocking active entry still has no dismiss
 * button when the inbox offers one for dismissible entries.
 */

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: 'deploy:pending-build',
    source: 'deploy',
    lifecycle: 'condition',
    severity: 'attention',
    revision: 'a'.repeat(40),
    scope: 'global',
    title: 'notices.deploy.pendingBuild.title',
    params: { count: 1 },
    raisedAt: '2026-10-24T12:00:00.000Z',
    ...overrides,
  };
}

function renderInbox(props: Parameters<typeof NoticeInbox>[0]) {
  return render(
    <I18nextProvider i18n={i18n}>
      <NoticeInbox {...props} />
    </I18nextProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
});

describe('the notices inbox', () => {
  it('lists folded active entries', () => {
    renderInbox({
      active: [notice({ id: 'notice:two', params: { count: 2 } })],
      dismissed: [],
    });

    expect(screen.getByTestId('notice-inbox-entry').textContent).toContain(
      'Deployment changes are built but not running',
    );
    expect(screen.queryByTestId('notices-dismissed-group')).toBeNull();
  });

  it('shows dismissed entries in the 「已忽略」 group (N6)', () => {
    renderInbox({
      active: [],
      dismissed: [
        notice({ id: 'deploy:pending-build' }),
        notice({ id: 'deploy:other', title: 'notices.deploy.failed.title', params: {} }),
      ],
    });

    expect(screen.getByTestId('notices-dismissed-title').textContent).toBe('Dismissed');
    const entries = screen.getAllByTestId('notice-dismissed-entry');
    expect(entries).toHaveLength(2);
    expect(entries[1]!.textContent).toBe('The last build or restart failed');
  });

  it('offers dismiss only for dismissible active entries, never for blocking ones (N2)', () => {
    const onDismiss = vi.fn();
    const attention = notice({ id: 'notice:attention' });
    const blocking = notice({
      id: 'deploy:failed',
      severity: 'blocking',
      title: 'notices.deploy.failed.title',
      params: {},
    });

    renderInbox({ active: [attention, blocking], dismissed: [], onDismiss });

    const buttons = screen.getAllByTestId('notice-inbox-dismiss');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onDismiss).toHaveBeenCalledWith(attention);
  });
});
