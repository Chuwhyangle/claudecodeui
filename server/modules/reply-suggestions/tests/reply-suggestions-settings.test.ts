/**
 * Reply-suggestions settings criterion.
 *
 * Each leg drives the real reader against a temp file: defaults, explicit-path
 * reporting, validation fallbacks, the key-file grammar, the modification-time
 * cache, key hygiene, credential opacity and the mode check.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/reply-suggestions/tests/reply-suggestions-settings.test.ts
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { format, inspect } from 'node:util';

import { createReplySuggestionsService } from '../reply-suggestions.service.js';
import {
  ApiCredential,
  createReplySuggestionsSettingsSource,
  REPLY_SUGGESTIONS_SETTINGS_PATH_ENV,
  type ReplySuggestionsSettings,
} from '../reply-suggestions-settings.js';

function temporaryDirectory(t: { after(callback: () => void): void }, prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(filePath: string, value: unknown, mode = 0o600): string {
  writeFileSync(filePath, JSON.stringify(value), { mode });
  chmodSync(filePath, mode);
  return filePath;
}

function read(settingsPath: string | null, homeDir: string): ReplySuggestionsSettings {
  return createReplySuggestionsSettingsSource({ settingsPath, homeDir }).read();
}

/** The defaults table, spelled once so the omitted-key leg can compare every group. */
const EXPECTED_DEFAULTS = {
  version: 'example-1',
  enabled: false,
  upstream: {
    protocol: 'anthropic',
    baseUrl: '',
    model: '',
    authScheme: '',
    disableThinking: true,
    timeoutMs: 5000,
  },
  generation: {
    temperature: 0.3,
    redrawTemperature: 1.0,
    maxOutputTokens: 400,
    maxChips: 3,
    maxChipChars: 120,
    maxTailChars: 1500,
    maxFocusChars: 600,
    expansion: 'off',
    systemPrompt: '',
  },
  limits: {
    maxCallsPerMinute: 30,
    maxCallsPerDay: 3000,
  },
  usageLog: true,
  diagnostics: {
    configuredEnabled: false,
    apiKeyFile: '',
    apiKeyVar: '',
  },
} as const;

test('(a) no settings file at all: feature off, problems empty', (t) => {
  const home = temporaryDirectory(t, 'reply-settings-a-');
  const settings = read(null, home);
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.diagnostics.problems, []);
  assert.equal(settings.diagnostics.source, 'default');
});

test('(b) an explicitly named path that cannot be read reports the problem and stays off', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-b-');
  const missing = path.join(directory, 'does-not-exist.json');
  const settings = read(missing, directory);
  assert.equal(settings.enabled, false);
  assert.equal(settings.diagnostics.problems.length, 1);
  assert.match(settings.diagnostics.problems[0], /could not read/);
  assert.ok(settings.diagnostics.problems[0].includes(missing), 'the problem names the path that could not be read');
});

test('(c) an empty settings object reads every key at its shipped default', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-c-');
  const file = writeJson(path.join(directory, 'settings.json'), {});
  const settings = read(file, directory);
  assert.deepEqual(settings.diagnostics.problems, []);
  assert.equal(settings.version, EXPECTED_DEFAULTS.version);
  assert.equal(settings.enabled, EXPECTED_DEFAULTS.enabled);
  assert.deepEqual(
    { ...settings.upstream, credential: undefined },
    { ...EXPECTED_DEFAULTS.upstream, credential: undefined },
  );
  assert.deepEqual(settings.generation, EXPECTED_DEFAULTS.generation);
  assert.deepEqual(settings.limits, EXPECTED_DEFAULTS.limits);
  assert.equal(settings.usageLog, EXPECTED_DEFAULTS.usageLog);
  assert.deepEqual(
    {
      configuredEnabled: settings.diagnostics.configuredEnabled,
      apiKeyFile: settings.diagnostics.apiKeyFile,
      apiKeyVar: settings.diagnostics.apiKeyVar,
    },
    EXPECTED_DEFAULTS.diagnostics,
  );
  assert.equal(settings.diagnostics.source, 'file');
  assert.equal(settings.diagnostics.path, file);
  assert.equal(settings.upstream.credential.reveal(), '');
});

test('(d) an invalid known key falls back to its default and names itself; an unknown key is ignored', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-d-');
  const file = writeJson(path.join(directory, 'settings.json'), {
    temperature: 'hot',
    protocol: 'grpc',
    maxChips: 0,
    expansion: 'sometimes',
    unknownKnob: 42,
  });
  const settings = read(file, directory);
  assert.equal(settings.generation.temperature, 0.3);
  assert.equal(settings.upstream.protocol, 'anthropic');
  assert.equal(settings.generation.maxChips, 3);
  assert.equal(settings.generation.expansion, 'off');
  const problems = settings.diagnostics.problems.join('\n');
  for (const key of ['temperature', 'protocol', 'maxChips', 'expansion']) {
    assert.ok(problems.includes(`\`${key}\``), `problems name ${key}: ${problems}`);
  }
  assert.ok(!problems.includes('unknownKnob'), 'an unknown key produces no problem');
});

test('(e1) enabled without baseUrl reads as off and names baseUrl', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-e1-');
  const keyFile = path.join(directory, 'key.txt');
  writeFileSync(keyFile, 'sk-test\n', { mode: 0o600 });
  const file = writeJson(path.join(directory, 'settings.json'), {
    enabled: true,
    model: 'test-model',
    apiKeyFile: keyFile,
  });
  const settings = read(file, directory);
  assert.equal(settings.diagnostics.configuredEnabled, true);
  assert.equal(settings.enabled, false);
  assert.ok(settings.diagnostics.problems.join('\n').includes('`baseUrl`'));
});

test('(e2) enabled without model reads as off and names model', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-e2-');
  const keyFile = path.join(directory, 'key.txt');
  writeFileSync(keyFile, 'sk-test\n', { mode: 0o600 });
  const file = writeJson(path.join(directory, 'settings.json'), {
    enabled: true,
    baseUrl: 'http://gateway.invalid',
    apiKeyFile: keyFile,
  });
  const settings = read(file, directory);
  assert.equal(settings.enabled, false);
  assert.ok(settings.diagnostics.problems.join('\n').includes('`model`'));
});

test('(e3) enabled without a key reads as off and names the key source', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-e3-');
  const file = writeJson(path.join(directory, 'settings.json'), {
    enabled: true,
    baseUrl: 'http://gateway.invalid',
    model: 'test-model',
  });
  const settings = read(file, directory);
  assert.equal(settings.enabled, false);
  const problems = settings.diagnostics.problems.join('\n');
  assert.ok(problems.includes('`apiKeyFile`'), problems);
});

test('(f) the key-file grammar: bare, NAME=value, export, quotes, apiKeyVar and ~', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-f-');

  const plain = path.join(directory, 'plain.key');
  writeFileSync(plain, '  sk-plain  \n', { mode: 0o600 });
  assert.equal(readKeyFor(directory, plain, ''), 'sk-plain');

  const assignment = path.join(directory, 'assignment.key');
  writeFileSync(assignment, 'FJDAC_API_KEY=sk-assignment\n', { mode: 0o600 });
  assert.equal(readKeyFor(directory, assignment, ''), 'sk-assignment');

  const exportedDouble = path.join(directory, 'exported-double.key');
  writeFileSync(exportedDouble, 'export FJDAC_API_KEY="sk-exported-double"\n', { mode: 0o600 });
  assert.equal(readKeyFor(directory, exportedDouble, ''), 'sk-exported-double');

  const single = path.join(directory, 'single.key');
  writeFileSync(single, "export FJDAC_API_KEY='sk-single'\n", { mode: 0o600 });
  assert.equal(readKeyFor(directory, single, ''), 'sk-single');

  const multiple = path.join(directory, 'multiple.key');
  writeFileSync(multiple, 'OTHER=sk-other\nFJDAC_API_KEY=sk-selected\n', { mode: 0o600 });
  assert.equal(readKeyFor(directory, multiple, 'FJDAC_API_KEY'), 'sk-selected');

  const home = temporaryDirectory(t, 'reply-settings-f-home-');
  writeFileSync(path.join(home, 'home.key'), 'sk-home\n', { mode: 0o600 });
  assert.equal(readKeyFor(home, '~/home.key', ''), 'sk-home');
});

/** Read a key through a minimal enabled settings file. */
function readKeyFor(homeDir: string, apiKeyFile: string, apiKeyVar: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'reply-settings-key-'));
  try {
    const file = path.join(directory, 'settings.json');
    writeJson(file, {
      enabled: true,
      baseUrl: 'http://gateway.invalid',
      model: 'test-model',
      apiKeyFile,
      apiKeyVar,
    });
    return createReplySuggestionsSettingsSource({ settingsPath: file, homeDir }).read().upstream.credential.reveal();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('(g) a changed modification time re-reads; an unchanged one keeps the cached reading', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-g-');
  const file = path.join(directory, 'settings.json');
  const source = createReplySuggestionsSettingsSource({ settingsPath: file, homeDir: directory });

  writeJson(file, { temperature: 0.5 });
  const firstMtime = 1_780_000_000;
  utimesSync(file, firstMtime, firstMtime);
  assert.equal(source.read().generation.temperature, 0.5);

  writeJson(file, { temperature: 1.5 });
  const secondMtime = firstMtime + 5;
  utimesSync(file, secondMtime, secondMtime);
  assert.equal(source.read().generation.temperature, 1.5, 'a changed mtime re-reads the file');

  // Change the CONTENT but force the previous mtime back: the reader must keep
  // the cached reading (the documented "mtime unchanged -> no re-read" rule).
  writeJson(file, { temperature: 1.7 });
  utimesSync(file, secondMtime, secondMtime);
  assert.equal(statSync(file).mtimeMs, Math.trunc(secondMtime * 1000));
  assert.equal(source.read().generation.temperature, 1.5, 'an unchanged mtime must not re-read');
});

test('(h) the key never reaches problems or the public status object', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-h-');
  const secret = 'sk-super-secret-value';
  const keyFile = path.join(directory, 'key.txt');
  writeFileSync(keyFile, `${secret}\n`, { mode: 0o644 }); // also provokes the mode problem
  const file = writeJson(path.join(directory, 'settings.json'), {
    enabled: true,
    baseUrl: 'http://gateway.invalid',
    model: 'test-model',
    apiKeyFile: keyFile,
    temperature: 'hot',
  });
  const source = createReplySuggestionsSettingsSource({ settingsPath: file, homeDir: directory });
  const settings = source.read();
  assert.equal(settings.upstream.credential.reveal(), secret);
  assert.ok(settings.diagnostics.problems.length > 0);
  assert.ok(!settings.diagnostics.problems.join('\n').includes(secret), 'problems must not echo the key');

  const service = createReplySuggestionsService({
    readSettings: () => source.read(),
    readLastAssistantMessage: async () => null,
  });
  assert.ok(!JSON.stringify(service.status()).includes(secret), 'the status object must not carry the key');
});

test('(i) a key file wider than mode 600 is reported but is not fatal', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-i-');
  const keyFile = path.join(directory, 'wide.key');
  writeFileSync(keyFile, 'sk-wide\n');
  chmodSync(keyFile, 0o644);
  const file = writeJson(path.join(directory, 'settings.json'), {
    enabled: true,
    baseUrl: 'http://gateway.invalid',
    model: 'test-model',
    apiKeyFile: keyFile,
  });
  const settings = read(file, directory);
  assert.equal(settings.enabled, true, 'the mode problem does not disable the feature');
  const problems = settings.diagnostics.problems.join('\n');
  assert.match(problems, /600/);
  assert.ok(problems.includes(keyFile), problems);
  assert.ok(!problems.includes('sk-wide'), 'the problem names the file, never the key');
});

test('the environment names the file when no explicit path is passed', (t) => {
  const directory = temporaryDirectory(t, 'reply-settings-env-');
  const file = writeJson(path.join(directory, 'env.json'), { version: 'from-env' });
  const source = createReplySuggestionsSettingsSource({
    homeDir: directory,
    env: { [REPLY_SUGGESTIONS_SETTINGS_PATH_ENV]: file } as NodeJS.ProcessEnv,
  });
  assert.equal(source.read().version, 'from-env');
});

// ---------------------------------------------------------------------------
// Credential opacity: the secret cannot leave through serialisation or printing
// ---------------------------------------------------------------------------

/** A full reading whose credential carries `secret`. */
function readingWithSecret(t: { after(callback: () => void): void }): {
  settings: ReplySuggestionsSettings;
  secret: string;
} {
  const directory = temporaryDirectory(t, 'reply-settings-credential-');
  const secret = 'sk-credential-opacity-secret';
  const keyFile = path.join(directory, 'key.txt');
  writeFileSync(keyFile, `${secret}\n`, { mode: 0o600 });
  const file = writeJson(path.join(directory, 'settings.json'), {
    enabled: true,
    baseUrl: 'http://gateway.invalid',
    model: 'test-model',
    apiKeyFile: keyFile,
  });
  return { settings: read(file, directory), secret };
}

test('(credential-a) JSON.stringify of the whole reading and its upstream group carries no key', (t) => {
  const { settings, secret } = readingWithSecret(t);
  assert.ok(!JSON.stringify(settings).includes(secret));
  assert.ok(!JSON.stringify(settings.upstream).includes(secret));
  assert.match(JSON.stringify(settings.upstream), /"credential":"\[redacted\]"/);
});

test('(credential-b) util.inspect of the whole reading carries no key', (t) => {
  const { settings, secret } = readingWithSecret(t);
  const printed = inspect(settings, { depth: null });
  assert.ok(!printed.includes(secret), 'the inspected reading must not carry the key');
  assert.ok(printed.includes('[redacted]'), 'the credential is shown as [redacted]');
});

test('(credential-c) String() and a template literal both answer [redacted]', (t) => {
  const { settings, secret } = readingWithSecret(t);
  assert.equal(String(settings.upstream.credential), '[redacted]');
  assert.equal(`${settings.upstream.credential}`, '[redacted]');
  assert.ok(!`${settings.upstream.credential}`.includes(secret));
});

test('(credential-d) reveal() returns the original value', (t) => {
  const { settings, secret } = readingWithSecret(t);
  assert.equal(settings.upstream.credential.reveal(), secret);
});

test('(credential-e) console.log formatting of the reading carries no key', (t) => {
  const { settings, secret } = readingWithSecret(t);
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(format(...args));
  };
  try {
    console.log(settings);
  } finally {
    console.log = original;
  }
  const printed = lines.join('\n');
  assert.ok(!printed.includes(secret), 'the console-formatted reading must not carry the key');
  assert.ok(printed.includes('[redacted]'));
});

test('ApiCredential is constructible from a bare value and hides it by construction', () => {
  const credential = new ApiCredential('sk-standalone');
  assert.equal(credential.reveal(), 'sk-standalone');
  assert.equal(JSON.stringify([credential]), '["[redacted]"]');
  assert.equal(inspect(credential), '[redacted]');
});
