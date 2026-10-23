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

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/cockpit/tests/cockpit-reducer.test.ts` exit 0——reducer 纯函数（同输入同输出、不改入参）；`move` 按上报的网格坐标吸附且不越界；`zoom in` 在项目上进入 board 并压栈、`back` 出栈；`pin`/`unpin` 改托盘；`utterance` 命中意图只改视图、未命中生成 `pendingSend` 且其 `visible` 等于最近一次 display 上报的可见集；`cancel` 清除 `pendingSend`。
- [x] AC2: `npx tsx --tsconfig server/tsconfig.json --test server/modules/cockpit/tests/cockpit-hub.test.ts` exit 0——两个假 websocket 客户端（同一用户，一个 display、一个 input）：input 发 `move` 后 display 收到 rev+1 的 state；input 发 `utterance` 时包内 visible 取自 display 的上报而非 input 的；`confirm` 触发发送服务恰好 1 次，重复 `confirm` 不重复发送；另一用户的客户端收不到该状态。
- [x] AC3: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——页面按中枢下发的 state 渲染焦点与视图；方向键产生 `move` 事件发往中枢（假连接计数）而不是改本地状态；既有舞台用例不弱化。
- [x] AC4: `npm run typecheck` 通过。

## DoD

- **MCP 浏览器实际操作 + 截图（必做）**：同一用户开两个浏览器上下文——桌面尺寸的 `/cockpit`（显示端）与手机尺寸的第二个页面（暂用 `/cockpit` 当输入端）；在手机页按方向键 / 提交「看 <项目>」，截图桌面页焦点与视图随之变化（存 `tmp/`）；`browser_evaluate` 读回两端 state 的 rev 一致。
- 场景运行器：为驾驶舱补一个场景（运行器目前只认 quay-panel，见记忆中的缺口说明），贴报告；做不到则如实写明缺口。
- 记录「输入端事件 → 显示端重绘」的实测延迟。

## Notes

实现（commit 811100e1b）：`server/modules/cockpit/` 为纯函数 reducer + 内存 hub（`cockpit.hello` / `cockpit.event` / `cockpit.state`），模块是 AC-394 叶子（只 import `server/shared/**` 与自身，gateway 用结构化 seam 注入），因此无需改 manifest/pin，`server/shared/tests/server-import-cycle-budget.test.ts` 保持绿。中枢的两条外部接缝（目标解析 = fleet registry 接口会话 → 最近打开；发送 = 既有 `chatControl.send`）在组合根注入；`confirm` 先清卡片再 await 发送，重复 `confirm` 结构上不可能二次发送。前端 `useCockpitFocus` 改为纯函数，页面只发事件、渲染广播 state；`visible` 上报只在页面所画视图能被中枢描述时发送，deep link 到未注册项目时仍按 URL 渲染而不是被中枢拉回 fleet。

实测（隔离实例：本 worktree 的 tsx server + vite dev，独立 HOME/DATABASE_PATH，端口 4399/5399；两个真实 Chromium context 同一用户，桌面 1280×800、手机 390×844；quay 两个读接口在浏览器层用夹具桩住）：
- 初始两端 `rev=2`，焦点均 `quay://claudecodeui/board`；
- 手机按 ArrowDown → 桌面焦点变 `quay://quay-fleet/board`，两端 `rev=3`；**输入端事件 → 显示端重绘实测 8 ms**；
- 手机输入「看 claudecodeui」提交 → 桌面切到 board，URL `?view=board&project=p1`，焦点 `quay://claudecodeui/task/task-a`，两端 `rev=7` 一致；
- 状态条来源回显：桌面显示 `← Phone`（设备名由浏览器上报）。
- 截图：`tmp/cockpit-hub-dod-1-before.png`、`tmp/cockpit-hub-dod-2-after-move.png`、`tmp/cockpit-hub-dod-3-phone.png`、`tmp/cockpit-hub-dod-4-after-view.png`（`tmp/` 已 gitignore；驱动脚本 `tmp/cockpit-hub-dod.mjs`）。
- 场景运行器缺口（如实）：`scripts/ui-scenario.mjs` 的 `open` 只认 `quay-panel`，语义面 `window.__cloudcliScenario` 读的是 Quay wall 的页面内契约；驾驶舱的焦点/视图现在在中枢里、页面上只有 `data-cockpit-hub-rev` 等读数，要接运行器需要新增 cockpit opener + 把中枢 state 暴露进语义面。本任务未做，记此缺口。
- 既有单元用例：`src/modules/cockpit/tests/` 5 个文件 48 用例全绿（舞台原有用例断言未减弱，只把测试替身换成假中枢连接）。

## Touches

- server/modules/cockpit/index.ts
- server/modules/cockpit/cockpit.reducer.ts
- server/modules/cockpit/cockpit-hub.service.ts
- server/modules/cockpit/cockpit.module.ts
- server/modules/cockpit/tests/cockpit-reducer.test.ts
- server/modules/cockpit/tests/cockpit-hub.test.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/index.ts
- server/modules/quay/index.ts
- server/index.ts
- server/shared/tests/server-import-cycle-budget.test.ts
- src/shared/types.ts
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/hooks/useCockpitFocus.ts
- src/modules/cockpit/hooks/useCockpitHub.ts
- src/modules/cockpit/cockpitRouting.ts
- src/modules/cockpit/tests/CockpitStage.test.tsx
- scripts/ui-scenario.mjs
- src/modules/ui-scenario/scenarioSurface.ts
- tasks/cockpit-hub-cross-device-state.md

## Blocker

**2026-10-23T05:42:24.166Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=82001 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1792733720267
- run_id：wk-prod-anchor
- session_id：d01debf6-f245-4e6a-b5c6-ce2268ec8d11
