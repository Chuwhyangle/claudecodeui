/**
 * The `ui_show_diff` criterion (gap-mcp-ui-focus-turn-show-diff-open-task).
 *
 * The tool tells ONE connected browser to reveal a file's diff in the Git panel,
 * and — like its three siblings — it answers with the DELIVERY reading, names one
 * device, throttles per token and attributes the asker through the gateway's ONE
 * resolution. The body is shared ({@link ./mcp-ui-navigation.js}); this criterion
 * reads back what makes `ui_show_diff` ITSELF:
 *
 *   - the frame carries `at: { diffFile }`, the argument name being `filePath`;
 *   - revealing a diff is NOT a session-opening move, so an applied navigation
 *     must NOT write the "last opened" pointer (that is `ui_focus_turn` /
 *     `ui_open_session`'s side effect, not this tool's);
 *   - the scope refusal and the absent self-target guard over a real `/mcp`.
 *
 * The rig is {@link ./mcp-ui-navigation-harness.js}, shared with the other three
 * tools.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import type { AnyRecord } from '@/shared/types.js';
import {
  ACCESS_TOKEN_SCOPES,
  MCP_ERROR_CODES,
  NAVIGATE_SCOPE,
  cleanupHarness,
  createRig,
  makeTab,
  principal,
  refusal,
  visibleNavigations,
  withNavigationGateway,
} from './mcp-ui-navigation-harness.js';

const {
  buildUiShowDiff,
  createUiShowDiffRateLimiter,
  MCP_UI_SHOW_DIFF_RATE_LIMIT_PER_MINUTE,
  UI_SHOW_DIFF_RATE_WINDOW_MS,
} = await import('../mcp-ui-show-diff.js');
const { MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE } = await import('../mcp-ui-navigation.js');

// =====================================================================
// (1) the frame carries the diff target
// =====================================================================

test('(1) the frame carries { diffFile } read from the filePath argument, and names one device', async () => {
  const laptop = makeTab({ deviceId: 'dev-laptop', tabId: 'l-1', deviceName: 'Laptop' }, { ack: 'applied' });
  const phone = makeTab({ deviceId: 'dev-phone', tabId: 'p-1', deviceName: 'Phone' }, { ack: 'shown' });
  const rig = createRig([laptop, phone]);

  const payload = await buildUiShowDiff(
    rig.deps,
    { session: 'sess-1', filePath: 'src/app.ts', client: 'laptop' },
    principal(),
  );
  assert.equal(payload.device.deviceId, 'dev-laptop');
  assert.equal(payload.status, 'applied');
  assert.equal(laptop.frames.length, 1, 'the named device receives exactly one frame');
  assert.equal(phone.frames.length, 0, 'the other device is never written to');
  assert.equal(laptop.frames[0].type, 'ui.navigate');
  assert.equal(laptop.frames[0].sessionId, 'sess-1');
  assert.deepEqual(
    laptop.frames[0].at,
    { diffFile: 'src/app.ts' },
    'the wire target is `diffFile`, read from the `filePath` argument',
  );
  assert.equal(laptop.frames[0].navigationId, payload.navigationId);
});

test('(1) with several browsers the client is REQUIRED, and no browser is NO_CLIENT', async () => {
  const rig = createRig([
    makeTab({ deviceId: 'a', tabId: 'a1', deviceName: 'A' }, { ack: 'applied' }),
    makeTab({ deviceId: 'b', tabId: 'b1', deviceName: 'B' }, { ack: 'applied' }),
  ]);
  await refusal(
    () => buildUiShowDiff(rig.deps, { session: 'sess-1', filePath: 'src/app.ts' }, principal()),
    MCP_ERROR_CODES.CLIENT_REQUIRED.code,
  );
  assert.equal(rig.tabs[0].frames.length + rig.tabs[1].frames.length, 0, 'a refused call writes nothing');

  const empty = createRig([]);
  await refusal(
    () => buildUiShowDiff(empty.deps, { session: 'sess-1', filePath: 'src/app.ts' }, principal()),
    MCP_ERROR_CODES.NO_CLIENT.code,
  );
});

// =====================================================================
// (2) the delivery reading
// =====================================================================

test('(2) the ack maps to the delivery status, and a silent device resolves unresponsive', async () => {
  const shown = makeTab({ deviceId: 'd-1', tabId: 't-1', deviceName: 'Shown' }, { ack: 'shown' });
  const declined = makeTab({ deviceId: 'd-2', tabId: 't-2', deviceName: 'Declined' }, { ack: 'declined' });
  const rig = createRig([shown, declined]);

  const asked = await buildUiShowDiff(rig.deps, { session: 's1', filePath: 'a.ts', client: 'd-1' }, principal());
  assert.equal(asked.status, 'pending_user', 'a shown bar is a pending decision');
  const said = await buildUiShowDiff(rig.deps, { session: 's1', filePath: 'a.ts', client: 'd-2' }, principal());
  assert.equal(said.status, 'declined');

  const silent = makeTab({ deviceId: 'd-3', tabId: 't-3', deviceName: 'Silent' }, { ack: null });
  const quiet = createRig([silent]);
  const startedAt = Date.now();
  const unanswered = await buildUiShowDiff(quiet.deps, { session: 's1', filePath: 'a.ts' }, principal());
  assert.equal(unanswered.status, 'unresponsive');
  assert.ok(Date.now() - startedAt >= 1_300, 'the call waits the delivery window out for a silent tab');
});

// =====================================================================
// (3) the retained record and the ABSENT last-opened write
// =====================================================================

test('(3) the record is visible with the diff target, and a diff reveal does NOT write last-opened', async () => {
  const applied: Array<{ sessionId: string; at: number }> = [];
  const tab = makeTab({ deviceId: 'dev-1', tabId: 't-1', deviceName: 'Browser' }, { ack: 'shown' });
  const rig = createRig([tab], { recordApplied: (sessionId, at) => applied.push({ sessionId, at }) });

  const payload = await buildUiShowDiff(rig.deps, { session: 'sess-diff', filePath: 'src/app.ts' }, principal());
  assert.equal(payload.status, 'pending_user');

  const visible = await visibleNavigations(rig);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].at, { diffFile: 'src/app.ts' }, 'the retained record carries the diff target');

  // The user accepts the reveal later.
  const handled = rig.service.handleResult(tab.connection, {
    type: 'ui.navigate_result',
    navigationId: payload.navigationId,
    deviceId: 'dev-1',
    tabId: 't-1',
    status: 'applied',
  });
  assert.equal(handled, true);
  const after2 = await visibleNavigations(rig);
  assert.equal(after2[0].status, 'applied', 'ui_visible_context reflects the verdict');
  assert.deepEqual(
    applied,
    [],
    'revealing a diff leaves the session where it was — it must NOT write the "last opened" pointer',
  );
});

// =====================================================================
// (4) the throttle
// =====================================================================

test('(4) the (N+1)th call in a minute is RATE_LIMITED, read from the shared exported limit', async () => {
  assert.equal(MCP_UI_SHOW_DIFF_RATE_LIMIT_PER_MINUTE, MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE);

  let clock = 0;
  const limiter = createUiShowDiffRateLimiter({ now: () => clock });
  const tab = makeTab({ deviceId: 'dev-1', tabId: 't-1', deviceName: 'Browser' }, { ack: 'applied' });
  const rig = createRig([tab], { rateLimiter: limiter });
  const caller = principal({ tokenId: 11 });

  for (let index = 0; index < MCP_UI_SHOW_DIFF_RATE_LIMIT_PER_MINUTE; index += 1) {
    const payload = await buildUiShowDiff(rig.deps, { session: 's1', filePath: `f-${index}.ts` }, caller);
    assert.equal(payload.status, 'applied');
  }
  const limited = await refusal(
    () => buildUiShowDiff(rig.deps, { session: 's1', filePath: 'f-x.ts' }, caller),
    MCP_ERROR_CODES.RATE_LIMITED.code,
  );
  const details = limited.details as AnyRecord;
  assert.equal(details.limit, MCP_UI_SHOW_DIFF_RATE_LIMIT_PER_MINUTE);
  assert.equal(details.windowMs, UI_SHOW_DIFF_RATE_WINDOW_MS);
  assert.equal(details.tool, 'ui_show_diff', 'the refusal names the tool the caller hit');
  assert.equal(tab.frames.length, MCP_UI_SHOW_DIFF_RATE_LIMIT_PER_MINUTE, 'a refused call writes no frame');
});

// =====================================================================
// (5) the scope refusal and the absent self-target guard, over a real mount
// =====================================================================

test('(5) a token without cloudcli:navigate is refused INSUFFICIENT_SCOPE naming the scope', async () => {
  await withNavigationGateway({
    toolName: 'ui_show_diff',
    depsKey: 'uiShowDiff',
    scopes: [ACCESS_TOKEN_SCOPES[0] as string],
    run: async (call, navigateCalls) => {
      const result = await call({ session: 'sess-1', filePath: 'src/app.ts' });
      assert.equal(result.isError, true);
      const structured = result.structuredContent as AnyRecord;
      assert.equal(structured.code, MCP_ERROR_CODES.INSUFFICIENT_SCOPE.code);
      const required = (structured.details as AnyRecord).requiredScopes as string[];
      assert.ok(required.includes(NAVIGATE_SCOPE));
      assert.equal(navigateCalls.length, 0, 'a scope refusal must never reach the navigation service');
    },
  });
});

test('(5) a fully scoped call executes against a live turn — no SELF_TARGET', async () => {
  await withNavigationGateway({
    toolName: 'ui_show_diff',
    depsKey: 'uiShowDiff',
    scopes: ACCESS_TOKEN_SCOPES,
    run: async (call, navigateCalls) => {
      const result = await call({ session: 'sess-1', filePath: 'src/app.ts' });
      assert.notEqual((result.structuredContent as AnyRecord)?.code, 'SELF_TARGET');
      assert.notEqual(result.isError, true, `expected a payload, got ${JSON.stringify(result)}`);
      const structured = result.structuredContent as AnyRecord;
      assert.equal(structured.navigationId, 'nav-1');
      assert.equal(structured.status, 'applied');
      assert.equal(navigateCalls.length, 1, 'the call reached the navigation service exactly once');
      assert.deepEqual(navigateCalls[0].at, { diffFile: 'src/app.ts' });
    },
  });
});

after(cleanupHarness);
