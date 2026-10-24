/**
 * AC2 — the coarse classifier covers all ten ladder categories.
 *
 * Each category is driven by at least two positive phrases, written the way the
 * person actually spoke them (the probe's own examples are among them), plus a
 * block of ordinary discussion phrases that must fall through to
 * `discussion` rather than being claimed by a keyword. The readings are printed
 * per category so the table can be compared with the probe's phrase list.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LADDER_BASELINE,
  UTTERANCE_CLASSES,
  classifyUtterance,
  type UtteranceClass,
} from '@/modules/context-events/index.js';

/** At least two positives per category; the probe's examples are included verbatim. */
const POSITIVES: Readonly<Record<Exclude<UtteranceClass, 'discussion'>, readonly string[]>> = {
  'task-authoring': ['建 A、B、C 三个修复任务', '帮我立一个任务', '创建两个测试任务，然后再做'],
  'build-restart': ['Build + 安全重启。', '重新构建服务', '重启一下后端'],
  'landing-verification': ['检查是否已经落地可用', '这个功能落地了吗', '确认一下已经生效'],
  'progress-check': ['检查进展。', '现在进度如何？', '跑到哪了'],
  'browser-verification': ['用 MCP 浏览器访问……截图', '打开浏览器点一下那个按钮', 'playwright 跑一遍页面'],
  release: ['发版吧', 'npm publish 到 registry', '准备发布 1.40'],
  approval: ['好，继续', '同意，推进', '可以'],
  'session-collaboration': ['和 fleet 那个会话协作一下', '通知另一个会话', '转发给隔壁会话'],
  diagnosis: ['为什么这个测试红了', '排查一下报错', '诊断失败原因'],
};

/** Ordinary talk that mentions no act: every one must land in `discussion`. */
const DISCUSSION = [
  '今天天气不错',
  '这个图标颜色浅了一点',
  '我在想是不是该换个名字',
  '嗯，先聊聊方案',
  '这个设计我有点犹豫',
];

test('AC2: every category has at least two distinct positive phrases', () => {
  for (const [category, phrases] of Object.entries(POSITIVES)) {
    assert.ok(phrases.length >= 2, `${category} must have at least two positives`);
  }
  console.log(`AC2 categories=${UTTERANCE_CLASSES.length} positive_total=${Object.values(POSITIVES).flat().length}`);
});

for (const [category, phrases] of Object.entries(POSITIVES) as [UtteranceClass, readonly string[]][]) {
  test(`AC2: ${category} — ${phrases.length} positives classify as themselves`, () => {
    for (const phrase of phrases) {
      const reading = classifyUtterance(phrase);
      assert.equal(reading.class, category, `"${phrase}" read as ${reading.class} (rule ${reading.rule})`);
    }
    console.log(`AC2 ${category} checked=${phrases.length}`);
  });
}

test('AC2: discussion phrases fall through, and the fallback is honest about itself', () => {
  for (const phrase of DISCUSSION) {
    const reading = classifyUtterance(phrase);
    assert.equal(reading.class, 'discussion', `"${phrase}" read as ${reading.class} (rule ${reading.rule})`);
  }
  assert.equal(classifyUtterance('   ').class, 'discussion');
  console.log(`AC2 discussion checked=${DISCUSSION.length}`);
});

test('AC2: every category carries a baseline ladder level', () => {
  for (const category of UTTERANCE_CLASSES) {
    assert.ok(LADDER_BASELINE[category] === 'you-do' || LADDER_BASELINE[category] === 'system-suggests');
  }
  console.log(`AC2 ladder=${JSON.stringify(LADDER_BASELINE)}`);
});
