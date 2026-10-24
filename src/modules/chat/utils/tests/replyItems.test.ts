/**
 * The reply-item primitives: extraction, addressing, and reference resolution.
 *
 * WHAT THIS PINS. A reply's numbered points are addressable only if three
 * things agree: what counts as an item, what address that item has, and which
 * ordinals a phrase like 「执行 1–2」 names. Each section below drives one of
 * them directly — no component, no i18n, no DOM — because an error here would
 * be an error in both the preview and the transcript labels at once.
 *
 * Run: npx vitest run src/modules/chat/utils/tests/replyItems.test.ts
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, test } from 'vitest';

import {
  extractReplyItems,
  findLatestReplyItems,
  formatReplyItemUri,
  parseReplyItemUri,
  replyItemLabel,
  resolveReplyReference,
} from '@/modules/chat/utils/transcript/replyItems';
import type { ReplyItem } from '@/modules/chat/utils/transcript/replyItems';

/** The four-item reply every resolution case below points at. */
const FOUR_ITEMS: ReplyItem[] = [
  { ordinal: 1, label: '①', excerpt: '安装依赖', kind: 'ordered' },
  { ordinal: 2, label: '②', excerpt: '运行测试', kind: 'ordered' },
  { ordinal: 3, label: '③', excerpt: '修复失败项', kind: 'ordered' },
  { ordinal: 4, label: '④', excerpt: '提交变更', kind: 'ordered' },
];

const kinds = (markdown: string): Array<[number, string, string]> =>
  extractReplyItems(markdown).map((item) => [item.ordinal, item.label, item.excerpt]);

describe('extractReplyItems', () => {
  test('top-level ordered list items, numbered by position', () => {
    const markdown = ['先做这些：', '', '1. 安装依赖', '2. 运行测试', '3. 提交变更'].join('\n');
    assert.deepEqual(kinds(markdown), [
      [1, '①', '安装依赖'],
      [2, '②', '运行测试'],
      [3, '③', '提交变更'],
    ]);
  });

  test('numbered headings are items, with the number stripped from the excerpt', () => {
    const markdown = ['## 1. 准备环境', '正文', '## 2、执行迁移', '正文'].join('\n');
    assert.deepEqual(kinds(markdown), [
      [1, '①', '准备环境'],
      [2, '②', '执行迁移'],
    ]);
  });

  test('a paragraph opening with a numbered bold run is an item', () => {
    const markdown = ['**1. 先备份数据库**，然后停服务。', '', '**2. 再升级**'].join('\n');
    assert.deepEqual(kinds(markdown), [
      [1, '①', '先备份数据库，然后停服务。'],
      [2, '②', '再升级'],
    ]);
  });

  test('numbered lines inside fenced code blocks and tables are not items', () => {
    const markdown = [
      '1. 真条目',
      '',
      '```bash',
      '1. echo not-an-item',
      '2. echo also-not',
      '```',
      '',
      '| # | 步骤 |',
      '| --- | --- |',
      '| 1. | 表里的数字不是条目 |',
      '',
      '2. 另一个真条目',
    ].join('\n');
    assert.deepEqual(kinds(markdown), [
      [1, '①', '真条目'],
      [2, '②', '另一个真条目'],
    ]);
  });

  test('unordered items are extracted only when there is no ordered list', () => {
    const unorderedOnly = ['- 第一项', '- 第二项'].join('\n');
    assert.deepEqual(kinds(unorderedOnly), [
      [1, '①', '第一项'],
      [2, '②', '第二项'],
    ]);

    const both = ['- 无序项', '', '1. 有序项一', '2. 有序项二'].join('\n');
    assert.deepEqual(kinds(both), [
      [1, '①', '有序项一'],
      [2, '②', '有序项二'],
    ]);
  });

  test('a reply without any numbered structure has no items', () => {
    assert.deepEqual(extractReplyItems('好的，我看完了。有问题再告诉我。'), []);
  });
});

describe('reply item addresses', () => {
  test('format and parse round-trip', () => {
    const address = { sessionId: 'session-42', messageId: 'msg-7', ordinal: 3 };
    const uri = formatReplyItemUri(address);
    assert.equal(uri, 'cloudcli://session/session-42/msg/msg-7#item-3');
    assert.deepEqual(parseReplyItemUri(uri), address);
  });

  test('foreign URIs are refused rather than half-parsed', () => {
    assert.equal(parseReplyItemUri('cloudcli://view/wall/item-1'), null);
    assert.equal(parseReplyItemUri('https://example.com/#item-1'), null);
  });

  test('labels are circled up to twenty', () => {
    assert.equal(replyItemLabel(1), '①');
    assert.equal(replyItemLabel(20), '⑳');
    assert.equal(replyItemLabel(21), '(21)');
  });
});

describe('resolveReplyReference', () => {
  const cases: Array<[string, string, number[]]> = [
    ['第 1 点', 'items', [1]],
    ['第三条', 'items', [3]],
    ['第二项', 'items', [2]],
    ['②', 'items', [2]],
    ['1–2', 'items', [1, 2]],
    ['执行 1–2', 'items', [1, 2]],
    ['1-3', 'items', [1, 2, 3]],
    ['1、3', 'items', [1, 3]],
    ['第 1 和第 3 点', 'items', [1, 3]],
    ['现在执行 1–2 并把 3 排成定时重启', 'items', [1, 2, 3]],
    ['前三条', 'items', [1, 2, 3]],
    ['最后一条', 'items', [4]],
    ['最后两条', 'items', [3, 4]],
  ];

  for (const [text, kind, ordinals] of cases) {
    test(`「${text}」 → ${kind} ${ordinals.join(',')}`, () => {
      const resolved = resolveReplyReference(text, FOUR_ITEMS);
      assert.equal(resolved.kind, kind);
      assert.deepEqual(resolved.ordinals, ordinals);
    });
  }

  test('「上述 5 项」 is all five when the reply has five items', () => {
    const five: ReplyItem[] = [...FOUR_ITEMS, { ordinal: 5, label: '⑤', excerpt: '收尾', kind: 'ordered' }];
    const resolved = resolveReplyReference('上述 5 项都要做', five);
    assert.equal(resolved.kind, 'items');
    assert.deepEqual(resolved.ordinals, [1, 2, 3, 4, 5]);
  });

  test('「上述 5 项」 is a mismatch when the reply has four items', () => {
    const resolved = resolveReplyReference('上述 5 项都要做', FOUR_ITEMS);
    assert.equal(resolved.kind, 'mismatch');
    assert.equal(resolved.expected, 5);
    assert.equal(resolved.total, 4);
    assert.deepEqual(resolved.ordinals, []);
  });

  test('an ordinal beyond the reply is a mismatch, not a clamped item', () => {
    const resolved = resolveReplyReference('执行第 6 点', FOUR_ITEMS);
    assert.equal(resolved.kind, 'mismatch');
    assert.equal(resolved.expected, 6);
    assert.equal(resolved.total, 4);
  });

  test('「按你的方案」 and 「按上面的」 name the whole reply', () => {
    assert.equal(resolveReplyReference('按你的方案做', FOUR_ITEMS).kind, 'reply');
    assert.equal(resolveReplyReference('按上面的来', FOUR_ITEMS).kind, 'reply');
    assert.equal(resolveReplyReference('上述方案可以', FOUR_ITEMS).kind, 'reply');
    assert.equal(resolveReplyReference('按你的意见，作者层改写', FOUR_ITEMS).kind, 'reply');
    assert.equal(resolveReplyReference('讨论应用这一方案的计划', FOUR_ITEMS).kind, 'reply');
  });

  test('time, verb phrases and first-times are not references', () => {
    for (const text of ['十二点开会', '一起看看', '第一次', '第一句的问题是']) {
      assert.equal(resolveReplyReference(text, FOUR_ITEMS).kind, 'none', text);
    }
  });

  test('an empty input references nothing', () => {
    assert.equal(resolveReplyReference('', FOUR_ITEMS).kind, 'none');
  });
});

describe('replyReference copy', () => {
  test('every shipped locale carries every preview key', () => {
    const localesDir = path.resolve(process.cwd(), 'src/modules/i18n/locales');
    const locales = readdirSync(localesDir).sort();
    assert.equal(locales.length, 12, 'all twelve locales are shipped');
    for (const locale of locales) {
      const common = JSON.parse(
        readFileSync(path.join(localesDir, locale, 'common.json'), 'utf8'),
      ) as { replyReference?: Record<string, unknown> };
      for (const key of ['item', 'itemsRange', 'itemsList', 'wholeReply', 'mismatch']) {
        assert.equal(
          typeof common.replyReference?.[key],
          'string',
          `${locale}/common.json is missing replyReference.${key}`,
        );
      }
    }
  });
});

describe('findLatestReplyItems', () => {
  test('picks the last assistant text reply, skipping thinking and tool rows', () => {
    const messages = [
      { type: 'assistant', content: '1. old item' },
      { type: 'user', content: '1. user text is not a reply' },
      { type: 'assistant', content: '让我查一下。' },
      { type: 'assistant', content: 'thinking', isThinking: true },
      { type: 'assistant', content: '1. 最新一项\n2. 最新二项' },
      { type: 'tool', content: '1. tool output' },
    ];
    const found = findLatestReplyItems(messages);
    assert.ok(found);
    assert.equal(found!.message, messages[4]);
    assert.deepEqual(found!.items.map((item) => item.excerpt), ['最新一项', '最新二项']);
  });

  test('a latest reply with no items does not fall back to an earlier reply', () => {
    const messages = [
      { type: 'assistant', content: '1. earlier item' },
      { type: 'assistant', content: '好的。' },
    ];
    assert.equal(findLatestReplyItems(messages), null);
  });
});
