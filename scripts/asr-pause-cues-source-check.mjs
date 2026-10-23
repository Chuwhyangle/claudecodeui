#!/usr/bin/env node
/**
 * The value a trim decision reads has to be the REGISTRY's declaration for the provider the
 * request will actually be sent to — not a second table kept on the client.
 *
 * WHY THIS IS NOT `scripts/asr-trim-capability-check.mjs`. That check measures the MECHANISM: that
 * there is exactly one place where "裁不裁" is answered from a capability, and that the consumers
 * reach it. Every one of its readings is green on a tree whose one read point is wired to a table
 * the client wrote for itself, because a single read point fed by the wrong value still has a
 * single read point. It prints `ok` while the tree ships `destructive` for an id nothing is
 * registered under, against the one registered adapter's `useful`.
 *
 * This check measures the VALUE, and it is the pairing that makes the two falsifiable: a read
 * point that keeps deciding by hand is caught from the consumer side, and a read point that
 * decides from the wrong declaration is caught here.
 *
 * WHERE EACH SIDE IS READ FROM, and why neither is named by a symbol:
 *
 *   · the REGISTRY side is READ: the registration table in `shared/asr/asrRegistry.ts` is followed
 *     to the adapter module it imports, and the adapter's own `id` and
 *     `capabilities.pauseCues` are read off that module. So the reading is the declaration that
 *     would be handed out at runtime, not a copy of it.
 *   · the CLIENT side is SCANNED: any `pauseCues: '<value>'` written as CODE in `src/` is a
 *     client-side declaration of the capability, whatever it is called and whichever file it sits
 *     in — the shape is the thing, because the shape is what a second table is made of. Comments
 *     are stripped first (`stripComments`), because the same words in a sentence that EXPLAINS the
 *     registry are documentation, not a declaration. The scan reads the client's own fallback too
 *     (`DEFAULT_*PROVIDER`), because a table that answers for an undeclared id is answering about
 *     the effective provider just the same.
 *
 * THE EFFECTIVE PROVIDER is the first adapter in registration order. That is what
 * `effectiveProviderId(requested, defaults)` in `server/modules/voice/voice.service.ts` lands on
 * when no provider has been requested or configured, and the browser's profile is published from
 * that same health reading — so it is the provider a trim decision in the shipped configuration is
 * made about. A configured `providerId` would be requested first; the reading printed below names
 * which provider this judgement is about, so a tree that changes the effective provider shows up
 * as a changed line rather than as a silently different subject.
 *
 * THE EMPTY READING IS A FAILURE. A tree whose registry cannot be parsed, or whose gate reaches
 * nothing, must not read as passing: deleting or renaming the thing under test has to be its own
 * verdict rather than a scan that matched nothing.
 *
 * Usage:
 *   node scripts/asr-pause-cues-source-check.mjs [--root <dir>]
 *
 *   --root <dir>  the tree to check (default: this script's repository root). The falsification
 *                 cases point it at a throwaway tree copied from the shipping files.
 *
 * Exit codes: 0 = the client's declaration and the registry's agree (or the client declares none
 * and reads the registry); 1 = at least one judgement failed, each on its own line.
 */

import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

/**
 * The files a falsification rig has to carry for this check to answer about the rig.
 *
 * The registry-side entries are what the registration table is followed through — EVERY module the
 * table names, because the probe resolves each registration to the module that declares it and a
 * missing one fails the whole reading rather than skipping that row; the two `src/` entries are the
 * client side — where a second declaration would be written, and the gate that has to reach the
 * registry's instead.
 */
export const FIXTURE_FILES = [
  'shared/asr/asrRegistry.ts',
  'shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts',
  'shared/asr/list/multimodal/multimodal.asr-provider.ts',
  'src/shared/voiceTrim.ts',
  'src/modules/chat/hooks/useVoiceInput.ts',
];

/** Exported for the same reason `registryDeclarations` is: one home for the registry's path. */
export const REGISTRY_MODULE = 'shared/asr/asrRegistry.ts';

/** The module whose trim gate AC4 is about: the client-side read point this task unwires. */
const GATE_MODULE = 'src/modules/chat/hooks/useVoiceInput.ts';

/** The capability's vocabulary. A declaration outside it is not read as a declaration at all. */
const CAPABILITY_VALUES = ['destructive', 'neutral', 'useful'];

/**
 * The id the client used to name, and the literal whose absence AC4 asserts.
 *
 * Kept here as a string rather than resolved from the tree: the point of the reading is that the
 * NAME is gone from the gate, and a resolver would find it missing and find nothing to report.
 */
const RETIRED_PROVIDER_BINDING = 'OPENAI_COMPATIBLE_PROVIDER';

/** A client-side declaration row: the capability written down with a string value. */
const CLIENT_DECLARATION = new RegExp(
  `pauseCues\\s*:\\s*['"](${CAPABILITY_VALUES.join('|')})['"]`,
  'g',
);

/** How the client names the row it falls back to for an id its own table does not declare. */
const DECLARED_DEFAULT = /DEFAULT[A-Z0-9_]*PROVIDER\s*(?::[^=]+)?=\s*([^;\n]+);/;

/** How the gate has to reach the registry side: a lookup by provider id, or the accessor wrapping one. */
const REGISTRY_READ = /(?:pauseCuesDeclarationFor|effectivePauseCuesDeclaration)\s*\(/;

/** The registry's own registration table, which is what the provider order is read from. */
const REGISTRATION_TABLE = /const\s+REGISTERED[^=]*=\s*\[([\s\S]*?)\n\];/;

/** The registry's own evidence map, which is what each declaration names as its paired experiment. */
const PAUSE_CUES_EVIDENCE_TABLE = /const\s+PAUSE_CUES_EVIDENCE[^=]*=\s*\{([\s\S]*?)\n\};/;

/**
 * @param {string[]} argv
 * @returns {{ root: string }}
 */
function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) {
      root = path.resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument '${argv[i]}'`);
    }
  }
  return { root };
}

/**
 * The paths of `globs`, relative to `root`, deduplicated and sorted so a scan is reproducible.
 *
 * @param {string} root
 * @param {string[]} globs
 * @returns {string[]}
 */
function sourceFiles(root, globs) {
  const found = new Set();
  for (const pattern of globs) {
    for (const rel of globSync(pattern, { cwd: root })) found.add(rel);
  }
  return [...found].sort();
}

/**
 * The binding names a module's import statements introduce, mapped to what they are imported from.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
function importBindings(text) {
  const bindings = new Map();
  const statement = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = statement.exec(text)) !== null) {
    for (const clause of match[1].split(',')) {
      const parts = clause.trim().split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0]).trim();
      if (name) bindings.set(name, match[2]);
    }
  }
  return bindings;
}

/**
 * The string literal an `export const <name> = '…'` in `text` holds, or `null`.
 *
 * @param {string} text
 * @param {string} name
 * @returns {string | null}
 */
function exportedString(text, name) {
  const match = new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*'([^']*)'`).exec(text);
  return match ? match[1] : null;
}

/**
 * The capability an adapter module declares, read out of its own `capabilities` export.
 *
 * Sliced from the export down to the object's closing brace at column 0 rather than matched over
 * the whole file: the module comment talks about `pauseCues` too, and a reading taken from prose
 * is a reading of the comment.
 *
 * @param {string} text
 * @returns {string | null}
 */
function declaredCapability(text) {
  const at = text.search(/export\s+const\s+capabilities\b/);
  if (at < 0) return null;
  const end = text.indexOf('\n};', at);
  const body = end < 0 ? text.slice(at) : text.slice(at, end);
  const match = new RegExp(`pauseCues\\s*:\\s*'(${CAPABILITY_VALUES.join('|')})'`).exec(body);
  return match ? match[1] : null;
}

/**
 * `specifier`, resolved from the directory of `fromRel`, as a source path `root` really has.
 *
 * @param {string} root
 * @param {string} fromRel
 * @param {string} specifier
 * @returns {string | null}
 */
function resolveModule(root, fromRel, specifier) {
  const base = path.posix.join(path.posix.dirname(fromRel), specifier).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, `${base}.tsx`, base]) {
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

/**
 * The registry's declaration for every registered provider, in registration order — the id, the
 * `pauseCues` the adapter module declares, the module it was read from, and the paired experiment
 * the registry names for it (absent when the registry names none).
 *
 * `providers` is empty exactly when `error` is set, so a caller that ignores the error cannot read
 * a truncated list as a complete one.
 *
 * EXPORTED, because the registry side has exactly one reading: `scripts/asr-trim-capability-check.mjs`
 * needs the same rows — which recognisers are registered and what each declares — and following the
 * registration table a second time there would be the same 口径 derived twice.
 *
 * @param {string} root
 * @returns {{ providers: { id: string, capability: string, module: string, evidence: string | undefined }[], error: string | null }}
 */
export function registryDeclarations(root) {
  /** @type {{ id: string, capability: string, module: string, evidence: string | undefined }[]} */
  const providers = [];
  /** @type {string | null} */
  let error = null;
  /**
   * @param {string} message
   * @returns {{ providers: { id: string, capability: string, module: string, evidence: string | undefined }[], error: string | null }}
   */
  const fail = (message) => {
    error = message;
    return { providers, error };
  };

  if (!existsSync(path.join(root, REGISTRY_MODULE))) {
    return fail(`${REGISTRY_MODULE} is not in this tree`);
  }
  const text = readFileSync(path.join(root, REGISTRY_MODULE), 'utf8');
  const bindings = importBindings(text);
  const table = REGISTRATION_TABLE.exec(text);
  if (!table) return fail(`${REGISTRY_MODULE}: the registration table could not be read`);

  const registered = [...table[1].matchAll(/\bid:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  if (registered.length === 0) return fail(`${REGISTRY_MODULE}: nothing is registered`);

  // The paired experiment each declaration rests on, keyed by the binding the registration table
  // imports the adapter under. Read, not enforced: a declaration that changes what gets uploaded
  // without a record behind it is `scripts/asr-trim-capability-check.mjs`'s `discipline` check,
  // and a registry that names none must come back as "none" rather than as a failure here.
  /** @type {Map<string, string>} */
  const evidenceByBinding = new Map();
  const evidenceTable = PAUSE_CUES_EVIDENCE_TABLE.exec(text);
  if (evidenceTable) {
    for (const row of evidenceTable[1].matchAll(/\[?\s*([A-Za-z_$][\w$]*)\s*\]?\s*:\s*['"]([^'"]+)['"]/g)) {
      evidenceByBinding.set(row[1], row[2]);
    }
  }

  for (const binding of registered) {
    const specifier = bindings.get(binding);
    if (!specifier) return fail(`${REGISTRY_MODULE}: '${binding}' is registered but never imported`);
    const module = resolveModule(root, REGISTRY_MODULE, specifier);
    if (!module) return fail(`${REGISTRY_MODULE}: '${specifier}' does not resolve to a source file`);
    const providerText = readFileSync(path.join(root, module), 'utf8');
    const id = exportedString(providerText, 'id');
    const capability = declaredCapability(providerText);
    if (!id) return fail(`${module}: the adapter's id could not be read`);
    if (!capability) return fail(`${module}: the adapter declares no pauseCues in its capabilities`);
    providers.push({ id, capability, module, evidence: evidenceByBinding.get(binding) });
  }
  return { providers, error };
}

/**
 * The string constants a client file declares, so a row's `provider:` can be followed to its value.
 *
 * Closed over itself before it is read: a fallback row is routinely written as another constant's
 * name, and two passes cover the one hop that shape has.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
function stringConstants(text) {
  const constants = new Map();
  const declaration = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;\n]+);/g;
  let match;
  while ((match = declaration.exec(text)) !== null) constants.set(match[1], match[2].trim());
  for (let pass = 0; pass < 2; pass++) {
    for (const [name, value] of constants) {
      const identifier = /^([A-Za-z_$][\w$]*)$/.exec(value);
      if (identifier && constants.has(identifier[1])) constants.set(name, constants.get(identifier[1]));
    }
  }
  return constants;
}

/**
 * The value an expression holds, when it is a string literal or a constant resolving to one.
 *
 * @param {string} expression
 * @param {Map<string, string>} constants
 * @returns {string | null}
 */
function constantValue(expression, constants) {
  const literal = /^['"]([^'"]*)['"]$/.exec(expression.trim());
  if (literal) return literal[1];
  const identifier = /^([A-Za-z_$][\w$]*)$/.exec(expression.trim());
  if (identifier && constants.has(identifier[1])) {
    const value = constants.get(identifier[1]) ?? '';
    const inner = /^['"]([^'"]*)['"]$/.exec(value);
    if (inner) return inner[1];
  }
  return null;
}

/**
 * `source` with its comments removed, leaving string and template literals (and their contents)
 * byte-for-byte intact.
 *
 * WHY THE CLIENT DECLARATION SCAN IS COMMENT-BLIND. `CLIENT_DECLARATION` matches
 * `pauseCues: '<value>'` in the raw text, but `src/shared/voiceTrim.ts` also EXPLAINS the
 * registry's own declaration in a JSDoc sentence (`A relay recogniser declares
 * 'pauseCues: ...'`). That sentence is true documentation about an adapter, not a client-side
 * declaration, yet the raw scan counted it as a row — `client-declaration-rows=1` where the
 * invariant says 0. The sibling probe (`scripts/asr-health-provider-check.mjs`) was reded by the
 * same prose on 2026-10-22 and fixed by stripping comments; this is the same walk, so the two
 * readings cannot disagree about what a declaration is.
 *
 * WHY NOT A REGEX REPLACEMENT. `source.replace(/\/\/.*$/gm, '')` truncates every URL at its scheme
 * (`https://…`), so a declaration after a URL would vanish. This walks one character at a time and
 * drops comment syntax only in CODE position: quotes toggle a literal state, a `/` that can begin a
 * regex is consumed as one, and removed comments become a single space so tokens cannot fuse.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  /** @type {string[]} */
  const out = [];
  let quote = '';
  let previous = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out.push(char);
      if (char === '\\' && index + 1 < source.length) {
        out.push(source[index + 1]);
        index += 2;
        continue;
      }
      if (char === quote) quote = '';
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out.push(char);
      previous = char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      out.push(' ');
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      out.push(' ');
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out.push('\n');
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '/' && (previous === '' || /[(,=:[!&|?{};+\-*%^~<>]/.test(previous))) {
      let cursor = index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < source.length) {
        const inner = source[cursor];
        if (inner === '\\') { cursor += 2; continue; }
        if (inner === '\n') break;
        if (inner === '[') { inClass = true; cursor += 1; continue; }
        if (inner === ']') { inClass = false; cursor += 1; continue; }
        if (inner === '/' && !inClass) { closed = true; cursor += 1; break; }
        cursor += 1;
      }
      if (closed) {
        while (cursor < source.length && /[a-z]/i.test(source[cursor])) cursor += 1;
        out.push(source.slice(index, cursor));
        previous = '/';
        index = cursor;
        continue;
      }
    }
    out.push(char);
    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return out.join('');
}

/**
 * Every client-side declaration of the capability in `root`'s `src/`, and the row the client falls
 * back to for an id its own table does not declare.
 *
 * @param {string} root
 * @returns {{
 *   rows: { file: string, providerId: string | null, value: string }[],
 *   fallback: { file: string, providerId: string, value: string } | null,
 * }}
 */
function clientDeclarations(root) {
  /** @type {{ file: string, providerId: string | null, value: string }[]} */
  const rows = [];
  /** @type {{ file: string, providerId: string, value: string } | null} */
  let fallback = null;

  for (const rel of sourceFiles(root, ['src/**/*.ts', 'src/**/*.tsx'])) {
    // Comment-blind on purpose: see `stripComments` above.
    const text = stripComments(readFileSync(path.join(root, rel), 'utf8'));
    const constants = stringConstants(text);

    for (const match of text.matchAll(CLIENT_DECLARATION)) {
      // The row's own `provider:` is the nearest one before this value — a row is written
      // `{ provider: …, pauseCues: '…' }`, so the binding precedes the value it is paired with.
      const before = text.slice(Math.max(0, (match.index ?? 0) - 400), match.index ?? 0);
      const provider = [...before.matchAll(/provider\s*:\s*([^,\n}]+)/g)].pop();
      rows.push({
        file: rel,
        providerId: provider ? constantValue(provider[1], constants) : null,
        value: match[1],
      });
    }

    const declared = DECLARED_DEFAULT.exec(text);
    if (declared) {
      const providerId = constantValue(declared[1], constants);
      if (providerId) fallback = { file: rel, providerId, value: '' };
    }
  }

  if (fallback) {
    const row = rows.find((candidate) => candidate.providerId === fallback?.providerId);
    fallback = row ? { ...fallback, value: row.value } : null;
  }
  return { rows, fallback };
}

/**
 * What the client would act on for `providerId`: the row naming it, else the row its own declared
 * default names, else nothing.
 *
 * @param {{ rows: { file: string, providerId: string | null, value: string }[], fallback: { file: string, providerId: string, value: string } | null }} declared
 * @param {string} providerId
 * @returns {{ file: string, providerId: string | null, value: string } | null}
 */
function clientValueFor(declared, providerId) {
  const named = declared.rows.find((row) => row.providerId === providerId);
  if (named) return named;
  return declared.fallback ? { ...declared.fallback } : null;
}

/**
 * The gate's own reading: whether the retired literal is back, and whether it reaches the registry.
 *
 * @param {string} root
 * @returns {{
 *   error: string | null,
 *   reachesRegistry: boolean,
 *   readPoint: string | null,
 *   retiredLiteral: boolean,
 * }}
 */
function gateReading(root) {
  const missing = { error: `${GATE_MODULE} is not in this tree`, reachesRegistry: false, readPoint: null, retiredLiteral: false };
  if (!existsSync(path.join(root, GATE_MODULE))) return missing;
  const text = readFileSync(path.join(root, GATE_MODULE), 'utf8');
  const read = REGISTRY_READ.exec(text);
  return {
    error: null,
    reachesRegistry: Boolean(read),
    readPoint: read ? read[0].replace(/\s*\($/, '') : null,
    retiredLiteral: text.includes(RETIRED_PROVIDER_BINDING),
  };
}

/**
 * Whether the client's declaration and the registry's agree, as readings plus judgements.
 *
 * @param {string} root
 * @returns {{ ok: boolean, lines: string[], failures: string[] }}
 */
export function checkPauseCuesSource(root) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const failures = [];

  const registry = registryDeclarations(root);
  if (registry.error) {
    return { ok: false, lines, failures: [`registry 的声明读不出来：${registry.error}`] };
  }
  const effective = registry.providers[0];
  lines.push(`registry-module=${REGISTRY_MODULE}`);
  lines.push(
    `registry-provider=${effective.id} (1 of ${registry.providers.length} registered, ` +
      'nothing requested or configured)',
  );
  lines.push(`registry-pauseCues=${effective.capability}`);
  lines.push(`registry-declared-by=${effective.module}`);

  const declared = clientDeclarations(root);
  const client = clientValueFor(declared, effective.id);
  lines.push(`client-declaration-rows=${declared.rows.length}`);
  lines.push(`client-pauseCues=${client ? client.value : 'none'}`);
  lines.push(
    `client-declaration-source=${client ? `${client.file} (provider ${client.providerId})` : 'none'}`,
  );

  const gate = gateReading(root);
  if (gate.error) {
    failures.push(`裁剪门读不出来：${gate.error}`);
    return { ok: false, lines, failures };
  }
  lines.push(`gate-module=${GATE_MODULE}`);
  lines.push(`gate-reads-registry=${gate.reachesRegistry ? `yes (${gate.readPoint})` : 'no'}`);
  lines.push(`gate-retired-literal=${gate.retiredLiteral ? RETIRED_PROVIDER_BINDING : 'absent'}`);

  if (client && client.value !== effective.capability) {
    failures.push(
      '客户端声明的 `pauseCues` 与 registry 对当前 provider 的声明不一致：' +
        `client=${client.value} registry=${effective.capability} provider=${effective.id}` +
        `（client 的声明在 ${client.file}，其 provider 列为 ${client.providerId}）`,
    );
  }
  if (gate.retiredLiteral) {
    failures.push(`AC4: ${GATE_MODULE} 仍出现字面量 ${RETIRED_PROVIDER_BINDING}`);
  }
  if (!gate.reachesRegistry) {
    failures.push(
      `AC4: ${GATE_MODULE} 的裁剪门没读到 registry 的声明读取点（provider id 不来自配置读取路径）`,
    );
  }

  return { ok: failures.length === 0, lines, failures };
}

/**
 * What the CLI prints; kept beside the readings so the two cannot drift apart.
 *
 * @param {string} root
 * @returns {number} the process exit code
 */
export function report(root) {
  const { ok, lines, failures } = checkPauseCuesSource(root);
  for (const line of lines) console.log(line);
  for (const failure of failures) console.log(`failure=${failure}`);
  console.log(`verdict=${ok ? 'ok' : 'fail'}`);
  return ok ? 0 : 1;
}

// Imported by the falsification cases, which drive `report` against their own rigs; the CLI is
// the same function, so a rig's exit code is the shipping command's exit code.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const { root } = parseArgs(process.argv.slice(2));
    process.exit(report(root));
  } catch (error) {
    console.log(`failure=${error instanceof Error ? error.message : String(error)}`);
    console.log('verdict=fail');
    process.exit(1);
  }
}
