---
id: voice-output-backchannel
title: backchannel：停顿「不确定态」给「嗯」，换更长 silence window（前置验 semantic_vad）
status: ready
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

## Prerequisite verification (2026-10-19)

结论：semantic_vad 在本端点上观测不到「用户可能没说完」的中间态，按 Proposal 的回退分支执行「暂停检测 + 主动 `response.create`」。

证据（均为本仓库既有读数，未新增付费运行）：线上 server-VAD 事件面只有 `input_audio_buffer.speech_started` / `.speech_stopped` / `.committed`（`voice-realtime-bridge.service.ts` 的 `TOLERATED_ENDPOINT_EVENTS`，从保留的真实抓包枚举）；`docs/operations/voice-realtime-continuous-calibration.md` §C-1 的 semantic_vad 时间线是 `speech_started` 11673 ms、`speech_stopped`/`committed` 紧随 2 ms——它更晚地做出判定，并不把「不确定」作为事件播报；更早的 P0-S4 还测得控制面接受是回显（`echoDiscriminates=false`）。判据文件与模块头记录该结论，`SEMANTIC_VAD_EXPOSES_UNCERTAIN_PAUSE === false` 是读数而不是默认值。

## AC

- [x] AC-407：semantic_vad 验证通过前提下，停顿「不确定态」给「嗯」、换更长 silence window、「继续说比例」上升；把「不确定态」触发换成「每个停顿都回执」必红。

## DoD

`server/modules/voice-realtime/tests/voice-realtime-backchannel.test.ts` 落地并绿（前提 semantic_vad 验证通过）；AC-407 转绿；`npm run typecheck` 退出 0。

## Touches

- server/modules/voice-realtime/voice-realtime-turn-detection.ts
- server/modules/voice-realtime/tests/voice-realtime-backchannel.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/voice-output-backchannel.md