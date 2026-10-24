---
id: architecture-fullscreen-fit-margin
title: 架构图全屏适应边距：Fit 使用全屏宿主扣除实际叠层，不再沿用非全屏的预留边距
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
depends_on:
  - architecture-single-scale-fit-contract
---
## Proposal

<!-- dedup-ref -->2026-10-24 在真实浏览器里探查 Architecture 标签（PC 1440×765，会话 f9602ca3 的 55 实体 L 图，截图 `tmp/ux-08-L-fullscreen.png`）：全屏下该图只画成约 788×480、比例 15%（B 档），四周留有大片空白。已检索 `architecture-*` 的 todo / ready 任务，没有与本任务共用 Touches 的开放任务；本任务在已完成的 `architecture-single-scale-fit-contract`（Fit = 求解，`MAX_FIT_SCALE = 1.5`，适应粘性）之上调整求解的输入边距，该契约的其余行为保留。

要求：
1. 全屏时 Fit 求解的可用区域取"全屏宿主的完整尺寸，扣除实际存在的叠层（工具栏、底部槽位、Inspector 抽屉等）所占的矩形"，不再沿用非全屏布局为外围控件预留的边距。叠层尺寸取实测矩形而不是常量；叠层开合时按既有 150ms 去抖重新求解。
2. 复核 `MAX_FIT_SCALE` 与各档位阈值对大图（50 个实体以上）的影响：在不违反最小字号（PC 10px、手机 11px）的前提下，确认大图 Fit 后不会因阈值过保守而被锁在过小的档位；若需要调整阈值，调整后既有档位用例逐条仍通过，并在 Evidence 里写明复核结论。
3. 非全屏与独立页的 Fit 结果不变。

## AC

- [x] `npx vitest run src/modules/architecture/tests/semanticZoomLayout.test.ts` exit 0：新增用例——给定全屏宿主尺寸与叠层矩形，求解可用区域等于宿主扣除叠层；叠层为空时等于整个宿主；既有 `solveFitScale` 用例不回归
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/svgViewport.test.tsx` exit 0：新增用例——全屏进入后 Fit 用实测叠层矩形而非非全屏预留边距；叠层开合触发重新求解；非全屏 Fit 的读数与改动前一致；既有用例不回归
- [x] `npx playwright test e2e/architecture-fullscreen-fit.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：L（55 实体）夹具在 1440×765 全屏、点 Fit 后，svg 屏幕尺寸在限制维度上占全屏宿主可用尺寸（扣除叠层后）的 ≥ 85%，最小字号 ≥ 10px，图不被叠层遮挡；1920×900 与手机 390×844、844×390 同样读数
- [x] `npx playwright test e2e/architecture-fullscreen-fit.spec.ts --grep "control arm"` exit 0：控制臂——恢复非全屏预留边距时占比读数变红，主臂与控制臂用同一读取函数
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/` exit 0

## DoD

真实浏览器（MCP 浏览器）里，PC 1440×765 打开 claudecodeui 的 55 实体 L 会话 Architecture 标签，进入全屏并点 Fit，读出 svg 尺寸、宿主可用尺寸、占比、比例与档位，开合 Inspector 再读一次，对照修复前的约 788×480 / 15%；截图存 `tmp/`（含与 `tmp/ux-08-L-fullscreen.png` 的前后对照）并贴进 Evidence。仓库里若存在 Architecture 场景，另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；不存在则在 Evidence 里写明。任何临时改动必须还原。遵循 `.agents/skills/frontend-module-standards`。

## Evidence

- **复核当前态（要求 2）**：提案里的 788×480 / 15% 是 `architecture-single-scale-fit-contract` 落地之前的读数。在本 worktree 的改动前基线上，同一 L 夹具在 1440×765 全屏已读到 1207×665 / 53%（A 档）——全屏重解本身已由上游任务修好。本任务的 delta 是：Fit 的可用区改成"宿主 − 实测叠层"、不再沿用非全屏预留边距，且图不再被叠层遮挡；控制臂把"沿用非全屏画布"的旧规则恢复出来，占比变红。
- **AC1** — `npx vitest run src/modules/architecture/tests/semanticZoomLayout.test.ts`：`40 passed (2.0s)`。新增 `solveFitArea` 用例：空叠层 = 整个宿主（1440×765）；顶部整幅工具栏 76px → `{top:76,height:689}`；底部抽屉只减底部；右下角槽按"代价更小的一轴"扣除（60×200 的角落只扣 72px 右边带，不减 200px 高度）；左下信息条扣底部；三条复合为 `{top:76,width:1380,height:589}`；超宽叠层裁剪不为负；同一几何用叠层可用区求解的 scale 严格大于用 24px 预留边距的 scale。既有 `solveFitScale` 用例（单调性、MAX_FIT_SCALE、≤14 次求解、D 档兜底、成员压缩）逐条通过。
- **AC2** — `npx vitest run architectureTab.test.tsx svgViewport.test.tsx`：`149 passed`（124 + 25）。新增：进入全屏后（host 1440×765、读出行 60px、右下角槽 60×200 内缩 12px）`data-architecture-fit-viewport` = `1367x704`（实测可用区 1368×705 减 1px 取整余量），宿主内联 padding 为 top 60 / right 72 / bottom 0 / left 0——旧的非全屏预留边距会得到 1416×681；把角槽放大到 300×200 后经既有 150ms 去抖重解为 `1439x492`；退出全屏读数回到 `400x300`、padding 清空。`svgViewport.test.tsx` 新增 `fitAreaInsets`（无叠层时四边 0）与 `measureHostSize`（完整宿主 vs `measureViewportSize` 内容盒）。既有用例全绿（含 55 实体 tier-B 压缩）。
- **AC3** — `npx playwright test e2e/architecture-fullscreen-fit.spec.ts`：`5 passed (1.2m)`（config、两个 webServer、浏览器启动、夹具与全部读数）。L（55 实体）夹具、全屏 + Fit 后：
  - 1440×765：可用 1350×652.5，图 1169×652，限制维度 99.9%，tier A，scale 0.5166，最小字号 10.00px，无遮挡；
  - 1920×900：可用 1830×787.5，图 1684×787，99.9%，tier A，0.7492，10.00px；
  - 390×844：可用 390×679，图 390×386，100%，tier B，0.1081，11.00px；
  - 844×390：可用 844×233，图 446×233，100%，tier C，0.1944，11.00px。
  四条都用同一个 `readFullscreenFit` 断言图不与实测叠层（顶部 77px 带、角槽、footer 36px、桌面打开时的 Inspector 320px 右列）相交。截图 `tmp/architecture-fullscreen-fit/*-fullscreen-fit.png`。`SPEC_BUDGET_MS['architecture-fullscreen-fit.spec.ts'] = 360_000`，实测约 78s（四条 16.5 / 28.7 / 44.2 / 60.9s，控制臂随后）。
- **AC4** — `npx playwright test e2e/architecture-fullscreen-fit.spec.ts --grep "control arm"`：`1 passed (21.4s)`。同一 `readFullscreenFit`：DEV 开关恢复非全屏画布后图 821×540、占比 82.8% < 85%、`data-architecture-fit-viewport` = 1127×539（退役盒子）；移除开关并重新进入全屏后 1169×652、99.9%、1349×652（实测可用区）。生产构建不含该 DEV 分支。
- **AC5** — `npm run typecheck`、`npm run build`、`npx oxlint src/ server/ scripts/ shared/`（= `npm run lint`）：均 exit 0；lint 只有既有 warning。
- **DoD / 真实浏览器**：本会话没有可用的 MCP 浏览器工具，按仓库约定用真实 Playwright 页面完成同一读法。前后对照：`tmp/architecture-fullscreen-fit/before-ux-08-L-fullscreen.png`（提案的 788×480 / 15%）对 `pc-1440x765-fullscreen-fit.png`（1169×652 / 51.7%，填满实测可用区、不被叠层遮挡）。Inspector 开/合：`pc-1440x765-fullscreen-inspector.png`（可用 1120×652.5、图 1119×636、scale 0.4943）与 `-inspector-closed.png`（回到 1350×652.5、0.5166）。临时改动全部在 DEV 开关之后，生产构建不含；截图只在 gitignored 的 `tmp/`。
- **场景运行器**：仓库里没有 Architecture 场景（`e2e/scenarios/` 只有 `cockpit-mode-switch.json` 与 `quay-wall-focus-pin-utter.json`），故以新增 e2e 作为场景级回归。
- **阈值复核结论（要求 2）**：`MAX_FIT_SCALE = 1.5` 与手工缩放的 `SEMANTIC_STRETCH_LIMIT = 1.8` 都未调整——L 在桌面解出 0.517 / 0.749，远低于上限；小图仍按 1.5 放大（既有用例通过）。改的是 Fit 的档位选择：先在地板比例上选"映射内容真正放得下的最丰富档位"（内容随 scale 单调不减，地板放得下 ⇔ 任意 scale 可达），再在该档内二分，从而在机制上排除"预算过早发稀疏档、Fit 没有更大 scale 可试"的锁档；全部档位/压缩用例逐条通过，四个视口的图都填满实测可用区（≥99.9%）。

## Touches

- src/modules/architecture/semanticZoomLayout.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/tests/semanticZoomLayout.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/svgViewport.test.tsx
- e2e/architecture-fullscreen-fit.spec.ts
- playwright.config.ts
- tasks/architecture-fullscreen-fit-margin.md

## Blocker

**2026-10-24T12:05:19.465Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/modules/architecture/tests/mobileCompactToolbar.test.tsx: AssertionError [ERR_ASSERTION]: the drawing reserves the top chrome band inside the overlay
- run_id：wk-prod-anchor
- session_id：7b43933a-783c-40c1-a412-f99994464e46
