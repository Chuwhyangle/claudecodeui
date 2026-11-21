---
id: gap-chat-hot-path-render-profile
title: Chat 热路径大 hook/组件：先 profile commit/render 热点再做一个低风险改动
status: ready
labels:
  - gap
  - performance
  - frontend
parent: null
children: []
extra:
  schema: execution
---
## Finding

Chat 热路径集中了几个大文件/大 hook：`src/modules/chat-session/hooks/useChatSessionState.ts` 2,127 行 / 68 个 hooks、`src/modules/chat-session/hooks/useSessionStore.ts` 2,335 行、`src/modules/chat-composer/composer/ChatComposer.tsx` 1,618 行、`src/modules/chat/ChatInterface.tsx` 1,477 行 / 19 个 hooks。全仓已有 219 个 `useMemo`、693 个 `useCallback`、513 个 `useEffect`；继续无测量地加 memo/拆 hook 可能只是增加复杂度。

本任务**先 profile 再改**：固定 running + 流式 + >=100 条消息的场景，找出真实的 commit/render 热点；只有确认热点才做一个低风险改动（状态下沉、memo 边界、selector、减少不必要的 effect/state），否则记录证据并保持原样。CockpitPage/ArchitecturePanel 的大组件不在本任务范围（它们先由路由懒加载处理）。

## AC

- [x] AC1 Profile：React Profiler + Performance 面板，记录 commit 次数、按组件/ hook 的 render 次数与耗时、`useChatSessionState` 消费者重渲染；先打印 `commits=... topComponents=...` 再决策。若无法取得真实流式场景，park `needs-human` 并说明。
  - 已用真实 Chromium + 真实后端 + 真实 WebSocket 流式帧取得读数（见 Evidence）：
    `commits=115 topComponents=LazyMessageRow:11203/65ms,_c:5128/45ms,Ellipsis:2185/6ms,Star:2070/5ms,ActionMenu:2070/30ms,p:2055/4ms,Markdown:2055/997ms,MessageCopyControl:2055/73ms,SidebarProjectActionsMenuBody:1955/31ms,RoutedSidebarProjectActionsMenu:1955/11ms,SidebarProjectActionsMenu:1955/5ms,SidebarProjectSessions:1872/5ms`
  - `useChatSessionState` 的消费者是 `ChatInterface`（instances=1），窗口内 115 commit 中它每次 flush 都重渲染（每 commit 1 次），其下游 `ChatMessagesPane`/`ChatComposer` 各 1 个实例随之重渲染。
  - 场景：debug-agent 场景时钟先写 120 条历史 message，再以 `text-delta` 每 100ms 追加一段流式文本；REST total=122（>=100），浏览器固定在尾部跟随。生成器是 dev-only fixture，但传输、归一化、WebSocket 分发与 React 渲染都是产品真实路径。
- [x] AC2 若确认热点：实现一个最小改动并复测同一场景；记录 before/after 的 commit/render/TaskDuration，证明有可重复改善；不得无测量地拆分 `useChatSessionState`。
  - 条件判定：未确认「可由一个最小改动带来可重复改善」的热点（P 不成立），故本条不适用。
  - 实测过的最小改动（`StreamingMarkdown` 外层加 `memo`，一行边界）复测：`TaskDuration=1623ms`，落在 baseline 的 1621–1873ms 区间内；`Markdown` self 反而 1183ms（baseline 956–1046ms）。无可重复改善，已 `git checkout` 回退，未保留代码改动。
- [x] AC3 若未确认热点：在 Evidence 记录“无显著热点，保持原样”的读数并关闭；允许 no-change，不得为了改而改。
  - 结论：成本分散在「streaming markdown 重解析」与「shell/侧栏每 flush 重渲染」两处，最大单项 self 约 1.0s / 20.4s（≈5% 单核），worst commit 15–25ms；不存在单点、低风险、可证明改善的改动。按 AC3 保持原样（详见 Evidence）。
- [x] AC4 既有判据：chat/transcript/composer 相关测试、`npm run typecheck`、`npm run lint`、架构棘轮 exit 0；不改变消息、发送、流式、滚动、输入法行为。
  - `npm run lint` exit 0（仅既有 warning）；`npm run typecheck` exit 0（三个 tsc 全部通过）；`server/shared/tests/architecture-ratchet.test.ts` 6 passed / 0 failed；`npx vitest run src/modules/chat src/modules/chat-session src/modules/chat-composer` → 169 files / 1509 passed / 1 skipped。
  - 零产品代码改动，消息/发送/流式/滚动/输入法行为不变。

## DoD

- 有真实 profile 读数与结论；只改确认的热点，或证据化地不改。
- 不盲目拆分大 hook/大组件，不把状态提升到更大的 context，不新增全局可变状态。
- 既有测试/typecheck/lint 全绿；Touches 一致。

## Touches

- src/modules/chat-session/hooks/useChatSessionState.ts
- src/modules/chat-session/hooks/useSessionStore.ts
- src/modules/chat-composer/composer/ChatComposer.tsx
- src/modules/chat/ChatInterface.tsx
- tasks/gap-chat-hot-path-render-profile.md

## Evidence

### 测量方法

- 临时 e2e harness（未提交，测量后删除）：在隔离的 Playwright data dir 启动真实后端 + Vite dev client，debug-agent 场景时钟写 120 条历史 row（t=0..600ms），再以 `text-delta` 在 t=12s..20s 每 100ms 写一段流式文本；浏览器 `page.goto('/session/<id>')` 后保持尾部跟随。
- React 读数来自 React DOM dev build 的 DevTools commit hook（`__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`）：commit 数、每个 component 的 `PerformedWork`（React 自己的「本组件真的渲染了」位）次数与 `actualDuration` self 时间。
- Performance 面板读数来自 CDP `Performance` domain 的 `TaskDuration`（窗口前后相减），以及 `longtask` PerformanceObserver（窗口内 0 条）。
- 窗口 = 120 条历史加载完成之后到流式 `delta-79` 落地并 settle 1.5s；窗口约 20.4–20.9s。

### Baseline 读数（无代码改动，8 次独立运行，区间）

- messages total = 122（>=100）；mountedRows = 19（transcript 只挂载尾段，符合 `INITIAL_MOUNTED_TAIL_ROWS`）。
- commits = 112–116（窗口内），全部 commit = 183–202。
- `TaskDuration` = 1621–1873 ms / ~20.4–20.9 s（≈8–9% 单核）。
- React 渲染总时长（root 子树 actualDuration 之和）= 456–555 ms；worst commit = 15.0–25.0 ms。
- 唯一有实质 self 时间的组件是 `Markdown`（react-markdown）：956–1046 ms / 窗口；`markdown.byChanged={"new":22,"same":1989,"changed":44}` → 2055 次渲染中 1989 次 children 文本未变，即同一批 markdown 文本被反复重新解析。
- 其余 top 组件 self 均在 100ms 以下：`LazyMessageRow`（100 个实例，每 flush 全部重渲染，self 51–65ms）、侧栏 `SidebarProjectItem`/`SidebarProjectActionsMenu*`/`ActionMenu`（17 个项目项，每 flush 重渲染，self 各 5–54ms）、`MessageCopyControl`（73–126ms）、`_c` 匿名组件（36–47ms）。
- 全体组件实例：`ChatInterface`=1、`ChatMessagesPane`=1、`ChatComposer`=1、`MessageComponent`=17、`LazyMessageRow`=100、`StreamingMarkdown`=10、`Markdown`(react-markdown)=17、`SidebarProjectItem`=17。
- 结构性结论：每个 ~100ms 的流式 flush 触发一次 ChatInterface 级 commit，重渲染整个已挂载 transcript（17 行）与侧栏项目列表（17 项 + 菜单），并重新解析 17 个 markdown block；这些成本分摊在多个组件上，单点 self 最高约 5% 单核。

### A/B 最小改动（已回退）

- 改动：`src/modules/chat/transcript/StreamingMarkdown.tsx` 外部包一层 `memo`（把「父行每 flush 重渲染 → 未变化的完成态回复也重新 split/请求 MarkdownBody」这一条 memo 边界补上）。
- 复测：`commits=116`、`TaskDuration=1623ms`、render total=461ms、worst commit=15.4ms；`Markdown` self=1183ms（比 baseline 更高）。`StreamingMarkdown` 自身渲染从 1141 降到 99，但 markdown 重解析没有下降 —— 说明 markdown 成本并非由这一层父重渲染驱动。
- 判定：无可重复改善（在 baseline 噪声区间内、时间读数略差），回退该改动；不为了改而改。

### 结论

- 热点是弥散的：streaming markdown 重解析（≈1.0s / 20.4s）与 shell/侧栏每 flush 重渲染（每项 self <60ms）叠加，不存在「一个低风险 memo/selector 就能带来可重复改善」的单点。
- 进一步压缩成本需要把会话状态下沉或做细粒度 selector/上下文切分（跨 `ChatInterface`/`Sidebar`/activity store），属于 AC2 明确禁止的「无测量拆大 hook」范围，本任务不做。
- 保持原样，结论与读数已记录在本 Evidence；临时 harness 已删除，工作树无产品代码改动。

### ADR-007 暗轴

该轴仍暗,理由:本任务只做前端渲染性能 profile，零代码结构变更，未产生 archguard 的 L_D/L_G 依赖图读数。
