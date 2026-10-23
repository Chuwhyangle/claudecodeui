import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  EDGE_OPACITY_BUSY,
  EDGE_OPACITY_DENSE,
  EDGE_OPACITY_QUIET,
  EDGE_OPACITY_VERY_DENSE,
  followCompactedFrame,
  NAME_ELLIPSIS_MIN_CHARS,
  NAME_ELLIPSIS_MIN_CHARS_SEED,
  PACKAGE_TAB_PADDING_PX,
  planCompartmentRules,
  planEdgeOpacity,
  planEntityContent,
  planEntityName,
  planMemberRows,
  planPackageLabel,
  planPackageTab,
  planStickyLabels,
  planTextWidth,
} from '@/modules/architecture/semanticZoomPlan';

/**
 * The semantic-zoom content plan, in isolation.
 *
 * These are the readings the design fixes (README rules 3, 4, 5, 6 and 7):
 * the three-level name fallback with its minimum retained characters, the two
 * compartment rules that survive a compacted frame (one for an operations-only
 * interface), the shortened package tab with its aggregate count and C-tier
 * `★N` badge, at most two sticky names, the four edge-opacity bands and an edge
 * endpoint that follows a shortened frame onto its new edge.
 *
 * The font is the PC floor (10 px) throughout; the phone floor is the same
 * logic at 11 px and is exercised by the component/E2E readings.
 */

const FONT_PX = 10;

describe('class-name fallback (rule 3)', () => {
  test('a name inside the cap is drawn on one line', () => {
    const planned = planEntityName('Alpha', FONT_PX, false);
    assert.equal(planned.form, 'single');
    assert.deepEqual(planned.lines, ['Alpha']);
    assert.equal(planned.titleHeight, FONT_PX + 5);
    assert.ok(planned.minWidth <= 130);
  });

  test('a long camel-case name wraps at a token boundary instead of eliding', () => {
    const planned = planEntityName('ArchitectureSemanticZoomLayout', FONT_PX, false);
    assert.equal(planned.form, 'wrapped');
    assert.equal(planned.lines.length, 2);
    assert.deepEqual(planned.lines, ['Architecture', 'SemanticZoomLayout']);
    // Two lines need a taller title compartment, which is what pushes the
    // frame's first rule down.
    assert.equal(planned.titleHeight, 2 * (FONT_PX * 1.25) + 3);
  });

  test('a name with no wrap point elides in the middle, keeping the tail', () => {
    const name = 'abcdefghijklmnopqrstuvwxyzabcdef';
    const planned = planEntityName(name, FONT_PX, false);
    assert.equal(planned.form, 'ellipsis');
    assert.equal(planned.lines.length, 1);
    const line = planned.lines[0];
    assert.ok(line.includes('…'), 'the elision is visible');
    const kept = line.replace('…', '').length;
    assert.ok(
      kept >= NAME_ELLIPSIS_MIN_CHARS,
      `a non-highlighted name keeps at least ${NAME_ELLIPSIS_MIN_CHARS} characters; kept ${kept}`,
    );
    assert.ok(line.endsWith(name.slice(-6)), 'the tail stays readable');
    assert.equal(planned.minWidth, 130);
    assert.ok(planTextWidth(line, FONT_PX, 'mono-bold') <= 130);
  });

  test('a session-mentioned name keeps six characters, not nine', () => {
    const name = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const seed = planEntityName(name, FONT_PX, true);
    const plain = planEntityName(name, FONT_PX, false);
    assert.equal(seed.form, 'ellipsis');
    assert.ok(seed.lines[0].replace('…', '').length >= NAME_ELLIPSIS_MIN_CHARS_SEED);
    assert.ok(
      seed.lines[0].length <= plain.lines[0].length,
      'the highlighted node is allowed a longer elision (fewer kept characters)',
    );
  });
});

describe('class frame and compartments (rule 7)', () => {
  test('a class always keeps two rules, and both positions are inside the frame', () => {
    const content = planEntityContent(
      { label: 'Alpha', kind: 'class', hasAttributes: true, hasOperations: true, seed: false },
      FONT_PX,
    );
    assert.equal(content.ruleCount, 2);
    assert.equal(content.hasAttributes, true);
    assert.equal(content.hasOperations, true);
    const rules = planCompartmentRules({
      height: 60,
      titleHeight: content.titleHeight,
      hasAttributes: content.hasAttributes,
      hasOperations: content.hasOperations,
      kind: content.kind,
    });
    assert.equal(rules.length, 2);
    assert.equal(rules[0], content.titleHeight);
    assert.ok(rules[1] > rules[0] && rules[1] < 60);
  });

  test('an interface with only operations keeps one rule', () => {
    const content = planEntityContent(
      { label: 'Runner', kind: 'interface', hasAttributes: false, hasOperations: true, seed: false },
      FONT_PX,
    );
    assert.equal(content.hasAttributes, false);
    assert.equal(content.hasOperations, true);
    assert.equal(content.ruleCount, 1);
    const rules = planCompartmentRules({
      height: 50,
      titleHeight: content.titleHeight,
      hasAttributes: content.hasAttributes,
      hasOperations: content.hasOperations,
      kind: content.kind,
    });
    assert.deepEqual(rules, [content.titleHeight]);
  });

  test('member rows stop at the room the compact frame has and say how many are left', () => {
    const rows = planMemberRows({
      members: ['a: string', 'b: number', 'run()'],
      height: 60,
      titleHeight: 15,
      fontPx: FONT_PX,
      maxWidth: 110,
      moreLine: null,
    });
    // room = floor((60 - 15 - 10) / 12.5) = 2; one row is spent on "… +N more".
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.moreLabel, '… +2 more');
  });
});

describe('package tab (rules 4 and 6)', () => {
  test('the label is the last path segment, and the original count is split off', () => {
    assert.deepEqual(planPackageLabel('src/modules/architecture (12)'), { text: 'architecture', count: 12 });
    assert.deepEqual(planPackageLabel('src/modules/architecture'), { text: 'architecture', count: null });
    assert.deepEqual(planPackageLabel('modules\\chat'), { text: 'chat', count: null });
  });

  test('the tab carries the aggregate count, and tier C adds an orange ★N badge', () => {
    const tierB = planPackageTab({
      raw: 'src/modules/chat',
      entityCount: 3,
      mentionedCount: 2,
      tier: 'B',
      fontPx: FONT_PX,
    });
    assert.equal(tierB.text, 'chat (3)');
    assert.equal(tierB.badge, '');

    const tierC = planPackageTab({
      raw: 'src/modules/chat',
      entityCount: 3,
      mentionedCount: 2,
      tier: 'C',
      fontPx: FONT_PX,
    });
    assert.equal(tierC.badge, ' ★2');
    assert.ok(tierC.width > tierB.width, 'the badge widens the tab, and the solver reserves that width');
    assert.equal(tierC.height, FONT_PX + PACKAGE_TAB_PADDING_PX);
  });

  test('a package with no mention gets no badge even at tier C', () => {
    const tab = planPackageTab({ raw: 'src/a', entityCount: 1, mentionedCount: 0, tier: 'C', fontPx: FONT_PX });
    assert.equal(tab.badge, '');
  });
});

describe('sticky names and edge furniture (rules 4, 5 and the compaction rule)', () => {
  test('at most two package names stick to the viewport top', () => {
    const frames = [
      { id: 'a', depth: 0, top: -50, bottom: 300 },
      { id: 'b', depth: 1, top: -20, bottom: 200 },
      { id: 'c', depth: 2, top: -10, bottom: 120 },
      { id: 'd', depth: 0, top: 40, bottom: 400 },
    ];
    const stickies = planStickyLabels(frames, 0);
    assert.equal(stickies.length, 2);
    assert.deepEqual(stickies.map((frame) => frame.id), ['b', 'c']);
  });

  test('edge opacity takes the 0.85/0.5/0.3/0.18 bands at the 22/40/100 boundaries', () => {
    assert.equal(planEdgeOpacity(0), EDGE_OPACITY_QUIET);
    assert.equal(planEdgeOpacity(22), EDGE_OPACITY_QUIET, 'exactly 22 is still the quiet band');
    assert.equal(planEdgeOpacity(23), EDGE_OPACITY_BUSY);
    assert.equal(planEdgeOpacity(40), EDGE_OPACITY_BUSY, 'exactly 40 is still the busy band');
    assert.equal(planEdgeOpacity(41), EDGE_OPACITY_DENSE);
    assert.equal(planEdgeOpacity(100), EDGE_OPACITY_DENSE, 'exactly 100 is still the dense band');
    assert.equal(planEdgeOpacity(101), EDGE_OPACITY_VERY_DENSE);
  });

  test('an endpoint on a compacted frame follows it to the new bottom edge', () => {
    const cell = { x: 0, y: 0, w: 100, h: 40 };
    const drawn = { x: 0, y: 0, w: 100, h: 20 };
    const bottom = followCompactedFrame({ point: { x: 50, y: 40 }, cell, drawn });
    assert.deepEqual(bottom, { x: 50, y: 20 });
  });

  test('an endpoint on a compacted frame’s side lands on the side, above the new bottom', () => {
    const cell = { x: 0, y: 0, w: 100, h: 40 };
    const drawn = { x: 0, y: 0, w: 100, h: 20 };
    const side = followCompactedFrame({ point: { x: 100, y: 35 }, cell, drawn });
    assert.equal(side.x, 100, 'the side is unchanged');
    assert.ok(side.y <= 20, 'the endpoint is pulled up onto the drawn frame’s side');
    assert.ok(side.y >= drawn.y);
  });

  test('an endpoint on an uncompacted frame is left alone', () => {
    const cell = { x: 0, y: 0, w: 100, h: 40 };
    const point = { x: 50, y: 40 };
    assert.deepEqual(followCompactedFrame({ point, cell, drawn: cell }), point);
  });
});
