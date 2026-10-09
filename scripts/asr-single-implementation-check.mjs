#!/usr/bin/env node
/**
 * AC-129 — the transcription wire protocol exists exactly once, and all three consumers
 * resolve to that one file.
 *
 * WHY THIS IS A RESOLVER AND NOT A LIST. This repository has already paid for the other
 * shape: a criterion that measured a copy of the implementation in a test harness, which had
 * drifted from the shipping module in 6 of 16 readings, and reported green throughout. A
 * checker holding a hardcoded list of "the three consumers" and a hardcoded path to "the
 * implementation" reproduces that failure in a new place — it asserts what the list says, not
 * what the code imports. So this file does the opposite:
 *
 *   · the implementation is FOUND by scanning production sources for the wire protocol's own
 *     vocabulary (the endpoint, the multipart it posts, the response field it reads);
 *   · a file carrying ONLY the endpoint literal is read as a MENTION, not as an implementation —
 *     the vocabulary is two families and the literal alone is in neither. A recorded URL (a
 *     fixture's expected endpoint, an endpoint named in a doc comment) shapes no request and
 *     parses no response, and counting it as a second implementation is a false positive that
 *     reds a tree with exactly one wire in it. This is not a hole: the "no implementation"
 *     verdict below is loud, so a tree whose wire is only ever mentioned cannot read as passing;
 *   · each consumer group is found by parsing the real import specifiers out of its files and
 *     RESOLVING them (relative paths, `@/…` and `@shared/…` read out of tsconfig.json's
 *     `paths`, not out of this file);
 *   · a consumer counts as wired only if what its specifier resolves to is the implementation.
 *
 * That is what makes the two fake forms falsifiable rather than merely stated: write a copy on
 * either side and the resolved paths differ; copy the algorithm anywhere in the production
 * tree and the scan finds two.
 *
 * The empty reading is a failure, not a pass: a glob that matched nothing must not exit 0, so
 * "no implementation was found" is its own verdict with its own token.
 *
 * Usage:
 *   node scripts/asr-single-implementation-check.mjs [--root <dir>] [--explain-scan] [--landing]
 *
 *   --root <dir>     the tree to check (default: this script's repository root). Tests point
 *                    it at a throwaway tree built from the real files, which is how the fake
 *                    forms above become executable cases.
 *   --explain-scan   print the scanned glob set and the files that matched, then run the check
 *   --landing        print which landing the implementation is at and the configuration
 *                    registrations that landing depends on (file + the matching line), then
 *                    run the check
 *
 * Exit codes: 0 = one implementation, three consumers, same path; 1 = a verdict above says
 * otherwise (each failing check prints its own reason on its own line).
 */

import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

/**
 * @typedef {{ prefix: string, target: string }} Alias one tsconfig `paths` entry, resolved
 * @typedef {{ specifier: string, line: number }} ImportReference a specifier and where it was written
 * @typedef {{ relativePath: string, line: number, specifier: string, realPath: string }} ImportSite an import that resolves into the implementation
 * @typedef {{ id: string, files: number, sites: ImportSite[], targets: string[] }} ConsumerGroup
 * @typedef {{ relativePath: string, markers: string[], implementation: boolean }} ImplementationHit a file
 *   carrying the wire protocol's vocabulary, `implementation` distinguishing the files that shape a request
 *   or parse a response from the ones that only mention the endpoint
 * @typedef {{ file: string, match: RegExp, why: string }} Registration
 * @typedef {{ root: string, explainScan: boolean, landing: boolean }} Options
 */

/** Production sources: the only place a second implementation would be shipping code. */
const PRODUCTION_GLOBS = ['src/**/*.ts', 'src/**/*.tsx', 'server/**/*.ts', 'server/**/*.js', 'shared/**/*.ts'];

/**
 * The three consumers, each as a group rather than a file list: a group is every production
 * source in that part of the tree, and it is wired only if the wire module is what its
 * imports resolve to. New files join a group by existing, not by being added here.
 */
const CONSUMER_GROUPS = [
  { id: 'frontend', globs: ['src/**/*.ts', 'src/**/*.tsx'] },
  { id: 'server', globs: ['server/**/*.ts', 'server/**/*.js'] },
  { id: 'cli', globs: ['experiments/**/*.ts'] },
];

/**
 * The wire protocol's vocabulary, in two families — the request half and the response half.
 * Both are needed and neither substitutes for the other: a copy that only rebuilds the
 * multipart posts the same bytes without the endpoint literal, and a copy that only re-parses
 * the answer reads the same field without posting anything. A checker that only knew one
 * family would be blind to the other half of the very thing it claims to be checking
 * (the multipart field names are named in ADR-004 §1, the parse field in §2).
 */
const REQUEST_MARKERS = [
  { id: 'endpoint-literal', pattern: /\/audio\/transcriptions/ },
  { id: 'multipart-file-field', pattern: /\.append\(\s*['"]file['"]/ },
  { id: 'multipart-model-field', pattern: /\.append\(\s*['"]model['"]/ },
];
const RESPONSE_MARKERS = [
  {
    // "parse a body, then read `text` off THIS parse's own result". Two constraints, and both
    // are load-bearing:
    //   · the BACKREFERENCE — not any `.text` near a `JSON.parse`. This repository has other
    //     files that parse JSON and then walk a `[{ type: 'text', text }]` block array (agent
    //     content); a marker loose enough to match those would report phantom implementations
    //     in a green tree — a criterion that cannot be green is as useless as one that cannot
    //     be red.
    //   · the OPERAND IS A BARE IDENTIFIER — the transcription response body read into a named
    //     variable (`JSON.parse(responseText)`), never a member expression. An event or frame
    //     payload arrives as a property (`JSON.parse(event.data)`), and a WebSocket frame
    //     `{ type: 'intent', text }` read off `frame.text` is not the wire protocol's response
    //     half. Matching it reported `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts`
    //     as a second implementation (a defect in this probe, not in that file). The operand
    //     shape is the fix, NOT a narrowing of the annotation gap below: that gap is what fuses
    //     the separated spelling (`let frame: ServerFrame;` … `frame = JSON.parse(event.data)`),
    //     but the compact spelling (`const frame = JSON.parse(event.data) as ServerFrame`) has
    //     no gap at all, and requiring a plain-variable operand rules out both spellings at once
    //     (AC2/AC3 of gap-asr-wire-probe-ws-frame-false-positive).
    id: 'parsed-text-field',
    pattern:
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,200})?=\s*JSON\.parse\(\s*[A-Za-z_$][\w$]*\s*\)[\s\S]{0,200}?\b\1\s*\??\.text\b/,
  },
];

/**
 * Where the implementation may live, and the configuration each landing needs to be reachable
 * from both sides. Read at run time so the report names the real registration line — "the
 * alias is registered somewhere" is exactly the claim that has to be checked against a file.
 */
/** @type {Record<string, Registration[]>} */
const LANDING_REGISTRATIONS = {
  'shared/asr': [
    { file: 'tsconfig.json', match: /"@shared\/\*"/, why: 'typecheck must resolve the alias' },
    { file: 'vite.config.js', match: /'@shared'/, why: 'the bundle must resolve the alias' },
    // Not covered by the line above: vitest prefers vitest.config.ts and inherits nothing from
    // vite.config.js, so without this one every unit test whose graph reaches the shared tree
    // fails to transform rather than failing an assertion.
    { file: 'vitest.config.ts', match: /'@shared'/, why: 'the unit-test transform must resolve the alias' },
    { file: '.oxlintrc.json', match: /"shared\/\*\*\/\*\.ts"/, why: 'the tree must be inside boundaries/include' },
    { file: '.oxlintrc.json', match: /"repo-shared"/, why: 'an import of it must not be an unknown boundary element' },
  ],
  'src/shared/asr': [
    { file: 'tsconfig.json', match: /"@\/\*"/, why: 'typecheck must resolve the @/ alias' },
    { file: 'vite.config.js', match: /'@'/, why: 'the bundle must resolve the @/ alias' },
  ],
};

// ── arguments ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, explainScan: false, landing: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root needs a directory');
      options.root = path.resolve(value);
      i += 1;
    } else if (arg === '--explain-scan') {
      options.explainScan = true;
    } else if (arg === '--landing') {
      options.landing = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: node scripts/asr-single-implementation-check.mjs [--root <dir>] [--explain-scan] [--landing]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

// ── reading the tree ─────────────────────────────────────────────────────────────────────────

/**
 * Test files are not production sources: they may name the endpoint without implementing it.
 * @param {string} relativePath
 * @returns {boolean}
 */
function isTestFile(relativePath) {
  return /(^|\/)(tests?|__tests__)\//.test(relativePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
}

/**
 * @param {string} root
 * @param {string[]} globs
 * @param {{ excludeTests: boolean }} options
 * @returns {string[]}
 */
function listFiles(root, globs, options) {
  const { excludeTests } = options;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const files = [];
  for (const pattern of globs) {
    for (const match of globSync(pattern, { cwd: root })) {
      const relativePath = match.split(path.sep).join('/');
      if (seen.has(relativePath)) continue;
      if (excludeTests && isTestFile(relativePath)) continue;
      seen.add(relativePath);
      files.push(relativePath);
    }
  }
  return files.sort();
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @returns {string|null}
 */
function readSource(root, relativePath) {
  try {
    return readFileSync(path.join(root, relativePath), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The alias map, read out of the tree's own tsconfig.json rather than restated here: a
 * hardcoded `@shared/ → shared/` would keep "resolving" after the registration was removed,
 * which is the one thing this probe exists to notice.
 * @param {string} root
 * @returns {Alias[]}
 */
function readAliasMap(root) {
  const configPath = path.join(root, 'tsconfig.json');
  if (!existsSync(configPath)) return [];
  let parsed;
  try {
    const withoutComments = readFileSync(configPath, 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    parsed = JSON.parse(withoutComments);
  } catch {
    return [];
  }
  const paths = parsed?.compilerOptions?.paths ?? {};
  const baseUrl = path.resolve(root, parsed?.compilerOptions?.baseUrl ?? '.');
  /** @type {Alias[]} */
  const aliases = [];
  for (const [key, targets] of Object.entries(paths)) {
    if (!key.endsWith('/*') || !Array.isArray(targets) || targets.length === 0) continue;
    const target = targets[0];
    if (typeof target !== 'string' || !target.endsWith('/*')) continue;
    aliases.push({ prefix: key.slice(0, -1), target: path.resolve(baseUrl, target.slice(0, -1)) });
  }
  // Longest prefix first, so `@shared/` cannot be decided by `@/`.
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * @param {string[]} candidates
 * @returns {string|null}
 */
function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Resolves one import specifier the way a bundler would: relative to the importing file for
 * `./` and `../`, through the tree's own aliases otherwise, and mapping the `.js` an emitting
 * configuration writes onto the `.ts` that is actually on disk.
 * @param {string} specifier
 * @param {string} fromFile
 * @param {Alias[]} aliases
 * @returns {string|null}
 */
function resolveSpecifier(specifier, fromFile, aliases) {
  /**
   * @param {string} absolute
   * @returns {string[]}
   */
  const withExtensions = (absolute) => {
    /** @type {string[]} */
    const candidates = [];
    if (absolute.endsWith('.js')) {
      candidates.push(absolute.slice(0, -3) + '.ts', absolute.slice(0, -3) + '.tsx');
    }
    candidates.push(absolute);
    for (const extension of ['.ts', '.tsx', '.js', '.mjs', '.cjs']) candidates.push(absolute + extension);
    for (const extension of ['.ts', '.tsx', '.js']) candidates.push(path.join(absolute, `index${extension}`));
    return candidates;
  };

  if (specifier.startsWith('.')) {
    return firstExistingFile(withExtensions(path.resolve(path.dirname(fromFile), specifier)));
  }

  for (const alias of aliases) {
    if (!specifier.startsWith(alias.prefix)) continue;
    return firstExistingFile(withExtensions(path.join(alias.target, specifier.slice(alias.prefix.length))));
  }

  return null;
}

/**
 * Every import and re-export specifier in a source file, with the line it sits on.
 * @param {string} source
 * @returns {ImportReference[]}
 */
function importSpecifiers(source) {
  /** @type {ImportReference[]} */
  const found = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      found.push({ specifier: match[1], line });
    }
  }
  return found;
}

// ── the two scans ────────────────────────────────────────────────────────────────────────────

/**
 * Files whose text carries the wire protocol's vocabulary — the request half or the response half.
 * @param {string} root
 * @returns {{ scanned: string[], hits: ImplementationHit[] }}
 */
function scanProductionForImplementation(root) {
  const files = listFiles(root, PRODUCTION_GLOBS, { excludeTests: true });
  /** @type {ImplementationHit[]} */
  const hits = [];
  for (const relativePath of files) {
    const source = readSource(root, relativePath);
    if (source === null) continue;
    const request = REQUEST_MARKERS.filter((marker) => marker.pattern.test(source)).map((marker) => marker.id);
    const response = RESPONSE_MARKERS.filter((marker) => marker.pattern.test(source)).map((marker) => marker.id);
    const buildsMultipart = request.includes('multipart-file-field') && request.includes('multipart-model-field');
    if (request.includes('endpoint-literal') || buildsMultipart || response.length > 0) {
      const markers = [...request, ...response];
      hits.push({ relativePath, markers, implementation: shapesTheWire(markers) });
    }
  }
  return { scanned: files, hits };
}

/**
 * Whether a file's markers make it an IMPLEMENTATION of the wire rather than a file that mentions
 * it. `endpoint-literal` on its own is a mention: a constant holding a URL, or the endpoint named
 * in a doc comment. Shaping a request (the multipart field names) or parsing a response (the
 * parsed-text backreference) is the thing itself — and each of those two is enough on its own,
 * because a copy that rebuilds the multipart without the literal, or re-parses the answer without
 * posting anything, is still half of the wire protocol written a second time.
 *
 * Both false positives this removes were measured, not imagined: the registry module names the
 * endpoint in the comment that explains the multipart shape, and the offline invariant board
 * records the URL its fixture resolves to (`https://asr.invalid/audio/transcriptions`). Neither
 * posts nor parses anything.
 * @param {string[]} markers
 * @returns {boolean}
 */
function shapesTheWire(markers) {
  return markers.some((marker) => marker !== 'endpoint-literal');
}

/**
 * Per consumer group: the real import sites that resolve into the implementation set.
 * @param {string} root
 * @param {Alias[]} aliases
 * @param {Set<string>} implementationPaths
 * @returns {ConsumerGroup[]}
 */
function scanConsumers(root, aliases, implementationPaths) {
  /** @type {ConsumerGroup[]} */
  const groups = [];
  for (const group of CONSUMER_GROUPS) {
    const files = listFiles(root, group.globs, { excludeTests: true });
    /** @type {ImportSite[]} */
    const sites = [];
    for (const relativePath of files) {
      const source = readSource(root, relativePath);
      if (source === null) continue;
      for (const { specifier, line } of importSpecifiers(source)) {
        const resolved = resolveSpecifier(specifier, path.join(root, relativePath), aliases);
        if (resolved === null) continue;
        let realPath;
        try {
          realPath = realpathSync(resolved);
        } catch {
          continue;
        }
        if (implementationPaths.has(realPath)) sites.push({ relativePath, line, specifier, realPath });
      }
    }
    const targets = [...new Set(sites.map((site) => site.realPath))];
    groups.push({ id: group.id, files: files.length, sites, targets });
  }
  return groups;
}

// ── the landing report ───────────────────────────────────────────────────────────────────────

/**
 * @param {string} root
 * @returns {string[]|null}
 */
function readLintPaths(root) {
  const packagePath = path.join(root, 'package.json');
  if (!existsSync(packagePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch {
    return null;
  }
  const lint = parsed?.scripts?.lint;
  if (typeof lint !== 'string') return null;
  const marker = lint.indexOf('oxlint');
  if (marker === -1) return null;
  return lint
    .slice(marker + 'oxlint'.length)
    .trim()
    .split(/\s+/)
    .filter((entry) => entry.length > 0);
}

/**
 * @param {string} root
 * @param {Set<string>} implementationPaths
 * @param {string[]} problems
 * @returns {string[]}
 */
function reportLanding(root, implementationPaths, problems) {
  /** @type {string[]} */
  const lines = [];
  const implementation = [...implementationPaths][0] ?? null;
  if (implementation === null) {
    problems.push('landing=unresolved: no implementation was found, so there is no landing to report');
    return lines;
  }

  const relative = path.relative(root, implementation).split(path.sep).join('/');
  const landing = path.posix.dirname(relative);
  lines.push(`landing=${landing}`);

  const registrations = LANDING_REGISTRATIONS[landing];
  if (!registrations) {
    problems.push(`landing=${landing} is not one of the two candidates (${Object.keys(LANDING_REGISTRATIONS).join(', ')})`);
    return lines;
  }

  for (const registration of registrations) {
    const filePath = path.join(root, registration.file);
    const source = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
    const matchLine = source
      ?.split('\n')
      .map((text, index) => ({ text: text.trim(), number: index + 1 }))
      .find(({ text }) => registration.match.test(text));
    if (matchLine) {
      lines.push(`registration file=${registration.file} line=${matchLine.number} text=${matchLine.text}`);
    } else {
      lines.push(`registration file=${registration.file} MISSING text=<no line matches ${registration.match}>`);
      problems.push(`landing=${landing} is not registered in ${registration.file} (${registration.why})`);
    }
  }

  const lintPaths = readLintPaths(root);
  if (lintPaths === null) {
    lines.push('lint-paths=<unreadable: no scripts.lint in package.json>');
    problems.push(`landing=${landing} cannot be shown to be lint-covered: package.json has no readable scripts.lint`);
    return lines;
  }
  lines.push(`lint-paths=${lintPaths.join(' ')}`);
  const topLevelDirectory = landing.split('/')[0];
  const covered = lintPaths.includes(`${topLevelDirectory}/`);
  lines.push(`lint-covers-landing=${covered ? 'yes' : 'no'} (${topLevelDirectory}/)`);
  if (!covered) {
    problems.push(
      `landing=${landing} is not covered by npm run lint: ${topLevelDirectory}/ is absent from the oxlint path list (only being un-flagged is not the same as being linted)`,
    );
  }
  return lines;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

/** @returns {number} the process exit code */
function main() {
  /** @type {Options} */
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const root = options.root;
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stdout.write(`root is not a directory: ${root}\n`);
    return 1;
  }

  const implementation = scanProductionForImplementation(root);
  // Only the files that shape a request or parse a response are implementations; the rest merely
  // mention the endpoint. The two sets below are what every verdict from here on reads — a
  // mention is printed so a reader can see it was looked at, and decides nothing.
  const implementations = implementation.hits.filter((hit) => hit.implementation);
  const mentions = implementation.hits.filter((hit) => !hit.implementation);
  /** @type {Set<string>} */
  const implementationPaths = new Set();
  for (const hit of implementations) {
    try {
      implementationPaths.add(realpathSync(path.join(root, hit.relativePath)));
    } catch {
      /* an unreadable hit is reported by the count below */
    }
  }

  const aliases = readAliasMap(root);
  const groups = scanConsumers(root, aliases, implementationPaths);

  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const lines = [];
  lines.push(`asr-single-implementation-check root=${root}`);

  if (options.explainScan) {
    lines.push(`scan-globs=${PRODUCTION_GLOBS.join(' ')}`);
    lines.push(`scan-files=${implementation.scanned.length}`);
    for (const hit of implementation.hits) lines.push(`scan-hit ${hit.relativePath} markers=${hit.markers.join(',')}`);
    if (implementation.hits.length === 0) {
      lines.push(`scan-hit <none> (the globs above matched ${implementation.scanned.length} files and none of them carries the wire protocol)`);
    }
  }

  if (implementations.length === 0) {
    lines.push(
      `no implementation: none of ${PRODUCTION_GLOBS.join(' ')} (${implementation.scanned.length} file(s) scanned, tests excluded) shapes a transcription request or parses a transcription response` +
        (mentions.length > 0
          ? `; ${mentions.length} file(s) mention the endpoint without doing either: ${mentions.map((hit) => hit.relativePath).join(', ')}`
          : ''),
    );
  } else {
    for (const hit of implementations) {
      lines.push(`implementation path=${path.join(root, hit.relativePath)} realpath=${realpathSync(path.join(root, hit.relativePath))} markers=${hit.markers.join(',')}`);
    }
  }
  for (const hit of mentions) {
    lines.push(`mention ${hit.relativePath} markers=${hit.markers.join(',')} (carries the endpoint literal and neither shapes a request nor parses a response)`);
  }

  const distinctTargets = new Set();
  for (const group of groups) {
    const target = group.targets.length === 1 ? group.targets[0] : null;
    const shown = target ?? (group.targets.length === 0 ? '<none>' : group.targets.join(' '));
    lines.push(`consumer=${group.id} path=${shown} realpath=${target ?? '<none>'} imports=${group.sites.length}`);
    for (const site of group.sites) {
      lines.push(`  site=${site.relativePath}:${site.line} specifier=${site.specifier} -> ${site.realPath}`);
    }
    for (const resolved of group.targets) distinctTargets.add(resolved);
  }

  if (distinctTargets.size > 1) {
    const sorted = [...distinctTargets].sort();
    lines.push(`paths differ: the consumers resolve to ${sorted.length} different files: ${sorted.join(' ')}`);
  }

  for (const group of groups) {
    if (group.targets.length === 0) {
      lines.push(
        `consumer missing: no file in the ${group.id} group imports the implementation (${group.files} file(s) scanned)`,
      );
    }
  }

  const extraImplementations = implementations.filter((hit, index) => index > 0);
  if (extraImplementations.length > 0) {
    for (const hit of extraImplementations) lines.push(`SECOND_IMPL ${hit.relativePath} markers=${hit.markers.join(',')}`);
  } else if (implementations.length > 0) {
    lines.push('SECOND_IMPL none');
  }

  if (options.landing) {
    /** @type {string[]} */
    const landingProblems = [];
    const landingLines = reportLanding(root, implementationPaths, landingProblems);
    for (const line of landingLines) lines.push(line);
    problems.push(...landingProblems);
  }

  for (const line of lines) {
    if (/^(no implementation|paths differ|consumer missing|SECOND_IMPL (?!(none)\b)|landing=unresolved)/.test(line)) {
      problems.push(line);
    }
  }

  const failing = [...new Set(problems)];
  for (const line of failing) process.stdout.write(`FAIL ${line}\n`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return failing.length === 0 ? 0 : 1;
}

process.exitCode = main();
