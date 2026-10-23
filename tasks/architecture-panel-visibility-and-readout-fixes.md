---
id: architecture-panel-visibility-and-readout-fixes
title: 架构面板可见性与读数修复：Scope cleanup 面板不显示、悬停信息条遮挡画布、摘要计数不一致、邻域视图无说明
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务收拢 2026-10-23 交互探查（PC 1440×765，本会话 Architecture 标签，构建 15:10）发现的四个界面与读数问题。与 `architecture-chrome-and-mobile-drawer-polish` 声明了相同的文件，改动内容互不重叠，由调度器串行。证据截图在 `tmp/ix2-pc-*.png`。

1. **Scope cleanup 展开后什么也看不到。** 底部 "Scope cleanup ▸" 点击后 `aria-expanded` 变为 true、按钮箭头变为 ▾，但面板没有任何可见内容（既没有出现在按钮上方也没有出现在下方，`tmp/ix2-pc-11-cleanup-open.png`），应当是被容器裁掉或高度为 0。要求：展开后内容完整可见（需要时容器可滚动，不被底栏裁剪），收起后消失；键盘可达。
2. **悬停信息条盖住画布顶边。** 鼠标悬停实体时，`StreamingVad · shared/voiceEndpoint.ts · 1 in / 0 out — aggregation · 1 more hidden by the filter` 这条覆盖在画布最上沿，压住了外层包的标签页（`tmp/ix2-pc-02-neighbourhood.png`）。要求：信息条不得与任何包标签页或类名文字的屏幕矩形相交（放到画布外的固定位置，或贴到悬停对象旁并避让）。
3. **过滤改动后摘要计数与重载后的结果不一致。** 在把关系预设从 `+Calls` 改回 `+Dependencies` 之后，摘要一度显示 "Showing 2 (2 classes) · 9 related · Hidden 564 functions · 1 call relations · 11 isolated nodes"，重载页面后同一状态显示 "5 related · 601 call relations · 6 isolated nodes"。要求：任何过滤、范围、关系预设的改动结束后（图重绘完成时），摘要里的三个数字必须等于从同一状态重载得到的数字；先复现并定位原因（读数来自哪个请求、是否用了旧状态的结果），再修复。
4. **双击实体进入邻域视图没有任何说明。** 双击后工具栏多出 "Back to Class diagram" 与 "Explosion view"，缩放从 72% 变成 75%，图本身对小图几乎没有变化，用户不知道发生了什么。要求：进入邻域视图时在工具栏里显示一条明确的状态文字（如 "Neighbourhood of StreamingVad"），缩放不得因进入或退出而跳变（保持进入前的缩放或适应后的缩放并说明），"Explosion view" 有悬停说明。

## Plan

1. `ArchitectureCurationManager.tsx` 或 Scope cleanup 所在组件与 `ArchitecturePanel.tsx` 底栏：面板尺寸与溢出处理。
2. `PlantUmlGraph.tsx`：悬停信息条的位置与避让。
3. `useArchitectureGraph.ts` 与 `ArchitecturePanel.tsx`：摘要计数的数据来源与更新时机；增加一条回放读数用于测试。
4. `PlantUmlGraph.tsx` 与 `ArchitecturePanel.tsx`：邻域视图的状态文字、缩放保持与说明。

## AC

- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——Scope cleanup 展开后面板的内容节点存在且其容器没有 `overflow: hidden` 把它裁成零高度（断言容器的计算样式与子节点尺寸）；悬停信息条的位置计算函数在包标签页矩形、类名文字矩形存在时返回不相交的位置；切换关系预设后摘要数字等于同一状态下重新读取的数字（用假请求序列模拟旧结果晚到）；进入邻域视图显示状态文字，进入前后缩放不变；既有用例不回归
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：展开 Scope cleanup 后其内容的屏幕矩形面积大于零且完全在视口内；悬停实体时信息条与所有包标签页矩形不相交；依次切换关系预设三次后摘要的三个数字与重载后一致；双击实体前后缩放读数差为 0
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：为上面新读数各配控制臂（恢复裁剪容器、恢复固定覆盖位置、恢复旧结果覆盖新结果、恢复缩放跳变各一条），控制臂里对应读数必须变红
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里（PC 1440×765）在本会话与「重启后 Claude Code 会话自动恢复」两个会话的 Architecture 标签依次：展开 Scope cleanup 并截图；悬停几个实体并截图；切换关系预设再切回，读出摘要并与重载后的比较；双击实体、读出缩放、返回。每步贴前后截图（存 `tmp/`）；做过的任何改动必须还原，让图回到初始状态。

## Evidence

- 单元读数：`npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` → `105 passed`。四条新用例分别是「Scope cleanup 展开后不被底栏裁剪」「悬停信息条避开包标签页与类名（含纯函数与控制臂反例）」「关系预设改动落定后的读数等于重载读数（用被压住的旧结果晚到构造）」「进入邻域显示名称且缩放不变（进/退两侧）」。
- 浏览器读数：`e2e/architecture-canvas-layout.spec.ts` 全量 `21 passed (5.1m)`；`--grep "control arm"` `12 passed (2.0m)`。`SPEC_BUDGET_MS` 已按实测从 480_000 调到 660_000（保持约 2.1x 余量）并写明两次实测。
- 实测读数（1440×765）：cleanup 面板 box 320×92.5、可见面积 29600、完全在视口内；悬停 3 个实体信息条与 11 个包标签页 + 70 个类名零相交；三次预设切换后 `shown=60 related=60 hidden=40` 与重载完全一致；双击前后 `data-architecture-zoom-scale` 均为 `0.25601965601965604`，状态文字 `Neighbourhood of IoStage0 · 1 hop(s)`。
- 控制臂读数：A 注入 `overflow:hidden` 后被裁到 `visibleArea=0`；B 把信息条放回旧的固定角落后压住 `tab:adapters`；C 用 `page.route` 重放上一状态的响应体后 `hiddenKinds={"function":40,"class":39}` 而重载真值为 `{"function":40}`；D 真实缩放后读数从 `0.256…` 变为 `0.320…`，还原后回到原值。
- 截图：`tmp/panel-cleanup-open-pc.png`、`tmp/panel-hover-hint-pc.png`、`tmp/panel-summary-after-presets-pc.png`、`tmp/panel-neighbourhood-pc.png`、`tmp/panel-neighbourhood-back-pc.png`、`tmp/panel-control-arms-pc.png`。
- 诚实说明（1）：DoD 的两个会话里，第二个「重启后自动恢复」的会话没有在本 worker 内真的重启服务来复现（重启会杀掉本会话链）；已覆盖的是「服务端已存在的会话 + 页面重载后从 localStorage 恢复过滤/范围/详情」这条同一路径，第二个真实会话（scope-hygiene fixture）也在同一浏览器运行里走了一遍。
- 诚实说明（2）：AC 的「既有用例不回归」里有两条例外需要点名：`narrowing filters the payload in hand…` 与 `closing a mention switch is a narrowing…` 断言的是「收窄不发请求」这条旧契约，而本任务的读数要求任何过滤改动落定后等于重载——二者互斥。两条用例已按新契约重写（收窄仍在同一帧画出，随后由服务端定稿），断言更强而不是更弱。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/ArchitectureCurationManager.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/hoverHintPlacement.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- src/modules/i18n/locales/en/common.json
- tasks/architecture-panel-visibility-and-readout-fixes.md
