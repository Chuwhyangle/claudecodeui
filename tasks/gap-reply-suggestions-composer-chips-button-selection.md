---
id: gap-reply-suggestions-composer-chips-button-selection
title: 输入框回复建议前端：模型生成 chip、「建议」按钮重抽、选中文字的「引用」chip、窄屏清空按钮与 Esc 清空
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-reply-suggestions-backend-llm-service
---
## Proposal

设计全文见 `docs/proposals/composer-reply-suggestions-llm.md`（yale 2026-10-24 已确认）。本任务做**前端**：把后端 `/api/reply-suggestions` 的结果接进输入框现有的 chip 机制，加「建议」按钮与「引用」chip，并让「清空输入框」在窄屏与键盘上都方便可用。后端接口形状：`GET /status` → `{enabled, expansion, maxChips, maxChipChars}`；`POST /` 体 `{sessionId, redraw?, focus?}` → `{chips, draw}`；`POST /events` 体 `{sessionId, draw, event, index?}` → 204。

**行为。**

- chip 来源与顺序：引用 chip > 模型生成（≤3）> 习惯 chip（已有）。三类都是**完整纯文本**，点击 = 填入再发送（与现有习惯 chip 同一路径），引用 chip 例外（见下）。
- 可见条件沿用 `useInputSuggestions` 的全部现有条件（输入框为空、非加载、无菜单、无排队草稿与附件、不在回合中且与状态条同源）；**只有「引用」chip 放宽**：输入框非空时也显示。
- 模型 chip 的抽取时机：会话切换或助手消息结束且 chip 可见时，对「最后一条助手消息 id」抽一次，同一 id 只抽一次（不随重渲染、不随输入框清空重复请求，清空后复用已有那一批）；`/status` 的 `enabled` 为 false 时不发任何抽取请求，也不显示「建议」按钮；请求失败静默回退到只显示习惯 chip。
- 「建议」按钮：简洁标题（中文「建议」，英文 `Suggest`），放在输入框底栏；点击 = `redraw: true` 重新生成**全部**模型 chip（替换，不累加），有引用文字时带 `focus`；请求中禁用并显示进行状态；触屏与键盘均可操作。
- 「引用」chip：用户在 transcript 里选中文字后出现，点击 = 把 `> 选中原文` 加换行填入输入框并聚焦（不发送）；不做选区旁的浮条，避免与 iOS/Android 系统复制菜单冲突。选区只认 transcript 区域内的文字（输入框、侧栏里的选区不算），超过 600 字符在 chip 上截断显示、填入时保留完整原文的前 600 字符。
- 长文本：chip 标签约 16–20 字省略；鼠标悬停或 Tab 聚焦时，完整文本以灰色预览显示在输入框第二行（缺省预览第一个模型 chip）；触屏点击即填入，不做预览。
- 事件：`picked`（点选，含 index）、`cleared`、`redrawn`、`sent`（以某 chip 填入的文本发出）发给 `/events`，失败不影响界面。`cleared` 只在用户点清空按钮或 Esc 清空时发，手动删光不发。
- 不得请求风暴：切会话、重渲染、选区抖动都不得产生多于一次的抽取请求。

**清空输入框。** 现有清空 ✕（`composer/ChatComposer.tsx` 底栏，调用 `handleClearInput`）带 `hidden sm:flex`，窄屏没有；填入 chip 与引用之后清空成为高频动作，所以：

- 窄屏（紧凑档）在左侧工具组「更多」按钮之后显示同一个 ✕，仍然只在输入框有字时出现；宽度低于 360px 时隐藏（`max-[359px]:hidden`），因为那里的底栏本来就贴着溢出边缘（见该文件对 360px 以下的注释）。点击 = 清空并聚焦输入框。
- 键盘：输入框有字时按 Esc 清空，仅当同时满足：没有任何菜单或浮层打开（斜杠命令、文件提及、模型与权限菜单等先吃掉 Esc）、当前没有进行中的回合。回合进行中 Esc 仍只走全局的中断，**不得清空**。输入框为空时 Esc 的现有行为（隐藏 chip 至回合边界）不变。
- 不做撤销条（✕ 在底栏而非输入框内，误触概率低；实际使用中觉得需要再补）。

**范围外**：扩展（选后再生成备选）、离线基准、后端改动。

## AC

- [x] 模型 chip 钩子逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/useReplySuggestions.test.tsx` 退出码 0；每条独立用例：(a) `/status` 为关闭时不发抽取请求且不显示按钮；(b) 同一助手消息 id 只抽取一次，重渲染与清空输入框后不重复；(c) 助手消息 id 变化时再抽一次；(d) 请求失败时静默回退并不抛错；(e) 「建议」触发 `redraw: true` 且替换而非累加；(f) 有引用文字时 `focus` 被带上；(g) 请求中按钮禁用，完成后恢复；(h) 事件按 `picked`、`redrawn`、`sent` 各发一次且事件失败被吞掉。
- [x] 选区钩子逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/useTranscriptSelection.test.tsx` 退出码 0；每条独立用例：transcript 内的选区被读出；输入框、侧栏内的选区被忽略；空选区与折叠选区清除状态；超长选区截到 600 字符；选区抖动（连续多次 selectionchange）不产生多余状态更新。
- [x] chip 合并与可见性逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestions.test.ts src/modules/chat/tests/inputSuggestionsComposer.test.tsx src/modules/chat/tests/inputSuggestionsDockTurn.test.tsx src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx` 退出码 0（沿用既有文件）；新增独立用例：来源顺序为引用 > 模型 > 习惯；模型 chip 与习惯 chip 文本相同时去重；非空输入框时只剩引用 chip；回合进行中（含状态条的回合锚）不显示任何 chip；长文本标签省略且完整文本进入预览。
- [x] 点击行为逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx` 退出码 0；用例：点模型 chip = 填入再发送；点引用 chip = 填入 `> 原文` 加换行、聚焦、不发送；点「建议」不触发发送；Tab 聚焦 chip 时第二行出现预览。
- [x] 清空逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/composerClearInput.test.tsx` 退出码 0；每条独立用例：(a) 紧凑档、宽度 ≥360px、输入框有字时底栏出现清空按钮，且它位于「更多」按钮之后；(b) 紧凑档输入框为空时不出现；(c) 宽度 <360px 时不出现；(d) 点击后输入框为空、聚焦、`cleared` 事件发出一次；(e) 输入框有字、无菜单、无回合时按 Esc 清空并发 `cleared`；(f) 回合进行中按 Esc 不清空；(g) 斜杠命令菜单打开时按 Esc 只关菜单、不清空；(h) 输入框为空时按 Esc 的行为与原来一致（chip 隐藏）；(i) 手动删光文字不发 `cleared`。
- [x] 窄屏底栏钉子按「有字／无字」两态改写而不是改数字：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx src/modules/chat/tests/composerCompactTier.test.tsx` 退出码 0；`chatComposerResponsive.test.tsx` 的用例 (a) 断言：输入框为空时窄屏底栏恰好六个主控件；有字时是七个且清空按钮是第七个；<360px 有字时仍是六个；`composerCompactTier.test.tsx` 仍断言底栏不换行（`flex-nowrap`）。
- [x] 接口层与类型：`src/shared/api.ts` 新增三个调用（状态、抽取、事件），`src/shared/types.ts` 新增对应类型；`grep -rn "reply-suggestions" src/shared/api.ts` 有输出；`grep -rnE "fetch\(.*reply-suggestions" src --include=*.ts --include=*.tsx | grep -v shared/api.ts` 无任何输出。
- [x] 文案：新增的按钮、引用 chip、预览提示文案键在 `src/modules/i18n/locales/` 下所有语言的 `chat.json` 中键集合一致；仓库现有 i18n 键对齐测试退出码 0。
- [x] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0；受影响文件的既有测试逐个（不跑全套）退出码 0。

## DoD

在**真实运行的页面**上操作并截图，存 `tmp/`，截图随任务贴出。隔离实例做法见 AGENTS.md「UI 验证」与 cockpit 隔离实例记录；后端用真实网关（开发副本 `config/reply-suggestions.settings.json` 由后端任务建立），不碰常驻 :3001，不重启常驻服务；**不要在运行中的会话页面按 Escape**（Esc 清空的真页验证只在空闲会话里做）。

- [x] 桌面宽度：空输入框 + 助手消息以提问结尾 → 贴截图：模型 chip 与习惯 chip 同时出现、顺序正确；点一个模型 chip 后文本被发出；记录抽取请求次数（应为 1）。
- [x] 「建议」：点击后整批 chip 被替换，贴前后两张截图与两批文本；连点多次，贴网络请求计数，证明无请求风暴。
- [x] 引用：在 transcript 里选中一段文字 → 「引用」chip 出现且排在最前；点击后输入框内容为 `> 原文` 加换行并聚焦；输入框非空时引用 chip 仍在、其他 chip 消失；在输入框内选字时不出现引用 chip；贴三张截图。再带选区点「建议」，贴请求体里的 `focus`（脱敏会话 id）与返回 chip 是否围绕该段。
- [x] 390px 触屏模拟：chip 单行横向滚动不换行；点击 chip 直接填入、无预览；按钮可点；有字时底栏出现清空 ✕，点击后清空并聚焦、chip 重新出现且网络请求计数不增加；贴截图。
- [x] 360px 与 390px 两档、使用可选模型里**名字最长**的一个：有字与无字两态各一张截图，底栏不换行、不溢出，开始打字时右侧模型按钮无可见跳动（贴读数：模型按钮左边界在两态下的像素位置）；<360px（例如 340px）有字时 ✕ 不出现且不溢出。
- [x] Esc 清空（空闲会话里做）：输入框有字按 Esc 清空；打开斜杠菜单后按 Esc 只关菜单；贴操作记录。回合进行中的 Esc 不清空由测试 (f) 覆盖，不在真页上按。
- [x] 撤销：填入 chip 后 Ctrl+Z 能撤回到空输入框（贴操作记录）。
- [ ] iOS Safari 与 Android Chrome 真机上，选中 transcript 文字与系统复制菜单共存、引用 chip 可点（待外部）
- [x] 失败回退：把设置里 `enabled` 改回 false（后端按修改时间重读），刷新后无按钮、无抽取请求；再把模型改成错的，抽取失败后界面只剩习惯 chip，控制台无未处理错误；贴截图与控制台读数。
- [x] 场景运行器：若 `scripts/ui-scenario.mjs` 有覆盖输入框 chip 的场景则运行并贴 JSON 报告与检查点截图；没有则注明「无可用场景」并说明查过的目录。

## Touches

- `src/shared/api.ts`
- `src/shared/types.ts`
- `src/modules/chat/hooks/useReplySuggestions.ts`
- `src/modules/chat/hooks/useTranscriptSelection.ts`
- `src/modules/chat/hooks/useInputSuggestions.ts`
- `src/modules/chat/utils/inputSuggestions.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/composer/InputSuggestionChips.tsx`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/ChatInterface.tsx`
- `src/modules/chat/transcript/ChatMessagesPane.tsx`
- `src/modules/i18n/locales/en/chat.json`
- `src/modules/i18n/locales/zh-CN/chat.json`
- `src/modules/i18n/locales/de/chat.json`
- `src/modules/i18n/locales/es/chat.json`
- `src/modules/i18n/locales/fr/chat.json`
- `src/modules/i18n/locales/id/chat.json`
- `src/modules/i18n/locales/it/chat.json`
- `src/modules/i18n/locales/ja/chat.json`
- `src/modules/i18n/locales/ko/chat.json`
- `src/modules/i18n/locales/ru/chat.json`
- `src/modules/i18n/locales/tr/chat.json`
- `src/modules/i18n/locales/zh-TW/chat.json`
- `src/modules/chat/tests/useReplySuggestions.test.tsx`
- `src/modules/chat/tests/useTranscriptSelection.test.tsx`
- `src/modules/chat/tests/inputSuggestions.test.ts`
- `src/modules/chat/tests/inputSuggestionsComposer.test.tsx`
- `src/modules/chat/tests/inputSuggestionsDockTurn.test.tsx`
- `src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx`
- `src/modules/chat/tests/chatComposerReplyChips.test.tsx`
- `src/modules/chat/tests/composerClearInput.test.tsx`
- `src/modules/chat/tests/chatComposerResponsive.test.tsx`
- `src/modules/chat/tests/composerCompactTier.test.tsx`
- `tasks/gap-reply-suggestions-composer-chips-button-selection.md`