---
id: AC-338
title: Live Voice 队列深度真实：relay 读数与 host command_lifecycle 对账，回合排空即归零，回放
  2026-10-12 真实时间线逐点等于真实 CLI 队列深度
status: draft
kind: criterion
goal: GOAL-041
criterion: f=server/modules/voice-realtime/tests/voice-realtime-queue-depth-truth.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --test "$f"
expect: 读数——(a) 以 99df08d8×c6493eb6 时间线为夹具回放（7 条入队 → 回合边界同毫秒出队合并 → 再入队 2 条 → 出队
  …），每个采样点 sent 帧 depth、S-A 注入 queued=、session_status.queuedItems
  三者相等且等于由出队记录推出的真实深度（峰值 7，01:26:18 后 ≤2）；(b) 非常驻（per-run）会话不回归：depth 仍只计 L3
  合并窗口与等待；(c) host 读数不可得时显式降级为「状态未知」而非沿用旧计数。取假形态——撤掉 lifecycle 对账（退回
  cliQueuedDeliveries 只增不减）⇒ (a) 必须红并报 8/9/10。
origin: 人 yale 2026-10-12 授权按 A+ 推荐落地（Opus 常驻架构会话）。证据：journal
  ~/.cloudcli/voice-realtime-log/99df08d8-….jsonl × Claude transcript
  c6493eb6（2026-10-12 01:24–01:31 UTC）；契约见
  docs/proposals/voice-realtime-persistent-control-SPEC.md §0.3 / §18。
---
