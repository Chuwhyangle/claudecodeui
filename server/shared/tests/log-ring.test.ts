/**
 * The process-local log window criterion.
 *
 * It pins the bounds an operator relies on: the ring drops the OLDEST line when
 * either cap is exceeded and says so (`truncated`), `read` filters by since,
 * level and source, clamps `limit` into `[1, 500]` and returns the last N lines
 * in chronological order. Redaction is measured at APPEND time — a stored line
 * never contains the secret. The console tee is exercised once against a
 * replaced console and restored in a `finally`.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/log-ring.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampLogLimit,
  createLogRing,
  deriveLogSource,
  installConsoleLogTee,
  parseLogSince,
  redactLogText,
} from '../log-ring.js';

function lineText(index: number, padding = 0): string {
  return `[reply-suggestions] outcome=ok requestId=req-${String(index).padStart(4, '0')} ${'x'.repeat(padding)}`;
}

test('AC1-a: maxLines drops the oldest line and reports truncated', () => {
  const ring = createLogRing({ maxLines: 3, maxBytes: 1024 * 1024 });
  for (let index = 0; index < 5; index += 1) {
    ring.append({ level: 'info', text: lineText(index) });
  }
  const stats = ring.stats();
  assert.equal(stats.size, 3);
  assert.equal(stats.truncated, true, 'dropping a line for the line cap must set truncated');
  assert.deepEqual(ring.read({ limit: 10 }).map((line) => line.text.slice(0, 44)), [
    lineText(2).slice(0, 44),
    lineText(3).slice(0, 44),
    lineText(4).slice(0, 44),
  ]);
});

test('AC1-b: maxBytes drops the oldest line and reports truncated', () => {
  const probe = createLogRing();
  probe.append({ level: 'info', text: lineText(0, 40) });
  const unit = probe.stats().bytes;
  assert.ok(unit > 0);

  const ring = createLogRing({ maxLines: 100, maxBytes: unit * 2 + 10 });
  for (let index = 0; index < 4; index += 1) {
    ring.append({ level: 'info', text: lineText(index, 40) });
  }
  const stats = ring.stats();
  assert.equal(stats.size, 2, 'only the newest two lines fit the byte cap');
  assert.equal(stats.truncated, true);
  assert.ok(stats.bytes <= unit * 2 + 10);
  assert.match(ring.read({ limit: 10 })[0]?.text ?? '', /req-0002/);
});

test('AC1-c: read filters by since/level/source and returns the last N in order', () => {
  const ring = createLogRing({ now: () => Date.parse('2026-11-18T10:00:00.000Z') });
  ring.append({ at: '2026-11-18T09:00:00.000Z', level: 'info', source: 'server', text: 'old' });
  ring.append({ at: '2026-11-18T10:00:00.000Z', level: 'warn', source: 'reply-suggestions', text: 'warn-a' });
  ring.append({ at: '2026-11-18T10:00:01.000Z', level: 'error', source: 'reply-suggestions', text: 'err-b' });
  ring.append({ at: '2026-11-18T10:00:02.000Z', level: 'info', source: 'voice', text: 'voice-c' });

  assert.deepEqual(ring.read({}).map((line) => line.text), ['old', 'warn-a', 'err-b', 'voice-c'], 'chronological order');
  assert.deepEqual(ring.read({ source: 'reply-suggestions' }).map((line) => line.text), ['warn-a', 'err-b']);
  assert.deepEqual(ring.read({ level: 'error' }).map((line) => line.text), ['err-b']);
  assert.deepEqual(
    ring.read({ since: '2026-11-18T10:00:01.000Z' }).map((line) => line.text),
    ['err-b', 'voice-c'],
  );
  assert.deepEqual(ring.read({ since: Date.parse('2026-11-18T10:00:01.000Z') }).map((line) => line.text), ['err-b', 'voice-c']);
  assert.deepEqual(ring.read({ limit: 2 }).map((line) => line.text), ['err-b', 'voice-c'], 'the newest N');
});

test('AC1-d: limit is clamped to [1, 500]', () => {
  assert.equal(clampLogLimit(9999), 500);
  assert.equal(clampLogLimit(0), 1);
  assert.equal(clampLogLimit(-5), 1);
  assert.equal(clampLogLimit(undefined), 200);
  assert.equal(clampLogLimit(Number.NaN), 200);

  const ring = createLogRing({ maxLines: 800 });
  for (let index = 0; index < 800; index += 1) ring.append({ level: 'info', text: lineText(index) });
  assert.equal(ring.read({ limit: 9999 }).length, 500, '9999 is clamped to 500');
  assert.equal(ring.read({ limit: 0 }).length, 1, '0 is raised to 1');
  assert.equal(ring.read({ limit: 7 }).length, 7);
});

test('AC1-e: stats reports per-source count and lastAt consistent with the lines', () => {
  const ring = createLogRing();
  ring.append({ at: '2026-11-18T10:00:00.000Z', level: 'info', source: 'server', text: 'a' });
  ring.append({ at: '2026-11-18T10:00:01.000Z', level: 'info', source: 'reply-suggestions', text: 'b' });
  ring.append({ at: '2026-11-18T10:00:02.000Z', level: 'warn', source: 'reply-suggestions', text: 'c' });

  const stats = ring.stats();
  const byId = new Map(stats.sources.map((source) => [source.id, source]));
  assert.equal(byId.get('server')?.count, 1);
  assert.equal(byId.get('reply-suggestions')?.count, 2);
  assert.equal(byId.get('reply-suggestions')?.lastAt, '2026-11-18T10:00:02.000Z');
  assert.equal(byId.get('voice')?.count, 0);
  assert.equal(byId.get('voice')?.lastAt, null);
  assert.equal(byId.get('other')?.count, 0, 'the roster always names every known source');
});

test('AC1-f: redaction runs at append time for every fixture family', () => {
  const ring = createLogRing();
  const fixtures = [
    { text: 'sk-test-secret', token: 'sk-test-secret' },
    { text: 'LITELLM_API_KEY=sk-live-abcdefgh', token: 'sk-live-abcdefgh' },
    { text: 'Authorization: Bearer abc.def-ghi_jkl', token: 'abc.def-ghi_jkl' },
    { text: 'x-api-key: xyz123', token: 'xyz123' },
    { text: 'apiKey: my-api-secret', token: 'my-api-secret' },
    { text: 'client_secret=topsecret', token: 'topsecret' },
  ];
  for (const fixture of fixtures) ring.append({ level: 'error', text: `[server] failed ${fixture.text}` });

  const stored = ring.read({ limit: 100 }).map((line) => line.text).join('\n');
  for (const fixture of fixtures) {
    assert.ok(!stored.includes(fixture.token), `stored window must not contain ${fixture.token}`);
  }
  assert.equal((stored.match(/\[redacted\]/g) ?? []).length, fixtures.length, 'each fixture is replaced');
});

test('AC1-g: source derivation and since parsing are the shared readers', () => {
  assert.equal(deriveLogSource('[reply-suggestions] x'), 'reply-suggestions');
  assert.equal(deriveLogSource('[server] x'), 'server');
  assert.equal(deriveLogSource('[Sessions] x'), 'sessions');
  assert.equal(deriveLogSource('[voice-realtime] x'), 'voice');
  assert.equal(deriveLogSource('[lifecycle] x'), 'other');
  assert.equal(deriveLogSource('no prefix'), 'other');

  assert.equal(parseLogSince('2026-11-18T10:00:00.000Z'), Date.parse('2026-11-18T10:00:00.000Z'));
  assert.equal(parseLogSince('1795000000000'), 1795000000000);
  assert.equal(parseLogSince(1795000000000), 1795000000000);
  assert.equal(parseLogSince('not-a-date'), null);
  assert.equal(parseLogSince(''), null);
  assert.equal(parseLogSince(undefined), null);

  assert.equal(redactLogText('Bearer abc123'), '[redacted]');
});

test('AC1-h: the console tee is installed once, feeds the ring, and uninstalls', () => {
  const ring = createLogRing();
  const original = { log: console.log, warn: console.warn, error: console.error };
  const printed: string[] = [];
  const capture = (...args: unknown[]): void => { printed.push(args.map(String).join(' ')); };
  console.log = capture;
  console.warn = capture;
  try {
    const tee = installConsoleLogTee(ring);
    const second = installConsoleLogTee(ring);
    console.log('[reply-suggestions] draw requestId=req-1 httpStatus=502');
    console.warn('[server] degraded');
    second.uninstall();
    assert.equal(ring.read({ limit: 10 }).length, 2, 'a second install must not double-wrap');
    const lines = ring.read({ limit: 10 });
    assert.equal(lines[0]?.level, 'info');
    assert.equal(lines[0]?.source, 'reply-suggestions');
    assert.equal(lines[1]?.level, 'warn');
    assert.equal(lines[1]?.source, 'server');
    assert.equal(printed.length, 2, 'each line is still forwarded');
    tee.uninstall();
    console.log('[server] after uninstall');
    assert.equal(ring.read({ limit: 10 }).length, 2, 'an uninstalled tee appends nothing');
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
});
