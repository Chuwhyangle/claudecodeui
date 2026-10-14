---
id: gap-voice-close-trace-row-removed-from-transcript
title: Live Voice：不再在对话末尾显示「关闭痕迹」行（Live Voice closed before N of your words…）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**人的裁定（2026-10-14）**：「不要显示这一"关闭痕迹"。」

**现状**：Live Voice 连接关闭（服务端关闭或人点 Exit）时，`useVoiceRealtimeSession.ts`（约 1079、1682 行）用 `countUnshownUtterances` 数出「没有被任何已显示投递认领的最终字幕段数 + 无字幕的已发送段数」，存进 `closedUnshown`；`ChatInterface.tsx`（约 610 行）调 `appendVoiceCloseTrace(placed, voice.closedUnshown)` 在对话末尾拼一条 `voiceClosedUnshown` 系统行，`MessageComponent.tsx`（约 278 行）把它渲染成 `Live Voice closed before {{count}} of your words reached the screen.`。该行只在下一次开启 Live Voice 时清零（约 1232 行），所以退出语音后一直挂在对话底部。

**实测（journal `e650117b`，2026-10-14 11:46）**：人退出时显示「7 of your words」，实为最后被模型吞掉的 7 段字幕；而且这 7 段随后已由输入框草稿（`collectUndeliveredUtterances`）发出，该行仍说它们没到达屏幕。文案单位也不对（数的是字幕段，不是词）；中间另 9 段丢句因水位线过度认领没被计入。人决定直接不显示。

**修法（谨慎、只撤显示）**：
1. `ChatInterface.tsx` 不再调用 `appendVoiceCloseTrace`，useMemo 依赖里去掉 `voice.closedUnshown`；
2. 删除 `placeCaptions.ts` 的 `appendVoiceCloseTrace` 及其在 `voice-realtime/index.ts` 的导出；
3. 删除 `MessageComponent.tsx` 的 `voiceClosedUnshown` 渲染分支与 `src/shared/types.ts` 的 `voiceClosedUnshown` 字段（若 i18n 资源里有 `message.voiceClosedUnshown` 键一并删除）。
**保留不动**：`countUnshownUtterances`、hook 的 `closedUnshown` 计数与那两行 `voiceLog`（诊断用，且多处 hook 桩引用该字段，删字段会引起无关改动）、退出时把未投递原话放进输入框草稿的 `collectUndeliveredUtterances`、字幕行/「Not delivered」等其他语音行。
4. 改写依赖该行的测试：`voiceCaptionShownState.test.tsx` 中关于 trace 渲染/builder 的用例删除（`countUnshownUtterances` 的计数用例保留）；`voiceStopVsExit.test.tsx` 的「close trace survives leaving Live Voice」用例改为断言新事实——服务端在未显示字幕上关闭连接并点 Exit 后，页面文本不含 `reached the screen`；`e2e/voice-realtime-segmented-replay-20261012.spec.ts` 的 `(c) branch A … leaves an exit trace` 腿改为断言 `snap.closeTrace` 为 `null`（快照里的查询可保留），`e2e/voice-realtime-double-drop.spec.ts` 选择器里的该 testid 一并移除。

<!-- dedup-ref -->
合并候选检查：none found（`task-granularity-advice` 对 5 份源文件 peers=[]、mentions=[]；无 open 任务提及 close trace）。

## AC

- [x] AC1 出货代码里不再有关闭痕迹行：`grep -rnE "voiceClosedUnshown|appendVoiceCloseTrace|voice-closed-unshown-utterance|Live Voice closed before" src --include=*.ts --include=*.tsx --include=*.json | grep -v "/tests/"` 无输出（管道退出 1）。
- [x] AC2 保留项仍在：`grep -c "export function countUnshownUtterances" src/modules/chat/voice-realtime/placeCaptions.ts` 输出 1，`grep -c "export function collectUndeliveredUtterances" src/modules/chat/voice-realtime/placeCaptions.ts` 输出 1。
- [x] AC3 行为断言（新）：`voiceStopVsExit.test.tsx` 内有用例在「服务端以未显示的最终字幕关闭连接 → 点 Exit」后断言页面文本不含 `Live Voice closed before`；`npm run test:client -- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` 退出 0。
- [x] AC4 相关客户端测试逐文件单跑、各自退出 0：`npm run test:client -- <file>` 分别跑 `src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx`、`src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx`、`src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx`、`src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx`、`src/modules/chat/tests/voiceModePermissionBanner.test.tsx`、`src/modules/chat/voice-realtime/tests/voiceMicSuspendedWaveform.test.tsx`。
- [x] AC5 `VOICE_REALTIME_MODE=segmented bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1 -g "leaving with an unrecognized segment leaves no exit trace"` 退出 0（只跑本任务改写的那条腿；整份 spec 另有两条既存红腿，owner 不在本任务——2026-10-14 按 worker 给出的出路 (i) 重指），且 `grep -c "closeTrace.*toBeNull()" e2e/voice-realtime-segmented-replay-20261012.spec.ts` ≥ 1。
- [x] AC6 `npm run typecheck` 退出 0。

## DoD

退出或断开 Live Voice 后，对话末尾不再出现「Live Voice closed before N of your words reached the screen.」这一行；未投递的原话仍照旧放进输入框草稿，字幕行与「Not delivered」等其他语音状态不受影响——由组件测试在真实 `ChatInterface` 渲染上、以及回放 e2e 在真实页面上验证。

## Touches

- src/modules/chat/ChatInterface.tsx
- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/voice-realtime/index.ts
- src/shared/types.ts
- src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx
- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- e2e/voice-realtime-double-drop.spec.ts
- tasks/gap-voice-close-trace-row-removed-from-transcript.md

## Notes

AC5 未满足，故意留 `- [ ]`。本任务自己那条腿是绿的——`(c) branch A: leaving with an unrecognized segment leaves no exit trace` 断言 `snap.closeTrace` 为 `null`，`grep -c "closeTrace.*toBeNull()"` = 1。但**文件整体 exit 0** 在 develop 上做不到，两个原因均为既存、与本改动无关：

1. AC5 的字面命令（不带 env）在第一条用例就红——`the replay ran segmented, on the local scripted upstream, with no cloud credential`，15s 握手轮询一个 `segmented-v1` 帧超时。commit `31e72dfd`（GOAL-044）把 `resolveVoiceRealtimeMode` 的默认翻成 `continuous`，而 `playwright.config.ts` 只给 `voiceContinuousOnlySelection` 项目武装 `VOICE_REALTIME_MODE: 'continuous'`，普通的 `voiceRealtimeSelection` 项目没给。即该判据按字面写就不可满足（已知形态：segmented 回放 spec 需要显式导出 `VOICE_REALTIME_MODE`）。
2. 带上 `VOICE_REALTIME_MODE=segmented` 重跑：**17 passed / 2 failed**——`branch A: Exit back-fills the composer with exactly the unrelayed transcripts`（原文约 1009 行）与 `(d) branch B: Exit back-fills S2,S3,S4 in SPOKEN order`（约 1174 行），都是 `draft was ""`。根因（用 `git stash` 把工作树退回 develop 跑同样两条腿同样红、以及插桩读记录帧双向证实）：服务端 `sent` 帧带的是 `coveredThroughItemId` 水位线（= 转发时刻最后一条已提交项），第二条投递的 `coveredThroughItemId: "A_E"` 会把从未转发的 `A_B`/`A_D` 一并认领，于是 `claimThrough`/`collectUndeliveredUtterances` 什么都不回填。即已知的水位线过度认领（`unforwarded-disposition-has-two-independent-causes` 因之二），修点在 `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` 的 `claimThrough`，不在本任务 Touches，且 Plan 第 4 条明令「保留不动 `collectUndeliveredUtterances`」，故此处不修。

已核验满足：AC1（grep 空、退出 1）、AC2（1/1）、AC3（voiceStopVsExit 8 passed）、AC4（六文件逐跑均退出 0：voiceCaptionShownState 6、voiceSegmentHonestState 16、useVoiceRealtimeSession 42、liveVoiceNewSessionEntry 8、voiceModePermissionBanner 2、voiceMicSuspendedWaveform 3）、AC6（typecheck 退出 0）。

## Evidence

**2026-10-14 worker 续做轮（第 3 次派发）→ ABI park `needs-human`。** 在 `git merge develop`（worktree HEAD `226a876ff`）后的树上重跑上面 `## Notes` 的全部读数，逐条一致：AC1（grep 空、退出 1）、AC2（1/1）、AC3（voiceStopVsExit 8 passed）、AC4（六文件逐跑均退出 0）、AC6（typecheck 退出 0）全绿；AC5 仍红，保持 `- [ ]`，且**不加「（待外部）」**。

- AC5 字面命令（不带 env）：首用例 `the replay ran segmented, on the local scripted upstream, with no cloud credential` 15s 握手轮询 `segmented-v1` 帧超时（实测 `1 failed / 18 did not run`）。
- `VOICE_REALTIME_MODE=segmented` 重跑：`17 passed / 2 failed`（58.4s）；两条红腿 `branch A: Exit back-fills the composer with exactly the unrelayed transcripts, in spoken order`（:1009）与 `(d) branch B: Exit back-fills S2, S3, S4 in SPOKEN order, not arrival order`（:1174），均 `draft was ""`。本任务自己改写的那条腿（`(c) branch A: leaving with an unrecognized segment leaves no exit trace`，:1165）在该次运行中**绿**。
- 两条根因均既存、owner 在别的任务、不在本任务 Touches（详 `## Notes`）：(1) `playwright.config.ts` 未给本 spec 所属项目武装 segmented（默认已翻 `continuous`）；(2) `claimThrough` 水位线过度认领（`useVoiceRealtimeSession.ts`）。

**处置**：按结构性不可满足 AC 的既定处置——勾掉可验证的 AC，AC5 未勾且不代加「（待外部）」，不代写勾、不改判据，park `needs-human`（对比 `ac-wallclock-bound-below-a-mandated-floor-is-unsatisfiable` / `external-human-reading-ac-parks-needs-human-unticked` 的同形处置）。**给出的两条出路（择一）**：(i) 把 AC5 重指为「只跑本任务改写的那条腿」的形态（与同日落地、同 spec 的 `gap-live-voice-remove-transcript-caption-rows` AC6 同形）：`VOICE_REALTIME_MODE=segmented bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1 -g "leaving with an unrecognized segment leaves no exit trace"`，现已绿；(ii) 先落地那两个 owner 缺陷（模式臂 / 水位线），再回头勾本 AC。

**2026-10-14 worker 续做轮（第 4 次派发，本任务 AC5 已被 author 按出路 (i) 重指）→ 全 AC 绿，勾选 AC5。** 在复用 worktree 上 `git merge --no-edit develop`（develop 时点 `c959de7b6`，6 commits ahead）后于合并树上复验本任务全部判据：

- AC1：`grep -rnE "voiceClosedUnshown|appendVoiceCloseTrace|voice-closed-unshown-utterance|Live Voice closed before" src --include=*.ts --include=*.tsx --include=*.json | grep -v "/tests/"` 无输出，管道退出 1。
- AC2：两处 `grep -c` 各输出 1。
- AC3：`npm run test:client -- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` 退出 0（1 file, 8 passed）。
- AC4：六文件逐文件单跑均退出 0——voiceCaptionShownState 6、voiceSegmentHonestState 16、useVoiceRealtimeSession 42、liveVoiceNewSessionEntry 8、voiceModePermissionBanner 2、voiceMicSuspendedWaveform 3。
- AC5：`VOICE_REALTIME_MODE=segmented bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1 -g "leaving with an unrecognized segment leaves no exit trace"` 退出 0（`1 passed (57.5s)`，`(c) branch A: leaving with an unrecognized segment leaves no exit trace` 命中）；`grep -c "closeTrace.*toBeNull()" e2e/voice-realtime-segmented-replay-20261012.spec.ts` = 1（≥ 1）。
- AC6：`npm run typecheck` 退出 0。

anti-drift（fan-in 同款硬门）`anti-drift-touches-check.js --task gap-voice-close-trace-row-removed-from-transcript --worktree … --merge-target develop` → `ANTI-DRIFT OK: 9 actual file(s), all within declared Touches`，退出 0。

**2026-10-14 worker 续做轮（第 5 次派发）→ 在 develop 已前进 13 commits 的树上重做合并并复验，全 AC 绿。** `git merge --no-edit develop`（develop 时点 `257571162`）产生 6 处冲突，全部按语义并集解决，merge commit `b466d8b9a`。

**关键背景：develop 的更大改动已把本任务的产出整体吞掉。** 同日的 `gap-voice-ui-strip-to-caption-and-connection-state`（人裁定「THE TRANSCRIPT IS THE TRANSCRIPT」，2026-10-14）删掉了整个语音专属行代数：`ChatInterface.tsx` 的 `transcriptMessages` useMemo 与 `voiceTranscriptRows` import、`MessageComponent.tsx` 的 `voiceClosedUnshown`/`voiceSegmentOutcome`/`voiceUnrecognizedSeq`/`voiceRowState` 四个渲染分支、`placeCaptions.ts` 的 `appendVoiceCloseTrace` 及 `index.ts` 的导出全部消失。所以本任务在出货代码上已无净增量——但判据仍须逐条成立，且两条 e2e 腿的读数是本任务独有的，不能随 develop 一并丢掉。

逐文件处置：

- `src/modules/chat/ChatInterface.tsx`、`src/modules/chat/transcript/MessageComponent.tsx`、`src/modules/chat/voice-realtime/index.ts`：取 develop 版。本任务对这三个文件的改动（去掉 `appendVoiceCloseTrace` 调用/导出、去掉 `voiceClosedUnshown` 渲染分支）是 develop 改动的真子集，取其超集即并集。
- `src/modules/chat/voice-realtime/placeCaptions.ts`、`src/shared/types.ts`：自动合并，合并后无 `appendVoiceCloseTrace`、无 `voiceClosedUnshown`；`countUnshownUtterances` 与 `collectUndeliveredUtterances` 两个导出俱在（AC2）。
- `voiceCaptionShownState.test.tsx`：取 develop 版。它已删掉 trace 用例，并新增更强的「面板不为该计数画任何行」用例。
- `voiceStopVsExit.test.tsx`：**并集**。保留 develop 的腿（bar 报 `Voice disconnected`、无 voice-only testid、退出后不变），接上本任务的 AC3 断言（退出后页面文本不含 `Live Voice closed before`）与其非空证明（未投递原话仍进草稿）。
- `e2e/voice-realtime-double-drop.spec.ts`：**并集**。取 develop 的 testid 前缀选择器，并补 `[data-testid^="voice-closed-"]`——develop 自己的注释说要覆盖「任何名字」的 voice-only 行，而它只写了 `voice-row-` 前缀，恰好看不到本任务这条 `voice-closed-…` 行。
- `e2e/voice-realtime-segmented-replay-20261012.spec.ts`：**并集**。快照同时保留 `voiceOnlyNodes`（develop，前缀计数）与 `closeTrace`（本任务，按名查询，查询体补回），`(c) branch A` 一条腿同时断言 `closeTrace` 为 `null` 与 `voiceOnlyNodes` 为 0，腿名保留 AC5 所依赖的 `leaving with an unrecognized segment leaves no exit trace`。

合并树上复验本任务全部判据：

- AC1：`grep -rnE "voiceClosedUnshown|appendVoiceCloseTrace|voice-closed-unshown-utterance|Live Voice closed before" src --include=*.ts --include=*.tsx --include=*.json | grep -v "/tests/"` 无输出、管道退出 1。
- AC2：两处 `grep -c` 各输出 1。
- AC3：`npm run test:client -- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` 退出 0（1 file, **8 passed**；含并入 AC3 断言的那条腿）。
- AC4：六文件逐文件单跑均退出 0——voiceCaptionShownState **7**（develop 版）、voiceSegmentHonestState 16、useVoiceRealtimeSession **46**（develop 版）、liveVoiceNewSessionEntry 8、voiceModePermissionBanner 2、voiceMicSuspendedWaveform 3。
- AC5：`VOICE_REALTIME_MODE=segmented bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1 -g "leaving with an unrecognized segment leaves no exit trace"` 退出 0（`1 passed (58.1s)`）。**首跑红 / 二跑绿**：首跑红在引导阶段——`replay()` 里 `expect(page.locator('.chat-messages-pane')).toBeVisible()` 30s 超时，页面根本没起来（不是断言红，也不是本任务那条腿红）；二跑绿，日志显示二跑复用了首跑 seed 出的 vite-cache。判为与本改动无关的引导抖动。`grep -c "closeTrace.*toBeNull()"` = 1。注意该 grep 要求 `closeTrace` 与 `toBeNull()` 落在**同一行**（多行展开的 `expect(\n snap.closeTrace,\n …\n).toBeNull()` 会数成 0，本轮先踩到过）。
- AC6：`npm run typecheck` 退出 0。
- anti-drift（fan-in 同款硬门）：`ANTI-DRIFT OK: 4 actual file(s), all within declared Touches (10 glob(s))`，退出 0。只剩 4 个文件是因为三个源文件与 `voiceCaptionShownState.test.tsx` 取 develop 版后已无 delta，实际差异为本任务两条 e2e 腿 + `voiceStopVsExit.test.tsx` + 本任务文件。

## Blocker

**2026-10-14T05:53:17.464Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 5/6，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：3b5c8780-e678-4635-9bc7-48e23a86a4bf


2026-10-14 author：AC5 已按 worker 出路 (i) 重指为只跑本任务改写的那条腿；重回 ready，续做轮只需复验并勾 AC5。
