/**
 * `uplinkVadGate.mts` 的 deterministic 测试。真执行 —— 断言直接驱动纯函数门控，任一规则不成立即红。
 *
 * 覆盖任务 AC2 要求的四条，外加 AC3 的「a 由解析值导出、写死即红」与 AC4 的顺序校验器：
 *
 *   1. 段首段整段丢弃（流开头、任何语音帧之前的非语音段不保留任何帧）；
 *   2. 非语音段保留开头 `a`（每段只保留开头 `aFrames` 帧）；
 *   3. 被保留的样本**逐字节等于原流对应位置**（证明不是合成零样本）；
 *   4. 短于 `a` 的段整段保留；
 *   5. `a` 跟随**解析后的** `silence_duration_ms`（400 ⇒ 21 帧 / 420 ms；800 ⇒ 41 帧 / 820 ms）；
 *      写死 420 的实现会让 800 那条用例红。
 *   6. 退出路径顺序校验器：`commit → response.create → … → close` 良构；`close`（收尾直接 ws.close）
 *      与 `response.create` 在 `commit` 之前都判红。
 *
 * 直接跑（experiments/ 不在任何 tsconfig / 测试 glob 里，不属于套件）：
 *   npx tsx --tsconfig server/tsconfig.json --test experiments/voice-realtime-vad-three-arm/uplinkVadGate.test.mts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UPLINK_VAD_FRAME_MS,
  initialUplinkVadGateState,
  materializeUplinkVadFrames,
  planUplinkVadGate,
  reduceUplinkVadFrame,
  summarizeUplinkVadActions,
  uplinkExitHasCommitAndResponse,
  uplinkExitIsWellFormed,
  uplinkHeadKeepFrames,
  uplinkHeadKeepMs,
} from './uplinkVadGate.mts';
import type { UplinkVadAction } from './uplinkVadGate.mts';

const HEAD = 3; // 本文件多数用例的保留窗，单位帧
const count = (actions: readonly UplinkVadAction[], want: UplinkVadAction): number =>
  actions.filter((a) => a === want).length;
/** 一段掩码里，每个非语音段的运行长度（用于断言「逐段保留开头 a」）。 */
const nonSpeechRuns = (mask: string): number[] => mask.split('1').map((run) => run.length).filter((n) => n > 0);

// ── (1) 段首段整段丢弃 ─────────────────────────────────────────────────────────────────────────

test('段首段（任何语音帧之前的非语音）整段丢弃，一帧不留', () => {
  // 10 帧段首段 + 1 帧语音 + 5 帧非语音段。
  const mask = '0'.repeat(10) + '1' + '0'.repeat(5);
  const actions = planUplinkVadGate(mask, HEAD);
  // 段首段的 10 帧全部 drop —— 上游此时没有待闭合的东西。
  assert.deepEqual(
    actions.slice(0, 10),
    Array.from({ length: 10 }, () => 'drop'),
    '段首段的每一帧都必须是 drop',
  );
  assert.equal(count(actions, 'send-head-kept') >= 10, false, '段首段不得产生任何 send-head-kept');
  // 段首段里连一帧都没被保留：前 10 帧的 send-head-kept 计数为 0。
  assert.equal(count(actions.slice(0, 10), 'send-head-kept'), 0);
});

test('负对照：把段首段换成相同长度的「已见语音」后置段，同样长度就会保留 —— 证明 (1) 不是空洞', () => {
  const leading = '0'.repeat(10) + '1'; // 10 帧段首段
  const postponed = '1' + '0'.repeat(10); // 10 帧后置段
  assert.equal(count(planUplinkVadGate(leading, HEAD), 'send-head-kept'), 0);
  assert.equal(count(planUplinkVadGate(postponed, HEAD), 'send-head-kept'), HEAD);
});

// ── (2) 非语音段保留开头 a ─────────────────────────────────────────────────────────────────────

test('每个非语音段只保留开头 a 帧，其余丢弃；每段独立重置', () => {
  const mask = '1' + '0'.repeat(5) + '1' + '0'.repeat(8) + '1' + '0'.repeat(2);
  const actions = planUplinkVadGate(mask, HEAD);
  const summary = summarizeUplinkVadActions(actions);
  // 三段非语音：5 ⇒ 保留 3、8 ⇒ 保留 3、2 ⇒ 保留 2（短于 a，整段保留）。
  assert.equal(summary.headKept, HEAD + HEAD + 2, '每段保留 min(runLen, a) 帧');
  assert.equal(summary.sentFrames, 3 /* 语音 */ + summary.headKept);
  // 逐段核对：第一段（索引 1..5）前 3 帧 kept、后 2 帧 drop。
  assert.deepEqual(actions.slice(1, 6), ['send-head-kept', 'send-head-kept', 'send-head-kept', 'drop', 'drop']);
});

test('单帧归约是纯因果的：语音帧清空段内计数，非语音段索引随帧推进', () => {
  let state = initialUplinkVadGateState();
  const step = (bit: string) => {
    const r = reduceUplinkVadFrame(state, bit, HEAD);
    state = r.state;
    return r.action;
  };
  assert.equal(step('0'), 'drop'); // 段首段
  assert.equal(step('1'), 'send-real'); // 见到语音
  assert.equal(step('0'), 'send-head-kept'); // 第 0 帧
  assert.equal(step('0'), 'send-head-kept'); // 第 1 帧
  assert.equal(step('0'), 'send-head-kept'); // 第 2 帧
  assert.equal(step('0'), 'drop'); // 第 3 帧 = HEAD，出窗
  assert.equal(step('1'), 'send-real'); // 语音帧重置
  assert.equal(step('0'), 'send-head-kept'); // 新段第 0 帧
});

// ── (3) 被保留的样本逐字节等于原流对应位置（不是合成） ─────────────────────────────────────────

test('被保留的样本逐字节等于原流对应位置，且非全零 —— 证明不是合成零样本', () => {
  const FRAME_BYTES = 4;
  const mask = '0'.repeat(4) + '1' + '0'.repeat(6); // 4 段首 + 语音 + 6 非语音
  const frameCount = mask.length;
  // 每一帧的 4 字节都是**非零、且逐帧不同**的模式：零样本实现不可能碰巧相等。
  const pcm = Buffer.from(
    Array.from({ length: frameCount * FRAME_BYTES }, (_, i) => ((i * 7) % 254) + 1),
  );
  const planned = materializeUplinkVadFrames({ pcm, mask, aFrames: HEAD, frameBytes: FRAME_BYTES });

  // 段首段的 4 帧不在计划里。
  for (const frame of planned) assert.ok(frame.index >= 4, `段首段的帧 ${frame.index} 不该被发出`);
  // 逐帧：计划里的样本 === 原流该位置的样本（逐字节）。
  for (const frame of planned) {
    assert.ok(
      frame.frame.equals(pcm.subarray(frame.index * FRAME_BYTES, (frame.index + 1) * FRAME_BYTES)),
      `帧 ${frame.index} 必须逐字节等于原流对应位置`,
    );
  }
  // 被保留的段首帧（head-kept）确实非全零 —— 若实现改为合成零样本，这里必红。
  const headKept = planned.filter((f) => f.action === 'send-head-kept');
  assert.equal(headKept.length, HEAD, '6 帧非语音段里保留开头 3 帧');
  for (const frame of headKept) {
    assert.equal(frame.frame.every((b) => b === 0), false, `head-kept 帧 ${frame.index} 不得是全零合成样本`);
  }
});

// ── (4) 短于 a 的段整段保留 ────────────────────────────────────────────────────────────────────

test('短于 a 的非语音段整段保留（逐帧全发）', () => {
  const aFrames = 5;
  const mask = '1' + '0'.repeat(3) + '1'; // 中间段长 3 < a=5
  const actions = planUplinkVadGate(mask, aFrames);
  assert.deepEqual(actions.slice(1, 4), ['send-head-kept', 'send-head-kept', 'send-head-kept']);
  assert.equal(count(actions, 'drop'), 0, '短于 a 的段没有任何帧被丢');
});

// ── (5) a 由解析后的 silence_duration_ms 导出（AC3 假形态） ────────────────────────────────────

test('a 由解析后的 silence_duration_ms 导出：400⇒21 帧/420 ms，800⇒41 帧/820 ms —— 写死即红', () => {
  assert.equal(UPLINK_VAD_FRAME_MS, 20);
  assert.equal(uplinkHeadKeepFrames(400), 21);
  assert.equal(uplinkHeadKeepMs(400), 420);
  assert.equal(uplinkHeadKeepFrames(800), 41);
  assert.equal(uplinkHeadKeepMs(800), 820);
  assert.notEqual(uplinkHeadKeepMs(800), uplinkHeadKeepMs(400), 'a 必须随解析值变化');

  // 保留窗在整条掩码上的**实测**效果：段首 10 + 语音 + 60 非语音。
  const mask = '0'.repeat(10) + '1' + '0'.repeat(60);
  const plan400 = planUplinkVadGate(mask, uplinkHeadKeepFrames(400));
  const plan800 = planUplinkVadGate(mask, uplinkHeadKeepFrames(800));
  assert.equal(count(plan400, 'send-head-kept'), 21, 'silence=400 ⇒ 保留 21 帧');
  assert.equal(count(plan800, 'send-head-kept'), 41, 'silence=800 ⇒ 保留 41 帧');
  // 写死 420 ms 的实现会在这条上红：800 的读数会停在 21 而不是 41。
  assert.notEqual(count(plan800, 'send-head-kept'), count(plan400, 'send-head-kept'));
});

// ── (6) 退出路径（方案 §6.3）顺序校验器 ─────────────────────────────────────────────────────────

test('退出路径良构：commit → response.create → bounded-wait → close', () => {
  const good = ['input_audio_buffer.commit', 'response.create', 'bounded-wait', 'socket-close'];
  assert.equal(uplinkExitIsWellFormed(good), true);
  assert.equal(uplinkExitHasCommitAndResponse(good), true);
  // 假形态 A（收尾直接 ws.close）：没有 commit/response.create ⇒ 判红。
  assert.equal(uplinkExitHasCommitAndResponse(['socket-close']), false);
  // 假形态 B（先关再发）：顺序乱 ⇒ 判红。
  assert.equal(uplinkExitIsWellFormed(['socket-close', 'input_audio_buffer.commit']), false);
  // 乱序 commit/response.create 也判红。
  assert.equal(uplinkExitHasCommitAndResponse(['response.create', 'input_audio_buffer.commit', 'socket-close']), false);
});

// ── 辅助不变式：段运行长度统计与门控无关地成立（防止测试自身写错） ─────────────────────────────────

test('nonSpeechRuns 辅助：掩码分段的长度统计', () => {
  assert.deepEqual(nonSpeechRuns('1' + '0'.repeat(5) + '1' + '0'.repeat(2)), [5, 2]);
  assert.deepEqual(nonSpeechRuns('0'.repeat(3) + '1'), [3]);
});
