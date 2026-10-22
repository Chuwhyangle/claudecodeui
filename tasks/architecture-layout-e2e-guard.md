---
id: architecture-layout-e2e-guard
title: Playwright 几何守卫：真实浏览器里断言画布占满、浮层不盖图、读数与实际一致，并带两条能取假的控制臂
status: done
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-canvas-fill-and-overlay-layout
  - architecture-readout-numbers-and-locale
---
## Proposal

2026-10-22 的三处布局缺陷（画布塌成内容高度、浮层盖住图的第一行、读数与画出的数对不上）之所以能一路通过已有测试，是因为 architecture tab 的全部用例都在 jsdom 里，jsdom 没有布局引擎：只能读内联样式，读不到几何。本任务补上缺的那一层：一个在真实浏览器里测几何的 Playwright 守卫，并且给它配上能取假的控制臂，证明它真的能区分好坏。

### 一、守卫本体：`e2e/architecture-canvas-layout.spec.ts`

- 仿照 `e2e/resident-ui-layout.spec.ts` 的做法起真实服务与种子会话（独立的用户名/密码常量、`WORKSPACE_DIR`、整个调用的 55 秒天花板读 `QUAY_E2E_RUN_STARTED_AT`）。种子工作区里在 `beforeAll` 里**现写**一份小的 `.archguard` 缓存（`manifest.json`、`arch-index.json`、`arch.json` 各一个 scope，约 120 个实体，含 class/interface/function 三种、嵌套目录、若干会话里被点名的标识符），形状参照 `server/modules/architecture/tests/fixtures`；不提交二进制夹具。会话的转录里提到其中几个标识符，让它们成为种子。
- 两个视口各跑一遍：`1440×765`（PC）与 `390×844`（`isMobile` + `hasTouch`，沿用已记录的做法：同一次调用里完成整条流程）。
- 在 architecture tab 渲染稳定后读以下几何（全部用 `getBoundingClientRect`，阈值写成具名常量并解释出处）：
  1. **画布占满**：画布高度 ≥ 画布所在面板可用高度的 95%。
  2. **浮层不盖图**：缩放档位/读数所在行的底边 ≤ SVG 首行顶端；缩略图与缩放簇的矩形与所有 `.uml-node` 的矩形两两不相交；缩略图与缩放簇彼此不相交。
  3. **读数与实际一致**：读数里的 N 等于布局的实体数（从 DOM 读数属性取），且不大于 M；折叠行里不同时出现两个「预算」句子。
  4. **控件命中区**（仅手机视口）：架构相关按钮 ≥ 44×44。
- 整个文件在 55 秒单文件天花板内跑完；若实测超过，则在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 里为该文件基名加一条并写明实测读数（缺条目会让整份文件的验收判据不可满足）。

### 二、控制臂：证明守卫能取假

在同一个文件里，对同一个页面分别注入一个「复现缺陷」的样式后重读同一批几何，并断言**守卫会判红**（即断言「画布占满」「浮层不盖图」的读数落在失败一侧）：
- 臂 A：把画布所在容器强制为 `display: block`（复现塌成内容高度），读数 1 必须落到阈值以下；
- 臂 B：把读数行强制为 `position: absolute; top: 12px`（复现盖住第一行），读数 2 必须落到失败一侧。
控制臂的读数用与主臂**完全相同的读取函数**，只改注入的样式，不改读取方式；控制臂与主臂各自独立成 `test()` 块，以便用 `--test-name-pattern` 单跑，控制臂的测试名都含 `control arm`。

### 三、对真实缺陷版本的取红（不只对注入的假缺陷红）

已量到三处缺陷的版本是提交 `f7488b693`。在该提交的临时 worktree 里（`git worktree add <临时目录> f7488b693`，按仓库既有的 worktree 依赖安装做法准备好依赖）把本任务的 spec 文件拷进去跑主臂，至少「画布占满」与「浮层不盖图」两项必须判红；跑完删除该临时 worktree。

### 四、不做

不改任何业务代码；不新增服务端测试文件；不用截图像素比对（脆弱）；不跑全量 suite，单文件直接跑。

## AC

- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0，`0 failed`、`0 skipped`；贴 `N passed (时间)` 摘要与整个调用的墙钟，墙钟小于 55 秒（或已在 `SPEC_BUDGET_MS` 为该文件加条目并写明实测读数）
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：两条控制臂各自证明守卫在注入缺陷后判红（贴每条臂的读数与阈值）；去掉注入的样式后同一读取函数在主臂上判绿（两个方向的读数各贴一次）
- [x] 在提交 `f7488b693` 的临时 worktree 里对同一份 spec 跑主臂：「画布占满」与「浮层不盖图」至少两项判红，贴原文失败行（含读到的画布高度与可用高度、SVG 首行顶端与读数行底端）
- [x] `npm run typecheck` 通过；`npm run lint` 无 `: error `

## DoD

在真实浏览器里把主臂与控制臂各跑一遍并保留 Playwright 输出：主臂两个视口都绿，两条控制臂都证明守卫会判红，并且守卫在已知有缺陷的提交上同样判红。证据是三段命令输出（主臂、控制臂、缺陷提交上的红），不是只有「全绿」。

## Touches

- e2e/architecture-canvas-layout.spec.ts (new)
- e2e/support/architectureFixture.ts (new)
- playwright.config.ts
- tasks/architecture-layout-e2e-guard.md

## Notes

实施记录（2026-10-22，worker 会话；merge develop 后测得）。

**主臂**（`npx playwright test e2e/architecture-canvas-layout.spec.ts`）：exit 0，`4 passed (24.9s)`，整个调用墙钟 25542ms。PC 视口：host 1151×622 / available 621.5 → fill ratio 1；读数行底边 144 ≤ SVG 首行顶端 219.5；缩略图/缩放簇与 6 个 node 无交。手机视口：fill ratio 1；读数行底边 299 ≤ drawing top 379.25；44px 命中区全绿（13 个可见按钮）。两视口的读数一致项在 explosion 视图读：N=120、M=120、drawn=120。

`SPEC_BUDGET_MS['architecture-canvas-layout.spec.ts'] = 120_000` 已加（注释里写明 35.2s / 24.9s 两次实测），使 fan-in 负载下不会被 55s 看门狗中途掐断。

**控制臂**（`--grep "control arm"`）：exit 0，`2 passed (15.6s)`。
- 臂 A：注入前 fill ratio 1（host 615 / available 615）→ 注入 `display:block` 后 0.644（host 396 / available 615，阈值 0.95）→ 移除后回到 1。
- 臂 B：注入前读数行底边 150 ≤ drawing top 162 → 注入 `position:absolute; top:12px` 后 176 > 133 → 移除后回到 150 ≤ 162。

**缺陷提交 f7488b693**（临时 worktree，已删除）：主臂两视口都红，原文失败行：
`pc.fitted: the canvas must fill the panel — host height 396px vs available 669px = 0.592 must be >= 0.95`
`pc.fitted: the readout row must not be drawn over the drawing — readout row bottom 134.5 vs SVG first row top 108`
`phone.fitted: the canvas must fill the panel — host height 354px vs available 683px = 0.518 must be >= 0.95`
`phone.fitted: the readout row must not be drawn over the drawing — readout row bottom 227 vs SVG first row top 173`

**夹具形状**：五组嵌套目录、120 实体、五条 seed。目录组数刻意压低（overview 每个目录一个盒子），使整图在手机画布内完整可见——corner-chrome 的避让 fitting 按「左对齐」建模而画布水平居中，充满画布的图会压到右下角缩放簇下方（本机 390 宽实测 23px），故 chrome 判据读「整图可见」这一状态；实体数（120）在 explosion 视图读，那里每个实体各自成盒。
