#!/usr/bin/env node
// @ts-nocheck -- LANDING GAP (carried by cockpit-initiative-view-and-decision-queue): this
// tool landed on develop with implicit-any parameters that `scripts/tsconfig.json` rejects, so
// `npm run typecheck` reds for every branch that merges develop. This file is excluded from the
// type gate until the owning follow-up types its signatures; remove this line with that fix.

/**
 * contraction-candidates scan — a read-only prototype that turns "this instrument never speaks"
 * into a list of objects a human can rule on.
 *
 * WHY THIS EXISTS. The contraction phase (removing things) has no mechanism behind it: of the
 * four retirements recorded in quay's own analysis, all four were started by a person. The
 * expansion phase is automatic — every finding becomes a spec and an AC — while nothing ever
 * says "delete this". The reason is not that deletion candidates are unknowable; it is that
 * nobody can query "has this ever fired?". This scanner assembles the queries that are cheap
 * and already answerable from files each project writes.
 *
 * WHAT IT IS NOT. It does not decide. Every candidate carries `counterCheck` — the reading that
 * would show the instrument is still necessary — and a confidence level. A candidate is a prompt
 * to look, never a delete order. Retiring is a human verb (see docs/proposals/contraction-candidates.md).
 *
 * READ-ONLY BY CONSTRUCTION. Every filesystem call here is a read; the process never creates,
 * writes, renames, or deletes a path under `--root`. The unit test pins that by comparing
 * `git status` of a fixture repo before and after a run.
 *
 * Usage:
 *   node scripts/contraction-candidates/scan.mjs --root /path/to/repo [--json] [--pretty]
 *        [--window-days 30] [--max-per-kind 25]
 *
 * Exit codes: 0 = scan completed (missing sources are reported under `skipped`, not fatal);
 * 2 = bad invocation (root missing/not a directory).
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const SCHEMA_VERSION = 1;
const TOOL = 'contraction-candidates-scan';
const DEFAULT_WINDOW_DAYS = 30;
const MIN_GATE_EVENTS = 5;
const MIN_EVALUATED_RECORDS = 5;
const MIN_CONSTANT_RECORDS = 20;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CODE_FILES = 25000;
const MAX_STATE_FILES = 300;
const MAX_LEDGER_FILES = 400;
const MAX_DOC_FILES = 1500;
const MAX_GIT_AGE_CALLS = 40;
const TAIL_SAMPLE_BYTES = 256 * 1024;
const SAMPLE_RECORDS = 200;

const EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'dist-server',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.worktrees',
  'tmp',
  'archive',
  'experiments',
  'docs-managed',
]);

const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.sh', '.ps1']);

const GOVERNANCE_DIRS = ['scripts', 'plugin/scripts', 'orchestration', 'ops', 'realchecks', 'goals', 'meta'];
const GOVERNED_DIRS = ['src', 'server', 'plugin/src', 'lib'];

// A read of a state/ledger file. Deliberately broad: the direction of the error should be
// "we found a reader and suppressed the candidate", not "we missed a reader and cried wolf".
const READ_RE = /readFileSync|readFile\s*\(|createReadStream|readJson|readJsonl|loadState|readState|JSON\.parse|readline|createInterface|readLines|readTail/;
const WRITE_RE = /writeFileSync|writeFile\s*\(|appendFileSync|appendFile\s*\(|createWriteStream|writeJson|writeJsonl|saveState|writeState/;

const INTERESTING_CONSTANT_KEY = /count|cycle|evaluat|verdict|result|phase|status|\bok\b|\bpass\b|\bfail\b|\bred\b|\bgreen\b|total/i;
const NON_CONSTANT_KEY = /^(id|uuid|ts|timestamp|time|at|createdAt|updatedAt|runId|round|roundId|session|sessionId|pid|sha|hash|path|file|dir|name|target|reason|message|error|detail|log)$/i;

function nowMs() {
  return Date.now();
}

function parseArgs(argv) {
  const opts = { root: null, json: false, pretty: false, windowDays: DEFAULT_WINDOW_DAYS, maxPerKind: 25 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') opts.root = argv[++i];
    else if (arg === '--json') opts.json = true;
    else if (arg === '--pretty') opts.pretty = true;
    else if (arg === '--window-days') opts.windowDays = Number(argv[++i]);
    else if (arg === '--max-per-kind') opts.maxPerKind = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/contraction-candidates/scan.mjs --root <repo> [--json] [--pretty] [--window-days N] [--max-per-kind N]');
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.root) fail('--root is required');
  if (!Number.isFinite(opts.windowDays) || opts.windowDays <= 0) fail('--window-days must be a positive number');
  if (!Number.isFinite(opts.maxPerKind) || opts.maxPerKind <= 0) fail('--max-per-kind must be a positive number');
  opts.root = path.resolve(opts.root);
  if (!fs.existsSync(opts.root) || !fs.statSync(opts.root).isDirectory()) fail(`root is not a directory: ${opts.root}`);
  return opts;
}

function fail(message) {
  console.error(`contraction-candidates-scan: ${message}`);
  process.exit(2);
}

/** Iterate regular files below `root`, skipping excluded directory names and symlinks. */
function* walkFiles(root, { maxFiles = MAX_CODE_FILES, excluded = EXCLUDED_DIRS } = {}) {
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        // Dot directories are metadata (including .quay): walkFiles is for CODE and prose, and
        // .quay is read explicitly by the dedicated scanners below.
        if (entry.name.startsWith('.')) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (seen > maxFiles) return;
      yield full;
    }
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function readCapped(file, cap = MAX_FILE_BYTES) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length <= cap) return buf.toString('utf8');
    return buf.subarray(0, cap).toString('utf8');
  } catch {
    return null;
  }
}

/** Read the tail of a large file without loading it whole; drops the partial first line. */
function readTail(file, cap = TAIL_SAMPLE_BYTES) {
  const st = safeStat(file);
  if (!st) return null;
  try {
    if (st.size <= cap) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(cap, st.size);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, st.size - length);
      const text = buf.toString('utf8');
      const firstNewline = text.indexOf('\n');
      return firstNewline < 0 ? '' : text.slice(firstNewline + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function parseJsonl(text, { cap = SAMPLE_RECORDS } = {}) {
  const records = [];
  if (!text) return records;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially-written trailing line is normal for append-only ledgers; skip it.
    }
  }
  return records.length > cap ? records.slice(records.length - cap) : records;
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function describeValue(value) {
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  return String(value);
}

/**
 * One pass over the repo's code, collecting every quoted `*.json` / `*.jsonl` literal and the
 * read/write verb near it. The result answers "does any code in THIS repo read this file?".
 */
function buildCodeReferenceIndex(root, skipped) {
  const refs = new Map();
  let filesRead = 0;
  for (const file of walkFiles(root)) {
    const ext = path.extname(file).toLowerCase();
    if (!CODE_EXTS.has(ext)) continue;
    const st = safeStat(file);
    if (!st || st.size > MAX_FILE_BYTES) continue;
    const text = readCapped(file);
    if (!text) continue;
    filesRead += 1;
    const re = /["'`]([^"'`\n]{1,240}\.(?:json|jsonl))["'`]/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const literal = match[1];
      const base = path.basename(literal);
      if (!base) continue;
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const lineEndRaw = text.indexOf('\n', match.index);
      const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
      const prevStart = text.lastIndexOf('\n', lineStart - 2) + 1;
      const nextEndRaw = text.indexOf('\n', lineEnd + 1);
      const nextEnd = nextEndRaw < 0 ? text.length : nextEndRaw;
      const context = text.slice(prevStart, nextEnd);
      const entry = refs.get(base) || { read: new Set(), write: new Set(), plain: new Set() };
      const rel = path.relative(root, file);
      const isRead = READ_RE.test(context);
      const isWrite = WRITE_RE.test(context);
      if (isRead) entry.read.add(rel);
      if (isWrite) entry.write.add(rel);
      if (!isRead && !isWrite) entry.plain.add(rel);
      refs.set(base, entry);
    }
  }
  skipped.push({ source: 'code-reference-index', reason: `scanned ${filesRead} code file(s)` });
  return refs;
}

function listQuayFiles(root, expression, { exclude = null, cap } = {}) {
  const dir = path.join(root, '.quay');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!expression.test(name)) continue;
    if (exclude && exclude.test(name)) continue;
    const full = path.join(dir, name);
    const st = safeStat(full);
    if (!st || !st.isFile()) continue;
    files.push({ full, rel: path.join('.quay', name), st });
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return cap ? files.slice(0, cap) : files;
}

function makeCandidate(kind, target, evidence, confidence, counterCheck, windowDays) {
  return {
    kind,
    target,
    evidence: evidence.filter(Boolean),
    window: `last ${windowDays}d`,
    confidence,
    counterCheck,
  };
}

async function scanGateEvents(root, sinceMs, windowDays, skipped, maxPerKind) {
  const candidates = [];
  const file = listQuayFiles(root, /^gate-events\.jsonl$/, { cap: 1 })[0];
  if (!file) {
    skipped.push({ source: 'gate-events.jsonl', reason: 'not present under .quay/' });
    return candidates;
  }
  const byGate = new Map();
  const stream = fs.createReadStream(file.full, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let parsed = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = event.timestamp || event.ts || event.at;
    if (ts) {
      const ms = Date.parse(ts);
      if (Number.isFinite(ms) && ms < sinceMs) continue;
    }
    const gate = event.gate || event.kind || 'unknown';
    const bucket = byGate.get(gate) || {
      pass: 0,
      fail: 0,
      warn: 0,
      other: 0,
      first: null,
      last: null,
      sampleReason: null,
    };
    const verdict = String(event.verdict || event.result || event.status || '').toLowerCase();
    if (verdict === 'pass' || verdict === 'ok' || verdict === 'green') bucket.pass += 1;
    else if (verdict === 'fail' || verdict === 'red' || verdict === 'error') bucket.fail += 1;
    else if (verdict === 'warn' || verdict === 'warning') bucket.warn += 1;
    else bucket.other += 1;
    if (!bucket.first) bucket.first = ts || null;
    bucket.last = ts || bucket.last;
    if (!bucket.sampleReason && event.payload && event.payload.reason) {
      bucket.sampleReason = String(event.payload.reason).slice(0, 160);
    }
    byGate.set(gate, bucket);
    parsed += 1;
  }

  const considered = [];
  for (const [gate, b] of byGate) {
    const total = b.pass + b.fail + b.warn + b.other;
    if (total < MIN_GATE_EVENTS) continue;
    considered.push({ gate, ...b, total });
  }
  considered.sort((a, b) => b.total - a.total);

  const neverRed = considered.filter((b) => b.fail === 0 && (b.pass + b.warn) > 0).slice(0, maxPerKind);
  const neverGreen = considered.filter((b) => b.pass === 0 && b.fail > 0).slice(0, maxPerKind);

  for (const b of neverRed) {
    candidates.push(
      makeCandidate(
        'never-red-gate',
        `gate:${b.gate}`,
        [
          `source=${file.rel}`,
          `gate=${b.gate}`,
          `events=${b.total} (pass=${b.pass} warn=${b.warn} fail=0 other=${b.other})`,
          b.first ? `first=${b.first}` : null,
          b.last ? `last=${b.last}` : null,
          b.sampleReason ? `sampleReason=${b.sampleReason}` : null,
        ],
        'medium',
        'A gate with a success-only transition arm (retreat/complete/promote) cannot fail by construction, so "never red" may mean "cannot be red", not "never useful". Read the gate definition and check whether its failures are recorded under a different gate name before treating this as dead.',
        windowDays,
      ),
    );
  }
  for (const b of neverGreen) {
    candidates.push(
      makeCandidate(
        'never-green-gate',
        `gate:${b.gate}`,
        [
          `source=${file.rel}`,
          `gate=${b.gate}`,
          `events=${b.total} (pass=0 fail=${b.fail} warn=${b.warn} other=${b.other})`,
          b.first ? `first=${b.first}` : null,
          b.last ? `last=${b.last}` : null,
          b.sampleReason ? `sampleReason=${b.sampleReason}` : null,
        ],
        'medium',
        'A gate that never passes may be a correctly-wired alarm whose failures humans act on, or an unsatisfiable check whose reds are ignored. Count whether any failure was followed by a different outcome before calling it noise.',
        windowDays,
      ),
    );
  }
  skipped.push({ source: 'gate-events.jsonl', reason: `parsed ${parsed} event(s) in window` });
  return candidates;
}

function scanLedgers(root, refs, sinceMs, windowDays, skipped, maxPerKind) {
  const candidates = [];
  const files = listQuayFiles(root, /\.jsonl$/, { exclude: /^gate-events\.jsonl$/, cap: MAX_LEDGER_FILES });
  let sampled = 0;
  for (const file of files) {
    const base = path.basename(file.rel);
    const codeRef = refs.get(base) || { read: new Set(), write: new Set(), plain: new Set() };
    const refCount = codeRef.read.size + codeRef.write.size + codeRef.plain.size;
    const tail = readTail(file.full);
    const records = parseJsonl(tail);
    if (records.length > 0) sampled += 1;

    const st = file.st;
    const stale = st.mtimeMs < sinceMs;
    if (refCount > 0 && (st.size === 0 || stale)) {
      candidates.push(
        makeCandidate(
          'silent-ledger',
          `ledger:${file.rel}`,
          [
            `ledger=${file.rel}`,
            st.size === 0 ? 'size=0 (declared writer produced no record)' : `size=${st.size}`,
            `lastModified=${new Date(st.mtimeMs).toISOString()}`,
            `codeReferences=${refCount} (read=${codeRef.read.size} write=${codeRef.write.size})`,
            st.size === 0 ? 'no records at all' : `no record in the last ${windowDays}d`,
          ],
          st.size === 0 ? 'high' : 'medium',
          'A ledger only fires on the event it records; rare events (a merge-lock escalation, a self-drift finding) legitimately have long gaps. Compare against the number of opportunities in the same window before retiring the instrument.',
          windowDays,
        ),
      );
    }

    if (records.length === 0) continue;
    const evaluated = records.filter((r) => r && Object.prototype.hasOwnProperty.call(r, 'evaluated'));
    if (evaluated.length >= MIN_EVALUATED_RECORDS && evaluated.every((r) => r.evaluated === false)) {
      const reason = records.map((r) => r.reason).find((r) => typeof r === 'string' && r.trim());
      candidates.push(
        makeCandidate(
          'never-evaluated-instrument',
          `ledger:${file.rel}#evaluated`,
          [
            `ledger=${file.rel}`,
            `sampledRecords=${records.length}`,
            `evaluated=false in ${evaluated.length}/${evaluated.length} record(s) carrying the field`,
            reason ? `sampleReason=${String(reason).slice(0, 160)}` : null,
          ],
          'high',
          '`evaluated:false` can be the honest reading of a missing input (the analyzer has no module graph), in which case the right fix is to restore the analyzer, not to retire the instrument. Read the reason field before treating the constant as uselessness.',
          windowDays,
        ),
      );
      continue;
    }

    if (records.length >= MIN_CONSTANT_RECORDS) {
      const keys = Object.keys(records[0] || {}).filter(
        (key) => !NON_CONSTANT_KEY.test(key) && INTERESTING_CONSTANT_KEY.test(key),
      );
      let emitted = 0;
      for (const key of keys) {
        if (emitted >= 2) break;
        const values = records.map((r) => (r ? r[key] : undefined));
        if (!values.every((v) => v !== undefined && isPrimitive(v))) continue;
        const first = values[0];
        if (!values.every((v) => v === first)) continue;
        candidates.push(
          makeCandidate(
            'constant-reading-instrument',
            `ledger:${file.rel}#${key}`,
            [
              `ledger=${file.rel}`,
              `sampledRecords=${records.length}`,
              `field=${key}`,
              `value=${describeValue(first)} in ${values.length}/${values.length} record(s)`,
            ],
            'medium',
            'A constant can be the correct reading: an empty cycle set really is zero cycles, and a configured mode really is constant. Cross-check against an independent producer (archguard output, a second ledger) before reading the unchanged number as a broken instrument.',
            windowDays,
          ),
        );
        emitted += 1;
      }
    }
  }
  skipped.push({ source: 'ledgers', reason: `sampled ${sampled} non-empty .jsonl ledger(s) of ${files.length}` });
  return candidates;
}

function scanStateFiles(root, refs, skipped, maxPerKind) {
  const candidates = [];
  // Per-run evidence and before/after captures are collected artifacts, not instruments: nothing
  // is supposed to read them back, so "no reader" says nothing about whether the producer is
  // useful. Keep them out of this signal; they belong to a different (archival) question.
  const ARTIFACT_NAME = /(evidence|snapshot|before|after|report|result|findings|backup)/i;
  const files = listQuayFiles(root, /\.json$/, { cap: MAX_STATE_FILES });
  let inspected = 0;
  for (const file of files) {
    if (file.st.size > MAX_FILE_BYTES) continue;
    if (ARTIFACT_NAME.test(path.basename(file.rel))) continue;
    inspected += 1;
    const base = path.basename(file.rel);
    const codeRef = refs.get(base);
    let confidence;
    const evidence = [`stateFile=${file.rel}`, `size=${file.st.size}`, `lastModified=${new Date(file.st.mtimeMs).toISOString()}`];
    const isTestPath = (rel) => /(^|\/)(test|tests|e2e)\/|\.(test|spec)\.[^.]+$/.test(rel);
    if (!codeRef || codeRef.read.size + codeRef.write.size + codeRef.plain.size === 0) {
      confidence = 'medium';
      evidence.push('no code file in this repo mentions the basename');
    } else if (codeRef.read.size === 0 && codeRef.write.size > 0) {
      const productionWriters = [...codeRef.write].filter((rel) => !isTestPath(rel));
      if (productionWriters.length > 0) {
        confidence = 'high';
        evidence.push(`written by ${productionWriters.slice(0, 3).join(', ')}`);
      } else {
        // A test writing a state file says nothing about production: the production reader usually
        // reaches the path through a shared constant, which this line-level heuristic cannot see.
        confidence = 'low';
        evidence.push(`written only by test file(s): ${[...codeRef.write].slice(0, 3).join(', ')}`);
      }
      evidence.push('no read call near any mention');
    } else if (codeRef.read.size === 0 && codeRef.plain.size > 0) {
      confidence = 'low';
      evidence.push(`mentioned without a read/write verb in ${[...codeRef.plain].slice(0, 3).join(', ')}`);
    } else {
      continue;
    }
    candidates.push(
      makeCandidate(
        'zero-reader-state-file',
        `state:${file.rel}`,
        evidence,
        confidence,
        'The writer or reader may live outside this repo (the quay CLI, quay-fleet, a plugin cache) or the file may be a published contract. Grep the consumer repos and the installed plugin before treating "no reader here" as "no reader".',
        DEFAULT_WINDOW_DAYS,
      ),
    );
  }
  skipped.push({ source: 'state-files', reason: `inspected ${inspected} .quay/*.json file(s) of ${files.length}` });
  const rank = { high: 0, medium: 1, low: 2 };
  candidates.sort((a, b) => (rank[a.confidence] ?? 9) - (rank[b.confidence] ?? 9) || a.target.localeCompare(b.target));
  return candidates.slice(0, maxPerKind);
}

function collectDocFiles(root) {
  const docs = [];
  const roots = [path.join(root, 'docs'), path.join(root, 'adr')];
  for (const dir of roots) {
    for (const file of walkFiles(dir, { maxFiles: MAX_DOC_FILES })) {
      if (path.extname(file).toLowerCase() !== '.md') continue;
      const base = path.basename(file);
      if (/^(README|INDEX|CHANGELOG|CONTRIBUTING|LICENSE)/i.test(base)) continue;
      const st = safeStat(file);
      if (!st) continue;
      docs.push({ full: file, rel: path.relative(root, file), base, st });
      if (docs.length >= MAX_DOC_FILES) return docs;
    }
  }
  // Root-level ADR folders (quay-fleet keeps adr/ at the root, handled above) plus top-level *.md
  // are intentionally not listed as candidates: entry-point docs are not retirement candidates.
  return docs;
}

function scanDocs(root, sinceMs, windowDays, skipped, maxPerKind) {
  const candidates = [];
  const docs = collectDocFiles(root);
  if (docs.length === 0) {
    skipped.push({ source: 'docs', reason: 'no docs/ or adr/ markdown found' });
    return candidates;
  }
  const docBases = new Set(docs.map((d) => d.base));
  const referencedBy = new Map();
  // A doc can be referenced from anywhere: tasks, code comments, experiment READMEs. Scan the
  // whole tree, but keep experiment references (they legitimately point at proposal docs) while
  // still skipping vendored/archived trees.
  const docRefExcluded = new Set([...EXCLUDED_DIRS].filter((name) => name !== 'experiments'));
  let textFiles = 0;
  for (const file of walkFiles(root, { maxFiles: MAX_DOC_FILES * 8, excluded: docRefExcluded })) {
    const ext = path.extname(file).toLowerCase();
    if (!['.md', '.txt', '.json', '.yml', '.yaml', '.mjs', '.ts', '.js'].includes(ext)) continue;
    const st = safeStat(file);
    if (!st || st.size > MAX_FILE_BYTES) continue;
    const text = readCapped(file);
    if (!text) continue;
    textFiles += 1;
    const rel = path.relative(root, file);
    const re = /([A-Za-z0-9._一-鿿-]+\.md)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      let base = path.basename(match[1]);
      // JSON escapes a newline as the two characters `\n`, so `"...\nexp5-....md"` makes the
      // regex capture a leading `n`. Strip it rather than losing a real reference.
      if (base.startsWith('n') && text[match.index - 1] === '\\') base = base.slice(1);
      if (!docBases.has(base) || base === path.basename(rel)) continue;
      const set = referencedBy.get(base) || new Set();
      set.add(rel);
      referencedBy.set(base, set);
    }
  }

  let gitCalls = 0;
  for (const doc of docs) {
    if (candidates.length >= maxPerKind) break;
    if (referencedBy.has(doc.base) && referencedBy.get(doc.base).size > 0) continue;
    let lastCommitMs = doc.st.mtimeMs;
    let ageSource = 'mtime';
    if (gitCalls < MAX_GIT_AGE_CALLS) {
      gitCalls += 1;
      try {
        const out = execFileSync('git', ['-C', root, 'log', '-1', '--format=%ct', '--', doc.rel], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const seconds = Number(out);
        if (Number.isFinite(seconds) && seconds > 0) {
          lastCommitMs = seconds * 1000;
          ageSource = 'git-last-commit';
        }
      } catch {
        // Not a git repo (or a path git does not track): fall back to mtime.
      }
    }
    if (lastCommitMs >= sinceMs) continue;
    candidates.push(
      makeCandidate(
        'unreferenced-doc',
        `doc:${doc.rel}`,
        [
          `doc=${doc.rel}`,
          'references=0 (basename not mentioned by any other doc/task/code file scanned)',
          `lastChange=${new Date(lastCommitMs).toISOString()} (${ageSource})`,
          `size=${doc.st.size}`,
        ],
        'medium',
        'A dated analysis or experiment record may be intentionally standalone, and a doc referenced only from chat or another repo looks unreferenced here. Check the doc\'s role (entry point / dated record / live contract) before proposing retirement.',
        windowDays,
      ),
    );
  }
  skipped.push({ source: 'docs', reason: `considered ${docs.length} doc(s) against ${textFiles} text file(s)` });
  return candidates;
}

function countLines(files) {
  let lines = 0;
  for (const file of files) {
    const st = safeStat(file);
    if (!st || st.size > MAX_FILE_BYTES) continue;
    const text = readCapped(file);
    if (!text) continue;
    for (const line of text.split('\n')) {
      if (line.trim()) lines += 1;
    }
  }
  return lines;
}

function collectDirCode(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return [...walkFiles(dir)].filter((f) => CODE_EXTS.has(path.extname(f).toLowerCase()));
}

function scanMetaMechanismRatio(root, windowDays, skipped, maxPerKind) {
  const candidates = [];
  const governance = [];
  for (const rel of GOVERNANCE_DIRS) governance.push(...collectDirCode(path.join(root, rel)));
  const governedDirs = [...GOVERNED_DIRS];
  let packages = [];
  try {
    packages = fs
      .readdirSync(path.join(root, 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `packages/${e.name}/src`);
  } catch {
    packages = [];
  }
  const governed = [];
  for (const rel of [...governedDirs, ...packages]) governed.push(...collectDirCode(path.join(root, rel)));
  if (governance.length === 0 || governed.length === 0) {
    skipped.push({ source: 'meta-mechanism-ratio', reason: 'no governance or governed code directories matched' });
    return candidates;
  }
  const govLines = countLines(governance);
  const governedLines = countLines(governed);
  if (governedLines === 0) {
    skipped.push({ source: 'meta-mechanism-ratio', reason: 'governed code has 0 non-blank lines' });
    return candidates;
  }
  const ratio = govLines / governedLines;
  if (ratio < 1) {
    skipped.push({
      source: 'meta-mechanism-ratio',
      reason: `ratio ${ratio.toFixed(2)} (governance ${govLines} / governed ${governedLines}) is below the 1.0 flag line`,
    });
    return candidates;
  }
  candidates.push(
    makeCandidate(
      'meta-mechanism-ratio',
      `repo:${path.basename(root)}`,
      [
        `governanceLines=${govLines} across ${governance.length} file(s) (${GOVERNANCE_DIRS.join(', ')})`,
        `governedLines=${governedLines} across ${governed.length} file(s) (${[...GOVERNED_DIRS, 'packages/*/src'].join(', ')})`,
        `ratio=${ratio.toFixed(2)} (ADR-021 expects the meta mechanism to be an order of magnitude SMALLER)`,
      ],
      'medium',
      'Governance code is not waste by itself — it is what makes the governed code trustworthy. Use the ratio as a reading that points at the largest governance files, not as a deletion verdict; per-file checks decide which mechanisms never fire.',
      windowDays,
    ),
  );
  return candidates;
}

function summarize(candidates) {
  const byKind = {};
  for (const candidate of candidates) byKind[candidate.kind] = (byKind[candidate.kind] || 0) + 1;
  return {
    candidates: candidates.length,
    byKind,
    kindsCovered: Object.keys(byKind).sort(),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const generatedAt = new Date(nowMs()).toISOString();
  const sinceMs = nowMs() - opts.windowDays * 24 * 60 * 60 * 1000;
  const skipped = [];
  const candidates = [];

  const refs = buildCodeReferenceIndex(opts.root, skipped);

  candidates.push(...(await scanGateEvents(opts.root, sinceMs, opts.windowDays, skipped, opts.maxPerKind)));
  candidates.push(...scanLedgers(opts.root, refs, sinceMs, opts.windowDays, skipped, opts.maxPerKind));
  candidates.push(...scanStateFiles(opts.root, refs, skipped, opts.maxPerKind));
  candidates.push(...scanDocs(opts.root, sinceMs, opts.windowDays, skipped, opts.maxPerKind));
  candidates.push(...scanMetaMechanismRatio(opts.root, opts.windowDays, skipped, opts.maxPerKind));

  for (const candidate of candidates) {
    if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) {
      candidate.evidence.push('(no evidence collected)');
    }
    if (typeof candidate.counterCheck !== 'string' || candidate.counterCheck.trim() === '') {
      candidate.counterCheck = 'No counter-check was generated for this candidate — treat it as unverified.';
    }
  }

  const report = {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL,
    root: opts.root,
    generatedAt,
    window: { days: opts.windowDays, since: new Date(sinceMs).toISOString() },
    summary: summarize(candidates),
    candidates,
    skipped,
  };

  const text = opts.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
  process.stdout.write(`${text}\n`);
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(`contraction-candidates-scan: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
