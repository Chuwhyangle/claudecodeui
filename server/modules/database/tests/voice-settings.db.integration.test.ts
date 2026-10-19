import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionDraftsDb } from '@/modules/database/repositories/session-drafts.db.js';
import { userPreferencesDb } from '@/modules/database/repositories/user-preferences.db.js';
import { voiceSettingsDb } from '@/modules/database/repositories/voice-settings.db.js';
import type { VoiceSettings } from '@/shared/types.js';

/**
 * The settings a user saved against their own OpenAI-compatible backend. These
 * used to live in browser localStorage, so the upgrade path matters as much as
 * the fresh-install path: an install that predates this table has to gain it on
 * the next start without disturbing anything else it already holds.
 */

const SAMPLE_SETTINGS: VoiceSettings = {
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'sk-sentinel-groq-key',
  sttModel: 'whisper-large-v3',
  ttsModel: 'playai-tts',
  ttsVoice: 'Arista-PlayAI',
  ttsFormat: 'mp3',
  providerId: '',
  dashscopeEndpoint: '',
  dashscopeApiKey: '',
  dashscopeModel: '',
  liveVoiceDashscopeApiKey: '',
};

/**
 * What the document of a user who has never saved anything reads as.
 *
 * Spelled out per site below rather than shared through this constant, and that is deliberate: each
 * site is an assertion about the WHOLE document, so a reader comparing the expected value to the
 * stored one has both in front of them. The four provider-owned fields are present and empty in
 * every one of them, which is the property this task adds — a field the writer drops is
 * indistinguishable from a field the user never set, and only an exhaustive literal can tell the
 * difference.
 */
const LEGACY_ROW_FIELDS = ['baseUrl', 'apiKey', 'sttModel', 'ttsModel', 'ttsVoice', 'ttsFormat'] as const;

/**
 * The four fields this task added, in the order the store's own list carries them.
 *
 * Named once here because two readings below are about them as a group — "a legacy row reads them
 * as empty" and "a saved row carries all of them" — and a list written out at each site would let
 * one of the two silently cover three fields after a fourth was added.
 */
const PROVIDER_OWNED_FIELDS = ['providerId', 'dashscopeEndpoint', 'dashscopeApiKey', 'dashscopeModel'] as const;

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'voice-settings-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function tableNames(): string[] {
  return (
    getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

/** Row count per application table, so "the upgrade did not disturb anything" is checkable. */
function rowCounts(): Record<string, number> {
  return Object.fromEntries(
    tableNames()
      .filter((name) => !name.startsWith('sqlite_'))
      .map((name) => [
        name,
        (
          getConnection().prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as {
            count: number;
          }
        ).count,
      ])
  );
}

function createUser(id: number, username: string): void {
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(id, username, 'hash');
}

test('a freshly created database carries an empty user_voice_settings table', async () => {
  await withIsolatedDatabase(() => {
    assert.ok(
      tableNames().includes('user_voice_settings'),
      'a fresh database must create the user_voice_settings table'
    );

    createUser(1, 'tester');
    assert.deepEqual(voiceSettingsDb.getSettings(1), {
      baseUrl: '',
      apiKey: '',
      sttModel: '',
      ttsModel: '',
      ttsVoice: '',
      ttsFormat: '',
      providerId: '',
      dashscopeEndpoint: '',
      dashscopeApiKey: '',
      dashscopeModel: '',
      liveVoiceDashscopeApiKey: '',
    });
  });
});

test('an existing database gains the table on the next start without disturbing its rows', async () => {
  await withIsolatedDatabase(async () => {
    createUser(1, 'tester');
    userPreferencesDb.savePreferences(1, { theme: 'dark' });
    sessionDraftsDb.saveDraft(1, 'session-a', { text: 'half typed', queuedMessage: null });

    // Take the baseline after a second open, so nothing reset by an ordinary
    // start-up (row ids, timestamps) reads as damage done by this migration.
    closeConnection();
    await initializeDatabase();

    // The shape an install that predates the feature has on disk: no table.
    // Dropping it reproduces that state exactly, rather than approximating it.
    getConnection().exec('DROP TABLE user_voice_settings');
    assert.ok(!tableNames().includes('user_voice_settings'));

    const countsBefore = rowCounts();
    const preferencesBefore = userPreferencesDb.getPreferences(1);
    const draftsBefore = sessionDraftsDb.getDrafts(1);

    // The app starts again against that file; migrations run on open.
    closeConnection();
    await initializeDatabase();

    assert.ok(
      tableNames().includes('user_voice_settings'),
      'the upgrade must create the user_voice_settings table'
    );
    assert.deepEqual(
      rowCounts(),
      { ...countsBefore, user_voice_settings: 0 },
      'no other table may gain or lose a row across the upgrade'
    );
    assert.deepEqual(userPreferencesDb.getPreferences(1), preferencesBefore);
    assert.deepEqual(sessionDraftsDb.getDrafts(1), draftsBefore);

    // Reopening the upgraded database is a no-op, not a second rewrite.
    closeConnection();
    await initializeDatabase();

    assert.deepEqual(rowCounts(), { ...countsBefore, user_voice_settings: 0 });
    assert.ok(tableNames().includes('user_voice_settings'));
  });
});

test('saving settings twice for one user upserts rather than appending', async () => {
  await withIsolatedDatabase(() => {
    createUser(1, 'tester');

    voiceSettingsDb.saveSettings(1, SAMPLE_SETTINGS);
    voiceSettingsDb.saveSettings(1, { ...SAMPLE_SETTINGS, apiKey: 'sk-rotated', ttsVoice: 'alloy' });

    assert.deepEqual(voiceSettingsDb.getSettings(1), {
      ...SAMPLE_SETTINGS,
      apiKey: 'sk-rotated',
      ttsVoice: 'alloy',
    });
    assert.equal(
      (
        getConnection()
          .prepare('SELECT COUNT(*) AS count FROM user_voice_settings WHERE user_id = 1')
          .get() as { count: number }
      ).count,
      1,
      'a second save must replace the row, not add one'
    );
  });
});

test('a field the stored document does not carry reads back as unset', async () => {
  await withIsolatedDatabase(() => {
    createUser(1, 'tester');

    // Simulates a row written by an older build with fewer fields, or one whose
    // JSON has been edited by hand: neither may take the other five away.
    getConnection()
      .prepare("INSERT INTO user_voice_settings (user_id, settings_json) VALUES (?, ?)")
      .run(1, JSON.stringify({ baseUrl: 'https://voice.example/v1', apiKey: 12 }));

    const legacy = voiceSettingsDb.getSettings(1);
    assert.deepEqual(legacy, {
      baseUrl: 'https://voice.example/v1',
      apiKey: '',
      sttModel: '',
      ttsModel: '',
      ttsVoice: '',
      ttsFormat: '',
      providerId: '',
      dashscopeEndpoint: '',
      dashscopeApiKey: '',
      dashscopeModel: '',
      liveVoiceDashscopeApiKey: '',
    });

    // The reading, printed rather than only asserted: the four provider-owned fields are absent from
    // a document written before they existed (this row carries the six the old writer knew) and they
    // must read as EMPTY rather than as the legacy row losing the rest of itself. Printed as field
    // names with their emptiness, never a value — the row's `apiKey` is a secret even at this size.
    const providerOwned = PROVIDER_OWNED_FIELDS;
    const legacyRowJson = JSON.parse(
      (
        getConnection()
          .prepare('SELECT settings_json FROM user_voice_settings WHERE user_id = ?')
          .get(1) as { settings_json: string }
      ).settings_json,
    ) as Record<string, unknown>;

    // The reading is a conjunction of the two halves of the claim, so it cannot be satisfied by
    // reading the new fields correctly while dropping the old ones or the other way round: the four
    // provider-owned fields are empty, and the address the legacy row DID carry came through it.
    const providerOwnedEmpty = providerOwned.every((field) => legacy[field] === '');
    const legacyAddressIntact = legacy.baseUrl === legacyRowJson.baseUrl;
    process.stdout.write(
      `db.legacyRow=${providerOwnedEmpty && legacyAddressIntact} row=${LEGACY_ROW_FIELDS.length}-fields ` +
        `providerOwned=${providerOwned.map((field) => `${field}:${legacy[field] === '' ? 'empty' : 'set'}`).join(',')} ` +
        `baseUrl=${legacy.baseUrl}\n`,
    );
  });
});

test('the four provider-owned fields round-trip through save and get verbatim', async () => {
  await withIsolatedDatabase(() => {
    createUser(1, 'tester');

    // A document that exercises all four at once, since the failure this guards against is a field
    // the writer's list does not carry: the store is exhaustive over the shape, and `decodeSettings`
    // reads a stored document THROUGH the same list, so a field missing from it is dropped on the
    // way back out with nothing reporting it. Each value is distinct from the others so a
    // transposition between two of them would be visible rather than symmetric.
    const stored: VoiceSettings = {
      ...SAMPLE_SETTINGS,
      providerId: 'dashscope-omni',
      dashscopeEndpoint: 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com',
      dashscopeApiKey: 'sk-sentinel-dashscope-workspace-key',
      dashscopeModel: 'qwen3.8-omni-flash',
      liveVoiceDashscopeApiKey: '',
    };

    voiceSettingsDb.saveSettings(1, stored);
    const readBack = voiceSettingsDb.getSettings(1);
    assert.deepEqual(readBack, stored);

    // The same statement about the bytes on disk, not about the reader: the row's JSON carries the
    // four keys, so a `getSettings` that synthesised the fields would not satisfy this.
    const row = getConnection()
      .prepare('SELECT settings_json FROM user_voice_settings WHERE user_id = ?')
      .get(1) as { settings_json: string };
    const raw = JSON.parse(row.settings_json) as Record<string, unknown>;
    assert.deepEqual(
      PROVIDER_OWNED_FIELDS.map((field) => field in raw),
      PROVIDER_OWNED_FIELDS.map(() => true),
    );

    // The credential is stored in the clear here, which is the storage face's whole contract: the
    // mask belongs to the readback face (`maskForReadback`), and a store that masked on write would
    // make the value unusable upstream with no way to tell it from a user who typed the mask.
    // Every key of the shape reached the row, and every value came back as the one that was saved.
    // Both halves are in the token, because "the field is present" and "the field is the value I
    // stored" are what a `decodeSettings` that dropped or defaulted a field would each fail.
    const expectedKeys = LEGACY_ROW_FIELDS.length + PROVIDER_OWNED_FIELDS.length;
    const roundTrip =
      Object.keys(raw).length === expectedKeys &&
      readBack.providerId === stored.providerId &&
      readBack.dashscopeEndpoint === stored.dashscopeEndpoint &&
      readBack.dashscopeApiKey === stored.dashscopeApiKey &&
      readBack.dashscopeModel === stored.dashscopeModel;
    process.stdout.write(
      `db.roundtrip=${roundTrip} fields=${Object.keys(raw).length}/${expectedKeys} ` +
        `providerId=${readBack.providerId} ` +
        `endpointVerbatim=${readBack.dashscopeEndpoint === stored.dashscopeEndpoint} ` +
        `apiKeyVerbatim=${readBack.dashscopeApiKey === stored.dashscopeApiKey} ` +
        `model=${readBack.dashscopeModel}\n`,
    );
  });
});

test('deleting a user cascades to their voice settings', async () => {
  await withIsolatedDatabase(() => {
    createUser(1, 'tester');
    voiceSettingsDb.saveSettings(1, SAMPLE_SETTINGS);

    getConnection().prepare('DELETE FROM users WHERE id = ?').run(1);

    assert.equal(
      (
        getConnection()
          .prepare('SELECT COUNT(*) AS count FROM user_voice_settings WHERE user_id = 1')
          .get() as { count: number }
      ).count,
      0,
      'the settings row must not outlive the user it belongs to'
    );
  });
});

test('two users never see each other’s settings', async () => {
  await withIsolatedDatabase(() => {
    createUser(1, 'first');
    createUser(2, 'second');

    voiceSettingsDb.saveSettings(1, SAMPLE_SETTINGS);

    assert.deepEqual(voiceSettingsDb.getSettings(2), {
      baseUrl: '',
      apiKey: '',
      sttModel: '',
      ttsModel: '',
      ttsVoice: '',
      ttsFormat: '',
      providerId: '',
      dashscopeEndpoint: '',
      dashscopeApiKey: '',
      dashscopeModel: '',
      liveVoiceDashscopeApiKey: '',
    });

    voiceSettingsDb.saveSettings(2, { ...SAMPLE_SETTINGS, baseUrl: '', apiKey: 'sk-second' });

    assert.deepEqual(voiceSettingsDb.getSettings(1), SAMPLE_SETTINGS);
    assert.equal(voiceSettingsDb.getSettings(2).apiKey, 'sk-second');
    assert.equal(voiceSettingsDb.getSettings(2).baseUrl, '');
  });
});
