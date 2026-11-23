import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterAll, beforeAll, test, vi } from 'vitest';

import type { Project, SessionWithProvider } from '@/shared/types';

/**
 * Dragging a session row: the drop must hand the parent the whole list in the
 * new order, and nothing else (no navigation, no reorder for a drag that ends
 * where it started).
 *
 * The row component is mocked down to its identity attribute — the real one
 * pulls in i18n, feature flags and the cockpit, none of which take part in the
 * reorder.
 */

vi.mock('@/modules/sidebar/SidebarSessionItem', () => ({
  default: ({ session }: { session: SessionWithProvider }) => (
    <div data-session-id={session.id}>{session.id}</div>
  ),
}));
vi.mock('@/modules/sidebar/SessionFilterBar', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => false }));

const { default: SidebarProjectSessions } = await import('@/modules/sidebar/SidebarProjectSessions');

type SessionsProps = React.ComponentProps<typeof SidebarProjectSessions>;

const PROJECT = {
  projectId: 'project-1',
  name: 'project-1',
  displayName: 'project-1',
  fullPath: '/tmp/project-1',
} as unknown as Project;

const sessions = ['a', 'b', 'c', 'd'].map((id) => ({
  id,
  summary: id,
  lastActivity: '2026-08-21T10:00:00.000Z',
})) as SessionWithProvider[];

const noop = () => {};
const t = ((key: string) => key) as unknown as SessionsProps['t'];

const props = (onReorderSessions?: (projectId: string, sessionIds: string[]) => void): SessionsProps => ({
  project: PROJECT,
  isExpanded: true,
  sessions,
  selectedSession: null,
  initialSessionsLoaded: true,
  hasMoreSessions: false,
  isLoadingMoreSessions: false,
  activeSessions: new Set<string>(),
  attentionSessionIds: new Set<string>(),
  currentTime: new Date('2026-08-21T10:00:00.000Z'),
  sessionRenameId: null,
  sessionRenameDraft: '',
  onRenameDraftChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  onProjectSelect: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  onReorderSessions,
  onLoadMoreSessions: noop,
  onNewSession: noop,
  t,
});

/**
 * jsdom reports a zero-size rect, so the row's midpoint is stated here: every
 * row is 20px tall starting at 0, which makes `clientY` above 10 mean "below
 * the midpoint" inside the handler.
 */
let originalRect: typeof Element.prototype.getBoundingClientRect;
beforeAll(() => {
  originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    if (this.hasAttribute('data-session-id')) {
      return { top: 0, bottom: 20, height: 20, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    return originalRect.call(this);
  };
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
});

const row = (id: string): HTMLElement => {
  const element = document.querySelector(`[data-session-id="${id}"]`);
  assert.ok(element instanceof HTMLElement, `row ${id} must render`);
  return element;
};

/**
 * Dispatches a real DragEvent-shaped event carrying `clientY` and
 * `dataTransfer`. `fireEvent.dragOver(el, { clientY })` is not enough: the
 * synthetic init does not survive into `event.clientY` here, and the handler's
 * above/below decision reads exactly that.
 */
const dragEvent = (type: string, element: HTMLElement, dataTransfer: object, clientY: number): void => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  fireEvent(element, event);
};

const dragRow = (from: string, onto: string, clientY: number): void => {
  const dataTransfer = { effectAllowed: '', dropEffect: '', setData: noop, getData: () => from };
  dragEvent('dragstart', row(from), dataTransfer, 0);
  dragEvent('dragover', row(onto), dataTransfer, clientY);
  dragEvent('drop', row(onto), dataTransfer, clientY);
};

test('dropping a row below another hands the parent the whole new order', () => {
  const reorders: string[][] = [];
  render(<SidebarProjectSessions {...props((_projectId, sessionIds) => reorders.push(sessionIds))} />);

  dragRow('a', 'c', 15);

  assert.deepEqual(reorders, [['b', 'c', 'a', 'd']]);
});

test('dropping a row above another inserts it before that row', () => {
  const reorders: string[][] = [];
  render(<SidebarProjectSessions {...props((_projectId, sessionIds) => reorders.push(sessionIds))} />);

  dragRow('d', 'b', 2);

  assert.deepEqual(reorders, [['a', 'd', 'b', 'c']]);
});

test('a drag that ends where it started stores nothing', () => {
  const reorders: string[][] = [];
  render(<SidebarProjectSessions {...props((_projectId, sessionIds) => reorders.push(sessionIds))} />);

  const dataTransfer = { effectAllowed: '', dropEffect: '', setData: noop, getData: () => 'b' };
  dragEvent('dragstart', row('b'), dataTransfer, 0);
  dragEvent('dragover', row('b'), dataTransfer, 15);
  dragEvent('drop', row('b'), dataTransfer, 15);

  assert.deepEqual(reorders, []);
});

test('a list with no reorder callback does not move rows', () => {
  render(<SidebarProjectSessions {...props(undefined)} />);

  dragRow('a', 'c', 15);

  assert.equal(screen.getAllByText(/^[abcd]$/).length, 4);
});
