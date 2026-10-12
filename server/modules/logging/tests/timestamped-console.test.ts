/**
 * The process-wide stdout stamp: every line an operator reads in `server.log` carries the instant
 * it was written.
 *
 * WHY THIS FILE EXISTS. `server.log` is the deployment's own append-only stdout (`StandardOutput=
 * append:…/server.log` in the systemd unit) and, until this criterion, it carried NO timestamp at
 * all — 78 MB of lines that cannot be dated. The cost was measured on 2026-10-12 while attributing
 * two process-fatal crashes: each one could only be placed in time by finding a later line that
 * happened to embed a date, and neither could be correlated with a voice connection's journal at
 * all. The relays' own journal (`.cloudcli/voice-realtime-log/*.jsonl`) HAS `at` on every line, so
 * the operator's two records could not be joined by time — the exact join the investigation needed.
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE IS THE ASSERTION THAT MATTERS:
 *
 *  - AC1: the stamp is `stampLines`' own output for an injected clock — deterministic, not "looks
 *    like a date". A criterion that pattern-matched a regex could pass with the wrong instant.
 *  - AC2: EVERY line of a multi-line message is stamped, not just the first. This is the reading
 *    that would have dated the crashes: a Node stack trace and an `util.inspect` dump are
 *    multi-line, and stamping only the head is what makes the rest undatable.
 *  - AC3: the underlying sink keeps receiving the message and its routing — `console.error` must
 *    still reach the error sink, and the text must survive byte for byte apart from the stamp.
 *  - AC4 (negative control): installing twice must NOT stamp twice. A second install would
 *    otherwise double every line, and the criterion that only checks "a stamp is present" stays
 *    green through it. Uninstall restores the sink to the exact function it had.
 *  - AC5: `%s`-style arguments and object arguments behave as `console.log` did — the object is
 *    still inspected rather than stringified to `[object Object]`, because the app's own JSON-ish
 *    dumps are what an investigator reads.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTimestampedConsole, stampLines } from '../timestamped-console.js';

/** A sink that records what reached it, per channel, so routing is readable. */
function recordingConsole() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    sink: {
      log: (...args: unknown[]) => void out.push(args.map(String).join(' ')),
      info: (...args: unknown[]) => void out.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => void out.push(args.map(String).join(' ')),
      debug: (...args: unknown[]) => void out.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => void err.push(args.map(String).join(' ')),
    },
  };
}

const AT = new Date('2026-10-12T01:28:54.219Z');

test('AC1: every line is prefixed with the injected instant, in ISO-8601 UTC', () => {
  assert.equal(stampLines('hello', AT), '2026-10-12T01:28:54.219Z hello');
});

test('AC2: EVERY line of a multi-line message is stamped, not only the first', () => {
  const stamped = stampLines('Error: boom\n    at f (x.js:1)\n    at g (y.js:2)', AT);
  const lines = stamped.split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(
      line.startsWith('2026-10-12T01:28:54.219Z '),
      `un-stamped continuation line (the crash-attribution reading): ${JSON.stringify(line)}`,
    );
  }
  assert.ok(lines[1].endsWith('at f (x.js:1)'));
});

test('AC2: a trailing newline does not manufacture a stamp-only last line', () => {
  assert.equal(stampLines('a\n', AT), '2026-10-12T01:28:54.219Z a\n');
});

test('AC3: the message still reaches its own sink, stamped, once installed', () => {
  const { out, err, sink } = recordingConsole();
  installTimestampedConsole(sink, { now: () => AT });
  sink.log('chat websocket connected');
  sink.error('write EPIPE');
  assert.deepEqual(out, ['2026-10-12T01:28:54.219Z chat websocket connected']);
  assert.deepEqual(err, ['2026-10-12T01:28:54.219Z write EPIPE']);
});

test('AC3: log/warn/info/debug keep the stdout sink and error keeps the stderr sink', () => {
  const { out, err, sink } = recordingConsole();
  installTimestampedConsole(sink, { now: () => AT });
  sink.log('l');
  sink.info('i');
  sink.warn('w');
  sink.debug('d');
  sink.error('e');
  assert.equal(out.length, 4);
  assert.equal(err.length, 1);
});

test('AC4 (negative control): a second install does NOT stamp a second time', () => {
  const { out, sink } = recordingConsole();
  installTimestampedConsole(sink, { now: () => AT });
  installTimestampedConsole(sink, { now: () => AT });
  sink.log('once');
  assert.deepEqual(out, ['2026-10-12T01:28:54.219Z once']);
});

test('AC4: uninstall restores the exact functions the sink had', () => {
  const { sink } = recordingConsole();
  const before = { log: sink.log, error: sink.error };
  const uninstall = installTimestampedConsole(sink, { now: () => AT });
  assert.notEqual(sink.log, before.log);
  uninstall();
  assert.equal(sink.log, before.log);
  assert.equal(sink.error, before.error);
});

test('AC5: object arguments are inspected, not stringified, and %s still substitutes', () => {
  const { out, sink } = recordingConsole();
  installTimestampedConsole(sink, { now: () => AT });
  sink.log({ sessionId: 'b280be43' });
  sink.log('frames=%d', 16000);
  assert.match(out[0], /^2026-10-12T01:28:54\.219Z \{ sessionId: 'b280be43' \}$/);
  assert.equal(out[1], '2026-10-12T01:28:54.219Z frames=16000');
});

test('AC2: an empty message is still stamped, so a blank line is datable', () => {
  assert.equal(stampLines('', AT), '2026-10-12T01:28:54.219Z ');
});
