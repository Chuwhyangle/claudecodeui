---
id: cockpit-stage-visual-attention-fixes
title: 驾驶舱舞台视觉修正：磁贴不显示原始 URI、需要人的项目唯一强调、序号标签可读
status: ready
labels:
  - cockpit
  - ui
parent: null
children: []
extra: {}
depends_on:
  - cockpit-read-only-stage
---
## Proposal

决策出处：2026-10-23 对 `cockpit-read-only-stage` 截图（`tmp/cockpit-fleet.png`、`tmp/cockpit-board.png`）的视觉复核，对照墙的设计原则「只有需要你的东西才动 / 所见即可说」。

发现：
1. **board 视图的在途磁贴把原始 URI 当标题显示**（`quay://50654ea6-…/task/ui-scenario-drive…`），被截断、不可读，也念不出来。URI 属于状态条，不属于磁贴标题。
2. **「需要人」没有任何强调**：fleet 视图里 quay-fleet「1 needs human」、quay「4 needs human」与「0 needs human」同样的灰色小字，一眼看不出哪个项目要你。
3. **序号标签过小、对比度过低**：①② 比正文小一号且是浅灰，作为口语句柄和手柄落点不够醒目。
4. 所有项目都显示同样的灰底「DRIVER RUNNING」徽标——信息量为零的重复元素占据了每块磁贴最显眼的位置。

方案：
1. 在途磁贴标题 = 任务 id（必要时截断并带 title 提示），副标题 = 任务标题；URI 只出现在状态条。
2. `needs human > 0` 的项目磁贴使用唯一的强调色（边框 + 数字），这是 fleet 视图里唯一的彩色元素；为 0 时不显示该计数或以最弱样式显示。磁贴位置保持稳定，不因状态重排。
3. 序号标签字号不小于正文、对比度满足 WCAG AA。
4. 驱动状态只在异常（停止 / 故障）时显示徽标；正常运行不显示。

## AC

- [x] AC1: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——在途磁贴的可见文本不含 `quay://`；needs-human > 0 的磁贴带强调样式标记（data 属性），= 0 的不带；驱动正常时不渲染驱动徽标，停止时渲染。
- [x] AC2: `npx playwright test e2e/cockpit-visual.spec.ts` exit 0（在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）——读取序号标签计算后的字号 ≥ 正文字号、前景 / 背景对比度 ≥ 4.5；控制臂：把标签强制设为浅灰小字后同一读取函数判红。
- [x] AC3: `npm run typecheck` 通过。

## DoD

- **MCP 浏览器实际操作 + 截图（必做）**：真实 CloudCLI `/cockpit` 的 fleet 与 board 视图修改前后截图对比（存 `tmp/`），确认一眼能看出哪个项目需要人、在途磁贴标题可读。

## Touches

- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- e2e/cockpit-visual.spec.ts
- playwright.config.ts
- tasks/cockpit-stage-visual-attention-fixes.md
