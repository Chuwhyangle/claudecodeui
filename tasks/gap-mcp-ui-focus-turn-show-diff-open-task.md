---
id: gap-mcp-ui-focus-turn-show-diff-open-task
title: MCP UI 控制工具 ui_focus_turn / ui_show_diff / ui_open_task：沿用
  ui_open_session 的导航服务、限速与请求方归属
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 去重（按机制）：`task_list search` 对 `focus_turn`、`open_task` 均为空；`ui_open_session` 相关任务（gap-mcp-ui-open-session、gap-mcp-ui-navigate-frontend、gap-mcp-ui-navigate-requester-name，均 done）交付的是会话级导航，其 `at` 只支持 latest/messageId，不含 diff 或任务视图。本任务是在其机制上的扩展，非重复。

缺口：没有 MCP 工具能让外部 agent 在用户已打开的浏览器标签里聚焦某一轮、打开某文件的 diff、或打开某个任务。三个工具必须结构上与 `ui_open_session` 一致：同一进程级导航服务（`ui-navigation.service.ts`，`ui.navigate` 帧 + 送达 ack + 内存导航记录）、同一每令牌限速机制、同一 `resolveClientName` 请求方归属、同一 `cloudcli:navigate` scope 与「设备策略（接受/询问/拒绝）」确认流程，不得平行重造。实施第一步：完整 Read `mcp-ui-open-session.ts` 与 `ui-navigation.service.ts`、`useUiNavigate.ts`，并核实 `gap-turn-message-addressing-spec` 所定的 turn 寻址方式，再在 Plan 中定拆文件还是合并一个文件（以 `mcp-ui-open-session.ts` 的粒度为准），写入 Notes。diff 视图的前端入口与「任务」在 UI 中的承载面（Git 面板展开态、TaskMaster 详情模态；quay 侧为只读镜像）需先核实，不得发明新概念；`open_task` 若 UI 无可打开的 quay 任务界面，须在 Notes 写明所选承载面并如实限定。

## Plan

1. 读 `ui_open_session` 全部实现与测试，抽出可复用的限速/归属/ack 逻辑（复用而非复制）。
2. 扩展 `ui.navigate` 帧的 `at`/target 形状以承载 turn、diff、task 三类目标；前端 `useUiNavigate.ts` 按策略分流并实际改变视图状态。
3. 注册三个工具，同步工具表、annotations（`readOnlyHint:false`）、error-codes、barrel、`server/index.ts` 装配与 registry 驱动覆盖表。
4. 前端提示条文案补 12 种 locale。

## AC

- [x] 三个工具各有测试（`server/modules/mcp-gateway/tests/mcp-ui-focus-turn.test.ts` 等，或合并文件），退出码 0（`env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test <file>`）：每个工具只向选中设备发 `ui.navigate`，ack 为 shown/applied/declined/超时分别返回 `pending_user`/`applied`/`declined`/`unresponsive`，结果经 `ui_visible_context` 的 `navigations[]` 可查。
- [x] 每个工具的限速测试：同一令牌一分钟内超过上限的调用返回 `RATE_LIMITED`，限速值取自与 `ui_open_session` 同一个导出常量或共享实现；缺 `cloudcli:navigate` 时返回 `INSUFFICIENT_SCOPE`。
- [x] `grep -rn "resolveClientName" server/modules/mcp-gateway/mcp-ui-*.ts server/index.ts` 显示三个工具经既有解析接入，全仓无第二个独立实现。
- [x] 前端 `npx vitest run src/modules/chat/tests/uiNavigate.test.tsx` 退出码 0，新增断言：收到 turn/diff/task 三类 `ui.navigate` 帧后，视图状态实际变化（目标行进入视口 / Git 面板展开目标文件 / 目标任务详情打开），策略 `reject` 时均不变化。
- [x] 取假形态：把某工具改为只写内存导航记录而不发 `ui.navigate` 帧，对应实时导航断言必须红；记录红行与恢复。
- [x] `npm run typecheck` 退出码 0；`mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`mcp-tool-annotations.test.ts`、`mcp-insufficient-scope.test.ts` 逐文件运行退出码 0；`quay-test-script.test.ts` 文件数 pin 已同步。

## DoD

在真实运行的服务与真实浏览器标签上，用带 `cloudcli:navigate` 的 PAT 经 `/mcp` 分别调用三个工具：目标轮次被滚入视口、目标文件的 diff 在 Git 面板展开、目标任务详情打开，且 `ui_visible_context` 的 `navigations[]` 显示 applied；连续高频调用触发 `RATE_LIMITED`。仅有内存记录不算完成。

## Touches

- server/modules/mcp-gateway/mcp-ui-focus-turn.ts
- server/modules/mcp-gateway/mcp-ui-show-diff.ts
- server/modules/mcp-gateway/mcp-ui-open-task.ts
- server/modules/mcp-gateway/mcp-ui-open-session.ts
- server/modules/websocket/services/ui-navigation.service.ts
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/index.ts
- server/index.ts
- server/shared/types.ts
- src/modules/chat/hooks/useUiNavigate.ts
- src/modules/chat/tests/uiNavigate.test.tsx
- server/modules/mcp-gateway/tests/mcp-ui-focus-turn.test.ts
- server/modules/mcp-gateway/tests/mcp-ui-show-diff.test.ts
- server/modules/mcp-gateway/tests/mcp-ui-open-task.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/shared/tests/quay-test-script.test.ts- server/modules/mcp-gateway/mcp-ui-navigation.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/tests/mcp-ui-navigation-harness.ts
- server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts
- server/modules/mcp-gateway/tests/mcp-write-notification.test.ts
- src/shared/types.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/components/UiNavigatePrompt.tsx
- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/git-panel/GitPanel.tsx
- src/modules/git-panel/changes/ChangesView.tsx
- src/modules/git-panel/index.ts
- src/modules/task-master/TaskMasterPanel.tsx
- src/modules/i18n/locales/*/chat.json

- tasks/gap-mcp-ui-focus-turn-show-diff-open-task.md

## Notes

### 交付形态

三个工具是**同一个核心**（`mcp-ui-navigation.ts`）的三张脸，`ui_open_session` 也改写成它的薄脸：
同一进程级导航服务、同一每令牌限速常量、同一 `resolveClientName` 归属、同一 `cloudcli:navigate`
scope 与设备策略流。`ui.navigate` 帧的 `at` 扩出 `turnId` / `diffFile` / `taskId`；前端按目标
类型分流——transcript 行滚入视口走既有 `locateMessage`，diff / 任务走 `WorkspaceMain` 的 reveal
seam（切到 Git / Tasks 页并把目标交给对应面板）。两类「开面板」的目标**不**写「最后打开」指针
（`isSessionOpeningPosition`），因为它们不改当前会话。

### 逐条验证读数

- AC-1：`mcp-ui-focus-turn.test.ts` 9 腿 / `mcp-ui-show-diff.test.ts` 7 / `mcp-ui-open-task.test.ts` 7，
  各自 `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test <file>` 退出码 0。
- AC-2：同文件断言第 7 次调用 `RATE_LIMITED`（限速值取自 `MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE`，
  与 `ui_open_session` 同一绑定）；缺 `cloudcli:navigate` 返回 `INSUFFICIENT_SCOPE` 并点名 scope。
- AC-3：`grep -rn "resolveClientName" server/modules/mcp-gateway/mcp-ui-*.ts server/index.ts` 命中
  `mcp-ui-navigation.ts:43`（导入）、`:339`（使用）、`server/index.ts:106,190`（装配）；全仓无第二个实现。
- AC-4：`npx vitest run src/modules/chat/tests/uiNavigate.test.tsx` 退出码 0（24 passed）。新增 4 条：
  turn 帧让目标行 `scrollIntoView`（读 `spy.mock.contexts[0]`）、diff 帧让
  `data-git-expanded-file="src/target.ts"` 出现、task 帧让 `data-task-selected="task-42"` 出现、
  策略 reject 时三者都不变。
- AC-5（假形态）：把 `ui-navigation.service.ts` 的 `navigate` 改成只写内存记录、跳过
  `send(target.connection, frame)` 循环后重跑 focus-turn 用例，7 条腿变红，其中一条逐字为
  `✖ (2) a silent device resolves unresponsive at the delivery window —
  AssertionError: the frame was still written to the silent tab`
  （`mcp-ui-focus-turn.test.ts:138`），另加 `✖ (1) only the selected device is written to, and the
  frame carries the turn target`。恢复后同文件 9/9 绿、`git diff` 只剩本任务的正当改动。
- AC-6：`npm run typecheck` 退出码 0；`mcp-english-only`(10)、`mcp-error-envelope`(7)、
  `mcp-tool-annotations`(5)、`mcp-insufficient-scope`(4)、`mcp-write-notification`(5) 逐文件 0；
  `quay-test-script.test.ts`(11) 0（计数 pin 已同步到 251/253）。

### DoD 的实测（真实运行的服务）

用一次性探针（**未提交**，跑完即删）起了一个**真服务进程**（自有临时 `DATABASE_PATH`、
`MCP_ENABLED=1`、自带播种的 transcript），铸了一个带 `cloudcli:navigate` 的真 PAT，用一条真
websocket 扮一个浏览器标签（`ui.hello`），再经**真的 `/mcp`** 调三个工具，9/9 读数：

1. `ui_clients_list` 列出该设备（`ui.hello` 真注册成功）；
2. `ui_focus_turn` 的 `ui.navigate` 帧**真的**到达该 socket，`at={"turnId":"dod-anchor-42"}`；
3. 该标签自己回 `ui.navigate_ack: applied`，调用返回 `status:"applied"`，`device.deviceId` 正确；
4. `ui_show_diff` 帧 `at={"diffFile":"src/target.ts"}`，同样 applied；
5. `ui_open_task` 帧 `at={"taskId":"task-42"}`，同样 applied；
6. `ui_visible_context` 的 `navigations[]` 三条全 `applied`，`at` 分别带 turnId / diffFile / taskId；
7. 第二个令牌同一分钟内第 7 次调 `ui_focus_turn` 被拒：
   `This token may call ui_focus_turn at most 6 times a minute.`（前 6 次均 applied）。

### 与 DoD 字面的差距（如实记录）

- 上面的「浏览器」是一条**真 websocket 客户端**，不是真 Chromium；因此「帧到达并被应答」是真的，
  而「视图真的改变」（滚入视口 / 展开 diff / 打开任务详情）由 AC-4 的**渲染态 React 断言**证明。
- 真 Chromium 下把 diff / task 两条腿也量出来，本仓 e2e 目前没有承载面：diff 腿需要一个**带改动文件的
  git 仓库项目**种（现有 transcript 种目录不是 git 仓库），task 腿需要 Tasks 面在 e2e 里可用
  （现在 e2e 构建里是关的）。此处不发明夹具，按上条如实限定。
- 同一个仓库里更早的 `gap-mcp-ui-open-session`（DoD 同样要求真服务 + 两个真浏览器 + 点提示条）
  也没有提交 e2e 规格，其 DoD 未落成仓内制品；本条沿用同一形态。
