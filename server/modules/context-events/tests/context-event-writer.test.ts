/**
 * AC1 — the context event writer's write discipline.
 *
 * Each reading is taken against a temporary HOME and a FIXTURE schema document,
 * never the host's fleet installation, so the criterion measures the writer's
 * behaviour rather than this machine's state:
 *
 *   (a) a valid event is appended as exactly one line that parses back to the
 *       envelope the writer minted;
 *   (b) an event the schema rejects is refused AND leaves the file untouched;
 *   (c) a text field that would push the line past 16 KB is truncated and marked
 *       `data.truncated: true`, and the line really is inside the ceiling;
 *   (d) a missing schema document reads `schema-unavailable` and performs ZERO
 *       writes (the append is a value, not a throw);
 *   (e) fifty concurrent appends land as exactly fifty parseable lines — the
 *       O_APPEND single-write half of the discipline.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONTEXT_EVENT_MAX_LINE_BYTES,
  createContextEventWriter,
} from '@/modules/context-events/index.js';

/** The schema the fleet ships; this fixture states the same envelope keywords. */
const FIXTURE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['v', 'id', 'at', 'source', 'kind', 'data'],
  properties: {
    v: { const: 0 },
    id: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
    at: { type: 'string' },
    source: { const: 'cloudcli' },
    kind: {
      enum: [
        'utterance',
        'chip.shown',
        'chip.picked',
        'chip.redrawn',
        'focus',
        'reference.resolved',
        'send.previewed',
        'send.confirmed',
        'send.cancelled',
        'build.completed',
        'service.restarted',
        'correction',
        'shadow.prediction',
        'shadow.prediction.outcome',
      ],
    },
    project: { type: 'string' },
    session: { type: 'string' },
    refs: { type: 'array', items: { type: 'string' } },
    data: {
      type: 'object',
      // The writer may only carry the keys this fixture permits, which is what
      // gives (b) an invalid event the writer cannot otherwise avoid producing.
      additionalProperties: false,
      properties: { text: { type: 'string' } },
    },
  },
};

const DAY = '2026-10-24';
const AT = `${DAY}T12:00:00.000Z`;

/** Reads every parseable line of the day file. */
async function readDay(eventsDir: string): Promise<string[]> {
  const raw = await readFile(path.join(eventsDir, `${DAY}.jsonl`), 'utf8');
  return raw.split('\n').filter((line) => line !== '');
}

/** One isolated HOME with a fixture schema; the caller supplies the reader. */
async function withFixtureHome(
  run: (context: { homeDir: string; eventsDir: string; schemaPath: string }) => Promise<void>,
  options: { schema?: boolean } = {},
): Promise<void> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'context-writer-'));
  const eventsDir = path.join(homeDir, '.quay-fleet', 'context', 'events');
  const schemaPath = path.join(homeDir, 'fixture', 'context-event.schema.v0.json');
  try {
    if (options.schema !== false) {
      await mkdir(path.dirname(schemaPath), { recursive: true });
      await writeFile(schemaPath, JSON.stringify(FIXTURE_SCHEMA), 'utf8');
    }
    await run({ homeDir, eventsDir, schemaPath });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test('AC1 (a): a valid event appends as one parseable line with the minted envelope', async () => {
  await withFixtureHome(async ({ eventsDir, schemaPath }) => {
    const writer = createContextEventWriter({ eventsDir, schemaPath, now: () => Date.parse(AT) });
    const result = await writer.append({ kind: 'utterance', session: 's-1', at: AT, data: { text: '检查进展。' } });
    assert.equal(result.ok, true);

    const lines = await readDay(eventsDir);
    assert.equal(lines.length, 1, 'one append is one line');
    const event = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(event.v, 0);
    assert.equal(event.source, 'cloudcli');
    assert.equal(event.kind, 'utterance');
    assert.equal(event.session, 's-1');
    assert.match(String(event.id), /^[0-9A-HJKMNP-TV-Z]{26}$/, 'the id is a ULID');
    assert.equal(event.at, AT);
    assert.deepEqual(event.data, { text: '检查进展。' });
    assert.equal(writer.status().state, 'ok');
    assert.equal(writer.status().writes, 1);
    console.log(`AC1(a) lines=1 id=${event.id} kind=${event.kind}`);
  });
});

test('AC1 (b): a schema-rejected event is refused and writes nothing', async () => {
  await withFixtureHome(async ({ eventsDir, schemaPath }) => {
    const writer = createContextEventWriter({ eventsDir, schemaPath, now: () => Date.parse(AT) });
    const result = await writer.append({ kind: 'utterance', at: AT, data: { unexpected: 'not allowed' } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid');
    assert.equal(writer.status().rejected, 1);
    assert.equal(writer.status().writes, 0);

    await assert.rejects(readFile(path.join(eventsDir, `${DAY}.jsonl`), 'utf8'), 'no file may be created');
    console.log(`AC1(b) rejected=${writer.status().rejected} writes=0 file=absent`);
  });
});

test('AC1 (c): a text over 16 KB is truncated, marked, and stays inside the ceiling', async () => {
  await withFixtureHome(async ({ eventsDir, schemaPath }) => {
    const writer = createContextEventWriter({ eventsDir, schemaPath, now: () => Date.parse(AT) });
    const result = await writer.append({
      kind: 'utterance',
      at: AT,
      data: { text: 'x'.repeat(CONTEXT_EVENT_MAX_LINE_BYTES * 2) },
    });
    assert.equal(result.ok, true);

    const lines = await readDay(eventsDir);
    assert.equal(lines.length, 1);
    assert.ok(
      Buffer.byteLength(lines[0], 'utf8') <= CONTEXT_EVENT_MAX_LINE_BYTES,
      'the assembled line must fit the 16 KB ceiling',
    );
    const event = JSON.parse(lines[0]) as { data: { text: string; truncated?: boolean } };
    assert.equal(event.data.truncated, true);
    assert.ok(event.data.text.length < CONTEXT_EVENT_MAX_LINE_BYTES, 'the text was actually cut');
    console.log(`AC1(c) line_bytes=${Buffer.byteLength(lines[0], 'utf8')} text_chars=${event.data.text.length} truncated=${event.data.truncated}`);
  });
});

test('AC1 (d): a missing schema reads schema-unavailable and performs zero writes', async () => {
  await withFixtureHome(
    async ({ eventsDir, schemaPath }) => {
      const writer = createContextEventWriter({ eventsDir, schemaPath, now: () => Date.parse(AT) });
      const result = await writer.append({ kind: 'utterance', at: AT, data: { text: 'hello' } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'schema-unavailable');
      const status = writer.status();
      assert.equal(status.state, 'schema-unavailable');
      assert.match(status.reason ?? '', /schema unavailable/);
      assert.equal(status.writes, 0);
      await assert.rejects(readFile(path.join(eventsDir, `${DAY}.jsonl`), 'utf8'), 'no file may be created');
      console.log(`AC1(d) state=${status.state} writes=${status.writes} reason=${status.reason}`);
    },
    { schema: false },
  );
});

test('AC1 (e): fifty concurrent appends land as exactly fifty parseable lines', async () => {
  await withFixtureHome(async ({ eventsDir, schemaPath }) => {
    const writer = createContextEventWriter({ eventsDir, schemaPath, now: () => Date.parse(AT) });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        writer.append({ kind: 'utterance', at: AT, session: `s-${index}`, data: { text: `message ${index}` } }),
      ),
    );
    assert.equal(results.filter((result) => result.ok).length, 50);

    const lines = await readDay(eventsDir);
    assert.equal(lines.length, 50, 'every append is exactly one line');
    const ids = new Set<string>();
    for (const line of lines) {
      const event = JSON.parse(line) as { id: string; kind: string };
      assert.equal(event.kind, 'utterance');
      ids.add(event.id);
    }
    assert.equal(ids.size, 50, 'each line carries its own ULID');
    console.log(`AC1(e) lines=${lines.length} unique_ids=${ids.size}`);
  });
});
