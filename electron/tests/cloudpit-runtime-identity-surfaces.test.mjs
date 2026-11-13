/**
 * Criterion file for GOAL-054 AC-459: the Cloudpit runtime *internal* identity
 * surfaces.
 *
 *   npx tsx --tsconfig server/tsconfig.json --test electron/tests/cloudpit-runtime-identity-surfaces.test.mjs
 *
 * The display identity (AC-453) and the runtime defaults (AC-452) are covered by
 * their own criterion files. This one pins the surfaces a user never sees a name
 * on but every renderer call travels through:
 *
 *  - the Electron IPC channel family (`window.send` / `ipcMain` / preload
 *    `invoke` + `on` must all agree),
 *  - the two `contextBridge` globals and the code that reads them,
 *  - the one architecture `BroadcastChannel` name shared by the standalone page
 *    and the workspace tab,
 *  - the dev-only semantic scenario global and every surface that synchronises
 *    it.
 *
 * The scanner takes an injectable root so the negative arms can run against a
 * tmp fixture instead of the live tree. The pre-2.0 names are assembled from
 * parts: this file lives inside the surface it scans, so it must not contain a
 * literal copy of what it forbids (the scanner additionally excludes this file
 * by path, so a future edit cannot make the criterion self-red).
 *
 * The non-goal identity (`cloudcli.ai`, the `cloudcli://auth/callback` login
 * callback, `app_surface=cloudcli_desktop`, the legacy `ai.cloudcli.desktop`
 * app-id spelling and the `cloudcli://` observation URIs) is asserted *present*
 * in the same run — a zero-hit scan must not be achieved by renaming it away.
 * (v3.0's R13 keeps that legacy spelling as the migration constant in
 * `electron/appIdMigration.js`; the live `APP_USER_MODEL_ID` is the new id. v3.0's
 * R7 retires the dual-read observation grammar: the parsers accept only
 * `cloudpit://session|architecture`, and the legacy `cloudcli://` forms parse to
 * null — `src/modules/cockpit/tests/observationUri.test.ts` pins the same.)
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..');

/** This criterion file, excluded from the scan by path. */
const SELF_RELATIVE_PATH = 'electron/tests/cloudpit-runtime-identity-surfaces.test.mjs';

// ── the forbidden names ────────────────────────────────────────────────────
// Built by concatenation so the literal never appears in this file.
const LEGACY_STEM = ['cloud', 'cli'].join('');
const LEGACY_IPC_PREFIX = `${LEGACY_STEM}-desktop:`;
const LEGACY_BRIDGE = `${LEGACY_STEM}Desktop`;
const LEGACY_CHANNEL = `${LEGACY_STEM}-architecture`;
const LEGACY_SCENARIO_GLOBAL = `__${LEGACY_STEM}Scenario`;
const LEGACY_TOKENS = Object.freeze([
  LEGACY_IPC_PREFIX,
  LEGACY_BRIDGE,
  LEGACY_CHANNEL,
  LEGACY_SCENARIO_GLOBAL,
]);

// ── the required names ─────────────────────────────────────────────────────
const IPC_PREFIX = 'cloudpit-desktop:';
const BRIDGE_NAME = 'cloudpitDesktop';
const BRIDGE_NOTIFICATIONS_NAME = 'cloudpitDesktopNotifications';
const ARCHITECTURE_CHANNEL = 'cloudpit-architecture';
const SCENARIO_GLOBAL = '__cloudpitScenario';

// ── the scanned surface ────────────────────────────────────────────────────
// AC-459's zero-hit scope is the live code surface: these four trees plus the
// root AGENTS.md. History (`tasks/`, `goals/`, `adr/`, `experiments/`,
// `docs/proposals/`, `CHANGELOG`) is a GOAL-054 non-goal and is NOT scanned.
const SCAN_DIRECTORIES = Object.freeze(['electron', 'src', 'scripts', 'e2e']);
const SCAN_ROOT_FILES = Object.freeze(['AGENTS.md']);
const SKIPPED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'dist',
  '.git',
  'test-results',
  'playwright-report',
]);
const TEXT_EXTENSIONS = new Set([
  '.js',
  '.cjs',
  '.mjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.md',
  '.html',
  '.css',
  '.yml',
  '.yaml',
]);

function toRelative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function collectTextFiles(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      collectTextFiles(path.join(dir, entry.name), files);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
}

function collectSurfaceFiles(root) {
  const files = [];
  for (const directory of SCAN_DIRECTORIES) {
    const start = path.join(root, directory);
    if (!existsSync(start)) continue;
    if (!statSync(start).isDirectory()) continue;
    collectTextFiles(start, files);
  }
  for (const fileName of SCAN_ROOT_FILES) {
    const file = path.join(root, fileName);
    if (existsSync(file) && statSync(file).isFile()) files.push(file);
  }
  return files.sort();
}

/**
 * Scan `root`'s live code surface for the pre-2.0 identity names.
 *
 * @returns {{ violations: Array<{ file: string, line: number, token: string }>, filesScanned: number }}
 */
function scanIdentitySurfacesDetailed(root) {
  const excluded = path.resolve(root, SELF_RELATIVE_PATH);
  const violations = [];
  let filesScanned = 0;

  for (const file of collectSurfaceFiles(root)) {
    if (path.resolve(file) === excluded) continue;
    const relative = toRelative(root, file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    filesScanned += 1;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const token of LEGACY_TOKENS) {
        if (line.includes(token)) {
          violations.push({ file: relative, line: index + 1, token });
        }
      }
    }
  }

  return { violations, filesScanned };
}

/** The AC-459 scanner: an injectable root in, the violation list out. */
function scanIdentitySurfaces(root) {
  return scanIdentitySurfacesDetailed(root).violations;
}

function makeFixtureRoot(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cloudpit-runtime-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFixtureFile(root, relativePath, contents) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function readRepoFile(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function collectMatches(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

// ── the standalone send chain ─────────────────────────────────────────────
// The standalone architecture page reaches the bridge through four composition
// rings. Pinning only the leaf that happens to hold the call is what let a
// previous split move the call without moving the criterion; this reading walks
// the whole chain and names the ring that broke.
const ARCHITECTURE_SEND_CALL = 'sendArchitectureChatMessage(';
const ARCHITECTURE_SEND_HOOK =
  'src/modules/architecture/render/useArchitecturePanelActions.ts';
/** The bridge defines the send function; it is a definition, not a caller. */
const ARCHITECTURE_BRIDGE_FILE =
  'src/modules/architecture/render/architectureChatBridge.ts';
const ARCHITECTURE_SEND_CHAIN = Object.freeze([
  ['src/modules/architecture/render/ArchitecturePanel.tsx', 'ArchitecturePanelShell'],
  ['src/modules/architecture/render/architecturePanelShell.tsx', 'ArchitecturePanelReadyView'],
  ['src/modules/architecture/render/architecturePanelReadyView.tsx', 'useArchitecturePanelActions'],
  [ARCHITECTURE_SEND_HOOK, ARCHITECTURE_SEND_CALL],
]);
const ARCHITECTURE_PACKAGE_DIR = 'src/modules/architecture';

/** Every text source file under the architecture package, `tests/` excluded. */
function collectArchitectureSourceFiles(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name) || entry.name === 'tests') continue;
      collectArchitectureSourceFiles(path.join(dir, entry.name), files);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

/**
 * Read the standalone page's send chain under an injectable `root`.
 *
 * Returns the rings that are absent, the files that actually call the bridge
 * (the bridge definition and `tests/` excluded), and whether the single call in
 * the actions hook sits inside the `if (standalone)` branch.
 *
 * @returns {{ brokenLinks: string[], callerFiles: string[], callInsideStandaloneBranch: boolean }}
 */
function architectureSendChain(root) {
  const links = ARCHITECTURE_SEND_CHAIN.map(([file, needle]) => {
    const absolute = path.join(root, file);
    const source = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
    return { file, needle, present: source.includes(needle), source };
  });

  const bridgeAbsolute = path.resolve(root, ARCHITECTURE_BRIDGE_FILE);
  const callerFiles = collectArchitectureSourceFiles(path.join(root, ARCHITECTURE_PACKAGE_DIR))
    .filter((file) => path.resolve(file) !== bridgeAbsolute)
    .filter((file) => readFileSync(file, 'utf8').includes(ARCHITECTURE_SEND_CALL))
    .map((file) => toRelative(root, file))
    .sort();

  const actionsSource = links[links.length - 1].source;
  const branchIndex = actionsSource.indexOf('if (standalone)');
  const callIndex = actionsSource.indexOf(ARCHITECTURE_SEND_CALL);

  return {
    brokenLinks: links.filter((link) => !link.present).map((link) => link.file),
    callerFiles,
    callInsideStandaloneBranch:
      branchIndex !== -1 && callIndex !== -1 && branchIndex < callIndex,
  };
}

/**
 * The BroadcastChannel send half of AC-459, as assertions.
 *
 * Kept as a function so the negative arms can run the SAME criterion against a
 * fixture and prove it reds, rather than merely describing a broken chain.
 */
function assertArchitectureSendChain(root) {
  const chain = architectureSendChain(root);
  assert.deepEqual(
    chain.brokenLinks,
    [],
    `the standalone send chain is intact (broken links: ${chain.brokenLinks.join(', ') || 'none'})`,
  );
  assert.deepEqual(
    chain.callerFiles,
    [ARCHITECTURE_SEND_HOOK],
    `exactly one file calls the bridge and it is ${ARCHITECTURE_SEND_HOOK}`,
  );
  assert.equal(
    chain.callInsideStandaloneBranch,
    true,
    'the single call sits inside the `if (standalone)` branch',
  );
}

/** A minimal stand-in for the whole chain, so a fixture can break one ring. */
function writeArchitectureChainFixture(root, overrides = {}) {
  const sources = {
    'src/modules/architecture/render/ArchitecturePanel.tsx':
      'export const ArchitecturePanel = () => <ArchitecturePanelShell />;\n',
    'src/modules/architecture/render/architecturePanelShell.tsx':
      'export const ArchitecturePanelShell = () => <ArchitecturePanelReadyView />;\n',
    'src/modules/architecture/render/architecturePanelReadyView.tsx':
      'export const ArchitecturePanelReadyView = () => useArchitecturePanelActions({});\n',
    [ARCHITECTURE_SEND_HOOK]: [
      "import { sendArchitectureChatMessage } from './architectureChatBridge';",
      'export function useArchitecturePanelActions(args) {',
      '  if (standalone) {',
      '    return sendArchitectureChatMessage({ sessionId: null, text: "" });',
      '  }',
      '  return null;',
      '}',
      '',
    ].join('\n'),
    [ARCHITECTURE_BRIDGE_FILE]:
      'export function sendArchitectureChatMessage(options) { return Promise.resolve(false); }\n',
    ...overrides,
  };
  for (const [file, contents] of Object.entries(sources)) {
    writeFixtureFile(root, file, contents);
  }
}

// ── AC-459 expect: the live surface, and a non-vacuous positive arm ────────

test('AC2: the live runtime identity surfaces are clean, and the scan is not vacuous', () => {
  const live = scanIdentitySurfacesDetailed(REPO_ROOT);

  assert.deepEqual(live.violations, [], 'no pre-2.0 runtime identity name survives on the live surface');
  assert.deepEqual(scanIdentitySurfaces(REPO_ROOT), [], 'the scanner returns a violation array');

  // A wrong root or an empty traversal would make the assertion above vacuous.
  assert.ok(
    live.filesScanned >= 20,
    `the scan must cover the live surface (scanned ${live.filesScanned} files, expected >= 20)`,
  );

  const positives = [
    [IPC_PREFIX, 'electron/main.js', `${IPC_PREFIX}get-state`],
    [BRIDGE_NAME, 'electron/preload.cjs', BRIDGE_NAME],
    [ARCHITECTURE_CHANNEL, 'src/modules/architecture/render/architectureChatBridge.ts', ARCHITECTURE_CHANNEL],
    [SCENARIO_GLOBAL, 'src/modules/ui-scenario/scenarioSurface.ts', SCENARIO_GLOBAL],
  ];
  for (const [name, file, needle] of positives) {
    assert.ok(
      readRepoFile(file).includes(needle),
      `${name} must be present in ${file} — otherwise "zero hits" is an empty-set artefact`,
    );
  }
});

test('AC-459 expect: IPC registration, preload invoke/on and webContents.send agree', () => {
  const mainSource = readRepoFile('electron/main.js');
  const preloadSource = readRepoFile('electron/preload.cjs');
  const desktopWindowSource = readRepoFile('electron/desktopWindow.js');

  const registered = uniqueSorted(collectMatches(mainSource, /ipcMain\.handle\(\s*'([^']+)'/g));
  assert.ok(registered.length >= 20, `main.js registers the desktop IPC family (found ${registered.length})`);
  for (const channel of registered) {
    assert.ok(channel.startsWith(IPC_PREFIX), `${channel} is registered under the ${IPC_PREFIX} prefix`);
  }

  const invoked = uniqueSorted(collectMatches(preloadSource, /ipcRenderer\.invoke\(\s*'([^']+)'/g));
  assert.ok(invoked.length >= 20, `preload exposes the desktop IPC family (found ${invoked.length})`);
  for (const channel of invoked) {
    assert.ok(
      registered.includes(channel),
      `preload invokes ${channel}, but main.js registers no such channel`,
    );
  }

  const listened = uniqueSorted(
    collectMatches(preloadSource, /ipcRenderer\.(?:on|removeListener)\(\s*'([^']+)'/g),
  );
  const sent = uniqueSorted(collectMatches(desktopWindowSource, /\.send\(\s*'([^']+)'/g));
  assert.deepEqual(
    sent,
    [`${IPC_PREFIX}launcher-command`, `${IPC_PREFIX}state-updated`],
    'desktopWindow pushes exactly the two renderer channels preload listens to',
  );
  for (const channel of listened) {
    assert.ok(sent.includes(channel), `preload listens to ${channel}, but desktopWindow never sends it`);
  }
});

test('AC-459 expect: contextBridge exposes only the two Cloudpit names and consumers read them', () => {
  const preloadSource = readRepoFile('electron/preload.cjs');

  const exposed = collectMatches(preloadSource, /contextBridge\.exposeInMainWorld\(\s*'([^']+)'/g);
  assert.deepEqual(
    uniqueSorted(exposed),
    [BRIDGE_NAME, BRIDGE_NOTIFICATIONS_NAME],
    'contextBridge exposes exactly the two Cloudpit globals',
  );
  assert.equal(
    preloadSource.includes(LEGACY_BRIDGE),
    false,
    'preload does not keep an alias for the pre-2.0 bridge global',
  );

  assert.match(
    readRepoFile('electron/launcher/launcher.js'),
    /window\.cloudpitDesktop\b/,
    'the launcher reads window.cloudpitDesktop',
  );
  assert.match(
    readRepoFile('src/modules/settings/Settings.tsx'),
    /\bcloudpitDesktopNotifications\b/,
    'Settings reads window.cloudpitDesktopNotifications',
  );
  assert.match(
    readRepoFile('src/modules/settings/hooks/useWebPush.ts'),
    /\bcloudpitDesktopNotifications\b/,
    'useWebPush reads window.cloudpitDesktopNotifications',
  );
});

test('AC-459 expect: one BroadcastChannel name feeds both architecture surfaces', () => {
  const bridgeSource = readRepoFile('src/modules/architecture/render/architectureChatBridge.ts');

  assert.match(
    bridgeSource,
    new RegExp(`export const ARCHITECTURE_CHAT_CHANNEL = '${ARCHITECTURE_CHANNEL}';`),
    'the architecture channel is the Cloudpit name, verbatim',
  );

  const constructions = [...bridgeSource.matchAll(/new BroadcastChannel\(\s*([^)]*)\)/g)];
  assert.equal(constructions.length, 1, 'the bridge defines the channel exactly once');
  assert.match(
    constructions[0][1],
    /ARCHITECTURE_CHAT_CHANNEL/,
    'the single construction uses the exported constant, not a second literal',
  );

  // The two surfaces this channel joins: the standalone architecture page
  // (sends) and the workspace tab hook (receives). The send half is a chain —
  // panel → shell → ready view → actions hook → bridge — read ring by ring, so
  // a future split names the ring that moved instead of silently changing which
  // leaf file holds the call.
  assertArchitectureSendChain(REPO_ROOT);
  assert.match(
    readRepoFile('src/modules/architecture/index.ts'),
    /useArchitectureChatBridge/,
    'the workspace architecture entry point exposes the receiving hook',
  );

  // The package boundary that owns the bridge. A future split that moves the
  // file again must fail here with a boundary message rather than a bare
  // ENOENT from the reads above.
  assert.match(
    readRepoFile('src/modules/architecture/index.ts'),
    /render\/architectureChatBridge/,
    'the architecture package entry point re-exports the bridge from render/architectureChatBridge',
  );
});

test('AC-459 expect: the dev-only semantic surface installs the Cloudpit global everywhere', () => {
  const surfaceSource = readRepoFile('src/modules/ui-scenario/scenarioSurface.ts');

  assert.match(
    surfaceSource,
    /scenarioWindow\(\)\.__cloudpitScenario = attachedSurface/,
    'the semantic surface is installed as window.__cloudpitScenario',
  );
  assert.match(
    surfaceSource,
    /delete scenarioWindow\(\)\.__cloudpitScenario/,
    'the semantic surface is torn down by the same name',
  );

  // Every surface that reads or writes the global, so a rename in one of them
  // cannot leave a half-migrated runtime.
  const synchronisedSurfaces = [
    'src/main.tsx',
    'src/modules/ui-scenario/index.ts',
    'src/modules/ui-scenario/tests/scenarioSurface.test.ts',
    'src/modules/ui-scenario/tests/cockpitCardsSurface.test.ts',
    'scripts/ui-scenario.mjs',
    'e2e/ui-scenario-runner.spec.ts',
    'e2e/scenarios/quay-wall-focus-pin-utter.json',
    'AGENTS.md',
  ];
  for (const file of synchronisedSurfaces) {
    assert.ok(
      readRepoFile(file).includes(SCENARIO_GLOBAL),
      `${file} still references the semantic surface by its Cloudpit name`,
    );
  }
});

// ── AC-459 expect: injected pre-2.0 names must turn the same scan red ─────

test('AC3: an injected pre-2.0 IPC channel in a tmp fixture is reported against electron/main.js', (t) => {
  const root = makeFixtureRoot(t);
  writeFixtureFile(
    root,
    'electron/main.js',
    `ipcMain.handle('${LEGACY_IPC_PREFIX}get-state', () => null);\n`,
  );

  const detail = scanIdentitySurfacesDetailed(root);
  assert.equal(detail.filesScanned, 1, 'the fixture scan is not empty');
  assert.deepEqual(scanIdentitySurfaces(root), detail.violations);
  assert.ok(
    detail.violations.some(
      (violation) =>
        violation.file === 'electron/main.js' &&
        violation.line === 1 &&
        violation.token === LEGACY_IPC_PREFIX,
    ),
    `expected a ${LEGACY_IPC_PREFIX} violation against electron/main.js, got ${JSON.stringify(detail.violations)}`,
  );
});

test('AC3: an injected pre-2.0 scenario global in a tmp fixture is reported against src/semantic.js', (t) => {
  const root = makeFixtureRoot(t);
  writeFixtureFile(
    root,
    'src/semantic.js',
    `window.${LEGACY_SCENARIO_GLOBAL} = attachedSurface;\n`,
  );

  const detail = scanIdentitySurfacesDetailed(root);
  assert.equal(detail.filesScanned, 1, 'the fixture scan is not empty');
  assert.ok(
    detail.violations.some(
      (violation) =>
        violation.file === 'src/semantic.js' &&
        violation.line === 1 &&
        violation.token === LEGACY_SCENARIO_GLOBAL,
    ),
    `expected a ${LEGACY_SCENARIO_GLOBAL} violation against src/semantic.js, got ${JSON.stringify(detail.violations)}`,
  );
});

// ── AC-459 expect: a broken send chain turns the same criterion red ───────

test('AC3: a tmp fixture whose actions hook drops the send call breaks the chain', (t) => {
  const root = makeFixtureRoot(t);
  writeArchitectureChainFixture(root, {
    [ARCHITECTURE_SEND_HOOK]:
      'export function useArchitecturePanelActions() { return null; }\n',
  });

  const chain = architectureSendChain(root);
  assert.deepEqual(
    chain.brokenLinks,
    [ARCHITECTURE_SEND_HOOK],
    `the reading names the broken ring: ${JSON.stringify(chain.brokenLinks)}`,
  );
  assert.deepEqual(chain.callerFiles, [], 'no file calls the bridge any more');
  assert.throws(
    () => assertArchitectureSendChain(root),
    /the standalone send chain is intact/,
    'the criterion reds when the hook no longer calls the bridge',
  );
});

test('AC3: a tmp fixture with a second send caller breaks the chain', (t) => {
  const root = makeFixtureRoot(t);
  writeArchitectureChainFixture(root, {
    'src/modules/architecture/render/architecturePanelCanvas.tsx': [
      "import { sendArchitectureChatMessage } from './architectureChatBridge';",
      "export const resend = () => sendArchitectureChatMessage({ sessionId: null, text: 'x' });",
      '',
    ].join('\n'),
  });

  const chain = architectureSendChain(root);
  assert.deepEqual(
    chain.callerFiles,
    [
      'src/modules/architecture/render/architecturePanelCanvas.tsx',
      ARCHITECTURE_SEND_HOOK,
    ],
    'the reading reports both call sites',
  );
  assert.throws(
    () => assertArchitectureSendChain(root),
    /exactly one file calls the bridge/,
    'the criterion reds when a second file calls the bridge',
  );
});

// ── AC-459 expect: the non-goal identity is not collateral damage ─────────

test('AC4: a tmp fixture holding only the non-goal cloudcli identifiers stays clean', (t) => {
  const root = makeFixtureRoot(t);
  writeFixtureFile(
    root,
    'electron/main.js',
    [
      "const APP_USER_MODEL_ID = 'ai.cloudcli.desktop';",
      "const CALLBACK_URL = 'cloudcli://auth/callback';",
      "const CLOUDCLI_CONTROL_PLANE_URL = 'https://cloudcli.ai';",
      "connectUrl.searchParams.set('app_surface', 'cloudcli_desktop');",
      "const uri = 'cloudcli://session/<id>';",
      '',
    ].join('\n'),
  );
  writeFixtureFile(root, 'AGENTS.md', 'The `cloudcli://` observation URIs and `cloudcli.ai` are non-goals.\n');

  const detail = scanIdentitySurfacesDetailed(root);
  assert.equal(detail.filesScanned, 2, 'the fixture scan is not empty');
  assert.deepEqual(
    detail.violations,
    [],
    'a zero-hit scan must not forbid the cloudcli scheme, domain, surface tag or app id',
  );
});

test('AC4: the live non-goal identity pins are untouched', () => {
  const mainSource = readRepoFile('electron/main.js');
  assert.match(
    mainSource,
    /const APP_USER_MODEL_ID = 'ai\.cloudpit\.desktop';/,
    'the live app id follows the v3.0 switch (its legacy spelling is a non-goal token, not the live pin)',
  );
  assert.match(mainSource, /const CALLBACK_PROTOCOL = 'cloudcli';/, 'the login callback scheme is unchanged');
  assert.ok(
    mainSource.includes('const CALLBACK_URL = `${CALLBACK_PROTOCOL}://auth/callback`;'),
    'the login callback URL still resolves to cloudcli://auth/callback',
  );
  assert.ok(mainSource.includes("'https://cloudcli.ai'"), 'the control plane domain is unchanged');

  assert.match(
    readRepoFile('electron/cloud.js'),
    /app_surface', 'cloudcli_desktop'/,
    'the cloud surface tag is unchanged',
  );

  // v3.0 R13: the legacy app id survives only as the migration constant an upgrade
  // reads, never as the live pin asserted above.
  assert.match(
    readRepoFile('electron/appIdMigration.js'),
    /export const LEGACY_DESKTOP_APP_ID = 'ai\.cloudcli\.desktop';/,
    'the legacy app id is kept as the v3.0 migration constant',
  );

  // v3.0 R7 retires the dual-read observation grammar. The forbidden branch is
  // assembled from parts: this file lives inside the surface it scans (it is
  // excluded by path), so it must not carry a literal copy of it.
  //
  // The grammar itself now has ONE home — the repo-root `shared/` tree both compilers
  // compile (the fix for archguard's duplicate-code finding `dup-parse-observation-uri`) —
  // and the two former copies are pure re-export shims onto it. The canonical-spelling
  // reading is taken on that one file; each shim must point at it rather than restate it.
  const RETIRED_DUAL_READ_URI = `(?:${LEGACY_STEM}|cloudpit)://`;
  const grammarSource = readRepoFile('shared/observation/observationUri.ts');
  assert.ok(
    grammarSource.includes('^cloudpit://(session|architecture)/'),
    'the one observation URI grammar accepts only the canonical cloudpit:// spellings',
  );
  assert.ok(
    !grammarSource.includes(RETIRED_DUAL_READ_URI),
    'the one observation URI grammar accepts only the canonical cloudpit:// spellings (the retired dual-read branch is back)',
  );
  for (const file of [
    'src/modules/cockpit-contract/observationUri.ts',
    'server/modules/observation/core/observation-uri.ts',
  ]) {
    const source = readRepoFile(file);
    assert.ok(
      source.includes("from '@shared/observation/observationUri"),
      `${file} re-exports the one observation URI grammar`,
    );
    assert.ok(
      !source.includes('^cloudpit://(session|architecture)/'),
      `${file} must not restate the grammar: the shared module is the one implementation`,
    );
  }
});

// ── AC-459 expect: history stays history ─────────────────────────────────

test('AC6: the history ledger still records the pre-2.0 names', () => {
  const ledger = readRepoFile('docs/proposals/cloudpit-rename-SPEC.md');

  assert.ok(
    ledger.includes(LEGACY_IPC_PREFIX),
    `the rename spec still records at least one ${LEGACY_IPC_PREFIX} occurrence`,
  );
  assert.ok(
    ledger.includes(LEGACY_SCENARIO_GLOBAL),
    `the rename spec still records at least one ${LEGACY_SCENARIO_GLOBAL} occurrence`,
  );

  // The zero-hit scope is the live surface only. Assert that structurally
  // instead of leaving it implied by the positive arm: a scanned ledger would
  // red that arm, but only this pins the scan root itself.
  const scanned = collectSurfaceFiles(REPO_ROOT).map((file) => toRelative(REPO_ROOT, file));
  assert.ok(scanned.length >= 20, 'the scan root resolves to the live surface');
  for (const ledgerPrefix of [
    'tasks/',
    'goals/',
    'adr/',
    'experiments/',
    'docs/proposals/',
    'CHANGELOG',
  ]) {
    assert.deepEqual(
      scanned.filter((file) => file === ledgerPrefix || file.startsWith(ledgerPrefix)),
      [],
      `the scan root must not include the history ledger (${ledgerPrefix})`,
    );
  }
});
