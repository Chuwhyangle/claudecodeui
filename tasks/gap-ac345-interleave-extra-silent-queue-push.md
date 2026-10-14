---
id: gap-ac345-interleave-extra-silent-queue-push
title: AC-345 用例 2 判据红：一次语音投递在 CLI 队列里留下两条项（第二条无任何投递、压紧时序才出现、+6 s 松弛即消失的竞争）——归因并修
status: ready
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

- [ ] AC1：判据回绿。`f=e2e/voice-realtime-intent-control.spec.ts; DASHSCOPE_API_KEY= npx playwright test "$f"` 退出 0，7 用例全 pass，且用例 2 的 `reading.interleaveQueue` 是 4 项、四向交错两条断言都过。（会话内执行按 AGENTS.md 套 `bash scripts/with-memory-cap.sh`。）
- [ ] AC2：把多出来的那一项归因到具体一层，并在该层落一条**修复前必红**的判据：服务端则新/改的测试文件单跑 `npx tsx --tsconfig server/tsconfig.json --test <file>` 退出 0；若归因落在验收脚本本身，则同一 `-g` 命令单跑退出 0。修复前的红读数（跑几次、读到什么）写入 `## Notes`。
- [ ] AC3：稳定性。整文件连续 3 次运行都退出 0（记录每次墙钟）；用例 2 单独 `-g "typed message and a spoken sentence"` 连续 5 次都退出 0。竞争只在压紧时序下出现，一次绿不算数。
- [ ] AC4：不削弱既有判据。以下单跑各自退出 0，pass 数写入 Notes（`npx tsx --tsconfig server/tsconfig.json --test <file>`，均在 `server/modules/voice-realtime/tests/`）：`voice-realtime-continuous-empty-guard-span.test.ts`、`voice-realtime-empty-transcript-guard.test.ts`、`voice-realtime-ws-proxy.protocol-simulation.test.ts`、`voice-realtime-function-call-output-receipt.test.ts`。
- [ ] AC5：`npm run lint` 退出 0；`npm run typecheck` 退出 0。

## DoD

AC-345 的 criterion 在将要落地的树上真跑绿，而且这条绿不是放宽读数换来的：用例 2 仍然逐字断言「CLI 队列恰好四项、两项由投递命名、两项由各自的打字投递命名」，多出来的静默项必须以修复消失，而不是把期望值从 4 改成 5。`## Notes` 要写全：修复前的红读数（含 2026-10-14 台账两次 fail 与本地重跑）、归因落点与二分结论、「+6 s 松弛即绿」这条竞争证据在修复后不再成立（即不再需要那 6 s），以及 AC3 的 8 次读数。

## Touches

- e2e/voice-realtime-intent-control.spec.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- tasks/gap-ac345-interleave-extra-silent-queue-push.md
