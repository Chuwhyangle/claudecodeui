---
id: chat-reply-items-addressable
title: 回复条目可寻址：assistant 回复里的编号条目带标签与地址，「第 1 点 / 执行 1–2 / 按你的方案」在发送前预览并高亮
status: ready
labels:
  - chat
  - ui
  - voice
parent: null
children: []
extra: {}
---
## Proposal

决策出处：2026-10-24 对用户真实话语的小探针（`experiments/voice-grounding-probe/README.md` 探针 3/4，最近 12 天 1003 条单行短句，固定种子抽 40 条人工标注）。用户已确认先做本项。

发现：话语里**最大的指代来源是 agent 刚说过的话**——40 条里 15 条指向对话上下文（「上面 / 上述 / 你的建议 / 第 1 点 / 执行 1–2 并把 3 排成定时重启」），只有 6 条指向屏幕上的对象；全量 1003 条中「指代上文」占 11.5%。可是 agent 回复里的条目现在只是文本流里的字，系统既不能高亮它们，也不能把「第 1 点」解析成具体内容；用户只能靠自己对照，指错了也看不出来。打字和语音都受这个问题影响。

方案（只做 chat 会话视图；驾驶舱侧的接入另立任务）：
1. **条目提取（纯函数）**：新文件 `src/modules/chat/utils/transcript/replyItems.ts` 提供 `extractReplyItems(markdown)`，从一条 assistant 回复里提取可寻址条目：顶层有序列表项、顶层无序列表项（仅当回复里没有有序列表时）、以数字编号开头的标题或粗体段落（如 `## 1. …`、`**1. …**`）。每个条目给出 `{ordinal, label, excerpt, kind}`：label 是 ①②③…，excerpt 取前 80 个字符。代码块和表格内部不提取。
2. **条目地址**：`cloudcli://session/<sessionId>/msg/<messageId>#item-<n>`，格式化和解析都放在 `replyItems.ts` 里；不改动 observation wall 的 URI 语法（`src/modules/cockpit/observationUri.ts` 与服务端那份保持不变）。
3. **转写里显示标签**：只给**最近一条 assistant 文本回复**的条目显示 ①② 标签，放在条目左侧，样式低调；条目元素带 `data-reply-item-uri` 与 `data-reply-item-label`，供场景驱动和浏览器验证读取。
4. **指代解析（纯函数）**：`resolveReplyReference(text, items)` 识别「第 1 点 / 第三条 / 第二项 / ②」「1–2 / 1-3 / 1、3 / 第 1 和第 3 点」「前三条 / 最后一条」「上述 5 项 / 这 5 条」（数量与条目数一致时视为全部，不一致时返回 mismatch）、「按你的方案 / 按上面的 / 上述方案」（整条回复）。返回 `{kind: 'items' | 'reply' | 'none' | 'mismatch', ordinals}`。不能确定时返回 none 或 mismatch，不猜。
5. **输入框预览**：用户在输入框里打字或口述，内容命中上述说法时，输入框上方显示一行预览，例如「第 1–2 点 → ①「…」②「…」」，同时高亮转写里对应的条目；mismatch 时显示「回复里只有 4 条」。**发出的消息内容保持不变**，agent 本来就能看到自己的回复，预览只是让人在发送前确认指对了。

## AC

- [ ] AC1: `npx vitest run src/modules/chat/utils/tests/replyItems.test.ts` exit 0——提取：有序列表、编号标题、编号粗体段落各有夹具；代码块和表格内的数字行不被提取；只有无序列表时提取无序项，同时有有序列表时只取有序项；地址格式化与解析往返一致。
- [ ] AC2: 同一测试文件——解析：「第 1 点」「第三条」「②」→ 单条；「1–2」「1、3」「第 1 和第 3 点」「前三条」「最后一条」→ 对应集合；「上述 5 项」在 5 条时为全部、在 4 条时为 mismatch；「按你的方案」→ reply；「十二点开会」「一起看看」「第一次」→ none。
- [ ] AC3: `npx vitest run src/modules/chat/tests/replyItemReferences.test.tsx` exit 0——转写中只有最近一条 assistant 回复显示条目标签，并带 `data-reply-item-uri`；在输入框里输入「执行 1–2」后，预览行列出 ①② 的摘要，转写中对应条目带高亮标记；发送后的消息文本与输入完全一致；输入「执行第 6 点」而回复只有 4 条时，预览显示条目数不符。
- [ ] AC4: `npx vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx src/modules/chat/tests/inputSuggestionsComposer.test.tsx` exit 0（既有输入框用例不弱化）；文案覆盖 12 个 locale；`npm run typecheck` 通过。

## DoD

- **MCP 浏览器（或独立 Playwright）实际操作 + 截图（必做）**：在真实运行的 CloudCLI 上打开一个最近一条回复带编号列表的会话，截图条目标签；在输入框里依次输入「第 2 点展开说说」「执行 1–2」「按你的方案做」，截图预览行与转写高亮；用 `browser_evaluate` 读回 `data-reply-item-uri` 列表。截图存 `tmp/` 并在任务里贴出。
- 用探针样本中的真实话语（`experiments/voice-grounding-probe/utterance-sample40.json` 里指向对话上下文的 15 条）逐条跑一次解析，如实列出哪些被识别、哪些返回 none 及原因。
- 场景运行器可用时补一个场景并贴报告；不可用则如实写明。

## Touches

- src/modules/chat/utils/transcript/replyItems.ts (new)
- src/modules/chat/utils/tests/replyItems.test.ts (new)
- src/modules/chat/tests/replyItemReferences.test.tsx (new)
- src/modules/chat/composer/ReplyReferencePreview.tsx (new)
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/transcript/Markdown.tsx
- src/modules/chat/transcript/StreamingMarkdown.tsx
- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/index.ts
- src/modules/chat/tests/chatComposerReplyChips.test.tsx
- src/modules/chat/tests/inputSuggestionsComposer.test.tsx
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- tasks/chat-reply-items-addressable.md
