---
id: voice-output-backchannel
title: backchannel：停顿「不确定态」给「嗯」，换更长 silence window（前置验 semantic_vad）
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-407
---
## Proposal

backchannel：停顿「不确定态」给一个「嗯」级回执（一字级），换更长的 silence window，拿回更完整的句子。回执只在「不确定态」这个临界点，不是每个停顿、不是固定间隔。

⚠️ 前置（本 task 第一步，先验再做）：验证 semantic_vad 能否观测到「用户可能没说完」的中间态——现在 shipped 是 `server_vad`（纯静音阈值，只在 turn 结束后响应，不会在中间停顿说话）。若 semantic_vad 只有「说完了/没说」两档、够不到「不确定态」，本 task 需先回退为「暂停检测 + 主动 response.create」的替代机制，或改 AC-407 措辞。

成本约束：backchannel 每说一次「嗯」是一次 response 重读上下文，必须极轻（一字回执 + 频率上限），否则回到 closing-turn 想省的 46% spend。

## AC

- [ ] AC-407：semantic_vad 验证通过前提下，停顿「不确定态」给「嗯」、换更长 silence window、「继续说比例」上升；把「不确定态」触发换成「每个停顿都回执」必红。

## DoD

`server/modules/voice-realtime/tests/voice-realtime-backchannel.test.ts` 落地并绿（前提 semantic_vad 验证通过）；AC-407 转绿；`npm run typecheck` 退出 0。

## Touches

- server/modules/voice-realtime/voice-realtime-turn-detection.ts
- server/modules/voice-realtime/tests/voice-realtime-backchannel.test.ts