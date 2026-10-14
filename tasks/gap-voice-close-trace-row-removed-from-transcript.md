---
id: gap-voice-close-trace-row-removed-from-transcript
title: Live Voice：不再在对话末尾显示「关闭痕迹」行（Live Voice closed before N of your words…）
status: todo
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

- [ ] AC1 出货代码里不再有关闭痕迹行：`grep -rnE "voiceClosedUnshown|appendVoiceCloseTrace|voice-closed-unshown-utterance|Live Voice closed before" src --include=*.ts --include=*.tsx --include=*.json | grep -v "/tests/"` 无输出（管道退出 1）。
- [ ] AC2 保留项仍在：`grep -c "export function countUnshownUtterances" src/modules/chat/voice-realtime/placeCaptions.ts` 输出 1，`grep -c "export function collectUndeliveredUtterances" src/modules/chat/voice-realtime/placeCaptions.ts` 输出 1。
- [ ] AC3 行为断言（新）：`voiceStopVsExit.test.tsx` 内有用例在「服务端以未显示的最终字幕关闭连接 → 点 Exit」后断言页面文本不含 `Live Voice closed before`；`npm run test:client -- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` 退出 0。
- [ ] AC4 相关客户端测试逐文件单跑、各自退出 0：`npm run test:client -- <file>` 分别跑 `src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx`、`src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx`、`src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx`、`src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx`、`src/modules/chat/tests/voiceModePermissionBanner.test.tsx`、`src/modules/chat/voice-realtime/tests/voiceMicSuspendedWaveform.test.tsx`。
- [ ] AC5 `bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 退出 0，且其中 `(c) branch A` 腿断言 `closeTrace` 为 `null`（`grep -c "closeTrace.*toBeNull()" e2e/voice-realtime-segmented-replay-20261012.spec.ts` ≥ 1）。
- [ ] AC6 `npm run typecheck` 退出 0。

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
