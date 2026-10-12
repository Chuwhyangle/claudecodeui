---
id: AC-317
title: 实时 ASR interim/final transcript 作为用户消息展示，不混入模型推理输入（依赖 AC-316，本轮暂未实现）
status: achieved
kind: criterion
goal: GOAL-033
criterion: npx playwright test e2e/voice-realtime-upload-fixture.spec.ts && npx
  tsx --tsconfig server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
expect: |-
  两条命令均 exit 0（GOAL-033 / AC-317，已实现）。

  一、端点的转写事件被识别，不再误报为未知事件。`conversation.item.input_audio_transcription.delta`（累计文本在 `stash` 字段，`text` 恒为空）与 `.completed`（最终文本在 `transcript`）在 bridge 的 dispatch 里各有分支，转发为 outbound `caption` 帧 `{type, itemId, text, final}`。协议模拟套件里三条用例覆盖：(a) 两个 delta 产生两个 caption 帧且**零** error 帧（这条是回归——AC-317 之前它们落到 `UNKNOWN_EVENT`，持续采集下会把 UI 泡在一串失败里）；(b) `.completed` 以 `final:true` 携带最终文本、`itemId` 与 delta 相同；(c) caption 文本与真实 `session_send` 的 `message` 参数来自两条互不相通的通路（用例里两者故意是不同字符串，断言送进 executor 的始终是模型自己的 arguments）。

  二、转写以**用户消息**出现在 transcript 里，而不是底栏里。e2e 的假上游同时发出转写事件与 function_call：`HEARD_TEXT`（端点声称听到的）必须作为 user 行出现在 `.chat-messages-pane` 中，而 `PROPOSED_TEXT`（模型自己决定发送的指令）独立出现——两个字符串故意不同，把展示通道与模型输入通道混为一谈的实现无法同时满足两条断言。

  三、按 `itemId` 去重、替换而非追加：前端对同一 `itemId` 的后续 caption **替换**该条文本（首次到达时记录时间戳，之后沿用），所以一段持续数秒的 interim 流只对应一个气泡、不会每来一个 delta 就多一行。captions 在每次新连接开始时清空。

  取假形态：(a) 去掉 bridge 的 caption dispatch 分支 ⇒ 协议模拟的两条 caption 用例必须红（已现场验证：删掉分支后两条用例在 2000ms `waitFor` 超时后失败，恢复后 8/8 绿）；(b) 把 caption 行接到 `chatMessages` 而非 `visibleMessages` ⇒ e2e 的 user 行断言必须红（已现场复现：transcript 渲染的是 `visibleMessages`，接错时该断言收到 0）。
origin: 2026-10-09 人 yale 的结构化规格补充：实时 ASR transcript 仅作为用户消息显示、不得成为模型推理输入、需正确处理
  interim/final 与重复与顺序；并明确「若服务端语义尚不支持真正持续采集，请识别并明确实现差距，不能只做
  CSS」。实现差距已核实并闭合：`toBridgeEvent` 本就透传这两种事件（transport 第 412 行兜底），但 bridge 的
  `dispatch()` 只认 `function_call`，其余一律 `UNKNOWN_EVENT`，代理再把它变成发给浏览器的 error
  帧——持续采集下即一串失败。事件字段形状取自真实抓包
  `experiments/voice-realtime-ambiguity/real-trace/qwen38-omni-realtime-trace.json`。
activatedAt: 2026-10-09T10:36:35.596Z
statusLog:
  - at: 2026-10-09T10:36:35.596Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-09T10:44:58.174Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-09T10:36:35.596Z
timeoutMs: 115000
---
