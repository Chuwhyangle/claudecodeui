---
id: AC-327
title: Live Voice 交付状态线性可见：服务端在进入合并窗口的真实时刻发 outbound 帧，前端在转写行上依次显示「已听到」与「整理中」，静默段不再无提示
status: active
kind: criterion
goal: GOAL-038
criterion: npm run test:client --
  src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx && npx tsx
  --tsconfig server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
  && npx playwright test e2e/voice-realtime-upload-fixture.spec.ts
expect: >-
  三条命令均 exit 0。


  〇、判据为何点名一个**尚不存在的文件**（`voiceDeliveryState.test.tsx` 由本 AC 的任务创建）。同 AC-326
  条〇：只用既有测试文件的判据在工作尚未开始时就 exit 0（2026-10-11 实测），goal-driver 会据此把 AC 机械翻成
  achieved——AC-326 就这样被空过翻绿过一次（commit
  `7e936c03`）。点名新文件使本条在实现落地前必红。服务端断言放在**既有**的
  `voice-realtime-ws-proxy.protocol-simulation.test.ts` 里，不新建服务端测试文件——新建会牵动
  `scripts/suite-duration-baseline.tsv` 的耗时基线行，与本条要证的事无关。


  一、服务端在「模型已决定交付、但还在合并窗口里」这一**真实时刻**发一个 outbound 帧（名称以实现为准，语义是「已接受、待交付」）。协议模拟读数：

  (a) 一次 `session_send` 调用之后、`sent` 帧之前，outbound 里**恰好一个**该帧；

  (b) 它在时间序上早于 `sent` 帧；

  (c) 同一段的重放（`activeSegmentIsReplay` 分支）不再多发一个；

  (d) 既有 `state`/`ready`/`caption`/`sent`/`segment_ack`/`error` 帧的集合与相对顺序不变。


  二、前端把这两个状态渲染在**那一行**上（不是新控件、不是新行），由新判据 `voiceDeliveryState.test.tsx` 覆盖状态迁移：

  (e) 存在未交付的 final caption 时，该行带 `data-testid="voice-row-heard"`；

  (f) 收到该帧后**同一行**变为 `data-testid="voice-row-delivering"`，且 `voice-row-heard`
  不再存在；

  (g) 交付后两个 testid 都消失，该行变为带 `data-testid="voice-transcript-badge"` 的真实消息；

  (h) 这两个 testid 只在 Live Voice 模式下的那一行出现，普通文本 user 行不出现。


  三、静默段有界可读：从最后一条 final caption 到达、到该行出现 `voice-row-delivering`，不得超过 2
  秒（`server.log` 实测 `function_call` → 交付为 2.50s 固定窗口，故保留 ≥0.5s 余量）。


  现状（2026-10-11 复核）：`server/index.ts:379` 的 `VOICE_REALTIME_COALESCE_MS = 2_500`
  让交付固定延后 2.5s，期间浏览器收不到任何帧——`server.log` 全部 11 次交付都是 `coalesced 1 relayed
  piece(s) into one message`，即这段窗口没有合并任何东西，纯粹是等待；此刻该行没有任何变化。故 (e)(f) 现在必红。


  取假形态：(a) 不发该帧 ⇒ (f) 红；(b) 把它发在 `sent` 之后 ⇒ (b) 红；(c) 移除 heard/delivering 的
  testid ⇒ (e)(f) 红；各自恢复后回绿。


  (d) 既有判据不得变红：AC-326 的判据命令仍 exit 0；`npx playwright test
  e2e/voice-realtime-upload-fixture.spec.ts` 的三条既有用例仍绿；`npm run typecheck` exit
  0。
origin: 2026-10-11 人 yale 在 GOAL-038 的三选一中裁定「两段式：已听到 + 整理中」——即接受为此改动服务端 outbound
  帧集合。现状读数取自
  `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:696-775`（coalescing
  段与 `sessionSend`）与 `server/index.ts:379`，以及 `server.log` 连接 d88c6722 的 11 次
  `coalesced 1 relayed piece(s)`。
activatedAt: 2026-10-10T18:16:21.781Z
statusLog:
  - at: 2026-10-10T18:16:21.781Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-10T18:21:13.773Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-10-10T18:24:28.017Z
    from: achieved
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-10T18:24:28.017Z
---
