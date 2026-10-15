/**
 * The Live Voice dispatch hook's PRODUCTION WIRING, now an IN-PROCESS CALLBACK
 * (task `gap-live-voice-dispatch-hook-in-process-callback-with-relay-state` AC1/AC2/AC8).
 *
 * WHAT IS BEING PINNED. A resident launch has to tell the CLI to inject the "foreground schedules,
 * background works" rules for a session that is in Live Voice — and the carrier is now a `hooks`
 * callback rather than a `settings` command. The rules text and the gate used to live in
 * `modules/voice-realtime/hooks/voice-mode-context.mjs`, a command hook the CLI spawned on every
 * prompt; the text moved to `modules/voice-realtime/voice-mode-rules.ts` and the gate to
 * `modules/voice-realtime/voice-realtime-active.ts`, both of which this launch now imports.
 *
 * WHERE THE HOOK GOES, AND WHY THE ASSERTION READS `hooks`. The SDK's `hooks` option bag is an
 * IN-PROCESS channel: `query()` turns each entry into a `hookCallbackId` and later INVOKES it, so
 * every entry must be a callback function. A `{ type: 'command', command }` object placed there is
 * never executed — measured against the real SDK, the CLI reports
 * `Error in hook callback hook_0: … n is not a function` and the command never fires. The command form
 * belongs to the CLI's settings schema, which is where the previous wiring put it — and that is
 * exactly the shape this criterion now asserts is ABSENT, because running a command hook means
 * spawning a process on every prompt.
 *
 * HOW THE BAG IS READ. Through `createSdkResidentProcess` — the production factory — with only its SDK
 * entry point replaced, so the object asserted on is the one `query()` would have been handed and not
 * a second copy of it. Nothing spawns and no turn is armed: the substituted query never yields.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig=server/tsconfig.json --test \
 *       server/modules/providers/tests/claude-resident-dispatch-hook.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSdkResidentProcess } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentQuery,
  ClaudeResidentQueryFactory,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import {
  VOICE_MODE_RULES,
  clearVoiceSessionActive,
  markVoiceSessionActive,
  rulesFor,
} from '@/modules/voice-realtime/index.js';
import type { AnyRecord } from '@/shared/types.js';

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

/**
 * The dispatch callback itself, taken out of a freshly built production bag. It is the entry the SDK
 * would invoke, read at the same depth the criterion names.
 */
function dispatchCallback(bag: AnyRecord = captureLaunchBag()): (input: AnyRecord) => Promise<AnyRecord> {
  const groups = (bag.hooks as AnyRecord).UserPromptSubmit as AnyRecord[];
  assert.ok(Array.isArray(groups) && groups.length > 0, 'the launch registers a UserPromptSubmit hook');
  const callback = (groups[0].hooks as unknown[])[0];
  assert.equal(typeof callback, 'function', 'the UserPromptSubmit entry is a callback function, not a command object');
  return callback as (input: AnyRecord) => Promise<AnyRecord>;
}

/**
 * Runs `body` with one environment variable set, then restores exactly what was there. The callback
 * reads `process.env` at submit time, so this is what makes an experimental arm a property of the run
 * rather than of the module load.
 */
async function withEnv(name: string, value: string, body: () => Promise<void> | void): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

/**
 * The openings of the six numbered rules — AC2(b)'s "the first sentence of each numbered rule". Named
 * as a list rather than grepped out of the text so a rule that silently stopped being injected is a
 * RED rather than a shorter match.
 */
const SIX_RULE_OPENINGS = [
  '1. 预计本轮要超过约 20 秒',
  '2. 单条命令预计超过约 10 秒',
  '3. 约 20 秒内能答完的问题',
  '4. 前台需要多步时',
  '5. 用户的新话进来时',
  '6. 后台任务完成后',
];

test('AC1: the launch registers the Live Voice hook as a callback, and NOTHING in settings', () => {
  const bag = captureLaunchBag();

  // (1) THE EXISTING HOOK SURVIVED. The append is a spread of `hooks`, so the `Stop` callback the
  //     driver installs has to still be in the bag — a wiring that replaced it would be the defect
  //     this half of the criterion exists to catch.
  const stop = (bag.hooks as AnyRecord | undefined)?.Stop as unknown[] | undefined;
  assert.ok(
    Array.isArray(stop) && stop.length > 0,
    'the launch still carries its Stop hook after the UserPromptSubmit append',
  );

  // (2) THE DISPATCH HOOK IS REGISTERED, as an IN-PROCESS CALLBACK.
  const callback = dispatchCallback(bag);
  assert.equal(typeof callback, 'function', 'hooks.UserPromptSubmit[0].hooks[0] is a function');

  // (3) AND NOTHING WAS WRITTEN INTO `settings` — neither the retired command hook nor a hook section
  //     at all. Two readings, because the defect this replaces was BOTH a hook section and a command
  //     path inside it: the section has to be gone, and no settings string may name a script.
  const settings = (bag.settings ?? {}) as AnyRecord;
  assert.equal(
    (settings.hooks as AnyRecord | undefined)?.UserPromptSubmit,
    undefined,
    'the launch writes no UserPromptSubmit hook into the settings layer',
  );
  assert.equal(
    JSON.stringify(settings).includes('.mjs'),
    false,
    'no settings string names a hook script (the retired wiring put one there)',
  );
});

test('AC1: the append preserves the settings the launch already carried', () => {
  // `ultracode` is the one effort that writes into the same `settings` object (`applyClaudeEffort`), so
  // it is what makes "the hook was added, not assigned over" a readable fact rather than a claim. It is
  // offered on the `best` model in the catalog, and the catalog is what gates the effort through.
  const bag = captureLaunchBag({ model: 'best', effort: 'ultracode' });
  const settings = bag.settings as AnyRecord;

  assert.equal(settings.ultracode, true, 'the launch\'s own ultracode marker survived the hook append');
  assert.equal(settings.enableWorkflows, true, 'and so did the flag it carries with it');
  // The callback is a `hooks` entry, so it is nowhere near the settings object it used to be written
  // into — the whole point of the change.
  assert.equal((settings.hooks as AnyRecord | undefined)?.UserPromptSubmit, undefined);
});

test('AC2: the injected text follows the registry, deterministically, in both directions', async () => {
  const callback = dispatchCallback();

  // (a) A SESSION WITH NO LIVE VOICE CONNECTION IS TOLD NOTHING. `{}` is the hook contract's "no
  //     decision"; returning an injection here would arm every session in the process.
  const idle = await callback({ session_id: 'never-marked' });
  assert.equal(
    (idle as AnyRecord).hookSpecificOutput,
    undefined,
    'an unmarked session gets no hookSpecificOutput',
  );

  // (b) THE MOMENT THE RELAY MARKS IT, the same session is told the rules — no file, no spawn, no
  //     second process: the registry went in-process with the hook.
  markVoiceSessionActive('ac2-session');
  try {
    const active = (await callback({ session_id: 'ac2-session' })) as AnyRecord;
    const output = active.hookSpecificOutput as AnyRecord;
    assert.ok(output, 'a marked session gets a hookSpecificOutput');
    assert.equal(output.hookEventName, 'UserPromptSubmit', 'the injection names its own event');
    const context = output.additionalContext as string;
    assert.equal(context, VOICE_MODE_RULES, 'the injected text IS the rules text, byte for byte');
    assert.ok(context.includes('[Live Voice 模式]'), 'the injection is the Live Voice rules');
    for (const opening of SIX_RULE_OPENINGS) {
      assert.ok(context.includes(opening), `the injection carries the numbered rule starting ${opening}`);
    }
  } finally {
    clearVoiceSessionActive('ac2-session');
  }

  // (c) AND WHEN THE CONNECTION ENDS IT STOPS BEING TOLD, which is what makes the gate a gate.
  const afterClear = await callback({ session_id: 'ac2-session' });
  assert.equal(
    (afterClear as AnyRecord).hookSpecificOutput,
    undefined,
    'clearing the session turns the injection back off',
  );
});

test('AC8: VOICE_MODE_RULES_VARIANT=fragments adds the 7th rule; VOICE_MODE_HOOK_FORCE injects unmarked', async () => {
  const callback = dispatchCallback();

  // The variant arm: read at SUBMIT time, so a launch picks up the arm its environment names.
  await withEnv('VOICE_MODE_RULES_VARIANT', 'fragments', async () => {
    markVoiceSessionActive('ac8-session');
    try {
      const injected = ((await callback({ session_id: 'ac8-session' })) as AnyRecord)
        .hookSpecificOutput as AnyRecord;
      const context = injected.additionalContext as string;
      assert.equal(context, rulesFor('fragments'), 'the fragments arm is the arm rulesFor names');
      assert.ok(context.startsWith(VOICE_MODE_RULES), 'it is the default rules plus the extra rule');
      assert.ok(
        context.slice(VOICE_MODE_RULES.length).includes('7. 语音会分段到达'),
        'the extra rule is the fragments rule, numbered 7',
      );
    } finally {
      clearVoiceSessionActive('ac8-session');
    }
  });

  // The force arm: the experimental escape hatch has to inject into a session with NO connection,
  // which is the only way the arms can be exercised against a launch that is not in Live Voice.
  await withEnv('VOICE_MODE_HOOK_FORCE', '1', async () => {
    const forced = ((await callback({ session_id: 'never-marked' })) as AnyRecord)
      .hookSpecificOutput as AnyRecord;
    assert.ok(forced, 'VOICE_MODE_HOOK_FORCE=1 injects regardless of the registry');
    assert.equal(forced.hookEventName, 'UserPromptSubmit');
    assert.equal(forced.additionalContext, VOICE_MODE_RULES, 'and it injects the default rules arm');
  });
});
