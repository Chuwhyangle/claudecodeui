---
id: AC-361
title: 连续模式体验基线的本地确定性 E2E：fake mic 语音/静音时间线 + fake upstream 声学 VAD 仿真与可配置模型策略 +
  执行面夹具，零外联，测出 X-1..X-7 读数
status: active
kind: criterion
goal: GOAL-044
criterion: for f in
  server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts
  e2e/voice-realtime-continuous-experience.spec.ts; do [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json
  --test
  server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts
  && npx playwright test e2e/voice-realtime-continuous-experience.spec.ts
expect: 读数——(a) fake upstream 在 server_vad 配置下按收到的 PCM 做声学 VAD 仿真：语音后静音 ≥
  silence_duration_ms ⇒ speech_stopped + committed + 自动 response；只送语音帧（丢静音）⇒ 不产生
  speech_stopped（§5 推论的本地复现）；(b) 模型策略逐条目可配置（转发 / 不转发 / 等待后合并 / 中断 / 文本作答）；(c)
  e2e spec 走当前 continuous 代码路径，fake mic 播放固定时间线（≥5 句、0.3–3 s
  停顿、含「嗯」类片段、执行面忙闲交替），产出 X-1..X-7 逐项读数表；当前不达标项以 expectKnownDefect 签名记录而非
  test.fail；(d) 零外联（复用 AC-360 守卫）且同一种子连续 3 次读数一致。取假形态——把 VAD 仿真改成按墙钟定时切分 ⇒ (a)
  的丢静音用例必须红。
origin: 人 yale 2026-10-12 调整 Live Voice 优先级：体验优先、模型决定何时输出、VAD
  只服务传输与成本、成本为第二阶段（Opus 常驻会话；决策文档
  docs/proposals/live-voice-experience-first-decision-2026-10.md，提交 038730f0）。
activatedAt: 2026-10-12T12:29:21.041Z
statusLog:
  - at: 2026-10-12T12:29:21.041Z
    from: draft
    to: active
    actor: goal-cli
    reason: GOAL-044 立项：任务同批建立
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T12:29:21.041Z
---
