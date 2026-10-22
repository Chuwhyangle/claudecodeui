import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ArchitectureCacheFingerprintMismatchError,
  createArchitectureCache,
  type ArchitectureIndexRef,
  type ArchitectureReadingKey,
} from '../cache.js';

// ---------------------------------------------------------------------------
// Frozen real snapshot
// ---------------------------------------------------------------------------

/**
 * A frozen, cropped slice of the real
 * `.archguard/query/93e0a992/arch-index.json` (scope `src (typescript)`,
 * generated 2026-10-20T15:52:34.424Z). The top-level fields are the real file's,
 * including its real `archJsonHash`; only the adjacency maps were cropped to a
 * five-entity closed neighbourhood around `ResidentConsentNotice.tsx`, so the
 * slice stays small and every kept edge has both endpoints present.
 *
 * It is a snapshot, not an assertion about the live cache: `.archguard/` is
 * excluded from git and is absent in a task worktree. The criterion below pins
 * the real fingerprint literal so this file cannot drift into a synthetic hash.
 */
type FixtureIndex = {
  version: string;
  generatedAt: string;
  archJsonHash: string;
  language: string;
  nameToIds: Record<string, string[]>;
  idToFile: Record<string, string>;
  idToName: Record<string, string>;
  dependents: Record<string, string[]>;
  dependencies: Record<string, string[]>;
  relationsByType: Record<string, unknown>;
  fileToIds: Record<string, string[]>;
  cycles: unknown[];
};

const REAL_ARCH_INDEX_SLICE: FixtureIndex = {
  version: '1.0',
  generatedAt: '2026-10-20T15:52:34.424Z',
  archJsonHash: 'd02930eaf41dacb0b22a498575d9d479bd77931e874e78d97b00db170b5e42f0',
  language: 'typescript',
  nameToIds: {
    ProviderSelectionEmptyState: [
      'modules/chat/transcript/ProviderSelectionEmptyState.tsx.ProviderSelectionEmptyState',
    ],
    ResidentConsentNotice: [
      'modules/chat/components/ResidentConsentNotice.tsx.ResidentConsentNotice',
    ],
    ResidentToggle: [
      'modules/chat/components/ResidentConsentNotice.tsx.ResidentToggle',
    ],
    Tooltip: ['shared/ui/Tooltip.tsx.Tooltip'],
    cn: ['shared/utils.ts.cn'],
  },
  idToFile: {
    'modules/chat/components/ResidentConsentNotice.tsx.ResidentConsentNotice':
      'modules/chat/components/ResidentConsentNotice.tsx',
    'modules/chat/components/ResidentConsentNotice.tsx.ResidentToggle':
      'modules/chat/components/ResidentConsentNotice.tsx',
    'modules/chat/transcript/ProviderSelectionEmptyState.tsx.ProviderSelectionEmptyState':
      'modules/chat/transcript/ProviderSelectionEmptyState.tsx',
    'shared/ui/Tooltip.tsx.Tooltip': 'shared/ui/Tooltip.tsx',
    'shared/utils.ts.cn': 'shared/utils.ts',
  },
  idToName: {
    'modules/chat/components/ResidentConsentNotice.tsx.ResidentConsentNotice': 'ResidentConsentNotice',
    'modules/chat/components/ResidentConsentNotice.tsx.ResidentToggle': 'ResidentToggle',
    'modules/chat/transcript/ProviderSelectionEmptyState.tsx.ProviderSelectionEmptyState':
      'ProviderSelectionEmptyState',
    'shared/ui/Tooltip.tsx.Tooltip': 'Tooltip',
    'shared/utils.ts.cn': 'cn',
  },
  dependents: {
    'modules/chat/components/ResidentConsentNotice.tsx.ResidentConsentNotice': [],
    'modules/chat/components/ResidentConsentNotice.tsx.ResidentToggle': [
      'modules/chat/transcript/ProviderSelectionEmptyState.tsx.ProviderSelectionEmptyState',
    ],
    'modules/chat/transcript/ProviderSelectionEmptyState.tsx.ProviderSelectionEmptyState': [],
    'shared/ui/Tooltip.tsx.Tooltip': [
      'modules/chat/components/ResidentConsentNotice.tsx.ResidentConsentNotice',
    ],
    'shared/utils.ts.cn': [
      'modules/chat/components/ResidentConsentNotice.tsx.ResidentConsentNotice',
      'modules/chat/components/ResidentConsentNotice.tsx.ResidentToggle',
      'shared/ui/Tooltip.tsx.Tooltip',
    ],
  },
  dependencies: {
    'modules/chat/components/ResidentConsentNotice.tsx.ResidentConsentNotice': [
      'shared/utils.ts.cn',
      'shared/ui/Tooltip.tsx.Tooltip',
    ],
    'modules/chat/components/ResidentConsentNotice.tsx.ResidentToggle': ['shared/utils.ts.cn'],
    'modules/chat/transcript/ProviderSelectionEmptyState.tsx.ProviderSelectionEmptyState': [
      'modules/chat/components/ResidentConsentNotice.tsx.ResidentToggle',
    ],
    'shared/ui/Tooltip.tsx.Tooltip': ['shared/utils.ts.cn'],
    'shared/utils.ts.cn': [],
  },
  relationsByType: {},
  fileToIds: {
    'modules/chat/components/ResidentConsentNotice.tsx': [
      'modules/chat/components/ResidentConsentNotice.tsx.ResidentConsentNotice',
      'modules/chat/components/ResidentConsentNotice.tsx.ResidentToggle',
    ],
    'modules/chat/transcript/ProviderSelectionEmptyState.tsx': [
      'modules/chat/transcript/ProviderSelectionEmptyState.tsx.ProviderSelectionEmptyState',
    ],
    'shared/ui/Tooltip.tsx': ['shared/ui/Tooltip.tsx.Tooltip'],
    'shared/utils.ts': ['shared/utils.ts.cn'],
  },
  cycles: [],
};

const REAL_ARCH_JSON_HASH = 'd02930eaf41dacb0b22a498575d9d479bd77931e874e78d97b00db170b5e42f0';
const MUTATED_ARCH_JSON_HASH = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type TestParams = {
  hops: number;
  maxNodes: number;
  /** The two manual-curation knobs the service adds to the content key. */
  extraSeeds?: readonly string[];
  excludeIds?: readonly string[];
  /** The element filter's two axes; the "keep mentioned" switches ride here. */
  kinds?: readonly string[];
  keepMentionedKinds?: readonly string[];
};

type TestReading = {
  readonly fingerprints: readonly string[];
  readonly fileCount: number;
};

function writeScope(root: string, name: string, value: unknown): string {
  const scope = path.join(root, name);
  mkdirSync(scope, { recursive: true });
  writeFileSync(path.join(scope, 'arch-index.json'), JSON.stringify(value, null, 2));
  return scope;
}

function createHarness(
  t: { after(callback: () => void): void },
  options: { maxEntries?: number; maxIndexEntries?: number; source?: unknown } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const scope = writeScope(root, '93e0a992', options.source ?? REAL_ARCH_INDEX_SLICE);
  let reads = 0;
  let builds = 0;

  const cache = createArchitectureCache<FixtureIndex, TestReading, TestParams>({
    // A real filesystem read: the "no re-read" assertions below count these calls.
    readIndex: async (scopePath) => {
      reads += 1;
      return JSON.parse(readFileSync(path.join(scopePath, 'arch-index.json'), 'utf8')) as FixtureIndex;
    },
    maxEntries: options.maxEntries ?? 4,
    maxIndexEntries: options.maxIndexEntries ?? 4,
  });

  const build = (indexes: readonly FixtureIndex[]): TestReading => {
    builds += 1;
    return {
      fingerprints: indexes.map((index) => index.archJsonHash),
      fileCount: indexes.reduce((total, index) => total + Object.keys(index.fileToIds).length, 0),
    };
  };

  return {
    cache,
    scope,
    build,
    reads: () => reads,
    builds: () => builds,
    addScope: (name: string, value: unknown) => writeScope(root, name, value),
  };
}

function makeKey(
  scope: string,
  overrides: Partial<ArchitectureReadingKey<TestParams>> = {},
): ArchitectureReadingKey<TestParams> {
  return {
    projectId: 'project-1',
    sessionId: 'session-1',
    seeds: { files: ['shared/utils.ts'], identifiers: ['cn'] },
    params: { hops: 1, maxNodes: 50 },
    indexes: [{ scope, archJsonHash: REAL_ARCH_JSON_HASH }],
    ...overrides,
  };
}

/** A structurally equal key built from fresh objects — not the same references. */
function cloneKey(key: ArchitectureReadingKey<TestParams>): ArchitectureReadingKey<TestParams> {
  return JSON.parse(JSON.stringify(key)) as ArchitectureReadingKey<TestParams>;
}

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

test('AC-417 相同键命中：同键二次读取命中且不重读盘', async (t) => {
  const h = createHarness(t);
  const key = makeKey(h.scope);

  const first = await h.cache.getReading(key, h.build);
  const second = await h.cache.getReading(cloneKey(key), h.build);

  assert.equal(second, first, 'a same-key hit must return the cached reading object itself');
  assert.equal(h.reads(), 1, 'a same-key hit must not re-read arch-index.json');
  assert.equal(h.builds(), 1, 'a same-key hit must not re-render');
  assert.deepEqual(first.fingerprints, [REAL_ARCH_JSON_HASH], 'the reading is built from the parsed real snapshot');
  assert.equal(first.fileCount, 4, 'the parsed index (not just its fingerprint) flows into build');
});

test('AC-417 seeds 变即失效：文件或标识符种子变化各自 miss', async (t) => {
  const h = createHarness(t);

  await h.cache.getReading(makeKey(h.scope), h.build);
  await h.cache.getReading(
    makeKey(h.scope, {
      seeds: { files: ['shared/utils.ts', 'shared/ui/Tooltip.tsx'], identifiers: ['cn'] },
    }),
    h.build,
  );
  await h.cache.getReading(
    makeKey(h.scope, {
      seeds: { files: ['shared/utils.ts'], identifiers: ['cn', 'Tooltip'] },
    }),
    h.build,
  );

  assert.equal(h.builds(), 3, 'each distinct seed list must re-render');
  assert.equal(h.reads(), 1, 'seed-only changes must hit the parse layer, not re-read the index');
});

test('AC-417 archJsonHash 变即失效：同内容异指纹也 miss', async (t) => {
  const h = createHarness(t);
  const mutated = { ...REAL_ARCH_INDEX_SLICE, archJsonHash: MUTATED_ARCH_JSON_HASH };
  const otherScope = h.addScope('93e0a992-next', mutated);

  // Discriminating fixture: everything except the fingerprint is identical.
  const { archJsonHash: _realHash, ...realBody } = REAL_ARCH_INDEX_SLICE;
  const { archJsonHash: _mutatedHash, ...mutatedBody } = mutated;
  assert.deepEqual(mutatedBody, realBody, 'the two snapshots differ only in archJsonHash');

  await h.cache.getReading(makeKey(h.scope), h.build);
  const changed = await h.cache.getReading(
    makeKey(h.scope, { indexes: [{ scope: otherScope, archJsonHash: MUTATED_ARCH_JSON_HASH }] }),
    h.build,
  );

  assert.equal(h.reads(), 2, 'a new fingerprint must be read, not served from the old entry');
  assert.equal(h.builds(), 2, 'a new fingerprint must re-render');
  assert.deepEqual(changed.fingerprints, [MUTATED_ARCH_JSON_HASH]);

  // Content addressing, not recency: the original fingerprint still hits after the new one.
  const again = await h.cache.getReading(makeKey(h.scope), h.build);
  assert.equal(h.builds(), 2);
  assert.deepEqual(again.fingerprints, [REAL_ARCH_JSON_HASH]);
});

test('AC-417 params 变即失效：顶层与嵌套字段都计入键', async (t) => {
  const h = createHarness(t);

  await h.cache.getReading(makeKey(h.scope), h.build);
  await h.cache.getReading(makeKey(h.scope, { params: { hops: 2, maxNodes: 50 } }), h.build);
  await h.cache.getReading(makeKey(h.scope, { params: { hops: 1, maxNodes: 51 } }), h.build);

  assert.equal(h.builds(), 3, 'each distinct params object must re-render');
  assert.equal(h.reads(), 1, 'params-only changes stay on the parse-layer hit path');
});

test('AC-417 projectId/sessionId 变即失效', async (t) => {
  const h = createHarness(t);

  await h.cache.getReading(makeKey(h.scope), h.build);
  await h.cache.getReading(makeKey(h.scope, { projectId: 'project-2' }), h.build);
  await h.cache.getReading(makeKey(h.scope, { sessionId: 'session-2' }), h.build);

  assert.equal(h.builds(), 3, 'the key must include both identities');
  assert.equal(h.reads(), 1);
});

test('AC-417 解析层按 archJsonHash memoize：同指纹不重读，异指纹重读', async (t) => {
  const h = createHarness(t);
  const mutated = { ...REAL_ARCH_INDEX_SLICE, archJsonHash: MUTATED_ARCH_JSON_HASH };
  const otherScope = h.addScope('93e0a992-next', mutated);

  const ref: ArchitectureIndexRef = { scope: h.scope, archJsonHash: REAL_ARCH_JSON_HASH };
  const first = await h.cache.getIndex(ref);
  const second = await h.cache.getIndex({ ...ref });

  assert.equal(h.reads(), 1, 'the same (scope, fingerprint) must not re-read');
  assert.equal(second, first, 'the parsed object itself is memoised');

  const otherRef: ArchitectureIndexRef = { scope: otherScope, archJsonHash: MUTATED_ARCH_JSON_HASH };
  const other = await h.cache.getIndex(otherRef);
  assert.equal(h.reads(), 2, 'a different fingerprint misses');
  assert.equal(other.archJsonHash, MUTATED_ARCH_JSON_HASH);

  await h.cache.getIndex(ref);
  assert.equal(h.reads(), 2, 'the earlier fingerprint remains cached by content, not by recency');
});

test('AC-417 结果层 LRU：超过容量淘汰最旧条目', async (t) => {
  const h = createHarness(t, { maxEntries: 2 });

  await h.cache.getReading(makeKey(h.scope, { sessionId: 's1' }), h.build);
  await h.cache.getReading(makeKey(h.scope, { sessionId: 's2' }), h.build);
  await h.cache.getReading(makeKey(h.scope, { sessionId: 's3' }), h.build);
  assert.equal(h.builds(), 3);

  // maxEntries is 2, so the third distinct key evicts the oldest one (s1).
  await h.cache.getReading(makeKey(h.scope, { sessionId: 's1' }), h.build);
  assert.equal(h.builds(), 4, 'the evicted key must re-render');
  assert.equal(h.reads(), 1, 'result-layer eviction must not evict the parsed index');
});

test('AC-417 假形态 A：键按内容而不是属性插入顺序，但数组顺序是语义', async (t) => {
  const h = createHarness(t);

  await h.cache.getReading(makeKey(h.scope), h.build);
  // Same params content, different property insertion order: must be the SAME key.
  await h.cache.getReading(makeKey(h.scope, { params: { maxNodes: 50, hops: 1 } }), h.build);
  assert.equal(h.builds(), 1, 'object property order must not change the key');

  // Seed order IS content: swapping two identifiers must be a different key.
  await h.cache.getReading(
    makeKey(h.scope, { seeds: { files: ['shared/utils.ts'], identifiers: ['cn', 'Tooltip'] } }),
    h.build,
  );
  await h.cache.getReading(
    makeKey(h.scope, { seeds: { files: ['shared/utils.ts'], identifiers: ['Tooltip', 'cn'] } }),
    h.build,
  );
  assert.equal(h.builds(), 3, 'seed order must be part of the key');
  assert.equal(h.reads(), 1);
});

test('AC-417 假形态 B：指纹不符必须拒绝，不得把旧解析记到新键上', async (t) => {
  const h = createHarness(t);
  const staleRef: ArchitectureIndexRef = { scope: h.scope, archJsonHash: MUTATED_ARCH_JSON_HASH };

  await assert.rejects(
    () => h.cache.getIndex(staleRef),
    (error: unknown) =>
      error instanceof ArchitectureCacheFingerprintMismatchError &&
      error.requestedArchJsonHash === MUTATED_ARCH_JSON_HASH &&
      error.actualArchJsonHash === REAL_ARCH_JSON_HASH,
    'a stale caller fingerprint must fail closed',
  );
  assert.equal(h.reads(), 1, 'the mismatch was detected after reading the file');

  // The failed call must not poison the correct key.
  const parsed = await h.cache.getIndex({ scope: h.scope, archJsonHash: REAL_ARCH_JSON_HASH });
  assert.equal(parsed.archJsonHash, REAL_ARCH_JSON_HASH);
  assert.equal(h.reads(), 2, 'the correct fingerprint was not cached by the failed call');

  await h.cache.getIndex({ scope: h.scope, archJsonHash: REAL_ARCH_JSON_HASH });
  assert.equal(h.reads(), 2, 'the successful read is memoised');
});

test('AC-417 真实指纹：fingerprint 来自真实 arch-index.json 的 archJsonHash', async (t) => {
  // Pin the snapshot to the real file's fingerprint; a synthetic value must red this leg.
  assert.equal(REAL_ARCH_INDEX_SLICE.archJsonHash, REAL_ARCH_JSON_HASH);

  const h = createHarness(t);
  const parsed = await h.cache.getIndex({ scope: h.scope, archJsonHash: REAL_ARCH_JSON_HASH });

  assert.equal(parsed.archJsonHash, REAL_ARCH_JSON_HASH);
  assert.deepEqual(Object.keys(parsed.fileToIds).sort(), [
    'modules/chat/components/ResidentConsentNotice.tsx',
    'modules/chat/transcript/ProviderSelectionEmptyState.tsx',
    'shared/ui/Tooltip.tsx',
    'shared/utils.ts',
  ]);
  assert.deepEqual(parsed.dependencies['modules/chat/components/ResidentConsentNotice.tsx.ResidentConsentNotice'], [
    'shared/utils.ts.cn',
    'shared/ui/Tooltip.tsx.Tooltip',
  ]);

  // The fingerprint is read from the file, not hard-coded: rewrite the file with a
  // different fingerprint and prove a fresh ref reads the new value.
  h.addScope('93e0a992', { ...REAL_ARCH_INDEX_SLICE, archJsonHash: MUTATED_ARCH_JSON_HASH });
  const reread = await h.cache.getIndex({
    scope: h.scope,
    archJsonHash: MUTATED_ARCH_JSON_HASH,
  });
  assert.equal(reread.archJsonHash, MUTATED_ARCH_JSON_HASH, 'the cache keys on the file-reported fingerprint');
});

test('合并规则版本进入缓存键：规则版本变化不命中旧缓存', async (t) => {
  const h = createHarness(t);
  const key = makeKey(h.scope);

  // The pre-version key (the field omitted) and two rule versions are three
  // distinct contents for the same `.archguard` bytes.
  await h.cache.getReading(key, h.build);
  await h.cache.getReading({ ...cloneKey(key), rulesVersion: 'scope-hygiene@1' }, h.build);
  const versioned = await h.cache.getReading({ ...cloneKey(key), rulesVersion: 'scope-hygiene@2' }, h.build);

  assert.equal(h.builds(), 3, 'each merge-rule version must re-render; the old entry must not be served');
  assert.equal(h.reads(), 1, 'a version-only change stays on the parse-layer hit path');

  // The same version is a hit, so the version is content, not a per-call nonce.
  const again = await h.cache.getReading({ ...cloneKey(key), rulesVersion: 'scope-hygiene@2' }, h.build);
  assert.equal(again, versioned, 'the same rules version returns the cached reading object');
  assert.equal(h.builds(), 3);
});

test('AC-417 curation params 计入内容键：extraSeeds/excludeIds 不同即 miss，相同即命中', async (t) => {
  const h = createHarness(t);
  const curated = { hops: 1, maxNodes: 50, extraSeeds: ['a.ts.A'], excludeIds: ['b.ts.B'] };

  await h.cache.getReading(makeKey(h.scope, { params: curated }), h.build);
  // A different pin set is a different reading (the traversal roots changed).
  await h.cache.getReading(
    makeKey(h.scope, { params: { ...curated, extraSeeds: ['a.ts.A', 'c.ts.C'] } }),
    h.build,
  );
  // A different removal set likewise.
  await h.cache.getReading(
    makeKey(h.scope, { params: { ...curated, excludeIds: ['b.ts.B', 'd.ts.D'] } }),
    h.build,
  );
  assert.equal(h.builds(), 3, 'each distinct curation combination must re-render');

  // The same combination (a fresh, structurally equal key) hits.
  await h.cache.getReading(makeKey(h.scope, { params: curated }), h.build);
  assert.equal(h.builds(), 3, 'the repeated curation combination performed no second generation');
  assert.equal(h.reads(), 1, 'curation-only changes stay on the parse-layer hit path');
});

test('AC-417 keep-mentioned switches 计入内容键：不同即 miss，相同即命中', async (t) => {
  const h = createHarness(t);
  const filtered = { hops: 1, maxNodes: 50, kinds: ['class', 'interface'], keepMentionedKinds: ['function'] };

  await h.cache.getReading(makeKey(h.scope, { params: filtered }), h.build);
  // A different switch is a different drawing (the mentioned functions move
  // in or out), so it must re-render.
  await h.cache.getReading(
    makeKey(h.scope, { params: { ...filtered, keepMentionedKinds: ['class'] } }),
    h.build,
  );
  // Removing the field entirely is yet another reading.
  const { keepMentionedKinds: _omitted, ...withoutSwitches } = filtered;
  await h.cache.getReading(makeKey(h.scope, { params: withoutSwitches }), h.build);
  assert.equal(h.builds(), 3, 'each distinct switch combination must re-render');

  // The same combination (a fresh, structurally equal key) hits. (The SERVICE
  // sorts and de-duplicates the list before it reaches the cache; that
  // normalisation is pinned on the request path in architecture-routes.test.)
  await h.cache.getReading(makeKey(h.scope, { params: { ...filtered } }), h.build);
  assert.equal(h.builds(), 3, 'the repeated switch combination performed no second generation');
  assert.equal(h.reads(), 1, 'switch-only changes stay on the parse-layer hit path');
});
