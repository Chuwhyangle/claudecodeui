import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, it } from 'vitest';

import * as CostContentModule from '@/modules/chat-support/modals/CostContent';
import type { CostCommandData, CostViewSession } from '@/shared/types';

const { CostContent } = CostContentModule;

/**
 * The `/cost` panel renders the server's cost view and derives nothing.
 *
 * The server hands over `data.cost` — session totals, the cache hit ratio, the
 * fresh remainder, the latest request and the provider's accounting statement.
 * The assertions below read the same `data-cost-*` declarations a scenario
 * surface reads, so "the row is drawn" is a structural fact rather than a string
 * match on translated prose.
 *
 * "Not reported" is never "zero": a cache write the server omitted draws no row
 * and no bar segment, which is why the absent-field leg is its own case.
 */

/** A `/cost` payload exactly as the server sends it. */
const costPayload = (
  session: CostViewSession,
  cost: Partial<NonNullable<CostCommandData['cost']>> = {},
): CostCommandData => ({
  cost: {
    session,
    accountingNote: 'Input already includes cached input tokens (cached_input_tokens).',
    ...cost,
  },
  provider: 'codex',
  model: 'gpt-5.6-sol',
});

const fullSession: CostViewSession = {
  total: 140,
  input: 100,
  output: 40,
  cacheRead: 30,
  cacheWrite: 20,
  cacheHitRatio: 0.3,
  fresh: 50,
};

describe('CostContent', () => {
  it('renders a cache-write row with the subset hint when the server reported one', () => {
    render(<CostContent data={costPayload(fullSession)} />);

    assert.ok(screen.getByText('Cached write tokens'), 'the cache-write row must render');
    // Both cache rows carry the subset hint: they are detail reads, not addends.
    assert.equal(screen.getAllByText('subset of input — not added again').length, 2);
  });

  it('renders no cache-write row or segment when the server omitted the quantity', () => {
    render(
      <CostContent
        data={costPayload({
          total: 140,
          input: 100,
          output: 40,
          cacheRead: 30,
          cacheHitRatio: 0.3,
          fresh: 70,
        })}
      />,
    );

    assert.equal(screen.queryByText('Cached write tokens'), null);
    assert.equal(screen.getAllByText('subset of input — not added again').length, 1);
    const bar = screen.getByTestId('cost-cache-usage-bar');
    assert.equal(bar.querySelectorAll('[data-cost-segment]').length, 2);
    assert.equal(bar.querySelector('[data-cost-segment="cacheWrite"]'), null);
  });

  it('renders the hit rate and the three-segment bar from the server-derived view', () => {
    render(<CostContent data={costPayload(fullSession)} />);

    const ratioRow = screen
      .getAllByTestId('cost-usage-row')
      .find((row) => row.getAttribute('data-cost-role') === 'cache-hit-ratio');
    assert.ok(ratioRow, 'the cache hit rate is its own row');
    assert.equal(ratioRow.getAttribute('data-cost-value'), '30%');

    const bar = screen.getByTestId('cost-cache-usage-bar');
    const segments = [...bar.querySelectorAll<HTMLElement>('[data-cost-segment]')];
    assert.deepEqual(
      segments.map((segment) => segment.getAttribute('data-cost-segment')),
      ['fresh', 'cacheRead', 'cacheWrite'],
    );
    assert.deepEqual(
      segments.map((segment) => Number(segment.getAttribute('data-cost-percent'))),
      [50, 30, 20],
    );
  });

  it('renders the server-reported session total instead of re-deriving it', () => {
    // The total deliberately differs from input + output, so a panel-side sum
    // would show 140 and red this assertion.
    render(<CostContent data={costPayload({ ...fullSession, total: 999 })} />);

    const totalRow = screen
      .getAllByTestId('cost-usage-row')
      .find((row) => row.getAttribute('data-cost-label') === 'Total tokens used');
    assert.ok(totalRow, 'the session-total row must render');
    assert.equal(totalRow.getAttribute('data-cost-value'), '999');
  });

  it('takes the accounting statement from data.cost.accountingNote', () => {
    render(
      <CostContent
        data={costPayload(fullSession, {
          accountingNote: 'Server-owned statement for this provider.',
        })}
      />,
    );

    const note = screen.getByTestId('cost-cache-accounting-note');
    assert.equal(note.textContent?.includes('Server-owned statement for this provider.'), true);
  });

  it('renders a "This turn" group from data.cost.turn and derives nothing', () => {
    // The server measured the turn; the panel draws each reported value as its
    // own row with the same `data-cost-*` surface a scenario step reads.
    render(
      <CostContent
        data={costPayload(fullSession, {
          turn: {
            totalTokens: 1_234,
            inputTokens: 1_000,
            outputTokens: 234,
            cacheReadTokens: 800,
            cacheHitRatio: 0.8,
            fresh: 200,
            elapsedMs: 65_000,
            apiMs: 40_000,
            tps: 58.5,
            costUsd: 0.0042,
            calls: 3,
          },
        })}
      />,
    );

    assert.ok(screen.getByText('This turn'));
    const rows = screen.getAllByTestId('cost-usage-row');
    const valueOf = (label: string) =>
      rows.find((row) => row.getAttribute('data-cost-label') === label)?.getAttribute('data-cost-value');

    assert.equal(valueOf('This turn — tokens'), '1,234');
    assert.equal(valueOf('This turn — output'), '234');
    assert.equal(valueOf('This turn — cache hit'), '80.0%');
    assert.equal(valueOf('This turn — duration'), '1m05s');
    assert.equal(valueOf('This turn — speed'), '59 t/s');
    assert.equal(valueOf('This turn — cost'), '$0.0042');
  });

  it('draws no turn rows and no cost row when the server omitted the turn', () => {
    render(<CostContent data={costPayload(fullSession)} />);

    assert.equal(screen.queryByText('This turn'), null);
    assert.equal(screen.queryByText('This turn — cost'), null);
  });

  it('renders the context block from data.cost.context', () => {
    render(
      <CostContent
        data={{
          cost: { context: { used: 1_200, window: 4_000 }, accountingNote: 'note' },
          provider: 'claude',
          model: 'claude-sonnet-4-5',
        }}
      />,
    );

    assert.ok(screen.getByText('Context used'));
    assert.ok(screen.getByText('Window capacity'));
    assert.equal(screen.queryByText('Session cumulative'), null);
  });

  it('exports no derivation helpers and names no provider descriptor or retired wire field', () => {
    // The panel renders; it does not derive. A re-exported derivation helper
    // would let a caller keep computing the ratio client-side.
    const exports = CostContentModule as unknown as Record<string, unknown>;
    assert.equal(exports.buildCacheUsageBreakdown, undefined);
    assert.equal(exports.formatCacheHitRatio, undefined);

    const source = readFileSync(
      path.join(process.cwd(), 'src/modules/chat-support/modals/CostContent.tsx'),
      'utf8',
    );
    assert.equal(source.includes('resolveProviderDescriptor'), false);
    assert.equal(source.includes('FALLBACK_CACHE_ACCOUNTING_NOTE'), false);
    assert.equal(/data\.token(?:Usage|Breakdown)/.test(source), false);
  });
});
