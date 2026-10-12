---
id: AC-339
title: session_interrupt 可审计：语音面接 intent（必填）/heard，回执与 journal kind:interrupt 带
  runId、triggerSeq、queuedStillPending、inFlightTool、by、outcome；gateway 旧调用形态兼容
status: active
kind: criterion
goal: GOAL-041
criterion: f=server/modules/voice-realtime/tests/voice-realtime-interrupt-audit.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --test "$f"
  server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts
expect: 读数——(a) 语音面 session_interrupt 描述符声明 intent（必填）与 heard（可选），缺 intent
  时报参数错误并点名 intent；(b) 每次调用在 journal 追加一条 kind:interrupt，字段
  runId、triggerSeq（触发该调用的最近一条已完成转写的
  utteranceSeq）、intent、heard、queuedStillPending、inFlightTool（读不到则显式
  null）、by、outcome 齐全，且不含会话正文以外的路径/密钥；(c) MCP gateway 的 session_interrupt 对只带
  session 的旧调用行为不变（mcp-session-lifecycle 判据绿），语音面独有字段不下传到 gateway。取假形态——删
  journal 任一字段 ⇒ (b) 红。
origin: 人 yale 2026-10-12 授权按 A+ 推荐落地（Opus 常驻架构会话）。证据：journal
  ~/.cloudcli/voice-realtime-log/99df08d8-….jsonl × Claude transcript
  c6493eb6（2026-10-12 01:24–01:31 UTC）；契约见
  docs/proposals/voice-realtime-persistent-control-SPEC.md §0.3 / §18。
activatedAt: 2026-10-12T06:05:12.223Z
statusLog:
  - at: 2026-10-12T06:05:12.223Z
    from: draft
    to: active
    actor: goal-cli
    reason: GOAL-041 立项：任务同批建立
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T06:05:12.222Z
---
