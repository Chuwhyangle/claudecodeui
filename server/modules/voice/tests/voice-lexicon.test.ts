import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import type {
  VoiceHumanMessage,
  VoiceService,
  VoiceSettingsService,
  VoiceIdentifierStore,
} from '@/shared/types.js';

/**
 * The U-source lexicon: the identifier-shaped tokens the user has sent, the two
 * paths that fill it, and the HTTP surface that reads it back.
 *
 * The shape half is checked against the Python reference
 * (`experiments/voice-index-loop/sim/extract.py`) with the same known-answer
 * table, because the vocabulary this index feeds is only comparable to the
 * experiment's if the two agree on what an identifier is. The import half is
 * checked against a CONSTRUCTED message set — injected prompts, a credential,
 * a paste block, a code fence, a URL, a UUID, a hash — because the property that
 * matters is what is ABSENT from the store, and absence is only checkable when
 * the input is.
 */

const {
  closeConnection,
  getConnection,
  initializeDatabase,
  voiceUserIdentifiersDb,
} = await import('@/modules/database/index.js');
const { createVoiceLexiconService, extractIdentifiers, extractSentIdentifiers } = await import(
  '@/modules/voice/voice-lexicon.js'
);
const { createVoiceRouter } = await import('@/modules/voice/voice.routes.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The known-answer table, mirrored from the Python reference's own cases.
 *
 * Each row is a WHOLE input, not a bare token: `extractIdentifiers` is the
 * reference's `ids` — clean, then tokenize, then `is_id` — and the rows marked
 * not-identifier for a URL, a UUID and a hash are false because CLEANING removes
 * them, not because the shape rule rejects them (the reference's `is_id` alone
 * would call a UUID identifier-like, since it carries `-`). Testing the pipeline
 * is what makes this table the reference's behaviour rather than a description
 * of one of its stages.
 *
 * A passing row is `[input]` and a failing row is `[]`, so a rule that started
 * emitting a fragment of a false row would fail the equality rather than slide
 * past an `includes` check.
 */
const SHAPE_TABLE: Array<[string, boolean]> = [
  ['needs-human', true],
  ['AC-103', true],
  ['CLOUDPIT-CLI', true],
  ['GOAL-013', true],
  ['provider_models', true],
  ['MCP', true],
  ['snake_case', true],
  ['a1', true],
  ['server.ts', false],
  ['README.md', false],
  ['a/b', false],
  ['plain', false],
  ['mcp', false],
  ['HTTPServer', false],
  ['x', false],
  ['https://x.y', false],
  ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', false],
  ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', false],
];

/**
 * A token the credential-style message carries and the index must never hold.
 *
 * Distinct from the sentence sentinel below, because the two are refused by
 * different rules — this one by the credential screen over the whole message,
 * that one by the shape rule over the token — and a failure has to name which.
 */
const CREDENTIAL_SENTINEL = 'sk-sentinel-credential-abc';

/**
 * A word that appears in a human message and is NOT identifier-shaped.
 *
 * Plain lowercase, no camel boundary, no `_`/`-`, no digit, not all-caps: the
 * shape rule drops it, so its absence from the store is the claim that no
 * sentence fragment survives. It is grep-able by construction — the point is to
 * look for exactly this string in an export of the table and find nothing.
 */
const SENTENCE_SENTINEL = 'zebraquokka';

/**
 * A JWT: the credential the reference's `SECRET` screen provably cannot see,
 * because it keys on the words AROUND a credential and this message is the
 * credential alone.
 *
 * It was not invented for the test — a real-data import on this machine put two
 * live JWTs in the table, from sessions whose whole user message was the token.
 * The token-level blob screen exists because of that finding, so this is its
 * regression: the string is identifier-shaped (three dot-separated base64url
 * runs, digits included) and must nevertheless contribute nothing.
 */
const JWT_SENTINEL =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInVzZXJuYW1lIjoiY3JpdGVyaW9uIiwiaWF0IjoxNzAwMDAwMDAwfQ.abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * The constructed history an import is run against.
 *
 * Deliberately includes one id TWICE with different bodies: a message the
 * history reader hands back more than once (a rerun of the same session, a
 * re-read of one transcript) must be counted once, and the two bodies differ so
 * a dedup that kept the wrong one would be visible.
 *
 * Every message is a human one unless its comment says otherwise; the injected
 * and credential messages are the ones the pipeline must refuse whole. The
 * project keys differ between m3 and the rest so the listing's cross-project
 * summing is exercised rather than assumed.
 */
const HISTORY_FIXTURE: VoiceHumanMessage[] = [
  { id: 'm1', projectKey: '/proj/a', text: 'Please fix needs-human and CLOUDPIT-CLI wiring, zebraquokka' },
  { id: 'm2', projectKey: '/proj/a', text: 'needs-human again: AC-103 blocked. zebraquokka' },
  // The same id a second time, with a body that would change the counts if it were counted.
  { id: 'm2', projectKey: '/proj/a', text: 'needs-human needs-human MCP in server.ts' },
  { id: 'm3', projectKey: '/proj/b', text: 'provider_models in server.ts and MCP' },
  // An injected prompt: the driver's own continuation banner, not the person's words.
  {
    id: 'm4',
    projectKey: '/proj/a',
    text: 'This session is being continued from a previous conversation that ran out of context. GOAL-777',
  },
  // A task notification: also injected, and also carries an identifier-shaped run.
  { id: 'm5', projectKey: '/proj/a', text: '<task-notification>task gap-123 is ready</task-notification>' },
  // Credential-style: refused WHOLE, so the token it contains never lands.
  { id: 'm6', projectKey: '/proj/a', text: `export VOICE_API_KEY=${CREDENTIAL_SENTINEL} now` },
  // A paste block: its contents are stripped before tokenizing.
  {
    id: 'm7',
    projectKey: '/proj/a',
    text: 'look <pasted_content source="editor">PASTED_SENTINEL_TOKEN</pasted_content> done zebraquokka',
  },
  // A fenced code block: likewise stripped.
  { id: 'm8', projectKey: '/proj/a', text: 'run this:\n```\nCODE_FENCE_SENTINEL = 1\n```\nthanks' },
  // A URL, a UUID and a hash: all removed by the cleaning pass.
  {
    id: 'm9',
    projectKey: '/proj/a',
    text: 'visit https://example.com/Path-Segment and read 3f2504e0-4f89-11d3-9a0c-0305e82c3301 then deadbeefdeadbeefdeadbeefdeadbeefdeadbeef ok',
  },
  // A bare JWT: no credential WORD for the reference's screen to key on, so the
  // token-level blob screen is the only thing that can refuse it.
  { id: 'm10', projectKey: '/proj/a', text: JWT_SENTINEL },
];

/** The store's rows once `HISTORY_FIXTURE` has been imported, most frequent first. */
const EXPECTED_LIST = [
  { token: 'needs-human', count: 2 },
  { token: 'AC-103', count: 1 },
  { token: 'CLOUDPIT-CLI', count: 1 },
  { token: 'MCP', count: 1 },
  { token: 'provider_models', count: 1 },
];

/** The three messages of the fixture that contribute at least one token. */
const EXPECTED_IMPORTED_MESSAGES = 3;

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'voice-lexicon-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

function createService(history: VoiceHumanMessage[]) {
  return createVoiceLexiconService({
    store: voiceUserIdentifiersDb,
    listHumanMessages: async () => history,
    clock: () => 1_700_000_000_000,
  });
}

function storedTokens(): string[] {
  return (
    getConnection()
      .prepare('SELECT token_lower FROM voice_user_identifiers')
      .all() as { token_lower: string }[]
  ).map((row) => row.token_lower);
}

/**
 * The table as an export, the way `sqlite3 <db> 'select * from …'` would print
 * it.
 *
 * The host has no `sqlite3` binary, so the export is taken through the same
 * connection the store writes to and stringified — which is the same reading of
 * the same bytes, and is what the sentence-sentinel check greps.
 */
function tableExport(): string {
  return JSON.stringify(
    getConnection()
      .prepare('SELECT token_lower, canonical, count, project_key FROM voice_user_identifiers')
      .all(),
  );
}

test('the shape rule agrees with the Python reference on every known answer', () => {
  for (const [input, isIdentifier] of SHAPE_TABLE) {
    assert.deepEqual(
      extractIdentifiers(input),
      isIdentifier ? [input] : [],
      `extractIdentifiers(${JSON.stringify(input)}) must ${isIdentifier ? '' : 'not '}be an identifier`,
    );
  }

  process.stdout.write(
    `lexicon.shapeTable=${SHAPE_TABLE.length} identifiers=${SHAPE_TABLE.filter(([, v]) => v).length}\n`,
  );
});

test('a credential blob is refused by token while the words around it survive', () => {
  // The blob screen is TOKEN-level, not message-level: a message that carries a
  // JWT alongside ordinary identifiers keeps the identifiers. That distinction
  // is the whole reason it lives beside `is_id` rather than in `clean` — putting
  // it in `clean` would strip the token before tokenizing, which is equivalent,
  // but the reference's `SECRET` refuses a credential by refusing the MESSAGE,
  // and conflating the two rules would make a long message lose its words.
  assert.deepEqual(extractSentIdentifiers(JWT_SENTINEL), [], 'a bare JWT is not vocabulary');
  assert.deepEqual(
    extractSentIdentifiers(`deploy CLOUDPIT-CLI ${JWT_SENTINEL} now`),
    ['CLOUDPIT-CLI'],
    'the words a message does contain are unaffected by the blob it also contains',
  );

  // The reference pipeline itself is unchanged: `extractIdentifiers` is the
  // reference's `ids` and still sees the blob, which is what keeps the known-answer
  // table the reference's behaviour rather than a description of a modified one.
  assert.deepEqual(
    extractIdentifiers(JWT_SENTINEL),
    [JWT_SENTINEL],
    'the exported reference pipeline must not carry the addition',
  );

  process.stdout.write('lexicon.blobScreen=token-level\n');
});

test('an import stores only the human identifiers, counting nothing it should refuse', async () => {
  await withIsolatedDatabase(async () => {
    const service = createService(HISTORY_FIXTURE);
    const result = await service.importFromHistory();

    assert.deepEqual(
      result,
      { importedMessages: EXPECTED_IMPORTED_MESSAGES, tokenCount: EXPECTED_LIST.length },
      'the import must report the messages that contributed and the rows it wrote',
    );

    // The positive control: a token the fixture really contains is present with
    // the count the two human messages give it, so an import that stored nothing
    // could not pass the absence assertions below by accident.
    const list = service.list(100);
    assert.deepEqual(
      list.map((row) => ({ token: row.token, count: row.count })),
      EXPECTED_LIST,
      'the listing must be exactly the fixture’s identifiers, most frequent first',
    );
    assert.ok(
      list.every((row) => typeof row.lastSeenAt === 'number'),
      'every row must carry the instant it was last seen',
    );

    // The negative controls, read off the TABLE rather than the listing so a
    // listing-side filter cannot hide a stored token.
    const stored = storedTokens();
    assert.ok(
      !stored.some((token) => token.includes('sentinel') || token.includes(SENTENCE_SENTINEL)),
      `the store must hold none of the refused tokens, got ${stored.join(',')}`,
    );
    assert.ok(
      !stored.some((token) => token.includes('gap-123') || token.includes('goal-777')),
      'an injected prompt must contribute nothing',
    );
    assert.ok(
      !stored.some((token) => token.startsWith('eyj')),
      `a bare JWT must contribute nothing, got ${stored.filter((t) => t.startsWith('eyj')).join(',')}`,
    );

    // The sentence sentinel must not survive anywhere in an export of the table:
    // this is the "no sentence fragments in the database" claim, taken over the
    // same bytes a `sqlite3` export would print.
    const exported = tableExport();
    assert.equal(
      exported.includes(SENTENCE_SENTINEL),
      false,
      'no sentence fragment may reach the database',
    );
    assert.equal(
      exported.includes(CREDENTIAL_SENTINEL),
      false,
      'a credential-style message must leave no trace',
    );

    process.stdout.write(
      `lexicon.import rows=${stored.length} importedMessages=${result.importedMessages} ` +
        `sentenceSentinelAbsent=${!exported.includes(SENTENCE_SENTINEL)} ` +
        `credentialSentinelAbsent=${!exported.includes(CREDENTIAL_SENTINEL)}\n`,
    );
  });
});

test('importing the same history twice leaves every count identical', async () => {
  await withIsolatedDatabase(async () => {
    const service = createService(HISTORY_FIXTURE);

    const first = await service.importFromHistory();
    const afterFirst = service.list(100);
    const rowsAfterFirst = voiceUserIdentifiersDb.countRows();

    const second = await service.importFromHistory();

    assert.deepEqual(second, first, 'a repeat import must report the same figures');
    assert.deepEqual(service.list(100), afterFirst, 'a repeat import must not change a single count');
    assert.equal(
      voiceUserIdentifiersDb.countRows(),
      rowsAfterFirst,
      'a repeat import must not add a row',
    );
    assert.deepEqual(
      afterFirst.map((row) => ({ token: row.token, count: row.count })),
      EXPECTED_LIST,
      'the counts after two imports are the fixture’s counts, not twice them',
    );
  });
});

test('a sent message records only its identifier-shaped tokens', async () => {
  await withIsolatedDatabase(async () => {
    const service = createService([]);

    service.observeSentText('deploy CLOUDPIT-CLI to prod now', '/proj/x');
    // Two plain words and one identifier, so the increment is attributable to
    // the identifier rather than to "the message was long enough".
    service.observeSentText('please check needs-human', '/proj/x');
    // A credential-style message and an injected prompt must each contribute
    // nothing — CLOUDPIT-CLI stays at its one sighting from the first send.
    service.observeSentText(`use ${CREDENTIAL_SENTINEL} here`, '/proj/x');
    service.observeSentText('<system-reminder>CLOUDPIT-CLI</system-reminder>', '/proj/x');
    // A second sighting, to show the count is a frequency and not a flag.
    service.observeSentText('CLOUDPIT-CLI again', '/proj/x');

    assert.deepEqual(
      service.list(100).map((row) => ({ token: row.token, count: row.count })),
      [
        { token: 'CLOUDPIT-CLI', count: 2 },
        { token: 'needs-human', count: 1 },
      ],
      'only the identifiers of the accepted sends may be counted',
    );
  });
});

test('the recording hook is called from exactly one place outside the tests', () => {
  const serverDirectory = path.join(REPO_ROOT, 'server');
  let output = '';
  try {
    // Test files are excluded so this probe does not find its own literal: the
    // claim is about the PRODUCTION call sites, and the criterion's own
    // `grep -v tests` says the same thing.
    output = execFileSync(
      'grep',
      ['-rn', '--include=*.ts', '--exclude=*.test.ts', 'voiceLexicon.observeSentText(', serverDirectory],
      { encoding: 'utf8' },
    );
  } catch (error) {
    // grep exits 1 when nothing matches, which is asserted below rather than
    // thrown: the failure this test reports is "not exactly one", not "grep".
    if ((error as { status?: number }).status !== 1) {
      throw error;
    }
  }

  const callSites = output.split('\n').filter((line) => line.trim() !== '');
  assert.deepEqual(
    callSites.map((line) => path.relative(REPO_ROOT, line.split(':')[0])),
    // The dispatch funnel moved out of the WebSocket transport into its own leaf
    // (`cycle-websocket-services-two-pairs`); the recording hook still has exactly
    // one production call site, now in that leaf.
    ['server/modules/websocket/services/dispatch/chat-run-dispatch.service.ts'],
    `the send hook must have one call site, got:\n${output}`,
  );
});

/**
 * A store backed by a Map, for the route test: the routes are under test, not
 * the SQL, and an in-memory store lets each assertion name the tokens it seeded.
 */
function createMemoryStore(): VoiceIdentifierStore {
  type Row = { canonical: string; count: number; firstSeenAt: number; lastSeenAt: number; projectKey: string };
  const rows = new Map<string, Row>();

  return {
    incrementTokens(entries) {
      for (const entry of entries) {
        const existing = rows.get(entry.tokenLower);
        if (existing) {
          existing.count += 1;
          existing.lastSeenAt = entry.at;
          continue;
        }
        rows.set(entry.tokenLower, {
          canonical: entry.canonical,
          count: 1,
          firstSeenAt: entry.at,
          lastSeenAt: entry.at,
          projectKey: entry.projectKey,
        });
      }
    },
    replaceAll(entries) {
      rows.clear();
      for (const entry of entries) {
        rows.set(entry.tokenLower, {
          canonical: entry.canonical,
          count: entry.count,
          firstSeenAt: entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt,
          projectKey: entry.projectKey,
        });
      }
    },
    listTop(limit) {
      return [...rows.entries()]
        .sort(([aToken, a], [bToken, b]) => b.count - a.count || aToken.localeCompare(bToken))
        .slice(0, limit)
        .map(([, row]) => ({ token: row.canonical, count: row.count, lastSeenAt: row.lastSeenAt }));
    },
    clear() {
      rows.clear();
    },
    countRows() {
      return rows.size;
    },
  };
}

/** The transcription service, throwing: no lexicon route may reach it. */
const unusedVoiceService = {
  getHealth: () => {
    throw new Error('a lexicon route must not consult the transcription service');
  },
  transcribe: async () => {
    throw new Error('a lexicon route must not transcribe');
  },
  synthesizeSpeech: async () => {
    throw new Error('a lexicon route must not synthesize');
  },
  captureRaw: () => {
    throw new Error('a lexicon route must not capture raw audio');
  },
  captureState: () => {
    throw new Error('a lexicon route must not read the capture state');
  },
} as unknown as VoiceService;

const unusedVoiceSettingsService = {
  getSettings: () => {
    throw new Error('a lexicon route must not read voice settings');
  },
  saveSettings: () => {
    throw new Error('a lexicon route must not write voice settings');
  },
  maskForReadback: () => {
    throw new Error('a lexicon route must not mask voice settings');
  },
} as unknown as VoiceSettingsService;

type ServerContext = { baseUrl: string; service: ReturnType<typeof createVoiceLexiconService> };

async function withLexiconServer(run: (context: ServerContext) => Promise<void>): Promise<void> {
  const service = createVoiceLexiconService({
    store: createMemoryStore(),
    listHumanMessages: async () => HISTORY_FIXTURE,
    clock: () => 1_700_000_000_000,
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/voice',
    createVoiceRouter({
      voiceService: unusedVoiceService,
      voiceSettingsService: unusedVoiceSettingsService,
      lexiconService: service,
      parseAudioUpload: (_request, _response, next) => next(),
      parseRawAudioUpload: (_request, _response, next) => next(),
    }),
  );

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    await run({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      service,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('GET /lexicon returns a capped list of tokens with no sentence fields', async () => {
  await withLexiconServer(async ({ baseUrl, service }) => {
    // Six distinct identifiers, one of them seen twice, so the cap and the
    // ordering are both observable: the most frequent must lead and the sixth
    // must be dropped.
    for (const token of ['alpha_one', 'beta_two', 'gamma_three', 'delta_four', 'epsilon_five']) {
      service.observeSentText(`use ${token} here`, '/proj/x');
    }
    service.observeSentText('zeta_six zeta_six', '/proj/x');

    const response = await fetch(`${baseUrl}/api/voice/lexicon?limit=5`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { tokens: Array<Record<string, unknown>> };

    assert.equal(body.tokens.length, 5, 'the limit must bound the listing');
    assert.deepEqual(
      body.tokens.map((row) => [row.token, row.count]),
      [
        ['zeta_six', 2],
        ['alpha_one', 1],
        ['beta_two', 1],
        ['delta_four', 1],
        ['epsilon_five', 1],
      ],
      'the listing must be most frequent first, then by token',
    );
    for (const row of body.tokens) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ['count', 'lastSeenAt', 'token'],
        'a listing row carries no field that could hold text',
      );
    }

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('"text"'), false);
    assert.equal(serialized.includes('"sentence"'), false);
    assert.equal(serialized.includes(SENTENCE_SENTINEL), false);

    // An absent limit falls back to the default rather than refusing: the read
    // is of the caller's own vocabulary, so only trimming it can be asked for.
    const unfiltered = await fetch(`${baseUrl}/api/voice/lexicon`);
    assert.equal(unfiltered.status, 200);
    assert.equal(((await unfiltered.json()) as { tokens: unknown[] }).tokens.length, 6);
  });
});

test('POST /lexicon/import fills the index and DELETE /lexicon empties it', async () => {
  await withLexiconServer(async ({ baseUrl }) => {
    const imported = await fetch(`${baseUrl}/api/voice/lexicon/import`, { method: 'POST' });
    assert.equal(imported.status, 200);
    assert.deepEqual(await imported.json(), {
      importedMessages: EXPECTED_IMPORTED_MESSAGES,
      tokenCount: EXPECTED_LIST.length,
    });

    const afterImport = (await (await fetch(`${baseUrl}/api/voice/lexicon?limit=20`)).json()) as {
      tokens: Array<{ token: string; count: number }>;
    };
    assert.deepEqual(
      afterImport.tokens.map((row) => [row.token, row.count]),
      EXPECTED_LIST.map((row) => [row.token, row.count]),
    );

    // A second import must not double anything: the route is retryable.
    await fetch(`${baseUrl}/api/voice/lexicon/import`, { method: 'POST' });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/voice/lexicon?limit=20`)).json(), afterImport);

    const cleared = await fetch(`${baseUrl}/api/voice/lexicon`, { method: 'DELETE' });
    assert.equal(cleared.status, 204);

    const afterClear = (await (await fetch(`${baseUrl}/api/voice/lexicon?limit=20`)).json()) as {
      tokens: unknown[];
    };
    assert.deepEqual(afterClear.tokens, [], 'DELETE must leave the lexicon empty');
  });
});
