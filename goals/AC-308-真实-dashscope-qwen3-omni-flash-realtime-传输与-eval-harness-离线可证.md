---
id: AC-308
title: 真实 DashScope qwen3-omni-flash-realtime 传输与 eval harness：离线可证 +
  保留的真实调用轨迹证明非确定性替身
status: active
kind: criterion
goal: GOAL-030
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts
  server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.false-forms.test.ts
expect: |-
  复用 GOAL-029 已落地的 `server/modules/voice-realtime/voice-realtime-bridge.service.ts` 的 `connect(transport, tools, executor, options?)`，不重写第二套 bridge：新增的只是一个真正实现 `transport` 接口、讲真实 WebSocket 的 `voice-realtime-dashscope-transport.ts`（复用其内建的 model override 机制，不新写第二套 transport）。离线半区（本 criterion 覆盖、零真实网络、CI 常跑）：对假 WS 服务端驱动 connect/session.update/音频帧发送/function-call 接收/function_call_output 回填的完整往返，取假形态与 AC-305 同形（schema 字段漂移、路由写死、异常不吞），退出 0。

  真实网络半区（不在本 criterion 里重复执行，按 ADR-004 决策 8 归人工/手动 `--live` 触发，不进 CI）：任务的完成记录必须指向至少一份针对 **`qwen3.8-omni-flash-realtime`**（本 GOAL 正式采用的目标模型，2026-10-08/09 resident 实测纠正，见 origin）的保留调用轨迹（凭据脱敏，落 `experiments/voice-realtime-ambiguity/real-trace/`），证明：真实合成/录制的音频输入（不是静音/全零占位）；真实端点发出的会话/连接 id；非零且有变化的真实网络往返延迟；至少一次模型自己决定发起（不是 harness 脚本调用）的 function_call 事件；该事件的 `function_call_output` 回填之后模型继续同一轮而不是另起会话。该模型的 `session.update` 需要显式 `voice: "Tina"`——这是已知的接入约束，必须在完成记录里登记（缺失该字段或用其它 voice 值导致连接失败/行为异常时，必须写明现象，不得静默改用别的模型回避）。

  **工具白名单与参数 schema 校验（不可用弱化判词回避）**：收到的 function_call 若命名一个不在六个已声明工具之列的名字，或参数与该工具声明的 schema 不符（多余字段、类型不符、缺必填字段），transport/bridge 必须拒绝或以 `onError`/明确错误上报，不能静默把它当成合法调用路由给 fixture executor。

  **已知风险（必须登记，不得回避或靠别的手段消除）**：DashScope 的 `tool_choice`/等价的"必须调用"设置**不保证**模型每轮真的发起工具调用；模型也可能幻觉出一个未声明的工具名或参数。这两条是记在案的限制，完成记录必须明确写出来，而不是通过挑选"总是触发"的输入来掩盖。

  取假形态：(1)-(3) 同旧版（schema 字段漂移、路由写死、异常不吞）；(4) 若保留的"真实"轨迹能被同一份假服务端夹具逐字节重放出来，判为 `SUSPECTED_STAND_IN`；(5)（新增）幻觉工具名或违反参数 schema 的调用若被静默路由到 executor 而不是拒绝/报告，必须判红。
origin: 本任务续接 GOAL-029（AC-305 已落地的离线 bridge）与
  `docs/experiments/2026-10-09-voice-realtime-ambiguity.md`
  自陈的限制。**2026-10-08/09 resident 实测纠正**：此前版本把目标模型写成
  `qwen3-omni-flash-realtime`；真实连接显示该别名（3.0）的 `session.updated` 不回显 `tools`、不产生
  function_call，而 `qwen3.8-omni-flash-realtime` 与 `qwen3.5-omni-flash-realtime`
  均能回显 tools、产生结构化 function_call、接收 `function_call_output` 并继续该轮。人 yale
  2026-10-09 裁定按 `qwen3.8-omni-flash-realtime` 方向推进，本条据此把目标模型改为该值，并补充工具白名单/参数
  schema 校验与 `tool_choice`
  非强制性两条风险登记要求。`docs/proposals/voice-native-control-plane.md` §10 的 prototype
  范围判断。
activatedAt: 2026-10-08T23:15:37.661Z
statusLog:
  - at: 2026-10-08T23:15:37.661Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-08T23:15:37.661Z
---
