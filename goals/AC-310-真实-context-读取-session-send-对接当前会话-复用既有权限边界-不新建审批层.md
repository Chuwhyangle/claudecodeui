---
id: AC-310
title: 真实 context 读取 + session_send 对接当前会话：复用既有权限边界，不新建审批层
status: draft
kind: criterion
goal: GOAL-031
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts
  server/modules/voice-realtime/tests/voice-realtime-live-executor.false-forms.test.ts
expect: |-
  新执行体 `voice-realtime-live-executor.ts` 实现 GOAL-029/030 已落地的 bridge executor 接口：六个只读工具（`ui_visible_context`/`session_get`/`run_get`/`approvals_list`/`session_background`）直接调用 `server/modules/mcp-gateway/*` 已经导出的构建函数（如 `buildUiVisibleContext`），同一份实现，不另抄一份；`session_send` 直接调用进程内的 `ChatControlService`（第一方直连，不经 PAT/HTTP，同 `mcp-session-send.ts` 的 `control` 依赖形状）。**目标会话硬编码为这条语音连接绑定的那一个 app session id，不接受模型在 function_call 参数里指定别的 session**——这是本 AC 用来替代"新建审批层"的具体机制：把"能操作哪个会话"收紧成参数白名单，而不是加一层确认对话框。**不新增任何权限模式、consent 流程或逐操作确认**；Claude Code 自己该不该向人确认（`canUseTool`/`approval_answer`）完全不变，语音层不插手、不重复这一层。

  离线（本 criterion 覆盖，零真实网络）：用假 `ChatControlService`/假 gateway 依赖验证六个工具路由正确；取假变体——executor 收到一个指向别的 session id 的 `session_send` 调用，必须拒绝或改写回绑定会话并记录，不得静默服从模型指定的别的会话。

  真实半区（手动 `--live`，不进 CI）：至少一次真实的"语音 function_call → `session_send`"落到一个真实测试会话，该会话转录里出现一条来源为 `mcp` 的新轮次。
origin: 续接 GOAL-029（`gap-voice-realtime-bridge-offline-provable`）与 GOAL-030（真实
  transport）；docs/proposals/voice-native-control-plane.md §9（第一方直连
  `ChatControlService`，不经 PAT）；人 yale 2026-10-09 的明确纠正——不新建 Policy/Gate
  或逐操作确认体系，用参数白名单 + 既有权限边界代替；明确依赖 GOAL-030/AC-309 的真实 paired evidence（见对应任务的
  `depends_on` 与任务体里的 NO-GO 处理说明）。
---
