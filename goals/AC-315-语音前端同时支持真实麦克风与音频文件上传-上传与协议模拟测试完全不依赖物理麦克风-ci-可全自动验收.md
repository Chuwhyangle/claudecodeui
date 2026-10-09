---
id: AC-315
title: 语音前端同时支持真实麦克风与音频文件上传，上传与协议模拟测试完全不依赖物理麦克风（CI 可全自动验收）
status: achieved
kind: criterion
goal: GOAL-031
criterion: npx playwright test e2e/voice-realtime-upload-fixture.spec.ts && npx
  tsx --tsconfig server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
expect: |-
  两条命令都必须 exit 0。

  第一条（e2e，真实浏览器）：固定语料的音频文件通过 `<input type="file">` 上传，经浏览器真实的
  `AudioContext.decodeAudioData` 解码、`fileAudioSource` 分帧，和麦克风路径复用同一条
  `useVoiceRealtimeSession` 管线（`beginCapture`/socket 发帧逻辑一行代码不分叉）送进
  `/voice-realtime` 代理；fake 上游收到 >1 个 `input_audio_buffer.append` 帧后提出一个
  `session_send`，页面显示可编辑意图，编辑后发送的文本必须真的落进会话 transcript（reload 后仍可见），
  且模型原始提议文本不得出现在 transcript 里。全程不调用 `getUserMedia`，不存在任何麦克风替身代码路径。

  第二条（协议模拟，offline node:test）：`voice-realtime-ws-proxy.service.ts` 的五个场景 ——
  (1) chunked audio：N 个浏览器 `audio` 帧必须变成 N 个独立、顺序一致的 `input_audio_buffer.append`
  帧；(2) interruption：`decision:false` 必须让被拒绝的意图永不触达真实 `session_send`，且槽位必须
  恢复可用；(3) 断线（非显式 close 帧）必须让 pending 意图被判定为拒绝，并让 bridge 走 teardown；
  (4) 并发 response 竞态：两个 `session_send` function_call 在任一个被裁决前先后到达时，第二个必须被
  立即拒绝而不是静默覆盖 `pending`——否则第一个调用的 `await` 永远不 settle（已验证：去掉
  `voice-realtime-ws-proxy.service.ts` 里 `if (pending) throw ...` 这段单槽保护后，这一条用例在
  `waitFor` 的 2000ms 超时后真的失败，证明这不是摆设断言）；(5) 工具调用回填：批准后的（可能被编辑过
  的）文本必须进入真实 `session_send`，浏览器必须收到 `sent` 帧，上游必须收到同一个 `callId` 的
  `function_call_output`，其 `output` 与浏览器收到的 `result` 一致。

  取假形态：(a) 把 `fileAudioSource` 换成不产生任何帧的空实现 ⇒ 第一条命令里 intent 必须永不出现，
  红；(b) 去掉 proxy 的并发保护 ⇒ 第二条命令里的并发竞态用例必须红（已现场验证）；(c) 去掉
  `function_call_output` 的发送 ⇒ 回填断言必须红。两条命令此前都已在本次改动下独立跑绿，也都各自单独
  重跑过一次确认非一次性通过。
origin: >-
  2026-10-09 人 yale 补充 GOAL-031 / AC-312 的明确需求：Web 前端同时提供实时麦克风输入和音频文件上传，

  上传文件用于固定语料的自动化端到端测试；另需协议/接口层自动测试模拟实时交互（音频 chunk、时序、打断、

  重连、并发 response、工具调用/回填）。CI 必须能在无物理麦克风条件下自动验收上传与模拟链路；真实麦克风

  权限/设备仅保留 AC-312/AC5 已有的人工 smoke test，本条不重复、不继承那个人工门。复用

  `gap-voice-realtime-browser-e2e-current-session`（AC-312）已落地但未合并的
  `useVoiceRealtimeSession`/

  `VoiceRealtimeControl`/`voice-realtime-ws-proxy.service.ts`，而不是另起一条管线：新文件

  `audioSource.ts` 把麦克风与文件两个音频源统一成一个 `VoiceRealtimeAudioSource` 接口，和

  `src/modules/chat/hooks/useVoiceInput.ts` 的 `VoiceCaptureEngine`
  是同一种模式的复用，不是第二套设计。
activatedAt: 2026-10-09T05:59:50.776Z
statusLog:
  - at: 2026-10-09T06:15:49.380Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
