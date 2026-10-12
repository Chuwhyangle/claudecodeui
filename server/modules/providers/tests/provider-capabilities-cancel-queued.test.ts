/**
 * SPEC D-11 / AC-350's criterion: the capability matrix states the MEASURED value of
 * `cancelQueuedInput`, and the module that used to reason off the old one no longer does.
 *
 * WHY THIS FILE EXISTS AT ALL. The bit read `false` with the note "not covered by E1–E8" long
 * after the verb had been measured: E9 (2026-09-26) withdrew the most recently queued entry and
 * the CLI answered `cancelled` for it, and E10/U4
 * (`docs/proposals/claude-resident-sessions-experiments.md`, §E10) withdrew a queued entry that
 * was NOT the newest one and got the same answer. Nothing in the runtime reads the slot, so the
 * wrong value broke no test — it only propagated into prose: the voice relay's byte-budget guard
 * justified itself by asserting the slot was off for this provider, and therefore that a message
 * already handed over could not be taken back. A declaration nothing reads is exactly the kind of
 * claim that decays silently, which is why the value and the prose that cited it are pinned
 * together here rather than in two places.
 *
 * AC1 — the shipping matrix reads `true`, and the reading is shown to be LOAD-BEARING: a copy of
 * the shipping module with the single token flipped back to its pre-D-11 value is written beside
 * it, imported, and read through the same expression, which must answer `false`. That is what makes
 * "the bit is `true`" a measurement instead of an assertion that would stay green if the value
 * regressed — the copy is named `__criterion-falsify-…` so `server/tsconfig.json` keeps it out of
 * the typecheck program, and it is removed in a `finally`.
 *
 * AC2 — the proxy module's comment is corrected, not deleted: it must carry no line tying
 * `cancelQueuedInput` to `false`, and it must still explain the byte budget (the positive control
 * that stops a deleted paragraph from satisfying the negative one vacuously).
 *
 * Consumers: the quay worker's AC state for AC-350; the proof that AC1/AC2's readings can go red.
 */
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { providerCapabilitiesService } from '@/modules/providers/index.js';

// ── where things are ─────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The shipping matrix module — the file AC1 reads and the false form copies. */
const SHIPPING_SERVICE = path.resolve(HERE, '../services/provider-capabilities.service.ts');
/** The voice relay module whose comment cited the old value (AC2). */
const SHIPPING_PROXY = path.resolve(HERE, '../../voice-realtime/voice-realtime-ws-proxy.service.ts');

/** The prefix every falsify copy carries; `server/tsconfig.json` excludes it from the program. */
const TEMP_PREFIX = '__criterion-falsify-cancel-queued-';

/**
 * The single field assignment the false form flips.
 *
 * Matched on the ASSIGNMENT, not on the trailing comment: the copy is a claim about the value, so
 * a later re-wording of the comment beside it must not silently turn this mutation into a no-op.
 * The hit count is asserted below for the same reason — a replacement that applied nowhere would
 * leave the false form reading the SHIPPING value and "the copy answers `false`" would be green
 * without having copied anything.
 */
const FIELD_ASSIGNMENT = /(\n\s*cancelQueuedInput: )true,/;

/** A line that ties the slot to the un-measured value — the reasoning D-11 retires. */
const OLD_VALUE_REASONING = /cancelQueuedInput[^\n]*\bfalse\b|slot is `?false`?/;

// ── AC1: the shipping value, and the false form that must red it ─────────────────────────────

test('AC1: claude declares cancelQueuedInput true, and a copy flipped back to false reads false', async () => {
  const shipping = providerCapabilitiesService.getProviderCapabilities('claude');
  assert.ok(shipping.residentFeatures, 'claude declares `resident`, so it must describe the process');
  assert.equal(
    shipping.residentFeatures.cancelQueuedInput,
    true,
    'E9 (newest queued entry) and E10/U4 (non-newest queued entry) both measured the withdraw',
  );

  // The false form: the same expression, read off a copy of the same module with the one token
  // flipped. If the assertion above could be satisfied by something other than the shipping value,
  // this arm would answer `true` too.
  const source = readFileSync(SHIPPING_SERVICE, 'utf8');
  // Counted with a global MATCH rather than `split`: `split` splices the regex's capture groups
  // into its own result, so the same pattern would report one phantom hit per group.
  const hits = (source.match(new RegExp(FIELD_ASSIGNMENT.source, 'g')) ?? []).length;
  assert.equal(hits, 1, `the false form must flip exactly one field assignment in ${path.basename(SHIPPING_SERVICE)}, found ${hits}`);
  const mutated = source.replace(FIELD_ASSIGNMENT, '$1false,');
  assert.notEqual(mutated, source, 'the mutation must have changed the source, or the false form copies the shipping value');

  const mutantPath = path.join(path.dirname(SHIPPING_SERVICE), `${TEMP_PREFIX}${process.pid}.ts`);
  try {
    writeFileSync(mutantPath, mutated, 'utf8');
    const mutant = (await import(pathToFileURL(mutantPath).href)) as typeof import('../services/provider-capabilities.service.js');
    const flipped = mutant.providerCapabilitiesService.getProviderCapabilities('claude');
    assert.equal(
      flipped.residentFeatures?.cancelQueuedInput,
      false,
      'the false form must read false — otherwise AC1 is green for a reason of its own',
    );
  } finally {
    rmSync(mutantPath, { force: true });
  }

  // The copy is a `.ts` file written into the module directory, so a leftover would be product
  // source to every later reader. Prove this process removed its own.
  assert.throws(
    () => readFileSync(mutantPath, 'utf8'),
    'the falsify copy must be gone when the case ends',
  );

  console.log(
    `[cancel-queued] claude.residentFeatures.cancelQueuedInput=${String(shipping.residentFeatures.cancelQueuedInput)} ` +
      `(false form on the flipped copy: ${String(false)}, measured by E9 + E10/U4)`,
  );
});

// ── AC2: the prose that cited the old value, corrected rather than dropped ────────────────────

test('AC2: the voice relay no longer reasons off the un-measured slot value, and still explains the budget', () => {
  const lines = readFileSync(SHIPPING_PROXY, 'utf8').split('\n');
  const citing = lines.filter((line) => line.includes('cancelQueuedInput'));
  const stale = citing.filter((line) => OLD_VALUE_REASONING.test(line));

  assert.deepEqual(
    stale,
    [],
    'no line may still tie `cancelQueuedInput` to the un-measured value — the withdraw verb is `true` for claude',
  );

  // The positive control: the paragraph must still be there, saying why the byte budget is an
  // ADMISSION axis. Without it, deleting the comment would satisfy the negative reading above.
  assert.ok(citing.length >= 1, 'the byte budget must still say why it cannot be a cancellation');
  assert.ok(
    citing.some((line) => /\btrue\b/.test(line)),
    'the corrected paragraph must state the measured value rather than drop the citation',
  );

  console.log(`[cancel-queued] ws-proxy: ${citing.length} line(s) cite the slot, 0 tie it to \`false\``);
});
