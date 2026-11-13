import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  isSelfAssignedSessionName,
  projectsDb,
  runMigrations,
  sessionsDb,
  stripSelfAssignedSuffix,
} from '@/modules/database/index.js';
import type { SessionNameSource } from '@/modules/database/index.js';
// The service reads the registry through the shared port; evaluating the registry
// module is what installs that port (it is no longer a static dependency of the service).
import '@/modules/providers/provider.registry.js';
import { readCliSessionRegistration } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

/**
 * Who owns a session's name: a human, Claude Code, or Cloudpit.
 *
 * Cloudpit does not own it. That is the settled design ((a) in the task
 * record): the app no longer hands the CLI a `--name` at all, and the name a
 * session has is the one Claude Code gives it. What remains to guard here is
 * everything an *older* build left behind — the launch address it wrote into
 * transcripts as an `agent-name` + `custom-title` pair — plus the two rungs
 * that must stay above it.
 *
 * Each case is stated as a pair, so a passing run says which answer the row
 * took rather than only that it took one:
 *
 * - an address a previous build injected must not outrank the `ai-title` of
 *   the session it was injected into, with the same fixture minus the
 *   `ai-title` as the positive control, so "the row shows the ai-title" can
 *   never be satisfied by a reader that always reads the ai-title;
 * - a real `agent-name` an agent chose, and a name the user chose, both still
 *   outrank it — without those two, the simplest way to pass the case above
 *   would be to demote every name the CLI writes;
 * - the rank table itself has to keep Cloudpit's own sources below `ai`, or the
 *   ladder above is unreachable through the other door into the same row.
 *
 * The fixtures are real transcript lines in a real temporary Claude home,
 * driven through the real synchronizer against a real temporary sqlite
 * database, for the reason `claude-session-title-mirror.test.ts` gives: a
 * reader can agree with the rule on a minimal object and still disagree on a
 * file, and it is the file that ships.
 */

const PROVIDER_SESSION_ID = 'claude-name-authority-1';
const TITLE = 'Archguard 架构分析';

/** One transcript line as Claude writes it: the id and cwd ride on every entry. */
const transcriptLine = (sessionId: string, cwd: string, event: Record<string, unknown>): string =>
  JSON.stringify({ sessionId, cwd, ...event });

/** The bookkeeping entries the CLI opens a transcript with, then the first prompt. */
const headLines = (sessionId: string, cwd: string, firstPrompt = 'first prompt'): string[] => [
  transcriptLine(sessionId, cwd, { type: 'mode', mode: 'normal' }),
  transcriptLine(sessionId, cwd, { type: 'permission-mode', permissionMode: 'default' }),
  transcriptLine(sessionId, cwd, {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: firstPrompt },
    uuid: 'msg-1',
    timestamp: '2026-07-10T00:00:00.000Z',
  }),
];

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-name-authority-db-'));

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

/** A temporary Claude home plus the workspace one transcript lives in. */
async function withClaudeHome(
  runTest: (context: { claudeHome: string; workspacePath: string; transcriptPath: string }) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-name-authority-home-'));
  const workspacePath = path.join(temporaryRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const claudeHome = path.join(temporaryRoot, '.claude');
  await mkdir(claudeHome, { recursive: true });
  // Empty, so the only naming source in play is the transcript under test.
  await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');
  const restoreHomeDir = patchHomeDir(temporaryRoot);
  // The SDK resolves a session by scanning this directory, and it reads the env
  // var rather than `os.homedir()`; both have to point at the same temporary
  // home or the two halves of a rename would search different trees.
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;

  try {
    await runTest({
      claudeHome,
      workspacePath,
      transcriptPath: path.join(workspacePath, `${PROVIDER_SESSION_ID}.jsonl`),
    });
  } finally {
    restoreHomeDir();
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Writes a transcript where Claude Code itself would look for one.
 *
 * `~/.claude/projects/<the working directory with its slashes replaced by
 * dashes>/<session id>.jsonl` — the same layout the CLI keeps, because the SDK's
 * session lookup is what has to find it for a rename to be accepted at all.
 * The body is written verbatim, so a case can hand in a transcript with a prompt
 * in it, and a case can hand in `null` for the empty file the CLI refuses to
 * rename.
 */
async function writeTranscriptFor(
  claudeHome: string,
  projectPath: string,
  providerSessionId: string,
  body: string | null,
): Promise<string> {
  const bucket = path.join(claudeHome, 'projects', projectPath.replace(/\//g, '-'));
  await mkdir(bucket, { recursive: true });
  const transcriptPath = path.join(bucket, `${providerSessionId}.jsonl`);
  await writeFile(
    transcriptPath,
    body ??
      `${JSON.stringify({
        sessionId: providerSessionId,
        cwd: projectPath,
        type: 'user',
        message: { role: 'user', content: 'first prompt' },
        uuid: 'msg-1',
        timestamp: '2026-07-10T00:00:00.000Z',
      })}\n`,
    'utf8',
  );
  return transcriptPath;
}

/**
 * Registers the session the app is about to hand a transcript to, and answers
 * the id the app minted for it.
 *
 * That id is the anchor the address discriminator is built on — an injected
 * address ends in its first six characters — so every fixture below has to be
 * built from the id the row actually got rather than from a constant.
 */
const registerAppSession = (
  workspacePath: string,
  name?: string,
  nameSource?: SessionNameSource,
  providerSessionId = PROVIDER_SESSION_ID,
): string => {
  sessionsDb.createSession(
    providerSessionId,
    'claude',
    workspacePath,
    name,
    undefined,
    undefined,
    null,
    nameSource ?? 'derived',
  );
  const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
  assert.ok(row, 'the session the fixture registers must be readable back');
  return row.session_id;
};

/** The name the app would display for the session, and where it came from. */
const storedName = (): { name: string | null; source: string | null } =>
  storedNameOf(PROVIDER_SESSION_ID);

const storedNameOf = (providerSessionId: string): { name: string | null; source: string | null } => {
  const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
  return { name: row?.custom_name ?? null, source: row?.name_source ?? null };
};

/** The address an older build handed this session's CLI as `--name`. */
const injectedAddress = (appSessionId: string): string =>
  `archguard-架构分析-${appSessionId.slice(0, 6)}`;

// ---------------------------------------------------------------------------
// AC1: the ai-title outranks the address an older build injected
// ---------------------------------------------------------------------------

test('an injected address does not outrank the ai-title of the session it was injected into', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      const appSessionId = registerAppSession(workspacePath);
      const address = injectedAddress(appSessionId);

      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          // A `--name` was written back as a *pair*: the session's `agent-name`
          // and its `custom-title`, byte-identical (2748 of the 2749 corpus
          // transcripts carrying an `agent-name` carry a matching
          // `custom-title`). Both halves are in the fixture because either one
          // can carry the address onto a rung of its own.
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'agent-name', agentName: address }),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'custom-title', customTitle: address }),
          // A real title the session earned, which must win.
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: TITLE, source: 'ai' });
    });
  });
});

test('with no ai-title the same fixture falls to the address, below every earned name', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      const appSessionId = registerAppSession(workspacePath);
      const address = injectedAddress(appSessionId);

      // The positive control for the case above: same fixture, no `ai-title`.
      // The reading has to move, or the first case was passing for a reason that
      // has nothing to do with the ladder.
      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'agent-name', agentName: address }),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'custom-title', customTitle: address }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: address, source: 'self-assigned' });
    });
  });
});

test('a custom-title carrying the address does not reach the manual rung on its own', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      const appSessionId = registerAppSession(workspacePath);
      const address = injectedAddress(appSessionId);

      // The `custom-title` half alone — a transcript whose `agent-name` was
      // never written, or a row re-synced by a build that routed only the
      // `agent-name` branch. `manual` outranks `ai`, so an address reaching
      // that rung would outrank the title anyway and the first case above would
      // be passing on a transcript that no longer resembles a real one.
      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'custom-title', customTitle: address }),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: TITLE, source: 'ai' });
    });
  });
});

test('an agent-name a real agent chose is still the top rung', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      registerAppSession(workspacePath);

      // The guard on the rule above: an `agent-name` that is not an address this
      // app minted must keep the rank it has always had. Without this the
      // simplest way to pass the cases above would be to drop the `agent` rung
      // altogether.
      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, {
            type: 'agent-name',
            agentName: 'The Agent That Owns This',
          }),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: 'The Agent That Owns This', source: 'agent' });
    });
  });
});

test('a custom-title that is not an address keeps the manual rung', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      registerAppSession(workspacePath);

      // The control for the case above: a `custom-title` written by a real
      // rename — the app's, or the CLI's own `/rename` — is a name a human
      // chose, and it must still outrank the `ai-title`. Routing *every*
      // `custom-title` off the `manual` rung would pass the address case by
      // breaking this one.
      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, {
            type: 'custom-title',
            customTitle: 'Restart Web Server',
          }),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: 'Restart Web Server', source: 'manual' });
    });
  });
});

test('a name the user chose outranks both an agent-name and an ai-title', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      registerAppSession(workspacePath, 'Restart Web Server', 'manual');

      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, {
            type: 'agent-name',
            agentName: 'The Agent That Owns This',
          }),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: 'Restart Web Server', source: 'manual' });
    });
  });
});

// ---------------------------------------------------------------------------
// AC4: a rename belongs to Claude Code, and this app's copy is its cache
// ---------------------------------------------------------------------------

/** The name Claude Code's *own* interface reports for a session. */
async function claudeCodeTitle(providerSessionId: string, projectPath: string): Promise<string | null> {
  const info = await getSessionInfo(providerSessionId, { dir: projectPath });
  return typeof info?.summary === 'string' ? info.summary : null;
}

const MANUAL_NAME = 'Restart Web Server';
const RENAME_UUID = '11111111-2222-4333-8444-555555555555';
const EMPTY_TRANSCRIPT_UUID = '99999999-8888-4777-8666-555555555555';

test('a rename lands in Claude Code, and the app stores the name Claude Code reports', async () => {
  await withClaudeHome(async ({ claudeHome, workspacePath }) => {
    await withIsolatedDatabase(async () => {
      const transcriptPath = await writeTranscriptFor(claudeHome, workspacePath, RENAME_UUID, null);
      const appSessionId = sessionsDb.createSession(
        RENAME_UUID,
        'claude',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath,
      );

      const renamed = await sessionsService.renameSessionById(appSessionId, MANUAL_NAME);

      // Both halves of the cache rule, read from the two sides that have to
      // agree: Claude Code's own interface, and this app's row.
      assert.strictEqual(
        await claudeCodeTitle(RENAME_UUID, workspacePath),
        MANUAL_NAME,
        'Claude Code itself must report the new name',
      );
      assert.deepEqual(storedNameOf(RENAME_UUID), { name: MANUAL_NAME, source: 'manual' });
      assert.strictEqual(renamed.summary, MANUAL_NAME);
    });
  });
});

test('a rename Claude Code refuses is not stored at all', async () => {
  await withClaudeHome(async ({ claudeHome, workspacePath }) => {
    await withIsolatedDatabase(async () => {
      // A transcript the CLI will not rename: the file is there, so the "is
      // there anything to write to" skip does not apply, and the SDK looks the
      // session up the way a real rename does — then refuses. This is the arm
      // the cache rule is graded on: a build that stores first and swallows the
      // refusal leaves the app showing a name Claude Code never accepted, and
      // no later scan can bring the two back together.
      const transcriptPath = await writeTranscriptFor(claudeHome, workspacePath, EMPTY_TRANSCRIPT_UUID, '');
      const appSessionId = sessionsDb.createSession(
        EMPTY_TRANSCRIPT_UUID,
        'claude',
        workspacePath,
        'first prompt',
        undefined,
        undefined,
        transcriptPath,
      );

      await assert.rejects(
        sessionsService.renameSessionById(appSessionId, MANUAL_NAME),
        'a refused rename must fail the request',
      );

      assert.deepEqual(storedNameOf(EMPTY_TRANSCRIPT_UUID), { name: 'first prompt', source: 'derived' });
      assert.notStrictEqual(
        await claudeCodeTitle(EMPTY_TRANSCRIPT_UUID, workspacePath),
        MANUAL_NAME,
        'the refused name must not have reached Claude Code either',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// AC7: the migration re-files polluted rows, and running it twice is a no-op
// ---------------------------------------------------------------------------

test('the migration re-files rows named after an address, and its second run is a no-op', async () => {
  await withClaudeHome(async ({ workspacePath }) => {
    await withIsolatedDatabase(async () => {
      // Two polluted rows of the kind an older build left behind: the address
      // accumulated twice, filed on the top rung. One session still has an
      // ai-title in its transcript; the other never had one.
      const withTitle = 'aaaaaaaa-1111-4222-8333-444455556666';
      const withoutTitle = 'bbbbbbbb-1111-4222-8333-444455556666';
      const titledTranscript = path.join(workspacePath, `${withTitle}.jsonl`);
      const untitledTranscript = path.join(workspacePath, `${withoutTitle}.jsonl`);

      await writeFile(
        titledTranscript,
        [
          ...headLines('titled', workspacePath),
          transcriptLine('titled', workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(untitledTranscript, `${headLines('untitled', workspacePath).join('\n')}\n`, 'utf8');

      // `sessions` carries a foreign key onto `projects`, so the workspace the
      // rows point at has to exist before the rows do.
      projectsDb.createProjectPath(workspacePath);

      const insert = getConnection().prepare(
        `INSERT INTO sessions (session_id, provider, project_path, transcript_name, transcript_name_source, jsonl_path, lifecycle_mode)
         VALUES (@sessionId, 'claude', @projectPath, @name, 'agent', @jsonlPath, 'per-run')`
      );
      insert.run({
        sessionId: withTitle,
        projectPath: workspacePath,
        name: `archguard-架构分析-aaaaaa-aaaaaa`,
        jsonlPath: titledTranscript,
      });
      insert.run({
        sessionId: withoutTitle,
        projectPath: workspacePath,
        name: `hello-there-bbbbbb-bbbbbb`,
        jsonlPath: untitledTranscript,
      });

      runMigrations(getConnection());

      const read = (sessionId: string) => {
        const row = getConnection()
          .prepare(`SELECT transcript_name AS name, transcript_name_source AS source FROM sessions WHERE session_id = ?`)
          .get(sessionId) as { name: string; source: string };
        return row;
      };

      // The title the transcript still carries is what the session was called;
      // the address is peeled back off, so it cannot seed the next launch.
      assert.deepEqual(read(withTitle), { name: 'archguard-架构分析', source: 'ai' });
      // No title to fall back on, so it belongs where an inferred name belongs.
      assert.deepEqual(read(withoutTitle), { name: 'hello-there', source: 'derived' });

      // Second run: every row has left the `agent`-plus-address combination the
      // predicate selects on, so this must change nothing at all.
      runMigrations(getConnection());

      assert.deepEqual(read(withTitle), { name: 'archguard-架构分析', source: 'ai' });
      assert.deepEqual(read(withoutTitle), { name: 'hello-there', source: 'derived' });
    });
  });
});

// ---------------------------------------------------------------------------
// AC9: the placeholder a session opens with is a stopgap, and never an address
// ---------------------------------------------------------------------------

/**
 * The app's own placeholder rule, restated: the first four words of the first
 * message. `sessionsService.createAppSession` is what applies it, so the
 * fixtures below go through that call rather than writing the string in
 * themselves — a placeholder the test invented could agree with a rule the app
 * no longer follows.
 */
const PLACEHOLDER_MESSAGE = 'count the typescript files under the server directory';
const PLACEHOLDER = 'count the typescript files';
const SECOND_PLACEHOLDER_MESSAGE = 'summarise the failing integration';
const SECOND_PLACEHOLDER = 'summarise the failing integration';
const PLACEHOLDER_PROVIDER_ID = 'claude-name-authority-placeholder-1';
const SECOND_PLACEHOLDER_PROVIDER_ID = 'claude-name-authority-placeholder-2';

/** The name the app displays for one of its own rows, and where that came from. */
const displayNameOf = (appSessionId: string): { name: string | null; source: string | null } => {
  const row = sessionsDb.getSessionById(appSessionId);
  return { name: row?.custom_name ?? null, source: row?.name_source ?? null };
};

test('a session opens on the app placeholder and gives it up to the title Claude Code writes', async () => {
  await withClaudeHome(async ({ workspacePath }) => {
    await withIsolatedDatabase(async () => {
      // The path a brand-new chat takes: the row is minted before any provider
      // run, carrying the app's guess at the name, and the provider's own
      // conversation id is attached when the runtime announces it.
      const created = sessionsService.createAppSession('claude', workspacePath, PLACEHOLDER_MESSAGE);
      assert.deepEqual(
        displayNameOf(created.sessionId),
        { name: PLACEHOLDER, source: 'derived' },
        'the placeholder must be the name a session opens with, and filed as a reading',
      );

      const transcriptPath = path.join(workspacePath, `${PLACEHOLDER_PROVIDER_ID}.jsonl`);
      await writeFile(
        transcriptPath,
        [
          ...headLines(PLACEHOLDER_PROVIDER_ID, workspacePath, PLACEHOLDER_MESSAGE),
          transcriptLine(PLACEHOLDER_PROVIDER_ID, workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );
      sessionsDb.assignProviderSessionId(created.sessionId, PLACEHOLDER_PROVIDER_ID);

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      // The stopgap's whole job: it is what the session is called until Claude
      // Code names it, and not one scan longer.
      assert.deepEqual(displayNameOf(created.sessionId), { name: TITLE, source: 'ai' });
    });
  });
});

test('a session Claude Code never titles keeps the placeholder rather than losing its name', async () => {
  await withClaudeHome(async ({ workspacePath }) => {
    await withIsolatedDatabase(async () => {
      const created = sessionsService.createAppSession('claude', workspacePath, SECOND_PLACEHOLDER_MESSAGE);
      assert.deepEqual(displayNameOf(created.sessionId), {
        name: SECOND_PLACEHOLDER,
        source: 'derived',
      });

      // A transcript the CLI has opened and nothing more: no title, and no
      // prompt yet either — the window in which the placeholder is the only
      // name the session has.
      const transcriptPath = path.join(workspacePath, `${SECOND_PLACEHOLDER_PROVIDER_ID}.jsonl`);
      await writeFile(
        transcriptPath,
        `${headLines(SECOND_PLACEHOLDER_PROVIDER_ID, workspacePath).slice(0, 2).join('\n')}\n`,
        'utf8',
      );
      sessionsDb.assignProviderSessionId(created.sessionId, SECOND_PLACEHOLDER_PROVIDER_ID);

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      // "Replaced" must not have been implemented as "cleared": a transcript
      // that names its session nowhere is not evidence that the name it had is
      // gone, so the placeholder survives the scan verbatim.
      assert.deepEqual(displayNameOf(created.sessionId), {
        name: SECOND_PLACEHOLDER,
        source: 'derived',
      });
    });
  });
});

test('a placeholder filed in the override column still gives way to the title', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      // The shape a pre-split build left behind: the placeholder sits in the
      // override column, which the reader takes ahead of every rung — a rung
      // above `ai` in everything but name. The title has to clear it, or the
      // stopgap becomes permanent and the session is stuck on the app's guess
      // for as long as it exists. (The control that keeps this clearing honest
      // is the case above it: a name the user chose lives in the same column,
      // and the same scan has to leave that one alone.)
      registerAppSession(workspacePath, PLACEHOLDER, 'derived');
      assert.deepEqual(storedName(), { name: PLACEHOLDER, source: 'derived' });

      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: TITLE, source: 'ai' });
    });
  });
});

test('peeling the address stops at this session, so a six-hex-letter word survives', () => {
  const appSessionId = 'aaaaaaaa-1111-2222-3333-444455556666';
  assert.strictEqual(
    stripSelfAssignedSuffix('archguard-架构分析-aaaaaa-aaaaaa', appSessionId),
    'archguard-架构分析',
  );
  // `facade` is six hex-looking letters, so a shape-only peel would eat it and
  // leave two different sessions named alike.
  assert.strictEqual(stripSelfAssignedSuffix('Fix the facade', appSessionId), 'Fix the facade');
});

// ---------------------------------------------------------------------------
// The discriminator the whole guard rests on
// ---------------------------------------------------------------------------

test('the discriminator is anchored on the session it is asked about', () => {
  const appSessionId = 'edb5ead0-1111-2222-8333-444455556666';
  assert.strictEqual(isSelfAssignedSessionName('archguard-架构分析-edb5ea', appSessionId), true);
  assert.strictEqual(isSelfAssignedSessionName('archguard-架构分析-edb5ea-edb5ea', appSessionId), true);
  // An agent's own name, which happens to be six hex-looking letters but not
  // this session's id.
  assert.strictEqual(isSelfAssignedSessionName('Fix the facade', appSessionId), false);
  assert.strictEqual(isSelfAssignedSessionName('The Agent That Owns This', appSessionId), false);
});

test('the rank table keeps every Cloudpit-made source below a real title', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'claude-name-authority-rank-'));
    projectsDb.createProjectPath(projectPath);
    try {
      // The two doors into one row: an upsert whose incoming source outranks
      // the stored one replaces the name, and one that does not leaves it. The
      // `ai` → `self-assigned` direction is the guard; the reverse is its
      // control, so a passing pair cannot come from a writer that never
      // replaces anything.
      sessionsDb.createSession('rank-write', 'claude', projectPath, TITLE, undefined, undefined, null, 'ai');
      sessionsDb.createSession('rank-write', 'claude', projectPath, 'archguard-架构分析-aaaaaa', undefined, undefined, null, 'self-assigned');
      const kept = sessionsDb.getSessionByProviderSessionId('rank-write');
      assert.deepEqual(
        { name: kept?.custom_name ?? null, source: kept?.name_source ?? null },
        { name: TITLE, source: 'ai' },
        'a self-assigned name must not displace an ai-title',
      );

      sessionsDb.createSession('rank-control', 'claude', projectPath, 'archguard-架构分析-bbbbbb', undefined, undefined, null, 'self-assigned');
      sessionsDb.createSession('rank-control', 'claude', projectPath, TITLE, undefined, undefined, null, 'ai');
      const replaced = sessionsDb.getSessionByProviderSessionId('rank-control');
      assert.deepEqual(
        { name: replaced?.custom_name ?? null, source: replaced?.name_source ?? null },
        { name: TITLE, source: 'ai' },
        'an ai-title must displace a self-assigned name',
      );

      // The placeholder's own rung, through the same pair of doors. It is the
      // name the app makes up for a session that has none yet, so it sits by
      // definition below a name the session earned — the guard and its control
      // are here as well as above because "below `ai`" is a claim about this
      // rung specifically, and a table that put the placeholder on top would
      // pass the self-assigned pair unchanged.
      sessionsDb.createSession('rank-placeholder', 'claude', projectPath, TITLE, undefined, undefined, null, 'ai');
      sessionsDb.createSession('rank-placeholder', 'claude', projectPath, PLACEHOLDER, undefined, undefined, null, 'derived');
      const keptFromPlaceholder = sessionsDb.getSessionByProviderSessionId('rank-placeholder');
      assert.deepEqual(
        { name: keptFromPlaceholder?.custom_name ?? null, source: keptFromPlaceholder?.name_source ?? null },
        { name: TITLE, source: 'ai' },
        'the placeholder must not displace an ai-title',
      );

      sessionsDb.createSession('rank-placeholder-control', 'claude', projectPath, PLACEHOLDER, undefined, undefined, null, 'derived');
      sessionsDb.createSession('rank-placeholder-control', 'claude', projectPath, TITLE, undefined, undefined, null, 'ai');
      const replacedPlaceholder = sessionsDb.getSessionByProviderSessionId('rank-placeholder-control');
      assert.deepEqual(
        { name: replacedPlaceholder?.custom_name ?? null, source: replacedPlaceholder?.name_source ?? null },
        { name: TITLE, source: 'ai' },
        'an ai-title must displace the placeholder',
      );
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The read the resident host does instead of computing an address
// ---------------------------------------------------------------------------

test('the CLI registration is read back by pid, and only for the session it names', async () => {
  await withClaudeHome(async ({ claudeHome }) => {
    const sessionsDirectory = path.join(claudeHome, 'sessions');
    await mkdir(sessionsDirectory, { recursive: true });
    await writeFile(
      path.join(sessionsDirectory, '4242.json'),
      JSON.stringify({
        pid: 4242,
        sessionId: 'cli-session-1',
        name: 'claudecodeui-74',
        nameSource: 'derived',
        messagingSocketPath: '/tmp/cli-4242.sock',
      }),
      'utf8',
    );

    assert.deepEqual(readCliSessionRegistration(claudeHome, 4242), {
      pid: 4242,
      sessionId: 'cli-session-1',
      name: 'claudecodeui-74',
      nameSource: 'derived',
      messagingSocketPath: '/tmp/cli-4242.sock',
    });

    // A pid the CLI has no registration for, and a registration that belongs to
    // a *different* session than the one being asked about, are both "no
    // answer" — never a name borrowed from the wrong process.
    assert.strictEqual(readCliSessionRegistration(claudeHome, 4243), null);
    assert.strictEqual(readCliSessionRegistration(claudeHome, 4242, 'cli-session-2'), null);
    assert.strictEqual(
      readCliSessionRegistration(claudeHome, 4242, 'cli-session-1')?.nameSource,
      'derived',
    );
  });
});
