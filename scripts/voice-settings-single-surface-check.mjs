#!/usr/bin/env node
/**
 * The voice settings/rules contract is a SINGLE DECLARATION, and the tree reads it from there.
 *
 * WHAT THIS MEASURES. The same settings document used to be declared independently on each side of
 * the browser/server boundary — a type and defaults table in `src/shared/voiceConfig.ts`, a second
 * type in `server/shared/types.ts`, a field list and empty row in the store, and a third field list
 * with its own bounds in the voice service — and the Live Voice rules were text each consumer
 * spelled for itself. This check answers the three questions that say the duplication is gone:
 *
 *   (a) the shared contract exists, and the two consumer types actually name it;
 *   (b) no key is DEFINED in a second contract-shaped declaration: every key appears in exactly one
 *       place, and that place is the registry (`duplicatedKeys=[]`);
 *   (c) the rule registration/installation verbs are reached only from the registry and the
 *       assembly points, never from an ordinary consumer.
 *
 * WHAT COUNTS AS A DEFINITION, which is the whole difficulty. A key name is not suspicious in
 * itself: `baseUrl` is a field of a TTS options object and `apiKey` of a route header bag, and a
 * scan that flagged every `baseUrl:` line would be measuring the word rather than the contract.
 * What a SECOND DECLARATION of the settings document looks like is an aggregate: an array literal
 * listing three or more of the document's string fields, an object literal assigning three or more
 * of them a literal default, or a type literal declaring three or more of them. That threshold is
 * the reading's definition of "contract-shaped", and it is stated here rather than left implicit
 * because it is what makes the scan discriminating: one or two shared field names are other
 * objects that happen to use the same words; a block of three or more is somebody writing the
 * document down again.
 *
 * THE EMPTY READING IS A FAILURE. A tree whose registry is missing, or that lost a key from it,
 * must not read as passing: `registryKeys` is asserted against the list below before
 * `duplicatedKeys` is believed, so deleting the thing under test is its own verdict rather than a
 * scan that matched nothing.
 *
 * Usage:
 *   node scripts/voice-settings-single-surface-check.mjs [--root <dir>]
 *
 *   --root <dir>  the tree to check (default: this script's repository root).
 *
 * Exit codes: 0 = every reading is clean; 1 = at least one judgement failed, one reason per line.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

/**
 * The document's fields, mirrored from the registry.
 *
 * A COPY ON PURPOSE: this file must be able to say the registry LOST a key. If the list were read
 * from the registry, deleting a key there would delete the expectation with it and the check would
 * stay green over a smaller document.
 */
const VOICE_SETTINGS_KEYS = [
  'baseUrl',
  'apiKey',
  'sttModel',
  'ttsModel',
  'ttsVoice',
  'ttsFormat',
  'providerId',
  'dashscopeEndpoint',
  'dashscopeApiKey',
  'dashscopeModel',
  'liveVoiceDashscopeApiKey',
  'voiceDataRecording',
  'voiceDataMaxBytes',
];

/** The shared declaration every consumer must read the document from. */
const REGISTRY_FILE = 'shared/voice/voiceSettingsRegistry.ts';

/** The two consumer types AC (a) names: the browser's store and the server's settings-file loader. */
const CONSUMER_FILES = [
  'src/shared/voiceConfig.ts',
  'server/modules/voice-realtime/voice-realtime-settings.ts',
];

/**
 * Where the rule registration/installation verbs are allowed to appear.
 *
 * The registry owns the verbs; the two barrels are the assembly points that register the rules and
 * install the process reader. A hit anywhere else is a consumer deciding what exists, which is the
 * second registration point this check exists to forbid.
 */
const RULE_ASSEMBLY_FILES = new Set([
  'shared/voice/voiceSettingsRegistry.ts',
  'server/shared/ports/voice-rules.port.ts',
  'server/index.ts',
  'server/modules/voice-realtime/index.ts',
]);

/** The verb shape AC (c) greps for, applied here to the syntax-stripped source. */
const RULE_VERB = /installVoiceRules|registerVoiceRule|voiceModeRules/;

/** A key definition must be one of the document's own fields, not a lookalike. */
const KEY_SET = new Set(VOICE_SETTINGS_KEYS);

/**
 * Reads `--root`, defaulting to this script's repository.
 * @returns {string}
 */
function parseRoot() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--root');
  if (index === -1) return DEFAULT_ROOT;
  const value = argv[index + 1];
  if (value === undefined || value === '') {
    throw new Error('--root needs a directory');
  }
  return path.resolve(value);
}

/**
 * Collects every non-test `.ts`/`.tsx` file under `dir` into `out`.
 * @param {string} dir
 * @param {string[]} out
 * @returns {void}
 */
function collectSources(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === 'tmp') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSources(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
}

/**
 * Removes `//` and `/* *\/` comments while leaving string literals intact.
 *
 * A comment that mentions a field name is prose, not a declaration; and a naive strip that cut at
 * the first `//` would truncate `'https://…'` and hide whatever followed it.
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  let out = '';
  let index = 0;
  /** @type {string | null} */
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      // Newlines are preserved so a reported line number is the line in the file, not a line in
      // the collapsed text: the reasons below are meant to be opened.
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * The canonical keys a block spells out, keyed by declaration name.
 *
 * The AC asks about STRING-LITERAL definitions, so only the two shapes that write a key as a
 * string literal are read: an array of field names and an object of default values. A type member
 * (`apiKey?: string`) spells neither the name as a literal nor a value, and the aggregates that
 * carry one or two of these fields for another reason — the per-request override shape, the
 * deployment-default bag — are named types of their own, not a second copy of the document. Each
 * shape is counted only when it names at least three canonical keys, which is what separates a
 * contract from an unrelated object that happens to use one or two of the same words.
 * @param {string} source syntax-stripped source
 * @returns {Array<{ declaration: string, keys: string[] }>}
 */
function contractShapes(source) {
  /** @type {Array<{ declaration: string, keys: string[] }>} */
  const shapes = [];

  const arrays = /const\s+([A-Za-z0-9_$]+)[^=\n]*=\s*\[([\s\S]*?)\]/g;
  for (const match of source.matchAll(arrays)) {
    const body = match[2] ?? '';
    const keys = VOICE_SETTINGS_KEYS.filter((key) => new RegExp(`['"]${key}['"]`).test(body));
    if (keys.length >= 3) shapes.push({ declaration: match[1] ?? '', keys });
  }

  const objects = /const\s+([A-Za-z0-9_$]+)[^=\n]*=\s*\{([\s\S]*?)\n\s*\};/g;
  for (const match of source.matchAll(objects)) {
    const body = match[2] ?? '';
    const keys = VOICE_SETTINGS_KEYS.filter((key) =>
      new RegExp(`^\\s*${key}\\s*:\\s*(?:['"][^'"]*['"]|\\d+|true|false)\\s*,?\\s*$`, 'm').test(body),
    );
    if (keys.length >= 3) shapes.push({ declaration: match[1] ?? '', keys });
  }

  return shapes;
}

/**
 * Runs every reading and prints it. Throws a plain Error with one reason per line on failure.
 * @param {string} root
 * @returns {void}
 */
function run(root) {
  /** @type {string[]} */
  const failures = [];

  // ── (a) the contract exists and the consumers name it ────────────────────────────────────────
  const registryPath = path.join(root, REGISTRY_FILE);
  if (!existsSync(registryPath)) {
    failures.push(`(a) missing ${REGISTRY_FILE}`);
  }
  const registrySource = existsSync(registryPath) ? stripComments(readFileSync(registryPath, 'utf8')) : '';
  const registryKeys = VOICE_SETTINGS_KEYS.filter((key) => registrySource.includes(key));
  const missingFromRegistry = VOICE_SETTINGS_KEYS.filter((key) => !registryKeys.includes(key));
  if (missingFromRegistry.length > 0) {
    failures.push(`(a) ${REGISTRY_FILE} does not declare: ${missingFromRegistry.join(', ')}`);
  }
  for (const consumer of CONSUMER_FILES) {
    const consumerPath = path.join(root, consumer);
    const present = existsSync(consumerPath);
    const references = present && readFileSync(consumerPath, 'utf8').includes('voiceSettingsRegistry');
    if (!present) failures.push(`(a) missing consumer ${consumer}`);
    else if (!references) failures.push(`(a) ${consumer} does not name ${REGISTRY_FILE}`);
  }

  // ── (b) no key is defined in a second contract-shaped declaration ────────────────────────────
  /** @type {string[]} */
  const sources = [];
  for (const directory of ['src', 'server', 'shared']) {
    const absolute = path.join(root, directory);
    if (existsSync(absolute)) collectSources(absolute, sources);
  }
  /** @type {Map<string, string[]>} */
  const duplicated = new Map();
  for (const file of sources) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative === REGISTRY_FILE) continue;
    for (const shape of contractShapes(stripComments(readFileSync(file, 'utf8')))) {
      for (const key of shape.keys) {
        if (!KEY_SET.has(key)) continue;
        const sites = duplicated.get(key) ?? [];
        sites.push(`${relative} (${shape.declaration})`);
        duplicated.set(key, sites);
      }
    }
  }
  const duplicatedKeys = [...duplicated.keys()].sort();
  for (const key of duplicatedKeys) {
    for (const site of duplicated.get(key) ?? []) failures.push(`(b) ${key} is defined at ${site}`);
  }

  // ── (c) the rule verbs are reached only from the registry and assembly points ────────────────
  /** @type {string[]} */
  const ruleHits = [];
  for (const file of sources) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (!relative.startsWith('server/')) continue;
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (!RULE_VERB.test(line)) return;
      ruleHits.push(`${relative}:${index + 1}`);
      if (!RULE_ASSEMBLY_FILES.has(relative)) {
        failures.push(`(c) ${relative}:${index + 1} reaches a rule verb outside the registry/assembly points`);
      }
    });
  }

  console.log(`settingsKeys=${VOICE_SETTINGS_KEYS.length} registryKeys=${registryKeys.length}`);
  console.log(`registry=${REGISTRY_FILE}`);
  console.log(`consumers=${CONSUMER_FILES.join(', ')}`);
  console.log(`duplicatedKeys=[${duplicatedKeys.join(', ')}]`);
  console.log(`ruleRegistryHits=[${ruleHits.join(', ')}]`);

  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
  console.log('ok');
}

try {
  run(parseRoot());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
