---
id: gap-live-voice-delivery-state-visible
title: Live Voice 交付状态线性可见（AC-327）：服务端在进入合并窗口的真实时刻发 outbound 帧，前端在那一行上依次显示「已听到」与「整理中」
status: done
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

- [x] `npm run test:client -- src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx` 退出 0（该文件由本任务新建，是 AC-327 criterion 点名的判据文件）
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 退出 0，且新增断言：一次 `session_send` 之后 `sent` 之前 outbound 里**恰好一个**该帧
- [x] 同一段重放（`activeSegmentIsReplay` 分支）不再多发一个
- [x] 既有帧集合与相对顺序不变：`state`/`ready`/`caption`/`sent`/`segment_ack`/`error` 的断言原样通过
- [x] e2e：存在未交付的 final caption 时该行带 `data-testid="voice-row-heard"`
- [x] e2e：收到该帧后**同一行**变为 `data-testid="voice-row-delivering"`，且 `voice-row-heard` 不再存在
- [x] e2e：交付后两个 testid 都消失，该行变为带 `data-testid="voice-transcript-badge"` 的真实消息
- [x] e2e：这两个 testid 只在 Live Voice 模式下的那一行出现，普通文本 user 行不出现
- [x] e2e：从最后一条 final caption 到该行出现 `voice-row-delivering` 不超过 2 秒（服务端实测窗口 2.50s，留 ≥0.5s 余量）
- [x] 取假形态现场红再还原：不发该帧 ⇒ 第六条红；把它发在 `sent` 之后 ⇒ 第二条红；移除两个 testid ⇒ 第五、六条红
- [x] 既有判据不变红：AC-326 的判据命令仍 exit 0；`e2e/voice-realtime-upload-fixture.spec.ts` 三条既有用例仍绿；`npm run typecheck` 退出 0

## DoD

真实浏览器 + 假上游实测并在本任务 Evidence 记录读数：一次交付里，「已听到」→「整理中」→ 定型为带徽章的真实消息三个阶段都在**同一行**上被观察到（截图或 trace 落在 `artifacts/live-voice/` 下并已查看），且从最后一条 final caption 到「整理中」的时间 ≤2 秒。服务端侧在 `server.log` 里能读到该帧与 `coalesced …` 同一时刻的相邻行。AC-327 的 criterion 合入 develop 后 exit 0（fan-in 后 `quay goal gate AC-327` 退出 0）——它点名 `voiceDeliveryState.test.tsx`，该文件未落地时这条判据必红。不是「测试存在」——是这两个状态真的在浏览器里被看到过。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx
- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/ChatInterface.tsx
- src/shared/types.ts
- e2e/voice-realtime-upload-fixture.spec.ts
- tasks/gap-live-voice-delivery-state-visible.md（self）

## 验证记录

实测读数（本任务 worktree `gap-live-voice-delivery-state-visible`，分支 `task/gap-live-voice-delivery-state-visible`；实现提交 `8be9df6b`，其后 `b72ca566`（补一行窗口开启日志）、`3d9da820`（截图时序与回读断言）；预退出合并 develop 后 HEAD `65525436`→`3d9da820`）：

- **服务端**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` ⇒ 13 passed。新增两条——(A) 一次 `session_send` ⇒ `queuedFrames.length === 1` 且 `indexOf(queued) < indexOf(sent)`；`transport.drop()` 触发重放后交付第二条 ⇒ 仍 1 个 `queued`、1 个 `sent`、1 次落地；(B) 同一窗口内第二条 `session_send` ⇒ 仍 1 个 `queued`。`…voice-realtime-streaming-stages.test.ts` ⇒ 15 passed（既有帧集合与相对顺序未变）。
- **前端**：`npm run test:client -- src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx` ⇒ 11 passed（hook 的 `delivering` 由 `queued` 开、`sent`/重连/socket 关闭关；fold 的行状态 heard/delivering/undefined；DOM 上两个 testid 互斥、交付行只剩 `voice-transcript-badge`、普通文本行两者皆无）。
- **e2e**：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` ⇒ 5 passed（3 条既有 + AC-326 的一条 + 本条新用例）。新用例实测：假上游听到 `ping the build server about the failed nightly`、延后 `1_200 ms` 才 `session_send` 交付 `tell the platform team the nightly failed`；同一行先 `data-testid="voice-row-heard"`（`row.first()` 的实测属性为 `voice-row-heard`），随后同一行变 `voice-row-delivering` 且 `voice-row-heard` 计数 0，交付后两个 testid 计数皆 0、该行带 `voice-transcript-badge`；判据用的普通文本 seed 行 `data-testid` 实测为 `null`。从该行出现（首条 caption 的 interim delta，不晚于最后一条 final caption）到 `voice-row-delivering` 的实测间隔 ≤ 2000 ms（延后 1200 ms + 帧行程，余量 >0.7 s）。
- **DoD ①：三阶段落在同一行，截图落 `artifacts/live-voice/` 并逐张查看**：`QUAY_LIVE_VOICE_SHOT_DIR=<wt>/artifacts/live-voice npx playwright test e2e/voice-realtime-upload-fixture.spec.ts -g "the delivery wait is visible"` ⇒ 1 passed，落三张图并逐张开图确认——`ac327-heard-1280.png`（该 user 行 mic 图标 + 「Heard」，文本仍是听到的 `ping the build server about the failed nightly`）、`ac327-delivering-1280.png`（**同一行** mic + 「Tidying up…」）、`ac327-delivered-1280.png`（**同一行**「From voice transcript」徽章 + 交付文本 `tell the platform team the nightly failed`）。三张的底栏都是同一条 Live Voice 底栏。⚠️ 此处发现并修掉一个错标证据：首跑时 `ac327-heard-1280.png` 拍到的是「Tidying up…」——`shot()` 里 700 ms 的「等颜色过渡」把 `heard` 阶段（只到 `queued` 帧落地为止）跑过去了，图与标签不符。改法（提交 `3d9da820`）：`shot()` 增 `settleMs`（默认 700），`heard` 一枪传 0 且在**截图之后**回读该行 `data-testid` 仍为 `voice-row-heard`，`delivering` 一枪同样回读；画面越过自身阶段即测试红，不再以错标图充当证据。修后重跑 1 passed，重看 `ac327-heard-1280.png` 现为「Heard」。
- **DoD ②：服务端 `server.log` 相邻读数**：`VOICE_REALTIME_LOG_DIR=<wt>/artifacts/live-voice/journal` 再跑一次同一条用例（journal 即服务端侧日志，`server/index.ts:624` 把 proxy 的 `log` seam 接到 recorder），`<connectionId>.jsonl` 里这一次交付读到相邻的行——
  ```
  function_call session_send {…"message":"tell the platform team the nightly failed","waitSeconds":0.5}
  queued: opening a 2500 ms coalescing window (the frame precedes the sent)
  to-browser queued
  …
  coalesced 1 relayed piece(s) into one message
  session_send delivered in 11 ms
  ```
  窗口**开启**那一刻的帧与窗口**关闭**那一刻的 `coalesced …` 同处一条交付记录、可相邻读到；`to-browser queued` 是 observe 侧对出站帧的记录，证明帧确实发出。提交 `b72ca566` 加的正是那行 `queued:` 日志——此前该帧只走 WS、日志里读不到（DoD 那句「能读到该帧」原本无从满足）。
- **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0（239 warnings、0 errors；本任务改动的文件未新增任何 warning）。
- **取假形态（三条，现场红后 `git checkout --` 还原；还原后 `git status --porcelain` 为空）**：
  - **不发该帧**（把 `send({ type: 'queued' })` 换成注释）⇒ 第 2 条红（`AssertionError: one accepted delivery opens exactly one window`，两条新用例皆红）且第 6 条红（e2e 在 `spec:1302` 等 `voice-row-delivering` 超时）。**此形态在合并树 `3d9da820` 上复跑仍红**（protocol-simulation 11 passed / 2 failed，红的正是两条 AC-327 用例），随即 `git checkout --` 还原、`grep -c "send({ type: 'queued' })"` = 1。
  - **把它发在 `sent` 之后**（帧移到 `deliverSessionSend` 里 `sent` 之后）⇒ 第 2 条红（`AssertionError: the window-opening frame must precede the sent that closes it`）。
  - **移除两个 testid**（删掉 `MessageComponent` 的 `data-testid` 三元）⇒ 第 5、6 条红（e2e 在 `spec:1296` 的 `voice-row-heard` 实测属性断言失败），同时判据文件本身红（`voiceDeliveryState.test.tsx` 2 failed | 9 passed，红的正是两条 testid 断言）。
  - 后两次形态实测于 `8be9df6b`；其后 `b72ca566` 只加一行日志、`3d9da820` 只改截图时序与回读断言，均未触碰这两条形态的位点（`send({ type: 'queued' })` 与 `MessageComponent` 的 testid 三元），形态结论不变。
- **AC-326 不变红**：`npm run test:client -- …/voiceSingleTranscriptRow.test.ts …/useVoiceRealtimeSession.test.tsx` ⇒ 2 files / 33 passed。
- **预退出合并后复跑**：预退出时按 §阶段 2b 执行 `git merge develop`，本次**不是** Already up to date——develop 已前进（拉到 `gap-voice-turn-detection-p0-6-dataset-benchmark` 等任务文件），合并产生合并提交 `65525436`；合并未触及本任务任何 Touches 文件。合并后在合并树上把 AC-327 的三条 criterion 全部复跑：protocol-simulation ⇒ 13 passed、streaming-stages ⇒ 15 passed、`voiceDeliveryState.test.tsx` ⇒ 11 passed、e2e ⇒ 5 passed（36.3s）；`npm run typecheck` 退出 0、`npm run lint` 退出 0。`git diff --name-only develop...HEAD` 恰好是本任务 Touches 里的 9 个文件，`anti-drift-touches-check.js --task … --worktree …` ⇒ `ANTI-DRIFT OK: … 9 actual file(s), all within declared Touches (11 glob(s))`。

### 一处与 Plan 措辞的收窄（已按实测钉住，非 finding）

Plan 第 1 条说「`pendingParts` 从空变非空的那一刻」发帧。实现按此，但把「非空」落在**有实际文本被推入**上：`openingWindow && pendingParts.length > 0`。一条只带空/空白 `message` 的 `session_send` 不会让 `pendingParts` 变非空，因而**不发**该帧——与相邻任务 `gap-voice-realtime-empty-transcript-delivery-guard` 的「空转写不投递」守卫同向（空内容既不开启窗口，也不产生「整理中」）。另：`coalesceMs <= 0` 的直投路径（`deliverSessionSend` 直返）与重放分支都不发该帧，见 `voice-realtime-ws-proxy.service.ts` 的帧注释。
