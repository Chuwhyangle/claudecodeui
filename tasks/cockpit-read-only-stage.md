---
id: cockpit-read-only-stage
title: 驾驶舱 1/2：/cockpit 顶层只读舞台（项目条 + 视图描述 + 吸附焦点 + 确定性意图）
status: ready
labels:
  - cockpit
  - ui
  - wall
parent: null
children: []
extra: {}
depends_on:
  - quay-wall-addressable-view-and-input-package
---
## Proposal

决策出处：用户 2026-10-23 确认——驾驶舱作为 CloudCLI 的**新顶层机制**（与项目 / 会话平级，不是某会话里的 tab），第一步做「只读舞台 + 按住说话 + 焦点路由」。本任务是其中的**只读舞台**；按住说话与焦点路由在 `cockpit-push-to-talk-and-focus-routing`（depends-on 本任务）。

驾驶舱与会话的区别：核心状态是焦点 / 当前视图 / 托盘，不是一条对话记录；LLM 只是调度部件（本任务完全不用 LLM）；它只看、指、路由，不干活。

方案：
1. **新顶层路由 `/cockpit`**（`src/App.tsx` 加 Route；新模块 `src/modules/cockpit/`，经 barrel 引用其他模块）。布局：左侧**项目条**（所有 quay 项目一格一格，数据来自既有 `GET /api/quay/fleet-summary`）+ 右侧**舞台**（一次显示一个视图）+ 底部状态条（焦点对象的 URI 与标签）。
2. **视图描述**：`{type, params}`，可序列化、可当 URL（`/cockpit?view=board&project=<id>`），有历史（后退回上一个视图）。本任务先落两种视图：
   - `fleet`：全部项目磁贴（状态、在途数、需要人的数量）。
   - `board`：单个项目的任务板 / 在途任务，数据来自既有 `GET /api/quay/:projectId/snapshot`，复用 quay 模块的在途磁贴（经 `@/modules/quay` barrel）。
3. **视图契约**：两种视图的每个可点对象都按 A/B 片落地的契约声明 `{uri,label,display}`（项目 = `quay://<project>/board`，任务 = `quay://<project>/task/<id>`），带可见序号标签。**焦点**用方向键在声明的元素间吸附移动（手柄以后接到同一个 `move(dir)` 接缝），Enter = 放大进入（项目 → board），Backspace/Escape-外的「返回」键 = 回上一视图。注意：别用全局 Escape（会中止正在运行的会话轮次）。
4. **快速路径意图（确定性，无 LLM）**：一个纯函数 `parseCockpitIntent(text, visible)`，覆盖「看 / 打开 <项目名>」「<项目名> 任务板」「第二个 / ② / 红的那个」（复用 A/B 片的确定性解析）、「放大」「返回」「全部项目」。未命中返回 `unmatched`，界面如实显示「未识别」，不猜。本任务里意图只能从文本框输入（语音在下一个任务接进来，走同一个函数）。
5. **延迟读数**：意图解析到视图首次渲染完成的耗时记入 `timings`，供以后的场景运行器读取。

## AC

- [ ] AC1: `npx vitest run src/modules/cockpit/tests/cockpitIntent.test.ts` exit 0——「看 claudecodeui」「打开 quay-fleet 任务板」→ board 视图且 project 正确；「第二个」「②」在给定可见集上命中唯一对象；「放大」「返回」「全部项目」各自映射正确；不在项目列表中的名字、闲聊句返回 `unmatched`；整个函数无网络 / LLM 调用。
- [ ] AC2: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——fleet 视图对每个项目声明 `quay://<project>/board` 可聚焦元素，带序号标签；方向键移动焦点按空间序吸附且不越界；Enter 在项目上进入该项目的 board 视图；返回键回到 fleet；视图描述与 URL 互相往返一致。
- [ ] AC3: 同一测试文件——board 视图里在途任务按 `quay://<project>/task/<id>` 声明；快照请求失败时舞台显示错误状态而不是空白，且焦点不丢失到页面外。
- [ ] AC4: `npm run typecheck` 通过；quay 模块既有测试（`src/modules/quay/tests/QuayPanel.test.tsx`）原样通过。

## DoD

- **MCP 浏览器实际操作 + 截图（必做）**：在真实运行的 CloudCLI 上打开 `/cockpit`，截图 fleet 视图（≥ 2 个真实项目）、用方向键 + Enter 进入一个项目的 board 视图后再截图、在文本框输入「看 <另一个项目>」后截图；截图存仓库 `tmp/`；用 `browser_evaluate` 读回当前焦点 URI 与可见集，与截图一致。
- 若 `ui-scenario-driver-semantic-surface` 已落地，补一个场景 JSON 并贴运行器报告；未落地则如实写明。
- 记录「文本意图 → 视图首帧」的实测延迟。

## Notes

文案键按仓库惯例覆盖全部 12 个 locale，并照 `src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts` 的样式加驾驶舱文案完整性测试（只在 1/2 任务里加一次，2/2 任务扩展同一测试）。

## Touches

- src/App.tsx
- src/modules/cockpit/index.ts
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/cockpitIntent.ts
- src/modules/cockpit/cockpitView.ts
- src/modules/cockpit/hooks/useCockpitFocus.ts
- src/modules/cockpit/tests/cockpitIntent.test.ts
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/quay/index.ts
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
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- tasks/cockpit-read-only-stage.md
