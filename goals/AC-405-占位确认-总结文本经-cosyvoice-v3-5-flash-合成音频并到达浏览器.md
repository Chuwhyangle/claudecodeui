---
id: AC-405
title: 占位确认/总结文本经 cosyvoice-v3.5-flash 合成音频并到达浏览器
status: achieved
kind: criterion
goal: GOAL-047
criterion: bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json
  --import ./scripts/undici-blocked-ports-preload.mjs --test
  server/modules/voice-realtime/tests/voice-realtime-tts.test.ts
expect: 退出码 0（⚠️ 当前必红：测试文件不存在）。给定一段「占位确认/总结」文本，经 cosyvoice-v3.5-flash（HTTP
  兼容模式）合成出非空音频字节，时长与文本长度同量级（不是 0 字节、不是超长）；文本→音频→浏览器下行帧到达（scripted
  断言）。取假形态：把模型名换成不存在的，合成必失败且错误码上报（非静默空音频）。
origin: 本会话 2026-10-19 讨论产出；TTS 落点 cosyvoice-v3.5-flash（¥0.8/万字符，2026-10-10
  官方价，中文约 2 计费字符=1 可见字符，一段 32 字小结 ≈ ¥0.0005）。
activatedAt: 2026-10-19T00:27:05.146Z
statusLog:
  - at: 2026-10-19T00:27:05.146Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-19T09:09:25.662Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-19T00:27:05.146Z
---
