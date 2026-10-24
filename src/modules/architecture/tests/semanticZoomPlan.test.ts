import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  CLASS_NAME_MAX_WIDTH_PX,
  EDGE_OPACITY_BUSY,
  EDGE_OPACITY_DENSE,
  EDGE_OPACITY_QUIET,
  EDGE_OPACITY_VERY_DENSE,
  followCompactedFrame,
  memberRuleOffset,
  MEMBER_COMPACTION_FADE_RATIO,
  MEMBER_ROWS_VISIBLE_MIN,
  NAME_ELLIPSIS_MIN_CHARS,
  NAME_ELLIPSIS_MIN_CHARS_SEED,
  PACKAGE_TAB_PADDING_PX,
  placeStickyLabels,
  planCompactFrameHeight,
  planCompartmentRules,
  planEdgeOpacity,
  planEntityContent,
  planEntityName,
  planEntityNameForWidth,
  planHintPlacement,
  planMemberFrameHeight,
  planMemberRows,
  planPackageLabel,
  planPackageTab,
  planRectsIntersect,
  planStickyLabels,
  planTextWidth,
  semanticMemberCompaction,
  SEMANTIC_IDENTITY_SCALE,
  SEMANTIC_MIN_FONT_MOBILE_PX,
  SEMANTIC_MIN_FONT_PX,
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

describe('stereotype text (the minimum-font rule on the title band)', () => {
  test('a drawn stereotype uses the floor font and grows the title compartment by a line', () => {
    for (const fontPx of [SEMANTIC_MIN_FONT_PX, SEMANTIC_MIN_FONT_MOBILE_PX]) {
      const plain = planEntityContent(
        { label: 'Runner', kind: 'interface', hasAttributes: false, hasOperations: true, seed: false },
        fontPx,
      );
      assert.equal(plain.stereotype, 'interface');
      assert.equal(
        plain.stereotypeFontPx,
        fontPx,
        'the stereotype is drawn at the floor font, never a scaled-down one',
      );
      assert.ok(plain.stereotypeFontPx !== null && plain.stereotypeFontPx >= fontPx);
      // The title band holds a full stereotype line AND the name line.
      assert.equal(plain.titleHeight, plain.name.titleHeight + fontPx * 1.25);
      // The box's minimum width holds the token at that same font.
      const tokenWidth = planTextWidth('<<interface>>', fontPx, 'sans');
      assert.ok(
        plain.minWidth >= tokenWidth,
        `the box must hold the stereotype (${plain.minWidth} < ${tokenWidth})`,
      );
    }
  });

  test('a stereotype wider than the box cap is hidden instead of shrunk or clipped', () => {
    const long = 'averyverylongstereotypetoken';
    const content = planEntityContent(
      {
        label: 'Widget',
        kind: 'class',
        stereotype: long,
        hasAttributes: true,
        hasOperations: true,
        seed: false,
      },
      SEMANTIC_MIN_FONT_PX,
    );
    assert.ok(
      planTextWidth(`<<${long}>>`, SEMANTIC_MIN_FONT_PX, 'sans') > CLASS_NAME_MAX_WIDTH_PX,
      'the case only means something when the token genuinely exceeds the cap',
    );
    assert.equal(content.stereotype, null, 'the un-fittable stereotype is hidden');
    assert.equal(content.stereotypeFontPx, null);
    assert.equal(content.titleHeight, content.name.titleHeight, 'a hidden stereotype takes no title space');
  });
});

describe('upstream member totals (one overflow hint only)', () => {
  test('the “+N more” line counts the rows the renderer already dropped', () => {
    const rows = planMemberRows({
      // The renderer kept four of five rows; the fifth is its own truncation row,
      // stripped by the read layer. Ours must still say one is missing.
      members: ['a: string', 'b: number', 'c: string', 'run()'],
      totalMembers: 5,
      height: 60,
      titleHeight: 15,
      fontPx: FONT_PX,
      maxWidth: 110,
      moreLine: null,
    });
    // room = floor((60 - 15 - 10) / 12.5) = 2; one row is spent on the hint.
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.moreLabel, '… +4 more');
  });

  test('a frame with room for every kept row still names the dropped one', () => {
    const rows = planMemberRows({
      members: ['a: string', 'b: number', 'c: string', 'run()'],
      totalMembers: 5,
      height: 200,
      titleHeight: 15,
      fontPx: FONT_PX,
      maxWidth: 110,
      moreLine: null,
    });
    assert.equal(rows.rows.length, 4);
    assert.equal(rows.moreLabel, '… +1 more');
  });
});

describe('sticky-name appearance and placement (rules 2 and 3)', () => {
  const viewport = { x: 0, y: 0, w: 390, h: 500 };

  test('a package whose own tab is still on screen gets no ghost label', () => {
    // `top` is above the viewport, but the tab (at the frame's top) straddles
    // the top edge and is still visible — the state that painted two labels.
    const frames = [
      { id: 'visible-tab', depth: 0, top: -2, bottom: 300, tab: { x: 10, y: -2, w: 90, h: 16 } },
      { id: 'scrolled-tab', depth: 1, top: -80, bottom: 300, tab: { x: 10, y: -80, w: 90, h: 16 } },
    ];
    const stickies = planStickyLabels(frames, viewport.y, viewport);
    assert.deepEqual(stickies.map((frame) => frame.id), ['scrolled-tab']);
  });

  test('a sticky label is clamped inside the viewport and never covers a name, tab or sibling', () => {
    const placed = placeStickyLabels({
      candidates: [
        // Anchor far left of the viewport: the pill would be clipped without clamping.
        { id: 'left', anchorX: -200, width: 120, height: 16 },
        // Its default slot collides with a class name → skipped, not drawn over it.
        { id: 'blocked', anchorX: 20, width: 120, height: 16 },
        { id: 'last', anchorX: 250, width: 120, height: 16 },
      ],
      viewport,
      // Sits exactly in the SECOND slot, so only that candidate is skipped.
      obstacles: [{ x: 20, y: 18, w: 60, h: 14 }],
    });
    for (const placement of placed) {
      assert.ok(placement.rect.x >= viewport.x, 'not clipped on the left');
      assert.ok(placement.rect.x + placement.rect.w <= viewport.x + viewport.w, 'not clipped on the right');
      assert.ok(placement.rect.y >= viewport.y, 'not clipped at the top');
      assert.ok(placement.rect.y + placement.rect.h <= viewport.y + viewport.h, 'not clipped at the bottom');
    }
    assert.deepEqual(placed.map((placement) => placement.id), ['left', 'last']);
    assert.equal(placed[0].rect.x, 2, 'the left anchor is clamped to the viewport margin');
    for (const a of placed) {
      for (const b of placed) {
        if (a.id !== b.id) assert.equal(planRectsIntersect(a.rect, b.rect), false, 'two ghosts never overlap');
      }
    }
  });

  test('the hint pill moves off a package tab instead of covering it', () => {
    const tabs = [{ x: 8, y: 8, w: 100, h: 18 }];
    const topLeft = planHintPlacement({ width: 200, height: 24, viewport, obstacles: tabs });
    assert.equal(
      planRectsIntersect({ x: topLeft.x, y: topLeft.y, w: 200, h: 24 }, tabs[0]),
      false,
      'the chosen corner must not intersect the tab',
    );
    assert.equal(topLeft.y, viewport.y + 8, 'the top-left candidate is blocked, so it does not stay there');
  });

  test('a sticky label is not drawn over the overview hint pill either', () => {
    const placed = placeStickyLabels({
      candidates: [{ id: 'top', anchorX: 0, width: 120, height: 16 }],
      viewport,
      // The hint occupies every top-edge slot this single candidate could use.
      obstacles: [{ x: 0, y: 0, w: 390, h: 40 }],
    });
    assert.deepEqual(placed, [], 'no sticky label rather than one covering the hint');
  });
});

/**
 * The second compartment rule, positioned from the member rows the component
 * draws. The baseline/rect arithmetic mirrors `PlantUmlGraph.drawSemanticLayout`
 * (both use `memberRuleOffset` and one row pitch), so this is the same geometry
 * the browser draws.
 */
describe('member-positioned compartment rule (defect 5)', () => {
  const LINE_HEIGHT = FONT_PX * 1.25;
  const TITLE = 20;

  type Row = { readonly text: string; readonly compartment: 'attr' | 'op'; readonly more: boolean };
  const rowRects = (rows: ReturnType<typeof planMemberRows>, ruleY: number): { row: Row; rect: { x: number; y: number; w: number; h: number } }[] => {
    const result: { row: Row; rect: { x: number; y: number; w: number; h: number } }[] = [];
    let attr = 0;
    let op = 0;
    rows.rows.forEach((text, index) => {
      const inAttributes = index < rows.attrCount;
      const baseline = inAttributes
        ? TITLE + (attr + 1) * LINE_HEIGHT - 2
        : ruleY + (op + 1) * LINE_HEIGHT - 2;
      result.push({
        row: { text, compartment: rows.compartments[index], more: false },
        rect: { x: 0, y: baseline - FONT_PX * 0.8, w: 100, h: FONT_PX },
      });
      if (inAttributes) attr += 1;
      else op += 1;
    });
    if (rows.moreLabel !== null) {
      const inAttributes = rows.moreCompartment === 'attr';
      const baseline = inAttributes
        ? TITLE + (rows.attrCount + 1) * LINE_HEIGHT - 2
        : ruleY + (op + 1) * LINE_HEIGHT - 2;
      result.push({
        row: { text: rows.moreLabel, compartment: inAttributes ? 'attr' : 'op', more: true },
        rect: { x: 0, y: baseline - FONT_PX * 0.8, w: 100, h: FONT_PX },
      });
    }
    return result;
  };

  const check = (members: readonly string[], compartments: readonly ('attr' | 'op')[], height: number): void => {
    const rows = planMemberRows({
      members,
      compartments,
      height,
      titleHeight: TITLE,
      fontPx: FONT_PX,
      maxWidth: 200,
      moreLine: null,
    });
    const ruleY = memberRuleOffset(rows, TITLE);
    const rules = planCompartmentRules({
      height,
      titleHeight: TITLE,
      hasAttributes: compartments.includes('attr'),
      hasOperations: compartments.includes('op'),
      kind: 'class',
      memberLines: rows,
    });
    assert.deepEqual(rules, [TITLE, ruleY], 'the second rule is the member-positioned one');
    const rowsOnScreen = rowRects(rows, ruleY);
    const ruleRect = { x: 0, y: ruleY - 0.5, w: 200, h: 1 };
    for (const { row, rect } of rowsOnScreen) {
      assert.equal(
        planRectsIntersect(ruleRect, rect),
        false,
        `the rule must not cross “${row.text}” (${row.compartment}${row.more ? ', more' : ''})`,
      );
    }
    const attrs = rowsOnScreen.filter((entry) => entry.row.compartment === 'attr');
    const ops = rowsOnScreen.filter((entry) => entry.row.compartment === 'op');
    if (attrs.length > 0) {
      const lastAttrBottom = Math.max(...attrs.map((entry) => entry.rect.y + entry.rect.h));
      assert.ok(ruleY > lastAttrBottom, `the rule must sit below the last attribute row (${ruleY} vs ${lastAttrBottom})`);
    }
    if (ops.length > 0) {
      const firstOpTop = Math.min(...ops.map((entry) => entry.rect.y));
      assert.ok(ruleY < firstOpTop, `the rule must sit above the first operation row (${ruleY} vs ${firstOpTop})`);
    }
  };

  test('attributes only: the rule sits below the last attribute row', () => {
    check(['- a: string', '- b: number', '- c: string'], ['attr', 'attr', 'attr'], 70);
  });

  test('operations only: the rule sits above the first operation row', () => {
    check(['+ run()', '+ stop()', '+ reset()'], ['op', 'op', 'op'], 70);
  });

  test('both compartments: attributes above, operations below', () => {
    check(['- a: string', '- b: number', '+ run()', '+ stop()'], ['attr', 'attr', 'op', 'op'], 80);
  });

  test('attributes truncated by “+N more”: the rule follows the overflow line', () => {
    const rows = planMemberRows({
      members: ['- a: string', '- b: number', '- c: string', '- d: string', '- e: string', '+ run()', '+ stop()'],
      compartments: ['attr', 'attr', 'attr', 'attr', 'attr', 'op', 'op'],
      height: 70,
      titleHeight: TITLE,
      fontPx: FONT_PX,
      maxWidth: 200,
      moreLine: null,
    });
    assert.equal(rows.moreCompartment, 'attr', 'the cut fell inside the attribute block');
    assert.equal(rows.attrCount, 2);
    assert.equal(rows.linesBeforeRule, 3, 'two attribute rows plus the overflow line');
    check(['- a: string', '- b: number', '- c: string', '- d: string', '- e: string', '+ run()', '+ stop()'],
      ['attr', 'attr', 'attr', 'attr', 'attr', 'op', 'op'], 70);
  });
});

describe('draw-time name selection for the real box width (defect 7)', () => {
  test('a 615px box draws VoiceFrameProcessor on one line', () => {
    const planned = planEntityNameForWidth('VoiceFrameProcessor', 615, FONT_PX, false);
    assert.equal(planned.form, 'single');
    assert.deepEqual(planned.lines, ['VoiceFrameProcessor']);
    assert.equal(planned.titleHeight, FONT_PX + 5, 'one line reserves one line of title height');
  });

  test('a narrower box wraps the same name at a camel-case boundary', () => {
    const planned = planEntityNameForWidth('VoiceFrameProcessor', 100, FONT_PX, false);
    assert.equal(planned.form, 'wrapped');
    assert.equal(planned.lines.length, 2);
    assert.deepEqual(planned.lines, ['VoiceFrame', 'Processor']);
    assert.equal(planned.titleHeight, 2 * (FONT_PX * 1.25) + 3);
  });

  test('a box too narrow for either keeps the middle ellipsis', () => {
    const planned = planEntityNameForWidth('VoiceFrameProcessor', 60, FONT_PX, false);
    assert.equal(planned.form, 'ellipsis');
    assert.equal(planned.lines.length, 1);
    assert.ok(planned.lines[0].includes('…'));
    assert.equal(planned.titleHeight, FONT_PX + 5);
  });
});

describe('function and enum stereotypes (defect 8)', () => {
  test('function and enum stereotypes are drawn at the floor font', () => {
    for (const kind of ['function', 'enum'] as const) {
      const content = planEntityContent(
        { label: `${kind}Name`, kind, hasAttributes: false, hasOperations: false, seed: false },
        SEMANTIC_MIN_FONT_MOBILE_PX,
      );
      assert.equal(content.stereotype, kind, `${kind} states its kind`);
      assert.equal(content.stereotypeFontPx, SEMANTIC_MIN_FONT_MOBILE_PX);
      assert.ok((content.stereotypeFontPx ?? 0) >= SEMANTIC_MIN_FONT_PX);
    }
  });

  test('a function node keeps exactly one compartment rule', () => {
    const content = planEntityContent(
      { label: 'run', kind: 'function', hasAttributes: false, hasOperations: false, seed: false },
      FONT_PX,
    );
    const rules = planCompartmentRules({
      height: 40,
      titleHeight: content.titleHeight,
      hasAttributes: false,
      hasOperations: false,
      kind: 'function',
    });
    assert.deepEqual(rules, [content.titleHeight], 'no empty second compartment');
  });
});

describe('the member-hidden frame height (vertical compaction)', () => {
  // A class whose name plans on one line; the worst title the draw-time width
  // can pick is therefore that same line.
  const plan = planEntityContent(
    { label: 'Widget', kind: 'class', hasAttributes: true, hasOperations: true, seed: false },
    FONT_PX,
  );
  const FULL = 140;
  const COMPACT = planCompactFrameHeight({
    kind: plan.kind,
    hasAttributes: plan.hasAttributes,
    titleHeight: plan.reservedTitleHeight,
  });

  test('planMemberRows owns the “member text rendered” verdict', () => {
    const few = planMemberRows({
      members: ['a: string', 'b: string', 'run()'],
      height: 60,
      titleHeight: plan.titleHeight,
      fontPx: FONT_PX,
      maxWidth: 110,
      moreLine: null,
    });
    // room = 2, one row spent on “+N more” → one visible row is NOT enough.
    assert.equal(few.rows.length, 1);
    assert.equal(few.visible, false, `a frame with fewer than ${MEMBER_ROWS_VISIBLE_MIN} rows renders none`);

    const many = planMemberRows({
      members: ['a: string', 'b: string', 'run()'],
      height: 140,
      titleHeight: plan.titleHeight,
      fontPx: FONT_PX,
      maxWidth: 110,
      moreLine: null,
    });
    assert.ok(many.rows.length >= MEMBER_ROWS_VISIBLE_MIN);
    assert.equal(many.visible, true);

    const empty = planMemberRows({
      members: [],
      height: 140,
      titleHeight: plan.titleHeight,
      fontPx: FONT_PX,
      maxWidth: 110,
      moreLine: null,
    });
    assert.equal(empty.visible, false, 'a memberless frame never renders member text');
  });

  test('the compaction is 0 at the identity threshold and 1 at 90 % of it, continuously', () => {
    assert.equal(semanticMemberCompaction(SEMANTIC_IDENTITY_SCALE), 0);
    assert.equal(
      semanticMemberCompaction(SEMANTIC_IDENTITY_SCALE * MEMBER_COMPACTION_FADE_RATIO),
      1,
    );
    const mid = semanticMemberCompaction((SEMANTIC_IDENTITY_SCALE + SEMANTIC_IDENTITY_SCALE * MEMBER_COMPACTION_FADE_RATIO) / 2);
    assert.ok(mid > 0 && mid < 1, `the 10 % band interpolates; got ${mid}`);
  });

  test('the axis length is the compact frame when hidden and the full height when visible', () => {
    const hiddenRows = planMemberRows({
      members: ['a: string'],
      height: FULL,
      titleHeight: plan.titleHeight,
      fontPx: FONT_PX,
      maxWidth: 110,
      moreLine: null,
    });
    assert.equal(hiddenRows.visible, false);
    const compacted = planMemberFrameHeight({
      fullHeight: FULL,
      compactHeight: COMPACT,
      rows: hiddenRows,
      compaction: 1,
    });
    assert.equal(compacted, COMPACT, 'a fully compacted frame is its title band plus the divider band');

    const visibleRows = planMemberRows({
      members: ['a: string', 'b: string', 'run()'],
      height: FULL,
      titleHeight: plan.titleHeight,
      fontPx: FONT_PX,
      maxWidth: 110,
      moreLine: null,
    });
    assert.equal(visibleRows.visible, true);
    assert.equal(
      planMemberFrameHeight({
        fullHeight: FULL,
        compactHeight: COMPACT,
        rows: visibleRows,
        compaction: 1,
      }),
      FULL,
      'visible member text keeps the renderer’s full height, whatever the compaction',
    );
  });

  test('the height is monotone non-increasing as the scale falls across the threshold', () => {
    // One member can never reach the two-row threshold, so visibility is held
    // constant while only the compaction ramp changes — the comparison is about
    // the ramp, not about the row count.
    const rows = planMemberRows({
      members: ['a: string'],
      height: FULL,
      titleHeight: plan.titleHeight,
      fontPx: FONT_PX,
      maxWidth: 110,
      moreLine: null,
    });
    const heightAt = (scale: number): number => planMemberFrameHeight({
      fullHeight: FULL,
      compactHeight: COMPACT,
      rows,
      compaction: semanticMemberCompaction(scale),
    });
    const scales = [1, 0.95, 0.92, SEMANTIC_IDENTITY_SCALE, 0.88, 0.85, 0.83, 0.82,
      SEMANTIC_IDENTITY_SCALE * MEMBER_COMPACTION_FADE_RATIO, 0.7, 0.5, 0.2];
    let previous = Number.POSITIVE_INFINITY;
    for (const scale of scales) {
      const height = heightAt(scale);
      assert.ok(
        height <= previous + 1e-9,
        `as the scale falls the hidden frame must never grow: ${scale} → ${height} (was ${previous})`,
      );
      assert.ok(height >= COMPACT - 1e-9, 'the compact frame is the floor');
      assert.ok(height <= FULL + 1e-9, 'the full height is the ceiling');
      previous = height;
    }
    assert.equal(heightAt(SEMANTIC_IDENTITY_SCALE), FULL);
    assert.equal(heightAt(SEMANTIC_IDENTITY_SCALE * MEMBER_COMPACTION_FADE_RATIO), COMPACT);
  });

  test('a frame already shorter than its title + divider is never grown', () => {
    const short = COMPACT - 6;
    const rows = planMemberRows({
      members: ['a: string'],
      height: short,
      titleHeight: plan.titleHeight,
      fontPx: FONT_PX,
      maxWidth: 110,
      moreLine: null,
    });
    assert.equal(
      planMemberFrameHeight({ fullHeight: short, compactHeight: COMPACT, rows, compaction: 1 }),
      short,
      'the compaction may only remove member rows, never add height',
    );
  });
});
