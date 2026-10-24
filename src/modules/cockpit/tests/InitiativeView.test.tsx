import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import InitiativeView from '@/modules/cockpit/InitiativeView';
import type { InitiativeReading } from '@/modules/cockpit/cockpitView';

/**
 * The cockpit's 「倡议」 view.
 *
 * WHAT THIS FILE PROVES (M6 AC1), against the rendered DOM rather than component internals:
 *
 *   - every stubbed `initiative list` row draws ONE row, one cell per member project and its
 *     dependency edges;
 *   - a blocking edge is highlighted and states how long it has been blocking;
 *   - the row's focusable address is the fleet's reserved URI, and the pin action names the
 *     SAME string — there is no display-name shortcut that could pin a different object.
 *
 * The stub is the fleet's `initiative list --json` shape: charter/members/edges exactly as the
 * server relays it. The i18n bundle runs for real, so a missing key would surface as literal
 * text rather than silently passing.
 */

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const TWO_HOURS_AGO = new Date(NOW - 2 * 60 * 60_000).toISOString();

const INITIATIVES: InitiativeReading[] = [
  {
    slug: 'cockpit-observation-wall',
    uri: 'quay://fleet/initiative/cockpit-observation-wall',
    status: 'active',
    charter: {
      intent: 'Ship the cockpit observation wall and the initiative view on top of it.',
      projects: ['claudecodeui', 'quay-fleet'],
      completionCriteria: ['wall ships', 'initiative view ships'],
      exitConditions: ['both projects green'],
      expiresAt: '2026-12-31T00:00:00.000Z',
      grantScope: { mayDecide: ['layout'], mustEscalate: ['scope'] },
    },
    members: [
      {
        project: 'claudecodeui',
        taskRefs: ['observation-wall-ui', 'continuity-accordion'],
        goalRefs: ['GOAL-cockpit'],
        liaison: 'liaison:claudecodeui',
      },
      { project: 'quay-fleet', taskRefs: [], goalRefs: [], liaison: null },
    ],
    edges: [
      {
        from: 'quay://quay-fleet/task/fleet-initiative-store-and-cli',
        to: 'quay://claudecodeui/task/cockpit-initiative-view-and-decision-queue',
        kind: 'blocks',
        blocked: true,
        blockedSince: TWO_HOURS_AGO,
      },
      {
        from: 'quay://claudecodeui/board',
        to: 'quay://quay-fleet/board',
        kind: 'contract',
        blocked: false,
        blockedSince: null,
      },
    ],
  },
  {
    slug: 'second-initiative',
    uri: 'quay://fleet/initiative/second-initiative',
    status: 'active',
    charter: {
      intent: 'A second cross-project unit.',
      projects: ['archguard'],
      completionCriteria: ['done'],
      exitConditions: ['none'],
      expiresAt: '2027-01-31T00:00:00.000Z',
      grantScope: { mayDecide: [], mustEscalate: [] },
    },
    members: [{ project: 'archguard', taskRefs: ['a'], goalRefs: [], liaison: null }],
    edges: [],
  },
];

afterEach(cleanup);

function renderView(overrides: Partial<ComponentProps<typeof InitiativeView>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <InitiativeView
        initiatives={INITIATIVES}
        focusUri={null}
        pinnedUris={new Set()}
        pinPendingUri={null}
        now={NOW}
        onFocus={() => {}}
        onPin={() => {}}
        {...overrides}
      />
    </I18nextProvider>,
  );
}

describe('the initiative view draws the fleet reading', () => {
  it('renders one row per initiative, one cell per member project and the dependency edges', () => {
    renderView();

    const rows = screen.getAllByTestId('initiative-row');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute('data-initiative-slug'))).toEqual([
      'cockpit-observation-wall',
      'second-initiative',
    ]);

    const first = rows[0]!;
    expect(within(first).getByTestId('initiative-intent').textContent).toContain(
      'Ship the cockpit observation wall',
    );
    const cells = within(first).getAllByTestId('initiative-project-cell');
    expect(cells.map((cell) => cell.getAttribute('data-project'))).toEqual([
      'claudecodeui',
      'quay-fleet',
    ]);
    // The empty project still draws its cell; its counts are zero rather than absent.
    expect(cells[1]!.getAttribute('data-tasks')).toBe('0');

    const edges = within(first).getAllByTestId('initiative-edge');
    expect(edges.map((edge) => edge.getAttribute('data-edge-kind'))).toEqual(['blocks', 'contract']);
    expect(within(edges[0]!).getByTestId('initiative-edge-endpoints').textContent).toContain(
      'quay://quay-fleet/task/fleet-initiative-store-and-cli',
    );
  });

  it('highlights a blocked edge and states how long it has been blocking', () => {
    renderView();

    const first = screen.getAllByTestId('initiative-row')[0]!;
    const edges = within(first).getAllByTestId('initiative-edge');
    expect(edges[0]!.getAttribute('data-edge-blocked')).toBe('true');
    expect(edges[1]!.getAttribute('data-edge-blocked')).toBe('false');

    const blockedFor = within(edges[0]!).getByTestId('initiative-edge-blocked-for');
    expect(blockedFor.getAttribute('data-blocked-since')).toBe(TWO_HOURS_AGO);
    // Two hours before the reading clock, in the locale's own duration sentence.
    expect(blockedFor.textContent).toContain('2 h');
    expect(first.getAttribute('data-initiative-blocked')).toBe('true');
    expect(within(edges[1]!).queryByTestId('initiative-edge-blocked-for')).toBeNull();
  });

  it('focuses and pins the fleet URI, never a display name', () => {
    const onFocus = vi.fn();
    const onPin = vi.fn();
    renderView({ onFocus, onPin, focusUri: INITIATIVES[0]!.uri });

    const first = screen.getAllByTestId('initiative-row')[0]!;
    expect(first.getAttribute('data-initiative-uri')).toBe(
      'quay://fleet/initiative/cockpit-observation-wall',
    );
    expect(first.getAttribute('data-initiative-focused')).toBe('true');

    const focusButton = within(first).getByTestId('initiative-focus');
    expect(focusButton.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(focusButton);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith('quay://fleet/initiative/cockpit-observation-wall');

    fireEvent.click(within(first).getByTestId('initiative-pin'));
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledWith('quay://fleet/initiative/cockpit-observation-wall');
  });

  it('draws a pinned initiative as unpinnable, and a pending pin as busy', () => {
    const uri = INITIATIVES[0]!.uri;
    renderView({ pinnedUris: new Set([uri]), pinPendingUri: uri });

    const first = screen.getAllByTestId('initiative-row')[0]!;
    const pin = within(first).getByTestId('initiative-pin');
    expect(pin.getAttribute('data-pinned')).toBe('true');
    expect(pin.textContent).toBe(i18n.t('cockpit.initiativeUnpin'));
    expect((pin as HTMLButtonElement).disabled).toBe(true);
  });
});
