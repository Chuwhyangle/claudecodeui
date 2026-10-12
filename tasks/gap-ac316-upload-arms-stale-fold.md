---
id: gap-ac316-upload-arms-stale-fold
title: AC-316 判据腿一红：上传夹具里 AC-326 双腿仍钉「折叠成一行」，与已落地的逐句行模型相悖
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-316
---
## Proposal

### 现象（2026-10-13 直接复跑当前 HEAD 树，不是台账继承）

AC-316 判据的第一条命令直接红：

```
bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts
```

读数 `7 passed / 1 failed / 3 did not run`，EXIT=1。唯一失败是 `e2e/voice-realtime-upload-fixture.spec.ts:1265`（AC-326 那条腿「three transcriptions of one thought are ONE row …」），台账 `counts=[0,3,3,3,...,3,1,1,1,1,1,1,1,1]`，交付前的样本文本是 `alfa bravo charlie`（`ROW_HEARD[0]`）：

- `:1319` `expect.soft(provisional.length).toBeGreaterThan(0)` —— 实测 0（整条手势期间没有任何一次读到「恰好一行」）；
- `:1337` `expect.soft(Math.max(...counts)).toBeLessThanOrEqual(1)` —— 实测 3。

即同一手势期间屏上是 **3 行** user 行、交付后塌回 1 行——正是该腿禁掉的 `3→1` 塌缩。另两条命令我单独复跑为绿：protocol-sim 腿 EXIT=0，`e2e/voice-trim.spec.ts -g "AC-120"` `1 passed` EXIT=0。

### 机制（上一轮修复为什么没兜住）

- `gap-ac316-restore-criterion-two-regressions`（done，`goal_ac: AC-316`，提交 d526a5ff）修的是同一份 e2e 的 `FakeAudioContext` 与 `useVoiceRealtimeSession.ts` 的 `carried` 回退，**没有碰** AC-326 那条腿的行模型。
- 8a87620b（`gap-live-voice-segment-honest-heard-unrecognized-state`，done，`goal_ac: AC-355`，人 yale 2026-10-12 授权）把生产放置换成 `heardUtteranceRows`（`src/modules/chat/voice-realtime/placeCaptions.ts:235`，**每条 caption 一行**，键 `voice-caption-${caption.itemId}`）。唯一入口 `voiceTranscriptRows`（`:661`，`:678` 调它）此后只走逐句模型；`foldCaptionsIntoTranscriptRow`（`:153`）**再无生产调用点**，其 doc（`:200-233`）写明为什么改。
- AC-355 任务的回归范围（其 AC8）只覆盖 `voiceStopVsExit.test.tsx`、`src/modules/chat/voice-realtime/tests/`、`e2e/voice-realtime-scripted-scenarios.spec.ts`，**不含** `e2e/voice-realtime-upload-fixture.spec.ts` ⇒ AC-326 的臂在模型换代时无人看管。
- AC-326 的**单位臂**同样已空过：`src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts` 只 import 并断言 `foldCaptionsIntoTranscriptRow` —— 那个已无生产调用点的函数。文件是绿的，但它钉的行为已不在生产路径上。

### 冲突与方向

AC-326 的 expect (a)「交付前恰好 1 行」与 (c)「计数从不超过 1」和 AC-355 已落地的逐句模型直接冲突；两者都是人 yale 裁定（AC-326 2026-10-11，AC-355 2026-10-12，更晚）。本任务采取的方向：**以已落地的生产模型为准，把 AC-326 的两条臂改成断言这个模型**——回退生产会同时红掉 AC-355 的 replay 判据与 `voiceSegmentHonestState.test.tsx`，改臂是唯一不牵动生产回归的解。保留 AC-326 仍然为真的那两半：交付就地定型为一条真实消息、三段原文都不留成独立 user 行；空转写不产生行。

⚠️ 若执行者在当前树上复核后认定「一次语音一行」**仍是**本仓意图（例如找到晚于 8a87620b 的裁定），**不得静默弱化**这条腿：应在 Notes 写明读数并停派（needs-human）等裁定，而不是把它改绿。

<!-- dedup-ref -->
与 `gap-live-voice-segment-lost-uncertain-honest-state`（todo）是**并行**关系：它改 `placeCaptions.ts` 的逐段 lost/uncertain 状态；本任务**不改生产代码**（`foldCaptionsIntoTranscriptRow` 保留原样，只把它的判据改锚），故两者 Touches 不重叠。

### 取假形态

把入口 `voiceTranscriptRows` 的放置临时回退到 `foldCaptionsIntoTranscriptRow`（一次实验，随后复原、不落 diff）⇒ 改写后的单位臂与 e2e 腿必须变红；复原后绿。以此证明新断言钉的是当前模型，而不是又一轮空过。

## AC

- [ ] AC1：`bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts` 退出 0（AC-316 判据第一条命令）；`e2e/voice-realtime-upload-fixture.spec.ts` 内 8 条腿全绿或全为显式 skip，不再有 `did not run` 之外的失败。
- [ ] AC2：`:1265` 那条腿改后仍断言、且只剩仍为真的那几半——一段语音的 N 条转写各成一行 `voice-caption-*`（`heard`）按 seq 排列；交付**就地**吸收为一条真实消息，三段原文都不留成独立 user 行；空转写不产生行。
- [ ] AC3：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts` 退出 0，且该文件改成断言生产入口 `voiceTranscriptRows` 的逐句行（不再只断言没有调用点的 `foldCaptionsIntoTranscriptRow`）。
- [ ] AC4：取假形态——把 `voiceTranscriptRows` 的放置临时回退到 `foldCaptionsIntoTranscriptRow` 后，AC2 的腿与 AC3 的文件变红；复原后绿。两次读数贴进 Notes。
- [ ] AC5：AC-355 侧不被回退：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx` 退出 0；`npm run typecheck`、`npm run lint` 各退出 0。
- [ ] AC6：AC-316 判据另两条命令各退出 0——`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`；`npx playwright test e2e/voice-trim.spec.ts -g "AC-120"`。

## DoD

在**当前 HEAD 的树**上用真实 e2e 夹具（`FakeAudioContext` + 假上游）驱动一次注入手势：上传夹具、三段时间转写先后到达时屏上是三行 `voice-caption-*`（`heard`），交付后只剩一条带 `voice-transcript-badge` 的真实行、三段原文各自作为 user 行的计数为 0；截图与台账读数写入 Notes。AC-316 判据三条命令在同一棵树上全绿（贴出各命令的 exit code 与末行）。单位臂在入口回退到旧折叠时红、复原后绿，两次读数都贴出。运行遵守 8G cgroup：Playwright 单文件经 `bash scripts/with-memory-cap.sh` 跑，不跑无界的 `--test` 扇出。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts
- src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts
- tasks/gap-ac316-upload-arms-stale-fold.md

## Notes

立案：gap-filing 轮次，2026-10-13。AC-316 已离开 reverify 范围（GOAL-033 `achieved`、`longTerm: false`），本轮的「红」来自**直接复跑判据**，不是台账尾巴。

若执行者顺带删除已无生产调用点的 `foldCaptionsIntoTranscriptRow` 及其 barrel 导出，需把 `src/modules/chat/voice-realtime/placeCaptions.ts`、`src/modules/chat/voice-realtime/index.ts` 补进 Touches，并知会正在改同一文件的 `gap-live-voice-segment-lost-uncertain-honest-state`。

AC-326 记录本身（`goals/AC-326…` 的 expect (a)/(c)）随之失效，应由 AC-326 自己的 driver 收口；本任务只改臂、不改任何 AC 记录。
