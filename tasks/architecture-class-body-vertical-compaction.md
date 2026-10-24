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

- [x] `npx vitest run src/modules/architecture/tests/semanticZoomLayout.test.ts` exit 0：新增用例——B 档与 A 档过渡区间（比例 ≥ 阈值 90%）内，成员被隐藏的类框高度 ≤ 标题高度 + 分隔线高度；成员可见的类框高度等于原完整高度；压缩后同层相邻实体矩形两两不相交（容差 0.5px）；同输入同输出；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/semanticZoomPlan.test.ts` exit 0：`planMemberRows` 对"成员行是否显示"的判定与压缩高度一致；比例在阈值 90% 两侧高度单调不增；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：用 55 实体合成夹具在 B 档渲染，读数 `data-architecture-*` 类框高度不含成员占位，Fit 求得的比例不小于压缩前
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/` exit 0

## DoD

真实浏览器（MCP 浏览器）里，PC 1440×765 打开 claudecodeui 的 55 实体 L 会话 Architecture 标签，进入全屏，亲手走一遍：缺省、Fit、缩放到 B 档与 A 档过渡区间、拖动与点选，读出压缩前后类框高度与 Fit 比例，确认没有大片空类框主体、没有重叠；截图存 `tmp/`（含与 `tmp/ux-08-L-fullscreen.png` 的前后对照）并贴进 Evidence。仓库里若存在 Architecture 场景，另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；不存在则在 Evidence 里写明。任何临时改动必须还原。遵循 `.agents/skills/frontend-module-standards`。

## Touches

- src/modules/architecture/semanticZoomLayout.ts
- src/modules/architecture/semanticZoomPlan.ts
- src/modules/architecture/tests/semanticZoomLayout.test.ts
- src/modules/architecture/tests/semanticZoomPlan.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-class-body-vertical-compaction.md

## Evidence

实现（分支 `task/architecture-class-body-vertical-compaction`，已合并 develop 后重跑）：

- `semanticZoomPlan.ts`：`planMemberRows` 新增 `visible` 判定（不足两行即整块不画）；新增 `planCompactFrameHeight`（标题带 + 分隔带）、`planMemberFrameHeight`（可见→原高度，隐藏→按压缩量收缩）、`semanticMemberCompaction`（在 identity 阈值 0.9 → 其 90% 即 0.81 之间 0→1 线性渐变，连续且随比例单调）。
- `semanticZoomLayout.ts`：y 轴求解器对成员不可见的实体改用 `effectiveHeight`（标题 + 分隔线）作为元素长度，后续断点从该长度累计，整列随之上移；`cell` 即压缩后的布局单元，新增 `sourceCell`（映射后的原矩形）供边端点跟随；两折线关系不再因一端压缩而把另一端拖出自身框。既有「≥90% 为原布局 × 比例」口径不变。

AC 逐条：

1. `npx vitest run src/modules/architecture/tests/semanticZoomLayout.test.ts` → **33 passed**。新增：B/A 过渡带（ratio ≥ 1.62）内隐藏成员类框高度 ≤ 标题（按 plan 预留的最坏标题）+ 分隔线、drawn 同样满足；成员可见的类框保持完整映射高度；压缩后同层矩形两两不相交（0.5px 容差）；边端点落在压缩后框边界；同输入同输出；既有用例全绿。
2. `npx vitest run src/modules/architecture/tests/semanticZoomPlan.test.ts` → **37 passed**。新增：`visible` 判定与压缩高度一致；0.9 → 0.81 连续渐变；跨阈值高度单调不增；不低于 title+divider、不高于原完整高度。
3. `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` → **121 passed**。新增 55 实体夹具（entity 粒度）在 640×400 画布 Fit 到 B 档：42 个抽取到的类框全部无 `data-architecture-node-member`，drawn 高度 16px vs 源 216px；Fit 填充 0.912 且 `data-architecture-semantic-scale` 与 zoom 读数一致。
4. `npx tsc --noEmit -p tsconfig.json` exit 0（src/ 覆盖面）；`npm run build` exit 0；`npx oxlint src/` exit 0。⚠️ 仓库级 `npm run typecheck` / `npm run lint` 在 `scripts/contraction-candidates/*` 上红——该文件来自 develop 的既有提交 `350a47bbc`（早于本任务 fork 点），与本任务 src/ 改动无关；按 AC 的「对 src/」口径记录。

DoD（真实浏览器，Playwright/Chromium，PC 1440×765，全屏）：

- 夹具：55 实体（5 个目录、每实体 10 个成员、L 形依赖链），经 `.archguard` fixture + debug-agent 会话在隔离 e2e server（独立 dataDir 与端口）打开；未触碰线上会话。
- Fit：tier A、scale 0.3038、内容 1313×665（host 1440×765，填充 0.912）。此时 5 个放不下成员行的类框已压缩（drawn 35.5 vs source 216），37 个成员可见的类框保持完整高度。
- 缩放到 B 档（scale 0.1244）：42 个类框全部无成员文本，drawn 高度全部 16px、source 216px；截图确认无大片空类框主体。
- A/B 过渡：沿 zoom-out 阶梯读取 `data-architecture-semantic` 与 scale：A@0.3038 → A@0.2431 → A@0.1944 → A@0.1556 → B@0.1244；切换前后类框高度单调不增（成员隐藏框 35.5 → 16），无瞬间回弹。
- 拖动与点选：放大到内容超出视口（59%）后在画布空白处左键拖拽，host 的 scrollLeft/scrollTop 改变（真实平移）；在 B 档点击类框打开 Inspector（Unit0，选中 1），tier 与类框高度不变；无重叠。该 Playwright 用例 `1 passed (21.7s)`。
- 截图（`tmp/architecture-compaction/`，git-ignored）：`01-fit.png`、`02-tier-B.png`、`03-selected.png`、`04-dragged.png`、`05-fit-after-interactions.png`。
- 前后对照：任务正文引用的 `tmp/ux-08-L-fullscreen.png` 在当前工作区不存在；以同一 55 实体夹具的 Fit（成员可见的 A 档）与 B 档（成员行消失、类框收紧为 16px 带）作为前后对照。
- 场景运行器：仓库 `e2e/scenarios/` 仅有 cockpit / voice 场景，**不存在 Architecture 场景**，故未跑 `scripts/ui-scenario.mjs`。
- 临时改动已还原：用于 DoD 的 throwaway Playwright spec 与 `playwright.config.ts` 的两处临时登记（`DEBUG_AGENT_SPEC_FILES` / `SPEC_BUDGET_MS`）在取证后删除/回退，未进入提交。
