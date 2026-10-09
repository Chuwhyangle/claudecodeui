---
id: AC-315
title: 语音前端同时支持真实麦克风与音频文件上传，上传与协议模拟测试完全不依赖物理麦克风（CI 可全自动验收）
status: achieved
kind: criterion
goal: GOAL-031
criterion: npx playwright test e2e/voice-realtime-upload-fixture.spec.ts && npx
  tsx --tsconfig server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
expect: >-
  （2026-10-09 人 yale 裁定：本条的判据按 GOAL-033/AC-316 的 UI
  形态**重指**——保留仍然为真的上传与协议保证，删去随被 supersede 的旧 UI
  形态一并废弃的描述。命令不变，仍是上面那两条。改写来源：GOAL-033（其 origin 与「非目标」两处都写明 AC-315
  的后端/协议保证不受影响、不重新验收）+ AC-316（正式 supersede 的只有 AC-312 的草稿确认 / 可见 Start&Upload
  那一层 UI 形态）+ 任务
  `gap-ac315-upload-criterion-repoint-under-voice-bar`（把判据文件本体重指到已出货的
  `VoiceRealtimeBar` UI）。本条状态保持 achieved、**未被 supersede**。）


  两条命令都必须 exit 0。


  第一条（e2e，真实浏览器）：固定语料的音频文件通过 `<input type="file">` 注入（AC-316 之后该 input
  是隐藏的测试通道：仍在 DOM、仍可被 `setInputFiles` 直接注入，但没有可见的触发按钮），经浏览器真实的
  `AudioContext.decodeAudioData` 解码、`fileAudioSource` 分帧，和麦克风路径复用同一条
  `useVoiceRealtimeSession` 管线（`beginCapture`/socket 发帧逻辑一行代码不分叉）送进
  `/voice-realtime` 代理；上游必须收到 >1 个 `input_audio_buffer.append` 帧（证明真的解码 +
  分帧，不是单帧、不是空实现），且必须建立 ≥1 条连接；注入指令的文本必须真的落进会话 transcript，且 `page.reload()`
  之后仍可见。全程不调用 `getUserMedia`（用例对 `navigator.mediaDevices.getUserMedia`
  打桩计数，结束时断言为 0），不存在任何麦克风替身代码路径。


  已随旧形态废弃、不再由本条断言的部分（AC-312 的草稿确认形态，GOAL-033/AC-316 已 supersede）：页面上「可编辑意图草稿 +
  Send/Cancel」这一步；「模型原始提议文本不得出现在 transcript」（AC-316 之后模型提议即刻执行，提议文本本身就是发送内容）；以及用
  `decision:false` 表达的打断语义（AC-316 之后打断 = Mute）。旧控件与旧
  testid（`voice-realtime-control` / `-intent` / `-send` / `-cancel` / `-start` /
  `-stop`）不得复活。


  第二条（协议模拟，offline node:test）：`voice-realtime-ws-proxy.service.ts` 的五个场景必须全绿 ——
  (1) chunked audio：N 个浏览器 `audio` 帧必须变成 N 个独立、顺序一致的 `input_audio_buffer.append`
  帧；(2) 打断：按 AC-316 的 Mute 语义断言（不发送音频帧、不新开连接、连接保持可用，被拒绝 / 被打断的意图永不触达真实
  `session_send`）；(3) 断线（非显式 close 帧）必须让 in-flight 的真实 `session_send` 走
  teardown；(4) 并发 response 竞态：两个 `session_send` 先后到达时，第二个必须被立即拒绝而不是静默覆盖
  `pending`——否则第一个调用的 `await` 永远不 settle（已验证：去掉
  `voice-realtime-ws-proxy.service.ts` 里那段单槽保护后，这一条用例在 `waitFor` 的 2000ms
  超时后真的失败）；(5) 工具调用回填：执行后的文本必须进入真实 `session_send`，上游必须收到同一个 `callId` 的
  `function_call_output`，其 `output` 与浏览器收到的 `result` 一致。


  取假形态：(a) 把 `fileAudioSource` 换成不产生任何帧的空实现 ⇒ 第一条命令里注入的指令必须永不落进 transcript，红；(b)
  去掉 proxy 的单槽并发保护 ⇒ 第二条命令里的并发竞态用例必须红；(c) 去掉 `function_call_output` 的发送 ⇒
  回填断言必须红。
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
