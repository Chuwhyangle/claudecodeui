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
## 退役记录（2026-10-14）

人 yale 2026-10-14 裁定：「STS 已证实无效，取消生产调用」。该裁定由 `gap-live-voice-sts-production-disconnect`（status=done，落地提交 `b6b60a95a`）执行：`server/index.ts` 的 `buildVoiceRealtimeSeams` 在任何 env 下都不再把 `silenceTail` seam 交给代理，`createSilenceTailGate` 在生产装配里不可达；该部署下 `VOICE_REALTIME_SILENCE_TAIL` 只被读出并打一行 `DEPRECATED and IGNORED`。

本判据（AC-364）断言的保证是「STS 是产品实现、开关默认关闭、在 continuous 连线上端到端验证 S-1..S-7」。生产路径不再有 STS 之后，其 e2e 腿（`e2e/voice-realtime-silence-tail-suppression.spec.ts`）要读的正是「真实服务进程装配出的门控」，而该门控已不可达 ⇒ 判据在设计上不可满足（要让 e2e 腿在不改产品装配的前提下重新看到门控，只能在生产装配根新增 STS arm 点，正面违反 2026-10-14 裁定与该断开任务的 AC4）。故本记录置 `superseded`。

`criterion` 行逐字未改：判据是「它当时断言了什么」的记录，退役不改写它。后继不变量由 `server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts` 承担（断言 `VOICE_REALTIME_SILENCE_TAIL` 被读出并忽略、生产装配不 arm 门控）。STS 模块、其两份服务端测试与那份 e2e spec 按裁定逐字节原样归档、一件不删不改；归档 spec 已移出仓库默认的 playwright 集合（文件本体不动，具名 `npx playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts` 仍可跑）。

退役任务：`gap-ac364-supersede-after-sts-production-retirement`。
