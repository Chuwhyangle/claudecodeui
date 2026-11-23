import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

/**
 * Wire-contract type sync between the browser bundle and the server tree.
 *
 * The two ends do not share types: the server is compiled by its own tsconfig and
 * never reaches the bundle, so several wire shapes are stated twice by hand. The
 * source comments say so explicitly — `noticesController.ts` calls its copy
 * "duplicated rather than imported", `useRecentSessionEndings.ts` says "Mirrors
 * `ResidentTerminalState`", `useMentions.ts` says "Mirrors the server's
 * `SeedMentionHit`" and "Mirrors `ArchitectureMentionEntity`".
 *
 * `replySuggestionsTypeSync.test.ts` covers the same seam for one pair of literal
 * unions. This criterion generalises the reading to the rest of the hand-copied
 * wire: literal unions and object field sets, for notices, architecture refresh,
 * the resident terminal taxonomy, and mention provenance. Each row reads BOTH
 * ends; a member or field added on one side without the other reds the run.
 *
 * The client declaration is located by type name under `src/**` (tests excluded),
 * so moving a type between files does not red this criterion. Server declarations
 * are read from their module paths, which is where each one is authored.
 *
 * The files are read through `process.cwd()`: Vitest serves this module through
 * Vite, where `import.meta.url` is a dev-server URL rather than a `file:` one.
 */

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, 'src');

/** Reads one exported literal union's members out of a source string. */
const readLiteralUnionFromSource = (source: string, typeName: string): string[] => {
  const declaration = new RegExp(
    `export type ${typeName}\\s*(?:<[^>]*>)?\\s*=\\s*([^;]+);`,
  ).exec(source);
  assert.ok(declaration, `${typeName} must be declared as a literal union`);
  const members = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(members.length > 0, `${typeName} must be a non-empty literal union`);
  return [...new Set(members)].sort();
};

/** Returns the body of the first `{ … }` starting at `startIndex`, braces balanced. */
const readBalancedBraces = (source: string, startIndex: number): string => {
  assert.equal(source[startIndex], '{', 'balanced-brace read must start at an opening brace');
  let depth = 0;
  for (let index = startIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex + 1, index);
    }
  }
  throw new Error('unbalanced braces in declaration');
};

/** Reads one exported object type's top-level field names out of a source string. */
const readObjectKeysFromSource = (source: string, typeName: string): string[] => {
  const declaration = new RegExp(
    `export type ${typeName}\\s*(?:<[^>]*>)?\\s*=\\s*\\{`,
  ).exec(source);
  assert.ok(declaration, `${typeName} must be declared as an object type`);
  const body = readBalancedBraces(source, declaration.index + declaration[0].length - 1);
  const keys: string[] = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    // Only top-level members count: a nested object literal's own fields are not
    // fields of this wire shape.
    if (depth === 0) {
      const member = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:/.exec(line);
      if (member) keys.push(member[2] ? `${member[1]}?` : member[1]);
    }
    for (const char of line) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
  }
  assert.ok(keys.length > 0, `${typeName} must be a non-empty object type`);
  return [...new Set(keys)].sort();
};

// A directory path means "the whole split types vocabulary": `server/shared/types.ts` is a
// re-export barrel since gap-routine-architecture-analysis-server-shared-god-package, and the
// hand-copied wire shapes are authored under `server/shared/types/`. Concatenating every
// non-test file there keeps the server end of each row readable wherever it was placed.
const readFile = (file: string): string => {
  if (!statSync(file).isDirectory()) return readFileSync(file, 'utf8');
  return readdirSync(file)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .sort()
    .map((entry) => readFileSync(path.join(file, entry), 'utf8'))
    .join('\n');
};

/**
 * Runs `read` and reports `null` when the path vanished between the directory listing and the
 * read. Vitest runs test files in parallel workers, and `voiceErrorNoticePersistence.test.tsx`
 * writes `__mutation-*` copies beside the shipped composer and removes them at the end of its
 * file — so an entry this walk just listed can be gone by the time it is inspected. A vanished
 * entry cannot be a declaration source, and failing on it would make this criterion depend on a
 * sibling file's timing rather than on the wire itself.
 */
const readIfPresent = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/** Finds the single non-test `src/**` file declaring `export type <typeName> = …`. */
const findClientDeclaration = (typeName: string): string => {
  const declaration = new RegExp(`export type ${typeName}\\s*(?:<[^>]*>)?\\s*=`);

  const walk = (directory: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      const stats = readIfPresent(() => statSync(full));
      if (stats === null) continue;
      if (stats.isDirectory()) {
        if (entry === 'tests') continue;
        found.push(...walk(full));
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
        const source = readIfPresent(() => readFile(full));
        if (source !== null && declaration.test(source)) found.push(full);
      }
    }
    return found;
  };

  const matches = walk(srcRoot);
  assert.equal(
    matches.length,
    1,
    `${typeName} must be declared in exactly one non-test src file, found: ${matches.join(', ')}`,
  );
  return matches[0];
};

/** One row of the comparison table. */
type SyncRow = {
  /** Type name on the client side. */
  readonly client: string;
  /** Type name on the server side (differs when the wire renames it). */
  readonly server: string;
  /** Absolute path of the server declaration. */
  readonly serverFile: string;
  /** Which reading applies: a literal union or an object's top-level field set. */
  readonly reader: 'union' | 'object';
};

// The split moved the declarations out of the root barrel; read the directory (see readFile).
const SERVER_TYPES = path.join(repoRoot, 'server', 'shared', 'types');

const ROWS: readonly SyncRow[] = [
  {
    client: 'NoticeLifecycle',
    server: 'NoticeLifecycle',
    serverFile: path.join(repoRoot, 'server', 'modules', 'notices', 'notice-registry.service.ts'),
    reader: 'union',
  },
  {
    client: 'NoticeSeverity',
    server: 'NoticeSeverity',
    serverFile: path.join(repoRoot, 'server', 'modules', 'notices', 'notice-registry.service.ts'),
    reader: 'union',
  },
  {
    client: 'Notice',
    server: 'Notice',
    serverFile: path.join(repoRoot, 'server', 'modules', 'notices', 'notice-registry.service.ts'),
    reader: 'object',
  },
  {
    client: 'NoticeList',
    server: 'NoticeList',
    serverFile: path.join(repoRoot, 'server', 'modules', 'notices', 'notice-registry.service.ts'),
    reader: 'object',
  },
  {
    client: 'ArchitectureRefreshState',
    server: 'ArchitectureRefreshState',
    serverFile: SERVER_TYPES,
    reader: 'union',
  },
  {
    client: 'ArchitectureRefreshStage',
    server: 'ArchitectureRefreshStage',
    serverFile: SERVER_TYPES,
    reader: 'union',
  },
  {
    client: 'ArchitectureRefreshStatus',
    server: 'ArchitectureRefreshStatus',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'ArchitectureRefreshStartResult',
    server: 'ArchitectureRefreshStartResult',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'RecentTerminalState',
    server: 'ResidentTerminalState',
    serverFile: path.join(repoRoot, 'server', 'modules', 'resident-ledger', 'terminal-state.ts'),
    reader: 'union',
  },
  {
    client: 'ArchitectureMentionHit',
    server: 'SeedMentionHit',
    serverFile: path.join(repoRoot, 'server', 'modules', 'architecture', 'seed-extraction.ts'),
    reader: 'object',
  },
  {
    client: 'ArchitectureMentionEntity',
    server: 'ArchitectureMentionEntity',
    serverFile: path.join(repoRoot, 'server', 'modules', 'architecture', 'service.ts'),
    reader: 'object',
  },
  {
    client: 'CockpitSessionStartSettingsReading',
    server: 'CockpitSessionStartSettingsReading',
    serverFile: path.join(repoRoot, 'server', 'modules', 'settings', 'server-settings-file.ts'),
    reader: 'object',
  },
  {
    // The current-turn usage block the composer chip and `/cost` panel render.
    // The server measures it; the browser reads the same fields to display it,
    // so a field added on one end without the other would silently drop it.
    client: 'TurnTokenUsage',
    server: 'TurnTokenUsage',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    // The project-owned Codex upstream provider registry: the settings UI renders this shape and
    // a save sends the same fields back, so a field added on one end without the other would make
    // the form silently drop or invent configuration. The server's copy lives in shared/types.ts
    // beside the other provider types.
    client: 'CodexModelProvider',
    server: 'CodexModelProvider',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'CodexModelProvidersReading',
    server: 'CodexModelProvidersReading',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    // A custom model's config crosses the wire in both directions: the editor reads the
    // provider binding back and sends it on save. Both ends must name the same fields, or a
    // Codex model bound to a project provider would silently lose that binding on edit. The
    // server's stored shape is `ProviderModelConfig`; the client sees the public projection.
    client: 'ProviderModelPublicConfig',
    server: 'ProviderModelConfig',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    // The lifecycle vocabulary a NEW session is created with. The client spells
    // it `SessionLifecycleMode`; the server's row column and capability matrix
    // spell it `HostMode`. Both ends must name the same modes, or a create the
    // page offers would be refused by the gateway (or vice versa).
    client: 'SessionLifecycleMode',
    server: 'HostMode',
    serverFile: SERVER_TYPES,
    reader: 'union',
  },
  {
    // The `/cost` panel's usage blocks. The client's `TokenUsageCounts` is a
    // hand-copied mirror of the server's `ProviderTokenUsageCounts`, so a
    // quantity added on one end must be added on the other — including the
    // cache-write count both ends now carry.
    client: 'TokenUsageCounts',
    server: 'ProviderTokenUsageCounts',
    serverFile: path.join(repoRoot, 'server', 'shared', 'types', 'interfaces.ts'),
    reader: 'object',
  },
  {
    // The sidebar's NC-lease row reads `ncres status --json` through this shape,
    // and a release sends `NcReleaseRequest` back. A field the CLI starts emitting
    // and one end drops would make the row silently render an empty slot, so every
    // nclease wire type is a row of its own.
    client: 'NcLeaseProbe',
    server: 'NcLeaseProbe',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'NcLease',
    server: 'NcLease',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'NcLeaseInstance',
    server: 'NcLeaseInstance',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'NcBuild',
    server: 'NcBuild',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'NcBuildState',
    server: 'NcBuildState',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'NcLeaseStatus',
    server: 'NcLeaseStatus',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'NcReleaseRequest',
    server: 'NcReleaseRequest',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    // The API-speed view reads one staged probe's timings and sends a probe request
    // back. The two ends state these shapes by hand (the browser bundle never
    // imports `server/`), so every latency wire type is a row of its own: a leg the
    // server measures and one end drops would make the breakdown silently wrong.
    client: 'ApiLatencyStageTimings',
    server: 'ApiLatencyStageTimings',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'ApiLatencyProbeMode',
    server: 'ApiLatencyProbeMode',
    serverFile: SERVER_TYPES,
    reader: 'union',
  },
  {
    client: 'ApiLatencyCredentialSource',
    server: 'ApiLatencyCredentialSource',
    serverFile: SERVER_TYPES,
    reader: 'union',
  },
  {
    client: 'ApiLatencyProbeResult',
    server: 'ApiLatencyProbeResult',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'ApiLatencyGatewayTarget',
    server: 'ApiLatencyGatewayTarget',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'ApiLatencySeries',
    server: 'ApiLatencySeries',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
  {
    client: 'ApiLatencyProbeRequest',
    server: 'ApiLatencyProbeRequest',
    serverFile: SERVER_TYPES,
    reader: 'object',
  },
];

/** Reads one row's type from an arbitrary source string (used for both ends). */
const readFromSource = (reader: SyncRow['reader'], source: string, typeName: string): string[] =>
  reader === 'union'
    ? readLiteralUnionFromSource(source, typeName)
    : readObjectKeysFromSource(source, typeName);

/** Reads the client end of one row. */
const readClient = (row: SyncRow): string[] =>
  readFromSource(row.reader, readFile(findClientDeclaration(row.client)), row.client);

/** Reads the server end of one row. */
const readServer = (row: SyncRow): string[] =>
  readFromSource(row.reader, readFile(row.serverFile), row.server);

describe('wire contract type sync', () => {
  it('every row reads a non-empty declaration on both ends, so no comparison is vacuous', () => {
    for (const row of ROWS) {
      assert.ok(
        readClient(row).length > 0,
        `${row.client} must read a non-empty declaration on the client`,
      );
      assert.ok(
        readServer(row).length > 0,
        `${row.server} must read a non-empty declaration on the server`,
      );
    }
  });

  it('(a) every literal-union row names the same members on both ends', () => {
    for (const row of ROWS.filter((candidate) => candidate.reader === 'union')) {
      assert.deepEqual(
        readClient(row),
        readServer(row),
        `${row.client} (client) and ${row.server} (server) must name the same members`,
      );
    }
  });

  it('(b) every object row names the same top-level fields on both ends', () => {
    for (const row of ROWS.filter((candidate) => candidate.reader === 'object')) {
      assert.deepEqual(
        readClient(row),
        readServer(row),
        `${row.client} (client) and ${row.server} (server) must name the same fields`,
      );
    }
  });

  it('(c) TokenUsageCounts mirrors ProviderTokenUsageCounts, including cacheWriteTokens', () => {
    const row = ROWSByClient('TokenUsageCounts');
    const client = readClient(row);
    const server = readServer(row);

    assert.ok(
      client.includes('cacheWriteTokens?'),
      'the client mirror must declare cacheWriteTokens?',
    );
    assert.ok(
      server.includes('cacheWriteTokens?'),
      'the server wire shape must declare cacheWriteTokens?',
    );
    assert.deepEqual(client, server, 'the two ends must name the same usage quantities');

    // A quantity removed on one end is the drift this row exists to catch.
    const serverSource = readFile(row.serverFile);
    const mutated = serverSource.replace('  cacheWriteTokens?: number;\n', '');
    assert.notEqual(mutated, serverSource, 'the cache-write removal must apply to the copy');
    assert.notDeepEqual(
      readObjectKeysFromSource(mutated, 'ProviderTokenUsageCounts'),
      client,
      'a quantity removed on the server end must fail the comparison',
    );
  });

  it('false-form: a mutated in-memory copy is detected for a union member and an object field', () => {
    // Union drift: the server's NoticeSeverity gains a member the client does not name.
    const serverNotices = readFile(
      path.join(repoRoot, 'server', 'modules', 'notices', 'notice-registry.service.ts'),
    );
    const mutatedUnion = serverNotices.replace(
      "export type NoticeSeverity = 'info' | 'attention' | 'blocking';",
      "export type NoticeSeverity = 'info' | 'attention' | 'blocking' | 'urgent';",
    );
    assert.notEqual(mutatedUnion, serverNotices, 'the union mutation must apply to the copy');
    assert.notDeepEqual(
      readLiteralUnionFromSource(mutatedUnion, 'NoticeSeverity'),
      readClient(ROWSByClient('NoticeSeverity')),
      'a union member added on one end must fail the comparison',
    );

    // Object drift: the server's ArchitectureRefreshStatus gains a field the client does not name.
    const serverTypes = readFile(SERVER_TYPES);
    const mutatedObject = serverTypes.replace(
      'export type ArchitectureRefreshStatus = {\n',
      'export type ArchitectureRefreshStatus = {\n  urgent: boolean;\n',
    );
    assert.notEqual(mutatedObject, serverTypes, 'the object mutation must apply to the copy');
    assert.notDeepEqual(
      readObjectKeysFromSource(mutatedObject, 'ArchitectureRefreshStatus'),
      readClient(ROWSByClient('ArchitectureRefreshStatus')),
      'a field added on one end must fail the comparison',
    );
  });
});

/** Looks up a row by client type name; used by the false-form case only. */
function ROWSByClient(client: string): SyncRow {
  const row = ROWS.find((candidate) => candidate.client === client);
  assert.ok(row, `${client} must be in the comparison table`);
  return row;
}
