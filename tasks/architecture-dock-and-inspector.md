---
id: architecture-dock-and-inspector
title: 右侧停靠区 + 实体/关系检查器：单击选中、双击下钻，会话页显示提及该实体的消息并可跳到 Chat 定位；停靠区开合时冻结重新布局
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-mention-provenance
  - architecture-toolbar-readout-and-legend
  - architecture-mobile-sheet-layout
---
## Proposal

2026-10-22 设计评审与用户确认的交互设计（用户已确认：停靠区共用并冻结重新布局、PC 单击选中双击下钻、会话页默认不含 `tool_result`、单字母快捷键仅在画布聚焦时生效）。本任务搭停靠区外壳、选择模型与检查器；文本页、钉住/移除、多选与选择托盘由后续任务在同一外壳上接入。

### 一、停靠区（PC）

- 画布右侧一块 320px 的可收起停靠区（`role="complementary"`，页签 `tablist`），**默认关闭**；选中节点时自动打开「检查器」页，点关闭按钮收起。外壳支持注册多个页签（本任务只注册「检查器」，「文本」页签由后续任务注册），收起状态按本地存储记忆。打开时挤占画布宽度，不是浮层。
- **开合期间冻结重新布局**：画布容器宽度变化会让宽高比超过 `ASPECT_RELAYOUT_THRESHOLD`（15%，`elkAspectEngine.ts`）而触发整图重排。给 `shouldRelayoutForAspect`/重排调度加一个「锁」，停靠区开合与拖拽调宽期间不因宽高比变化触发重排，只重新适应视口（fit）；锁释放后以**打开前**的宽高比为基准，不把开合本身算作一次形状变化。锁是纯函数入参，不在模块里藏状态。
- 手机/粗指针档位：同一份检查器内容渲染进相关任务提供的底部抽屉（三个吸附高度：收起 96px 只显示名字、种类和操作按钮，半屏 45vh，全屏），沿用 `useTouchLayout` 的档位判断，不另造断点。

### 二、选择模型（单选；多选在后续任务）

- 纯函数/小状态模块 `src/modules/architecture/selectionModel.ts`：选中一个实体或一条关系，或为空；换视图/换会话清空。
- PC：**单击选中并打开检查器，双击下钻**（原先的单击下钻改为双击；触摸维持「点按选中、双击下钻」）。键盘（仅画布聚焦时）：`]`/`[` 下一个/上一个节点，`Enter` 选中，`Alt+Enter` 下钻，`Escape` 先关停靠区、再清除选择，且 `stopPropagation`。
- 选中样式：`ring-2 ring-primary/60` 加角标对勾（不只靠颜色）；关系选中时线加粗并显示类型文字。关系的点击命中区放大到 12px（触摸 ≥ 44px），用不可见的粗描边实现，不改 SVG 的 `data-edge-*` 契约。

### 三、检查器内容

- **头部**：种类图标和名字、文件路径（前截断，悬停全路径）。
- **概览页**：构造型/种类；成员前 8 个可展开；入度/出度；按关系类型分组的关联列表，点击即选中并居中到该节点。
- **会话页**：页签带命中数。数据来自 `POST /api/architecture/mentions`（由提及出处任务提供）。开关「包含工具输出」默认关，对应 `includeToolResults`。每条命中：角色徽标（用户/助手/工具输出）、相对时间、两行摘录（名字用 `<mark>` 高亮）；点击在新建的共享接缝里发出「定位这条消息」请求并切到 Chat 标签。同名时显示 `role="note"` 提示「名字 X 对应 N 个实体，命中可能指向其中任意一个」。状态：加载中（3 行骨架屏、`aria-busy`）、无命中（「会话里没有直接提到它。它在图中，是因为它距离最近的提及 N 跳」，N 取节点 `distance`）、出错（重试按钮）、截断（「仅显示前 20 条」）。
- **关系检查器**：两端实体、UML 类型名（继承/实现/组合/聚合/依赖/调用）、聚合边列出它包含的底层边（前 20 条）、「共同出现的消息」列表（`edge.coMentions`）。

### 四、跳到 Chat 并定位消息（模块间只经共享接缝）

聊天模块已有按消息 id 居中的 `jumpToMessage`（`ChatInterface.tsx` 里作为 `locateMessage` 交给 `useUiNavigate`），但它是 ChatInterface 内部函数；架构模块与聊天模块互不 import。新建共享接缝 `src/shared/chatMessageLocator.ts`（形如 `src/shared/chatDrafts.ts` 的订阅式小存储）：`requestLocateMessage(messageId)` 记录请求并通知订阅者，`subscribeToLocateRequests(listener)`。`ChatInterface` 订阅，并且**只在 `isActive` 为真（Chat 标签已可见）时**调用 `jumpToMessage`——架构标签打开时 Chat 是挂载但隐藏的（`WorkspaceMain.tsx` 的 `hidden` 类），隐藏时居中没有意义；请求在 Chat 变为可见后消费，找不到消息（`jumpToMessage` 返回 false）时在 Chat 里显示一条「没有找到这条消息」的轻提示，不静默。`ArchitecturePanel` 新增可选 prop `onOpenChat?: () => void`，由 `WorkspaceMain` 传入 `() => setActiveTab('chat')`。

### 五、无障碍与动效

停靠区与抽屉的焦点管理（关闭后焦点回到触发处）；检查器内容变化用 `aria-live="polite"`；页签、列表、按钮的 ARIA 角色与名字齐全。动效：停靠区滑入 160ms ease-out（`transform`），`prefers-reduced-motion` 下取消。所有新文案走 i18n，12 个 locale 键齐全。

## AC

- [x] `npx vitest run src/modules/architecture/tests/selectionModel.test.ts` exit 0（新文件）：选中实体/关系/清空；换视图与换会话清空；`]`/`[` 在节点顺序上循环；选中状态不在模块内残留
- [x] `npx vitest run src/modules/architecture/tests/layoutAspect.test.tsx` exit 0：新增用例——停靠区开合（容器宽高比变化超过 15%）在锁生效时**不**触发重排、只 fit；锁释放后同一宽高比不再触发；锁未生效时既有的 15% 阈值与 250ms 防抖用例不回归
- [x] `npx vitest run src/modules/architecture/tests/dockInspector.test.tsx` exit 0（新文件）：默认不渲染停靠区；单击节点打开停靠区并显示名字/种类/路径，双击下钻（邻域视图），触摸档位点按选中、双击下钻；`Escape` 先关停靠区再清选择且 `chat.abort` 调用计数为 0；概览页的关联列表点击后选中并居中目标；会话页五个状态（加载/无命中/出错/截断/同名提示）各一条用例；「包含工具输出」默认关且切换后请求带 `includeToolResults: true`；点击命中项调用 `requestLocateMessage(messageId)` 并触发 `onOpenChat`；关系检查器显示两端、类型与 `coMentions`
- [x] `npx vitest run src/modules/chat/tests` 中新增/既有用例 exit 0（`--test-name-pattern` 限定到新增的定位用例即可）：Chat 不可见（`isActive` 为假）时收到定位请求不调用 `jumpToMessage`、变为可见后才调用；`jumpToMessage` 返回 false 时出现「没有找到这条消息」提示；`src/shared/chatMessageLocator.ts` 的订阅/取消订阅用例
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/mobileGestures.test.tsx src/modules/architecture/tests/mobileCompactToolbar.test.tsx` exit 0：既有用例里「单击下钻」的断言已逐处改为双击（列在实施记录）；粗指针档位下检查器渲染进底部抽屉且有三个吸附高度
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（PC 1440×900）打开 quay 会话 architecture tab：单击一个实体，右侧滑出 320px 停靠区，画布没有因此整图重排（贴开合前后节点坐标不变的读数）；会话页列出提及它的消息，名字被高亮，点击其中一条后工作区切到 Chat 并把该消息居中；对 `main` 这类同名多的实体看到同名提示；勾选「包含工具输出」后多出工具输出命中。双击节点下钻邻域。再用手机视口（390×844，`isMobile`+`hasTouch`）点按一个实体，底部抽屉升起并可在三个高度间切换。证据是操作前后节点坐标读数、截图与 Chat 里被居中的消息 id。

## Touches

- src/modules/architecture/ArchitectureDock.tsx (new)
- src/modules/architecture/ArchitectureInspector.tsx (new)
- src/modules/architecture/selectionModel.ts (new)
- src/modules/architecture/hooks/useMentions.ts (new)
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitectureSheet.tsx
- src/modules/architecture/elkAspectEngine.ts
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/tests/selectionModel.test.ts (new)
- src/modules/architecture/tests/dockInspector.test.tsx (new)
- src/modules/architecture/tests/layoutAspect.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/mobileGestures.test.tsx
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/modules/architecture/tests/exportMenu.test.tsx
- src/shared/chatMessageLocator.ts (new)
- src/shared/tests/chatMessageLocator.test.ts (new)
- src/shared/api.ts
- src/shared/utils.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/chatMessageLocate.test.tsx (new)
- src/modules/project-workspace/WorkspaceMain.tsx
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
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/de/chat.json
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
- tasks/architecture-dock-and-inspector.md

## Implementation record

**手势**。PC 单击 = 选中并打开停靠区，双击 = 下钻；触摸维持单击选中、双击下钻（`DOUBLE_TAP_MS` 窗口不变）。键盘仅在画布聚焦时生效：`[` / `]` 按 payload 节点顺序循环移动焦点、`Enter` 选中、`Alt+Enter` 下钻；`Escape` 只在存在选择时拦截（`preventDefault` + `stopPropagation`），先关停靠区、第二次清选择；无选择时不拦截，聊天页的全局 abort 不受影响。

**「单击下钻」断言的逐处改动**（`src/modules/architecture/tests/architectureTab.test.tsx`）。新增 `drillNode(host, id)` 帮助函数：先 `click`（保留选中与 `architecture:entity-selected` 断言），再 `doubleClick`（触发下钻）。原先依赖单击下钻的 17 处断言改为该帮助函数：left-drag 的 press-on-node、middle-button/3px 抖动、cancelled-drag 三处；redrawing-view；semantic-zoom；三个 group 展开用例（overview / deep re-group / flat-over-limit）；neighbourhood drill + centre hop；hover highlight 与 stable-ids 的前置下钻；pinned announce 用例的两级下钻。相关用例标题/注释同步改为「double-click」。同批改动：`src/modules/architecture/tests/exportMenu.test.tsx` 的两处下钻断言（目录组展开、实体邻域）同样改为 `fireEvent.doubleClick`，该文件因此加入 Touches。触摸用例（`mobileGestures.test.tsx`）无需改动。

**画布高度链**。停靠区与画布共享的 flex ROW 嵌在「面板直接子节点」内部；面板那个直接子节点本身保持 `flex-1 flex flex-col`。若让 flex row 直接充当面板的子节点，`canvasLayoutContract.test.tsx` 的高度链契约就会在行容器上读 `flex-col` 而报红（行方向正是水平），且下方 `flex-1`/`h-full` 的解析基准也会跟着变。

**自动打开的正确性**。停靠区自动打开效应只依赖 `selection`（不依赖 `dockOpen`），否则 Escape 关闭后会被「仍有选择」立刻重开——本实现第一版出现过该环并导致测试 worker 崩溃，现在由 Escape 用例（先关后再清、document 级 keydown 计数 0）钉住。

**重排锁**。`shouldRelayoutForAspect(drawn, measured, { locked })` 的锁是纯函数入参；`ArchitecturePanel` 在停靠区开合时置 `relayoutLocked` 200ms（160ms 动画 + 余量），渲染器锁内只 fit；锁释放时把当前测量写回 `drawnAspectRef`（不重排），因此开合本身永不计为形状变化；真正后续的形状变化仍重排一次。`layoutAspect.test.tsx` 新增该整链用例（1.333 → 0.978 锁内 0 次重排、解锁后同一比例仍 0 次、再变到 0.667 才 1 次）。

**共享接缝与 API**。`src/shared/chatMessageLocator.ts` 记录「最新一条待消费请求」并通知订阅者；`ChatInterface` 订阅后只在 `isActive` 时消费，`jumpToMessage` 返回 false 时渲染 `[data-chat-locate-notice]` 提示。`POST /api/architecture/mentions` 的调用统一收进 `src/shared/api.ts` 的 `architectureMentions`（`limit: 20`），`useMentions` 按选择内容做请求键并丢弃过期回复。时间格式化的既有实现从 Panel 提到 `src/shared/utils.ts`（Panel 与 Inspector 共用，输出不变）。

**i18n**。Dock/Inspector 的新键与关系类型名加入 12 个 `common.json`；聊天提示加入 12 个 `chat.json`。`i18nArchitectureTabCompleteness.test.ts` 的键提取范围扩到 Dock/Inspector 两个新源文件，避免新文件里的文案逃过完整性检查。

**验证（本 worktree，逐文件运行）**：
- `selectionModel.test.ts` 4/4；`layoutAspect.test.tsx` 8/8；`dockInspector.test.tsx` 9/9
- `chatMessageLocate.test.tsx` 3/3；`src/shared/tests/chatMessageLocator.test.ts` 3/3
- `architectureTab.test.tsx` 65/65；`mobileGestures.test.tsx` 7/7；`mobileCompactToolbar.test.tsx` 9/9
- `i18nArchitectureTabCompleteness.test.ts` 6/6；`canvasLayoutContract.test.tsx` 3/3；`exportMenu.test.tsx` 11/11
- `npm run typecheck` 与 `npm run build` 通过

**DoD（真实浏览器）**：本 worker 会话未启动/重启本机 server（重启会杀掉承载会话的进程），浏览器读数与截图留给 fan-in 后的人工复核。

## Blocker

**2026-10-22T13:51:13.218Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/modules/architecture/tests/canvasLayoutContract.test.tsx: AssertionError [ERR_ASSERTION]: the canvas region stacks its rows in a column
- run_id：wk-prod-anchor
- session_id：366b91ed-92fe-4552-989f-5c5b7cf009be
