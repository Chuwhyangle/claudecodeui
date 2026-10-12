---
id: gap-live-voice-caption-segment-attribution-by-item-id
title: 转写与分段按上游 itemId 归属：晚到转写记到自己的 segmentSeq，不污染到达时的 active
  段；提交被拒/上游自建条目诚实标注；向浏览器下发 seq↔itemId（不自动补发）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-segmented-replay-20261012
  - gap-live-voice-interrupt-after-revision-enqueued
  - gap-live-voice-queue-depth-refresh-on-turn-boundary
  - gap-live-voice-scripted-upstream-protocol-state-machine
goal_ac: AC-354
---
## Proposal

### 问题（代码已核对，2026-10-12）

- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 的 `onCaption`（约 :2066-2095）对最终转写用**到达时**的 `activeSegmentSeq` 做 `segmentTranscriptEmpty.set`、`markSegmentEmpty`、held delivery 释放；`activeSegmentSeq` 只随 segment 事件变化（约 :2010），段只在 `response.done` 才 settle。`session_send` 也按 active 段归属（约 :1837-1848），held 调用最多等 `SEGMENT_TRANSCRIPT_GRACE_MS`=600ms 后 fail-open。
- bridge 的 caption 带 `itemId`（`voice-realtime-bridge.service.ts` 约 :809-814），但 proxy 没有 seq↔itemId 映射；`onUserAudioCommitted` 不带 item id。
- Realtime 输入输出都是流式、延迟不确定（人 yale：晚到是正常的）。journal ef9daacd…：S2 的转写在 seq2 提交后才到，S4 在 seq4，S5 在 seq5，均可能落在下一段名下；空转写晚到时会把**下一段**判空，进而拒收那一段的真实转发。

### 要做的事

- 每次提交得到的 `input_audio_buffer.committed` / `conversation.item.created` 的 item_id 与该提交的 seq 建立映射；提交报错（buffer too small）的 seq 记 rejected；上游 VAD 自建、无法对应提交的条目记 seq=null，不默认归给 active 段。
- 最终转写按 itemId→seq 归属：`segmentTranscriptEmpty`、`markSegmentEmpty`、held delivery 释放都作用于转写所属段。
- 浏览器帧携带 seq 与 itemId（caption 增字段或新增 segment 提交帧），供前端按说话顺序放置与标记未识别（下游任务 `gap-live-voice-segment-honest-heard-unrecognized-state`）。
- 回放 spec 中缺陷腿 (b) 去掉 `test.fail()` 转绿。

### SCOPE BOUNDARY

- ⛔ **不**新增任何把转写自动投递给 Claude 的路径：模型未调用 session_send 的转写投递次数恒为 0（人 yale 2026-10-12 裁定）。
- ⛔ 不改中断/栅栏/队列深度/撤回语义（GOAL-041）；本任务依赖 ws-proxy 上在途的 A+ 任务先落地，串行改同一文件。
- ⛔ 不重启 :3001。

## Plan

1. 判据测试（先红）；2. bridge 暴露 committed item id；3. proxy 映射与归属；4. 浏览器帧字段（前端只需容忍新字段，不改渲染）；5. 回放腿 (b) 翻绿；6. 计数钉子与基线；typecheck/lint。

## AC

- [x] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-caption-item-attribution.test.ts` 退出 0；首组用例在「改回按 activeSegmentSeq 归属」的假形态下断言 seq N+1 被错误标记（证明会红）。
- [x] AC2：seq N 的条目转写在 seq N+1 已提交后到达时，空转写标记、held delivery 释放都作用于 seq N；空转写晚到变体中 seq N+1 的真实 session_send 不被拒收。
- [x] AC3：提交被拒的 seq 记 rejected；上游自建且无法对应提交的条目 seq=null；均不归给 active 段。
- [x] AC4：浏览器收到的 caption（或新帧）带 seq 与 itemId。
- [x] AC5：模型未调用 session_send 的转写，投递给 Claude 的次数为 0（禁止自动补发的钉子）。
- [x] AC6：回放 `e2e/voice-realtime-segmented-replay-20261012.spec.ts` 缺陷腿 (b) 去掉 `test.fail()` 后通过，整份单文件运行退出 0。
- [x] AC7：回归——`voice-realtime-empty-transcript-guard.test.ts`、`voice-realtime-segmented-protocol.test.ts`、`voice-realtime-teardown-races.test.ts`、GOAL-041 已落地的 interrupt/queue-depth 测试、`server/shared/tests/quay-test-script.test.ts` 退出 0；`npm run typecheck`、`npm run lint` 退出 0。

## DoD

真 proxy + 真 bridge + scripted fake 上游，按 journal ef9daacd… 的帧序回放，读出修复前后每段的归属表（seq、itemId、transcript、empty、relayed）写入 Notes；零云调用。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-log.ts（仅当 journal 需记录归属）
- server/modules/voice-realtime/voice-realtime-upstream-pool.ts（转发 `onSegmentCommitRejected` 与两个 hook 的载荷，否则池化模式下拒收被吞）
- server/modules/voice-realtime/index.ts（导出 `RealtimeUserAudioCommitted` / `RealtimeCommitRejected` 两个 hook 载荷类型）
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts（仅当帧类型需声明新字段）
- server/modules/voice-realtime/tests/voice-realtime-caption-item-attribution.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-empty-transcript-guard.test.ts（仅当既有断言受影响）
- server/modules/voice-realtime/tests/voice-realtime-segmented-protocol.test.ts（假形态的源码字面量需与实现同步，否则锚点失配）
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts（caption 帧的类型谓词加 `seq`）
- e2e/voice-realtime-segmented-replay-20261012.spec.ts（翻转缺陷腿 b）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-caption-segment-attribution-by-item-id.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-354）。depends_on 两项 ws-proxy 上 ready 的 A+ 任务（after-revision-enqueued、queue-depth-refresh-on-turn-boundary），以串行化同文件改动；fence 已 done。todo 的 honest-aftermath 也改 ws-proxy，未设依赖以免长链阻塞，fan-in 时按 develop 合并。

### 立案取证（2026-10-12）

回放草稿（见回放任务 Notes）在当前代码上读到：忠实回放 A/B 中错归属无可见后果；变体 V（C 段空转写在 seq1 活跃时晚到）中 journal 为 `segment 1 dropped: the endpoint reported no words for it | … session_send not-delivered (empty-transcript)`，segment_ack 为 `["0:committed", "1:committed", "1:dropped:empty-transcript"]`，S5 的真实转发被拒。判据文件 AC2 以变体 V 为主读数。

### DoD 读数（2026-10-12，合并 develop 后重跑）

真 proxy（`handleVoiceRealtimeConnection`）+ 真 bridge + scripted fake 上游，按 journal ef9daacd… 的帧序与真实分段时长回放，零云调用（`--import ./scripts/undici-blocked-ports-preload.mjs`）。**修复后**的每段归属表（`voice-realtime-caption-item-attribution.test.ts` 的 `DoD reading` 用例）：

| seq | itemId | transcript | empty | relayed |
| --- | --- | --- | --- | --- |
| 0 | `item_GwgJFajaMzs3vySGWMpX2` | 这是一轮新的Live Voice Mod 测试。 | 否 | 是（投递给 Claude） |
| 1 | 提交被拒，endpoint 自建 `item_B5xbXwo6VjzvvwgvdgzvL` 不归属任何 seq | — | — | 否；`1:dropped:commit-refused` |
| 2 | `item_scripted_2` | 现在是第二句话。 | 否 | 否 |
| 3 | `item_Q26nL87tIMtxZW8FHDUh1` | 无转写 | 是 | 否 |
| 4 | `item_OsZh2fsopXcNz9XOS2Ky7` | 第四句话。 | 否 | 否 |
| 5 | `item_CGvOOLqlKXscZ8bWQ6pLe` | 上面我们看见丢了一句话。 | 否 | 是（投递给 Claude） |
| 6 | 提交被拒 | — | — | 否；`6:dropped:commit-refused` |
| 7 | `item_EtrMhyoYoCdQGlBCWFmhJ` | 所以你已经可以看到很多错了。 | 否 | 是（投递给 Claude） |
| 8 | 提交被拒 | — | — | 否；`8:dropped:commit-refused` |

共 12 条 `segment_ack`（seq0-8 每段一条，seq1/6/8 各多一条 `dropped:commit-refused`），投递给 Claude 的**恰好 3 条**，与 journal 记下的三条转写逐字相符。

**修复前**（把 `segmentSeqForCaption` 改回读 `activeSegmentSeq` 的假形态）：在这份 journal 上两张表**完全一致**，acks 也一致。这不是漏读，而是这份 journal 的证据边界：它的每一条转写都在自己那一段仍是 open 段时到达，所以迟到只体现在时序上、没有跨过一次提交。真正把两条规则分开的是「转写跨过提交」这一形态——由 AC1 的假形态（mutant 下 seq N+1 被标空、真实转发被拒）与回放 spec 的变体 V（C 段空转写晚到时把 seq1 判空、S5 的真实转发被拒）驱动。journal 里唯一的缺口是 seq3 整行缺失（endpoint 从未转写 `item_Q26nL87tIMtxZW8FHDUh1`），两种规则下都一样；用例把这个缺口显式断言成读数而非疏漏。

回归读数（合并 develop 后重跑）：判据文件 13/13；`quay-test-script.test.ts` 11/11（两处 dispatch 计数钉子随本任务新增的一个测试文件各 +1）；`empty-transcript-guard` 17/17、`segmented-protocol` 21/21、`teardown-races` 3/3、GOAL-041 interrupt 5 文件 28/28、queue-depth 2 文件 8/8；`e2e/voice-realtime-segmented-replay-20261012.spec.ts` 19 passed 退出 0；`npm run typecheck`、`npm run lint` 退出 0。

## Blocker

**2026-10-12T15:22:40.330Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/providers/tests/claude-peer-name-title-guard.test.ts:   AssertionError [ERR_ASSERTION]: a renamed session must still hand its name over ({"pid":466723,"sessionId":"c53d141a-ff6f-4f59-97d5-8502f4e8bbe0","name":"claude-peer-title-guard-4nqpzr-30","nameSource":"derived"})
- run_id：wk-prod-anchor
- session_id：d7d25af1-aa19-4413-9976-f585ee361b58
