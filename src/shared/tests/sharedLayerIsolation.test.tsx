import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import * as shared from '@/shared';
import { WebSocketProvider } from '@/shared/context/WebSocketContext';

/**
 * `src/shared` must load and render without any feature module.
 *
 * The layering inversion this guards against is `shared → modules/*`: a shared
 * module importing a feature module (the provider used to import `useAuth` from
 * `modules/auth` and `readDeviceName` from `modules/settings`). Such an edge is
 * invisible at runtime until the feature's dependencies are unavailable, so the
 * criterion makes the edge *throw*: every feature module the shared provider
 * could reach is a stub whose factory increments a counter and throws. Then:
 *
 *   (a) importing the shared barrel and rendering the websocket provider must
 *       leave the counter at 0 — no stub was ever asked for;
 *   (b) the positive control imports the stub explicitly; the counter reaches 1
 *       and the import rejects. Without (b), 0 would also be the reading of a
 *       stub that does not work at all.
 *
 * The render is not downgraded to an import: the provider is given an auth port
 * and a fake WebSocket, so the real mount path runs. It never reaches `onopen`,
 * so nothing is sent on the wire.
 */

/**
 * Counts how many feature-module stubs were asked for; any hit is the inversion.
 *
 * Hoisted because `vi.mock` factories are lifted above the imports; the factory
 * must reach both the counter and its own body through this hoisted object.
 */
const stub = vi.hoisted(() => {
  const state = { imports: 0 };
  const throwOnImport = () => {
    state.imports += 1;
    throw new Error('shared layer imported a feature module');
  };
  return { state, throwOnImport };
});

/**
 * The feature modules the shared provider historically imported. A static import
 * of either of these from `src/shared` is the inversion this file exists to see;
 * `src/shared`'s source-level criterion covers every other module path.
 */
vi.mock('@/modules/auth', stub.throwOnImport);
vi.mock('@/modules/settings', stub.throwOnImport);

/** The provider only needs a socket that exists; nothing here opens the handshake. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('shared loads and renders with every feature-module stub untouched; the control makes one throw', async () => {
  // -------- (a) the isolation reading -------------------------------------
  vi.stubGlobal('WebSocket', FakeWebSocket);

  // The barrel must be importable on its own: importing it is where a re-export
  // of a feature-backed value would pull the feature graph in.
  assert.equal(typeof shared.readDeviceName, 'function', 'the shared barrel must expose the shared reader');
  assert.equal(shared.readDeviceName().length > 0, true, 'the shared reader must answer without a feature module');

  render(React.createElement(WebSocketProvider, {
    auth: { isLoading: false, token: 'isolation-token', user: { id: 1 } },
  }));

  const isolated = stub.state.imports;
  assert.equal(isolated, 0, 'rendering the shared provider must not import any feature module');
  console.log(`[shared-layer-isolation] (a) stub import count after barrel import + provider render: ${isolated} (expected 0)`);

  // -------- (b) the positive control --------------------------------------
  // The same stub, imported deliberately. It must throw and the counter must
  // move, which is what gives (a) its discriminating power.
  let controlError: unknown = null;
  try {
    await import('@/modules/auth');
  } catch (error) {
    controlError = error;
  }

  // Vitest reports a throwing `vi.mock` factory as its own wrapper error, so the
  // assertion is on the rejection and the counter — the two readings the stub
  // owns — rather than on the wrapper's wording.
  assert.ok(controlError, 'the positive control must reject: a throwing stub that never throws proves nothing');
  assert.equal(stub.state.imports, 1, 'the control import must be counted exactly once');
  console.log(`[shared-layer-isolation] (b) control import rejected: ${String(controlError)}`);
  console.log(`[shared-layer-isolation] (b) control stub import count: ${stub.state.imports} (expected 1)`);
});
