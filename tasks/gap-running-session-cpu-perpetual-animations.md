---
id: gap-running-session-cpu-perpetual-animations
title: 显示运行中会话时 CPU 约 0.6 核：侧栏 backdrop-filter 与 Thinking shimmer 每帧重算
status: done
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


2026-11-21 在 MCP 浏览器打开正在运行的会话（app session `7126bf10-0087-4920-918d-c73d99377a13`，jsonl `dd4a4c0a-de57-42ff-a886-2e86f36617bb`）实测：浏览器进程合计 **55–60% of one core**（renderer 20–27%，GPU 31–36%，主线程 `TaskDuration` 12–14%，`RecalcStyle` ≈60 次/秒）；同页注入 `animation:none` 后 **1.1–1.7%**；未打开会话的 fleet overview 为 **1.4%**。逐项 A/B（6–10s 窗口，同一 running 页）：只关 `.animate-spin` 57.7%→16.1%；只关 `.animate-shimmer` 57.7%→40.5%；只关 `.animate-pulse` 53.5%（噪声级）；去掉侧栏 `backdrop-filter` 60%→36.8%（GPU 35.8%→3.3%）；去背景模糊 + shimmer 静态（spinner 仍旋转）13.9%。服务端 `dist-server` 进程仅 5.9%，成本在浏览器侧。

两处根因（代码核实）：

1. `src/modules/sidebar/SidebarContent.tsx:218` 的 `bg-background/80 backdrop-blur-sm` 是整棵侧栏内容的祖先。运行中会话行有两只 `Loader2 animate-spin`（`src/modules/sidebar/SidebarSessionItem.tsx:235`、`src/modules/sidebar/ResidentMark.tsx:70`）；动画后代让 `backdrop-filter` 每帧失效，GPU 进程反复重算整块侧栏的模糊。后续实测补充：把 filter 移到空的独立层仍会被同级 spinner 的帧变化触发（GPU 仍 ~30%），所以有运行中会话时必须关闭模糊，而不只是搬家。
2. `src/shared/ui/Shimmer.tsx` 的 `animate-shimmer` 使用 `tailwind.config.js` 的 `shimmer` keyframes 动画 `background-position`，并与 `bg-clip-text`/`text-transparent` 组合；每帧触发 style recalc（≈60 次/秒）和文字重绘。`Shimmer` 被 `ActivityIndicator`（`Thinking…`）、`Reasoning`、`PlanDisplay` 使用。

`Thinking…` 从 turn 开始一直显示到 turn 结束（本次实测 17m+），因此这不是流式 token 的瞬时成本，而是整个运行期的持续成本。本任务只修这两项；侧栏 spinner 的数量、形状与语义，以及其它动画都不动。

## AC

- [x] AC1 侧栏模糊层与动画分离：新增 `src/modules/sidebar/tests/sidebarBackdropLayer.test.tsx`，命令 `bash scripts/with-memory-cap.sh npx vitest run src/modules/sidebar/tests/sidebarBackdropLayer.test.tsx --maxWorkers=1` 退出 0；两个状态都先打印读数再断言：运行中 `runningBlur=false blurLayerChildren=0 blurAnimatedDescendants=0 backdropBlurOnRoot=false`，空闲 `idleBlur=true blurLayerChildren=0 blurAnimatedDescendants=0 backdropBlurOnRoot=false`。红态：未修实现上 root 仍带 `backdrop-blur-sm` 且 `[data-sidebar-backdrop]` 不存在。
- [x] AC2 Shimmer 只做 opacity 动画：新增 `src/shared/ui/tests/Shimmer.test.tsx`，命令 `bash scripts/with-memory-cap.sh npx vitest run src/shared/ui/tests/Shimmer.test.tsx --maxWorkers=1` 退出 0；用例先打印 `animation=opacity-pulse hasBackgroundPosition=false hasClipText=false` 再断言。红态：未修实现上红在仍带 `animate-shimmer`/`bg-clip-text`。
- [x] AC3 既有渲染契约不回退：`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/activityDockPhaseTruthful.test.tsx src/modules/sidebar/tests/sidebarResize.test.ts src/modules/sidebar/tests/sidebarBackdropLayer.test.tsx src/shared/ui/tests/Shimmer.test.tsx --maxWorkers=1` 退出 0（4 files / 17 tests）；`npm run typecheck` 与 `npm run lint` 退出 0；架构棘轮 `server/shared/tests/architecture-ratchet.test.ts` 6/6 通过。
- [x] AC4 实测 CPU：修复后在工作树 production build（`npm run build:client`，静态+代理服务 `127.0.0.1:5195 -> 3001`）打开同一运行中会话，5 次 10s CDP 窗口（页级 `Performance.getMetrics` + 浏览器级 `SystemInfo.getProcessInfo` 按 type 求和）的中位数满足：总 CPU ≤ 20% of one core、主线程 `TaskDuration` ≤ 5%、且「动画开 − 注入 `animation:none`」差值 ≤ 15 个百分点；全部原始窗口（含一次 20.6% 的冷首窗）与修复前对照都写入 Evidence。
- [x] AC5 真实页面证据：MCP 浏览器打开 worktree production build 上的运行中会话，DOM 读数 `[data-sidebar-backdrop]` 存在、`childElementCount=0`、`.animate-shimmer` 数量为 0、层上无 `backdrop-blur`；截图 `tmp/running-session-cpu-fixed.png`（修复前对照 `tmp/cpu-running-session-03.png`）写入 Evidence。

## DoD

- 侧栏毛玻璃变成独立空背景层（`absolute -z-10` + root `isolate`），该层不含任何动画后代；根节点不再直接挂 `backdrop-blur-sm`。有运行中会话时不挂 `backdrop-filter`（否则同级 spinner 的帧变化仍会让 GPU 重算模糊），空闲时保留毛玻璃。
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

## Evidence

实现 commit `e4764d062`（worktree `task/gap-running-session-cpu-perpetual-animations`，基于 develop `1d3412630`）。改动：`SidebarContent.tsx` 把 `bg-background/80 backdrop-blur-sm` 从 root 移到 `[data-sidebar-backdrop]` 空层（root 加 `isolate`），且 `runningSessionsCount > 0` 时不挂 `backdrop-blur-sm`；`Shimmer.tsx` 改为 `inline-block motion-safe:animate-pulse`；`tailwind.config.js` 删除未再使用的 `shimmer` keyframes/animation。

### AC1 — 侧栏模糊层（绿）

```
cd <worktree> && bash scripts/with-memory-cap.sh npx vitest run src/modules/sidebar/tests/sidebarBackdropLayer.test.tsx --maxWorkers=1
```

```
runningBlur=false blurLayerChildren=0 blurAnimatedDescendants=0 backdropBlurOnRoot=false
idleBlur=true blurLayerChildren=0 blurAnimatedDescendants=0 backdropBlurOnRoot=false
Test Files  1 passed (1) / Tests  2 passed (2)
```

红态（未修实现）：root 直接带 `backdrop-blur-sm`，`[data-sidebar-backdrop]` 不存在，`backdropBlurOnRoot=true`。测试同时断言 layer 是 panel 的直接子节点（不是内容 wrapper），否则动画行会重新落回 filter 子树。

### AC2 — Shimmer（绿）

```
cd <worktree> && bash scripts/with-memory-cap.sh npx vitest run src/shared/ui/tests/Shimmer.test.tsx --maxWorkers=1
```

```
animation=opacity-pulse hasBackgroundPosition=false hasClipText=false
Test Files  1 passed (1) / Tests  1 passed (1)
```

红态（未修实现）：`animate-shimmer` + `bg-clip-text` + `text-transparent` 仍在，读数 `animation=other hasBackgroundPosition=true hasClipText=true`，断言在 `hasBackgroundPosition` 失败。

### AC3 — 既有判据 / typecheck / lint / 棘轮（绿）

```
npx vitest run src/modules/chat/tests/activityDockPhaseTruthful.test.tsx src/modules/sidebar/tests/sidebarResize.test.ts src/modules/sidebar/tests/sidebarBackdropLayer.test.tsx src/shared/ui/tests/Shimmer.test.tsx --maxWorkers=1
→ Test Files 4 passed (4) / Tests 17 passed (17)

npm run typecheck → exit 0（tsconfig + server/tsconfig + scripts/tsconfig 全部 0）
npm run lint → exit 0（仅既有 warning，无 error）
npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/architecture-ratchet.test.ts → 6 pass / 0 fail
```

### AC4 — CPU 实测（绿，median 口径）

方法（与修复前完全相同）：MCP 浏览器打开运行中会话；页级 CDP `Performance.getMetrics`（`TaskDuration` / `ScriptDuration` / `RecalcStyleCount`），浏览器级 CDP `SystemInfo.getProcessInfo` 按 `type` 求和（renderer / GPU / browser / network / storage），10s 窗口；随后注入 `*,*::before,*::after{animation:none!important;transition:none!important}` 再测 10s 得到「动画关」基线。全部读数原始记录如下。

修复前（production `:3001`，同一 running 会话，2026-11-21 15:43–15:49 本地）：

| 窗口 | total | renderer | GPU | main Task | recalc |
|---|---:|---:|---:|---:|---:|
| baseline-1 | 57.7% | 26.3% | 31.1% | 14.4% | 356/6s |
| baseline-2 | 60.0% | 23.7% | 35.8% | 14.0% | — |
| baseline-3 | 55.3% | 20.4% | 34.7% | 12.5% | 484/8s |
| animations-off | 1.5% | 1.2% | 0.0% | 1.0% | 0 |

修复后（worktree production build `:5195`，同一 running 会话，2026-11-21 16:13–16:14 本地；`runningBadge=1`，页面动画 `spin:2 pulse:3 chat-activity-enter:1`，无 `shimmer`）：

| 窗口 | total | renderer | GPU | main Task | recalc | 动画关 total | delta |
|---|---:|---:|---:|---:|---:|---:|---:|
| on-1（冷首窗） | 20.6% | 11.6% | 8.7% | 4.1% | 133/10s | 4.6% | 16.0 |
| on-2 | 13.1% | 4.1% | 8.8% | 1.7% | 54/10s | 4.6% | 8.5 |
| on-3 | 14.7% | 6.0% | 8.3% | 2.8% | 55/10s | 9.1% | 5.6 |
| on-4 | 18.2% | 9.8% | 8.2% | 3.8% | 56/10s | 4.7% | 13.5 |
| on-5 | 12.4% | 4.0% | 8.2% | 1.6% | 64/10s | 6.6% | 5.8 |

中位数：**total 14.7%**、**main TaskDuration 2.8%**、**delta 8.5 个百分点**；5 个窗口的 main 全部 ≤ 4.1%。冷首窗 total 20.6% / delta 16.0 略超阈值，归因于首窗 `RecalcStyle` 133 次与共享宿主负载（128 vCPU，同时有 suite/agent 进程），不是动画机制回退；其余 4 窗全部通过。主线程 recalc 从修复前 ≈60 次/秒降到 5.4–13.3 次/秒。

残余（本任务范围外，如实记录）：侧栏两只 `Loader2 animate-spin` 仍在转，GPU 进程 ≈8.2–8.8% 基本由它们贡献；本任务不动 spinner 的数量/形状/语义，后续若需要可再开任务把 spinner 改为 opacity 式指示。

### AC5 — 真实页面（绿）

worktree production build（`npm run build:client`，静态+代理 `127.0.0.1:5195 -> 3001`）打开同一 running 会话：

```
layerClass="pointer-events-none absolute inset-0 -z-10 bg-background/80"
layerChildren=0  layerDirect=true  shimmerCount=0
animations={spin:2, pulse:3, chat-activity-enter:1}
runningBadge="1"  title="运行中会话列表 CPU 占用高"  Thinking · 17m 14s
```

截图：`tmp/running-session-cpu-fixed.png`（修复后）；`tmp/cpu-running-session-03.png`（修复前，含 `Thinking…` shimmer 与 `backdrop-blur-sm`）。验证用的 dev server、静态代理与一次性 JWT 端点均为临时进程，收尾停止；浏览器 localStorage 中临时 `auth-token` 已删除。

### 上线后复核（2026-11-21 16:40–16:43 本地）

`npm run build:client` 在 `develop`（build-info gitSha `3bf560cb8`）完成后，线上 `:3001` 的 `index.html` 指向 `assets/index-JDsoKD9U.js`；该 bundle 内 `data-sidebar-backdrop` 命中 1 次、`animate-shimmer` 命中 0 次、`motion-safe:animate-pulse` 命中 2 次。无需重启 `dist-server`，静态资源按请求从 `dist/` 读取。

MCP 浏览器在线上 `:3001` 打开同一 running 会话复核：`layerClass="pointer-events-none absolute inset-0 -z-10 bg-background/80"`、`layerChildren=0`、`shimmerCount=0`、`spinCount=2`（spinner 按约定保持不动）、`runningBadge=1`。

上线后 10 个 10s 窗口（分两批，同一 CDP 测法）：

| # | on total | main Task | GPU | off total | delta |
|---|---:|---:|---:|---:|---:|
| 1 | 30.0% | 6.3% | 12.9% | 5.4% | 24.6 |
| 2 | 23.1% | 4.9% | 9.7% | 3.2% | 19.9 |
| 3 | 20.3% | 4.4% | 7.5% | 8.3% | 12.0 |
| 4 | 16.5% | 2.8% | 8.5% | 5.7% | 10.8 |
| 5 | 16.3% | 2.7% | 8.6% | 10.1% | 6.2 |
| 6 | 26.4% | 8.6% | 9.5% | 5.7% | 20.7 |
| 7 | 18.5% | 3.0% | 9.7% | 9.1% | 9.4 |
| 8 | 24.7% | 6.3% | 9.5% | 6.2% | 18.5 |
| 9 | 17.7% | 3.0% | 9.1% | 5.5% | 12.2 |
| 10 | 16.3% | 2.8% | 8.3% | 4.1% | 12.2 |

中位数：**total 19.4%**、**main TaskDuration 3.7%**、**GPU 9.3%**、**delta 12.2 点**。上线前同机同会话是 55–60% total / 12–14% main / GPU 31–36%；残余 GPU 仍由两只未改动的 `Loader2 animate-spin` 贡献。线上读数比 worktree 隔离构建（median total 14.7%）高约 5 点，归因于线上同时有其它会话/fleet 活动；仍低于 AC4 的 20% 上限。
