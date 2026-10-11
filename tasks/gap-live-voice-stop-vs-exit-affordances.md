---
id: gap-live-voice-stop-vs-exit-affordances
title: 停止键与退出键语义分离：Live Voice 那颗改为「退出模式」（换字形/文字/位置），通用停止键挂到 running
  行（语音模式下同样可停）；退出不中断当前处理、把 backlog 文本转入 composer、未上屏留痕跨模式存活
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

### 现状（2026-10-11 逐文件复核，带 file:line）

- **同形不同义（操作者原话：「仅颜色和终止助手处理的停止键有差异，形状完全一样」）**：`VoiceRealtimeBar` 的 End 是实心 `Square` + destructive 红底（`src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx:292-301`，图标 `Square` 在 `:300`）；composer 忙时的 submit 位也是实心 `SquareIcon`（`src/modules/chat/composer/PromptInput.tsx:222`，接线在 `ChatComposer.tsx:1069-1095`）。形状完全一致，只有底色差。
- **两颗键做的事完全不同**：composer 的 → `chat.abort`（停当前 run，`src/modules/chat/hooks/useChatComposerState.ts:1524-1541`）；bar 的 → `end()` + `onExit()`（`VoiceRealtimeBar.tsx:190-193`，`end()` 在 `useVoiceRealtimeSession.ts:501` 起），**不 abort 任何 run**。语义已经对了（`aria-label`/`title` 就是 "End" / "End Live Voice"），**问题纯粹在视觉**。
- **running 行明确没有停止键**：`src/modules/chat/transcript/ChatMessagesPane.tsx:689-694` 的注释写着「it carries no Stop, because the composer's submit button is the one stop entry at every width and height」——`ActivityIndicator` 正是操作者要挂停止键的那一行（「附在正在处理的助手输出或 Thinking… 状态气泡上」）。
- **退出会静默丢掉尚未投递的话**：`end()` 只 flush 音频段并关 socket；而中继侧的 `waitingExtraMessages` 与合并窗口 `pendingParts` 是**每连接**状态（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:783-786`、`:880-882`），socket 一关即随之消失。所以今天「退出 Live Voice」会丢掉还没投递的说话。
- **留痕在退出那一刻消失**：`src/modules/chat/ChatInterface.tsx:552` 在 `composerMode !== 'voice'` 时直接 `return placed`，未上屏话语的留痕（`voice-closed-unshown-utterance`）随之不见——而那恰恰是最需要它的时刻。

### 人的裁定（2026-10-11，本会话）

- 那颗键**明确定义为「退出 Live Voice mode」**，并赋予**明显有差异的视觉效果**。
- 通用停止键**附在正在处理的助手输出 /「Thinking...」状态气泡上**：停当前处理，但接受后续输入。
- 退出 Live Voice 时**可继续当前助手的处理**，并把 backlog 的文本**转入输入框 composer**。

### SCOPE BOUNDARY / 关联

<!-- dedup-ref --> 「用语音终止当前回合」是 `gap-live-voice-voice-terminated-interrupt`（**语音指令**通路）；本任务是**手势与按钮**通路，两者必须复用同一个 abort 实现，不各造一个。backlog 的准入轴由 `gap-live-voice-queue-byte-budget-and-visible-backlog` 定义；本任务只消费「已听到但未投递」的集合做「转入 composer」。机制检索（`stop button` / `退出` / `composer 输入框` 于 open 任务）**0 命中**；`task-granularity-advice.js` 报 `peers: []`。

## Plan

1. **退出键重定义**：`VoiceRealtimeBar.tsx` 的 `voice-realtime-end` 改为「退出模式」——换字形（**不再 `Square`**，用离开语义的图标）、**带可见文字标签**（宽视口显示「退出」，窄屏保留图标 + `title`）、拉到最右并用分隔与 Mute / 模型菜单分开、视觉权重从 destructive 实心红改为 outline/ghost。**沿用 `defaultValue` 模式，不改 locale 文件**（`voice.realtime.*` 键在 `src/modules/i18n/locales/*/chat.json` 里本就不存在——已核实 `en/chat.json` 无该节），避免引入未声明的 Touches。
2. **running 行停止键**：`ChatMessagesPane.tsx` 的 `ActivityIndicator`（`:689-706`）增加 `onStop` + `canStop`，实现**复用** `ChatInterface` 已有的 `handleAbortSession`——不新增第二条 abort 路径。该行的既有注释（「carries no Stop」）必须随之改写。
3. **语音模式下同样渲染**：`composerMode === 'voice'` 时该停止键仍在 DOM 且可点——停止键属于**那一行**，不属于 composer；于是 bar 上不必再有第二颗停止键，歧义从根上消失。
4. **composer submit 位**：保留作快捷键，但两处**同一实现、同一 `canAbortSession`**；若与 running 行重复，实现中写明取舍并断言两条路径调用同一个回调。
5. **退出不中断（钉住既有行为）**：确认 `handleEnd` → `end()` + `onExit()` **不触发任何 abort**（今天已如此），并加回归断言把它钉死，防止后人给退出加 abort。
6. **backlog 转入 composer**：退出前把「已听到但未投递」的文本拼成一段写进 composer 输入框。文本取自客户端已有的 caption / refusal / 待投递读数（见 `gap-live-voice-queue-byte-budget-and-visible-backlog`）；经 composer 的既有草稿入口写入；**若该入口不存在**，新增一个最小的受控入口并把它计入 Touches。转入后 backlog 清空，**不得重复投递**（AC5 有重复计数 0 的断言）。
7. **留痕跨模式存活**：去掉 `ChatInterface.tsx:552` 的 `composerMode !== 'voice'` 早退，使未上屏话语的留痕在退出后仍然在屏上。
8. **静态门**：`npm run test:client`、`npm run build:client`、`npm run typecheck`、`npm run lint`。

## AC

- [ ] AC1 形状可分（**取假形态，排在判据文件最前**）：退出键与 composer 停止键的图标**不同名**，且退出键带可见文字标签。判据 `npm run test:client -- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` 退出 0，且该文件**首条断言**即「两键图标不同」。
- [ ] AC2 running 行有停止键：`ActivityIndicator` 在 running 时渲染停止键（`data-testid="running-turn-stop"`），点击后 `handleAbortSession` 对应的 abort 被调用**恰一次**。判据同 AC1 文件退出 0。
- [ ] AC3 语音模式下同样可停：`composerMode === 'voice'` 时 `running-turn-stop` 仍在 DOM 且可点。判据同 AC1 文件退出 0。
- [ ] AC4 退出不中断（**负控**）：点击退出键后 `chat.abort` **未被调用**（计数 0），且 run 状态继续推进。判据同 AC1 文件退出 0，含该负控断言。
- [ ] AC5 backlog 转入 composer：退出时未投递文本出现在 composer 输入框的值里，且退出后**不再**被投递（重复投递计数 0）。判据同 AC1 文件退出 0。
- [ ] AC6 留痕跨模式存活：存在未上屏 utterance 时退出，`voice-closed-unshown-utterance` **仍在** DOM。判据 `npm run test:client -- src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx` 退出 0（**负控**：无未上屏时计数 0）。
- [ ] AC7 e2e 证据（**自证；`scripts/test.sh` 的 fan-in 套件不跑 Playwright**）：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` 退出 0，含「退出键与停止键视觉可分 + 退出后 run 继续」的浏览器读数。
- [ ] AC8 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npm run build:client` 退出 0。

## DoD

一个**真实对象**被操作过：真实 Live Voice 会话中，Claude 正跑一个长回合时——(a) 操作者一眼能分清哪颗键是「退出」、哪颗是「停止」；(b) 点 running 行的停止键**真的停住**当前回合；(c) 点退出键时当前回合**继续跑完**，而未投递的话出现在 composer 输入框里等着重发。证据：两次真实点击的截图/读数、回合时长读数、composer 值的读数。单元测试必要但不充分。

## Touches

- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/composer/ChatComposer.tsx (only if the composer needs a minimal controlled draft entry)
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/index.ts (only if the module's export surface changes)
- src/shared/types.ts (only if a new row/state type is needed)
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx (new)（本任务主判据文件）
- src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx
- e2e/voice-realtime-composer-embedded.spec.ts
- tasks/gap-live-voice-stop-vs-exit-affordances.md (self)
