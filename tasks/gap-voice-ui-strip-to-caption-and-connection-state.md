---
id: gap-voice-ui-strip-to-caption-and-connection-state
title: Live Voice 页面减法：语音条只留连接状态+字幕行+Mute/退出，对话里撤掉全部语音专用行（含关闭痕迹）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**人的裁定（2026-10-14）**：Live Voice 页面信息「太多太杂、缺乏统一模式」，要简化：
- 已发送的就是一条正常 CloudCLI user message，不要任何特殊；
- 语音条字幕行保留；
- 页面上 Live Voice 只提供 Mute 和退出两个操作（不提供撤回、打断、重连）；
- 模型没转发的话，页面上不另做显示；
- 连接失败：删掉重连按钮，不加自动重连，状态行给一句能看懂的原因。
（排队「最多一个气泡、一次发出」另立 `gap-voice-proxy-holds-one-merged-pending-message`，本任务**不动**排队相关的 `VoicePendingUtterance` / `useVoicePendingWithdraw`。）

**现状清点（2026-10-14，逐项对过源码）**：
- 语音条状态格（`src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx` 约 218–349 行）按优先级只显示一条：Stopped the current turn — N still queued → Queue full — that one was not sent → Busy {{elapsed}} · {{bytes}} bytes waiting（elapsed 实为连接时长）→ No answer — say it again → Heard — not forwarded → 连接相位。
- 字幕行（约 351–357 行）出错时整行换成服务端原文错误（未翻译、技术措辞，如「The upstream sent an event this build does not handle: …」）。
- 重连按钮 `voice-realtime-retry`（约 376–387 行）。
- 对话里的语音专用行（`src/modules/chat/voice-realtime/placeCaptions.ts` 构造，`src/modules/chat/transcript/MessageComponent.tsx` 渲染）：关闭痕迹 `voiceClosedUnshown`（约 278 行）、segment 结果三种 `voice-row-segment-outcome`（约 299 行）、`voice-row-unrecognized`（约 340 行）、Not delivered 气泡 `voice-row-undelivered`（约 374、414 行）、「From voice transcript」徽标 `voice-transcript-badge`（约 434 行）、代投气泡（`deliveredMessageRows`，placeCaptions 约 415 行）。由 `ChatInterface.tsx` 约 579–620 行的 `voiceTranscriptRows` + `appendVoiceCloseTrace` 拼入。segment/unrecognized 行只在已退役的 segmented 线路出现，continuous（线上默认）下是死代码。

**修法（只做减法，hook 的状态与帧处理保留）**：
1. 状态格只显示连接相位：Connecting voice… / Listening… / Muted / Voice disconnected / Voice control stopped。删除 stopped / refused / busy / unanswered / unforwarded 五种读数的渲染（含 `voice-realtime-stopped`、`voice-realtime-unanswered`、`voice-realtime-unforwarded` 节点）；`data-*` 诊断属性可留。
2. 字幕行出错时显示**归类后的一句话**（新 i18n 键，`src/modules/i18n/locales/*/chat.json` 全部语言补齐），原始 message 放进该元素的 `title`：连接类（服务端 code `CONNECTION_FAILED`/`CONNECTION_LOST`/`TRANSPORT`、浏览器 socket `onerror`/构造失败）→「语音连接失败，请退出后重新进入。」；`SPEND_LIMIT` →「本次语音花费已达上限，请退出后重新进入。」；`MISSING_API_KEY` →「服务器未配置语音服务凭据。」；麦克风/采集失败 →「无法使用麦克风。」；其余 →「语音出错，请退出后重新进入。」（英文版同义）。归类读 error 帧的 `code`；浏览器侧错误由 hook 打一个本地 code。
3. 删除重连按钮。
4. 对话里撤掉全部语音专用行：`ChatInterface` 不再调用 `voiceTranscriptRows` 与 `appendVoiceCloseTrace`（直接用真实消息）；删除 `MessageComponent` 中上列各分支与 `src/shared/types.ts` 中仅供它们用的字段；删除 `placeCaptions.ts` 中只服务于这些行的构造函数（`appendVoiceCloseTrace`、`segmentOutcomeRows`、`unrecognizedSegmentRows`、`undeliveredUtteranceRows`、`deliveredMessageRows`、`markDeliveredVoiceMessages` 等，以无引用为准）。**保留**：`collectUndeliveredUtterances`（退出时把未投递原话放进输入框草稿）、`countUnshownUtterances` 与 hook 的计数日志、字幕行。
5. 测试：删除或改写只断言被删元素的用例；新增断言「出错时字幕行显示归类文案」「无重连按钮」「状态格在 Claude 忙时仍显示连接相位」。依赖这些行的 e2e 腿改为断言其不存在。

<!-- dedup-ref -->
合并决定：separate——`gap-voice-close-trace-row-removed-from-transcript`（只撤关闭痕迹行）已在 worker 手上，是本任务的严格子集；它若先落地，本任务第 4 点中关闭痕迹部分即已完成，AC2 的缺失断言照常成立，调度器按 Touches 串行。与 `gap-voice-proxy-holds-one-merged-pending-message` 分开：独立验收（那条以服务端排队机制为主），调度器按 Touches 串行。与 `gap-voice-relay-mode-a-prompt-drop-continue-arm-and-session-status` 无共同源文件。

## AC

- [ ] AC1 状态格只剩连接相位：`grep -nE "voice-realtime-(stopped|unanswered|unforwarded|retry)\"" src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx` 无输出（退出 1）；`grep -nE "voice\.realtime\.(busy|refused|stopped|unanswered|unforwarded|retry)'" src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx` 无输出（退出 1）。
- [ ] AC2 对话里不再有语音专用行：`grep -rnE "voiceClosedUnshown|appendVoiceCloseTrace|voice-row-segment-outcome|voice-row-unrecognized|voice-row-undelivered|voice-transcript-badge|Live Voice closed before" src --include=*.ts --include=*.tsx | grep -v "/tests/"` 无输出（管道退出 1）；`grep -c "export function collectUndeliveredUtterances" src/modules/chat/voice-realtime/placeCaptions.ts` 输出 1。
- [ ] AC3 错误归类文案：新 i18n 键在每个 `src/modules/i18n/locales/*/chat.json` 中都存在（`for f in src/modules/i18n/locales/*/chat.json; do node -e "const j=require('./'+process.argv[1]); const k=['connectionFailed','spendLimit','missingCredential','micUnavailable','generic']; process.exit(k.every(x=>j.voice&&j.voice.realtime&&j.voice.realtime.errors&&j.voice.realtime.errors[x])?0:1)" "$f" || echo MISSING $f; done` 无 MISSING 输出）；组件测试断言：收到 `{type:'error', code:'UNKNOWN_EVENT', message:'The upstream sent an event…'}` 帧后字幕行文本为 generic 文案、`title` 含原 message。
- [ ] AC4 客户端测试逐文件单跑、各自退出 0（`npm run test:client -- <file>`）：`src/modules/chat/voice-realtime/tests/` 与 `src/modules/chat/tests/` 下所有文件名含 `voice` 或 `Voice` 的测试文件，逐个跑，结果写入「验证读数」。
- [ ] AC5 e2e 不再依赖被删元素：`grep -nE "voice-row-(segment-outcome|unrecognized|undelivered)|voice-transcript-badge|voice-closed-unshown|voice-realtime-(retry|stopped|unanswered|unforwarded)" e2e/*.ts | grep -vE "toHaveCount\(0\)|toBeNull\(\)|not\.toBeVisible|toBe\(0\)"` 无输出（管道退出 1）——断言这些元素「存在」的腿删除或改为断言不存在；且 `npx playwright test --list e2e/voice-realtime-segmented-replay-20261012.spec.ts e2e/voice-realtime-double-drop.spec.ts` 退出 0（两份 spec 仍能装载）。不要求整份 segmented 回放 spec 跑绿：它需 `VOICE_REALTIME_MODE=segmented` 且有两条既存红腿（Exit 回填草稿、水位线），owner 不在本任务。
- [ ] AC6 `npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

在真实页面上进入 Live Voice：语音条只有连接状态、字幕行、Mute、退出；Claude 忙、模型没转发、排队满、停止当前回合时状态格都不再出现额外文字；出错时字幕行给出一句可读原因、无重连按钮；对话里只出现普通 user/assistant 消息，没有任何语音专用行或末尾的关闭痕迹；退出时未投递的原话仍进入输入框草稿。由组件测试在真实 `ChatInterface`/`VoiceRealtimeBar` 渲染上与回放 e2e 在真实页面上验证。

## Touches

- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/voice-realtime/index.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/transcript/MessageComponent.tsx
- src/shared/types.ts
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx
- src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx
- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- e2e/voice-realtime-double-drop.spec.ts
- tasks/gap-voice-ui-strip-to-caption-and-connection-state.md
