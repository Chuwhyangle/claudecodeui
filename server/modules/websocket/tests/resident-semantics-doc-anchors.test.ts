/**
 * Criterion for AC-391 (GOAL-045; SPEC `docs/proposals/resident-delivery-turn-ledger-SPEC.md`
 * §12 「文档」行、§13.3、§15): the S2/S3 semantics rewrite of
 * `id-relations-and-projection-invariants.md` (A.2 / A.3 / B-2 / B-7 rewritten, B-8 / B-9
 * added) and `claude-resident-sessions.md` §8 (C-4) must be **mechanically checkable**.
 *
 * Prose cannot be judged, so every requirement carries a STABLE HTML comment anchor and the
 * criterion reads the LIVE documents and asserts three readings:
 *
 *   (a) all seven anchors appear, each in the document that owns it;
 *   (b) each anchor's NUMBERED references appear within the SLICE that runs from the anchor to
 *       the next heading / the next anchor — never a whole-document grep, which would count the
 *       prose that explains a reference's absence and go red on any unrelated rewrite;
 *   (c) the 15 criterion files listed in the SPEC §15 matrix exist on disk AND each path appears
 *       verbatim in some `goals/AC-*.md` `criterion` field — parsed as a YAML folded scalar,
 *       because the value wraps across lines and a line-wise grep sees zero hits.
 *
 * Leg (d) — delete or rename any one anchor and re-run ⇒ red on the anchor reading — is a manual
 * false-form step and is deliberately NOT part of this file. Reading only docs/ and goals/; no
 * `server/` import. Imports only node builtins, never `any`.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The criterion lives at server/modules/websocket/tests/, four levels below the repo root.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');

const ID_RELATIONS = path.join(REPO_ROOT, 'docs/proposals/id-relations-and-projection-invariants.md');
const RESIDENT_SESSIONS = path.join(REPO_ROOT, 'docs/proposals/claude-resident-sessions.md');
const SPEC = path.join(REPO_ROOT, 'docs/proposals/resident-delivery-turn-ledger-SPEC.md');
const GOALS_DIR = path.join(REPO_ROOT, 'goals');

type DocKey = 'id-relations' | 'resident-sessions';

type AnchorSpec = {
  /** Which document owns this anchor. */
  doc: DocKey;
  /** The stable HTML comment anchor, verbatim. */
  anchor: string;
  /** The numbered references this requirement must carry inside its own slice. */
  refs: string[];
};

/**
 * The seven anchors of SPEC §13.3 / AC-391, with the numbered references each slice must carry.
 * The refs are the SPEC's own numbering (`§4.4` I1–I6, `§5.3` order-independence, `§2` C-1..C-6),
 * never an invented id.
 */
const ANCHORS: AnchorSpec[] = [
  { doc: 'id-relations', anchor: '<!-- anchor: delivery-id -->', refs: ['I2', 'I4'] },
  { doc: 'id-relations', anchor: '<!-- anchor: run-is-turn -->', refs: ['I2', 'I3'] },
  { doc: 'id-relations', anchor: '<!-- anchor: b2-state-channel -->', refs: ['§7', 'I2'] },
  { doc: 'id-relations', anchor: '<!-- anchor: b7-state-channel -->', refs: ['§7', 'I2'] },
  { doc: 'id-relations', anchor: '<!-- anchor: b8-processing-single-writer -->', refs: ['I1', 'I6'] },
  { doc: 'id-relations', anchor: '<!-- anchor: b9-terminal-order-independent -->', refs: ['§5.3', 'C-3'] },
  { doc: 'resident-sessions', anchor: '<!-- anchor: resident-drain-merge -->', refs: ['C-4'] },
];

/**
 * The text that follows an anchor, up to (but not including) the next heading of level 2–4 or
 * the next anchor comment — whichever comes first. This is the anchor-located slice: the
 * criterion asserts references inside it and never greps the whole document.
 */
function sliceAfterAnchor(text: string, anchor: string): string | null {
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  const rest = text.slice(at + anchor.length);
  const heading = /^#{2,4} /m.exec(rest);
  const nextAnchor = rest.indexOf('<!-- anchor:');
  let end = rest.length;
  if (heading !== null) end = Math.min(end, heading.index);
  if (nextAnchor >= 0) end = Math.min(end, nextAnchor);
  return rest.slice(0, end);
}

/** The YAML frontmatter block of a markdown file, or null when there is none. */
function frontmatterOf(text: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  return m === null ? null : m[1];
}

/**
 * The `criterion` field of a goal record, folded back into one line.
 *
 * `criterion:` is a plain YAML scalar that wraps across lines (e.g. `goals/AC-391-…md:8-9`), so
 * line-wise grepping for a path finds zero hits. A plain multi-line scalar folds each newline
 * (plus its indentation) into one space, so joining the start line with its indented continuation
 * lines and collapsing whitespace reproduces the value the reader sees.
 */
function criterionOf(text: string): string | null {
  const frontmatter = frontmatterOf(text);
  if (frontmatter === null) return null;
  const lines = frontmatter.split('\n');
  const start = lines.findIndex((line) => /^criterion:/.test(line));
  if (start < 0) return null;
  const parts = [lines[start].replace(/^criterion:[ \t]*/, '')];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      parts.push('');
      continue;
    }
    if (/^[ \t]/.test(line)) {
      parts.push(line);
      continue;
    }
    break;
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

type MatrixRow = { ac: string; file: string };

/**
 * Parse the SPEC §15 acceptance matrix — the table whose header is
 * `| AC | 阶段 | 判据文件 | 激活 |` — into `{ ac, file }` rows, taking the backticked path from
 * the third column. Anchored on the exact header line so the other AC tables in the document
 * (§13.1) are never mis-parsed.
 */
function parseSpecMatrix(specText: string): MatrixRow[] {
  const lines = specText.split('\n');
  const headerIndex = lines.findIndex((line) => line.trim() === '| AC | 阶段 | 判据文件 | 激活 |');
  assert.ok(headerIndex >= 0, 'SPEC §15 matrix header `| AC | 阶段 | 判据文件 | 激活 |` not found');
  const rows: MatrixRow[] = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    if (/^\|\s*-/.test(line)) continue; // the `|---|---|---|---|` separator
    const cells = line.split('|');
    const ac = (cells[1] ?? '').trim();
    const match = /`([^`]+)`/.exec(cells[3] ?? '');
    if (ac === '' || match === null) continue;
    rows.push({ ac, file: match[1] });
  }
  return rows;
}

function readDoc(file: string): string {
  return readFileSync(file, 'utf8');
}

// (a) every anchor is present, and in the document that owns it.
test('AC-391(a): all seven stable anchors are present, each in the document that owns it', () => {
  const texts: Record<DocKey, string> = {
    'id-relations': readDoc(ID_RELATIONS),
    'resident-sessions': readDoc(RESIDENT_SESSIONS),
  };
  const missing: string[] = [];
  let present = 0;
  for (const spec of ANCHORS) {
    if (texts[spec.doc].includes(spec.anchor)) present += 1;
    else missing.push(`${spec.doc}: ${spec.anchor}`);
  }
  console.log(`anchorsPresent=${present} anchorsMissing=${missing.length}`);
  assert.equal(missing.length, 0, `anchors missing from their document: ${missing.join('; ')}`);
  assert.equal(present, 7, `expected 7 anchors, found ${present}`);
});

// (b) each anchor's slice carries its numbered references — anchor-located, never a full grep.
test('AC-391(b): each anchor\'s slice carries its numbered references', () => {
  const texts: Record<DocKey, string> = {
    'id-relations': readDoc(ID_RELATIONS),
    'resident-sessions': readDoc(RESIDENT_SESSIONS),
  };
  const missingRefs: string[] = [];
  let sectionsChecked = 0;
  for (const spec of ANCHORS) {
    sectionsChecked += 1;
    const slice = sliceAfterAnchor(texts[spec.doc], spec.anchor);
    if (slice === null) {
      missingRefs.push(`${spec.anchor}: anchor absent`);
      continue;
    }
    if (slice.trim() === '') {
      missingRefs.push(`${spec.anchor}: empty section`);
      continue;
    }
    for (const ref of spec.refs) {
      if (!slice.includes(ref)) missingRefs.push(`${spec.anchor}: missing ${ref}`);
    }
  }
  console.log(`sectionsChecked=${sectionsChecked} refsMissing=${missingRefs.length}`);
  assert.equal(missingRefs.length, 0, `references missing inside anchor slices: ${missingRefs.join('; ')}`);
});

// (c) the §15 matrix files exist, and each is quoted verbatim by a goal criterion.
test('AC-391(c): the SPEC §15 matrix files exist and each is quoted by a goals/AC-*.md criterion', () => {
  const rows = parseSpecMatrix(readDoc(SPEC));
  const files = rows.map((row) => row.file);
  const uniqueFiles = new Set(files);
  const duplicateCount = files.length - uniqueFiles.size;

  const goalFiles = readdirSync(GOALS_DIR).filter((name) => /^AC-.*\.md$/.test(name));
  const criteria: string[] = [];
  for (const name of goalFiles) {
    const criterion = criterionOf(readDoc(path.join(GOALS_DIR, name)));
    if (criterion !== null) criteria.push(criterion);
  }

  const filesMissing: string[] = [];
  const notQuoted: string[] = [];
  for (const file of files) {
    if (!existsSync(path.join(REPO_ROOT, file))) filesMissing.push(file);
    if (!criteria.some((criterion) => criterion.includes(file))) notQuoted.push(file);
  }

  console.log(
    `matrixFiles=${files.length} filesMissing=${filesMissing.length} criterionQuoted=${files.length - notQuoted.length}`,
  );
  assert.equal(duplicateCount, 0, `the matrix repeats a criterion file path ${duplicateCount} time(s)`);
  assert.equal(files.length, 15, `the matrix must list 15 criterion files (AC-377..AC-391), got ${files.length}`);
  assert.deepEqual(
    rows.map((row) => row.ac).sort(),
    Array.from({ length: 15 }, (_, i) => `AC-${377 + i}`).sort(),
    'the matrix AC column must be exactly AC-377..AC-391 (no extra or missing row)',
  );
  assert.equal(filesMissing.length, 0, `matrix files missing on disk: ${filesMissing.join(', ')}`);
  assert.equal(
    notQuoted.length,
    0,
    `matrix files not quoted verbatim by any goals/AC-*.md criterion: ${notQuoted.join(', ')}`,
  );
});
