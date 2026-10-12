---
id: AC-364
title: Silence Tail Suppression 产品实现（开关默认关闭）：continuous 下偏向语音的本地静音检测、真实底噪 tail
  T、停传与前滚 P 恢复，不 commit/不 response.create/不关 WS；本地 S-1..S-7 判据
status: achieved
kind: criterion
goal: GOAL-044
criterion: for f in
  server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts
  e2e/voice-realtime-silence-tail-suppression.spec.ts; do [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json
  --test
  server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts
  && npx playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts
expect: 读数——(S-1) 本地确定性 fake 下 STS
  开与关两臂逐事件一致（条目、speech_stopped、response、工具调用），audio-time 与 wall-clock
  两种时间基分别报告；(S-2) 上游收到的帧覆盖每段语音 [起点−P, 终点+T]，恢复讲话首帧不丢；(S-3)
  说完→speech_stopped、说完→工具调用与关闭时差值 p50 ≤ 100 ms；(S-4) 停传 ≥30 min（虚拟时钟）后恢复正常，stall
  看门狗、turn_unanswered、pool 轮换零误触发；(S-5) 低音量与噪声语料误判静音率 = 0；(S-6)
  开关关闭时逐帧行为与现状一致；(S-7) T/P/阈值默认值在代码注释中引用 AC-363 读数。取假形态——tail 用合成零值代替真实底噪或去掉前滚 ⇒
  S-2 必须红。
origin: 人 yale 2026-10-12 提出 Silence Tail Suppression（体验优先候选）；决策文档
  docs/proposals/live-voice-experience-first-decision-2026-10.md §10（提交
  18616927）。
activatedAt: 2026-10-12T12:32:58.726Z
statusLog:
  - at: 2026-10-12T12:32:58.726Z
    from: draft
    to: active
    actor: goal-cli
    reason: STS 立项：任务同批建立
  - at: 2026-10-12T17:50:53.695Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T12:32:58.726Z
---
