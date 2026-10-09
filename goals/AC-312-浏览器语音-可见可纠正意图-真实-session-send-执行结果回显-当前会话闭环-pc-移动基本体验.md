---
id: AC-312
title: 浏览器语音→可见可纠正意图→真实 session_send→执行结果回显：当前会话闭环，PC+移动基本体验
status: achieved
kind: criterion
goal: GOAL-031
criterion: npx playwright test e2e/voice-realtime-live-session-send.spec.ts
  e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
expect: |-
  三条命令合一，均必须 exit 0（2026-10-09 人 yale 裁定重定形态，细节见下方「2026-10-09 重定」）。

  第一层（UI，不单独是一条命令，是前两条判据得以成立的前提）：Web 前端同时提供真实麦克风与音频文件上传两个输入入口，二者共用同一条 `useVoiceRealtimeSession` 管线（`connect`/`beginCapture`，一行代码不分叉），不是两套实现。

  第二层（`e2e/voice-realtime-live-session-send.spec.ts` + `e2e/voice-realtime-upload-fixture.spec.ts`，链式跑在一次 Playwright 调用里）：麦克风路径（假麦克风替身，按本仓库既有 e2e 惯例）与文件上传路径（固定语料 WAV，真实 `AudioContext.decodeAudioData`，全程不调用 `getUserMedia`）各自跑通 PC 与 375px 移动视口共四条 leg；每条 leg 都要看到模型提议的可编辑意图（**用户可在送出前编辑**，低摩擦——编辑能力本身就是纠正机制，不要求勾选框/确认弹窗），编辑后调用 AC-310 落地的 `session_send` 路径送达当前会话，执行结果通过**现有**聊天转录渲染呈现（复用 `ChatRunSource==='mcp'` 的既有渲染，不新建反馈 UI），reload 后仍可见，模型原始提议文本不得出现在 transcript 里。

  第三层（`server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`，offline `node:test`，驱动 `/voice-realtime` 代理本身，不经浏览器）：chunk 时序（N 个浏览器音频帧必须变成 N 个独立、顺序一致的上游帧）、打断（`decision:false` 必须让被拒绝的意图永不触达真实 `session_send`，且槛位恢复可用）、断线/重连清理（非显式 close 帧断线必须让 pending 意图被判定为拒绝，bridge 走 teardown）、并发 response 竞态（两个 `session_send` function_call 在被裁决前先后到达，第二个必须被立即拒绝而不是静默覆盖单槛位 `pending`——否则第一个调用永远不 settle）、工具调用回填（批准后的文本进入真实 `session_send`，浏览器收到 `sent` 帧，上游收到同一个 `callId` 的 `function_call_output`）。

  取假形态：(a) `fileAudioSource` 换成不产帧的空实现 ⇒ 第二层上传 leg 的 intent 永不出现，红；(b) 去掉代理的并发保护 ⇒ 第三层并发竞态用例必须红（已现场验证：删除保护后该用例在 2000ms `waitFor` 超时后真的失败）；(c) 去掉 `function_call_output` 发送 ⇒ 第三层回填断言必须红。

  **2026-10-09 重定（人 yale 裁定，替换原形态）**：原 AC5「至少一次真实麦克风+真实网络的端到端走查，人工确认结果正确渲染（手动，不进 CI）」从本判据拆出，不再是 AC-312 `done` 的前提条件。该人工走查独立立案为 `gap-voice-realtime-microphone-human-smoke-test`（`needs-human`，明确不阻塞任何判据/任务），可在任意时间由具备真实硬件的人完成，完成与否都不影响本 AC 的 `achieved` 状态。本判据改为完全可自动验收：CI 在零物理麦克风条件下即可对第二层（文件上传路径）与第三层（协议模拟）给出确定性读数；第二层里麦克风路径的那一半继续沿用假麦克风替身（与本仓库既有 e2e 惯例一致），不是本判据新引入的妥协。
origin: 本 GOAL
  目标链路第一句（浏览器语音输入→…→执行反馈）；docs/proposals/voice-native-control-plane.md
  §1/§9/§10.7 的分层与鉴权设计；人 yale 的两轮纠正——(1) 不新建确认流程，复用既有渲染与既有权限边界；(2) 2026-10-09
  把真实麦克风人工走查从本判据拆出为独立非阻塞任务，本判据改用麦克风+上传+协议模拟的三层自动化方案结算，CI 可在零物理麦克风条件下全自动验收。
activatedAt: 2026-10-09T02:13:52.926Z
statusLog:
  - at: 2026-10-09T02:13:52.926Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-09T06:17:55.904Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-09T02:13:52.926Z
---
