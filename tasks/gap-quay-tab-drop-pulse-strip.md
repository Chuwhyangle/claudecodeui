---
id: gap-quay-tab-drop-pulse-strip
title: Quay tab：先去掉顶部脉搏条（PulseStrip 组件与 cockpit 用法保留）
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

<!-- dedup-ref --> 取代同日立案但尚未开工的 `gap-quay-tab-three-charts-aligned-time-axis-revert-pulse-strip`（改为 superseded；其「revert `a2b876d97`、三图叠成一列」两项已被用户裁定缩小范围）。用户裁定（2026-10-25）：**Quay tab 先去掉 PulseStrip**；cockpit 继续实验 PulseStrip（见 `gap-cockpit-pulse-strip-composes-existing-charts-aligned`），所以 `PulseStrip.tsx`、它的测试、`src/modules/quay/index.ts` 的导出与 cockpit 的用法**一律保留，不 revert**。

现状：`QuayPanel.tsx` 顶部（`quay-panel-pulse` 区块，`<PulseStrip …>`）在 Quay tab 渲染一条脉搏条，是与下方 Loop pulse / Tests / Fan-in 三张图并存的第四套时间基；用户认为这条图的设计是错的。

做法（只做这件事）：
- 从 `QuayPanel.tsx` 删除 `PulseStrip` 的 import 与 `quay-panel-pulse` 区块，以及只为它存在的状态/回调（如 strip 的窗口状态、`onFocusTask` 接线），不留空 `div` 与多余的 `mb-3` 间隙。
- 下方三张图（Loop pulse、Tests、Fan-in）、其窗口选择器与布局**一律不动**，包括左右两列的排布。
- `src/modules/quay/PulseStrip.tsx`、`src/modules/quay/tests/PulseStrip.test.tsx`、`src/modules/quay/index.ts`、`src/modules/cockpit/CockpitStage.tsx` 不改。
- 删除 `QuayPanel.test.tsx` 里仅针对 Quay 面板内脉搏条的用例；其余用例不改。

## AC

- [ ] `QuayPanel.tsx` 不再引用脉搏条：`git grep -c "PulseStrip" -- src/modules/quay/QuayPanel.tsx || true` 无输出或输出 0，且 `git grep -c "quay-panel-pulse" -- src/modules/quay/QuayPanel.tsx || true` 同样为 0（代码与注释都不得再出现这两个字面量）。
- [ ] `npx vitest run src/modules/quay/tests/QuayPanel.test.tsx` exit 0，且含一例：渲染已加载快照后 `queryByTestId('quay-panel-pulse')` 为 null，Loop pulse / Tests / Fan-in 三张图仍在（`quay-gantt`、`quay-panel-tests-timeline`、`quay-panel-fanin-timeline`）。取假：把脉搏条区块加回去，该例必须红。
- [ ] 保留项不被碰：`git diff --stat -- src/modules/quay/PulseStrip.tsx src/modules/quay/tests/PulseStrip.test.tsx src/modules/quay/index.ts src/modules/cockpit/CockpitStage.tsx` 无输出；`npx vitest run src/modules/quay/tests/PulseStrip.test.tsx src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0。
- [ ] `npx tsc --noEmit -p tsconfig.json` exit 0。

## DoD

真实页面验证（AGENTS.md「UI 验证」）：隔离实例（`scripts/isolated-instance.sh`）里 MCP 浏览器打开真实项目的 Quay tab，PC 1440×900 与手机 390×844 各截图存 `tmp/` 并贴出，并用 `browser_evaluate` 贴出读数：`document.querySelector('[data-testid="quay-panel-pulse"]')` 为 null；顶栏（quay status / Refresh / Dashboard）与下方 Task ledger 之间没有空白间隙；三张图的位置与改动前一致。再在 cockpit 的 fleet 视图确认舰队卡片底部的脉搏条仍照常显示（贴截图）。再跑 `node scripts/ui-scenario.mjs` 中涉及 Quay tab 的场景（若存在）并贴 JSON 报告。fixture 单测只是必要条件，不算落地。

## Touches

- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- e2e/zz-quay-panel-mobile-grid.spec.ts
- tasks/gap-quay-tab-drop-pulse-strip.md
