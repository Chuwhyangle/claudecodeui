---
id: architecture-default-fit-and-readable-lod
title: 默认缩放到看全图不用拖动；低缩放下 package 标题反向缩放保持可读；package 级关系线沿原有正交折线裁剪而不是画中心直线
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
depends_on:
  - architecture-toolbar-popover-and-fit-fixes
---
## Proposal

2026-10-22 用 MCP 浏览器在 4 个会话（1440×765）实测，默认画面都不是「整图缩放到画布内」：本会话（自然 4395×1943，默认 69%，真能适应 26%）、live voice（2420×1526，69% 对 33%，显示 1675×1057 对画布 831×580）、「现有语音模型的上下文识别对比」（2015×1174，69% 对 49%，只有 5 个实体也要拖动）、「Quay 的 OO 设计重构」（4176×3756，69% 对 15%，显示 2891×2600 对画布 1151×601）。用户要求：默认应能看到全图，不用拖动；缩放到很小、类被隐藏只显示 package 时，package 标题要可读，关系线要保持原有风格。

### 一、默认全图

根因在 `readableZoom.ts`：`READABLE_ZOOM_SCALE = MIN_READABLE_FONT_PX / RENDERED_LABEL_FONT_PX`（≈ 0.69），`decideReadableZoom` 里 `defaultMode = measuredFit < READABLE_ZOOM_SCALE ? 'focus' : 'overview'`，focus 档缩放取 `max(measuredFit, READABLE_ZOOM_SCALE)`——整图适应后低于 69% 时（几乎总是）默认就是「按可读缩放裁出一块」。修法：默认永远是整图适应（Overview 档，整图完全落入画布、缩放等于真正的 fit，沿用已修好的 fit 计算）；原来的「可读聚焦」保留为 `Focus` 档，由用户手动进入，选择按项目记住（本地存储，换项目隔离），记住的是用户的显式选择，不是上次自动落入的档位。`PlantUmlGraph.tsx` 里四处 `decideReadableZoom` 调用（第 1396、1851、1920、1959 行附近）按新规则统一。

### 二、低缩放下 package 标题可读

实测（live voice 会话，Overview 33%）：package 标题字号 12px（SVG 用户单位），屏幕上约 4–5px，固定在 package 框左上角（相对框偏移 [3,0]），没有任何反向缩放，无法阅读。修法：在 LOD 层（`explosionLod.ts`）为每个 package 维护一层标题覆盖（`<g data-architecture-lod-labels>`），随缩放反向缩放，使**屏幕上字高不小于 11px**（上限 16px），仍锚在 package 框左上角；标题按框的屏幕宽度截断加省略号，框的屏幕宽度小于标题最小可读宽度（约 60px）时不画标题；框重叠时外层（面积大的）优先，内层标题放不下就省略；带计数的格式沿用现状（`modules/chat (12)`）。缩放变化用既有的 5–10% 迟滞与 150–250ms 防抖，不逐帧重算。实体框可见档位（Entities）的标题不受影响。

### 三、package 级关系线保持原有风格

实测：低缩放档的 package 间关系线是 `<line class="arch-lod-package-edge">`（`explosionLod.ts` 第 400 行附近，实测 22 条），连接 package 框**中心**的直线，与原有实体边（带正交折点的 `<path>`、虚线、箭头与关系类型样式）完全不同。修法：不再画中心直线；对每一对有关系的 package（A、B），取该对之间权重最大的一条原有实体边的折线，把它**裁剪**到两端 package 框的边界（从 A 的边界出发、到 B 的边界结束），保留折线的正交形状、虚线与箭头样式、关系类型颜色；同一对 package 之间的多条边合并成这一条，线宽按权重加粗并带权重标签（沿用 `data-weight`）；没有可用折线时（如原边被隐藏）退化为沿两框边界的正交 L 形线，仍不画斜线。裁剪是纯函数（输入折线点与两个框，输出裁剪后的点），放在 `explosionLod.ts` 里便于测试。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/readableZoom.test.tsx` exit 0：新增用例——整图适应缩放低于 0.69 时默认仍是整图适应（整图完全落入画布，缩放 ≥ 理论 fit 的 95%），而不是 `max(fit, 0.69)`；用户显式选择 Focus 后被记住（按项目隔离）、再次打开仍是 Focus；换项目不串；既有的 Focus 档缩放计算用例在显式选择路径下不回归
- [ ] `npx vitest run src/modules/architecture/tests/explosionLod.test.tsx` exit 0：标题反向缩放用例——给定缩放 0.33，标题屏幕字高 ≥ 11px 且 ≤ 16px；缩放 1.0 时不再放大（不小于原字号）；框屏幕宽度 < 60px 时不画标题；外层与内层标题冲突时外层保留；裁剪纯函数用例——折线被裁剪到两个框的边界且每一段保持水平或垂直（正交）、端点在框边界上、同一对 package 多条边合并为一条且线宽随权重增加、无可用折线时退化为正交 L 形；不再产生任何 `arch-lod-package-edge` 的 `<line>` 元素
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/svgViewport.test.tsx` exit 0：默认状态整图在画布内（`svg` 盒完全位于画布盒内）；`Focus` 档按钮仍可进入可读聚焦；既有 LOD、爆炸、下钻、hover 用例不回归（涉及「默认是 focus」的旧断言已逐处改写并列在实施记录）
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（在既有几何守卫里增加断言，整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 为它加条目并写明实测）：默认状态整图落入画布（PC 与手机视口都断言）；低缩放档位下可见的 package 标题屏幕字高 ≥ 11px；LOD 层的关系线每一段都是水平或竖直的（正交），且不存在 `arch-lod-package-edge` 的 `<line>`
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：新增控制臂——把标题覆盖层强制为不反向缩放后，读数的字高落到 11px 以下（证明守卫能取假），主臂与控制臂用同一读取函数
- [ ] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（1440×765 与 390×844）分别打开 claudecodeui 项目的四个会话（本会话、live voice、「现有语音模型的上下文识别对比」、「Quay 的 OO 设计重构」）的 architecture tab：每一个默认画面都是整图落入画布、无需拖动（贴 `svg` 盒与画布盒读数）；缩小到只剩 package 时标题清晰可读（贴屏幕字高读数与截图），关系线是与原有实体边同风格的正交虚线而不是中心直线；点 Focus 能进入可读聚焦，刷新后保持用户的选择。证据是几何读数与前后截图。

## Touches

- src/modules/architecture/readableZoom.ts
- src/modules/architecture/explosionLod.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/tests/readableZoom.test.tsx
- src/modules/architecture/tests/explosionLod.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/svgViewport.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-default-fit-and-readable-lod.md
