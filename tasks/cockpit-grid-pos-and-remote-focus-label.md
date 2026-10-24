---
id: cockpit-grid-pos-and-remote-focus-label
title: 驾驶舱：方向键按可视网格位置吸附（现按可聚焦序号）；遥控器焦点卡片显示对象名称
status: ready
labels:
  - cockpit
  - ui
parent: null
children: []
extra: {}
---
## Proposal

决策出处：2026-10-24 对线上构建（:3001 于 10-24 09:45 重建重启）的复测（同一份 dist 起隔离实例、headless 两窗口驱动；截图 `tmp/ckv/8-fleet-after.png`、`tmp/ckv/9-remote.png`）。`cockpit-live-verification-defects` 修好的项已确认：输入框不再抢焦点、来源显示「Desktop · 0a70ca」、fleet CLI 状态透出。剩下两处：

1. **方向键按「可聚焦列表的序号」排网格，而不是按磁贴在屏幕上的位置**。fleet 视图是 3 列，未登记项目（meta-cc、cantus、quay-dogfood-goal030、gap-official-…）占位但不可聚焦。实测：在 claudecodeui（第 1 行第 2 列）按 ↓，焦点跳到 plantuml-js（第 3 行第 3 列），而不是正下方的 archguard（第 2 行第 2 列）。原因：上报的 `display.pos` 是在 5 个可聚焦元素里重新编号的行列，不是可视网格的行列。
2. **手机遥控器的焦点卡片只显示「① running」**，没有对象名称（应为「① quay-fleet」）；在手机上看不到桌面，序号和状态不足以确认自己指着什么。

方案：
1. `display.pos` 取磁贴在可视网格中的真实行列（包含不可聚焦的占位磁贴在内计算），reducer 按此吸附；目标格不可聚焦时沿同方向继续找最近的可聚焦格。
2. 遥控器焦点卡片显示序号 + 对象名称（项目名或任务 id）+ 状态。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/cockpit/tests/cockpit-reducer.test.ts` exit 0——3 列网格夹具，(1,3)、(2,3) 为不可聚焦占位：在 (1,2) 按 ↓ 到 (2,2)；在 (2,2) 按 → 跳过 (2,3) 停在原处或按规则到最近可聚焦格（行为写明并断言）；既有用例不弱化。
- [x] AC2: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——fleet 视图上报的 `pos` 与磁贴在网格中的行列一致（含占位磁贴）。
- [x] AC3: `npx vitest run src/modules/cockpit/tests/CockpitRemote.test.tsx` exit 0——焦点卡片文本包含对象名称。
- [x] AC4: `npm run typecheck` 通过。

## DoD

- **浏览器实际操作 + 截图（必做）**：fleet 视图上从 claudecodeui 按 ↓ 落到 archguard；遥控器焦点卡片显示项目名。截图存 `tmp/`。

## Touches

- server/modules/cockpit/cockpit.reducer.ts
- server/modules/cockpit/tests/cockpit-reducer.test.ts
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/cockpitView.ts
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitRemote.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/cockpit/tests/CockpitRemote.test.tsx
- tasks/cockpit-grid-pos-and-remote-focus-label.md
