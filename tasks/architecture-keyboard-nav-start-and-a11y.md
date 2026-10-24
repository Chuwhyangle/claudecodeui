---
id: architecture-keyboard-nav-start-and-a11y
title: 架构图键盘导航起点与无障碍：起点取视口中心最近实体，aria-live 只播报名称与种类，焦点环与选中样式区分
status: done
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

- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——首次键盘聚焦时活动实体等于距视口中心最近的实体（合成几何，含并列时按稳定顺序）；存在上次选中且仍存在时取它；aria-live 区域文本只含名称、种类与 n/m，且不含 Inspector 文本；失焦后焦点环属性被清除；无选中时画布上没有焦点环；焦点与选中使用不同的 `data-*` 状态与不同的样式类；Escape 相关既有用例逐条不回归
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：新增的播报文案键在十二个语言包中齐全
- [x] `npx playwright test e2e/architecture-keyboard-a11y.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：L（55 实体）夹具在 1440×765 视口，Tab 进入画布后的活动实体等于距视口中心最近的实体；方向键移动后 aria-live 文本只含名称、种类、n/m；点击空白处或 Tab 离开后焦点环消失；焦点环与选中描边的计算样式不同
- [x] `npx playwright test e2e/architecture-keyboard-a11y.spec.ts --grep "control arm"` exit 0：控制臂——恢复任意起点、恢复整段 Inspector 播报、恢复失焦不清环时对应读数变红，主臂与控制臂用同一读取函数
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/` exit 0

## DoD

真实浏览器（MCP 浏览器）里，PC 1440×765 打开 claudecodeui 的 55 实体 L 会话 Architecture 标签，亲手走一遍：Tab 进入画布看起点、方向键移动、读出 aria-live 区域文本、选中后对比焦点环与选中样式、失焦确认焦点环消失；截图存 `tmp/` 并贴进 Evidence。仓库里若存在 Architecture 场景，另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；不存在则在 Evidence 里写明。任何临时改动必须还原。遵循 `.agents/skills/frontend-module-standards`。

## Evidence

实施提交：`74a431ee9`（task 分支 `task/architecture-keyboard-nav-start-and-a11y`）。

### AC-1 组件用例
`bash scripts/with-memory-cap.sh npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` → `Test Files 2 passed (2)` / `Tests 135 passed (135)`；architectureTab 单文件 127 条全绿。新增：
- `the keyboard start rule is the nearest entity to the viewport centre, stable on ties`：合成几何，最近者胜；并列按 y→x→id 稳定；上次选中仍存在则取它；不在则回退最近；有实体时帧不作起点；只有帧的折叠图取最近帧；空图返回 null。
- `keyboard focus starts on the nearest entity, announces name/kind/n-of-m, and blur clears the ring`：焦点进入后 active descendant = 视口中心最近实体；aria-live 文本形如 `Keyboard1, class, 18/55`，不含 package/incoming/outgoing；blur 后环与 `data-architecture-nav-focus` 清除、role 回 `img`、active descendant 清空、无选中时无任何选中状态；焦点与选中分别使用 `arch-nav-focus`/`data-architecture-nav-focus` 与 `arch-selected`/`data-architecture-selected`；选中描边为实线、焦点环为 `stroke-dasharray: 5 3`。
- `a pointer press focuses the canvas for panning without painting a keyboard ring`。
- 既有 entity-navigation 用例的 Escape 语义逐条通过（退出导航并 `stopPropagation`，非导航且无选中时不消费）。

### AC-2 十二语言包
`architecture.nav.announceItem`（`{{label}}, {{kind}}, {{position}}/{{total}}`）与 `architecture.nav.kindPackage` 已加入全部 12 个 `locales/*/common.json`；i18n 完整性用例新增一条，校验两键在 12 包齐全且 `{{position}}`/`{{total}}` 占位符与英文一致。

### AC-3 / AC-4 Playwright（真实 Chromium + 真实 server/client，55 实体 L 夹具，1440×765）
- `npx playwright test e2e/architecture-keyboard-a11y.spec.ts` → `4 passed (40.9s)`（复测一次 `4 passed (36.8s)`；主臂单跑 21.3s）。`playwright.config.ts` 新增 `'architecture-keyboard-a11y.spec.ts': 600_000` 并在注释里写明上述实测。
- `--grep "control arm"` → `3 passed (28.7s)`。
- 关键读数（主臂）：Tab 后 `role=application`、`nearestEntityId === entityId = scope-src/src/fit/p1/Keyboard1.ts.Keyboard1`、aria-live `Keyboard1, class, 18/55`；环 `class=arch-nav-ring`、`stroke-dasharray: 5px, 3px`、`stroke-width: 3px`；选中边 `arch-selected`、`stroke-dasharray: none`、`stroke-width: 2.5px`；Tab 离开后 `ring=null`、`navFocusState=false`，而 `data-architecture-selected=true` 仍在；空白点击后仍无环。
- 控制臂（同一 `readKeyboardA11y` / `startsOnNearest` / `announcementIsConcise`）：`farthest-start` 起点变为距中心最远实体（`Keyboard23`）且 `startsOnNearest=false`；`verbose-announce` 播报 `Keyboard1, class, package src/fit/p1, 0 outgoing, 1 incoming` 且 `announcementIsConcise=false`；`keep-ring-on-blur` 在 Tab 离开后 `ring` 仍非空。三者均为 DEV-only localStorage 开关，生产构建不含分支。

### AC-5 静态门
`npm run typecheck` exit 0；`npm run build` exit 0；`npx oxlint src/` exit 0（仅仓库既有 warning，无 error）。

### DoD 实机走查
本会话没有 MCP 浏览器工具，改用仓库自带的 Playwright 真实 Chromium 在同一真实页面/服务端上完成实机走查（等价替代，见 `no-mcp-browser-use-throwaway-playwright-spec`）：Tab 进入画布看起点 → 方向键移动 → 读 aria-live → Enter 选中后对比焦点环与选中样式 → Tab 离开/点击空白确认环消失。截图存 `tmp/architecture-keyboard-a11y/`（git-ignored，不随提交）：
- `01-tab-start-nearest.png`、`02-arrow-moved.png`、`03-focus-vs-selection.png`、`04-tab-away-ring-gone.png`、`05-blank-press-ring-gone.png`
- 控制臂：`control-farthest-start.png`、`control-verbose-announce.png`、`control-keep-ring-on-blur.png`

仓库里不存在 Architecture 的 `scripts/ui-scenario.mjs` 场景 JSON（`find . -maxdepth 3 -name '*scenario*.json'` 无匹配），故未运行场景运行器。无临时改动遗留。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- e2e/architecture-keyboard-a11y.spec.ts
- playwright.config.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-TW/common.json
- tasks/architecture-keyboard-nav-start-and-a11y.md
