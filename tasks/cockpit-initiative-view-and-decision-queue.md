---
id: cockpit-initiative-view-and-decision-queue
title: M6 驾驶舱倡议视图 + 裁定队列（含联络自决的抽样审计）
status: ready
labels:
  - cockpit
  - initiative
  - ui
parent: null
children: []
extra: {}
depends_on:
  - observation-wall-ui
---
## Proposal

决策出处：用户 2026-10-24 同意的跨项目机制 M6——驾驶舱的倡议视图与裁定队列。倡议（跨仓库的一件事）由 quay-fleet 管理（fleet 任务 `fleet-initiative-store-and-cli`、`fleet-initiative-decision-attention-category`、`fleet-wall-uri-fleet-reserved-segment`）；人在组合层按倡议分配注意力，只裁定上报的问题。

前置：fleet 的上述三个任务落地、观察墙 `observation-wall-ui` 落地之后再做；接口以 fleet 落地的 `initiative show|list --json` 与 attention 类目为准。

方案：
1. **倡议视图**：驾驶舱新增「倡议」视图，每条活跃倡议一行，横跨参与项目：每个项目一格（该项目下的子任务进度与状态），格与格之间画依赖边（blocks / contract / release），阻塞的边高亮并显示阻塞时长；倡议的章程摘要、截止时间、退出条件可展开。倡议对象 `quay://fleet/initiative/<slug>` 可被焦点选中、钉到观察墙。
2. **裁定队列**：读取 `initiative-decision` 类目的上报，每条带问题、类型化选项、证据引用；裁定动作调用 `quay-fleet initiative decide`（by=human，kind=fact）并在预览确认后执行。
3. **抽样审计**：决策日志里 `kind ∈ {inference, llm}`（联络会话自决）的条目，按比例（配置项，默认 1/5）抽样进入裁定队列的「请抽查」分组，人可标「同意 / 有异议（附说明）」，异议回写为一条 human 决策并上报给相关联络会话。
4. 徽标与观察墙：裁定队列条数并入模式切换徽标；倡议阻塞超过阈值时自动浮现到观察墙。

## AC

- [ ] AC1: `npx vitest run src/modules/cockpit/tests/InitiativeView.test.tsx` exit 0——桩 `initiative list` 数据渲染每条倡议一行、每项目一格、依赖边；阻塞边高亮且显示时长；倡议 URI 可聚焦与钉选。
- [ ] AC2: `npx vitest run src/modules/cockpit/tests/DecisionQueue.test.tsx` exit 0——上报条目渲染类型化选项；确认后调用 decide 恰好一次且 by=human、kind=fact；未确认不调用；kind 为 inference/llm 的日志条目按配置比例进入抽查分组，「有异议」产生一条 human 决策调用。
- [ ] AC3: `npm run typecheck` 通过；文案覆盖 12 个 locale。

## DoD

- **浏览器实际操作 + 截图（必做，PC 与移动）**：以冷启动的 `cockpit-observation-wall` 倡议为真实数据，截图倡议视图与一条裁定的预览→确认。
- 隔离实例验证必须关闭常驻会话恢复。

## Touches

- src/modules/cockpit/InitiativeView.tsx
- src/modules/cockpit/DecisionQueue.tsx
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/cockpitView.ts
- src/modules/cockpit/index.ts
- src/modules/cockpit/tests/InitiativeView.test.tsx
- src/modules/cockpit/tests/DecisionQueue.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- server/modules/quay/quay-initiatives.ts
- server/modules/quay/quay.routes.ts
- server/modules/quay/tests/quay-initiatives.test.ts
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
- tasks/cockpit-initiative-view-and-decision-queue.md
