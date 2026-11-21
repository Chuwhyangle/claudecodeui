---
id: gap-running-spinner-60fps-after-layer-fix
title: 层数降到 21 后复评 60fps spinner：在 15Hz 成本包络内换回平滑旋转
status: done
labels:
  - gap
  - feature
  - ui
  - performance
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-sidebar-collapsed-project-sticky-layer-explosion
---
## Finding

上一轮已把侧栏 spinner 从 60Hz 降到 15Hz steps：用户接受，线上 5×10s 中位 **total 14.7% / GPU 4.5%**（5Hz 9.2/3.1；60Hz 20.4/9.5）。层审计显示 60Hz 的高成本主要来自 **172 层**（154 个 276x52 的 sticky 项目行），spinner 自身只有 2 层。把收起项目的 sticky 去掉后层数 **172→21**（mutation 实测）。

层数下降后，60fps 的每帧成本可能回到可接受范围。本任务在 `gap-sidebar-collapsed-project-sticky-layer-explosion` 完成后复测 15Hz SVG、60fps SVG、60fps wrapper（动画在外层 span，SVG 静止）三种方案，目标是在 15Hz 的成本包络内换回更平滑的旋转；如果 60fps 仍超预算，保留 15Hz 并留下证据，不得为了平滑无条件加成本。

## AC

- [x] AC1 复测矩阵：依赖任务完成、层数 ≤30 后，对同一 running 会话跑 5×10s CDP：15Hz SVG、60fps SVG、60fps wrapper。记录 total/main/GPU 中位与原始窗口到 Evidence；先打印三行读数再选方案。
- [x] AC2 选择与实现：选择 total ≤ 15Hz + 2 点且 GPU ≤ 15Hz + 1 点的最平滑方案；如果 60fps 仍超出包络，保留 15Hz 并在 Evidence 记录原因。实现时保持 spinner 数量/图标/语义；wrapper 方案保留 `currentColor` 与尺寸。
- [x] AC3 可见旋转与判据：选中的方案在真实页面仍有多个不同帧（元素截图）；CSS/组件测试 pin 住实际 timing（若 60fps 则无 steps，若保留 15Hz 则 steps(15)）；更新 `globalCssRules.test.ts` 等；`npm run typecheck`、`npm run lint`、架构棘轮 exit 0。
- [x] AC4 线上 build 后复测：`npm run build:client` 后同一会话读数写入 Evidence，并与 15Hz 基线对照；若读数无法取得，park `needs-human` 并说明，不得推断。

## Evidence

### 测量方法（AC1/AC4 共用）

- **隔离生产构建**：在本 worktree `npm run build:client` 后，用 worktree 自己的 `tsx server/tsconfig.json server/index.ts` 起服务，`HOME` 与 `DATABASE_PATH` 都指向 throwaway 目录（不碰线上 `~/.cloudpit/auth.db`，不碰 :3001）。服务端直接渲染 `dist/`，不经 Vite dev。
- **页面形状**：预置 **600 个 workspace**，服务端列出 `project rows listed=600`；只展开 owning running session 的那一个。running 状态由客户端自己的 `/api/providers/sessions/running` 响应形状给出（探针 `page.route` 返回该 shape），因此渲染走真实 `SidebarSessionItem` → `Loader2.animate-spin`。页面里有 **1 个 processing spinner**（线上对照时是 processing + resident busy 两只，故绝对值不可与线上直接比）。
- **层数**：每个 variant 都用页级 CDP `LayerTree` 读数 **total=13 层**（`276x52` 层 = 2，即展开行的 wrapper+button；收起项目不再进层树），满足 AC1 的 ≤30 前提。
- **成本读数**：浏览器级 CDP `SystemInfo.getProcessInfo` 按进程类型求 CPU-time 差；`total` = 所有进程 CPU 秒 / 窗口秒（单核百分比），`GPU` = `gpu` 进程，`main` = 页级 `Performance.getMetrics` 的 `TaskDuration` / 窗口秒。窗口 15–20s。
- **抗漂移**：共享宿主 load1 在 5–29 间漂移，顺序 sweep 会把 load 坡度记成 variant 差异（首次顺序跑里最后测的 `animation:none` 反而最高）。因此改为**交错轮次**（每轮把每个 variant 各测一次、轮转顺序），判定用**同一轮的 paired delta vs 15Hz**，同时报中位数与原始窗口。
- 探针固定在 `taskset -c 120,80,84,72,70,64,58,54` 上跑（含 server 与 Chromium），headless Playwright Chromium 1.63.0，viewport 1280x900。原始 JSON 在 worktree `tmp/evidence/{ac1-matrix,ac1-matrix-confirm,ac4-shipped-balanced,frames}.json`（gitignored，私有）。

### AC1 — 三方案矩阵（实现前 15Hz 生产构建，注入式切换）

同一个页面、同一 running 会话，两次独立运行（A/B 各 4 轮 × 20s；每格是先打印的中位读数，原始窗口见下）：

| variant | A total/main/GPU (%) | B total/main/GPU (%) | paired Δtotal / ΔGPU (A · B) | layers |
| --- | --- | --- | --- | --- |
| 15Hz SVG | 5.65 / 3.03 / 0.47 | 4.95 / 2.61 / 0.30 | 0 / 0 · 0 / 0 | 13 |
| 60fps SVG | 4.90 / 3.08 / 0.45 | 4.92 / 3.11 / 0.37 | **−0.92 / −0.02** · **−0.02 / +0.05** | 13 |
| 60fps wrapper | 5.75 / 3.39 / 0.77 | 4.65 / 2.62 / 0.50 | **−0.25 / +0.30** · **−0.55 / +0.20** | 13 |
| `animation:none` 对照 | 2.45 / 1.27 / 0.30 | 1.85 / 1.11 / 0.22 | — | 13 |

原始窗口（total %）：

- A 15Hz `[4.3, 6.5, 5.4, 5.8]`；60fps SVG `[6.9, 4.8, 4.5, 4.9]`；60fps wrapper `[7.2, 5.1, 6.4, 3.4]`；none `[2.5, 2.2, 3.2, 2.3]`
- A main %：15Hz `[2.4, 3.6, 2.9, 3.1]`；SVG `[3.9, 3.1, 3.1, 3.1]`；wrapper `[3.6, 3.2, 3.8, 2.1]`；none `[1.3, 1.2, 1.4, 1.3]`
- A GPU %：15Hz `[0.3, 0.4, 0.5, 0.5]`；SVG `[0.4, 0.3, 0.5, 0.4]`；wrapper `[0.9, 0.8, 0.7, 0.5]`；none `[0.2, 0.3, 0.4, 0.3]`
- B 15Hz `[4.0, 5.7, 4.1, 6.2]`；60fps SVG `[5.7, 5.8, 4.0, 4.1]`；60fps wrapper `[6.9, 3.6, 4.6, 4.7]`；none `[1.9, 1.7, 1.7, 2.7]`
- B main %：15Hz `[2.3, 2.8, 2.4, 3.7]`；SVG `[3.6, 3.2, 2.6, 3.0]`；wrapper `[3.5, 2.4, 2.8, 2.5]`；none `[1.2, 1.0, 1.1, 1.3]`
- B GPU %：15Hz `[0.2, 0.3, 0.3, 0.5]`；SVG `[0.4, 0.3, 0.3, 0.4]`；wrapper `[0.5, 0.5, 0.5, 0.7]`；none `[0.2, 0.2, 0.2, 0.2]`

`animation:none` 对照在两次交错运行里都明显低于三个旋转 variant（A 2.45 vs 4.9–5.75；B 1.85 vs 4.65–4.95），说明读数对该动画敏感；顺序 sweep 里它反而更高，是 load 坡度，不进判定。

### AC2 — 选择：60fps SVG（移除侧栏步进规则）

- 包络判定：两次独立矩阵中 **60fps SVG 与 60fps wrapper 都在 `total ≤ 15Hz + 2`、`GPU ≤ 15Hz + 1` 内**（最大 paired Δtotal = −0.02，最大 ΔGPU = +0.30）。60fps 不再因为层数付出额外成本，因此换回平滑旋转。
- 最平滑且最小改动：两个 60fps 候选平滑度相同；**SVG 方案只删一条 CSS 覆盖**，不改组件树、不改 SVG 内容/`currentColor`/尺寸/数量，wrapper 方案则要动 `SidebarSessionItem` / `ResidentMark`。wrapper 没有可测优势（Δtotal 与 SVG 互有胜负，均在噪声内），所以选 **60fps SVG**。
- 实现：删除 `#sidebar-panel .animate-spin { animation: spin 1s steps(15,end) infinite }`；基础 `.animate-spin { animation: spin 1s linear infinite }` 继续对侧栏生效。spinner 数量（1 个 processing）、图标（`Loader2`）、`currentColor`、尺寸（h-3 w-3）均未变。

### AC3 — 旋转可见、timing 判据与全绿门

- 结构判据：`src/shared/tests/globalCssRules.test.ts` 改为 pin「侧栏不得有减速覆盖 + 基础旋转是连续 60fps」。运行时先打印：`sidebarSpinAnimations=[]`、`baseSpinAnimation=spin 1s linear infinite`，再断言；`#sidebar-panel .animate-spin` 的 animation 声明必须为 0，`.animate-spin` 必须恰为 `spin 1s linear infinite`。
- 命令：`bash scripts/with-memory-cap.sh npx vitest run src/shared/tests/globalCssRules.test.ts src/modules/sidebar/tests/recentConversationRowActions.test.tsx --maxWorkers=1` → `Test Files 2 passed (2)`、`Tests 12 passed (12)`，exit 0。
- 在转证据：生产构建上对每个 variant 取 6 张元素截图 + 6 次 computed `transform` 矩阵。shipped（60fps SVG）**截图 5/6 个不同哈希、transform 6/6 个不同矩阵**；15Hz 3/6·5/6；注入 60fps SVG 2/6·6/6；wrapper 3/6·6/6。headless 表面截图偶尔复用上一帧（哈希重复），但每张截图的 transform 矩阵都不同，证明元素确实在转；判据不依赖截图哈希唯一性。
- `npm run typecheck` → exit 0；`npm run lint` → exit 0（仅仓库既存 warning）；架构棘轮 `bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/architecture-ratchet.test.ts` → 6 pass / 0 fail，exit 0。

### AC4 — 实现后的生产构建复测

- `npm run build:client` → exit 0；`dist/build-info.json`：`gitSha=38506b63e600f3280beb491a8a9626ec01b45d0c`、`builtAt=2026-11-21T12:52:25.349Z`。新 `dist/index.html` 引用的 CSS 中 **`steps(15` 命中 0**（`emptyOutDir:false` 会留下旧的未引用 CSS 文件，index.html 指向的是新文件）。
- 同一隔离页面、同一 running 会话、同一 600 workspace 形状（**13 层**），平衡轮转 6 轮 × 15s：

| variant | total 中位 | main 中位 | GPU 中位 | paired Δtotal / ΔGPU |
| --- | --- | --- | --- | --- |
| shipped（60fps SVG） | 6.00 % | 3.36 % | 0.53 % | **+1.17 / +0.10** |
| 15Hz SVG（注入对照） | 4.40 % | 2.41 % | 0.40 % | 0 / 0 |
| `animation:none` 对照 | 4.23 % | 1.75 % | 0.30 % | — |

- 原始 total 窗口：shipped `[5.5, 6.5, 4.6, 6.5, 6.8, 5.5]`；15Hz `[5.4, 3.5, 4.4, 4.4, 3.6, 5.4]`；none `[6.0, 2.8, 4.0, 4.5, 4.7, 2.6]`（load1 10.9→19.2）。main：shipped `[2.9, 3.5, 3.2, 3.8, 3.7, 3.3]`，15Hz `[2.7, 2.3, 2.4, 2.4, 2.3, 2.9]`。GPU：shipped `[0.5, 0.5, 0.6, 0.4, 0.5, 0.5]`，15Hz `[0.5, 0.4, 0.4, 0.4, 0.3, 0.4]`。
- 结论：中位数差 +1.6 点 total / +0.13 点 GPU，配对差 +1.17 / +0.10，均在包络 `total ≤ +2`、`GPU ≤ +1` 内；与 15Hz 基线对照成立。
- 与线上历史读数（15Hz 两只 spinner、172 层：total 14.7 / GPU 4.5）只作方向性对照：本探针是 13 层、1 只 processing spinner，绝对值不可直接相减；受控比较是上表同一页面的 shipped vs 15Hz 配对。

该轴仍暗,理由:本任务只删除侧栏 spinner 的步进 CSS 并改守卫测试，没有产生架构分层 L_D/L_G 读数

## DoD

- 选择的方案有实测依据；不出现“为了 60fps 把层数/CPU 拉回 20%”的回归。
- spinner 仍可见在转；SVG wrapper 方案只改动画承载元素，不改 SVG 内容/颜色/尺寸。
- 现有 sidebar/chat 测试、typecheck、lint、棘轮全绿；Touches 一致。

## Touches

- src/index.css
- src/modules/sidebar/SidebarSessionItem.tsx
- src/modules/sidebar/ResidentMark.tsx
- src/shared/tests/globalCssRules.test.ts
- src/modules/sidebar/tests/recentConversationRowActions.test.tsx
- tasks/gap-running-spinner-60fps-after-layer-fix.md
