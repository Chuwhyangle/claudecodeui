---
id: AC-408
title: 端到端典型场景：announce/总结文本经 TTS 合成、浏览器播放、narrator_done 推进
status: achieved
kind: criterion
goal: GOAL-047
criterion: node experiments/voice-e2e-harness/run.mjs --sample 402fad85
expect: 退出码 0。scripted relay + scripted TTS stand-in 下跑一次完整 Live Voice 交互，断言：
  (a) relay 转交冻结转写（既有）；(b) announce 文本经 TTS 合成，`tts_audio` 帧按 `seq` 从 0
  连续到达浏览器、`tts_done` bytes 等于合成字节数；(c) 浏览器播放后回 `narrator_done`，narrator
  队列推进下一句；(d) run-end 总结同样走 TTS 出声。取假形态：TTS 下行不接，announce 无 `tts_audio` 帧必红（⚠️
  当前必红：TTS 音频下行尚未接线）。
origin: 本会话 2026-10-19 讨论产出；北极星「跑通完整典型场景」的 suite 侧判据。当前 TTS
  leaf（voice-realtime-tts.ts）已完整但未接线，AC-405 的「浏览器下行帧到达」是假绿（帧推进注入数组，无浏览器）。
activatedAt: 2026-10-19T08:54:35.363Z
statusLog:
  - at: 2026-10-19T09:10:09.813Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
