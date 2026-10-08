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

- [ ] 三个工具各有测试（`server/modules/mcp-gateway/tests/mcp-ui-focus-turn.test.ts` 等，或合并文件），退出码 0（`env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test <file>`）：每个工具只向选中设备发 `ui.navigate`，ack 为 shown/applied/declined/超时分别返回 `pending_user`/`applied`/`declined`/`unresponsive`，结果经 `ui_visible_context` 的 `navigations[]` 可查。
- [ ] 每个工具的限速测试：同一令牌一分钟内超过上限的调用返回 `RATE_LIMITED`，限速值取自与 `ui_open_session` 同一个导出常量或共享实现；缺 `cloudcli:navigate` 时返回 `INSUFFICIENT_SCOPE`。
- [ ] `grep -rn "resolveClientName" server/modules/mcp-gateway/mcp-ui-*.ts server/index.ts` 显示三个工具经既有解析接入，全仓无第二个独立实现。
- [ ] 前端 `npx vitest run src/modules/chat/tests/uiNavigate.test.tsx` 退出码 0，新增断言：收到 turn/diff/task 三类 `ui.navigate` 帧后，视图状态实际变化（目标行进入视口 / Git 面板展开目标文件 / 目标任务详情打开），策略 `reject` 时均不变化。
- [ ] 取假形态：把某工具改为只写内存导航记录而不发 `ui.navigate` 帧，对应实时导航断言必须红；记录红行与恢复。
- [ ] `npm run typecheck` 退出码 0；`mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`mcp-tool-annotations.test.ts`、`mcp-insufficient-scope.test.ts` 逐文件运行退出码 0；`quay-test-script.test.ts` 文件数 pin 已同步。

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
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-mcp-ui-focus-turn-show-diff-open-task.md
