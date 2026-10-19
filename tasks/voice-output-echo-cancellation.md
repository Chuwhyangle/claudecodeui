---
id: voice-output-echo-cancellation
title: 回声消除（配套）：先验浏览器 echoCancellation 遮不遮得住外放，遮不住才上真 AEC
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-406
---
## Proposal

回声消除（AEC）：异步双工下，系统「说」（backchannel/确认/总结）的声音会从扬声器绕回自己的麦克风，被当成「用户的话」采进去，威胁三件事——误转交（系统的话被 ASR 识别成用户的话）、回声自打断（系统播报触发 turn detection）、信心崩塌（用户听到自己刚说的话被重复）。

现有 uplink VAD（silero）只判断「是不是语音」，分不出「谁的语音」；Silence Tail Suppression 管静音尾巴，都不是回声消除。真 AEC 需要远端参考信号（把系统正在播的音频从麦克风输入减掉）。

本 task 先验：外放场景下浏览器 `getUserMedia` 的 `echoCancellation` 遮不遮得住系统播报。遮得住 → 结案；遮不住 → 上真 AEC。

前置：T4（TTS 开始出声）之后、T6（backchannel 说话频率陡增）之前。

## AC

- [ ] 一个回声/串音测量探针：外放场景下播放一段系统播报，测麦克风采回该音频的程度；产出结论（echoCancellation 够 / 需真 AEC）。

## DoD

回声测量探针跑通并产出结论；若结论是「需真 AEC」，另立 task 做 AEC，不塞进本 task。

## Touches

- experiments/voice-echo-probe/（探针脚本）