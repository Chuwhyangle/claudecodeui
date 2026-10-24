---
id: architecture-keyboard-nav-start-and-a11y
title: 架构图键盘导航起点与无障碍：起点取视口中心最近实体，aria-live 只播报名称与种类，焦点环与选中样式区分
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->2026-10-24 在真实浏览器里探查 Architecture 标签（PC 1440×765，会话 f9602ca3 的 55 实体 L 图）的键盘操作，发现三处问题。已检索 `architecture-*` 的 todo / ready 任务，没有与本任务共用 Touches 的开放任务。

1. **键盘焦点进入画布时的首个活动实体是任意的**。要求：取距视口中心最近的实体；若已有上次选中的实体且仍存在，则取它。选取是纯函数，同输入同输出。
2. **aria-live 区域包含整段 Inspector 文字**，屏幕阅读器每次移动都读一大段。要求：只播报实体名称与种类，并带位置 n/m（如"OrderService，class，3/55"）；Inspector 内容不进入该区域。
3. **焦点样式问题**：没有任何选中时画布上仍残留蓝色焦点轮廓；"键盘焦点"与"已选中"两种状态在视觉上无法区分。要求：焦点环与选中样式使用不同的视觉表达（例如焦点为外描边环，选中为填充或粗边），并且焦点环在失焦（blur）时清除。

**不改动 Escape 键的行为**（含取消选中、退出全屏等既有语义），不在本任务范围内。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——首次键盘聚焦时活动实体等于距视口中心最近的实体（合成几何，含并列时按稳定顺序）；存在上次选中且仍存在时取它；aria-live 区域文本只含名称、种类与 n/m，且不含 Inspector 文本；失焦后焦点环属性被清除；无选中时画布上没有焦点环；焦点与选中使用不同的 `data-*` 状态与不同的样式类；Escape 相关既有用例逐条不回归
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：新增的播报文案键在十二个语言包中齐全
- [ ] `npx playwright test e2e/architecture-keyboard-a11y.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：L（55 实体）夹具在 1440×765 视口，Tab 进入画布后的活动实体等于距视口中心最近的实体；方向键移动后 aria-live 文本只含名称、种类、n/m；点击空白处或 Tab 离开后焦点环消失；焦点环与选中描边的计算样式不同
- [ ] `npx playwright test e2e/architecture-keyboard-a11y.spec.ts --grep "control arm"` exit 0：控制臂——恢复任意起点、恢复整段 Inspector 播报、恢复失焦不清环时对应读数变红，主臂与控制臂用同一读取函数
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/` exit 0

## DoD

真实浏览器（MCP 浏览器）里，PC 1440×765 打开 claudecodeui 的 55 实体 L 会话 Architecture 标签，亲手走一遍：Tab 进入画布看起点、方向键移动、读出 aria-live 区域文本、选中后对比焦点环与选中样式、失焦确认焦点环消失；截图存 `tmp/` 并贴进 Evidence。仓库里若存在 Architecture 场景，另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；不存在则在 Evidence 里写明。任何临时改动必须还原。遵循 `.agents/skills/frontend-module-standards`。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- e2e/architecture-keyboard-a11y.spec.ts
- playwright.config.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/zh-CN/common.json
- tasks/architecture-keyboard-nav-start-and-a11y.md
