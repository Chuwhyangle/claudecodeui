---
id: gap-running-spinner-60fps-after-layer-fix
title: 层数降到 21 后复评 60fps spinner：在 15Hz 成本包络内换回平滑旋转
status: todo
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

- [ ] AC1 复测矩阵：依赖任务完成、层数 ≤30 后，对同一 running 会话跑 5×10s CDP：15Hz SVG、60fps SVG、60fps wrapper。记录 total/main/GPU 中位与原始窗口到 Evidence；先打印三行读数再选方案。
- [ ] AC2 选择与实现：选择 total ≤ 15Hz + 2 点且 GPU ≤ 15Hz + 1 点的最平滑方案；如果 60fps 仍超出包络，保留 15Hz 并在 Evidence 记录原因。实现时保持 spinner 数量/图标/语义；wrapper 方案保留 `currentColor` 与尺寸。
- [ ] AC3 可见旋转与判据：选中的方案在真实页面仍有多个不同帧（元素截图）；CSS/组件测试 pin 住实际 timing（若 60fps 则无 steps，若保留 15Hz 则 steps(15)）；更新 `globalCssRules.test.ts` 等；`npm run typecheck`、`npm run lint`、架构棘轮 exit 0。
- [ ] AC4 线上 build 后复测：`npm run build:client` 后同一会话读数写入 Evidence，并与 15Hz 基线对照；若读数无法取得，park `needs-human` 并说明，不得推断。

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
