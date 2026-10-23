import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QuayFocusableObject } from '@/shared/types';
import { parseCockpitIntent } from '@/modules/cockpit/cockpitIntent';
import type { CockpitProject } from '@/modules/cockpit/cockpitView';

/**
 * The cockpit's deterministic fast path: project requests, spoken references and the three
 * whole-view commands, plus the honest `unmatched` arm.
 *
 * The visible set and project list are hand-built to be exactly what the fleet/board views
 * declare: `{uri, label, display}` triples in spatial order, and project names the tiles draw.
 */

const visible: QuayFocusableObject[] = [
  {
    uri: 'quay://p1/board',
    label: '①',
    display: { status: 'running', color: 'green', ordinal: 1, pos: { row: 1, column: 1 } },
  },
  {
    uri: 'quay://p2/board',
    label: '②',
    display: { status: 'stale', color: 'amber', ordinal: 2, pos: { row: 2, column: 1 } },
  },
  {
    uri: 'quay://p3/board',
    label: '③',
    display: { status: 'idle', color: 'blue', ordinal: 3, pos: { row: 3, column: 1 } },
  },
];

const projects: CockpitProject[] = [
  {
    projectId: 'p1',
    name: 'claudecodeui',
    projectPath: '/work/claudecodeui',
    driverState: 'running',
    tasks: { total: 3, todo: 1, ready: 1, needsHuman: 1, done: 0 },
    cached: false,
    error: null,
  },
  {
    projectId: 'p2',
    name: 'quay-fleet',
    projectPath: '/work/quay-fleet',
    driverState: 'stale',
    tasks: { total: 5, todo: 2, ready: 2, needsHuman: 1, done: 0 },
    cached: false,
    error: null,
  },
];

/** The one visible set where exactly one object is red — 「红的那个」 must name it. */
const redVisible: QuayFocusableObject[] = [
  {
    uri: 'quay://p1/task/green-task',
    label: '①',
    display: { status: 'landed', color: 'green', ordinal: 1, pos: { row: 1, column: 1 } },
  },
  {
    uri: 'quay://p1/task/red-task',
    label: '②',
    display: { status: 'failed', color: 'red', ordinal: 2, pos: { row: 2, column: 1 } },
  },
];

const context = { visible, projects };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project view requests', () => {
  it('maps 「看 <project>」 to that project’s board', () => {
    expect(parseCockpitIntent('看 claudecodeui', context)).toEqual({
      kind: 'view',
      view: { type: 'board', project: 'p1' },
    });
  });

  it('maps 「打开 <project> 任务板」 to that project’s board', () => {
    expect(parseCockpitIntent('打开 quay-fleet 任务板', context)).toEqual({
      kind: 'view',
      view: { type: 'board', project: 'p2' },
    });
  });

  it('accepts the board noun without a verb', () => {
    expect(parseCockpitIntent('quay-fleet 任务板', context)).toEqual({
      kind: 'view',
      view: { type: 'board', project: 'p2' },
    });
  });

  it('prefers the longest project name so a prefix never wins', () => {
    const extended: CockpitProject[] = [
      { ...projects[0], projectId: 'short', name: 'quay' },
      { ...projects[1], projectId: 'long', name: 'quay-fleet' },
    ];
    expect(parseCockpitIntent('打开 quay-fleet 任务板', { visible, projects: extended })).toEqual({
      kind: 'view',
      view: { type: 'board', project: 'long' },
    });
  });
});

describe('spoken references resolve over the declared visible set', () => {
  it('「第二个」 names the second declared object', () => {
    expect(parseCockpitIntent('第二个', context)).toEqual({
      kind: 'focus',
      uri: 'quay://p2/board',
    });
  });

  it('「②」 names the object carrying that label', () => {
    expect(parseCockpitIntent('②', context)).toEqual({
      kind: 'focus',
      uri: 'quay://p2/board',
    });
  });

  it('「红的那个」 resolves by the declared colour bucket', () => {
    expect(parseCockpitIntent('红的那个', { visible: redVisible, projects })).toEqual({
      kind: 'focus',
      uri: 'quay://p1/task/red-task',
    });
  });
});

describe('whole-view commands', () => {
  it('「放大」 maps to zoom-in', () => {
    expect(parseCockpitIntent('放大', context)).toEqual({ kind: 'zoom-in' });
  });

  it('「返回」 maps to back', () => {
    expect(parseCockpitIntent('返回', context)).toEqual({ kind: 'back' });
  });

  it('「全部项目」 maps to the fleet view', () => {
    expect(parseCockpitIntent('全部项目', context)).toEqual({
      kind: 'view',
      view: { type: 'fleet' },
    });
  });
});

describe('unmatched is stated, never guessed', () => {
  it('a name that is not a project is unmatched', () => {
    expect(parseCockpitIntent('看 nothing-here', context)).toEqual({
      kind: 'unmatched',
      text: '看 nothing-here',
    });
  });

  it('ordinary conversation is unmatched', () => {
    expect(parseCockpitIntent('今天天气不错', context)).toEqual({
      kind: 'unmatched',
      text: '今天天气不错',
    });
  });

  it('an empty phrase is unmatched', () => {
    expect(parseCockpitIntent('   ', context)).toEqual({ kind: 'unmatched', text: '' });
  });
});

describe('the parser is local: no network, no model', () => {
  it('never calls fetch while resolving every phrase above', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const phrase of ['看 claudecodeui', '第二个', '②', '放大', '返回', '全部项目', '闲聊']) {
      parseCockpitIntent(phrase, context);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('imports no HTTP client and no model client', () => {
    // Whole-file read rather than a line grep: the invariant is about the module's imports,
    // and a wrapped import statement must not read as "absent".
    const source = readFileSync(
      resolve(process.cwd(), 'src', 'modules', 'cockpit', 'cockpitIntent.ts'),
      'utf8',
    );
    expect(source).not.toContain('@/shared/api');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('XMLHttpRequest');
    expect(source.toLowerCase()).not.toContain('openai');
    expect(source.toLowerCase()).not.toContain('anthropic');
  });
});
