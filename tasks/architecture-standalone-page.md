---
id: architecture-standalone-page
title: 架构图独立页：新标签页打开整屏架构图，筛选与置顶跨标签同步，可从独立页发回会话
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
depends_on:
  - architecture-fullscreen-view
---
## Proposal

<!-- dedup-ref -->本任务增加「在新标签页打开架构图」：一个只渲染架构面板的整屏路由，便于放到第二块屏幕或分享链接。路由目前只有 `/`、`/session/:sessionId`、`/cockpit` 等，Architecture 标签没有深链；`/cockpit` 是已有的独立页先例。它建立在页内全屏之上（复用其布局与退出之外的全部行为），不改变页内全屏的行为。

要求：
1. **路由**：新增 `/session/:sessionId/architecture`（挂在现有路由基址之下），只渲染架构面板（无侧栏、无标签栏），画布铺满视口；工具栏增加 "Open in new tab" 按钮（页内与全屏里都有），点击用 `window.open` 在新标签打开当前会话的该路由并带上当前视图的深链参数。
2. **深链参数**：`?view=class|file`、`scope=<数字>`、`detail=core|common|all`、`entity=<实体 id>`（打开时选中并居中该实体）、`mode=neighbourhood`。参数只决定首次打开的状态，之后的变化不回写地址栏；参数非法时忽略并用该项目已存的状态。
3. **状态共享**：筛选、范围、详情、置顶与排除等本来就按项目存在 `localStorage`（键含项目 id），新标签页直接读取；两个标签同时打开时，任一方的置顶 / 排除 / 筛选改动通过 `storage` 事件在另一方 1 秒内反映到画面与 Adjusted 计数。选择（当前选中的实体）不跨标签共享。
4. **发回会话**：独立页里的「Put in chat input」不能直接写聊天输入框；改用 `BroadcastChannel('cloudcli-architecture')` 把消息发给同一会话的主标签，主标签收到后把文本追加到输入框草稿并切到 Chat（行为与页内同名按钮一致），并向独立页回一条确认；没有主标签响应（1.5 秒内无确认）时回退为复制到剪贴板并提示。
5. **返回**：独立页顶部有一个不遮挡画布的 "Back to session" 入口（切换到同会话的主页面，已关闭则在当前标签导航）。
6. 认证沿用现有登录；未登录时走现有重定向。

## Plan

1. `App.tsx`：新路由与路由组件（只渲染架构面板与上述入口）。
2. 新增 `architectureDeepLink.ts`：深链参数的解析与生成（纯函数）。
3. `ArchitecturePanel.tsx`：按钮、深链初始状态、`storage` 事件同步、`BroadcastChannel` 发送与接收。
4. 主标签侧：接收消息并写入输入框草稿（经 chat 模块的 barrel 暴露的能力）。
5. 文案：10 个 locale；测试与守卫。

## AC

- [x] `npx vitest run src/modules/architecture/tests/architectureDeepLink.test.ts` exit 0：新增文件——参数解析与生成互逆；非法值被忽略；未知参数被忽略；`entity` 含特殊字符时正确编码；同输入同输出
- [x] `npx vitest run src/modules/architecture/tests/standalonePage.test.tsx` exit 0：新增文件——路由渲染无侧栏的面板；深链参数决定首次状态；`storage` 事件触发后 1 秒内画面与 Adjusted 计数更新；发回会话在有确认时不复制、1.5 秒无确认时回退复制并提示；"Open in new tab" 调用 `window.open` 的参数含当前视图的深链
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：十个 locale 的新增文案齐全
- [x] `npx playwright test e2e/architecture-standalone.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：同一浏览器上下文开两个页面（主页面与新开的独立页）——独立页画布宿主矩形等于视口、无侧栏；在独立页置顶一个实体，主页面 Adjusted 计数 1 秒内变为 1；在独立页选中实体并点「Put in chat input」，主页面输入框出现该文本且切到 Chat；关闭主页面后再点，剪贴板得到该文本；测试结束前清空输入框草稿并撤销置顶；控制臂：断开 `BroadcastChannel` 时输入框读数变红
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/` exit 0

## DoD

真实浏览器里（PC）从本会话的 Architecture 标签点 "Open in new tab"，在新标签里置顶一个实体、选中两个实体点「Put in chat input」，回到主标签读出 Adjusted 计数与输入框内容；再关闭主标签重试一次得到剪贴板回退；带 `entity=` 深链直接打开并确认居中选中。每步截图（存 `tmp/`）；过程中做过的任何置顶与输入框草稿必须还原。

## Touches

- src/App.tsx
- src/modules/architecture/architectureChatBridge.ts
- src/modules/architecture/architectureDeepLink.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/index.ts
- src/modules/architecture/tests/architectureDeepLink.test.ts
- src/modules/architecture/tests/standalonePage.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/modules/project-workspace/WorkspaceMain.tsx
- e2e/architecture-standalone.spec.ts
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
- tasks/architecture-standalone-page.md
