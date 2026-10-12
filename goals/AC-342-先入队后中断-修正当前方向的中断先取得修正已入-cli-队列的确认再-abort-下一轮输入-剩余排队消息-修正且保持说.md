---
id: AC-342
title: 先入队后中断：修正当前方向的中断先取得修正已入 CLI 队列的确认再 abort，下一轮输入 = 剩余排队消息 +
  修正且保持说话/打字顺序，stale-first 回合为 0；中断语义扩到「停止或修正方向」（语义判断）
status: active
kind: criterion
goal: GOAL-041
criterion: f=server/modules/voice-realtime/tests/voice-realtime-interrupt-revision-order.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --test "$f"
expect: 读数——(a) 假 resident host 在 abort 瞬间出队：下一轮 user 输入同时含旧排队消息与修正，修正在后；(b) 文本
  composer 消息与语音交错入队时，CLI 收到的顺序 = 发生顺序；(c) 修正入队失败（busy/拒绝）⇒ 不 abort 并诚实回执；(d)
  指令以语义描述「停止或修正当前执行方向」时调用，无关键词。实现形态按 E10（AC-341）U1/U2 结论选择并在注释写明依据。取假形态——改成先
  abort 后入队 ⇒ (a) 红（修正落到再下一轮）。
origin: 人 yale 2026-10-12 授权按 A+ 推荐落地（Opus 常驻架构会话）。证据：journal
  ~/.cloudcli/voice-realtime-log/99df08d8-….jsonl × Claude transcript
  c6493eb6（2026-10-12 01:24–01:31 UTC）；契约见
  docs/proposals/voice-realtime-persistent-control-SPEC.md §0.3 / §18。
activatedAt: 2026-10-12T06:09:23.747Z
statusLog:
  - at: 2026-10-12T06:09:23.747Z
    from: draft
    to: active
    actor: goal-cli
    reason: GOAL-041 立项：任务同批建立
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T06:09:23.747Z
---
