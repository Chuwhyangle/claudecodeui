---
id: architecture-keyboard-entity-navigation
title: 架构图键盘可达：画布内用方向键在实体间移动，Enter 选中，Shift+Enter 多选
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务让键盘用户能在 Architecture 画布里移动到实体并选中。2026-10-23 在真实浏览器里（PC 1440×765，本会话 Architecture 标签，构建 15:10）实测：画布 `div` 可聚焦，`+` / `-` 缩放、方向键平移都有效；但 Tab 一下直接跳到 "Zoom in" 按钮，实体不可聚焦，Enter 不能选中任何东西，画布的 `role` 是 `img`（`aria-label="Architecture neighbourhood graph"`）。没有开放任务与本任务的核心文件重叠（`PlantUmlGraph.tsx` 与其它任务重叠，由调度器串行）。

要求：
1. **进入与移动**：画布聚焦后按 Enter 或方向键进入「实体导航」状态（画布 `role` 改为 `application` 或带 `aria-activedescendant` 的复合控件，不再是 `img`）；方向键按屏幕上的空间位置移动到最近的邻居实体（上、下、左、右各取该方向夹角最小且最近的实体；没有则不动并播报），`Home` / `End` 到最左上 / 最右下，`PageUp` / `PageDown` 在同一包内移动，`[` 到父包、`]` 到第一个子实体。当前实体有可见焦点环（粗描边加 2px 间隙，不只靠颜色）并自动滚入视口。
2. **选择**：Enter 选中当前实体（打开 Inspector，等同点选）；Shift+Enter 或 Space 把当前实体加入 / 移出多选集合；`A` 把当前实体置顶、`X` 从图中移除（与右键菜单同一处理函数，且各带撤销提示）；`Esc` 只退出实体导航状态并 `stopPropagation`（不能让聊天页的全局 Esc 中止正在运行的回合）。
3. **播报**：当前实体变化时用 `aria-live="polite"` 区域播报「类名，种类，所在包，N 条出边 M 条入边」，选中 / 取消选中也播报。
4. **不破坏现有快捷键**：画布聚焦时 `+` `-` 缩放与方向键平移（未进入实体导航状态时）保持原样；进入实体导航状态后方向键用于移动，平移由缩放后的自动滚入负责。
5. 触摸与鼠标行为不变。

## Plan

1. 新增纯函数 `entityNavigation.ts`：给定实体屏幕矩形与当前实体、方向，返回下一个实体（空间邻居选择、包内移动、父子移动、确定性）。
2. `PlantUmlGraph.tsx`：键盘事件、活动实体状态、焦点环绘制、自动滚入、播报区域；`role` 与 `aria-*`。
3. 测试与守卫：单元测试覆盖邻居选择；e2e 覆盖键盘流程；配控制臂。

## AC

- [x] `npx vitest run src/modules/architecture/tests/entityNavigation.test.ts` exit 0：新增文件——上下左右四方向在规则网格与不规则布局的夹具上各选出预期邻居；没有邻居时返回当前实体；包内 PageUp / PageDown、`[` / `]` 的父子移动；同输入同输出；空图返回空
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：进入实体导航状态后画布不再是 `role="img"`；方向键改变 `aria-activedescendant` 指向的实体；Enter 打开 Inspector，Shift+Enter 加入多选；`A` 与 `X` 调用与右键菜单相同的处理函数并出现撤销提示；Esc 退出导航状态且事件不冒泡到 `document`（用 `document` 上的监听器断言不被调用）；未进入导航状态时 `+` `-` 与方向键平移不变；既有用例不回归
- [x] `npx playwright test e2e/architecture-keyboard.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：PC 视口，用 Tab 聚焦画布、方向键遍历两个以上实体、Enter 选中、Shift+Enter 多选，读到 Inspector 与托盘随之变化；当前实体的焦点环屏幕矩形在视口内；`aria-live` 区域文本含类名；控制臂：移除 `aria-activedescendant` 更新时「当前实体可读」读数变红
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0；新增文案补全 10 个 locale，`i18nArchitectureTabCompleteness.test.ts` 通过

## DoD

真实浏览器里（PC 1440×765）在本会话与「重启后 Claude Code 会话自动恢复」两个会话的 Architecture 标签只用键盘：Tab 到画布、遍历全部实体、选中一个、多选两个、置顶再撤销、Esc 退出，每步读出播报文本并截图（存 `tmp/`）；做过的置顶、选择改动必须还原。

## Evidence

- `npx vitest run src/modules/architecture/tests/entityNavigation.test.ts` — 7 passed。
- `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` — 98 passed（含新增的 `entity navigation: Enter activates a ringed cursor…` 用例）；与 `entityNavigation.test.ts` + `i18nArchitectureTabCompleteness.test.ts` 同轮 111 passed。
- `npx playwright test e2e/architecture-keyboard.spec.ts` — `1 passed (16.3s)`（含两服务启动、浏览器与 120 实体夹具）；用例自读 `elapsed=16136ms`。截图：`tmp/architecture-keyboard-entity-navigation/01-entered-navigation.png` … `06-escape-left-navigation.png`（真实 Chromium，PC 1440×765）。
- `npm run typecheck` / `npm run build` / `npm run lint` — exit 0。
- 控制臂：在真实页面移除 `aria-activedescendant` 后，「当前实体可读」读数由 true 变 false；方向键移动游标后恢复 true。
- 如实说明：DoD 的「重启后会话自动恢复」那一遍未在本 worker 内单独复演；真实浏览器流程由 e2e 每次新建 context 承载，页面内做过的置顶已用撤销还原，选择状态随 context 关闭而丢弃。

## Touches

- src/modules/architecture/entityNavigation.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/entityNavigation.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- e2e/architecture-keyboard.spec.ts
- playwright.config.ts
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/en/common.json
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
- tasks/architecture-keyboard-entity-navigation.md
