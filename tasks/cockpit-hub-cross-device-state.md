---
id: cockpit-hub-cross-device-state
title: 驾驶舱中枢：服务端持有焦点/视图/托盘/待确认发送（纯函数 reducer + 语义事件 + 多设备订阅）
status: ready
labels:
  - cockpit
  - contract
parent: null
children: []
extra: {}
depends_on:
  - cockpit-push-to-talk-and-focus-routing
  - quay-uri-project-segment-is-fleet-registry-id
  - cockpit-stage-visual-attention-fixes
---
## Proposal

决策出处：用户 2026-10-23 确认的跨端方向——PC 浏览器拿不到持续的**输入焦点**（全局热键、后台窗口的按键与手柄事件都到不了页面），因此把**输入与输出拆开**：桌面浏览器只做显示端（只需可见、不需焦点），输入交给始终在手上的设备（先做手机遥控器，桌面后台进程往后放）。三种形态都依赖同一个前提：驾驶舱状态不能只活在某个标签页里。本任务建这个**驾驶舱中枢**，并按用户确认把「焦点状态改成纯函数」并入。

现状：`cockpit-read-only-stage` 的焦点是 `src/modules/cockpit/hooks/useCockpitFocus.ts` 里的 `useState`，视图在 URL 里，托盘与待确认预览在 `cockpit-push-to-talk-and-focus-routing` 里也是页面内状态。服务端已有一半底座：`ui-client-registry.service.ts`（按 `deviceId`/`tabId` 识别设备，`ui.hello`）、`ui-state-request.service.ts`（向浏览器询问可见内容）、`ui-navigation.service.ts`（服务端驱动浏览器导航）。

方案：
1. **纯函数 reducer**：`reduceCockpit(state, event) → state`。状态 = `{rev, view, viewStack, focusUri, tray, history, visible, pendingSend, lastEventSource}`；事件可序列化：`move(dir)`、`zoom(in|out)`、`back`、`focus(uri)`、`pin`、`unpin(uri)`、`setView(view)`、`utterance(text)`、`confirm`、`cancel`、`visible(viewUri, focusables)`。每个事件带 `source:{deviceId, role}`。`move` 按显示端上报的可聚焦元素的网格坐标 / 序号吸附移动，不读 DOM。
2. **服务端中枢**（新后端模块 `server/modules/cockpit/`，遵守 backend-module-standards；新模块目录按 AC-394 棘轮要求处理 manifest / pin，见 `server/shared/tests/server-import-cycle-budget.test.ts`）：每个登录用户一份内存状态（与 ui-client-registry 同样只存内存、重启即重置）；挂在既有 websocket 上，帧：`cockpit.hello{role:'display'|'input'}`、`cockpit.event{event}`、`cockpit.state{state}`（每次状态变化广播给该用户全部 display 与 input）。
3. **显示端上报可见集**：舞台每次渲染后发 `visible` 事件（当前视图 URI + 可聚焦元素 `{uri,label,display}`）。**输入包与识别热词由中枢按显示端上报的可见集构建**，而不是按采集语音那台设备的页面——你对着手机说话、看的是桌面。
4. **待确认发送在中枢里**：未命中意图的 `utterance` 在中枢生成 `pendingSend`（目标会话按 `cockpit-push-to-talk-and-focus-routing` 的规则：fleet `interfaceSessionId` → 最近打开 → 无则不发送）；`confirm` 由任一 input 设备发出，中枢经既有会话发送服务执行，**恰好一次**；`cancel` 清除。
5. **前端改为订阅中枢**：`/cockpit` 页面以 display + input 双角色连接；`useCockpitFocus` 与页面内的托盘 / 预览状态改为渲染中枢下发的 state，键盘与输入框产生事件发给中枢。只保留这一条路径，不保留页面内状态的第二套实现。
6. 回显来源：状态条显示最近一次事件来自哪台设备（「来自手机」）。

## AC

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/cockpit/tests/cockpit-reducer.test.ts` exit 0——reducer 纯函数（同输入同输出、不改入参）；`move` 按上报的网格坐标吸附且不越界；`zoom in` 在项目上进入 board 并压栈、`back` 出栈；`pin`/`unpin` 改托盘；`utterance` 命中意图只改视图、未命中生成 `pendingSend` 且其 `visible` 等于最近一次 display 上报的可见集；`cancel` 清除 `pendingSend`。
- [ ] AC2: `npx tsx --tsconfig server/tsconfig.json --test server/modules/cockpit/tests/cockpit-hub.test.ts` exit 0——两个假 websocket 客户端（同一用户，一个 display、一个 input）：input 发 `move` 后 display 收到 rev+1 的 state；input 发 `utterance` 时包内 visible 取自 display 的上报而非 input 的；`confirm` 触发发送服务恰好 1 次，重复 `confirm` 不重复发送；另一用户的客户端收不到该状态。
- [ ] AC3: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——页面按中枢下发的 state 渲染焦点与视图；方向键产生 `move` 事件发往中枢（假连接计数）而不是改本地状态；既有舞台用例不弱化。
- [ ] AC4: `npm run typecheck` 通过。

## DoD

- **MCP 浏览器实际操作 + 截图（必做）**：同一用户开两个浏览器上下文——桌面尺寸的 `/cockpit`（显示端）与手机尺寸的第二个页面（暂用 `/cockpit` 当输入端）；在手机页按方向键 / 提交「看 <项目>」，截图桌面页焦点与视图随之变化（存 `tmp/`）；`browser_evaluate` 读回两端 state 的 rev 一致。
- 场景运行器：为驾驶舱补一个场景（运行器目前只认 quay-panel，见记忆中的缺口说明），贴报告；做不到则如实写明缺口。
- 记录「输入端事件 → 显示端重绘」的实测延迟。

## Touches

- server/modules/cockpit/index.ts
- server/modules/cockpit/cockpit.reducer.ts
- server/modules/cockpit/cockpit-hub.service.ts
- server/modules/cockpit/cockpit.module.ts
- server/modules/cockpit/tests/cockpit-reducer.test.ts
- server/modules/cockpit/tests/cockpit-hub.test.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/index.ts
- server/index.ts
- server/shared/tests/server-import-cycle-budget.test.ts
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/hooks/useCockpitFocus.ts
- src/modules/cockpit/hooks/useCockpitHub.ts
- src/modules/cockpit/cockpitRouting.ts
- src/modules/cockpit/tests/CockpitStage.test.tsx
- scripts/ui-scenario.mjs
- src/modules/ui-scenario/scenarioSurface.ts
- tasks/cockpit-hub-cross-device-state.md
