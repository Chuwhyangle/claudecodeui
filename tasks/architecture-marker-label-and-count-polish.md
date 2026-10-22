---
id: architecture-marker-label-and-count-polish
title: 小修复：种子圆点画到节点上、「保持显示」复选框的无障碍名与可见文字一致、读数「相关」数不随切换路径漂移、筛选角标不把「保持显示」算成隐藏
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-23 在新构建（`HEAD` `5189f5d4a`）的真实页面上复测发现四处互相独立的小缺陷，改动都小，合成一条。

1. **种子圆点画错位置**：轻形式种子标记的圆点（`arch-seed-dot`）在 `PlantUmlGraph.tsx` 第 615 行附近用固定的 `cx=4`、`cy=4` 插进节点 `<g>`，但节点的几何是绝对坐标（`rect` 自带 x/y，没有 `translate`），所以 `(4,4)` 就是 SVG 原点：37 个种子的 37 个圆点全在同一个位置（距画布左上 `(13,13)`），画面左上角出现一个孤零零的橙点，并且把每个节点分组的包围盒撑到原点（节点组盒从 `[13,13,…]` 开始，影响命中与缩略图包围盒）。修法：圆点的 `cx/cy` 取该节点第一个 `rect` 的 `x/y` 加固定内偏移；同一函数里的 pin 角标（`arch-pinned-badge`）按同样方式核对，若同样错位一并修；加一个纯函数 `markerAnchor(rect)` 便于测试。
2. **「会话里提到的」复选框的无障碍名与可见文字不一致**：可见文字是 `35 functions`，`aria-label` 却是 `functions: 35`（WCAG「可见标签应包含在无障碍名里」）。修法：无障碍名以可见文字开头（如 `35 functions，会话里提到的，即使该种类被隐藏也保持显示`），补充说明放 `aria-describedby`；同一处的类、接口、抽象类等行一并处理。
3. **读数里「相关」数在同一状态下不一致**：默认读 `· 5 related`，打开再关掉「保持显示函数」后同一状态读 `· 40 related`（客户端本地收窄沿用了旧的总数，`ArchitecturePanel.tsx` 里 `readout.relatedText` 的来源）。修法：M 只由「当前响应的节点集合经当前筛选后的结果」决定，与到达该状态的路径无关；同一筛选同一数据必须读出同一个数。
4. **筛选角标「Hiding N」把「保持显示」算成隐藏**：`elementRelationFilter.ts` 的 `activeFilterCount` 末尾 `+ filter.keepMentionedKinds.length`，所以打开「保持显示函数」（显示更多）后角标从 4 变成 5，与「Hiding」的含义相反。修法：`activeFilterCount` 只数「正在隐藏东西的选项」；保持显示的数量单独表达（角标写「Hiding 4 · keeping 1」，或 `title`/`aria-label` 里单列），打开「保持显示」不得使「隐藏中」增加。

## AC

- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：多个轻形式种子节点的圆点各自位于所属节点矩形内（不同节点的圆点坐标不同），节点组的包围盒不延伸到 SVG 原点；pin 角标位于所属节点内；「会话里提到的」复选框的 `aria-label` 以可见文字开头；同一筛选下「打开再关闭保持显示」前后读数里的相关数相同；打开「保持显示」后角标的隐藏数不增加且保持显示数被单独表达
- [x] `npx vitest run src/modules/architecture/tests/elementRelationFilter.test.ts src/modules/architecture/tests/readoutNumbers.test.ts` exit 0：`activeFilterCount` 在 `keepMentionedKinds` 非空时与为空时的隐藏数相同；`markerAnchor` 纯函数用例；相关数由「响应节点集合经筛选」决定的用例（先全量后收窄与直接取同一筛选的读数一致）
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器打开 claudecodeui 项目的本会话 `c5a57036-de6c-482e-9078-d5572e528ef5` 的 architecture tab：在筛选弹层打开「保持显示函数」，37 个种子圆点分别落在各自节点上，画布左上角不再有孤零零的橙点；角标不从 4 变 5；关掉后读数回到 `· 5 related`；读屏朗读复选框时先读出 `35 functions`。贴圆点坐标读数与前后截图。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/elementRelationFilter.ts
- src/modules/architecture/readoutNumbers.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/elementRelationFilter.test.ts
- src/modules/architecture/tests/readoutNumbers.test.ts
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- tasks/architecture-marker-label-and-count-polish.md
