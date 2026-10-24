/**
 * `ArchitectureRefreshDialog` — the confirmation / running / failure faces.
 *
 * The dialog is presentational: the panel owns the start request, so "Refresh
 * sends exactly one request" is measured as "onStart is called once". The two
 * properties that are NOT presentation are load-bearing and measured here:
 *  · Escape closes the dialog only — a document-level `chat.abort` listener must
 *    not fire (the chat page owns that key for aborting a running turn);
 *  · Tab is trapped inside the dialog and wraps at both ends.
 */
import { createRef } from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enCommon from '@/modules/i18n/locales/en/common.json';

import { ArchitectureRefreshDialog } from '@/modules/architecture/ArchitectureRefreshDialog';

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function renderDialog(overrides: Partial<Parameters<typeof ArchitectureRefreshDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onStart = vi.fn();
  const returnFocusRef = createRef<HTMLButtonElement>();
  const trigger = document.createElement('button');
  trigger.textContent = 'trigger';
  document.body.append(trigger);
  trigger.focus();
  (returnFocusRef as { current: HTMLElement | null }).current = trigger;

  const view = render(
    <ArchitectureRefreshDialog
      open
      phase="confirm"
      elapsedMs={0}
      error={null}
      onClose={onClose}
      onStart={onStart}
      returnFocusRef={returnFocusRef}
      {...overrides}
    />,
  );
  return { ...view, onClose, onStart, trigger };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ArchitectureRefreshDialog', () => {
  it('shows the whole-project warning and offers Cancel / Refresh in the confirm phase', async () => {
    const { onClose, onStart } = renderDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('data-architecture-refresh-phase')).toBe('confirm');
    expect(dialog.textContent).toContain('Refresh the project analysis?');
    expect(dialog.textContent).toContain('re-analyse the whole project');
    expect(dialog.textContent).toContain('other tabs or sessions');
    expect(dialog.textContent).toContain('The current analysis stays in place');
    await waitFor(() => expect(document.activeElement).toBe(dialog));

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('sends exactly one start request for one Refresh press', () => {
    const { onStart } = renderDialog();
    const confirm = document.querySelector<HTMLButtonElement>('[data-architecture-refresh-confirm]');
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm as HTMLButtonElement);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without reaching the chat page’s abort listener', () => {
    const { onClose, onStart } = renderDialog();
    const aborts: string[] = [];
    const abortListener = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') aborts.push('chat.abort');
    };
    document.addEventListener('keydown', abortListener);

    try {
      const dialog = screen.getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onStart).not.toHaveBeenCalled();
      expect(aborts, 'Escape inside the dialog must not abort a running chat turn').toEqual([]);
    } finally {
      document.removeEventListener('keydown', abortListener);
    }
  });

  it('traps Tab inside the dialog and wraps at both ends', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const focusables = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('shows the elapsed time and disables Refresh while running', () => {
    const { onStart } = renderDialog({ phase: 'running', elapsedMs: 65_000 });

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('data-architecture-refresh-phase')).toBe('running');
    const elapsed = document.querySelector('[data-architecture-refresh-elapsed]');
    expect(elapsed?.textContent).toContain('1:05');

    const confirm = document.querySelector<HTMLButtonElement>('[data-architecture-refresh-confirm]');
    expect(confirm?.disabled).toBe(true);
    fireEvent.click(confirm as HTMLButtonElement);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('shows the reason and a Retry that starts again when failed', () => {
    const { onStart } = renderDialog({
      phase: 'failed',
      error: 'ArchGuard exited with code 1: boom',
    });

    const reason = document.querySelector('[data-architecture-refresh-error]');
    expect(reason?.textContent).toContain('ArchGuard exited with code 1: boom');
    const retry = screen.getByText('Retry');
    fireEvent.click(retry);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the trigger when it unmounts', async () => {
    const { trigger, unmount } = renderDialog();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('dialog')));
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('renders nothing while closed', () => {
    render(
      <ArchitectureRefreshDialog
        open={false}
        phase="confirm"
        elapsedMs={0}
        error={null}
        onClose={() => {}}
        onStart={() => {}}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
