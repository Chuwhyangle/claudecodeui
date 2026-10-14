---
id: gap-ac345-pending-card-absent-hold-not-engaged
title: AC-345 用例 1 判据红：意图控制 e2e 里 relay 的「一条合并消息」保持从未合上（host 忙读数给不出 ⇒ 不发 pending
  帧）⇒ 屏上唯一 held card 计数 0、判据退出 1
status: todo
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

**当前读数（本轮直接现测，非台账尾巴）：判据为假。** 驱动在 2026-10-14T09:23:47Z 于 tree `05a9fde1f385cf7aef7f3d34d84ed0a238893e57`（= 当前 HEAD `f69cac02c` 的树）重跑 criterion，退出 1。该轮 e2e 工件（`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-HeQ9FL/`）逐字：

- `test-results/.last-run.json`：`"status":"failed"`，列 7 条 failed 测试 id。**但只有一个失败工件目录**（`.../test-results/voice-realtime-intent-cont-cf03e-s-ahead-of-what-followed-it/`）。spec 顶部 `test.describe.configure({ mode: 'serial', ... })`（≈:618）把一次失败级联成「其余 did not run」——**真实失败只有用例 1 一条**，别去追那 7 条。
- 该目录的 `error-context.md` 逐字：
  - Name: `voice-realtime-intent-control.spec.ts >> voice realtime intent control >> sentences spoken during a run stay visible one by one, the bar depth is read from the party that owns it, and the correction lands ahead of what followed it`
  - Location: `e2e/voice-realtime-intent-control.spec.ts:756:3`
  - Error: `expect(locator).toHaveCount(expected) failed` / Locator: `locator('[data-testid="voice-pending-message"]')` / **Expected: 1, Received: 0** / Timeout: 5000ms / `14 × locator resolved to 0 elements`。
- 失败断言是 `spec.ts:833`：`await expect(page.locator(HELD_CARD)).toHaveCount(1);`（`HELD_CARD = '[data-testid="voice-pending-message"]'`，`spec.ts:78`）。

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

——走的是**裁决前的 1 s 合并窗口**路径（`queued`），**不是** 2026-10-14 裁定的「忙时保持一条合并消息」路径；全程**没有** `pending` 帧。该保持的闸门在 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:2932`（`if (readRunBusy() === true)`）：`readRunBusy()`（`:2324`）读 `seams.hostRunActivity`，`server/index.ts:830` 把它接到 `activityStore.snapshot(sessionId)`，`busy = snapshot.turn.phase !== 'idle'`，**`snapshot === null` 时整个读数返回 `null`**，relay 读作「无声明」⇒ 保持不合上、永不发 `pending` 帧。前端 `useVoiceRealtimeSession.ts:1494` 只在收到 `frame.type === 'pending'` 时 `setPendingMessage(frame.text)`，`VoicePendingMessageCard.tsx:27` 在空文本时 `return null` ⇒ 屏上 0 张卡。

**归因窗口（台账读数）。** AC-345 上一次 pass 在 2026-10-14T09:05:39Z（tree `f1dd4df`，commit `18df6cfdb` 17:02+0800）；下一次即 09:23:47Z fail（tree `05a9fde`，HEAD）。两树之间 `0efab05a2 Merge branch 'develop' into author`（09:16Z）把 `9ccdc6eb7 feat(voice): hold ONE merged pending message in the relay (ruling 2026-10-14)` 合进 author。

**为什么此前三次修复没有兜住（认领 AC-345 的三个任务都已 done，故不是 duplicate，另立）：**

- `gap-live-voice-intent-control-browser-e2e`（done）建立了这 7 个用例，当时读的是 `voice-pending-utterance` 的**逐句行**（旧模型）。
- `gap-ac345-interleave-extra-silent-queue-push`（done）修的是用例 2 的「静默多项」（rig 的 `emit` 广播），与「屏上那张卡」无关。
- `gap-ac345-gate-deadline-below-criterion-wallclock`（done）把记录 `timeoutMs` 定到 118000（治闸预算）。三者都不涉及 2026-10-14 的「保持在忙时合上」这条新语义。
- 真正引入回归的是 `gap-voice-proxy-holds-one-merged-pending-message`（done，`9ccdc6eb7`）：它把**逐句行**换成**唯一一张只读卡**，**并在同一提交里把 AC-345 的 spec 改成读这张卡**，但**没改同一用例的投递腿**——spec 与产品各改了一半。

**待裁的边界（原样保留作历史；人已于 2026-10-14 裁定，见 Notes）：** 这张卡画不画，取决于本 e2e 场景的 host 能不能报忙。两支的实测读数见 `## Notes` 读数 1–3。

## AC

- [ ] AC1（判据回绿，承重）：`f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || exit 1; DASHSCOPE_API_KEY= npx playwright test "$f"` 退出 0，7 用例全 pass（会话内按 AGENTS.md 套 `bash scripts/with-memory-cap.sh`，只跑这一个文件）。逐字读数（pass 数、墙钟）记入 `## Notes`。
- [ ] AC2（非真空守卫：保持真的合上）：同一轮的 journal（`<e2e-tmp>/voice-realtime-log/*.jsonl`）里出现**裁决后**的保持证据——逐字 `holding while the session is busy (one merged message, not one per sentence)` 与 `busy hold released: delivering the ONE merged message`，以及 `to-browser pending` 帧；且屏上 `[data-testid="voice-pending-message"]` 在「忙时连说两句」那一刻计数 ≥ 1。把该轮 journal 的相关行与卡计数读数记入 `## Notes`。（防止用「等更久 / 放宽计数」过关。）
- [x] AC3（判据未被削弱）：`grep -nE "test\\.fail|test\\.skip|expect\\.soft|voiceRealtimeKnownDefect" e2e/voice-realtime-intent-control.spec.ts` 无输出（退出 1）；且 `:833` 那条断言仍逐字要求 `[data-testid="voice-pending-message"]` 计数为 1（期望值不得改成 0，也不得改成读旧 `voice-pending-utterance` 行）。
- [ ] AC4（反向读数 / 假形态）：把「保持合上」的修复回退（或把 host 的 busy 读数复原为不给）后单跑该 spec，`spec.ts:833` 那条腿**必须红**，报错逐字为 `Expected: 1, Received: 0`（读数 1 即该形态）；恢复后的绿读数与红读数都记入 `## Notes`。
- [x] AC5（不削弱既有判据）：`npm run typecheck` 与 `npm run lint` 各自退出 0；若改动落在 `server/`，按 AGENTS.md 加载并遵循 `$backend-module-standards`，单跑受影响的 server 测试文件退出 0（pass 数记入 `## Notes`）。
- [ ] AC6（**2026-10-14 人裁定授权的重锚本身**，本轮的承重项）：`## Evidence` 给出**改前/改后逐字对照**，证明用例 1–3 的**投递**读数已按裁决后模型重锚——不再断言裁决前口径（`hostQueued === 2`、`waitForQueued` 的 `>= 1 queued deliveries settled`、`order.length === 4`），改为断言裁决后语义（**忙时零逐句投递**、屏上是**一条合并的 pending 消息**、中断把 hold + 纠正 + 说明折成**一条 enqueue-then-abort**）；并同步 `goals/AC-345` 记录自身 `expect` 文本中「用例 1 屏上逐条可见」的旧口径。⛔ 不得用读旧 `queued` 路径来凑绿（那与「屏上是唯一一张卡」的裁决相矛盾）。
- [ ] AC7（夹具侧让忙可读）：本场景的 host 能报出忙读数（`activityStore.snapshot` 的 `phase !== 'idle'`），使保持真的合上；给出该读数与它触发的两行 journal 证据。若最终判定夹具**不应**给忙读数，则必须写明理由并说明 AC6 的重锚如何在「不给忙」的前提下自洽（两支都要有读数，不得含糊）。

## DoD

AC-345 的 criterion 在将要落地的树上真跑绿（7 用例全 pass，退出 0），而且这条绿不是把读数放宽换来的：`:833` 仍逐字要求那张唯一的 held card 计数为 1，多出来的那条腿（`Expected 1 / Received 0`）是**从机制上消失**的——relay 真的合上了保持、真的发了 `pending` 帧、屏上真的画了那张卡。**2026-10-14 人裁定已下：批准把用例 1–3 的投递读数重锚到裁决后模型、并同步 AC-345 记录的 expect 文本**（见 Notes）——这是补齐 `9ccdc6eb7` 只改了一半的那半边，不是放宽判据；⛔ 仍不得用 test.fail / skip / 软断言 / 延长等待 / 改期望值（卡计数）来凑绿。

## Touches

- e2e/voice-realtime-intent-control.spec.ts
- e2e/voiceRealtimeScriptedUpstream.ts
- server/index.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
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
- **读数 1（本轮现测，落地树 `565d0eaa…` ＝ develop 同 sha；保持不合上）**：判据 **退 1**，`1 failed / 6 did not run`。逐字：`reading.barDepth=0 reading.hostQueued=2`；`Expected: 1 / Received: 0`（`:833:43`）；同轮 journal **0** 条 busy/hold/pending 行、恰 **2** 行 `queued: opening a 1000 ms coalescing window`。⛔ 这条读数里 `:828` 的投递腿是**过**的，红的只有 `:833` 的卡腿。
- **读数 2（待裁边界第一支的实验读数：把忙读数给出来；一次性、未提交、已复原）**：临时把 `server/index.ts` 的 `hostRunActivity` 改成 `busy: true` 后单跑 → 用例 1 的红**提前到 `:788` 且方向相反**：`fewer than 1 queued deliveries settled`（`Expected: >= 1 / Received: 0`）。该轮 journal 逐字有 `holding while the session is busy (one merged message, not one per sentence)` ×1、`busy hold released: delivering the ONE merged message (1 relayed piece(s))` ×1、`to-browser pending` ×1 —— **保持真的合上、`pending` 帧真的发出**（卡会画），但会话在这 20s 内**一条投递都拿不到**。
- **读数 3（单元判据；裁决后语义的钉子，同一棵树，退 0）**：`voice-realtime-single-pending-message.test.ts` → **5 pass / 0 fail**；其中 `:180` 逐字 `assert.deepEqual(h.deliveries, [], 'a busy session must not take a per-sentence delivery');`。
- **机制（`:828` 与 `:833` 按定义互斥，非推断）**：一句若已在会话自己的队列里（`:828` 读的 host queue），它**就已经**被 relay 投给会话了；而 `:833` 要的那张卡，只在 relay **没有**把这些话投出去时才存在（读数 3 逐字钉住）。故两者**同一时刻不能同真**——这正是裁定要重锚投递腿的原因。

<!-- dedup-ref --> **粒度与去重决定（separate）**：`task-granularity-advice.js` 报一个 peer：`gap-continuous-experience-busy-window-swallows-forward-row`，与本任务共享 `e2e/voiceRealtimeScriptedUpstream.ts` 与 `server/modules/debug-agent/debug-agent.provider.ts`。决定 **separate**——那是**另一条判据**（AC-361 的 X-1 腿），机制不同，验收面独立；调度器按 Touches 串行。

## Evidence

**2026-10-14 上一轮裁定：停手 needs-human，不凑绿**（两支都不成立，读数见 `## Notes` 读数 1–3）。**同日人裁定后，本任务改为按裁决后模型重锚投递读数**（见 Notes 首节），故本轮续做 = AC6 + AC7 + 复跑 AC1/AC2/AC4。

逐条 AC 读数（上一轮）：

- **AC1 ✗** — 判据退 1（读数 1）；给出忙读数后仍退 1（读数 2）。无可落地的修复能让用例 1 的 `:788` 与 `:833` 同时为真 —— **重锚前**如此。
- **AC2 ✗** — 现状 journal 无 `pending`/hold 行、卡计数 0（读数 1）；给出忙读数后 journal 有 `pending`（读数 2），但判据在别处红。
- **AC3 ✓** — `grep -nE "test\.fail|test\.skip|expect\.soft|voiceRealtimeKnownDefect"` 无输出、退 1；`:833` 逐字仍为 `await expect(page.locator(HELD_CARD)).toHaveCount(1);`。
- **AC4 ✗** — 反向红半边**已取得**（读数 1：`:833` 红、逐字 `Expected: 1, Received: 0`）；另一半「恢复后的绿读数」在重锚前不存在。
- **AC5 ✓** — `npm run typecheck` 退 0；`npm run lint` 退 0（仅既有 warning）；改动未落在 `server/`，后半条不触发。

**上一轮工作树状态**：`git status --porcelain` 为空，`HEAD = 565d0eaa…`（与 develop 同 sha）——零代码改动。交接工件：驱动红 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-HeQ9FL/`、现测红 `…/quay-e2e-Te5S1U/`、实验红 `…/quay-e2e-iI9r8z/`。

## Blocker

**2026-10-14T10:00:07.157Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 2/5，剩余未勾 3）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：11b6a5d3-af29-4a1c-aff3-3e2956844e76

**2026-10-14 人裁定后处置**：重锚已获授权（Notes 首节），本任务不再 park，退回 todo 由常规流程续做 AC6/AC7 并复跑 AC1/AC2/AC4。
