---
id: architecture-send-selection-to-chat-entry-points
title: 选中实体发到会话：Inspector、右键菜单、悬浮条、Text 面板四个入口，消息用项目显示名与关系行
status: ready
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

- [x] `npx vitest run src/modules/architecture/tests/selectionTray.test.tsx` exit 0：新增用例——放进输入框的消息第一行含项目显示名且不含 UUID 形态字符串（`[0-9a-f]{8}-[0-9a-f]{4}-`）；两个被选实体之间有关系时消息里有对应的关系行，没有关系时没有；追加到已有草稿之后；悬浮条文字含 "Send to chat"（本地化文案）；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/dockInspector.test.tsx src/modules/architecture/tests/textPanel.test.tsx src/modules/architecture/tests/architectureTab.test.tsx` exit 0：Inspector 选中单个实体时操作行有 "Put in chat input"、多选时有带数量的按钮，点击与托盘按钮调用同一处理函数（同一个 mock 被调用且参数相同）；右键实体菜单含该项，右键未选中的实体时以它为唯一选中对象；Text 面板有 "Copy for chat" 与 "Put in chat input" 两个按钮且作用于当前文本范围；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：十个 locale 的新增文案齐全
- [x] `npx playwright test e2e/architecture-send-to-chat.spec.ts` exit 0（在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：PC 与手机视口各一条——选中实体后，从 Inspector 按钮、右键菜单、悬浮条展开的托盘、Text 面板四条路径分别触发，输入框内容都含项目显示名与该实体名、不含 UUID，聊天标签被激活；测试结束前清空输入框草稿；控制臂：恢复用 `projectId` 作为项目名时，不含 UUID 的读数变红
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里（PC 1440×765 与手机 390×844）打开本项目任一含有两个以上实体的会话的 Architecture 标签，分别用四个入口把一个实体、再把两个实体放进输入框，截图并读出输入框里的完整消息（含项目显示名、关系行）。每次都要把输入框草稿清空，使会话回到初始状态，并在 Evidence 里写明已清空。

## Evidence

2026-10-23，worktree `/data/home/yale/work/claudecodeui-worktrees/architecture-send-selection-to-chat-entry-points`（分支 `task/architecture-send-selection-to-chat-entry-points`，实现提交 `1500ee977`，e2e 两实体扩展 `f2e9628f5`，其后已 merge develop 并与 `develop` 做 anti-drift：`ANTI-DRIFT OK … 22 actual file(s), all within declared Touches (25 glob(s))`）。

判据读数（均为改后代码上的实跑）：

- AC1：`npx vitest run src/modules/architecture/tests/selectionTray.test.tsx` → `Test Files 1 passed (1) / Tests 15 passed (15)`（2.19 s）。新增三条：① header 用 `projectName="claudecodeui"` + UUID 形态的 `projectId` 渲染，消息第一行含显示名、全文 `doesNotMatch /[0-9a-f]{8}-[0-9a-f]{4}-/`，分析时间仍在；② 同时选中 Alpha+Beta 时消息含 `- Alpha ← Beta (dependency)` 与 `- Beta → Alpha (dependency)`，改选无边的 Alpha+Gamma 时无任何二者关系行；③ pill 文本 `2 selected · Send to chat ▴`。既有的「非空草稿后追加」「附件围栏」「20 标签折叠/300 实体上限」等用例全绿。
- AC2：`npx vitest run dockInspector.test.tsx textPanel.test.tsx architectureTab.test.tsx` → `Test Files 3 passed (3) / Tests 134 passed (134)`（16.54 s）。dockInspector 新增 4 条：Inspector Adjust 行按钮存在且点击后与托盘按钮产生**逐字相同**的草稿（`assert.equal(readDraftText, fromInspector)`，两条路径都走面板的 `composeSelectionText` + 同一个 `buildSelectionMessage`）；多选摘要下方 `Put 2 in chat input` 且消息含两实体与关系；右键菜单含该项、右键非成员实体后草稿只有该实体且选中集合变成 1；右键成员实体发送整套。textPanel 新增 3 条：按钮文案 `Copy for chat`、`Put in chat input`；点击把**当前 scope** 的 contextText（含 `; scope: Whole filtered graph;` / 切到 `Selected + 1 neighbour` 后内容随之变化）交给回调；空图与无会话时禁用。
- AC3：`npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` → `Test Files 1 passed (1) / Tests 6 passed (6)`。12 个 `locales/*/common.json`（de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN/zh-TW）全部补齐 `tray.pill`、`tray.relatedInLine`、`tray.relatedOutLine`、`curation.putInChat`、`curation.putCountInChat`、`text.copyForChat`、`text.putInChat`。
- AC4：`npx playwright test e2e/architecture-send-to-chat.spec.ts` → `4 passed (35.8s)`（整次调用；PC 四门 7.7 s、手机四门 8.1 s、PC 两实体 7.6 s、手机两实体 6.3 s）。`SPEC_BUDGET_MS['architecture-send-to-chat.spec.ts'] = 240_000`，条目里写明了这组实测。读数（log 原文，PC/手机相同）：四门各门 `hasProjectName=true, hasEntity=true, hasUuid=false`；Text 面 `text="About the architecture diagram (project architecture-send-to-chat-workspace, session Architecture send to chat, analysed at …, scope: Whole filtered graph; view: Class diagram; …)"`；两实体 `hasSecondEntity=true, hasRelationLine=true`，消息含 `- Alpha → Beta (dependency)` 与 `- Beta ← Alpha (dependency)`。每条用例都等 `[data-workspace-tab="chat"][aria-current="true"]` 出现（聊天标签被激活），读完后 `fill('')` 清空并断言为空。控制臂：把真实消息里的显示名替换回项目 UUID（`projectId` 实测为 `[0-9a-f]{8}-…` 形态）后，同一 `analyzeMessage` 得 `healthy hasUuid=false` → `defective hasUuid=true, hasProjectName=false`，红绿分明。
- AC5：`npm run typecheck` exit 0（client/server/scripts 三个 tsconfig）；`npm run build` 成功（client `✓ built in 22.15s`，server `tsc` + promote 成功）；`npm run lint` exit 0（仅既有 warning）。

DoD（真实 Chromium，PC 1440×765 与手机 390×844；AGENTS 要求的 MCP 浏览器在本 worker 环境不可用，改用仓库自带的 Playwright 真实浏览器驱动做同样的亲手操作，截图落在 worktree 的 `tmp/architecture-send-shots/`）：

- 前置 UI 证据（每个入口操作前）：`pc.inspector-open.png`（Adjust 行 `Pin to graph / Remove from graph / Put in chat input`，pill `1 selected · Send to chat ▴`）、`pc.context-menu-open.png`（菜单三项，含 `Put in chat input`）、`pc.text-panel-open.png`（`Copy for chat` 与 `Put in chat input` 相邻）、`pc.tray-open.png`；手机同名 `phone.*` 四张（Text 面板在抽屉内滚动到动作行后截）。
- 一个实体（Alpha）经四个入口放入输入框，消息全文：`About these elements in the architecture diagram (project architecture-send-to-chat-workspace, analyzed 10/23/2026, 3:21:56 PM):` + `- class `Alpha` (src/alpha/alpha.ts)`；截图为 `pc.inspector.composer.png`、`pc.context-menu.composer.png`、`pc.tray.composer.png`、`pc.text-panel.composer.png` 与 `phone.*` 对应四张（Text 面为当前 scope 的会话头 + PlantUML 文档，含项目显示名，无 UUID）。
- 两个实体（Alpha+Beta）经 Inspector 多选按钮（`Put 2 in chat input`）、右键菜单（右键成员）、托盘展开三条路径，消息含显示名、两行实体与两行关系；截图为 `pc.multi-inspector-open.png`、`pc.multi-context-menu-open.png`、`pc.multi-tray-open.png` 及三条 composer 截图和手机同名五张。
- 草稿清空：上述每一次动作之后都执行 `textarea[data-slot="prompt-input-textarea"].fill('')` 并用 `expect.poll(inputValue).toBe('')` 断言为空；四条 e2e 用例结束时（含最后一次动作之后）输入框均为空，会话回到初始状态。
- 场景运行器：architecture 模块没有可用的 `scripts/ui-scenario.mjs` 场景（现有场景只覆盖 quay-panel），故未跑；视觉与交互验证由上述真实浏览器截图承担。

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
