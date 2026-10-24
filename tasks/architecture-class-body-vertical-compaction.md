---
id: architecture-class-body-vertical-compaction
title: 架构图类框纵向压缩：低档位隐藏成员行时类框高度随之收紧，不留大片空白
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->2026-10-24 在真实浏览器里探查 Architecture 标签（PC 1440×765，会话 f9602ca3 的 55 实体 L 图，全屏截图 `tmp/ux-08-L-fullscreen.png`）：低档位下类框的成员行文字已隐藏，但框高仍按完整成员列表计算，类框主体出现大片空白，整幅图被无谓拉高，Fit 求得的比例也随之变小。已检索 `architecture-*` 的 todo / ready 任务，没有任何一个与本任务共用 Touches，故单独立项；与已完成的 `architecture-semantic-zoom-layout`（建立档位与轴求解器）、`architecture-single-scale-fit-contract`（Fit 求解）不是同一机制，它们的行为保留。

要求：
1. 在应用侧（不依赖上游 plantuml-js 的 `memberMaxRows` / `sourceModel`，上游以后提供时可再消费，本任务不等待它）对成员文字被隐藏的类框做纵向压缩：当显示比例达到该档位阈值的 90% 及以上、且该类的成员行不渲染时，类框高度收紧为标题区高度加分隔线高度，不再包含成员行占位。
2. 改动落在 `semanticZoomLayout.ts` 的轴求解器（纵向轴上各实体高度作为输入）与 `semanticZoomPlan.ts` 的 `planMemberRows`（决定哪些成员行可见）之间的接口：`planMemberRows` 给出"该类在当前比例下是否显示成员行"，轴求解器据此取压缩高度；比例在阈值 90% 前后高度单调不增，避免档位切换瞬间跳动。
3. 压缩后同一列、同一层的相邻实体不得重叠，边的端点仍落在框边界上；有成员行可见的类框高度不变。
4. 纯函数、同输入同输出，不引入新的全局状态。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomLayout.test.ts` exit 0：新增用例——B 档与 A 档过渡区间（比例 ≥ 阈值 90%）内，成员被隐藏的类框高度 ≤ 标题高度 + 分隔线高度；成员可见的类框高度等于原完整高度；压缩后同层相邻实体矩形两两不相交（容差 0.5px）；同输入同输出；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomPlan.test.ts` exit 0：`planMemberRows` 对"成员行是否显示"的判定与压缩高度一致；比例在阈值 90% 两侧高度单调不增；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：用 55 实体合成夹具在 B 档渲染，读数 `data-architecture-*` 类框高度不含成员占位，Fit 求得的比例不小于压缩前
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/` exit 0

## DoD

真实浏览器（MCP 浏览器）里，PC 1440×765 打开 claudecodeui 的 55 实体 L 会话 Architecture 标签，进入全屏，亲手走一遍：缺省、Fit、缩放到 B 档与 A 档过渡区间、拖动与点选，读出压缩前后类框高度与 Fit 比例，确认没有大片空类框主体、没有重叠；截图存 `tmp/`（含与 `tmp/ux-08-L-fullscreen.png` 的前后对照）并贴进 Evidence。仓库里若存在 Architecture 场景，另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；不存在则在 Evidence 里写明。任何临时改动必须还原。遵循 `.agents/skills/frontend-module-standards`。

## Touches

- src/modules/architecture/semanticZoomLayout.ts
- src/modules/architecture/semanticZoomPlan.ts
- src/modules/architecture/tests/semanticZoomLayout.test.ts
- src/modules/architecture/tests/semanticZoomPlan.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-class-body-vertical-compaction.md
