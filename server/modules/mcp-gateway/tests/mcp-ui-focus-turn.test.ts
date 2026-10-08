/**
 * The `ui_focus_turn` criterion (gap-mcp-ui-focus-turn-show-diff-open-task).
 *
 * The tool tells ONE connected browser to focus a turn inside a session, and it
 * answers with the DELIVERY reading rather than with the user's decision. Every
 * in-process leg drives the REAL navigation service over fake browsers and reads
 * the REAL tool (`buildUiFocusTurn`), so the frames a fake browser records are the
 * frames the service wrote and the acks it sends back are routed through the
 * service's own `handleAck` / `handleResult`. The rig is
 * {@link ./mcp-ui-navigation-harness.js}, shared with the other three tools.
 *
 * One leg (`INSUFFICIENT_SCOPE` / the absent guard) is driven over a real `/mcp`
 * mount, because the scope refusal is the transport's and cannot be exercised in
 * process.
 *
 * Readings:
 *   (1) device resolution and the FRAME — `client` is omittable with one device and
 *       REQUIRED with several, only the selected device is written to, and the
 *       frame carries `at: { turnId }`.
 *   (2) the delivery reading — shown ⇒ pending_user, applied ⇒ applied, declined ⇒
 *       declined, silence ⇒ unresponsive.
 *   (3) the retained record — `ui_visible_context`'s `navigations[]` reflects it and
 *       carries the same `{ turnId }` target.
 *   (4) the throttle — the (N+1)th call a minute is RATE_LIMITED, the limit read
 *       from the SAME exported constant `ui_open_session` uses; and a focus IS a
 *       session-opening move, so an applied navigation writes last-opened.
 *   (5) the scope refusal and the absent self-target guard, over a real mount.
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
  buildUiFocusTurn,
  createUiFocusTurnRateLimiter,
  MCP_UI_FOCUS_TURN_RATE_LIMIT_PER_MINUTE,
  UI_FOCUS_TURN_RATE_WINDOW_MS,
} = await import('../mcp-ui-focus-turn.js');
// The shared core's constant, so the leg below can prove the tool's limit IS
// `ui_open_session`'s — one binding, not two copies of the number `6`.
const { MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE } = await import('../mcp-ui-navigation.js');

// =====================================================================
// (1) device resolution and the frame
// =====================================================================

test('(1) only the selected device is written to, and the frame carries the turn target', async () => {
  const laptop = makeTab({ deviceId: 'dev-laptop', tabId: 'l-1', deviceName: 'Laptop' }, { ack: 'applied' });
  const phone = makeTab({ deviceId: 'dev-phone', tabId: 'p-1', deviceName: 'Phone' }, { ack: 'shown' });
  const rig = createRig([laptop, phone]);

  // Omitted `client` with SEVERAL devices is refused — the ambiguity is not guessed at.
  await refusal(
    () => buildUiFocusTurn(rig.deps, { session: 'sess-1', turnId: 'anchor-1' }, principal()),
    MCP_ERROR_CODES.CLIENT_REQUIRED.code,
  );
  assert.equal(laptop.frames.length, 0, 'a refused call must not write to any device');
  assert.equal(phone.frames.length, 0);

  // Naming one device writes to it and to no other.
  const payload = await buildUiFocusTurn(
    rig.deps,
    { session: 'sess-1', turnId: 'anchor-9', client: 'laptop' },
    principal(),
  );
  assert.equal(payload.device.deviceId, 'dev-laptop');
  assert.equal(payload.status, 'applied');
  assert.equal(laptop.frames.length, 1, 'the named device receives exactly one frame');
  assert.equal(phone.frames.length, 0, 'the other device is never written to');
  assert.equal(laptop.frames[0].type, 'ui.navigate');
  assert.equal(laptop.frames[0].sessionId, 'sess-1');
  assert.deepEqual(laptop.frames[0].at, { turnId: 'anchor-9' }, 'the frame carries the turn target');
  assert.equal(laptop.frames[0].navigationId, payload.navigationId, 'the frame carries the minted id');
});

test('(1) a single device is chosen without a client, and no device at all is NO_CLIENT', async () => {
  const only = makeTab({ deviceId: 'dev-only', tabId: 'o-1', deviceName: 'Only Browser' }, { ack: 'applied' });
  const single = createRig([only]);
  const payload = await buildUiFocusTurn(single.deps, { session: 'sess-7', turnId: 'a-1' }, principal());
  assert.equal(payload.device.deviceId, 'dev-only', 'a lone device needs no id echoed back');
  assert.equal(only.frames.length, 1);

  const empty = createRig([]);
  const refusalError = await refusal(
    () => buildUiFocusTurn(empty.deps, { session: 'sess-7', turnId: 'a-1' }, principal()),
    MCP_ERROR_CODES.NO_CLIENT.code,
  );
  assert.deepEqual((refusalError.details as AnyRecord).candidates, [], 'no browsers means no candidates');
});

// =====================================================================
// (2) the delivery reading; the call does not wait for the user
// =====================================================================

test('(2) the ack maps to the delivery status, and the call returns at the ack', async () => {
  const ask = makeTab({ deviceId: 'dev-ask', tabId: 'a-1', deviceName: 'Ask' }, { ack: 'shown' });
  const accept = makeTab({ deviceId: 'dev-accept', tabId: 'c-1', deviceName: 'Accept' }, { ack: 'applied' });
  const reject = makeTab({ deviceId: 'dev-reject', tabId: 'r-1', deviceName: 'Reject' }, { ack: 'declined' });
  const rig = createRig([ask, accept, reject]);

  const asked = await buildUiFocusTurn(rig.deps, { session: 'sess-1', turnId: 'a', client: 'dev-ask' }, principal());
  assert.equal(asked.status, 'pending_user', 'a shown bar is a pending decision, not a verdict');

  const accepted = await buildUiFocusTurn(rig.deps, { session: 'sess-1', turnId: 'a', client: 'dev-accept' }, principal());
  assert.equal(accepted.status, 'applied');

  const declined = await buildUiFocusTurn(rig.deps, { session: 'sess-1', turnId: 'a', client: 'dev-reject' }, principal());
  assert.equal(declined.status, 'declined');

  // The call resolved on the ACK: no tab ever sent a `ui.navigate_result`, so a
  // tool that waited for the user's decision would still be pending here.
  assert.equal(rig.service.listNavigations().length, 3);
});

test('(2) a silent device resolves unresponsive at the delivery window', async () => {
  const silent = makeTab({ deviceId: 'dev-silent', tabId: 's-1', deviceName: 'Silent' }, { ack: null });
  const rig = createRig([silent]);

  const startedAt = Date.now();
  const payload = await buildUiFocusTurn(rig.deps, { session: 'sess-1', turnId: 'a' }, principal());
  const elapsed = Date.now() - startedAt;

  assert.equal(payload.status, 'unresponsive', 'nobody listened, so the instruction did not land');
  assert.equal(silent.frames.length, 1, 'the frame was still written to the silent tab');
  assert.ok(elapsed >= 1_300, `the call must wait the delivery window out, saw ${elapsed}ms`);
  assert.ok(elapsed < 3_000, `the call must not wait far past the window, saw ${elapsed}ms`);
});

// =====================================================================
// (3) the retained record
// =====================================================================

test('(3) the record is visible in ui_visible_context with the turn target, and a later result mutates it', async () => {
  const tab = makeTab({ deviceId: 'dev-1', tabId: 't-1', deviceName: 'Browser' }, { ack: 'shown' });
  const rig = createRig([tab]);

  const payload = await buildUiFocusTurn(rig.deps, { session: 'sess-1', turnId: 'anchor-42' }, principal());
  assert.equal(payload.status, 'pending_user');

  const visible = await visibleNavigations(rig);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].navigationId, payload.navigationId);
  assert.deepEqual(visible[0].at, { turnId: 'anchor-42' }, 'the retained record carries the same turn target');
  assert.equal(visible[0].status, 'pending_user');

  // The user decides later; the tool has long since returned, and the result
  // names the RECORD by id.
  const handled = rig.service.handleResult(tab.connection, {
    type: 'ui.navigate_result',
    navigationId: payload.navigationId,
    deviceId: 'dev-1',
    tabId: 't-1',
    status: 'applied',
  });
  assert.equal(handled, true, 'a well-formed result for a retained record is applied');
  const after2 = await visibleNavigations(rig);
  assert.equal(after2[0].status, 'applied', 'ui_visible_context reflects the later verdict');
});

// =====================================================================
// (4) the throttle and the last-opened write
// =====================================================================

test('(4) the (N+1)th call in a minute is RATE_LIMITED, read from the shared exported limit', async () => {
  // The tool's limit IS `ui_open_session`'s — the same shared binding, not a copy.
  assert.equal(MCP_UI_FOCUS_TURN_RATE_LIMIT_PER_MINUTE, MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE);

  let clock = 0;
  const limiter = createUiFocusTurnRateLimiter({ now: () => clock });
  const tab = makeTab({ deviceId: 'dev-1', tabId: 't-1', deviceName: 'Browser' }, { ack: 'applied' });
  const rig = createRig([tab], { rateLimiter: limiter });
  const caller = principal({ tokenId: 7 });

  for (let index = 0; index < MCP_UI_FOCUS_TURN_RATE_LIMIT_PER_MINUTE; index += 1) {
    const payload = await buildUiFocusTurn(rig.deps, { session: 'sess-1', turnId: `a-${index}` }, caller);
    assert.equal(payload.status, 'applied');
  }
  assert.equal(tab.frames.length, MCP_UI_FOCUS_TURN_RATE_LIMIT_PER_MINUTE, 'each allowed call wrote exactly one frame');

  const limited = await refusal(
    () => buildUiFocusTurn(rig.deps, { session: 'sess-1', turnId: 'a-x' }, caller),
    MCP_ERROR_CODES.RATE_LIMITED.code,
  );
  const details = limited.details as AnyRecord;
  assert.equal(details.limit, MCP_UI_FOCUS_TURN_RATE_LIMIT_PER_MINUTE, 'the reading names the exported limit');
  assert.equal(details.windowMs, UI_FOCUS_TURN_RATE_WINDOW_MS);
  assert.equal(details.tool, 'ui_focus_turn', 'the refusal names the tool the caller hit');
  assert.equal(tab.frames.length, MCP_UI_FOCUS_TURN_RATE_LIMIT_PER_MINUTE, 'a refused call writes no frame');

  // A DIFFERENT token has its own budget.
  const other = principal({ tokenId: 8 });
  const allowed = await buildUiFocusTurn(rig.deps, { session: 'sess-1', turnId: 'a-y' }, other);
  assert.equal(allowed.status, 'applied', 'the throttle is per token, not global');

  // Once the window slides, the first token is allowed again.
  clock += UI_FOCUS_TURN_RATE_WINDOW_MS + 1;
  const recovered = await buildUiFocusTurn(rig.deps, { session: 'sess-1', turnId: 'a-z' }, caller);
  assert.equal(recovered.status, 'applied', 'the window is a sliding reading, not a permanent ban');
});

test('(4) a focus IS a session-opening move, so an applied navigation writes last-opened', async () => {
  const applied: Array<{ sessionId: string; at: number }> = [];
  const accept = makeTab({ deviceId: 'dev-accept', tabId: 'c-1', deviceName: 'Accept' }, { ack: 'applied' });
  const rig = createRig([accept], { recordApplied: (sessionId, at) => applied.push({ sessionId, at }) });

  await buildUiFocusTurn(rig.deps, { session: 'sess-focus', turnId: 'a-1' }, principal());
  assert.deepEqual(applied.map((entry) => entry.sessionId), ['sess-focus'], 'an applied focus writes last-opened');
});

// =====================================================================
// (5) the scope refusal and the absent self-target guard, over a real mount
// =====================================================================

test('(5) a token without cloudcli:navigate is refused INSUFFICIENT_SCOPE naming the scope', async () => {
  await withNavigationGateway({
    toolName: 'ui_focus_turn',
    depsKey: 'uiFocusTurn',
    scopes: [ACCESS_TOKEN_SCOPES[0] as string],
    run: async (call, navigateCalls) => {
      const result = await call({ session: 'sess-1', turnId: 'anchor-1' });
      assert.equal(result.isError, true, 'a token without the scope must be refused');
      const structured = result.structuredContent as AnyRecord;
      assert.equal(structured.code, MCP_ERROR_CODES.INSUFFICIENT_SCOPE.code);
      const required = (structured.details as AnyRecord).requiredScopes as string[];
      assert.ok(required.includes(NAVIGATE_SCOPE), `the missing set must name "${NAVIGATE_SCOPE}"`);
      assert.equal(navigateCalls.length, 0, 'a scope refusal must never reach the navigation service');
    },
  });
});

test('(5) a fully scoped call executes against its own live turn — no SELF_TARGET', async () => {
  await withNavigationGateway({
    toolName: 'ui_focus_turn',
    depsKey: 'uiFocusTurn',
    scopes: ACCESS_TOKEN_SCOPES,
    run: async (call, navigateCalls) => {
      const result = await call({ session: 'sess-1', turnId: 'anchor-1' });
      assert.notEqual(
        (result.structuredContent as AnyRecord)?.code,
        'SELF_TARGET',
        'moving the caller own view must not be refused by the self-target guard',
      );
      assert.notEqual(result.isError, true, `expected a payload, got ${JSON.stringify(result)}`);
      const structured = result.structuredContent as AnyRecord;
      assert.equal(structured.navigationId, 'nav-1');
      assert.equal(structured.status, 'applied');
      assert.equal(navigateCalls.length, 1, 'the call reached the navigation service exactly once');
      assert.deepEqual(navigateCalls[0].at, { turnId: 'anchor-1' });
    },
  });
});

after(cleanupHarness);
