---
id: voice-output-tts-cosyvoice
title: TTS 接入：占位确认/总结文本经 cosyvoice-v3.5-flash 合成音频并播放
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-405
---
## Proposal

接 cosyvoice-v3.5-flash（HTTP 兼容模式，`qwen3.8-omni-flash` 的 TTS 孪生）把「占位确认/总结」文本合成音频，浏览器播放。链路：文本 → cosyvoice 合成 → 音频字节 → 浏览器下行帧。这是「真的出声」的分水岭——之前只产文本不发声，之后才需要回声消除（C1 配套）。

成本：cosyvoice-v3.5-flash ¥0.8/万字符，中文约 2 计费字符=1 可见字符，一段 32 字小结 ≈ ¥0.0005，可忽略。

## AC

- [ ] AC-405：给定文本 → cosyvoice 合成非空音频、时长与文本同量级 → 浏览器下行帧到达；假模型名合成必失败且错误码上报（非静默空音频）。

## DoD

`server/modules/voice-realtime/tests/voice-realtime-tts.test.ts` 落地并绿；AC-405 转绿；`npm run typecheck` 退出 0。

## Touches

- server/modules/voice-realtime/（新增 TTS 模块文件）
- server/modules/voice-realtime/tests/voice-realtime-tts.test.ts