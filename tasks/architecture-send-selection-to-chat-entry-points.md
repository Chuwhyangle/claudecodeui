---
id: architecture-send-selection-to-chat-entry-points
title: 选中实体发到会话：Inspector、右键菜单、悬浮条、Text 面板四个入口，消息用项目显示名与关系行
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务让「选择一个或多个实体后发送到会话」的操作容易被发现，并让发出的消息可读。2026-10-23 在真实浏览器里验证：这个功能是有的（选中实体后画布底部出现悬浮条 "1 selected ▴"，点开托盘才有 "Put in the input and switch to chat"，在手机上走通：输入框出现消息并切到 Chat），但入口几乎找不到：右键菜单只有 "Pin to graph / Remove from graph"；Inspector 是选中单个实体时唯一常开的面板，里面没有这个操作；Text 面板里的 "Copy as session context" 只是复制，且叫法与托盘不一致；悬浮条上的字没有任何「发送」提示。已完成的 `architecture-multiselect-and-selection-tray` 建立了托盘与这个操作，本任务不改它的行为，只增加入口与修正消息内容。没有开放任务与本任务的核心文件（`ArchitectureSelectionTray.tsx`、`ArchitectureInspector.tsx`）重叠，其余文件与其它架构任务重叠，由调度器串行。

消息内容的问题：放进输入框的第一行是 "About these elements in the architecture diagram (project b0a96771-c926-468a-bf18-09a5b3708039, analyzed 10/23/2026, 6:14:35 AM):"，里面是原始项目 UUID，读者看不懂；`ArchitectureSelectionTray.tsx` 里把 `projectId` 直接填进了 `architecture.tray.messageHeader` 的 `{{project}}`。（语言跟随界面语言，这一点没有问题，不要改。）

要求：
1. **Inspector 增加入口**：选中单个实体或单条关系时，Inspector 的 "Adjust" 操作行（Pin / Remove 旁）增加 "Put in chat input"；多选时 Inspector 的计数下方也提供同一个按钮（带数量，如 "Put 3 in chat input"）。点击后行为与托盘里的同名按钮完全一致（同一个处理函数，不复制逻辑）。
2. **右键菜单增加入口**：右键实体的菜单在 "Pin to graph / Remove from graph" 之外增加 "Put in chat input"；右键的实体若不在当前选中集合里，则以它单独作为选中对象。
3. **悬浮条文字**：触摸与桌面的悬浮条文字改为 "N selected · Send to chat ▴"（本地化文案），让它看起来是一个有动作的入口，而不只是一个计数。
4. **Text 面板**：把 "Copy as session context" 改名为与托盘一致的叫法（例如 "Copy for chat"），并在它旁边增加 "Put in chat input"，作用于当前文本范围（Whole filtered graph / Current viewport / Selected + neighbours）。
5. **消息内容**：第一行用项目的显示名（面板标题下方已显示的项目名，例如 `claudecodeui`）代替 UUID；分析时间保留但不得出现 UUID 或内部 id；每个被选实体除类名与路径外，附上它与其它被选实体之间的关系（有则一行，如 `StreamingVad ← VoiceFrameProcessor (composition)`）。
6. 放进输入框的行为不变：追加到已有草稿之后、切到 Chat、不自动发送。

文案新增键需要在全部 10 个 locale 补齐，`i18nArchitectureTabCompleteness.test.ts` 通过。

## Plan

1. `ArchitectureSelectionTray.tsx`：把「放进输入框」抽成一个可被多处调用的函数（若尚未导出），消息头用项目显示名，增加被选实体之间的关系行；悬浮条文字。
2. `ArchitectureInspector.tsx` 与 `ArchitecturePanel.tsx`：Inspector 操作行与多选摘要处的按钮；面板把项目显示名传给托盘与消息构造。
3. `PlantUmlGraph.tsx`：右键菜单增加入口并处理「右键对象不在选中集合内」。
4. `ArchitectureTextPanel.tsx`：改名与新增按钮。
5. 文案：10 个 locale；测试与 e2e。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/selectionTray.test.tsx` exit 0：新增用例——放进输入框的消息第一行含项目显示名且不含 UUID 形态字符串（`[0-9a-f]{8}-[0-9a-f]{4}-`）；两个被选实体之间有关系时消息里有对应的关系行，没有关系时没有；追加到已有草稿之后；悬浮条文字含 "Send to chat"（本地化文案）；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/dockInspector.test.tsx src/modules/architecture/tests/textPanel.test.tsx src/modules/architecture/tests/architectureTab.test.tsx` exit 0：Inspector 选中单个实体时操作行有 "Put in chat input"、多选时有带数量的按钮，点击与托盘按钮调用同一处理函数（同一个 mock 被调用且参数相同）；右键实体菜单含该项，右键未选中的实体时以它为唯一选中对象；Text 面板有 "Copy for chat" 与 "Put in chat input" 两个按钮且作用于当前文本范围；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：十个 locale 的新增文案齐全
- [ ] `npx playwright test e2e/architecture-send-to-chat.spec.ts` exit 0（在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：PC 与手机视口各一条——选中实体后，从 Inspector 按钮、右键菜单、悬浮条展开的托盘、Text 面板四条路径分别触发，输入框内容都含项目显示名与该实体名、不含 UUID，聊天标签被激活；测试结束前清空输入框草稿；控制臂：恢复用 `projectId` 作为项目名时，不含 UUID 的读数变红
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里（PC 1440×765 与手机 390×844）打开本项目任一含有两个以上实体的会话的 Architecture 标签，分别用四个入口把一个实体、再把两个实体放进输入框，截图并读出输入框里的完整消息（含项目显示名、关系行）。每次都要把输入框草稿清空，使会话回到初始状态，并在 Evidence 里写明已清空。

## Touches

- src/modules/architecture/ArchitectureSelectionTray.tsx
- src/modules/architecture/ArchitectureInspector.tsx
- src/modules/architecture/ArchitectureTextPanel.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/selectionTray.test.tsx
- src/modules/architecture/tests/dockInspector.test.tsx
- src/modules/architecture/tests/textPanel.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- e2e/architecture-send-to-chat.spec.ts
- playwright.config.ts
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
- tasks/architecture-send-selection-to-chat-entry-points.md
