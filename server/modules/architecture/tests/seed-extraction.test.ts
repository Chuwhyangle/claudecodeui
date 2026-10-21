/**
 * AC-416 — architecture seed extraction from a normalized transcript.
 *
 * What this criterion is FOR. ADR-005 decision 3 needs one pure step between
 * "read a session's history" (AC-418) and "expand a seeded subgraph" (AC-415):
 * turn `NormalizedMessage[]` into the ordered file and identifier seed lists
 * that the graph is built from. This file drives `extractSeeds` over a
 * `NormalizedMessage[]` built with the real `createNormalizedMessage` envelope
 * — not a hand-rolled shape — and reads the lists back.
 *
 * `knownIdentifiers` is a FROZEN SLICE of the real `.archguard/query` snapshot,
 * not a live-cache assertion. Source scopes (both read 2026-10-21):
 *  · `src`    — `.archguard/query/93e0a992/arch-index.json`
 *    archJsonHash d02930eaf41dacb0b22a498575d9d479bd77931e874e78d97b00db170b5e42f0
 *    generatedAt 2026-10-20T15:52:34.424Z
 *  · `server` — `.archguard/query/bcc56acf/arch-index.json`
 *    archJsonHash dca912462fdedad5e17d18a435b67457ff45e7abe9ff954bd447f0241860199b
 *    generatedAt 2026-10-20T15:49:24.847Z
 * The names below were transcribed from those `nameToIds` keys; they are the
 * fixture's ground truth even after the live cache moves on.
 *
 * Test blocks are named one per reading, all prefixed `AC-416`, so a single
 * leg can be re-run with `--test-name-pattern`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

import { extractSeeds } from '../index.js';

const SESSION_ID = 'seed-extraction-fixture-session';

/**
 * A frozen slice of the real `nameToIds` key sets (see the file header for the
 * two source scopes and their `archJsonHash`). Includes PascalCase, camelCase,
 * an all-lowercase name (`reassemble`, only reachable through the backtick rule)
 * and three names that appear ONLY in non-seed rows, so the role/kind filter has
 * something it can visibly exclude.
 */
const KNOWN_IDENTIFIERS: ReadonlySet<string> = new Set([
  // src scope 93e0a992
  'App',
  'ChatInterface',
  'MermaidDiagram',
  'useAuth',
  'reassemble',
  'LoginForm',
  'SetupForm',
  'ProtectedRoute',
  // server scope bcc56acf
  'createNormalizedMessage',
]);

let messageSeq = 0;

/** Build one fixture row with the real envelope helper. */
function row(fields: { kind: NormalizedMessage['kind'] } & Record<string, unknown>): NormalizedMessage {
  messageSeq += 1;
  return createNormalizedMessage({
    id: `seed-fixture-${messageSeq}`,
    sessionId: SESSION_ID,
    timestamp: `2026-10-20T15:00:${String(messageSeq % 60).padStart(2, '0')}.000Z`,
    provider: 'claude',
    ...fields,
  });
}

function toolUse(toolName: string, toolInput: unknown): NormalizedMessage {
  return row({ kind: 'tool_use', toolName, toolInput });
}

function assistantText(content: string): NormalizedMessage {
  return row({ kind: 'text', role: 'assistant', content });
}

/**
 * The full fixture: the four seed-bearing tools (with a repeated path and the
 * Codex JSON-string `toolInput` shape), plus noise rows that must contribute
 * nothing (`tool_result`, `thinking`, user text).
 */
const FULL_FIXTURE: readonly NormalizedMessage[] = [
  assistantText(
    'The `reassemble` helper rebuilds a turn from fragments. Whenever `createNormalizedMessage` runs, ' +
      'App and useAuth are already normalized, so MermaidDiagram can render the graph. ' +
      'JSON and Promise are just external symbols here.',
  ),
  toolUse('Read', { file_path: 'src/App.tsx' }),
  row({ kind: 'tool_result', toolId: 'call-1', content: 'SetupForm is mounted in the result output' }),
  row({ kind: 'thinking', role: 'assistant', content: 'LoginForm should be wired later' }),
  toolUse('Edit', { file_path: 'src/auth/useAuth.ts' }),
  toolUse('Write', { file_path: 'src/components/MermaidDiagram.tsx' }),
  toolUse('NotebookEdit', { file_path: 'notebooks/probe.ipynb' }),
  toolUse('Read', { file_path: 'src/App.tsx' }),
  toolUse('Read', JSON.stringify({ file_path: 'src/codex/json-string-input.ts' })),
  toolUse('Read', '{not valid json'),
  assistantText('`App` sits above ChatInterface, and `reassemble` keeps its order.'),
  row({ kind: 'text', role: 'user', content: 'ProtectedRoute should stay out of the seeds' }),
];

const EXPECTED_FILES = [
  'src/App.tsx',
  'src/auth/useAuth.ts',
  'src/components/MermaidDiagram.tsx',
  'notebooks/probe.ipynb',
  'src/codex/json-string-input.ts',
];

const EXPECTED_IDENTIFIERS = [
  'reassemble',
  'createNormalizedMessage',
  'App',
  'useAuth',
  'MermaidDiagram',
  'ChatInterface',
];

test('AC-416 文件种子：Read/Edit/Write/NotebookEdit 的 file_path 全提取并去重', () => {
  const { files } = extractSeeds(FULL_FIXTURE, KNOWN_IDENTIFIERS);
  console.log(`AC-416 reading: files.length=${files.length} files=${JSON.stringify(files)}`);

  // Order is first-occurrence order, and the repeated `src/App.tsx` appears once.
  assert.deepEqual(files, EXPECTED_FILES);
  // Every seed-bearing tool contributed its own path.
  for (const toolPath of [
    'src/App.tsx', // Read
    'src/auth/useAuth.ts', // Edit
    'src/components/MermaidDiagram.tsx', // Write
    'notebooks/probe.ipynb', // NotebookEdit
  ]) {
    assert.ok(files.includes(toolPath), `missing ${toolPath}`);
  }
  // The Codex JSON-string toolInput shape parses; the malformed one contributes nothing.
  assert.ok(files.includes('src/codex/json-string-input.ts'));
  assert.equal(files.filter((file) => file === 'src/App.tsx').length, 1, 'duplicate path kept once');
  assert.equal(files.length, 5, 'malformed JSON must not add a seed');
});

test('AC-416 标识符种子：反引号 span 与 PascalCase/camelCase 词中与 nameToIds 精确命中', () => {
  const { identifiers } = extractSeeds(FULL_FIXTURE, KNOWN_IDENTIFIERS);
  console.log(`AC-416 reading: identifiers=${JSON.stringify(identifiers)}`);

  assert.deepEqual(identifiers, EXPECTED_IDENTIFIERS);
  // Rule ①: an all-lowercase name is reachable only because it sits in a backtick span.
  assert.ok(identifiers.includes('reassemble'));
  // Rule ②: PascalCase and camelCase words in the running text.
  for (const name of ['App', 'useAuth', 'MermaidDiagram', 'ChatInterface']) {
    assert.ok(identifiers.includes(name), `missing ${name}`);
  }
  // De-duplication: `reassemble` and `App` each appear twice in the fixture text.
  assert.equal(new Set(identifiers).size, identifiers.length, 'no duplicates');
});

test('AC-416 普通词与外部符号：不在 nameToIds 的 token 不进种子', () => {
  const { identifiers } = extractSeeds(FULL_FIXTURE, KNOWN_IDENTIFIERS);
  const candidateButUnknown = ['Whenever', 'The', 'JSON', 'Promise'];
  for (const word of candidateButUnknown) {
    assert.ok(!identifiers.includes(word), `${word} must not be a seed`);
  }
  // Rows outside `kind: text && role: assistant` never contribute, even when the
  // token IS a real nameToIds key.
  for (const name of ['LoginForm', 'SetupForm', 'ProtectedRoute']) {
    assert.ok(!identifiers.includes(name), `${name} comes from a non-assistant-text row`);
  }
  console.log(
    `AC-416 reading: excluded=${JSON.stringify([...candidateButUnknown, 'LoginForm', 'SetupForm', 'ProtectedRoute'])}`,
  );
});

test('AC-416 文件种子 cap：去重后只保留前 100 个', () => {
  const capRows: NormalizedMessage[] = [];
  for (let i = 0; i < 101; i += 1) {
    capRows.push(toolUse('Read', { file_path: `src/cap/file-${String(i).padStart(3, '0')}.ts` }));
  }
  // A duplicate of the very first path, early in the stream: it must not take a slot.
  capRows.splice(1, 0, toolUse('Read', { file_path: 'src/cap/file-000.ts' }));

  const { files } = extractSeeds(capRows, KNOWN_IDENTIFIERS);
  const uniquePaths = new Set(
    capRows.flatMap((message) => {
      const input = message.toolInput as { file_path?: string } | undefined;
      return input?.file_path ? [input.file_path] : [];
    }),
  );
  const discarded = uniquePaths.size - files.length;
  console.log(
    `AC-416 reading: cap unique=${uniquePaths.size} kept=${files.length} discarded=${discarded} first=${files[0]} last=${files.at(-1)}`,
  );

  assert.equal(files.length, 100);
  assert.equal(files[0], 'src/cap/file-000.ts');
  assert.equal(files.at(-1), 'src/cap/file-099.ts');
  assert.ok(!files.includes('src/cap/file-100.ts'), 'the 101st distinct path is dropped');
  assert.equal(discarded, 1);
});

test('AC-416 假形态 A：漏读 Edit 的 file_path ⇒ 文件种子断言红', () => {
  const full = extractSeeds(FULL_FIXTURE, KNOWN_IDENTIFIERS);
  const withoutEdit = extractSeeds(
    FULL_FIXTURE.filter((message) => message.toolName !== 'Edit'),
    KNOWN_IDENTIFIERS,
  );
  const editOnlyPath = 'src/auth/useAuth.ts';
  const difference = full.files.filter((file) => !withoutEdit.files.includes(file));
  console.log(
    `AC-416 reading: false-form-A full=${JSON.stringify(full.files)} withoutEdit=${JSON.stringify(withoutEdit.files)} difference=${JSON.stringify(difference)}`,
  );

  assert.ok(full.files.includes(editOnlyPath), 'the full fixture must seed the Edit path');
  assert.ok(!withoutEdit.files.includes(editOnlyPath), 'removing the Edit row must drop that path');
  assert.deepEqual(difference, [editOnlyPath]);
  assert.ok(difference.length > 0, 'the two readings must differ');
});

test('AC-416 假形态 B：把普通词当标识符 ⇒ 标识符种子断言红', () => {
  const ordinaryWord = 'Whenever';
  const real = extractSeeds(FULL_FIXTURE, KNOWN_IDENTIFIERS);
  const mirrored = extractSeeds(FULL_FIXTURE, new Set([...KNOWN_IDENTIFIERS, ordinaryWord]));
  console.log(
    `AC-416 reading: false-form-B realHas=${real.identifiers.includes(ordinaryWord)} ` +
      `mirrorHas=${mirrored.identifiers.includes(ordinaryWord)}`,
  );

  assert.ok(!real.identifiers.includes(ordinaryWord), 'absent under the real nameToIds slice');
  assert.ok(mirrored.identifiers.includes(ordinaryWord), 'present once the exact-match set admits it');
  // Everything else is unchanged: the only difference is the word we admitted.
  assert.deepEqual(
    mirrored.identifiers.filter((name) => name !== ordinaryWord),
    real.identifiers,
  );
});
