---
id: gap-ac323-late-final-caption-unclaimed-by-its-delivery
title: 恢复 AC-323 判据绿：final caption 在其投递的 sent 之后才到 ⇒
  归属落空，退出把已交付的话交回草稿、live-voice-button 消失（同树 01:39/01:44 绿、01:48 红）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-323
---
## Proposal

### 现象（本轮直接重跑判据，不是台账尾巴）

- gate event：`2026-10-22T01:48:06.052Z`（本地 09:48）AC-323 `verdict: fail`，`evaluationRoot=/data/home/yale/work/claudecodeui`，`treeSha=9b141d3fb77c47a4e4705a8553d1dd849d745ffe`。
- 同一个 treeSha 在 `01:39:16.623Z` 与 `01:44:30.309Z` 两次 `verdict: pass`（exit 0）。同一棵树 8 分钟内 2 绿 1 红 ⇒ 不是确定性产品回归，是竞态。
- 红跑原文：`1 failed e2e/voice-realtime-composer-embedded.spec.ts:974:3 › … 1280px: a socket the server closed reads disconnected, offers no way back, and re-dials nothing` / `5 did not run` / `12 passed (2.0m)`。该文件 `test.describe.configure({ mode: 'serial' })`，首红即停，后续 5 例未跑。
- 本轮在当前树上单跑同一用例：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts -g "re-dials nothing"` ⇒ `1 passed (20.1s)`。单跑不复现 ⇒ 负载/时序相关。

### 根因（失败 trace 实读）

失败跑的数据目录还在：`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-52IzO3/test-results/voice-realtime-composer-em-6c818-y-back-and-re-dials-nothing/`（`error-context.md` + `trace.zip`；6h retention 可能清掉，关键读数逐字抄在这里）。

1. 失败断言原文：`Error: expect(locator).toBeVisible() failed / Locator: getByTestId('live-voice-button') / Expected: visible / Timeout: 15000ms / Error: element(s) not found` —— 落在 spec:1002（第一次 `leaveLiveVoice` 之后、断线重进之前）。
2. 失败时刻页面快照：composer textarea 的值是 `seeded user turn for the composer-embedded bar criterion`（`SEED_USER_TEXT`）；底栏只有 `Voice input` 与 `Send`，没有 `live-voice-button`。
3. trace 的 console 时序（相对 ms）：`connecting` 18635 → `frame queued` 19572 → `queue_depth` 21570 → 通知音（交付行落屏）22517 → `end(): releasing capture and closing the connection` 22578 → **`exit with 1 unshown utterance(s): leaving does not deliver them` 22578**。
4. 最后那条日志来自 `useVoiceRealtimeSession.ts:1637-1646` 的 `countUnshownUtterances`：退出那一刻有 1 条 `final` caption 不在任何「已上屏投递」的 `itemIds` 里。它随即被 `collectUndeliveredUtterances`（`placeCaptions.ts:333-353`）拼成 backlog，经 `ChatInterface.tsx:727-736` 的 `handleVoiceExit` 写进草稿；`ChatComposer.tsx:556-564` 的 `submitIsVoice` 要求草稿为空，`:1106` 只在它为真时挂 `live-voice-button` ⇒ 入口消失。
5. 归属为何落空：`sent` 处理器（`useVoiceRealtimeSession.ts:2521-2570`）当时的 `pending` 是 `captionsRef.current.filter(final && !attributed)`。若该条 caption 的 `final` 在 `sent` 之后才到（转写与模型 tool call 是两条独立的流，真实 Realtime 不保证 `conversation.item.input_audio_transcription.completed` 先于 `response.function_call_arguments.done`；CPU 负载会翻转这个顺序），`pending` 当时为空，投递的 `itemIds` 不含它，之后也没有第二条投递来认领。`priorDeliveryWindowRef`（`:2582-2584`）只记录 `sent` 那一刻已在屏上的 caption，晚到者不在其中。
6. 本 spec 的 fake upstream（`e2e/voice-realtime-composer-embedded.spec.ts:254-291`）固定按 `delta → completed → function_call` 发送，所以单跑永远走不到这个顺序；负载下代理/浏览器的处理先后才把它翻出来。

### 为什么上一次修复没兜住

`gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry`（done，`goal_ac: AC-323`）在退出前加了「等交付」；后续 `03e8f425b` 把它改成按 transcript 行数 `rowsCarrying(PROPOSED_TEXT)` 计数。两者读的都是「投递行已经落屏」，而不是「这条 caption 已被某个 delivery 的 `itemIds` 认领」。失败跑同时满足两点：行已落屏（通知音 22517），caption 仍未认领（22578 的 1 unshown）。**等待是必要的，但不充分——缺口在归属，不在时长。** 本任务不再加等待、不放大任何超时。

### 实现时对根因的修正（本轮实读 01:48 数据目录后的偏差记录）

失败跑的 proxy journal（`quay-e2e-52IzO3/voice-realtime-log/ae5a192a-…jsonl`）显示 01:48 那次的真实时序与上面第 5 点不同：`transcription.completed` 在 `01:46:22.363`（投递之前 3.4 s）就已送达浏览器，`teardown: the browser sent a close frame` 在 `25.798`，而 `to-browser sent` 在 `25.802` —— **是 `sent` 帧晚于浏览器的离开**，不是 caption 晚于 `sent`。两种顺序都会让 caption 无人认领，且根因同族（投递边界与转写/确认的时钟不同步），因此两条都修：晚到 final 的按 item 认领 + `queued` 已接受但 `sent` 未到时的在途认领。e2e 的假形态仍按 Proposal 的「call 先、转写后」固定下来（这是可确定性复现的那一支）。

### AC 文本漂移（别改错方向）

AC-323 的 `expect` 第三节仍写着 `voice-realtime-retry`，但 2026-10-14 的人裁定（`gap-voice-ui-strip-to-caption-and-connection-state`，commit `da36d28d4`）已删除重连控件、不加自动重连；spec 现在以 `a disconnected bar must offer no way back`（`e2e/voice-realtime-composer-embedded.spec.ts:1025`）断言 shipped 语义。⛔ 不恢复 retry、不改那段断言、不改 `criterion`/`expect`。本任务只让同一条命令在 shipped 语义下稳定 exit 0。

### 做法

1. **先让红确定**：给 fake upstream 一个「先发 `response.function_call_arguments.done`、后发 `conversation.item.input_audio_transcription.completed`」的选项，用在断线用例（或新增一条专用用例）上；改前必须稳定红在 spec:1002 的 `toBeVisible`，改后稳定绿。这是加强不是放水：把只有负载才能翻出来的顺序固定下来。
2. **按投递窗口归属晚到的 final caption**：`sent` 帧已带 `coveredThroughItemId`，caption 帧已带 `seq`/`itemId`（服务端 `gap-live-voice-caption-segment-attribution-by-item-id` 已落）。一条在该投递窗口内、但在 `sent` 之后才 final 的 caption 必须记到该投递的 `itemIds` 上，使 `collectUndeliveredUtterances` 不返回它、`countUnshownUtterances` 读 0。
3. ⛔ 不得退回「认领此刻所有未认领」——那会重开 `gap-live-voice-caption-attribution-swallows-undelivered` 的缺陷（投递吞掉它没携带的话）。归属仍按窗口/文本证据，只是把「晚到」纳入同一窗口。
4. ⛔ 不许用「退出前清空草稿」或「删/跳断言」让判据变绿；产品行为必须是「已交付的话不回到草稿」。

### 边界 / 不做

- 不恢复 retry、不动 AC-323 的 `criterion`/`expect`、不改 `playwright.config.ts` 的 workers/预算来「报出」绿。
- 不重启 :3001；e2e 单文件直接跑（按 AGENTS.md 的内存约束），不吃全量 suite。
- 不改 `handleVoiceExit` 的草稿交接契约本身（未交付原话仍进草稿），只改「谁来认领 caption」。

<!-- dedup-ref -->
去重与粒度：`tasks/*.md` 里声明 `goal_ac: AC-323` 的任务全部是 `done`（含 `gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry`、`gap-ac323-composer-embedded-arming-first-frame-and-criterion-deadline`、`gap-ac323-gate-deadline-below-criterion-serial-time`），todo/ready/needs-human 里没有任务认领 AC-323 ⇒ 本任务是新案。机制相邻但不同的已落地任务：`gap-live-voice-caption-attribution-swallows-undelivered`（done，管「投递多认领」）、`gap-live-voice-caption-segment-attribution-by-item-id`（done，管服务端转写→segment 的 seq 归属）、`gap-live-voice-caption-removal-on-shown`（done，管移除时机）。本任务管「客户端投递没有认领晚到的 final caption」。`task-granularity-advice.js --touches … --json` 返回 `peers: []`、`mentions: []` ⇒ 无合并候选，单独立案（separate）。

## AC

- [x] AC1 **取假形态先红**：给 fake upstream 加「call 先于 `transcription.completed`」的顺序后，修复前同用例稳定红，原文形如 `Error: expect(locator).toBeVisible() failed / Locator: getByTestId('live-voice-button') / Error: element(s) not found`，且该次运行 console 出现 `exit with 1 unshown utterance(s)`；贴命令、逐字失败行与 console 原始行。
- [x] AC2 **修后同顺序绿**：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts`（默认 continuous）exit 0、`0 failed`、`0 skipped`，贴 `N passed (time)` 摘要，且该次运行 console 不含 `unshown utterance`。
- [x] AC3 **归属单测**：`npx vitest run src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` exit 0；新增用例断言「窗口内晚到的 final caption 被投递认领 ⇒ `collectUndeliveredUtterances` 返回 `''`、`countUnshownUtterances` 为 0」，反向用例断言「窗口外未投递的 final caption 仍返回原话」；`gap-live-voice-caption-attribution-swallows-undelivered` 的 4 条形状不改一字仍绿。
- [x] AC4 **CMD1**：`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` exit 0、`0 failed`，贴摘要与墙钟。
- [x] AC5 **CMD2/CMD3**：`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime` 与 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` 均 exit 0，贴 `Test Files N passed` / `N passed` 原文。
- [x] AC6 **判据与契约未动**：`git diff --exit-code <基线>..HEAD -- goals/` 为空（`criterion`/`expect` 逐字节不变）；`grep -rn "voice-realtime-retry" src/ e2e/` 只剩反断言（`src/modules/chat/voice-realtime/tests/voiceSegmentLostState.test.tsx:352` 的 `toBeNull`），没有任何「存在」断言；不新增 `test.fail` / `test.skip`。
- [x] AC7 **闸自证**：`quay goal gate AC-323 --dry-run --root <工作树>` exit 0 且 stdout `verdict == "pass"`；贴原文与三段实测墙钟（应小于记录的 `timeoutMs: 480000`）。
- [x] AC8 **静态门**：`npm run typecheck` exit 0；`npm run lint` 无 `: error `。

## DoD

在真实浏览器里（默认 continuous）走一遍断线用例的新顺序（call 先、转写后）：退出 Live Voice 后 composer 草稿为空、`live-voice-button` 可见；随后 server 关 socket 的分支仍读 `disconnected`、无任何 retry 控件、6s 内不自动重拨。证据不是「测试绿了」，而是：

- 修复前那次运行的 console `exit with 1 unshown utterance(s)` 与 textarea = `SEED_USER_TEXT` 的原文；
- 修复后同一步的 textarea 值 `''`、`live-voice-button` visible、console 无 `unshown utterance`；
- `quay goal gate AC-323`（非 dry-run）返回 `verdict: "pass"` 的 GateEvent 原文，AC-323 台账尾随之翻 pass。

**实测记录（2026-10-22，本工作树）**

- 修复前：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts -g "re-dials nothing"` ⇒ 1 failed（23.8s）。原文 `Error: expect(locator).toBeVisible() failed / Locator: getByTestId('live-voice-button') / Expected: visible / Timeout: 15000ms / Error: element(s) not found`（spec:1078）；console 原始行 `[voice-realtime] end(): releasing capture and closing the connection` → `[voice-realtime] exit with 1 unshown utterance(s): leaving does not deliver them`；页面快照 textarea = `seeded user turn for the composer-embedded bar criterion`，底栏只有 `Voice input` 与 `Send`。
- 修复后：同命令 ⇒ `1 passed (15.1s)`；该用例新增的 console 断言（`unshown utterance` 行为空）通过；整文件 `7 passed (1.8m)`，0 failed / 0 skipped。`live-voice-button` 可见、草稿为空 ⇒ 断线分支随后仍读 `disconnected`、无 retry 控件、6s 不重拨（原断言不改）。
- `quay goal gate AC-323 --dry-run --root <worktree>` ⇒ `"verdict": "pass"`（`3m58.4s` < `timeoutMs: 480000`）。非 dry-run 的 GateEvent 由落地后的 driver 轮次写。

不放水：不删/跳过任何用例、不放大等待、不以清空草稿或换向断言代替归属修复、不改 `criterion`/`expect`、不恢复 retry。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx
- e2e/voice-realtime-composer-embedded.spec.ts
- tasks/gap-ac323-late-final-caption-unclaimed-by-its-delivery.md