---
id: AC-308
title: 真实 DashScope qwen3-omni-flash-realtime 传输与 eval harness：离线可证 +
  保留的真实调用轨迹证明非确定性替身
status: draft
kind: criterion
goal: GOAL-030
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts
  server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.false-forms.test.ts
expect: 复用 GOAL-029 已落地的
  `server/modules/voice-realtime/voice-realtime-bridge.service.ts` 的
  `connect(transport, tools, executor, options?)`，不重写第二套 bridge：新增的只是一个真正实现
  `transport` 接口、讲真实 WebSocket 的 `voice-realtime-dashscope-transport.ts`。离线半区（本
  criterion 覆盖、零真实网络、CI 常跑）：对假 WS 服务端驱动
  connect/session.update/音频帧发送/function-call 接收/function_call_output
  回填的完整往返，取假形态与 AC-305 同形（schema 字段漂移、路由写死、异常不吞），退出 0。真实网络半区（不在本 criterion
  里重复执行，按 ADR-004 决策 8 归人工/手动 `--live` 触发，不进 CI）：任务的完成记录必须指向至少一份保留的真实调用轨迹（凭据脱敏，落
  `experiments/voice-realtime-ambiguity/real-trace/`），该轨迹必须带着假服务端不可能产出的字段（例如真实
  DashScope 端发出的会话/连接 id、非零且有变化的真实网络往返延迟、至少一次模型自己决定发起而不是 harness 脚本调用的
  function_call
  事件），且该音频输入是真实合成/录制的语音，不是全零/静音占位。取假形态第四条：若保留的"真实"轨迹能被同一份假服务端夹具逐字节重放出来，判为
  `SUSPECTED_STAND_IN`，必须能被机械或人工指出缺失的"只有真实端点才能产生"的字段。
origin: 本任务续接 GOAL-029（AC-305 已落地的离线 bridge）与
  `docs/experiments/2026-10-09-voice-realtime-ambiguity.md`
  自陈的限制（"本次读数是离线确定性的……离线替身是完美读者，没有认知误差率，所以 Arm B 的 22/24 是能力上限的形状，不是真实模型分数"；"TTS
  音频未合成……一个 .wav 都没合成"）；`docs/proposals/voice-native-control-plane.md` §10 的
  prototype 范围判断
---
