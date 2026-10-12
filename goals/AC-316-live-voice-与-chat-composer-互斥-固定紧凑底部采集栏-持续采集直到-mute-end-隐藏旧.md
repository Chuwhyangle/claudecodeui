---
id: AC-316
title: Live Voice 与 Chat Composer 互斥；固定紧凑底部采集栏；持续采集直到 Mute/End；隐藏旧
  Start/Upload/草稿确认 UI；音频注入保留为测试通道
status: achieved
kind: criterion
goal: GOAL-033
criterion: npx playwright test e2e/voice-realtime-live-session-send.spec.ts
  e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
  && npx playwright test e2e/voice-trim.spec.ts -g "AC-120"
expect: |-
  三条命令合一，均 exit 0，PC/移动两个视口下都适用。

  一、布局与互斥（新增 UI 断言，前两条 Playwright 命令覆盖）：
  - 进入 Live Voice 模式后，`ChatComposer` 的输入框（text 模式下可见的 composer textarea）不可见；退出后恢复可见。任一时刻二者不同时可见。
  - 不再存在旧的 `voice-realtime-start`、可见的 `voice-realtime-upload`（按钮）、`voice-realtime-intent`、`voice-realtime-send`、`voice-realtime-cancel` 这些 testid 对应的元素（断言其在 DOM 中不可见或不存在，不是换了位置）。
  - 固定底部采集栏（新 testid，如 `voice-realtime-bar`）在 idle/connecting/listening/muted/executing/failed 各阶段的 `boundingBox().height` 相等或在 ≤4px 容差内——机械化「不放大、不切全屏」的要求。
  - 隐藏的音频文件 input（`voice-realtime-upload-input`）仍存在于 DOM、仍可被 `setInputFiles` 直接注入，但没有可见的触发按钮（`getByRole('button', {name:/upload/i})` 在 voice 模式下不可见）。

  二、持续采集语义：
  - 进入 Live Voice 即开始采集（测试用既有的 `__voiceFake`/`startWithFile` 注入，无需真实麦克风），采集持续到用户点 Mute 或 End；Mute 不关闭 `/voice-realtime` 连接（断言：Mute 后再 Unmute 不触发新的 WS 连接计数，`upstream.connectionCount()` 不变）；Mute 期间不再发送音频帧（上游收到的帧数在 Mute 期间不增长）。
  - 模型执行阶段（`session_send` 已送达、结果尚未回显）采集不中断——断言执行期间 Mute/Unmute 仍可操作，且采集状态不被执行过程重置。
  - End 才真正关闭连接并退出 Live Voice 模式，回到 `ChatComposer`。

  三、无草稿确认，直接送达：
  - 代理收到模型的 `session_send` function_call 后立即执行（不再等待浏览器 `decision` 帧），浏览器不展示可编辑草稿/Send/Cancel；执行结果仍通过既有 `mcp` 来源转录渲染呈现，reload 后可见——语义上等价于原 AC-312 AC1/AC3，只是不再有人工确认这一步。
  - 代理单槽并发保护（防止两个 `session_send` 互相踩踏）与 `function_call_output` 回填两者都保留，适配成「保护真实并发调用」而不是「保护等待浏览器决定的并发提案」。

  四、回归范围：不弱化、不误伤既有判据：
  - 第三条命令（AC-120）必须 exit 0——证明 `VoiceUploadButton` 自己的 `voice-upload-input` 定位、`?voiceDebug` 开关行为未被本次改动触碰。
  - 第二条判据文件（协议模拟）仍是 5 个场景全绿：chunk 时序、打断（现在打断就是 Mute，不是 decision:false，场景按新语义改写但覆盖面不降）、断线清理、并发竞态、工具调用回填。
  - `npm run typecheck`、`npm run lint` 均 exit 0，无新增 voice-realtime 相关告警。

  取假形态：(a) 把互斥渲染改回同时渲染 composer + bar ⇒ 第一条/第二条命令里的"composer 不可见"断言必须红；(b) 把 Mute 实现改回关闭并重开连接 ⇒ 连接计数断言必须红；(c) 去掉代理的单槽并发保护 ⇒ 并发场景必须红（延续 AC-315 已验证过的取假形态）。
origin: 2026-10-09 人 yale 正式批准：参照已认可的 ChatGPT 原型布局/交互结构重做 Live Voice，但视觉完全复用
  ClaudeCodeUI
  现有主题（不照搬原型配色）。本条是该改造里可独立实现、可独立回归验收的第一增量——互斥模式切换、固定紧凑底部栏、持续采集、去掉草稿确认
  UI、音频注入保留为测试通道。不包含实时 ASR 文本转写以用户消息形式显示（interim/final、去重、顺序）——那部分需要新的后端协议事件映射与
  transcript 渲染改动，复杂度与风险都单独成立，见 AC-317（依赖本条，暂未实现）。
activatedAt: 2026-10-09T08:06:47.420Z
statusLog:
  - at: 2026-10-09T08:09:19.230Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
supersedes:
  - AC-312
timeoutMs: 118000
---
