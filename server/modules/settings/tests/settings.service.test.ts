import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createServerFeaturesRouter } from '../server-features.routes.js';
import { loadServerSettings } from '../server-settings.js';
import { createSettingsService } from '../settings.service.js';

type Dependencies = Parameters<typeof createSettingsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    credentials: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined },
    getVapidPublicKey: () => null,
    accessTokens: {
      list: () => [],
      findById: () => undefined,
      issue: () => ({ ok: false, reason: 'invalid_expiry' }),
      revoke: () => false,
    },
    ...overrides,
  };
}

test('subscribeToPush persists the subscription and enables Web Push', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: () => undefined,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { operations.push('notify'); },
    },
  }));

  service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences', 'notify']);
});

test('createAccessToken rejects a lifetime outside 7/30/90 without issuing', () => {
  let issued = 0;
  const service = createSettingsService(dependencies({
    accessTokens: {
      list: () => [],
      findById: () => undefined,
      issue: () => { issued += 1; return { ok: false, reason: 'invalid_expiry' }; },
      revoke: () => false,
    },
  }));

  for (const expiresInDays of [0, 1, 6, 10, 365, -1, '30', null]) {
    assert.throws(
      () => service.createAccessToken(1, { name: 'laptop', expiresInDays }),
      (error: { code?: string; statusCode?: number }) =>
        error.code === 'INVALID_EXPIRES_IN' && error.statusCode === 400,
    );
  }
  // A missing lifetime defaults to 30 rather than being rejected.
  assert.throws(
    () => service.createAccessToken(1, { name: 'laptop' }),
    (error: { code?: string }) => error.code === 'ACCESS_TOKEN_ISSUE_FAILED',
  );
  assert.equal(issued, 1);
});

/** A stored personal-access-token row: `kind` 'pat' and a real `name`. */
const PAT_ROW = {
  id: 9,
  user_id: 1,
  kind: 'pat',
  token_hash: 'deadbeef'.repeat(8),
  token_prefix: 'ccp_abc1',
  name: 'laptop',
  scopes: JSON.stringify(['cloudcli:read']),
  expires_at: '2026-02-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  last_used: null,
  revoked_at: null,
};

/** A stored OAuth row exactly as the OAuth store writes it: `name` NULL, kind `oauth_access`. */
const OAUTH_ROW = {
  id: 42,
  user_id: 1,
  kind: 'oauth_access',
  token_hash: 'cafebabe'.repeat(8),
  token_prefix: 'cca_abc1',
  name: null,
  scopes: JSON.stringify(['cloudcli:read']),
  expires_at: '2026-02-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  last_used: null,
  revoked_at: null,
};

test('listAccessTokens asks for PAT rows only and projects them without the token hash', () => {
  const kindsAsked: (string | undefined)[] = [];
  const service = createSettingsService(dependencies({
    accessTokens: {
      // Mirrors the repository's SQL filter: the store only returns rows whose
      // kind matches the argument, so dropping the argument lets the OAuth row
      // through and this test reds.
      list: (_userId, kind) => {
        kindsAsked.push(kind);
        return [PAT_ROW, OAUTH_ROW].filter((row) => kind === undefined || row.kind === kind);
      },
      findById: () => undefined,
      issue: () => ({ ok: false, reason: 'invalid_expiry' }),
      revoke: () => false,
    },
  }));

  const listed = service.listAccessTokens(1);
  assert.deepEqual(kindsAsked, ['pat']);
  assert.equal(listed.tokens.length, 1);
  assert.deepEqual(listed.tokens[0], {
    id: 9,
    tokenPrefix: 'ccp_abc1',
    name: 'laptop',
    scopes: ['cloudcli:read'],
    expiresAt: '2026-02-01T00:00:00.000Z',
    lastUsed: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
  });
  // The nameless OAuth row is not in this list, so no entry renders as "Unnamed token".
  assert.equal(listed.tokens.some((token) => token.id === OAUTH_ROW.id), false);
  assert.equal(Object.keys(listed.tokens[0]).includes('token_hash'), false);
  assert.equal(JSON.stringify(listed).includes('deadbeef'), false);
});

test('listOAuthTokens projects the non-PAT rows (client name, no token hash)', () => {
  const service = createSettingsService(dependencies({
    oauthTokens: {
      list: () => [{ ...OAUTH_ROW, client_name: 'Preset App' }],
    },
  }));

  const listed = service.listOAuthTokens(1);
  assert.equal(listed.tokens.length, 1);
  assert.deepEqual(listed.tokens[0], {
    id: 42,
    kind: 'oauth_access',
    tokenPrefix: 'cca_abc1',
    clientName: 'Preset App',
    scopes: ['cloudcli:read'],
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    lastUsed: null,
    revokedAt: null,
  });
  assert.equal(Object.keys(listed.tokens[0]).includes('token_hash'), false);
  assert.equal(JSON.stringify(listed).includes('cafebabe'), false);
});

test('the cockpit switch ships off and only an explicit boolean true enables it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'server-settings-cockpit-'));
  try {
    // (a) No user copy at all: the shipped default is the answer, and an absent file is normal.
    const shipped = loadServerSettings({ env: {}, defaultPath: path.join(directory, 'absent.json') });
    assert.equal(shipped.cockpit.enabled, false);
    assert.equal(shipped.source, 'default');
    assert.deepEqual(shipped.problems, []);

    // (b) The opt-in.
    const enabledPath = path.join(directory, 'enabled.json');
    await writeFile(enabledPath, JSON.stringify({ cockpit: { enabled: true } }), 'utf8');
    const enabled = loadServerSettings({ settingsPath: enabledPath });
    assert.equal(enabled.cockpit.enabled, true);
    assert.equal(enabled.source, 'file');
    assert.deepEqual(enabled.problems, []);

    // (c) A string is malformed, not an opt-in: it falls back to the safe shipped value.
    const malformedPath = path.join(directory, 'malformed.json');
    await writeFile(malformedPath, JSON.stringify({ cockpit: { enabled: 'true' } }), 'utf8');
    const malformed = loadServerSettings({ settingsPath: malformedPath });
    assert.equal(malformed.cockpit.enabled, false);
    assert.ok(
      malformed.problems.some((problem) => problem.includes('cockpit.enabled')),
      `expected a problem naming cockpit.enabled, got ${JSON.stringify(malformed.problems)}`,
    );

    // (d) `counterVoice` is the sibling reader's block; its presence must not make `cockpit`
    // look malformed, and it must not turn the feature on.
    const siblingPath = path.join(directory, 'sibling.json');
    await writeFile(
      siblingPath,
      JSON.stringify({ cockpit: { counterVoice: { enabled: true, model: 'x' } } }),
      'utf8',
    );
    const sibling = loadServerSettings({ settingsPath: siblingPath });
    assert.equal(sibling.cockpit.enabled, false);
    assert.deepEqual(sibling.problems, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GET /api/settings/features relays the boot-time reading unchanged', async () => {
  const app = express();
  app.use(
    '/api/settings/features',
    createServerFeaturesRouter({ cockpit: { enabled: false } }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/settings/features`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cockpit: { enabled: false } });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
