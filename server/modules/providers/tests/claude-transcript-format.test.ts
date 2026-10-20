import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLocalCommandPayload } from '@/modules/providers/list/claude/claude-transcript-format.js';

/**
 * The shared local-command reader is consumed by BOTH read surfaces: the
 * history projection (`claude-sessions.provider.ts`) and transcript search
 * (`session-conversations-search.service.ts`). These cases pin the two
 * readings that decide what each surface sees: content with no wrapper tag
 * must read as "not a local command" (null), and a wrapper must read as the
 * structured `{commandName, commandMessage, commandArgs}` triple. Both
 * readings are written verbatim so a drift in either surface shows up as a
 * changed literal rather than a re-interpreted assertion.
 */

const UNRELATED_CONTENT = 'a plain user turn with no local command wrapper';

const TAGGED_CONTENT = [
  '<command-name>/model</command-name>',
  '<command-message>model</command-message>',
  '<command-args>opus</command-args>',
].join('\n');

type ParserReading = ReturnType<typeof parseLocalCommandPayload>;

type ParserCase = {
  name: string;
  content: string;
  /** The reading the shared reader must produce, written out verbatim. */
  reading: string;
  /** The same reading as a value, so deep equality is asserted too. */
  expected: ParserReading;
};

const cases: ParserCase[] = [
  {
    name: 'unrelated content',
    content: UNRELATED_CONTENT,
    reading: 'null',
    expected: null,
  },
  {
    name: 'tagged local command',
    content: TAGGED_CONTENT,
    reading: '{"commandName":"/model","commandMessage":"model","commandArgs":"opus"}',
    expected: {
      commandName: '/model',
      commandMessage: 'model',
      commandArgs: 'opus',
    },
  },
];

for (const parserCase of cases) {
  test(`parseLocalCommandPayload: ${parserCase.name}`, (t) => {
    const actual = parseLocalCommandPayload(parserCase.content);
    const reading = actual === null ? 'null' : JSON.stringify(actual);

    t.diagnostic(`parseLocalCommandPayload(${parserCase.name}) -> ${reading}`);
    assert.equal(reading, parserCase.reading);
    assert.deepEqual(actual, parserCase.expected);
  });
}
