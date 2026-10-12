/**
 * `expectKnownDefect` — run a scenario that is expected to fail TODAY, and fail the RUN if it stops
 * failing the way it is known to fail.
 *
 * WHY THIS EXISTS. The double-drop defects (`e22ac831`) are real, they are shipping, and their fix is
 * a separate task (`gap-live-voice-reconnect-epoch-scoped-commit-pairing`). A criterion for the
 * EVIDENCE therefore has to assert something that is currently FALSE — and a plain failing assertion
 * would be indistinguishable from a broken test. This helper makes the difference explicit, in both
 * directions:
 *
 *   · the scenario fails WITH the recorded signature  → the defect is still there, as recorded — PASS;
 *   · the scenario fails some OTHER way               → `unexpected failure signature` — FAIL;
 *   · the scenario passes                             → `defect no longer reproduces`       — FAIL.
 *
 * The third branch is the one that matters most. A known-defect wrapper is a liability the moment
 * its defect is fixed: left in place, it silently asserts nothing, and the criterion around it
 * reports green about code that no longer behaves as described. So a pass is a FAILURE here — the
 * run is telling its reader to retire the wrapper, and `fixTask` is the task whose landing should
 * have caused exactly that.
 *
 * WHAT A SIGNATURE MAY BE. The FIRST LINE of the failure the defect produces — the verbatim text a
 * journal or a previous run recorded, or a `RegExp` for the parts that legitimately vary. Never a
 * match-everything wildcard, never an empty string, never the test's own name: those match a test
 * that is broken in any way at all, which is the opposite of what a known defect is.
 * {@link expectKnownDefect} refuses them, so a scenario cannot be wrapped to look load-bearing when
 * it is not.
 *
 * Volatile substrings are stripped from the ACTUAL line before it is compared — ISO timestamps and
 * loopback `host:port` pairs — so a recorded signature does not have to be re-pasted every time a
 * run happens to start a second later, on a different port.
 */

/** The shape of a known defect: what to call it, and what it looks like while it is still there. */
export type KnownDefectOptions = {
  /**
   * The task that will fix this defect — the one whose landing makes the scenario PASS and flips
   * this wrapper's third branch into a failure. Required: a known defect with no owner is a test
   * nobody will ever retire.
   */
  fixTask: string;
  /**
   * The FIRST LINE of the failure this defect produces while it is still there — the verbatim text,
   * or a `RegExp` for the parts that vary by run.
   */
  signature: string | RegExp;
  /** Anything the reader needs to connect the signature to the incident (a journal id, a seq). */
  note?: string;
};

/** An ISO-8601 timestamp, as a log line or an assertion message writes one. */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
/** A loopback `host:port` — the port changes between runs, the host does not. */
const LOOPBACK_ADDRESS = /\b(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):\d+\b/g;

/** The first line of a thrown value's message — what a signature is written against. */
export function firstFailureLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? '').trim();
}

/** Strips the parts of a failure line that change between runs, and keeps the rest verbatim. */
export function normalizeFailureLine(line: string): string {
  return line.replace(ISO_TIMESTAMP, '<timestamp>').replace(LOOPBACK_ADDRESS, '$1:<port>').trim();
}

/**
 * Whether a signature can tell this defect apart from a broken test.
 *
 * A signature that matches everything (or almost nothing) is worse than no wrapper at all, because
 * it reports green about a scenario that never ran. The floor below is deliberately crude — length,
 * and a `RegExp` that is not a wildcard — because the real check is the third branch: a signature
 * that is too loose will pass here and then let a fixed defect keep reporting green, which is the
 * failure a reviewer of `## Notes` is asked to catch.
 */
export function signatureIsMeaningful(signature: string | RegExp): boolean {
  if (typeof signature === 'string') return signature.trim().length >= 12;
  const source = signature.source.trim();
  return !/^\^?\.\*\$?$/.test(source) && source.length >= 6;
}

/** How a signature reads back in a failure message. */
function describe(signature: string | RegExp): string {
  return typeof signature === 'string' ? JSON.stringify(signature) : `/${signature.source}/${signature.flags}`;
}

/** Whether the normalized actual line is the signature this defect is known by. */
export function matchesSignature(actual: string, signature: string | RegExp): boolean {
  return typeof signature === 'string' ? actual === signature : signature.test(actual);
}

/**
 * Runs `scenario` and requires it to fail in the recorded way.
 *
 * Returns normally ONLY when the scenario threw and its first failure line matched `signature` —
 * i.e. only while the defect is still there. Every other outcome is a thrown error, including the
 * scenario PASSING: see the module comment for why that is a failure and not a relief.
 */
export async function expectKnownDefect(
  scenario: () => void | Promise<void>,
  options: KnownDefectOptions,
): Promise<void> {
  if (typeof options.fixTask !== 'string' || options.fixTask.trim() === '') {
    throw new Error('expectKnownDefect: `fixTask` is required — a known defect with no owner is never retired');
  }
  if (!signatureIsMeaningful(options.signature)) {
    throw new Error(
      `expectKnownDefect: the signature ${describe(options.signature)} cannot tell this defect apart from a broken ` +
        'test — a wildcard or a stub matches any failure, including one that is not this defect',
    );
  }

  let failure: unknown;
  let threw = false;
  try {
    await scenario();
  } catch (error) {
    threw = true;
    failure = error;
  }

  if (!threw) {
    throw new Error(
      `defect no longer reproduces: ${options.fixTask} — retire this known-defect wrapper and assert the ` +
        'correct behaviour directly' +
        (options.note === undefined ? '' : `\n  note: ${options.note}`),
    );
  }

  const actual = normalizeFailureLine(firstFailureLine(failure));
  if (!matchesSignature(actual, options.signature)) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    throw new Error(
      'unexpected failure signature: the scenario failed, but not the way this defect is known to fail\n' +
        `  fixTask:  ${options.fixTask}\n` +
        `  expected: ${describe(options.signature)}\n` +
        `  actual:   ${actual}\n` +
        `  full:     ${detail}`,
    );
  }
}
