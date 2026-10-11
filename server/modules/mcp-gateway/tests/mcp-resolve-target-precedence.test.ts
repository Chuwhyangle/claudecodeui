/**
 * AC-333 criterion: target resolution is PRECEDENCE-ordered — an exact id, then a
 * project's normalized absolute path, then an exact title (case-sensitive before
 * case-insensitive), and only then the fuzzy substring — and a WRITE tool accepts
 * only an exact target, so a fragment can discover a target but never address one
 * for a mutation.
 *
 * Everything here is real where it can be and injected where the reading is about
 * the rule itself. The entries come from an injected {@link McpResolveDeps}, so
 * each layer can be driven without a database standing between the query and the
 * decision; the WRITE tools come from the ONE annotations table (AC1–AC7), so the
 * strict-write reading is over the tools the gateway actually registers and not
 * over a name list this file happens to spell. The injected handler is the side
 * effect the strict rule exists to suppress: it counts its own calls.
 *
 * Readings, one leg each (the AC-333 (a)–(h) set):
 *   (a) an exact id still wins before any title layer (regression);
 *   (b) a project named by its normalized absolute path resolves directly, even
 *       when the fragment that names it is ambiguous;
 *   (c) a unique case-SENSITIVE exact title resolves, beating the ambiguous
 *       substring the same characters would otherwise fall to;
 *   (d) a unique case-INSENSITIVE exact title resolves, but ONLY after the
 *       case-sensitive layer has had its turn (a fixture holding both `Quay` and
 *       `quay` resolves `quay` to `quay`);
 *   (e) two projects with the exact same name are ambiguous, and every candidate
 *       carries id, title, path and `matchType: 'exact_title'`;
 *   (f) a read-only tool still resolves a unique substring, and a substring with
 *       several hits is ambiguous with project candidates carrying path and
 *       `matchType: 'substring'`;
 *   (g) EVERY write tool (derived from the annotations table) refuses a
 *       substring-only target with `TARGET_AMBIGUOUS` /
 *       `details.reason === 'exact_target_required'`, the single matched
 *       candidate, and zero handler calls — while the same target by id, full
 *       path or exact title reaches the handler;
 *   (h) session targets obey (a)(c)(d)(f)(g) and have NO path layer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// The types are erased, so the static import is safe: it pulls no module in at
// load time, which is what keeps the environment preamble below effective.
import type { McpResolveDeps, McpResolveEntry, McpResolveResult } from '../index.js';

// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in; the barrel therefore comes in
// dynamically. (Same preamble as the sibling mcp-resolve-target criterion.)
process.env.JWT_SECRET = 'mcp-resolve-target-precedence-test-secret';
delete process.env.VITE_IS_PLATFORM;

const { MCP_TOOL_ANNOTATIONS, McpToolError, resolveInputTargets, resolveMcpTarget } = await import(
  '../index.js'
);

type AnyRecord = Record<string, unknown>;

// --------------------------- the injected fixture ---------------------------

/** A fake working root the project paths are built under; never touched on disk. */
const WORK = '/work';

/**
 * The projects the base fixture resolves against. Ids are deliberately NOT equal
 * to any title, so the exact-id layer can never mask the exact-title layers —
 * every title reading below is genuinely the title layer's work.
 */
const PROJECTS: readonly McpResolveEntry[] = [
  { id: 'p-quay', title: 'quay', path: `${WORK}/quay` },
  { id: 'p-quay-web', title: 'quay-web', path: `${WORK}/quay-web` },
  { id: 'p-foo-quay', title: 'foo-quay', path: `${WORK}/foo-quay` },
  { id: 'p-quay-two', title: 'Quay-Two', path: `${WORK}/quay-two` },
  { id: 'p-twin-x', title: 'Twin App', path: `${WORK}/twin-x` },
  { id: 'p-twin-y', title: 'Twin App', path: `${WORK}/twin-y` },
];

/** Sessions carry no path — a session is addressed by id or title only. */
const SESSIONS: readonly McpResolveEntry[] = [
  { id: 'sess-exact', title: 'Exact Pointer' },
  { id: 'sess-other', title: 'prefix sess-exact suffix' },
  { id: 'sess-alpha', title: 'Alpha Session' },
  { id: 'sess-solo', title: 'Solo Active Session' },
  { id: 'sess-upper', title: 'UPPER TITLE' },
  { id: 'sess-dup-one', title: 'Dup Marker One' },
  { id: 'sess-dup-two', title: 'Dup Marker Two' },
];

/** The base fixture: the entries every reading shares. */
const deps: McpResolveDeps = {
  listProjects: () => PROJECTS,
  listSessions: () => SESSIONS,
};

/**
 * The case-contrast fixture for (d): TWO projects whose titles differ only in
 * case. It is separate from the base fixture because the base fixture's `QUAY`
 * reading needs `quay` to be the UNIQUE case-insensitive exact title — adding a
 * bare `Quay` there would make `QUAY` ambiguous and blur the reading.
 */
const caseContrastDeps: McpResolveDeps = {
  listProjects: () => [
    { id: 'p-quay-upper', title: 'Quay', path: `${WORK}/quay-upper` },
    { id: 'p-quay-lower', title: 'quay', path: `${WORK}/quay-lower` },
  ],
  listSessions: () => [],
};

// --------------------------- result narrowing ---------------------------

type Success = Extract<McpResolveResult, { ok: true }>;
type Failed = Extract<McpResolveResult, { ok: false }>;

/** The resolved reading, asserting the reference resolved. */
function ok(result: McpResolveResult): Success {
  assert.equal(result.ok, true, `expected a resolution, got ${JSON.stringify(result)}`);
  return result;
}

/** The refusal, asserting the reference did not resolve. */
function fail(result: McpResolveResult): Failed {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  return result;
}

// --------------------------- the write tools, from the ONE table ---------------------------

/**
 * Every write tool the gateway registers — the tools whose annotations say
 * `readOnlyHint: false` — read from {@link MCP_TOOL_ANNOTATIONS} rather than a
 * hand-kept list. This is what makes mutation (iv) observable: a hand-written
 * name list that misses a tool would not be strict for that tool, and this
 * criterion iterates the table's own set, so the omission reds (g).
 */
const WRITE_TOOLS: readonly string[] = Object.entries(MCP_TOOL_ANNOTATIONS)
  .filter(([, annotations]) => annotations.readOnlyHint === false)
  .map(([name]) => name)
  .sort();

/** A read-only tool name, likewise from the table. */
const READ_TOOLS: readonly string[] = Object.entries(MCP_TOOL_ANNOTATIONS)
  .filter(([, annotations]) => annotations.readOnlyHint === true)
  .map(([name]) => name)
  .sort();

test('the criterion fixture is well formed: the table names both a write and a read tool', () => {
  assert.ok(WRITE_TOOLS.length > 0, 'the annotations table must name at least one write tool');
  assert.ok(READ_TOOLS.length > 0, 'the annotations table must name at least one read tool');
  console.log(`[fixture] write tools (${WRITE_TOOLS.length})=${JSON.stringify(WRITE_TOOLS)}`);
  console.log(`[fixture] read tools (${READ_TOOLS.length})=${JSON.stringify(READ_TOOLS.slice(0, 5))}...`);
});

// --------------------------- (a) exact id still wins ---------------------------

test('(a) an exact id still wins before any title layer', () => {
  // `sess-exact` is a SUBSTRING of `sess-other`'s title, so the substring layer
  // alone would pick the other session; the id layer must resolve it to itself.
  const session = ok(resolveMcpTarget('sess-exact', 'session', deps));
  console.log(`[a] query="sess-exact" -> ${JSON.stringify(session)}`);
  assert.equal(session.id, 'sess-exact');
  assert.equal(session.matchType, 'id');

  // Sanity: the lookalike title really does contain the id, so (a) is doing work.
  const lookalike = SESSIONS.find((entry) => entry.id === 'sess-other');
  assert.ok(lookalike && lookalike.title.includes('sess-exact'), 'the lookalike title must contain the id');

  // The project side: an id that is a substring of other titles still wins by id.
  const project = ok(resolveMcpTarget('p-quay', 'project', deps));
  assert.equal(project.id, 'p-quay');
  assert.equal(project.matchType, 'id');
});

// --------------------------- (b) project path resolves directly ---------------------------

test('(b) a project named by its normalized absolute path resolves directly', () => {
  // The fragment that would name this project collides with a sibling title...
  const fragment = fail(resolveMcpTarget('quay-', 'project', deps));
  console.log(`[b] query="quay-" candidates=${JSON.stringify(fragment.candidates.map((c) => c.id))}`);
  assert.equal(fragment.code, 'TARGET_AMBIGUOUS');
  assert.deepEqual(
    fragment.candidates.map((candidate) => candidate.id).sort(),
    ['p-quay-two', 'p-quay-web'],
    'the fragment must be ambiguous between the two quay-* projects',
  );

  // ...but the stored absolute path resolves it to exactly one.
  const byPath = ok(resolveMcpTarget(`${WORK}/quay-web`, 'project', deps));
  console.log(`[b] query="${WORK}/quay-web" -> ${JSON.stringify(byPath)}`);
  assert.equal(byPath.id, 'p-quay-web');
  assert.equal(byPath.matchType, 'path');

  // A trailing separator and a `.` segment normalize to the same stored path.
  const trailing = ok(resolveMcpTarget(`${WORK}/quay-web/`, 'project', deps));
  assert.equal(trailing.id, 'p-quay-web');
  assert.equal(trailing.matchType, 'path');
  const dotted = ok(resolveMcpTarget(`${WORK}/./quay-web`, 'project', deps));
  assert.equal(dotted.id, 'p-quay-web');
  assert.equal(dotted.matchType, 'path');
});

// --------------------------- (c) case-sensitive exact title ---------------------------

test('(c) a unique case-sensitive exact title resolves, beating the ambiguous substring', () => {
  // The same characters as a substring are ambiguous...
  const ambiguous = fail(resolveMcpTarget('qua', 'project', deps));
  console.log(`[c] query="qua" candidates=${JSON.stringify(ambiguous.candidates.map((c) => c.id))}`);
  assert.equal(ambiguous.code, 'TARGET_AMBIGUOUS');
  assert.equal(ambiguous.candidates.length, 4, 'every quay-ish title is a substring hit');

  // ...but the exact title `quay` resolves to exactly the one project titled so.
  const exact = ok(resolveMcpTarget('quay', 'project', deps));
  console.log(`[c] query="quay" -> ${JSON.stringify(exact)}`);
  assert.equal(exact.id, 'p-quay');
  assert.equal(exact.matchType, 'exact_title');
});

// --------------------------- (d) case-insensitive exact title, after the CS layer ---------------------------

test('(d) a case-insensitive exact title resolves only after the case-sensitive layer', () => {
  // `QUAY` has no case-sensitive exact title, so the CI layer catches it.
  const ci = ok(resolveMcpTarget('QUAY', 'project', deps));
  console.log(`[d] query="QUAY" -> ${JSON.stringify(ci)}`);
  assert.equal(ci.id, 'p-quay');
  assert.equal(ci.matchType, 'exact_title_ci');

  // With BOTH `Quay` and `quay` present, `quay` resolves to `quay` — the
  // case-sensitive layer runs first, so this never reaches the CI layer.
  const contrast = ok(resolveMcpTarget('quay', 'project', caseContrastDeps));
  console.log(`[d] contrast query="quay" -> ${JSON.stringify(contrast)}`);
  assert.equal(contrast.id, 'p-quay-lower');
  assert.equal(contrast.matchType, 'exact_title');

  // And on that fixture `QUAY` IS ambiguous: the CI layer matches both.
  const upper = fail(resolveMcpTarget('QUAY', 'project', caseContrastDeps));
  console.log(`[d] contrast query="QUAY" candidates=${JSON.stringify(upper.candidates.map((c) => c.id))}`);
  assert.equal(upper.code, 'TARGET_AMBIGUOUS');
  assert.deepEqual(
    upper.candidates.map((candidate) => candidate.id).sort(),
    ['p-quay-lower', 'p-quay-upper'],
  );
});

// --------------------------- (e) two exact-equal names ---------------------------

test('(e) two projects with the exact same name are ambiguous, each candidate fully described', () => {
  const twins = fail(resolveMcpTarget('Twin App', 'project', deps));
  console.log(`[e] query="Twin App" candidates=${JSON.stringify(twins.candidates)}`);
  assert.equal(twins.code, 'TARGET_AMBIGUOUS');
  assert.deepEqual(
    twins.candidates.map((candidate) => candidate.id).sort(),
    ['p-twin-x', 'p-twin-y'],
  );
  for (const candidate of twins.candidates) {
    assert.equal(candidate.title, 'Twin App');
    assert.equal(candidate.matchType, 'exact_title', 'the deciding layer is the exact-title layer');
    assert.equal(typeof candidate.path, 'string', 'a project candidate carries its path');
    assert.ok((candidate.path ?? '').length > 0);
  }
});

// --------------------------- (f) read-only: substring resolves, several hits do not ---------------------------

test('(f) a read-only tool resolves a unique substring and refuses several', () => {
  const readName = READ_TOOLS[0];
  assert.ok(readName, 'the table must name a read tool');

  const seen: AnyRecord[] = [];
  const gate = resolveInputTargets((args) => {
    seen.push(args);
    return args;
  }, deps, readName);

  // A unique substring-only hit resolves on a read-only tool (AC-246 (a) unchanged).
  const out = gate({ project: 'foo-qua' }) as AnyRecord;
  console.log(`[f] read ${readName} project="foo-qua" -> ${JSON.stringify(out.project)}`);
  assert.equal(out.project, 'p-foo-quay', 'the substring layer resolves a unique hit for a read');
  assert.equal(seen.length, 1, 'the read handler must run once');

  // Several substring hits refuse, and the project candidates carry path + the
  // substring layer.
  const multi = fail(resolveMcpTarget('quay-', 'project', deps));
  assert.equal(multi.code, 'TARGET_AMBIGUOUS');
  for (const candidate of multi.candidates) {
    assert.equal(candidate.matchType, 'substring');
    assert.equal(typeof candidate.path, 'string', 'a project candidate carries its path');
  }
  assert.throws(
    () => gate({ project: 'quay-' }),
    (error: unknown) => error instanceof McpToolError && error.code === 'TARGET_AMBIGUOUS',
    'several substring hits must refuse the read call',
  );
  assert.equal(seen.length, 1, 'the refused read must not reach the handler again');
});

// --------------------------- (g) write tools accept only exact targets ---------------------------

test('(g) every write tool (from the annotations table) refuses a substring-only target', () => {
  assert.ok(WRITE_TOOLS.length > 0, 'the table must name at least one write tool');

  for (const name of WRITE_TOOLS) {
    const seen: AnyRecord[] = [];
    const gate = resolveInputTargets((args) => {
      seen.push(args);
      return args;
    }, deps, name);

    // A substring-only target: `solo active` matches `Solo Active Session` and
    // nothing else, so the fuzzy layer WOULD resolve it — a write must refuse it.
    assert.throws(
      () => gate({ session: 'solo active' }),
      (error: unknown) => {
        assert.ok(error instanceof McpToolError, `${name} must throw the audited envelope`);
        assert.equal(error.code, 'TARGET_AMBIGUOUS');
        const details = error.details as AnyRecord | undefined;
        assert.equal(details?.reason, 'exact_target_required', `${name}: the strict marker must be present`);
        assert.equal(details?.query, 'solo active');
        const candidates = details?.candidates as Array<{ id?: string }> | undefined;
        assert.equal(candidates?.length, 1, `${name}: exactly the one matched candidate is named`);
        assert.equal(candidates?.[0]?.id, 'sess-solo');
        return true;
      },
      `${name} must refuse a substring-only target`,
    );
    console.log(`[g] ${name} session="solo active" refused, handler calls=${seen.length}`);
    assert.equal(seen.length, 0, `${name}: the handler must never run for a refused target`);

    // The SAME target, addressed exactly, reaches the handler — by exact title...
    const viaTitle = gate({ session: 'Solo Active Session' }) as AnyRecord;
    assert.equal(viaTitle.session, 'sess-solo', `${name}: an exact title resolves`);
    // ...by id...
    const viaId = gate({ session: 'sess-solo' }) as AnyRecord;
    assert.equal(viaId.session, 'sess-solo', `${name}: an exact id resolves`);
    // ...and by a project's full path.
    const viaPath = gate({ project: `${WORK}/quay` }) as AnyRecord;
    assert.equal(viaPath.project, 'p-quay', `${name}: a full path resolves`);
    assert.equal(seen.length, 3, `${name}: three exact targets must reach the handler`);
  }
});

// --------------------------- (h) sessions obey the same rules, with no path layer ---------------------------

test('(h) session targets obey (a)(c)(d)(f)(g) and expose no path layer', () => {
  // (a) exact id.
  assert.equal(ok(resolveMcpTarget('sess-exact', 'session', deps)).matchType, 'id');

  // (c) exact title.
  const exact = ok(resolveMcpTarget('Alpha Session', 'session', deps));
  assert.equal(exact.id, 'sess-alpha');
  assert.equal(exact.matchType, 'exact_title');

  // (d) case-insensitive exact title.
  const ci = ok(resolveMcpTarget('upper title', 'session', deps));
  assert.equal(ci.id, 'sess-upper');
  assert.equal(ci.matchType, 'exact_title_ci');

  // (f) several substring hits are ambiguous, and a session candidate has NO path.
  const multi = fail(resolveMcpTarget('dup marker', 'session', deps));
  assert.equal(multi.code, 'TARGET_AMBIGUOUS');
  assert.deepEqual(
    multi.candidates.map((candidate) => candidate.id).sort(),
    ['sess-dup-one', 'sess-dup-two'],
  );
  for (const candidate of multi.candidates) {
    assert.equal(candidate.matchType, 'substring');
    assert.equal('path' in candidate, false, 'a session candidate must not carry a path');
  }

  // (g) a write tool refuses a substring-only session target.
  const writeName = WRITE_TOOLS[0];
  assert.ok(writeName, 'the table must name a write tool');
  const gate = resolveInputTargets(() => {
    throw new Error('the handler must not run');
  }, deps, writeName);
  assert.throws(
    () => gate({ session: 'solo active' }),
    (error: unknown) => (error as { code?: string }).code === 'TARGET_AMBIGUOUS',
  );

  // No path layer: a project's path names no session.
  const byProjectPath = fail(resolveMcpTarget(`${WORK}/quay`, 'session', deps));
  console.log(`[h] session query="${WORK}/quay" -> ${byProjectPath.code}`);
  assert.equal(byProjectPath.code, 'SESSION_NOT_FOUND');
});
