---
id: AC-305
title: Realtime bridge 与工具调用在假 WS 服务端上离线可证
status: active
kind: criterion
goal: GOAL-029
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts
  server/modules/voice-realtime/tests/voice-realtime-bridge.false-forms.test.ts
expect: 对假 WS 服务端：连接的 connect/disconnect/reconnect 全流程可驱动，退出码 0，零真实网络（替身记账，任何真实
  DashScope 调用即红）；桥接层 `session.update` 携带的工具 schema，与
  `server/modules/mcp-gateway/*` 对
  `ui_visible_context`/`session_send`/`session_get`/`run_get`/`approvals_list`/`session_background`
  六个工具的既有 Zod `inputSchema`/`outputSchema` 逐字段相等；function-call 事件按工具名正确路由到注入的
  executor，参数原样传递（不改写、不丢字段）；连接中断/executor 抛错/未知事件类型三种异常，进程不崩溃且有明确错误上报。取假形态：(1)
  改动桥接层任一工具字段 ⇒ 必须红并指名哪个字段；(2) 把路由写死分派到固定一个工具 ⇒ 必须红；(3) 去掉异常捕获 ⇒
  任一异常情形下进程崩溃或静默吞掉，必须红。
origin: docs/proposals/voice-native-control-plane.md §2/§4/§10.3；criterion
  修正：原写法 node --test 在本仓 TS-ESM 下 node 不重映射 .js 说明符，实测 ERR_MODULE_NOT_FOUND
  恒红；改为本仓 136/137 条判据通用的 npx tsx --tsconfig server/tsconfig.json
  --test。两份测试文件逐字未改。
activatedAt: 2026-10-08T17:21:05.230Z
statusLog:
  - at: 2026-10-08T17:21:05.230Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-08T17:21:05.229Z
---
