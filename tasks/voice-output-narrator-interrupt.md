---
id: voice-output-narrator-interrupt
title: 双工打断 + 可清空队列：播报中用户开口即停、排队即清，不当作异常
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-406
---
## Proposal

narrator 播报队列「可清空」：播报进行中注入用户语音（新 utterance）→ 当前播报终止 + 排队播报清空；用户语音正常走 `session_send`，不记 error、不报异常。打断 = 对话推进不是异常，被打断的播报丢弃不补（用户已往前走，补播旧总结是打扰）。

这是「可丢弃即时层」的落地：narrator 的播报不是「暂停再恢复」而是「丢」。任何新用户语音 = 清空当前 + 排队。

## AC

- [x] AC-406：scripted 下播报中注入用户语音 → 当前播报终止、排队清空、用户语音正常走 session_send 且不记 error；去掉「新语音清空队列」钩子必红。

## DoD

`server/modules/voice-realtime/tests/voice-realtime-narrator-interrupt.test.ts` 落地并绿；AC-406 转绿；`npm run typecheck` 退出 0。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-narrator-interrupt.test.ts
- server/shared/tests/quay-test-script.test.ts（新增 server 测试文件把收集数 369→370，AC2/AC3 的 unknown 钉子随之 366→367、368→369）
- tasks/voice-output-narrator-interrupt.md

## Notes

### 落地（2026-10-19，worker）

- `voice-realtime-ws-proxy.service.ts`：新增 `VoiceRealtimeNarratorQueue`（`createVoiceRealtimeNarratorQueue`）+ 出站帧 `narrator_speak` / `narrator_stop`、入站帧 `narrator_done`，以及 `VoiceRealtimeProxySeams.narrator`（`attach` 交出本连接的队列；`interruptOnUserSpeech` 缺省开启）。队列**逐条放行**（发 `narrator_speak` 后等页面 `narrator_done` 才发下一条），因此「排队」的那条仍在服务端、可被真正丢弃。
- 三条「用户开口」读数接同一个钩子：上游 `speech_started`（`onUpstreamTurn(true)`）、浏览器 `segment_start`、本地语音门 `localSpeechGate` 的 `started`。打断只发 `narrator_stop` 并清空，不产生 `error` 帧、不记错误日志（`narrator cleared reason=user-spoke dropped=N`）。
- 判据 `voice-realtime-narrator-interrupt.test.ts`：真 proxy + scripted 上游。正臂证明当前播报被 stop、排队被清（`dropped=2`）、迟到 `narrator_done` 不推进、用户语音经 `session_send` 正常 `sent` 且无 error 帧/日志；假形态 `interruptOnUserSpeech: false` 证明去掉钩子后播报继续、排队那条照发（必红臂）。
- 读数：该判据 3/3 绿；`npm run typecheck` 退出 0；`server/shared/tests/quay-test-script.test.ts` 14/14 绿（钉子已按新收集数重测）。
