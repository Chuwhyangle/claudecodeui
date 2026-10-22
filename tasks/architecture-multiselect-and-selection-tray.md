---
id: architecture-multiselect-and-selection-tray
title: 多选与选择托盘：Shift/Ctrl 点选、Shift 框选、长按多选；选中后写一段文字放进 Chat 输入框（追加，可附选中子图的 PlantUML）
status: done
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-curation-pins-and-excludes
  - architecture-text-panel
---
## Proposal

用户要「选中一个或多个实体/关系，输入文本，在当前会话里发出一条与它们相关的消息」。已确认：首版只做「放进输入框并切到 Chat」，用户确认后自己发送；写入采用**追加**而不是覆盖；直接发送（绕过输入框）不在首版范围，原因是发送逻辑（`chat.send` 帧）封装在 `useChatComposerState.ts` 里带着设置快照，没有对外出口，还牵涉忙时/常驻会话/排队语义。

### 一、多选（扩展单选的选择模型）

- 选择集合是 app 状态（`selectionModel.ts` 扩为集合，纯函数），换视图/换会话清空；停靠区的检查器在多选时显示「已选 N 项」摘要而不是单个实体详情。
- **PC**：`Shift` 或 `Ctrl/Cmd` + 点击加选/取消；**`Shift` + 拖动框选**（普通拖动仍是平移）；框选命中节点与边（边按其放大后的命中区判定）。键盘（画布聚焦时）：`Space` / `Shift+Enter` 切换当前节点是否入选，`Alt+Enter` 下钻不变。
- **触摸**：长按（500ms，可用时触发 `navigator.vibrate(10)`）进入多选模式，之后点按切换；顶部出现「多选 · 已选 N · 完成」条；多选模式下拖动仍然平移；无框选。
- 边可选：点击边线的放大命中区（PC 12px、触摸 ≥ 44px）；选中后显示类型文字。

### 二、选择托盘

- 画布内、底部居中；无选中时不显示。折叠态是药丸「已选 3 项 ▴」；展开宽度 `min(560px, 画布宽 − 24px)`，避让缩略图与缩放簇（宽度上限扣除它们的占位）。
- 内容：选中项标签（实体显示种类图标和名字，关系显示 `A → B`，每个带 ×），`清除选择`；自动增高的文本框（最多 6 行，占位「对这些元素说点什么…」）；`☐ 附上选中子图的 PlantUML`（勾选后出现范围下拉「仅选中 / 含 +1 邻居」与体量读数，复用文本页的 `buildPlantUmlText` 与体量分级）；主按钮 `放进输入框并切到对话`；次按钮 `移除所选`（走手动调整的移除/取消钉住）与 `复制 PlantUML`。
- 选中超过 20 项时只显示前 20 个标签加「…另 N 项」；选中的实体超过 300 个时禁用「附上 PlantUML」并说明原因；体量 > 8k token 时显示提示，> 30k token 禁用附带并提示改用更小范围（阈值与文本页一致）。
- 手机档位：托盘并入底部栏「已选 N 项 ▴」，展开为抽屉，内容同上。

### 三、写入输入框（追加，不覆盖）

- 点主按钮：按下面的固定格式生成一段文本，用 `src/shared/chatDrafts.ts` 的 `writeDraftText(scope, 原草稿 + 空行 + 新内容)` **追加**到当前会话的草稿，然后调用 `onOpenChat`（`WorkspaceMain` 的 `setActiveTab('chat')`）并聚焦输入框；弹 Toast「已放进输入框」（草稿原来非空时写「已追加到输入框」）。不自动发送。
- `scope` 与聊天输入框一致：已核实 `useChatComposerState.ts` 里 `draftScope = (selectedSession?.id || currentSessionId) ?? \`project:${selectedProjectId}\``，且该 hook 订阅了 `subscribeToChatDrafts` 来恢复草稿，所以架构面板用自己的 `sessionId` 写入同一个键即可；没有会话时调整与托盘的发消息功能禁用并说明原因。
- 固定格式（实体行格式「`种类 \`名字\`（文件）`」，关系行「`关系：\`A\` --|> \`B\`（继承）`」，关系的 PlantUML 箭头取自既有的关系映射，不另造）：

```
关于架构图中的这些元素（项目 {项目}，分析于 {时间}）：
- interface `GateFactory`（packages/quay/src/gate/factories/goal.ts）
- 关系：`A` --|> `B`（继承）
{用户输入}

```plantuml
{选中子图的 PlantUML}
```
```

没勾选附带时省略围栏部分。

### 四、无障碍

托盘 `role="region" aria-label`；标签按钮 `aria-label="取消选择 X"`；框选与多选的选中数变化用 `aria-live="polite"`；`Escape`（画布聚焦时）先收起托盘展开态，再清除选择，且 `stopPropagation`，不触发聊天页的全局中止；触摸目标 ≥ 44×44。新文案走 i18n，12 个 locale 键齐全。

## AC

- [x] `npx vitest run src/modules/architecture/tests/selectionModel.test.ts` exit 0：选择集合的加选/取消/清空；框选命中规则（节点与边）；换视图与换会话清空；既有单选用例不回归
- [x] `npx vitest run src/modules/architecture/tests/selectionTray.test.tsx` exit 0（新文件）：`Shift`/`Ctrl` 点击加选、`Shift`+拖动框选（普通拖动不框选而是平移）、长按进入多选模式（触摸）；标签与 × 取消；超过 20 项折叠为「…另 N 项」；> 300 实体时附带 PlantUML 禁用并有说明；`Escape` 先收托盘再清选择且 `chat.abort` 调用计数为 0
- [x] 同文件：点主按钮后 `writeDraftText` 被调用，scope 与 `selectedSession?.id`（无会话时为 `project:<id>`）一致；**追加**而不是覆盖（原草稿非空时新内容在其后且中间有空行）；内容符合固定格式（实体行、关系行、用户输入、可选 ` ```plantuml ` 围栏）；`onOpenChat` 被调用；Toast 文案随原草稿是否为空区分；没有会话时按钮禁用
- [x] `npx vitest run src/modules/chat/tests/composerDraftScoping.test.tsx` exit 0（外部写入草稿后 composer 通过订阅恢复该文本，既有用例不回归；如需新增用例就在该文件内加）
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/mobileGestures.test.tsx` exit 0（既有用例不回归）；`npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（PC）打开 quay 会话 architecture tab：`Shift` 点选两个实体和它们之间的一条关系，托盘出现三个标签；输入一句话、勾选「附上选中子图的 PlantUML」，读数显示约几 k token；点「放进输入框并切到对话」，工作区切到 Chat，输入框里是固定格式的文本（贴输入框内容的开头），原来已写在输入框里的内容仍在最前面；回到架构标签再追加一次，内容追加在后面而不是覆盖。手机视口（390×844）：长按一个节点进入多选，点按另两个，抽屉里重复上述发送。证据是两次写入后的输入框内容与截图。

## Touches

- src/modules/architecture/selectionModel.ts
- src/modules/architecture/ArchitectureSelectionTray.tsx (new)
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitectureDock.tsx
- src/modules/architecture/ArchitectureInspector.tsx
- src/modules/architecture/ArchitectureSheet.tsx
- src/modules/architecture/plantUmlText.ts
- src/modules/architecture/curationStore.ts
- src/modules/architecture/hooks/useTouchLayout.ts
- src/modules/architecture/tests/selectionModel.test.ts
- src/modules/architecture/tests/selectionTray.test.tsx (new)
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/mobileGestures.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/modules/chat/tests/composerDraftScoping.test.tsx
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/de/common.json
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
- tasks/architecture-multiselect-and-selection-tray.md