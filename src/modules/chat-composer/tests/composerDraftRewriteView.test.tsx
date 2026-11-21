import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import DraftRewriteCandidate from '@/modules/chat-composer/composer/DraftRewriteCandidate';
import type { UseDraftRewriteResult } from '@/modules/chat-composer/hooks/useDraftRewrite';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { DraftRewriteFailure } from '@/shared/replySuggestionsType';

/**
 * The draft-rewrite surface as the composer draws it.
 *
 * WHAT THIS PINS. The chip exists only on a non-blank, enabled draft; it sits inside the
 * composer body (below the textarea, above the footer); the expanded panel draws ONLY the
 * candidate body and two icon buttons — no heading and no “not applied yet” status; pressing
 * a non-button area folds it, while a non-empty selection, a scroll, and the icon presses do
 * not; loading and error panels still fold; every icon has an accessible name.
 *
 * WHAT THIS CANNOT PIN. jsdom does no layout: the 320/375/1280 checks below read the DOM
 * structure the CSS lays out (the chip is a child of the composer body, the footer is still a
 * sibling after it, the candidate area is the height-capped scroller), not measured geometry.
 * The real-browser scenario run is what proves the pixels.
 */

const failure: DraftRewriteFailure = {
  at: '2026-01-01T00:00:00.000Z',
  code: 'REPLY_SUGGESTIONS_UPSTREAM_FAILED',
  category: 'http',
  httpStatus: 502,
  requestId: 'req-1',
  model: 'settings-model',
  message: 'safe message',
};

function surface(overrides: Partial<UseDraftRewriteResult> = {}): UseDraftRewriteResult {
  return {
    available: true,
    expanded: false,
    loading: false,
    candidate: null,
    failure: null,
    openOrRequest: vi.fn(),
    collapse: vi.fn(),
    retry: vi.fn(),
    apply: vi.fn(),
    invalidate: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

/** Renders the surface in the same body/footer structure ChatComposer uses. */
function renderInComposer(draftRewrite: UseDraftRewriteResult) {
  return render(
    <form data-slot="prompt-input">
      <div data-slot="prompt-input-body">
        <textarea data-slot="prompt-input-textarea" defaultValue="明天十点见" />
        <DraftRewriteCandidate draftRewrite={draftRewrite} />
      </div>
      <div data-slot="prompt-input-footer">
        <button type="button">Send</button>
      </div>
    </form>,
  );
}

beforeEach(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { chat: enChat } },
      interpolation: { escapeValue: false },
    });
  }
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

describe('draft rewrite view', () => {
  it('draws the chip only for a non-blank available draft', () => {
    const first = render(<DraftRewriteCandidate draftRewrite={surface()} />);
    assert.ok(screen.getByText('✦ Polish'));
    first.unmount();

    render(<DraftRewriteCandidate draftRewrite={surface({ available: false })} />);
    assert.equal(screen.queryByText('✦ Polish'), null);
    assert.equal(document.querySelector('[data-slot="draft-rewrite"]'), null);
  });

  it('the chip is inside the composer body, below the textarea and above the footer', () => {
    renderInComposer(surface());
    const body = document.querySelector('[data-slot="prompt-input-body"]');
    const textarea = document.querySelector('[data-slot="prompt-input-textarea"]');
    const chip = document.querySelector('[data-slot="draft-rewrite-chip"]');
    const footer = document.querySelector('[data-slot="prompt-input-footer"]');
    assert.ok(body && textarea && chip && footer);
    assert.ok(body.contains(chip), 'the chip lives in the same composer body');
    assert.ok(
      textarea.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the chip follows the textarea',
    );
    assert.ok(
      chip.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the footer follows the chip',
    );
  });

  it('the chip press opens/requests exactly once', () => {
    const openOrRequest = vi.fn();
    render(<DraftRewriteCandidate draftRewrite={surface({ openOrRequest })} />);
    fireEvent.click(screen.getByText('✦ Polish'));
    assert.equal(openOrRequest.mock.calls.length, 1);
  });

  it('the panel draws only the candidate body and two icon buttons — no title or status copy', () => {
    render(<DraftRewriteCandidate draftRewrite={surface({ expanded: true, candidate: '润色后的正文' })} />);
    const panel = document.querySelector('[data-slot="draft-rewrite-panel"]');
    assert.ok(panel);
    assert.ok(panel.textContent?.includes('润色后的正文'));
    assert.equal(panel.querySelectorAll('h1,h2,h3,h4,h5,h6').length, 0);
    assert.ok(!(panel.textContent ?? '').includes('润色建议'));
    assert.ok(!(panel.textContent ?? '').includes('尚未替换'));
    assert.ok(!(panel.textContent ?? '').toLowerCase().includes('not applied'));
    assert.ok(!(panel.textContent ?? '').toLowerCase().includes('suggestion'));
    // Exactly two controls inside the panel: apply and retry.
    assert.equal(panel.querySelectorAll('button').length, 2);
    assert.equal(panel.querySelectorAll('button[aria-label]').length, 2);
    for (const button of Array.from(panel.querySelectorAll('button'))) {
      assert.ok((button.getAttribute('title') ?? '') !== '', 'every icon carries a tooltip');
      assert.ok((button.getAttribute('aria-label') ?? '') !== '', 'every icon carries an accessible name');
    }
  });

  it('a non-button press folds the panel back to the chip', () => {
    const collapse = vi.fn();
    render(<DraftRewriteCandidate draftRewrite={surface({ expanded: true, candidate: 'candidate', collapse })} />);
    fireEvent.click(document.querySelector('[data-slot="draft-rewrite-panel"]') as Element);
    assert.equal(collapse.mock.calls.length, 1);
  });

  it('a non-empty text selection does not fold the panel', () => {
    const collapse = vi.fn();
    render(<DraftRewriteCandidate draftRewrite={surface({ expanded: true, candidate: 'selectable candidate', collapse })} />);
    const candidate = document.querySelector('[data-slot="draft-rewrite-candidate"]') as Element;
    const range = document.createRange();
    range.selectNodeContents(candidate);
    const selection = window.getSelection();
    assert.ok(selection);
    selection.removeAllRanges();
    selection.addRange(range);
    assert.ok(selection.toString().trim() !== '');
    fireEvent.click(document.querySelector('[data-slot="draft-rewrite-panel"]') as Element);
    assert.equal(collapse.mock.calls.length, 0);
  });

  it('scrolling the candidate area does not fold the panel', () => {
    const collapse = vi.fn();
    render(<DraftRewriteCandidate draftRewrite={surface({ expanded: true, candidate: 'long candidate', collapse })} />);
    fireEvent.scroll(document.querySelector('[data-slot="draft-rewrite-candidate"]') as Element);
    assert.equal(collapse.mock.calls.length, 0);
  });

  it('the icon presses do not bubble into a collapse', () => {
    const collapse = vi.fn();
    const apply = vi.fn();
    const retry = vi.fn();
    render(
      <DraftRewriteCandidate
        draftRewrite={surface({ expanded: true, candidate: 'candidate', collapse, apply, retry })}
      />,
    );
    fireEvent.click(document.querySelector('[data-slot="draft-rewrite-apply"]') as Element);
    fireEvent.click(document.querySelector('[data-slot="draft-rewrite-retry"]') as Element);
    assert.equal(apply.mock.calls.length, 1);
    assert.equal(retry.mock.calls.length, 1);
    assert.equal(collapse.mock.calls.length, 0);
  });

  it('the apply icon is disabled while loading or without a candidate', () => {
    const loading = render(
      <DraftRewriteCandidate draftRewrite={surface({ expanded: true, loading: true })} />,
    );
    assert.equal((document.querySelector('[data-slot="draft-rewrite-apply"]') as HTMLButtonElement).disabled, true);
    assert.equal((document.querySelector('[data-slot="draft-rewrite-retry"]') as HTMLButtonElement).disabled, true);
    loading.unmount();

    render(<DraftRewriteCandidate draftRewrite={surface({ expanded: true, candidate: 'x' })} />);
    assert.equal((document.querySelector('[data-slot="draft-rewrite-apply"]') as HTMLButtonElement).disabled, false);
  });

  it('the loading panel folds and shows only the progress line', () => {
    const collapse = vi.fn();
    render(<DraftRewriteCandidate draftRewrite={surface({ expanded: true, loading: true, collapse })} />);
    assert.ok(document.querySelector('[data-slot="draft-rewrite-loading"]'));
    fireEvent.click(document.querySelector('[data-slot="draft-rewrite-panel"]') as Element);
    assert.equal(collapse.mock.calls.length, 1);
  });

  it('the error panel folds and shows one safe sentence', () => {
    const collapse = vi.fn();
    render(<DraftRewriteCandidate draftRewrite={surface({ expanded: true, failure, collapse })} />);
    const error = document.querySelector('[data-slot="draft-rewrite-error"]');
    assert.ok(error);
    assert.ok(!(error.textContent ?? '').includes('settings-model'));
    assert.ok(!(error.textContent ?? '').includes('req-1'));
    fireEvent.click(document.querySelector('[data-slot="draft-rewrite-panel"]') as Element);
    assert.equal(collapse.mock.calls.length, 1);
  });

  it('the candidate area is the bounded scroller on every viewport tier', () => {
    for (const width of [320, 375, 1280]) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      const view = renderInComposer(surface({ expanded: true, candidate: 'a long candidate' }));
      const candidate = document.querySelector('[data-slot="draft-rewrite-candidate"]');
      const panel = document.querySelector('[data-slot="draft-rewrite-panel"]');
      assert.ok(candidate && panel, `width ${width}`);
      assert.ok((candidate.className as string).includes('overflow-y-auto'), `width ${width}: internal scroll`);
      assert.ok((panel.className as string).includes('max-h-'), `width ${width}: capped height`);
      assert.ok(document.querySelector('[data-slot="prompt-input-footer"]'), `width ${width}: footer still drawn`);
      view.unmount();
    }
  });
});
