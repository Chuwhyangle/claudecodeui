---
id: gap-quay-tab-window-switch-unmounts-the-whole-panel
title: Quay tab 切 1h/3h/6h/12h 会把整个面板连同选择器自身卸载：250ms 内按钮消失、再点落空，大库 3–4s
  才回来；gantt 读数一失败选择器就彻底消失只剩刷新页面——改为只重取甘特图读数并按窗口缓存
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

切换 Quay tab 的 1h/3h/6h/12h 时，**整个面板连同选择器自身会被卸载**，用户在数据回来之前无法再点任何窗口——实测（2026-10-11，真实后端 + MCP 浏览器）：

| 时刻 | 读数 |
|---|---|
| 点击前 | 选择器在，`3h` 选中 |
| 点 `12h` 后 +250ms | `[data-testid="quay-gantt-windows"]` **不存在**、`quay-panel-loading` 占据整块；此刻 `quay-gantt-window-1` 也不存在（第二次点击必然落空） |
| 稳定后 | `/data/home/yale/work/claudecodeui` 661–797ms 回来；`/data/home/yale/work/quay`（大库）**3009–3949ms** 才回来 |

根因链（三处叠加）：

1. `src/modules/quay/hooks/useQuayStatus.ts` 的 `load()` 对**每一次**取数都 `setFetchedView({ status: 'loading' })`，窗口变化走的也是这条路径 ⇒ `QuayPanel` 渲染 loading 分支而不是面板。
2. 1h/3h/6h/12h 选择器长在 `LoopPulseGantt` 内部，且只有 `gantt` 非 null 时才渲染 ⇒ 面板一卸载，控制器就跟着消失；更糟的是**只要那次 `lanes` 读数失败**（`gantt: null`），选择器就彻底不在，用户只剩「刷新页面」一条退路——这正是报告里「切换时需要刷新页面」的字面来源。
3. 窗口变化走的是整份 `collectSnapshot`（`task list` / `goal list` / `adr list` / `driver status` / `config validate` / `lanes` 六条 quay CLI + 进程内工作），而且**非默认窗口从不进缓存**（`quay.service.ts` 的 `loadSnapshot`/`getQuaySnapshot` 只对 `DEFAULT_QUAY_GANTT_WINDOW_HOURS` 读写缓存）⇒ 每次点窗口都付一次冷读全价，大库 3–4 秒。窗口本身也不落在 URL / localStorage，刷新页面就回到默认 3h。

本任务把窗口还原成它本来的语义 —— **甘特图卡片自己的数据过滤**：窗口变化只重取甘特图读数（其余卡片沿用已加载内容），按 `(projectId, windowHours)` 缓存；面板与选择器在取数期间保持挂载并给出局部忙碌态；窗口持久化到 URL；`gantt` 不可用时选择器仍在（禁用）并显示**可区分**的原因——三种状态不得再共用一句话：插件没有 `lanes` 动词 / `lanes` 读失败 / 该窗口内确实没有区间（后者是正常空态，不是不可用）。

## AC

- [x] AC1 窗口变化不卸载面板、选择器始终挂着：`src/modules/quay/tests/QuayPanel.test.tsx` 新增用例 —— 触发窗口变化后，在整个取数过程中 `[data-testid="quay-gantt-windows"]` 始终存在、`[data-testid="quay-panel-loaded"]` 不被替换成 `[data-testid="quay-panel-loading"]`，且此期间点击另一个窗口按钮能被接收（`onWindowChange` 被调用）。取假：把窗口变化路径改回 `setFetchedView({ status: 'loading' })`，该用例必须红。
- [x] AC2 窗口变化只重取甘特图读数、并按窗口缓存：`server/modules/quay/tests/quay.service.test.ts` 新增用例 —— 用注入的 `runCommand` 记录 argv：第二个不同窗口的请求不得再 spawn `task list` / `goal list` / `adr list` / `driver status` / `config validate`，只允许 `lanes` 一族；同一 `(projectId, windowHours)` 的重复请求命中缓存（`cached: true`，且不再 spawn 任何 lanes）。取假：删掉按窗口的缓存键（回到「每次冷读」），该用例必须红。
- [x] AC3 `gantt` 不可用时选择器仍可用，且不可用的原因可区分：`src/modules/quay/tests/LoopPulseGantt.test.tsx` 与 `QuayPanel.test.tsx` 断言 —— (a) `gantt: null` 时 `[data-testid="quay-gantt-windows"]` 仍渲染、四个窗口按钮 `disabled`，并渲染 `[data-testid="quay-gantt-unavailable-reason"]`；(b) 两种不同的不可用来源（`lanes` 命令读失败 / 该插件没有 `lanes` 动词）渲染出的原因文案**不相同**且各自非空；(c) 「窗口内无区间」（空车道集）**不**渲染该原因，仍渲染 `[data-testid="quay-gantt-empty"]`。取假：把选择器移回 `gantt &&` 分支内，或把三种情况写成同一句常量文案，该用例必须红。
- [x] AC4 窗口持久化：窗口选择写入 URL query（键名 `quayWindow`）或 localStorage；前端测试断言设置后读回同一值，且非枚举值（如 `5`）回落到默认 3h；浏览器读数：刷新页面后仍是所选窗口（不得回落到 3h）。
- [x] AC5 窄测试与类型：`npm run typecheck` exit 0；`src/modules/quay/tests/QuayPanel.test.tsx`、`src/modules/quay/tests/LoopPulseGantt.test.tsx`、`server/modules/quay/tests/quay.service.test.ts` 全绿（窄跑，不起无界扇出）。

## DoD

真实对象过机制：在真实后端 + 真实浏览器（MCP 浏览器）上，对**大库项目** `/data/home/yale/work/quay` 连续点 1h/3h/6h/12h —— 每次点击后 250ms 选择器仍在且可继续点击（元素不消失、点击不被丢弃），稳定后轴窗口读数与所选一致，且单次切换的墙钟不高于修前读数（修前 3.0–3.9s，目标为只重取甘特图读数后的实测值，记入 `## 验证记录`）。刷新页面后窗口保持所选值。对至少两个「读数不可用」的真实项目各取一次读数（例如插件停在 0.17.0、既无 kernel 也无 `lanes` 动词的 `/data/home/yale/work/archguard`），选择器仍在、四个按钮禁用、页面显示原因文案且**两个项目的文案可区分**，**无需刷新页面**。读数与截图记入本任务 `## 验证记录`。

## Touches

- src/modules/quay/hooks/useQuayStatus.ts（窗口取数不再进整面板 loading；窗口持久化与回落）
- src/modules/quay/QuayPanel.tsx（窗口变化时面板与选择器保持挂载；不可用原因文案）
- src/modules/quay/LoopPulseGantt.tsx（选择器在 gantt 不可用时仍渲染，禁用态）
- src/modules/project-workspace/WorkspaceMain.tsx（把 hook 的 windowHours / ganttRefreshing 接到 QuayPanel，选择器按请求窗口即时高亮）
- src/modules/quay/tests/QuayPanel.test.tsx（挂载 / 不可用 / 持久化用例）
- src/modules/quay/tests/LoopPulseGantt.test.tsx（选择器禁用态与原因区分用例）
- src/shared/api.ts（窗口参数随请求传递）
- src/shared/types.ts（不可用原因字段的契约）
- server/modules/quay/quay.routes.ts（窗口查询参数解析）
- server/modules/quay/quay.service.ts（按 projectId 与 windowHours 的读数缓存；不可用原因的分类）
- server/modules/quay/tests/quay.service.test.ts（只重取甘特图 + 按窗口缓存 + 原因分类的用例）
- tasks/gap-quay-tab-window-switch-unmounts-the-whole-panel.md

## 验证记录

真实后端 + 真实浏览器（Playwright chromium）跑在隔离端口 3901：后端由本工作树 `server/index.ts` 起（`SERVER_PORT=3901 HOST=127.0.0.1 DATABASE_PATH=<scratch>/auth.db HOME=/data/home/yale CLAUDE_SESSION_SCOPE_SWEEP=off`），客户端用本工作树 `vite build` 产出的 `dist/`，由该后端静态托管（`dist/` 已 gitignore，未污染工作树）。每次冷读数前重启后端，清空进程内缓存。DoD 脚本与读数落在会话 scratch 目录 `/data/home/yale/.cache/quay-dod-qws/`（`dod.mjs`、`dod1b.mjs`、`readings-*.json`、`shots/`），不在工作树内。

### 大库项目 `/data/home/yale/work/quay`（tasks 总数 2685）连续点 1h/3h/6h/12h

`readings-1_2_3.json`，截图 `shots/p1-00-initial.png`、`shots/p1-switch-{1,3,6,12}h.png`：

| 点击 | 单次墙钟 | 250ms 时选择器 | 250ms 时 `aria-pressed` | 稳定后 | 该次读 |
|---|---|---|---|---|---|
| 1h | 1346ms | 在，4 键全可用 | `1`（已即时翻转） | `1` | `cached:false` |
| 3h | 489ms | 在，4 键全可用 | `3` | `3` | `cached:true` |
| 6h | 1364ms | 在，4 键全可用 | `6` | `6` | `cached:false` |
| 12h | 1379ms | 在，4 键全可用 | `12` | `12` | `cached:false` |

修前单次切换 3.0–3.9s（整份 `collectSnapshot` 六条 quay CLI 冷读）；修后 1.35–1.38s，全部 ≤ 3.0s（3h 为 `cached:true` 的缓存命中）。四次点击的 250ms 探针一致：`quay-panel-loaded` 仍在、`quay-panel-loading` 未出现、`quay-gantt-windows` 在、四个窗口键均 `!disabled`。

### 取数途中第二次点击不被丢弃（冷缓存）

`readings-1b-instrumented.json`（冷缓存：点 12h，250ms 时点 1h）：

- `+46ms`（点 12h 后）：`aria-pressed=12`、`refreshing=true`、4 键可用；
- `+300ms`：选择器仍在、仍按 12、`refreshing=true`；
- `+345ms`（点 1h，即取数途中的第二次点击）：`aria-pressed` 立即翻到 `1`、`refreshing=true`——点击被接收，未落空；
- 稳定：`aria-pressed=1`、`refreshing=false`；
- 网络：两次点击各发一读（`reqs`：12h @+45ms、1h @+345ms），两读都返回 200（`resps`：12h @+1235ms、1h @+1539ms）；被取代的 12h 回复由请求 id 守卫丢弃，最终停在 1h。

### 刷新页面保持所选窗口

`readings-1b_1c.json`，截图 `shots/p1c-after-reload.png`：点 12h 后 URL = `http://127.0.0.1:3901/?quayWindow=12`；`page.reload()` 后重开同一项目，选择器在、`aria-pressed=12`（未回落到 3h）。

### 两个「读数不可用」的真实项目：文案可区分、无需刷新

- `/data/home/yale/work/archguard`（插件停在没有 `lanes` 动词的版本）：选择器在、4 键 `disabled`、无 gantt SVG，文案 = “Loop pulse unavailable — the installed quay plugin has no `lanes` verb (it predates the Loop pulse reading).”（`shots/p2-archguard.png`）
- `/data/home/yale/work/quay-fleet`（`lanes` 读失败）：选择器在、4 键 `disabled`、无 gantt SVG，文案 = “Loop pulse unavailable — the `lanes` read failed — quay did not return a usable lane document.”（`shots/p3-quay-fleet.png`）

两个项目的文案不相同、各自非空，且都无需刷新页面即可看到。

⚠️ 取证手法说明：`lanes-read-failed` 在本宿主上没有**天然**的真实项目——六个天然不可用项目全部落到 `plugin-lacks-lanes-verb`，畸形 `config.yml` 仍返回合法空车道集（exit 0）。故对 `quay-fleet` 做了一次**可逆诱导**取证：把 `.quay/plugin/bin/quay` 放成「文件存在但不可执行」，触发 `entrypoint-not-executable` ⇒ 服务端归类 `lanes-read-failed`。这是该分支的取证手段，不是产品状态；读数后已 `rm -rf` 诱导出的 `.quay/plugin` 目录，`git -C /data/home/yale/work/quay-fleet status --porcelain .quay` 无差异，原状恢复。

### 窄测试 / 类型 / 取假

- `npm run typecheck` exit 0。
- `vitest run src/modules/quay/tests/QuayPanel.test.tsx src/modules/quay/tests/LoopPulseGantt.test.tsx` → 38 passed。
- `tsx --test server/modules/quay/tests/quay.service.test.ts` → 29 pass / 1 skip（跳过项是「本机未装 quay 插件」的守卫）。
- 取假（三处变异均已复原，`git status --porcelain` 干净）：
  - AC1：把窗口变化路径的 `keepLoaded` 改回 `false`（等价改回 `setFetchedView({status:'loading'})`）⇒ `QuayPanel.test.tsx › a window change re-reads in place …` 红在 “the loaded panel must stay mounted”。
  - AC2：把甘特缓存键改成每次唯一（回到「每次冷读」）⇒ `quay.service.test.ts › a window change re-reads only the lanes verb, and a repeated (project, window) is served from cache` 红在 “a repeated (project, window) must spawn nothing”。
  - AC3：把选择器移回 `onWindowChange && gantt &&` 分支内 ⇒ `LoopPulseGantt.test.tsx › with no lane reading the selector stays mounted but inert …` 与 `QuayPanel.test.tsx › QuayPanel keeps the Loop pulse selector, disabled and with a reason …` 双双红。
