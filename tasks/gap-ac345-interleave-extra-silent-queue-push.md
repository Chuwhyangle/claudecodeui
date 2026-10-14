---
id: gap-ac345-interleave-extra-silent-queue-push
title: AC-345 用例 2 判据红：一次语音投递在 CLI 队列里留下两条项（第二条无任何投递、压紧时序才出现、+6 s 松弛即消失的竞争）——归因并修
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-345
---
## Proposal

**判据形式**（AC-345 的 criterion 逐字）：`f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test "$f"`

**当前读数（HEAD = `911105364`，tree `07837ead`，2026-10-14）**。直接重跑（会话内按 AGENTS.md 套 `bash scripts/with-memory-cap.sh`，下同）：

- 整文件：`1 failed` / `5 did not run` / `1 passed (57.9s)`，EXIT=1。
- 用例 1 绿（14.0 s）。用例 2（`e2e/voice-realtime-intent-control.spec.ts:904`）在 `:963` 红：`Expected: 4, Received: 5`，附「Timeout 20000ms exceeded while waiting on the predicate」——队列读到 5 项，而契约是 4 项，且 20 s 轮询内不回落到 4。
- `test.describe.configure({ mode: 'serial', timeout: 120_000 })`（`:618`）把一次失败级联成「5 did not run」，于是整文件退出 1。
- 只跑该用例（`-g "typed message and a spoken sentence"`）同样红，「Received: 5」。

台账里同一条判据此前是绿的：AC-345 的 goal gate 在 2026-10-13T14:09 与 T22:51 两次 pass；2026-10-14T07:04:47 与 T07:08:59 两次 fail（tree `3af89b8f`）。⇒ 回归落在 2026-10-13T22:51 之后、2026-10-14T07:04 之前合入 develop 的改动上。

**多出来的那一项是什么**（探针读数；临时改动已 `git checkout --` 回滚，工作区干净）：

- 队列读数走 `GET /api/debug-agent/queue?sessionId=…`，只回 uuid 列表（`server/modules/debug-agent/debug-agent.routes.ts:409-425`）；正文只在投递侧 `sent` 帧里。所以在分步读数里，浏览器从未被交过 id 的那一项读作 `<unobserved:…>`——**多出来的那一项没有任何 `sent` 帧**，它是「静默」多推，不是重复投递。
- 该用例全程只发 2 个 `sent` 帧（OPENING 与 SPOKEN）。
- 分步读数：进入 Live Voice 之后队列 2 项（OPENING、TYPED_1）→ 说 SPOKEN 并投递之后 4 项，多出来那一项排在 SPOKEN **之前**。即多推发生在「说这句 + 投递这句」这一步之内。

**它是竞争，不是稳定状态**。在 SPOKEN 那一步前后各插 3 s 松弛（共 +6 s），**同一条用例、同一棵树上变绿**：读数为契约的 4 项，`reading.interleaveQueue` 的四向交错两个断言全过；同一棵树的分步读数是 2 → 2 → 3 → 3（一次投递只加一项）。⇒ 多推只在「模式切换 / 分句投递」的时间窗被压紧时出现，松一点就没有。

**可疑落点**（落进上述窗口的 voice-realtime 改动，非穷举；归因请用二分）：

- `60dbfcd55 fix(voice-realtime): judge the continuous empty guard over the relay's span, not its last item`（提交 10-14 01:00，落地 01:47）——把连续线路的空转写守卫从「看最后一条转写项」改成「看转发水位覆盖的区间」，直接改动「哪些 `session_send` 调用能过闸」。首要嫌疑。
- `gap-live-voice-function-call-output-rejected-after-speech-resume`（10-14 01:58 落地）——新增 transport 层回执状态机，文件头声明「不改变投递语义」。
- `c9faefddb` / `1e339d31b` / `f858571d0`（10-14 02:02–02:57）——流式上行 VAD 接进出货缝，DEFAULT OFF。
- `gap-live-voice-interrupt-missing-intent-drops-stop`（10-14 02:22 落地）。

二分要在**新 worktree** 里做，不要在共享检出里 `git checkout` 旧提交：并发还有别的 driver 在 `author` 上落地。

**为什么此前两次修复没有兜住**（`goal_ac: AC-345` 的两个 claimant 都已 `done`，所以不是 duplicate，另立）：

- `gap-live-voice-intent-control-browser-e2e` 建立了本 spec 的 7 个用例，DoD 记的是 10-12 合并后的三次 `7 passed (1.5m)`（89/90/90 s）。
- `gap-ac345-gate-deadline-below-criterion-wallclock` 把 AC-345 记录的 `timeoutMs` 定到 118000（治的是 gate 默认 60 s 杀判据）。它的残余风险一节已经写明：跑过 118000 ms 的运行仍会被 SIGKILL 记 `not-evaluated(timeout)`。
- 两者都不涉及「队列项数」这条读数；回归是它们落地之后由别的任务带上树的。

<!-- dedup-ref -->
**去重与粒度决定**：`goal_ac: AC-345` 的两个 claimant 都是 `done`，无在飞 claimant，故另立。`task-granularity-advice.js` 报一个 peer：`gap-voice-proxy-holds-one-merged-pending-message`（ready）与本任务共享 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`。决定 **separate**——那是人裁定（2026-10-14）的排队语义重设计，有自己的验收面，本任务只做「让一条已经在红的判据回绿」；调度器按 Touches 串行，二者不并行。`gap-voice-ui-strip-to-caption-and-connection-state`（ready）只共享 e2e/前端文件，机制无关。若归因需要新开同级测试文件，请经 `quay-task-operator` 把新文件补进本任务 Touches。

## AC

- [x] AC1：判据回绿。`f=e2e/voice-realtime-intent-control.spec.ts; DASHSCOPE_API_KEY= npx playwright test "$f"` 退出 0，7 用例全 pass，且用例 2 的 `reading.interleaveQueue` 是 4 项、四向交错两条断言都过。（会话内执行按 AGENTS.md 套 `bash scripts/with-memory-cap.sh`。）
- [x] AC2：把多出来的那一项归因到具体一层，并在该层落一条**修复前必红**的判据：服务端则新/改的测试文件单跑 `npx tsx --tsconfig server/tsconfig.json --test <file>` 退出 0；若归因落在验收脚本本身，则同一 `-g` 命令单跑退出 0。修复前的红读数（跑几次、读到什么）写入 `## Notes`。
- [x] AC3：稳定性。整文件连续 3 次运行都退出 0（记录每次墙钟）；用例 2 单独 `-g "typed message and a spoken sentence"` 连续 5 次都退出 0。竞争只在压紧时序下出现，一次绿不算数。
- [x] AC4：不削弱既有判据。以下单跑各自退出 0，pass 数写入 Notes（`npx tsx --tsconfig server/tsconfig.json --test <file>`，均在 `server/modules/voice-realtime/tests/`）：`voice-realtime-continuous-empty-guard-span.test.ts`、`voice-realtime-empty-transcript-guard.test.ts`、`voice-realtime-ws-proxy.protocol-simulation.test.ts`、`voice-realtime-function-call-output-receipt.test.ts`。
- [x] AC5：`npm run lint` 退出 0；`npm run typecheck` 退出 0。

## DoD

AC-345 的 criterion 在将要落地的树上真跑绿，而且这条绿不是放宽读数换来的：用例 2 仍然逐字断言「CLI 队列恰好四项、两项由投递命名、两项由各自的打字投递命名」，多出来的静默项必须以修复消失，而不是把期望值从 4 改成 5。`## Notes` 要写全：修复前的红读数（含 2026-10-14 台账两次 fail 与本地重跑）、归因落点与二分结论、「+6 s 松弛即绿」这条竞争证据在修复后不再成立（即不再需要那 6 s），以及 AC3 的 8 次读数。

## Touches

- e2e/voice-realtime-intent-control.spec.ts
- e2e/voiceRealtimeScriptedUpstream.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- tasks/gap-ac345-interleave-extra-silent-queue-push.md

## Notes

### 修复前的红读数

- 台账（AC-345 的 criterion，tree `3af89b8f`）：2026-10-13T14:09、T22:51 两次 pass；2026-10-14T07:04:47、T07:08:59 两次 **fail**。
- 本地重跑（HEAD `911105364`，本任务 worktree，驱动进程同款环境）：
  - 整文件：`1 failed` / `5 did not run` / `1 passed (57.9s)`，EXIT=1。
  - 用例 2 单跑 `-g "typed message and a spoken sentence"`：EXIT=1，`Expected: 4 / Received: 5`，墙钟 44.6 s（`/tmp/ac345-prefix-red.log`），20 s 轮询内不回落到 4。
- 读数是「静默多项」而非「重复投递」：队列读数走 `GET /api/debug-agent/queue`（只回 uuid），多出来的那一项**没有任何 `sent` 帧**（分步读数里读作 `<unobserved:…>`），而该用例全程只发 2 个 `sent` 帧（OPENING、SPOKEN）。

### 归因：多出来的一项是「老连接 A 在退出窗口内被脚本上游多广播了一次」

机制（探针读数 + 分步时间线；临时探针已 `git checkout --` 回滚，工作区干净）：

1. 浏览器发 close 帧后，代理走 `exitUplinkVad()`：置 `uplinkVadExiting = true`，发 `input_audio_buffer.commit` + `response.create`，然后**有界等待** `UPLINK_VAD_EXIT_WAIT_MS`（e2e 下 1500 ms）才 `teardown()`——见 `docs/operations/voice-realtime-uplink-vad-scheme.md` §6.3。这段时间里 A 的上行 bridge 仍然订阅着上游。
2. 脚本上游那套 rig 只有**一个** `WebSocketServer` 应答每一次 dial，而 `emit` 是 `sendAll`：`for (const client of server.clients) client.send(data)`——**广播给所有活连接**。
3. 于是「退出 Live Voice → 1.5 s 内重新进入」这一幕里 A、B 两条连接同时活着；说出那句的 `transcription.completed` 与 `session_send` 被同时送到 A 和 B。A 收进合并窗口，A 的 `teardown()` → `flushCoalesced()` 把这句投递出去，而页面上已经没有接收方 ⇒ **队列 +1 且没有 `sent` 帧**；B 约 1 s 后投递同一文本。
4. 观测顺序 `[OPENING, TYPED_1, <unobserved:DUPLICATE>, SPOKEN, TYPED_3]` 与这解释逐项吻合。run6 时间线：close-frame 49.796 → B conn-open 50.043 → 入队 A 51.052 / B 51.054 → A teardown 51.297 → busy-push A 51.304 → busy-push B 52.056。

二分 / 对照读数：

- `VOICE_REALTIME_UPLINK_VAD=off`（同树、同 `-g`）：EXIT=0，读到 4 项，9.8 s test / 20.8 s real（`/tmp/ac345-vadoff.log`）。⇒ 机制确实是**上行 VAD 退出窗口**，不是转发/合并路径本身。
- 台账红而手跑绿的原因：驱动进程导出 `VOICE_REALTIME_UPLINK_VAD=silero`（+ `VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH`、`VOICE_REALTIME_CAPTURE=on`），Playwright 合并 `process.env`，所以**台账里的 e2e 跑是带 VAD 的**；不带该环境手跑时那条退出窗口不存在。
- 「+6 s 松弛即绿」当时的解释（竞争只在压紧时序下出现）被本次探针取代：松弛之所以绿，是因为它让 A 的 1.5 s 退出窗口在重进之前**先过期**。

为什么修 rig 而不是修代理：

- §6.3 明确要求退出时的那次投递（commit → response.create → 有界等 `transcription.completed` 与转发的 `session_send`），目的正是消灭「听见了、转写了、从未转发」。在代理侧加「close 帧后拒收转发」会把这条已文档化的缺陷重新引入。
- 生产路径产生不了这个重复：每次 dial 是各自的上游会话（各连各的 DashScope；没有上游池；没有按 session 建键的注册表）。rig 自己也按 dial 建模（`armProtocol`/`armVad` 都是每次 dial 一次），只有 `emit` 一处违背了它自己的模型 ⇒ **归因落在验收脚本本身**。

修复（提交 `43e03a514`，文件 `e2e/voiceRealtimeScriptedUpstream.ts`）：`emit`/`script` 改为只对**最近一次 dial 且仍打开**的连接说话（`liveInDialOrder` + `sayToCurrentSession`），即「场景所在会话的那一端点」；未 dial 过的场景没有会话可说话，帧哪儿也不去——与「端点无人拨入」一致。分支相对 develop 只改这一个文件（42 insertions / 8 deletions）。

### AC2 的判据与「修复前必红」

归因落在验收脚本（rig）上，故 AC2 的判据即**同一条 `-g` 命令**：

- 修复前：EXIT=1，`Expected: 4 / Received: 5`（墙钟 44.6 s）。
- 修复后：EXIT=0，连续 5 次（见下）。

### 「+6 s 松弛即绿」这条证据在修复后不再成立

修复后同一条 `-g` 命令**不加任何松弛**连续 5 次全绿（下节），多出来的一项是从机制上消失的，不是被时序藏起来的——那 6 s 不再需要。

### 修复后读数

AC1 / AC3 整文件（`DASHSCOPE_API_KEY= bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-intent-control.spec.ts`），连续 3 次：

| 次 | 退出 | 结果 | 墙钟 |
| --- | --- | --- | --- |
| 1 | 0 | 7 passed (1.4m) | 1m24.584s |
| 2 | 0 | 7 passed (1.4m) | 84s |
| 3 | 0 | 7 passed (1.4m) | 82s |

用例 2 读数（第 1 次）：`reading.interleaveQueue` 恰 4 项，`openingUuid` 在 0 位、`spokenUuid` 在 2 位，四向交错两条断言都过；用例 2 用时 11.0 s。

AC3 用例 2 单跑（`-g "typed message and a spoken sentence"`），连续 5 次，各自退出 0，且每次 `interleaveQueue` 都恰 4 项：

| 次 | 退出 | 墙钟 | interleaveQueue |
| --- | --- | --- | --- |
| 1 | 0 | 23.4s | 4 项 |
| 2 | 0 | 21s | 4 项 |
| 3 | 0 | 21s | 4 项 |
| 4 | 0 | 23s | 4 项 |
| 5 | 0 | 23s | 4 项 |

AC4（`npx tsx --tsconfig server/tsconfig.json --test <file>`，各自退出 0）：

- `voice-realtime-continuous-empty-guard-span.test.ts`：tests 7 / pass 7 / fail 0
- `voice-realtime-empty-transcript-guard.test.ts`：tests 17 / pass 17 / fail 0
- `voice-realtime-ws-proxy.protocol-simulation.test.ts`：tests 19 / pass 19 / fail 0
- `voice-realtime-function-call-output-receipt.test.ts`：tests 5 / pass 5 / fail 0

AC5：`npm run typecheck` 退出 0（墙钟 20 s）；`npm run lint` 退出 0（墙钟 10 s，只有既有告警）。

### 未放宽读数

用例 2 的期望值仍是逐字 4，未改成 5。本次改动只落在脚本上游的寻址（`emit` 对谁说话），没有触碰 `e2e/voice-realtime-intent-control.spec.ts`、`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 以及 AC4 那四个受保护测试文件——分支相对 develop 的 diff 只有 `e2e/voiceRealtimeScriptedUpstream.ts` 一个文件。Touches 里其余几条是「归因过程中读过、可能相关」的声明面，实际未被写。


### 落地树上的复读（2026-10-14）

合并 develop（merge commit `81b702d96`）之后再跑一次同一条 criterion：EXIT=0，`7 passed (1.4m)`，墙钟 84 s，`reading.interleaveQueue` 仍恰 4 项（`[b362bcae…,de5728a8…,45bd5de1…,c1c6db1c…]`）⇒ 这条绿在**将要落地的树上**成立，不是合入前那棵树的读数。