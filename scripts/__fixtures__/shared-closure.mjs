/**
 * The `shared/` subtree a fixture has to carry, taken by DEPENDENCY CLOSURE from the files the
 * fixture already copies.
 *
 * WHY A CLOSURE AND NOT A HAND-WRITTEN LIST. The ASR probes build their fixture out of shipped
 * files copied into a temporary directory. A fixture that copies `shared/asr/asrRegistry.ts` but
 * only some of the adapter modules its `list/` imports cannot load the registry at all: the import
 * of the missing adapter throws `ERR_MODULE_NOT_FOUND` inside the temporary tree, and the probe
 * that was supposed to report a reading reports `behavioural-reading=unavailable` instead — every
 * falsification case under it then reds on its own precondition rather than on the mutation it
 * names.
 *
 * That is exactly what happened on 2026-10-06 (`f8b99cf2`), when `sensevoice-local` and
 * `sensevoice-wasm` were registered: seven probes still listed the two or three adapters that
 * existed when their lists were written, and none of them named the new ones. A copy list is a
 * second copy of the registry's own edges, and nothing keeps the two in step — so this module
 * derives the set from the entries instead, and refuses a closure that does not resolve.
 *
 * THE CLOSURE STARTS FROM THE ENTRIES, NOT ONLY FROM THE REGISTRY. A fixture that carries the
 * registry and its adapters can still be unloadable for a file the registry never mentions:
 * `server/modules/voice/voice.service.ts` imports `shared/asr/confidenceFlags.ts`, which the
 * registry does not import. Seeding from the registry alone left that fixture red for the same
 * reason, one import further along. So every relative import the fixture's own entries make into
 * `shared/` is a seed too, and the set is whatever those seeds reach.
 *
 * ONLY `shared/` IS COPIED. An entry's relative import to a sibling under `server/` or `src/` is
 * left to the caller's own list: those files are what its readings are about, and pulling in their
 * closure would drag a server tree the fixture deliberately does not carry. A shared file that
 * reaches out of `shared/` is reported rather than followed — that is a gap this helper cannot fill
 * and should not paper over.
 */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The directory whose subtree a fixture derives rather than lists. */
const SHARED_PREFIX = 'shared/';

/**
 * Every relative module specifier `source` imports from.
 *
 * Relative only (`./`, `../`): a bare specifier is a package or a `node:` builtin and is provisioned
 * by the fixture's `node_modules` symlink rather than copied, and an alias (`@/`, `@shared/`) is a
 * build-time mapping the probes resolve with their own hooks — neither is a file this module should
 * follow into the fixture.
 *
 * @param {string} source
 * @returns {string[]}
 */
function relativeSpecifiers(source) {
  /** @type {string[]} */
  const specifiers = [];
  for (const match of source.matchAll(/(?:from|import)\s+['"](\.[^'"]*)['"]/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * The source file a relative specifier names inside `root`, or null when none exists.
 *
 * The shipping tree is TypeScript written in the ESM style: a relative import spells the COMPILED
 * extension (`.js`) even though the file on disk is `.ts`. Only that mapping and the extensionless
 * forms appear in this subtree, so those are the candidates tried; a specifier that resolves to none
 * of them is reported rather than guessed at.
 *
 * @param {string} root
 * @param {string} fromRel repository-relative path of the importing file
 * @param {string} specifier
 * @returns {string | null}
 */
function resolveSourcePath(root, fromRel, specifier) {
  const joined = path.posix.join(path.posix.dirname(fromRel), specifier);
  /** @type {string[]} */
  let candidates;
  if (joined.endsWith('.js')) {
    candidates = [`${joined.slice(0, -3)}.ts`, `${joined.slice(0, -3)}.tsx`];
  } else if (joined.endsWith('.ts') || joined.endsWith('.tsx')) {
    candidates = [joined];
  } else {
    candidates = [`${joined}.ts`, `${joined}.tsx`, path.posix.join(joined, 'index.ts')];
  }
  for (const candidate of candidates) {
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

/**
 * Every relative import the entries reach inside `shared/`, transitively, plus every relative import
 * in that closure that did not resolve to a shared source file.
 *
 * @param {string} repoRoot
 * @param {string[]} entries repository-relative files the fixture already copies
 * @returns {{ files: string[], unresolved: string[] }}
 */
export function sharedClosure(repoRoot, entries) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const unresolved = [];
  /** @type {string[]} */
  const queue = [];

  /** @type {(rel: string) => void} */
  const enqueue = (rel) => {
    if (rel.startsWith(SHARED_PREFIX)) queue.push(rel);
  };

  // Seeds: the entries that live under `shared/` themselves, and every shared file the entries
  // import. An entry's own imports are read here — not later — so a seed that the fixture cannot
  // cover is reported before anything is copied.
  for (const entry of entries) {
    const absolute = path.join(repoRoot, entry);
    if (!existsSync(absolute)) {
      unresolved.push(`${entry} (not present in the tree)`);
      continue;
    }
    enqueue(entry);
    for (const specifier of relativeSpecifiers(readFileSync(absolute, 'utf8'))) {
      const target = resolveSourcePath(repoRoot, entry, specifier);
      if (target === null) unresolved.push(`${entry} -> ${specifier}`);
      else enqueue(target);
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const rel = /** @type {string} */ (queue[index]);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const absolute = path.join(repoRoot, rel);
    if (!existsSync(absolute)) {
      unresolved.push(`${rel} (not present in the tree)`);
      continue;
    }
    files.push(rel);
    for (const specifier of relativeSpecifiers(readFileSync(absolute, 'utf8'))) {
      const target = resolveSourcePath(repoRoot, rel, specifier);
      if (target === null) unresolved.push(`${rel} -> ${specifier}`);
      else if (target.startsWith(SHARED_PREFIX)) enqueue(target);
      else unresolved.push(`${rel} -> ${specifier} (reaches outside ${SHARED_PREFIX})`);
    }
  }

  return { files: files.sort(), unresolved };
}

/**
 * Every relative import in `files`, resolved inside `fixtureRoot`, must land on a file the fixture
 * actually holds.
 *
 * This is the fixture's own reading of the drift that motivated this module: a copied tree with a
 * dangling relative import cannot be loaded, and the point is to say so HERE, naming the specifier,
 * rather than let it surface as a probe that is red for every input.
 *
 * @param {string} fixtureRoot
 * @param {string[]} files repository-relative
 * @returns {void}
 */
export function assertFixtureImportsResolve(fixtureRoot, files) {
  /** @type {string[]} */
  const unresolved = [];
  for (const rel of files) {
    const absolute = path.join(fixtureRoot, rel);
    if (!existsSync(absolute)) {
      unresolved.push(`${rel} (missing from the fixture)`);
      continue;
    }
    for (const specifier of relativeSpecifiers(readFileSync(absolute, 'utf8'))) {
      if (resolveSourcePath(fixtureRoot, rel, specifier) === null) {
        unresolved.push(`${rel} -> ${specifier}`);
      }
    }
  }
  assert.equal(
    unresolved.length,
    0,
    `the fixture has unresolvable relative imports:\n${unresolved.join('\n')}`,
  );
}

/**
 * Copy every `shared/` file the entries reach into the fixture and self-check it, in one call.
 *
 * Returning the copied paths lets a rig keep the same accounting it had with its own list (and, in
 * the negative control, omit one of them to prove the check bites).
 *
 * @param {{ repoRoot: string, fixtureRoot: string, entries: string[] }} options
 * @returns {string[]} the copied, repository-relative paths, sorted
 */
export function provisionSharedClosure({ repoRoot, fixtureRoot, entries }) {
  const { files, unresolved } = sharedClosure(repoRoot, entries);
  assert.equal(
    unresolved.length,
    0,
    `the shared closure has unresolvable relative imports:\n${unresolved.join('\n')}`,
  );
  for (const rel of files) {
    const destination = path.join(fixtureRoot, rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repoRoot, rel), destination);
  }
  assertFixtureImportsResolve(fixtureRoot, files);
  return files;
}
