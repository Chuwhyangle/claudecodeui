/**
 * Known-defect legs: a failing assertion only counts as "expected" when it fails for the reason the
 * current code is already known to produce.
 *
 * WHAT THIS REPLACES, AND WHY THE REPLACEMENT MATTERS. A leg marked with Playwright's expected-fail
 * annotation is green for ANY failure: a typo in the assertion, a field missing from the recording,
 * a throw from a helper — all read as "the known defect reproduced". That is a leg nobody can trust,
 * because the very reading it exists to make is the one it stops making the moment it breaks. This
 * module's signature is the current code's own verbatim first failing line — a stable prefix or a
 * regex with the run-to-run parts (timestamps, ports) removed — so a leg passes only when THAT
 * failure is what happened, and reds loudly otherwise:
 *
 *   - the assertion fails with the recorded signature   → pass (the defect still reproduces);
 *   - the assertion fails some other way                → red: `unexpected failure signature`;
 *   - the assertion does not fail at all                → red: `defect no longer reproduces`.
 *
 * FIX-TASK CONVENTION. Every call names the quay task that will fix the defect (`fixTask`). When
 * that task lands, delete the `expectKnownDefect(...)` wrapper and leave its second argument — the
 * direct assertion the leg was always expressing — in its place. The follow-up criterion AC-356
 * refuses a spec that still contains `expectKnownDefect(`, so the flip is mechanical and cannot be
 * forgotten silently.
 *
 * This module is a helper, not a spec: its filename does not match Playwright's `*.spec.ts`
 * testMatch, so it is never collected as a test file.
 */
import { test } from '@playwright/test';

/** Options for {@link expectKnownDefect}. */
export type KnownDefectOptions = {
  /** The quay task that will fix this defect; printed when the leg has to be flipped. */
  fixTask: string;
};

/** The prefix of the error thrown when the assertion failed for a reason other than the signature. */
export const UNEXPECTED_SIGNATURE_MARKER = 'unexpected failure signature';

/** The prefix of the error thrown when the defect stopped reproducing. */
export const DEFECT_GONE_MARKER = 'defect no longer reproduces';

/** Human-readable form of a signature, for the failure text. */
const labelOf = (signature: string | RegExp): string =>
  typeof signature === 'string' ? JSON.stringify(signature) : String(signature);

/** The first line of a message — the layer the recorded signature was taken from. */
const firstLineOf = (text: string): string => text.split('\n', 1)[0] ?? '';

/**
 * Whether `message` carries the recorded signature.
 *
 * A string is a literal (contained, so a stable prefix is the common case); a regex is the escape
 * hatch for a signature that straddles a variable part.
 */
const messageCarries = (message: string, signature: string | RegExp): boolean =>
  typeof signature === 'string' ? message.includes(signature) : signature.test(message);

/**
 * Run `assertion`, treating a failure as expected only when it matches `signature`.
 *
 * @param signature The current code's verbatim first failing line for this leg — a stable prefix
 *   (literal string) or a regex when a variable part sits inside it.
 * @param assertion The body of the leg: the direct assertions it has always expressed. Its FIRST
 *   thrown failure is the one judged against `signature`.
 * @param options `{ fixTask }` — the quay task that will fix the defect.
 */
export function expectKnownDefect(
  signature: string | RegExp,
  assertion: () => void,
  options: KnownDefectOptions,
): void {
  const { fixTask } = options;
  let failure: unknown;
  let failed = false;
  try {
    assertion();
  } catch (error) {
    failed = true;
    failure = error;
  }

  if (!failed) {
    throw new Error(
      `${DEFECT_GONE_MARKER} — flip this leg (${fixTask}). ` +
        `The assertion passed, so ${labelOf(signature)} was not observed.`,
    );
  }

  const message = failure instanceof Error ? failure.message : String(failure);
  if (!messageCarries(message, signature)) {
    throw new Error(
      `${UNEXPECTED_SIGNATURE_MARKER}\n` +
        `  expected signature: ${labelOf(signature)}\n` +
        `  fix task:           ${fixTask}\n` +
        `  actual failure:\n${message}`,
    );
  }

  // The signature the leg actually matched, on the transcript: this is the reading a run leaves
  // behind, and the annotation keeps it attached to the test in Playwright's own report.
  const matched = firstLineOf(message);
  console.log(`[known-defect] ${fixTask}: matched ${labelOf(signature)} :: ${matched}`);
  try {
    test.info().annotations.push({ type: 'known-defect', description: `${fixTask} :: ${matched}` });
  } catch {
    /* called outside a running Playwright test — the console line above is the record */
  }
}
