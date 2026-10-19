---
id: voice-output-narrator-interrupt
title: 双工打断 + 可清空队列：播报中用户开口即停、排队即清，不当作异常
status: todo
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

- [ ] AC-406：scripted 下播报中注入用户语音 → 当前播报终止、排队清空、用户语音正常走 session_send 且不记 error；去掉「新语音清空队列」钩子必红。

## DoD

`server/modules/voice-realtime/tests/voice-realtime-narrator-interrupt.test.ts` 落地并绿；AC-406 转绿；`npm run typecheck` 退出 0。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-narrator-interrupt.test.ts
- tasks/voice-output-narrator-interrupt.md