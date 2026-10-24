---
id: architecture-fullscreen-fit-margin
title: 架构图全屏适应边距：Fit 使用全屏宿主扣除实际叠层，不再沿用非全屏的预留边距
status: todo
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

- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomLayout.test.ts` exit 0：新增用例——给定全屏宿主尺寸与叠层矩形，求解可用区域等于宿主扣除叠层；叠层为空时等于整个宿主；既有 `solveFitScale` 用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/svgViewport.test.tsx` exit 0：新增用例——全屏进入后 Fit 用实测叠层矩形而非非全屏预留边距；叠层开合触发重新求解；非全屏 Fit 的读数与改动前一致；既有用例不回归
- [ ] `npx playwright test e2e/architecture-fullscreen-fit.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：L（55 实体）夹具在 1440×765 全屏、点 Fit 后，svg 屏幕尺寸在限制维度上占全屏宿主可用尺寸（扣除叠层后）的 ≥ 85%，最小字号 ≥ 10px，图不被叠层遮挡；1920×900 与手机 390×844、844×390 同样读数
- [ ] `npx playwright test e2e/architecture-fullscreen-fit.spec.ts --grep "control arm"` exit 0：控制臂——恢复非全屏预留边距时占比读数变红，主臂与控制臂用同一读取函数
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/` exit 0

## DoD

真实浏览器（MCP 浏览器）里，PC 1440×765 打开 claudecodeui 的 55 实体 L 会话 Architecture 标签，进入全屏并点 Fit，读出 svg 尺寸、宿主可用尺寸、占比、比例与档位，开合 Inspector 再读一次，对照修复前的约 788×480 / 15%；截图存 `tmp/`（含与 `tmp/ux-08-L-fullscreen.png` 的前后对照）并贴进 Evidence。仓库里若存在 Architecture 场景，另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；不存在则在 Evidence 里写明。任何临时改动必须还原。遵循 `.agents/skills/frontend-module-standards`。

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
