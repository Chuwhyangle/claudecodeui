/**
 * The Live Voice dispatch hook's PRODUCTION WIRING (task `gap-live-voice-dispatch-hook-production-wiring`, AC3).
 *
 * WHAT IS BEING PINNED. A resident launch has to hand the CLI a `UserPromptSubmit` hook that injects the
 * "foreground schedules, background works" rules for a session that is in Live Voice. The rules text and
 * the gate live in the shipped script (`modules/voice-realtime/hooks/voice-mode-context.mjs`); this
 * criterion is about the WIRE — that the driver actually registers it, on the production launch, without
 * disturbing what the launch already carried.
 *
 * WHERE THE HOOK GOES, AND WHY THE ASSERTION READS `settings`. The launch already installs a `Stop` hook
 * through the SDK's `hooks` option. That bag is an IN-PROCESS channel: `query()` turns each entry into a
 * `hookCallbackId` and later INVOKES it, so every entry must be a callback function. A
 * `{ type: 'command', command }` object placed there is never executed — measured against the real SDK,
 * the CLI reports `Error in hook callback hook_0: … n is not a function` and the command never fires.
 * The command form belongs to the CLI's settings schema, and the flag-settings layer the SDK's `settings`
 * option fills is merged with every other settings source, so that is where a command actually runs. The
 * assertion below therefore reads `settings.hooks.UserPromptSubmit[0].hooks[0].command` — the settings
 * shape, which is exactly the shape the criterion names.
 *
 * HOW THE BAG IS READ. Through `createSdkResidentProcess` — the production factory — with only its SDK
 * entry point replaced, so the object asserted on is the one `query()` would have been handed and not a
 * second copy of it. Nothing spawns and no turn is armed: the substituted query never yields.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig=server/tsconfig.json --test \
 *       server/modules/providers/tests/claude-resident-dispatch-hook.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSdkResidentProcess } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentQuery,
  ClaudeResidentQueryFactory,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type { AnyRecord } from '@/shared/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * The shipped hook, resolved from THIS file's own location inside the same checkout.
 *
 * Deliberately derived rather than spelled out: the whole point of the launch deriving its path from
 * `import.meta.url` is that the tree can sit anywhere, so a criterion that hardcoded the repository
 * root would pass on this machine and say nothing about the property it is measuring.
 */
const SHIPPED_HOOK = path.resolve(HERE, '../../voice-realtime/hooks/voice-mode-context.mjs');

/** A query that never yields and never ends: the launch needs an iterable and nothing consumes it. */
function inertQuery(): ClaudeResidentQuery {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<AnyRecord>>(() => undefined),
      return: () => new Promise<IteratorResult<AnyRecord>>(() => undefined),
    }),
    interrupt: async () => undefined,
    close: () => undefined,
  };
}

/**
 * The launch's prompt stream, written as a bare async iterable rather than a generator: nothing is
 * ever pulled from it, and a generator with no `yield` is a shape lint has to be talked out of.
 */
function inertPrompt(): AsyncIterable<AnyRecord> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<AnyRecord>>(() => undefined),
      return: () => new Promise<IteratorResult<AnyRecord>>(() => undefined),
    }),
  };
}

/** The one SDK option bag the production launch builds, captured at the boundary it is handed over. */
function captureLaunchBag(extraOptions: AnyRecord = {}): AnyRecord {
  const captured: AnyRecord[] = [];

  createSdkResidentProcess(
    {
      prompt: inertPrompt(),
      options: { cwd: process.cwd(), model: 'haiku', permissionMode: 'default', ...extraOptions },
      // The `Stop` sink is installed by the very block the dispatch hook is appended beside, so
      // installing it is what makes "the append did not replace what was there" a readable fact.
      seams: { onStop: () => undefined },
    },
    {
      createQuery: ((launch: { options: AnyRecord }) => {
        captured.push(launch.options);
        return inertQuery();
      }) as ClaudeResidentQueryFactory,
    },
  );

  assert.equal(captured.length, 1, 'the production launch builds exactly one SDK option bag');
  return captured[0];
}

test('AC3: a resident launch registers the Live Voice UserPromptSubmit command hook', () => {
  const bag = captureLaunchBag();

  // (1) THE EXISTING HOOK SURVIVED. The append is a spread of `hooks`, so the `Stop` callback the
  //     driver installs has to still be in the bag — a wiring that replaced it would be the defect
  //     this half of the criterion exists to catch.
  const stop = (bag.hooks as AnyRecord | undefined)?.Stop as unknown[] | undefined;
  assert.ok(
    Array.isArray(stop) && stop.length > 0,
    'the launch still carries its Stop hook after the UserPromptSubmit append',
  );

  // (2) THE DISPATCH HOOK IS REGISTERED, in the settings layer where a COMMAND hook actually runs.
  const settings = (bag.settings ?? {}) as AnyRecord;
  const settingsHooks = (settings.hooks ?? {}) as AnyRecord;
  const groups = settingsHooks.UserPromptSubmit as AnyRecord[] | undefined;
  assert.ok(
    Array.isArray(groups) && groups.length > 0,
    'the launch registers a UserPromptSubmit hook in the settings layer',
  );

  const entry = (groups[0].hooks as AnyRecord[])[0];
  assert.equal(entry.type, 'command', 'the UserPromptSubmit entry is a command hook');
  assert.equal(typeof entry.command, 'string', 'the command hook names a command');

  // (3) THE PATH IS DERIVED FROM THE MODULE'S OWN LOCATION, and it names a file that is really there.
  //     Equality against a path resolved from THIS file's directory is the derivation reading: a
  //     repository-absolute literal would not agree with it in a tree that had moved.
  assert.equal(entry.command, SHIPPED_HOOK, 'the hook path is derived from the module tree, not a literal');
  assert.ok(existsSync(entry.command), `the hook path must exist on disk: ${String(entry.command)}`);

  // (4) AND THE FILE IT NAMES IS THE REAL SCRIPT — not an empty file parked at the right path.
  assert.match(readFileSync(entry.command, 'utf8'), /\[Live Voice 模式\]/);
});

test('AC3: the append preserves the settings the launch already carried', () => {
  // `ultracode` is the one effort that writes into the same `settings` object (`applyClaudeEffort`), so
  // it is what makes "the hook was added, not assigned over" a readable fact rather than a claim. It is
  // offered on the `best` model in the catalog, and the catalog is what gates the effort through.
  const bag = captureLaunchBag({ model: 'best', effort: 'ultracode' });
  const settings = bag.settings as AnyRecord;

  assert.equal(settings.ultracode, true, 'the launch\'s own ultracode marker survived the hook append');
  assert.equal(settings.enableWorkflows, true, 'and so did the flag it carries with it');
  assert.equal(
    ((settings.hooks as AnyRecord).UserPromptSubmit as unknown[]).length,
    1,
    'the dispatch hook is registered alongside them rather than instead of them',
  );
});
