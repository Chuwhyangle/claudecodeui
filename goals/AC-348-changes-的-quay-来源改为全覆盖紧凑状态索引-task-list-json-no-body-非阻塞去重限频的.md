---
id: AC-348
title: 语音待投递条目逐条撤回：Live Voice 中已入 CLI 队列未出队的话语行带 UI 撤回按钮，走既有 cancelQueued
  链路，撤回后不进入任何一轮；模型无撤回工具、无清空队列
status: draft
kind: criterion
goal: GOAL-041
criterion: f=src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f"
expect: 读数——(a) 语音投递且 queued 的话语渲染为可撤回的待执行行（与打字的 PendingResidentMessage
  同一链路或同等语义），started 后撤回按钮消失；(b) 点撤回 ⇒ 调用 cancelQueued(sessionId,
  queuedMessageUuid)，outcome=cancelled 时该行标记已撤回、深度读数减一；already-started
  时诚实提示无法撤回；(c) 语音工具面仍恰为
  session_send/session_interrupt/session_status，无撤回/清空工具；(d) 撤回不触发
  abort。取假形态——撤回按钮不调 cancelQueued ⇒ (b) 红。
origin: 人 yale 2026-10-12「按建议推进」续裁 D-10/D-11（SPEC §0.3，提交 d09c4bc9）；证据 E9 +
  E10/U4（docs/proposals/claude-resident-sessions-experiments.md）。
activatedAt: 2026-10-12T06:52:13.709Z
statusLog:
  - at: 2026-10-12T06:52:13.709Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-12T07:29:29.496Z
    from: active
    to: draft
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T06:52:13.709Z
---
