---
id: gap-running-session-cpu-perpetual-animations
title: 显示运行中会话时 CPU 约 0.6 核：侧栏 backdrop-filter 与 Thinking shimmer 每帧重算
status: todo
labels:
  - gap
  - defect
  - ui
parent: null
children: []
extra:
  schema: execution
depends_on: []
---
## Finding

**PARKED** 临时挂起：本任务由人类主会话在独立 worktree 实现并以 MCP 浏览器采集实测读数；实现与证据写回前不要派发 worker。解除时删除本行。

2026-11-21 在 MCP 浏览器打开正在运行的会话（app session `7126bf10-0087-4920-918d-c73d99377a13`，jsonl `dd4a4c0a-de57-42ff-a886-2e86f36617bb`）实测：浏览器进程合计 **55–60% of one core**（renderer 20–27%，GPU 31–36%，主线程 `TaskDuration` 12–14%，`RecalcStyle` ≈60 次/秒）；同页注入 `animation:none` 后 **1.1–1.7%**；未打开会话的 fleet overview 为 **1.4%**。逐项 A/B（6–10s 窗口，同一 running 页）：只关 `.animate-spin` 57.7%→16.1%；只关 `.animate-shimmer` 57.7%→40.5%；只关 `.animate-pulse` 53.5%（噪声级）；去掉侧栏 `backdrop-filter` 60%→36.8%（GPU 35.8%→3.3%）；去背景模糊 + shimmer 静态（spinner 仍旋转）13.9%。服务端 `dist-server` 进程仅 5.9%，成本在浏览器侧。

两处根因（代码核实）：

1. `src/modules/sidebar/SidebarContent.tsx:218` 的 `bg-background/80 backdrop-blur-sm` 是整棵侧栏内容的祖先。运行中会话行有两只 `Loader2 animate-spin`（`src/modules/sidebar/SidebarSessionItem.tsx:235`、`src/modules/sidebar/ResidentMark.tsx:70`）；动画后代让 `backdrop-filter` 每帧失效，GPU 进程反复重算整块侧栏的模糊。
2. `src/shared/ui/Shimmer.tsx` 的 `animate-shimmer` 使用 `tailwind.config.js` 的 `shimmer` keyframes 动画 `background-position`，并与 `bg-clip-text`/`text-transparent` 组合；每帧触发 style recalc（≈60 次/秒）和文字重绘。`Shimmer` 被 `ActivityIndicator`（`Thinking…`）、`Reasoning`、`PlanDisplay` 使用。

`Thinking…` 从 turn 开始一直显示到 turn 结束（本次实测 8m47s），因此这不是流式 token 的瞬时成本，而是整个运行期的持续成本。本任务只修这两项；侧栏 spinner 的数量、形状与语义，以及其它动画都不动。

## AC

- [ ] AC1 侧栏模糊层与动画分离：新增 `src/modules/sidebar/tests/sidebarBackdropLayer.test.tsx`，命令 `bash scripts/with-memory-cap.sh npx vitest run src/modules/sidebar/tests/sidebarBackdropLayer.test.tsx --maxWorkers=1` 退出 0；用例先打印 `blurLayerChildren=0 blurAnimatedDescendants=0 backdropBlurOnRoot=false` 再断言。红态：未修实现上同一用例红在 root 仍带 `backdrop-blur-sm` 或模糊层不存在。
- [ ] AC2 Shimmer 只做 opacity 动画：新增 `src/shared/ui/tests/Shimmer.test.tsx`，命令 `bash scripts/with-memory-cap.sh npx vitest run src/shared/ui/tests/Shimmer.test.tsx --maxWorkers=1` 退出 0；用例先打印 `animation=opacity-pulse hasBackgroundPosition=false hasClipText=false` 再断言。红态：未修实现上红在仍带 `animate-shimmer`/`bg-clip-text`。
- [ ] AC3 既有渲染契约不回退：`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/activityDockPhaseTruthful.test.tsx src/modules/sidebar/tests/sidebarResize.test.ts --maxWorkers=1` 退出 0；`npm run typecheck` 与 `npm run lint` 退出 0。
- [ ] AC4 实测 CPU：修复后在工作树 dev server（`SERVER_PORT=3001` 代理活实例）打开同一运行中会话，10s CDP 窗口（页级 `Performance.getMetrics` + 浏览器级 `SystemInfo.getProcessInfo` 按 type 求和）满足：总 CPU ≤ 20% of one core、主线程 `TaskDuration` ≤ 5%、且「动画开 − 注入 `animation:none`」差值 ≤ 15 个百分点。命令、逐项读数与修复前对照写入 Evidence。
- [ ] AC5 真实页面证据：MCP 浏览器打开 worktree dev server 上的运行中会话，DOM 读数显示 `[data-sidebar-backdrop]` 存在且 `childElementCount=0`、`.animate-shimmer` 数量为 0；截图存 `tmp/` 并贴路径与读数。

## DoD

- 侧栏毛玻璃变成独立空背景层（`absolute -z-10` + root `isolate`），该层不含任何动画后代；根节点不再直接挂 `backdrop-blur-sm`。
- `Shimmer` 只用 opacity 类的 pulse 动画，不再有 `background-position`、`bg-clip-text`、`text-transparent`；`Reasoning`、`PlanDisplay`、`ActivityIndicator` 的调用点与文本不变。
- 不新增非测试源文件；不新增模块级可变状态；`SidebarContent.tsx` 行数仍在 800 行棘轮以内。
- 修复前后用同一套 CDP 测法留下读数；测量方法写进 Evidence，后续可用同一命令复测。
- 既有 sidebar/chat 判据、typecheck、lint 全绿；Touches 与实际改动一致。

## Touches

- src/modules/sidebar/SidebarContent.tsx
- src/shared/ui/Shimmer.tsx
- tailwind.config.js
- src/shared/ui/tests/Shimmer.test.tsx (new)
- src/modules/sidebar/tests/sidebarBackdropLayer.test.tsx (new)
- tasks/gap-running-session-cpu-perpetual-animations.md
