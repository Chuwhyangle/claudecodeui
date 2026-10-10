---
id: gap-live-voice-delivery-state-visible
title: Live Voice 交付状态线性可见（AC-327）：服务端在进入合并窗口的真实时刻发 outbound 帧，前端在那一行上依次显示「已听到」与「整理中」
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-single-transcript-row
goal_ac: AC-327
---
## Proposal

现状（2026-10-11 复核）：`server/index.ts:379` 的 `VOICE_REALTIME_COALESCE_MS = 2_500` 让每一次交付固定延后 2.5 秒。`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:696-775` 里 `sessionSend` 把模型的话推进 `pendingParts` 并 `armCoalesce()` 起一个 2500ms 定时器，`flushCoalesced` 到点才 `deliverSessionSend` 并给浏览器发 `sent`。这段窗口里浏览器**收不到任何帧**：`server.log` 全部 11 次交付都是 `coalesced 1 relayed piece(s) into one message`（如 `14:40:20.142` function_call → `14:40:22.643` coalesced），即这个窗口这一次没有合并任何东西、纯粹是等待；此刻屏幕上那一行没有任何变化。

人 yale 2026-10-11 在 GOAL-038 的三选一中裁定「两段式：已听到 + 整理中」——即接受为此改动服务端 outbound 帧集合，而不是用前端定时器推断一个可能是假的「整理中」。

做法：

1. **服务端**：在 `sessionSend` 把 `pendingParts` 从**空变非空**的那一刻（即模型已决定交付、进入合并窗口的真实时刻）向浏览器发一个 outbound 帧，语义是「已接受、待交付」；本任务提议 `{ type: 'queued' }`，名称以实现为准，语义不可换。同一段的重放分支（`activeSegmentIsReplay && deliveredSegmentSeqs.has(...)`）不发。既有 `state`/`ready`/`caption`/`sent`/`segment_ack`/`error` 帧的集合与相对顺序不变。
2. **客户端**：`useVoiceRealtimeSession.ts` 的 `ServerFrame` 联合与 `onmessage` 增加该帧的分支，导出一个「已受理但未交付」的布尔（或等价状态）。有 final caption 未交付 ⇒ 该行是「已听到」；收到该帧 ⇒ 同一行变「整理中」；`sent` ⇒ 两者都结束，该行成为带 `voice-transcript-badge` 的真实消息。
3. **渲染**：两个状态都落在**同一行**上（`data-testid="voice-row-heard"` / `data-testid="voice-row-delivering"`），不是新控件、不是新行；底栏不动（AC-323 的判据钉住它）。样式复用现有主题（muted 前景 + 既有的 `motion-safe:` 动画约定）。
4. **判据文件是本任务新建的**：`src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx`。AC-327 的 criterion 点名它，它不在时 `vitest run` 报 `No test files found, exiting with code 1`。⚠️ 2026-10-11 的实况：只用既有测试文件的判据在工作尚未开始时就是绿的，goal-driver 据此把 AC-326 与 AC-327 双双机械翻成 `achieved`；点名新文件是让判据在落地前必红的唯一手段。
5. **服务端断言写进既有的** `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`：一次 `session_send` ⇒ 恰好一个该帧且早于 `sent`；重放不多发。**不新建服务端测试文件**——新建会牵动 `scripts/suite-duration-baseline.tsv` 的耗时基线行，与本条要证的事无关。`server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts` 的既有帧序断言保持绿（若因新增帧而需要收紧，收紧的是「既有帧的相对顺序不变」而不是放宽）。
6. `e2e/voice-realtime-upload-fixture.spec.ts` 增加浏览器读数用例：假上游在交付前把 `session_send` 的落地延后，以便「已听到」与「整理中」两个状态都能被看到。

<!-- dedup-ref --> 本条依赖 `gap-live-voice-single-transcript-row`（AC-326）：AC-327 的 (e)(f) 要求「那一行」先存在，否则两个状态没有承载物。`depends_on` 已声明，调度器据此串行。

## AC

- [ ] `npm run test:client -- src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx` 退出 0（该文件由本任务新建，是 AC-327 criterion 点名的判据文件）
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 退出 0，且新增断言：一次 `session_send` 之后 `sent` 之前 outbound 里**恰好一个**该帧
- [ ] 同一段重放（`activeSegmentIsReplay` 分支）不再多发一个
- [ ] 既有帧集合与相对顺序不变：`state`/`ready`/`caption`/`sent`/`segment_ack`/`error` 的断言原样通过
- [ ] e2e：存在未交付的 final caption 时该行带 `data-testid="voice-row-heard"`
- [ ] e2e：收到该帧后**同一行**变为 `data-testid="voice-row-delivering"`，且 `voice-row-heard` 不再存在
- [ ] e2e：交付后两个 testid 都消失，该行变为带 `data-testid="voice-transcript-badge"` 的真实消息
- [ ] e2e：这两个 testid 只在 Live Voice 模式下的那一行出现，普通文本 user 行不出现
- [ ] e2e：从最后一条 final caption 到该行出现 `voice-row-delivering` 不超过 2 秒（服务端实测窗口 2.50s，留 ≥0.5s 余量）
- [ ] 取假形态现场红再还原：不发该帧 ⇒ 第六条红；把它发在 `sent` 之后 ⇒ 第二条红；移除两个 testid ⇒ 第五、六条红
- [ ] 既有判据不变红：AC-326 的判据命令仍 exit 0；`e2e/voice-realtime-upload-fixture.spec.ts` 三条既有用例仍绿；`npm run typecheck` 退出 0

## DoD

真实浏览器 + 假上游实测并在本任务 Evidence 记录读数：一次交付里，「已听到」→「整理中」→ 定型为带徽章的真实消息三个阶段都在**同一行**上被观察到（截图或 trace 落在 `artifacts/live-voice/` 下并已查看），且从最后一条 final caption 到「整理中」的时间 ≤2 秒。服务端侧在 `server.log` 里能读到该帧与 `coalesced …` 同一时刻的相邻行。AC-327 的 criterion 合入 develop 后 exit 0（fan-in 后 `quay goal gate AC-327` 退出 0）——它点名 `voiceDeliveryState.test.tsx`，该文件未落地时这条判据必红。不是「测试存在」——是这两个状态真的在浏览器里被看到过。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx
- src/modules/chat/ChatInterface.tsx
- e2e/voice-realtime-upload-fixture.spec.ts
- tasks/gap-live-voice-delivery-state-visible.md（self）
