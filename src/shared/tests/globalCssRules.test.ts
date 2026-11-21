import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import postcss from 'postcss';
import { describe, test } from 'vitest';

/**
 * The hand-written global stylesheet may not contain a rule that defeats the element it styles.
 *
 * `src/index.css` is the only authored sheet, and an audit of it against a rendered corpus (one rule at
 * a time: delete it from the CSSOM, re-read every matched element's computed style, put it back) found
 * three rules whose job was to be *general* and whose effect was to override what a component had asked
 * for. Each is pinned here as the shape of rule that must not exist, because the failure is invisible in
 * the rule itself — `white-space: pre-wrap !important` reads as a sensible default until it is seen to
 * beat the `white-space: pre` a syntax highlighter writes on its own `<pre>`.
 *
 * jsdom parses no Tailwind and lays nothing out, so this file reads the source. What a rule does to a
 * rendered page is `e2e/css-global-rules.spec.ts`'s job; this is the fast guard against reintroducing the
 * shape, and it fails with the offending rule's line so the red names the thing to delete.
 */

const css = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
const tailwindConfig = fs.readFileSync(path.join(process.cwd(), 'tailwind.config.js'), 'utf8');

type Found = { line: number; selector: string; decl: string };

/** Every declaration in the sheet, with the rule it sits in and that rule's line. */
const declarations = (): Array<Found & { prop: string; value: string; important: boolean }> => {
  const out: Array<Found & { prop: string; value: string; important: boolean }> = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes/.test((rule.parent as postcss.AtRule).name)) return;
    rule.walkDecls((d) => {
      out.push({
        line: rule.source?.start?.line ?? 0,
        selector: rule.selector.replace(/\s+/g, ' '),
        decl: `${d.prop}: ${d.value}${d.important ? ' !important' : ''}`,
        prop: d.prop,
        value: d.value,
        important: d.important,
      });
    });
  });
  return out;
};

const describeFound = (found: Found[]) => found.map((f) => `L${f.line} ${f.selector} { ${f.decl} }`).join('\n  ');

/** A selector part that can reach a `<pre>` or a `<code>` that sits inside one. */
const reachesPreformattedBlock = (selector: string): boolean =>
  selector.split(',').some((part) => {
    const p = part.trim();
    const hasPre = /(^|[\s>+~])pre(?=$|[\s>+~.:#\[)])/.test(p.replace(/:not\([^)]*\)/g, ''));
    // `:not(pre) > code` is the inline-code selector: a code whose parent is not a pre.
    const hasBlockableCode = /(^|[\s>+~])code(?=$|[\s>+~.:#\[)])/.test(p) && !/:not\(pre\)\s*>\s*code/.test(p);
    return hasPre || hasBlockableCode;
  });

describe('a global rule must not out-rank the element it styles', () => {
  test('nothing sets how a <pre> or the <code> inside one wraps', () => {
    // The shipped rule — `.chat-message pre, .chat-message code { white-space: pre-wrap !important;
    // word-break: break-all }` — beat the `white-space: pre` and `text-wrap-mode: nowrap` the syntax
    // highlighter writes inline on its own `<pre>`, and set `break-all` on the `<code>` inside it, so a
    // fenced block of an 853px-wide line was folded into a 332px box (a 4-line block drew as 16 lines)
    // and could not be scrolled sideways. A code block's wrapping is the highlighter's to decide.
    const offenders = declarations().filter(
      (d) => /^(white-space|word-break|overflow-wrap|text-wrap)/.test(d.prop) && reachesPreformattedBlock(d.selector),
    );
    assert.deepEqual(offenders, [], `these rules decide how a code block wraps and must not:\n  ${describeFound(offenders)}`);
  });

  test('inline code is still told how to wrap, and only inline code', () => {
    // The control for the test above: deleting the rule altogether would also pass it. Inline code needs
    // `overflow-wrap: anywhere` so a long path breaks instead of pushing a flex child wider than its row.
    const inline = declarations().filter(
      (d) => /:not\(pre\)\s*>\s*code/.test(d.selector) && d.prop === 'overflow-wrap' && d.value === 'anywhere',
    );
    assert.ok(inline.length > 0, 'a rule scoped to `:not(pre) > code` must set `overflow-wrap: anywhere`');
  });

  test('no :hover rule neutralises a property by inheriting it', () => {
    // `button:hover { background-color: inherit !important; … }` inside `(hover: none)` was meant to stop
    // hover styling sticking after a tap. `inherit` takes the PARENT's value, not the un-hovered one, so a
    // tapped solid-blue button turned into whatever its container's background was (transparent) with
    // dark text, and one button went to `opacity: 0`. The right tool is not to apply hover styles where
    // hover is not supported — `future.hoverOnlyWhenSupported` — not to overwrite them afterwards.
    const offenders = declarations().filter((d) => /:hover/.test(d.selector) && d.value === 'inherit');
    assert.deepEqual(offenders, [], `these :hover rules overwrite with the parent's value:\n  ${describeFound(offenders)}`);
  });

  test('Tailwind applies hover: utilities only where hover is supported', () => {
    assert.match(
      tailwindConfig,
      /future\s*:\s*\{[^}]*hoverOnlyWhenSupported\s*:\s*true/,
      'tailwind.config.js must set future.hoverOnlyWhenSupported so `hover:` utilities live in @media (hover: hover)',
    );
  });

  test('the PWA safe-area shift is scoped to the app shells, not to every fixed overlay', () => {
    // `body.pwa-mode .fixed.inset-0 { top: … }` matched ~40 elements: the three full-page roots it was
    // written for AND every modal backdrop, drawer scrim and lightbox, which then started 8px (plus the
    // device's safe-area inset) below the top of the screen and left the status-bar strip undimmed.
    const reachesEveryFixedOverlay = declarations().filter(
      (d) => /\.pwa-mode/.test(d.selector) && /\.fixed\.inset-0|\.inset-0\.fixed/.test(d.selector),
    );
    assert.deepEqual(
      reachesEveryFixedOverlay,
      [],
      `these rules shift every .fixed.inset-0 element in PWA mode:\n  ${describeFound(reachesEveryFixedOverlay)}`,
    );

    const scoped = declarations().filter((d) => /\.pwa-mode/.test(d.selector) && /\[data-app-shell\]/.test(d.selector) && d.prop === 'top');
    assert.ok(scoped.length > 0, 'the shift must still exist, scoped to `[data-app-shell]` — otherwise the shells lose it');
  });
});

describe('the sidebar activity indicator runs at the display rate', () => {
  test('no sidebar rule slows the spinner down; the base rotation is continuous', () => {
    // A running-session row spins for the whole turn. When the page still carried ~172
    // compositor layers (154 promoted 276x52 sticky project rows), a 60fps transform
    // animation made the compositor walk that tree every frame: ~20% of one core, ~9.5%
    // in the GPU process. `steps(15)` sat on the low plateau at 15 updates/s. The sticky
    // rows are now conditional (collapsed rows have no layer), the same page measures 13
    // layers, and a 5x10s interleaved CDP matrix put 60fps inside the 15Hz envelope
    // (paired delta total -0.9 points, GPU -0.0 points) — so the spinner is smooth again.
    // Reintroducing a sidebar override needs a new measured reading, not a memory of one.
    const sidebarAnimations = declarations().filter(
      (d) => d.selector === '#sidebar-panel .animate-spin' && d.prop === 'animation',
    );
    console.log(
      `sidebarSpinAnimations=${JSON.stringify(sidebarAnimations.map((d) => d.value))}`,
    );
    assert.deepEqual(
      sidebarAnimations,
      [],
      `no \`#sidebar-panel .animate-spin\` animation rule may slow the spinner down:\n  ${describeFound(sidebarAnimations)}`,
    );

    const base = declarations().filter((d) => d.selector === '.animate-spin' && d.prop === 'animation');
    assert.equal(
      base.length,
      1,
      `exactly one \`.animate-spin\` animation rule must exist:\n  ${describeFound(base)}`,
    );
    const value = base[0].value.replace(/\s+/g, ' ').trim();
    console.log(`baseSpinAnimation=${value}`);
    assert.match(
      value,
      /^spin 1s linear infinite$/,
      `the spinner must keep rotating every frame; found: ${value}`,
    );
  });
});
