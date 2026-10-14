---
id: gap-ac345-pending-card-absent-hold-not-engaged
title: AC-345 用例 1 判据红：意图控制 e2e 里 relay 的「一条合并消息」保持从未合上（host 忙读数给不出 ⇒ 不发 pending
  帧）⇒ 屏上唯一 held card 计数 0、判据退出 1
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

**判据**（AC-345 的 criterion，逐字）：`f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test "$f"`

**当前读数（立案时；本轮已回绿，见 Evidence/Notes）：判据为假。** 驱动在 2026-10-14T09:23:47Z 于 tree `05a9fde1f385cf7aef7f3d34d84ed0a238893e57`（= 当时 HEAD `f69cac02c` 的树）重跑 criterion，退出 1。该轮 e2e 工件（`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-HeQ9FL/`）逐字：

- `test-results/.last-run.json`：`"status":"failed"`，列 7 条 failed 测试 id。**但只有一个失败工件目录**（`.../test-results/voice-realtime-intent-cont-cf03e-s-ahead-of-what-followed-it/`）。spec 顶部 `test.describe.configure({ mode: 'serial', ... })`（≈:618）把一次失败级联成「其余 did not run」——**真实失败只有用例 1 一条**，别去追那 7 条。
- 该目录的 `error-context.md` 逐字：
  - Name: `voice-realtime-intent-control.spec.ts >> voice realtime intent control >> sentences spoken during a run stay visible one by one, the bar depth is read from the party that owns it, and the correction lands ahead of what followed it`
  - Location: `e2e/voice-realtime-intent-control.spec.ts:756:3`
  - Error: `expect(locator).toHaveCount(expected) failed` / Locator: `locator('[data-testid="voice-pending-message"]')` / **Expected: 1, Received: 0** / Timeout: 5000ms / `14 × locator resolved to 0 elements`。
- 失败断言是（当时）`spec.ts:833`：`await expect(page.locator(HELD_CARD)).toHaveCount(1);`（`HELD_CARD = '[data-testid="voice-pending-message"]'`，`spec.ts:78`）。

**机制：relay 的「一条合并消息」保持在本场景里从未合上。** 同轮的服务端 journal（`.../voice-realtime-log/ad100c6c-….jsonl`）逐字记下 relay 对 OPENING 那句的处置：

```
<< function_call session_send {"message":"open the held turn for the intent-control case"}
queued: opening a 1000 ms coalescing window (the frame precedes the sent)
to-browser queued depth=1
>> conversation.item.create
>> response.create
<< response.done status=completed
coalesced 1 relayed piece(s) into one message
to-browser sent
```

——走的是**裁决前的 1 s 合并窗口**路径（`queued`），**不是** 2026-10-14 裁定的「忙时保持一条合并消息」路径；全程**没有** `pending` 帧。该保持的闸门在 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 的 `if (readRunBusy() === true)`：`readRunBusy()` 读 `seams.hostRunActivity`，`server/index.ts` 把它接到 `activityStore.snapshot(sessionId)`，`busy = snapshot.turn.phase !== 'idle'`，**`snapshot === null` 时整个读数返回 `null`**，relay 读作「无声明」⇒ 保持不合上、永不发 `pending` 帧。前端只在收到 `frame.type === 'pending'` 时 `setPendingMessage(frame.text)`，`VoicePendingMessageCard.tsx` 在空文本时 `return null` ⇒ 屏上 0 张卡。

**归因窗口（台账读数）。** AC-345 上一次 pass 在 2026-10-14T09:05:39Z（tree `f1dd4df`，commit `18df6cfdb` 17:02+0800）；下一次即 09:23:47Z fail（tree `05a9fde`，HEAD）。两树之间 `0efab05a2 Merge branch 'develop' into author`（09:16Z）把 `9ccdc6eb7 feat(voice): hold ONE merged pending message in the relay (ruling 2026-10-14)` 合进 author。

**为什么此前三次修复没有兜住（认领 AC-345 的三个任务都已 done，故不是 duplicate，另立）：**

- `gap-live-voice-intent-control-browser-e2e`（done）建立了这 7 个用例，当时读的是 `voice-pending-utterance` 的**逐句行**（旧模型）。
- `gap-ac345-interleave-extra-silent-queue-push`（done）修的是用例 2 的「静默多项」（rig 的 `emit` 广播），与「屏上那张卡」无关。
- `gap-ac345-gate-deadline-below-criterion-wallclock`（done）把记录 `timeoutMs` 定到 118000（治闸预算）。三者都不涉及 2026-10-14 的「保持在忙时合上」这条新语义。
- 真正引入回归的是 `gap-voice-proxy-holds-one-merged-pending-message`（done，`9ccdc6eb7`）：它把**逐句行**换成**唯一一张只读卡**，**并在同一提交里把 AC-345 的 spec 改成读这张卡**，但**没改同一用例的投递腿**——spec 与产品各改了一半。

**待裁的边界（原样保留作历史；人已于 2026-10-14 裁定，见 Notes）：** 这张卡画不画，取决于本 e2e 场景的 host 能不能报忙。两支的实测读数见 `## Notes` 读数 1–3。

## AC

- [x] AC1（判据回绿，承重）：`f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || exit 1; DASHSCOPE_API_KEY= npx playwright test "$f"` 退出 0，7 用例全 pass（会话内按 AGENTS.md 套 `bash scripts/with-memory-cap.sh`，只跑这一个文件）。逐字读数（pass 数、墙钟）记入 `## Notes`。
- [x] AC2（非真空守卫：保持真的合上）：同一轮的 journal（`<e2e-tmp>/voice-realtime-log/*.jsonl`）里出现**裁决后**的保持证据——逐字 `holding while the session is busy (one merged message, not one per sentence)` 与 `busy hold released: delivering the ONE merged message`，以及 `to-browser pending` 帧；且屏上 `[data-testid="voice-pending-message"]` 在「忙时连说两句」那一刻计数 ≥ 1。把该轮 journal 的相关行与卡计数读数记入 `## Notes`。（防止用「等更久 / 放宽计数」过关。）
- [x] AC3（判据未被削弱）：`grep -nE "test\\.fail|test\\.skip|expect\\.soft|voiceRealtimeKnownDefect" e2e/voice-realtime-intent-control.spec.ts` 无输出（退出 1）；且 `:833` 那条断言仍逐字要求 `[data-testid="voice-pending-message"]` 计数为 1（期望值不得改成 0，也不得改成读旧 `voice-pending-utterance` 行）。
- [x] AC4（反向读数 / 假形态）：把「保持合上」的修复回退（撤掉 case 1 walk 的 busy 信号）后单跑该 spec，判据**必须红**。本树实测：判据退 1，逐字 `Error: a busy session takes no per-sentence delivery, so the CLI queue is empty` / `Expected: 0` / `Received: 2`（`at e2e/voice-realtime-intent-control.spec.ts:914:100`）。⛔ **重锚说明**：原文点名的 `:833` 卡计数腿在本树上不再单独变红——裁决后落地的「已送达排队」卡（`delivery.queuePending`）在**无保持**时也会画一张，`:833` 的 `toHaveCount(1)` 因此仍绿；红落在重锚后的「忙时零逐句投递」腿（`hostQueued === 0`）。该腿的替换理由与两组读数见 `## Notes` 读数 4。恢复后的绿读数与红读数都记入 `## Notes`。
- [x] AC5（不削弱既有判据）：`npm run typecheck` 与 `npm run lint` 各自退出 0；若改动落在 `server/`，按 AGENTS.md 加载并遵循 `$backend-module-standards`，单跑受影响的 server 测试文件退出 0（pass 数记入 `## Notes`）。
- [x] AC6（**2026-10-14 人裁定授权的重锚本身**，本轮的承重项）：`## Evidence` 给出**改前/改后逐字对照**，证明用例 1–3 的**投递**读数已按裁决后模型重锚——不再断言裁决前口径（`hostQueued === 2`、`waitForQueued` 的 `>= 1 queued deliveries settled`、`order.length === 4`），改为断言裁决后语义（**忙时零逐句投递**、屏上是**一条合并的 pending 消息**、中断把 hold + 纠正 + 说明折成**一条 enqueue-then-abort**）；并同步 `goals/AC-345` 记录自身 `expect` 文本中「用例 1 屏上逐条可见」的旧口径。⛔ 不得用读旧 `queued` 路径来凑绿（那与「屏上是唯一一张卡」的裁决相矛盾）。**范围说明**：那三条裁决前口径读数**只出现在用例 1**；用例 2（文本/语音交错顺序）与用例 3（重复中断幂等）读的是 CLI 队列，属队列模型，其 walk 不带 busy 信号、逐字未变、仍绿——把它们也改成忙模型会删掉它们要测的读数，故不做（见 Evidence）。
- [x] AC7（夹具侧让忙可读）：本场景的 host 能报出忙读数（`activityStore.snapshot` 的 `phase !== 'idle'`），使保持真的合上；给出该读数与它触发的两行 journal 证据。若最终判定夹具**不应**给忙读数，则必须写明理由并说明 AC6 的重锚如何在「不给忙」的前提下自洽（两支都要有读数，不得含糊）。

## DoD

AC-345 的 criterion 在将要落地的树上真跑绿（7 用例全 pass，退出 0），而且这条绿不是把读数放宽换来的：`:833` 仍逐字要求那张唯一的 held card 计数为 1，多出来的那条腿（`Expected 1 / Received 0`）是**从机制上消失**的——relay 真的合上了保持、真的发了 `pending` 帧、屏上真的画了那张卡。**2026-10-14 人裁定已下：批准把用例 1–3 的投递读数重锚到裁决后模型、并同步 AC-345 记录的 expect 文本**（见 Notes）——这是补齐 `9ccdc6eb7` 只改了一半的那半边，不是放宽判据；⛔ 仍不得用 test.fail / skip / 软断言 / 延长等待 / 改期望值（卡计数）来凑绿。

## Touches

- e2e/voice-realtime-intent-control.spec.ts
- e2e/voiceRealtimeScriptedUpstream.ts
- server/index.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts
- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/debug-agent/debug-agent.host-driver.ts
- goals/AC-345-live-voice-意图控制浏览器验收-scripted-fake-paced-audio-playwright-覆盖.md
- tasks/gap-ac345-pending-card-absent-hold-not-engaged.md

## Notes

### 2026-10-14 人裁定：批准重锚（本任务从 needs-human 退回的依据）

人 yale 裁定：**批准把用例 1–3 的投递读数重锚到裁决后模型**——忙时**零逐句投递**；屏上是**一次性 pending 卡**；中断把 hold + 纠正 + 说明折成**一条 enqueue-then-abort**；`order` **不再是 4 条**；并同步 `goals/AC-345` 记录自身的 `expect` 文本（去掉「用例 1 屏上逐条可见」的旧口径）。理由：`9ccdc6eb7` 把产品与 spec 的**卡腿**一起改到裁决后模型，却没动同一用例的**投递腿**——spec 与产品各改了一半；重锚是补齐另一半，**不是**放宽判据。

⛔ 边界不变：不得改成读旧 `queued` 路径凑绿（与「屏上是唯一一张卡」的裁决矛盾）；`:833` 的卡计数仍须恰为 1；不得用 test.fail / skip / 软断言 / 延长等待。

- 红读数与工件路径：见 Proposal（`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-HeQ9FL/`）。
- 台账事件（AC-345 的 criterion）：2026-10-14T09:05:39Z pass（tree `f1dd4df`）→ 09:23:47Z fail（tree `05a9fde`）。两树之间的 develop 合入带进 `9ccdc6eb7`。
- **读数 1（立案现测，落地树 `565d0eaa…` ＝ develop 同 sha；保持不合上）**：判据 **退 1**，`1 failed / 6 did not run`。逐字：`reading.barDepth=0 reading.hostQueued=2`；`Expected: 1 / Received: 0`（当时 `:833:43`）；同轮 journal **0** 条 busy/hold/pending 行、恰 **2** 行 `queued: opening a 1000 ms coalescing window`。⛔ 这条读数里投递腿是**过**的，红的只有卡腿。
- **读数 2（立案时第一支实验：把忙读数给出来；未提交、已复原）**：临时把忙读数改成恒 `true` 后单跑 → 用例 1 的红**提前**到 `fewer than 1 queued deliveries settled`（`Expected: >= 1 / Received: 0`）；该轮 journal 有 `holding while the session is busy…` ×1、`busy hold released…` ×1、`to-browser pending` ×1——保持真的合上、`pending` 帧真的发出，但会话 20s 内一条投递都拿不到。
- **读数 3（单元判据；裁决后语义的钉子）**：`voice-realtime-single-pending-message.test.ts` → **5 pass / 0 fail**；其中逐字 `assert.deepEqual(h.deliveries, [], 'a busy session must not take a per-sentence delivery');`。
- **机制（裁决前：投递腿与卡腿按定义互斥，非推断）**：一句若已在会话自己的队列里（投递腿读的 host queue），它**就已经**被 relay 投给会话了；而卡腿要的那张卡，只在 relay **没有**把这些话投出去时才存在。故两者**同一时刻不能同真**——这正是裁定要重锚投递腿的原因。

<!-- dedup-ref --> **粒度与去重决定（separate）**：`task-granularity-advice.js` 报一个 peer：`gap-continuous-experience-busy-window-swallows-forward-row`，与本任务共享 `e2e/voiceRealtimeScriptedUpstream.ts` 与 `server/modules/debug-agent/debug-agent.provider.ts`。决定 **separate**——那是**另一条判据**（AC-361 的 X-1 腿），机制不同，验收面独立；调度器按 Touches 串行。

### 本轮执行读数（2026-10-14 夜，判据已回绿）

- **读数 4（绿）**：`DASHSCOPE_API_KEY= bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-intent-control.spec.ts` → **7 passed / 0 failed，墙钟 1.3m**，退出 0。工件 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-jxBoBY/`。用例 1 逐字：`reading.barDepth=0 reading.hostQueued=0`、`reading.interruptReceipt={"aborted":true,…}`、`reading.cliOrder=["[The previous turn was interrupted before it fin"]`。
- **读数 4（红，AC4 反向）**：把用例 1 的 `openHeldRun(…, TURN_COUNT, true)` 改成 `false`（撤掉 busy 信号）后单跑同一 criterion → 判据**退 1**，逐字 `Error: a busy session takes no per-sentence delivery, so the CLI queue is empty` / `Expected: 0` / `Received: 2`（`at …:914:100`）。工件 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-zXauHl/`。⛔ 红在**重锚后的零投递腿**，不是原文点名的 `:833` 卡计数腿：裁决后 `gap-voice-relay-busy-hold-host-rounds-and-queue-visibility` 的 B 部分落地了「已送达排队」卡（delivery 的 `queuePending === true` 时渲染，与保持卡同一 testid、同一「唯一一张卡」约束），它在**无保持**时也会画一张 ⇒ `:833` 的 `toHaveCount(1)` 仍绿。该 AC4 腿的替换是为使「反向 ⇒ 红」在裁决后的树上仍可复现；若人要恢复 `:833` 腿语义，需另行裁定（本执行者不做）。
- **读数 5（AC7 夹具侧）**：本场景 host 的忙读数来自 `activityStore.snapshot(sessionId).turn.phase !== 'idle'`（`composeHostRunActivityReading` 的 `turn-phase` 分支——debug-agent 无宿主 `runInFlight`）。用例 1 的 walk 因此带一串 `thinking-tokens`（`BUSY_SIGNAL_INTERVAL_MS = 150ms`，窗口 45 s；`busySignalSteps()`），keyed 该会话 id，故只影响本 case 的会话。它触发两行 journal（读数 2/下节）。**未采用**给 debug 宿主加 `runInFlight` 的做法：那会把 `busy` 翻给全套 debug walk（多个 sibling spec 读 CLI 队列），blast radius 太大（见 spec 内注释）。
- **读数 6（AC2 journal）**：`<e2e-tmp>/voice-realtime-log/*.jsonl` 逐字含 `queued: holding while the session is busy (one merged message, not one per sentence)`、`to-browser pending`、`busy hold released: delivering the ONE merged message (1 relayed piece(s)) busy=true source=turn-phase`；同轮用例 1 的卡在 `toHaveCount(1)` 下逐字含 OPENING 与 SECOND。

## Evidence

**本轮裁定：按 2026-10-14 人裁定重锚并落地，判据回绿（7 pass / 0 fail，1.3m，退出 0）。** 承重读数见 `## Notes` 读数 4（绿/红）。

**改前/改后逐字对照（AC6，用例 1 的投递读数）**：

| 读数 | 改前（裁决前口径） | 改后（裁决后口径） |
| --- | --- | --- |
| 逐句投递 | `await waitForQueued(page, frames, 1, 20_000)` / `(…, 2, 20_000)` | 删除；改为 `waitForHeldCard(page, OPENING, 20_000)` / `(…, SECOND, 20_000)` |
| host 队列 | `expect(hostQueued, …).toBe(2)` | `expect(hostQueued, 'a busy session takes no per-sentence delivery…').toBe(0)` |
| 浏览器侧 | （无） | `expect((await deliveries(page)).length - frames.queued, …).toBe(0)` |
| bar 深度 | `expect.poll(depthShown(page)).toBeGreaterThanOrEqual(1)` | `expect.poll(depthShown(page)).toBe(0)` |
| 卡 | `toHaveCount(1)` + 含 OPENING/SECOND | 同（+ 顺序断言 `indexOf(OPENING) < indexOf(SECOND)`） |
| 中断 | 只读 `stoppedSince === 1` | 追加：中断把 hold + 纠正 + 说明折成**一条** `sent`（`folded`），逐字含 OPENING → SECOND → CORRECTION |
| CLI 顺序 | `waitForQueued(…, 4, …)` + `expect(order.length).toBe(4)` + `order[0..3]` | 删除；改为 `expect(order.length).toBe(1)`，`order[0]` 含 OPENING/CORRECTION，且**不含** AFTER（AFTER 仍被 hold） |

⛔ 未用 test.fail / skip / 软断言 / 延长等待 / 改卡计数凑绿；`await expect(page.locator(HELD_CARD)).toHaveCount(1);` 逐字未动（AC3 复测：`grep -nE "test\.fail|test\.skip|expect\.soft|voiceRealtimeKnownDefect"` 无输出、退 1）。

**用例 2–3 未动（AC6 的边界，逐字读数）**：三条裁决前口径读数**只在用例 1**。用例 2 读交错顺序（`reading.interleaveQueue` 4 条，含 opening/typedFirst/spokenUuid/typedLast）、用例 3 读重复中断幂等（`reading.coveredSecond={"stopped":false,"reason":"covered",…}`、`reading.stoppedFrames=1 of 1 expected`）——其 walk 不带 busy 信号（`heldScenario(..., busy)` 默认 `false`），逐字未变、仍绿。

**本轮产品修复（承载 AC1/AC2，`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`）**：`armCoalesce` 首行加 `if (busyBufferEngaged) return;`。诊断读数：某轮 journal 逐字 `busy hold released: delivering the ONE merged message (2 relayed piece(s)) busy=true source=turn-phase`——释放时 `busy=true`，说明**不是** `pollBusy` 放的；加临时探针后确认到 `onCaption` 末尾**无条件** `armCoalesce()`（「the person is still talking: the quiet window starts over」）在保持合上时重新武装了 1 s 窗口，~1 s 后 `flushCoalesced` 把保持冲掉。该守卫修掉它，且对无保持的连接（`busyBufferEngaged` false，含所有裁决前的判据与所有读不到忙的部署）逐字等价。`voice-realtime-single-pending-message.test.ts` 新增一例钉住（反向读数：去掉守卫即红，`actual: ['held while busy'], expected: []`）。

**逐条 AC 读数**：

- **AC1 ✓** — 7 passed / 0 failed，1.3m，退出 0（读数 4）。
- **AC2 ✓** — journal 三行齐（读数 6）；卡 `toHaveCount(1)` 且含两句。
- **AC3 ✓** — grep 无输出、退 1；`:833` 断言逐字仍在。
- **AC4 ✓（重锚后）** — 撤掉 busy 信号 → 判据退 1，`Expected: 0, Received: 2`（读数 4 红）。
- **AC5 ✓** — `npm run typecheck` 退 0（3 个 tsconfig）；`npm run lint` 退 0（仅存量 warning）；`server/modules/voice-realtime/tests/*.test.ts` 全量 **538 pass / 0 fail**（含新增一例）。已按 AGENTS.md 加载 `$backend-module-standards`。
- **AC6 ✓** — 上表 + `goals/AC-345` 的 `expect` 文本已同步（旧「屏上逐条可见 / bar 深度与 host 真实值一致」→「忙时零逐句投递、唯一一张合并 pending 卡、bar 队列深度只计已交给会话的部分、中断折成一条 enqueue-then-abort」）。
- **AC7 ✓** — 读数 5；两行 journal 见读数 6/Evidence。

**工作树状态**：`git status --porcelain` 只含已提交改动；本轮改动 4 个文件（spec、goal 记录、proxy 服务、单元测试），全在本任务 `## Touches` 内（anti-drift 已通过）。

## Blocker

**2026-10-14T10:00:07.157Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 2/5，剩余未勾 3）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：11b6a5d3-af29-4a1c-aff3-3e2956844e76

**2026-10-14 人裁定后处置**：重锚已获授权（Notes 首节），本任务不再 park，退回 todo 由常规流程续做 AC6/AC7 并复跑 AC1/AC2/AC4。