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

——走的是**裁决前的 1 s 合并窗口**路径（`queued`），**不是** 2026-10-14 裁定的「忙时保持一条合并消息」路径；全程**没有** `pending` 帧。该保持的闸门在 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:2932`（`if (readRunBusy() === true)`）：`readRunBusy()`（`:2324`）读 `seams.hostRunActivity`，`server/index.ts:830` 把它接到 `activityStore.snapshot(sessionId)`，`busy = snapshot.turn.phase !== 'idle'`，**`snapshot === null` 时整个读数返回 `null`**，relay 读作「无声明」⇒ 保持不合上、永不发 `pending` 帧（该文件 `:2851` 的注释逐字说明：`every criterion written before this ruling` 会保持旧行为）。前端 `useVoiceRealtimeSession.ts:1494` 只在收到 `frame.type === 'pending'` 时 `setPendingMessage(frame.text)`，`VoicePendingMessageCard.tsx:27` 在空文本时 `return null` ⇒ 屏上 0 张卡。

**归因窗口（台账读数）。** AC-345 上一次 pass 在 2026-10-14T09:05:39Z（tree `f1dd4df`，commit `18df6cfdb` 17:02+0800）；下一次即 09:23:47Z fail（tree `05a9fde`，HEAD）。两树之间 `0efab05a2 Merge branch 'develop' into author`（09:16Z）把 `9ccdc6eb7 feat(voice): hold ONE merged pending message in the relay (ruling 2026-10-14)` 合进 author。

**为什么此前三次修复没有兜住（认领 AC-345 的三个任务都已 done，故不是 duplicate，另立）：**

- `gap-live-voice-intent-control-browser-e2e`（done）建立了这 7 个用例，当时读的是 `voice-pending-utterance` 的**逐句行**（旧模型）。
- `gap-ac345-interleave-extra-silent-queue-push`（done）修的是用例 2 的「静默多项」（rig 的 `emit` 广播），与「屏上那张卡」无关。
- `gap-ac345-gate-deadline-below-criterion-wallclock`（done）把记录 `timeoutMs` 定到 118000（治闸预算）。三者都不涉及 2026-10-14 的「保持在忙时合上」这条新语义。
- 真正引入回归的是 `gap-voice-proxy-holds-one-merged-pending-message`（done，`9ccdc6eb7`）：它把**逐句行**（`VoicePendingUtterance.tsx` / `[data-testid="voice-pending-utterance"]`）换成**唯一一张只读卡**（`VoicePendingMessageCard.tsx` / `[data-testid="voice-pending-message"]`），**并在同一提交里把 AC-345 的 spec 改成读这张卡**（`f1dd4df→05a9fde` 的 spec diff：`:78` 的 `QUEUED_ROW→HELD_CARD`、`:830-835` 的 `toHaveCount(2)→toHaveCount(1)` 等）。即 spec 与产品被同一次落地一起改到「有一张卡」，但**那张卡在本 e2e 场景里画不出来**——保持的闸门要 host 的 `busy` 读数，而本场景的 host 给不出。

**待裁的边界（执行者须先判、不得静默削弱判据）：** 这张卡画不画，取决于**本 e2e 场景的 host 能不能报忙**：

- 若本场景本应复现「host 忙」（spec 自己断言 `running-turn-stop` 可见、`hostQueued === 2`，即确有一轮在飞）——那缺口在**夹具/接线**：让 debug-agent 侧的会话在 `activityStore` 里有 `phase !== 'idle'` 的快照（或让保持的闸门拿到等价的忙读数），使保持合上、`pending` 帧发出、卡画出。**优先这一支。**
- 若裁定认为本场景的 host 结构上给不出忙读数、而卡只该在真实 Claude provider 下画——**则不得把判据改成读旧路径的 `queued` 帧来凑绿**（那与 2026-10-14 裁定「屏上是唯一一张卡」相矛盾），应停手 **needs-human**，把两组读数与工件路径交接。

⚠️ 注意 AC-345 记录自身的 `expect` 文本仍写着用例 1「屏上逐条可见」（旧逐句行口径），与 2026-10-14 裁决的「唯一一张卡」已经不一致；`expect` 文本的改锚只能由人裁定，**不是**本任务执行者可自行做的事（若确需改锚则走 needs-human，不要在本任务里改 AC 记录的 expect）。

## AC

- [ ] AC1（判据回绿，承重）：`f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || exit 1; DASHSCOPE_API_KEY= npx playwright test "$f"` 退出 0，7 用例全 pass（会话内按 AGENTS.md 套 `bash scripts/with-memory-cap.sh`，只跑这一个文件）。逐字读数（pass 数、墙钟）记入 `## Notes`。
- [ ] AC2（非真空守卫：保持真的合上）：同一轮的 journal（`<e2e-tmp>/voice-realtime-log/*.jsonl`）里出现 `pending` 帧 / 保持合上的日志证据，且屏上读数与之一致——`[data-testid="voice-pending-message"]` 在「忙时连说两句」那一刻计数 ≥ 1。把该轮 journal 的相关行与卡计数读数记入 `## Notes`。（防止用「等更久 / 放宽计数」过关。）
- [ ] AC3（判据未被削弱）：`grep -nE "test\\.fail|test\\.skip|expect\\.soft|voiceRealtimeKnownDefect" e2e/voice-realtime-intent-control.spec.ts` 无输出（退出 1）；且 `:833` 那条断言仍逐字要求 `[data-testid="voice-pending-message"]` 计数为 1（期望值不得改成 0，也不得改成读旧 `voice-pending-utterance` 行）。
- [ ] AC4（反向读数 / 假形态）：把「保持合上」的修复回退（或把 host 的 busy 读数复原为不给）后单跑该 spec，`spec.ts:833` 那条腿**必须红**，报错逐字为 `Expected: 1, Received: 0`；恢复后的绿读数与红读数都记入 `## Notes`。
- [ ] AC5（不削弱既有判据）：`npm run typecheck` 与 `npm run lint` 各自退出 0；若改动落在 `server/`，按 AGENTS.md 加载并遵循 `$backend-module-standards`，单跑受影响的 server 测试文件退出 0（pass 数记入 `## Notes`）。

## DoD

AC-345 的 criterion 在将要落地的树上真跑绿（7 用例全 pass，退出 0），而且这条绿不是把读数放宽换来的：`:833` 仍逐字要求那张唯一的 held card 计数为 1，多出来的那条腿（`Expected 1 / Received 0`）是**从机制上消失**的——relay 真的合上了保持、真的发了 `pending` 帧、屏上真的画了那张卡——而不是靠跳过、软断言、延长等待或改期望值。若执行者判定本场景的 host 结构上给不出忙读数（上面的待裁边界第二支），**不得凑绿**：停手 needs-human，附 journal 与工件路径、两组读数，把「是否把 AC-345 的 spec / expect 重锚到裁决后的唯一卡模型」交人裁定。

## Touches

- e2e/voice-realtime-intent-control.spec.ts
- e2e/voiceRealtimeScriptedUpstream.ts
- server/index.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/debug-agent/debug-agent.host-driver.ts
- tasks/gap-ac345-pending-card-absent-hold-not-engaged.md

## Notes

- 红读数与工件路径：见 Proposal（`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-HeQ9FL/`，含 `test-results/.last-run.json`、`test-results/voice-realtime-intent-cont-cf03e-.../error-context.md`、`voice-realtime-log/ad100c6c-….jsonl`）。
- 台账事件（AC-345 的 criterion）：2026-10-14T09:05:39Z pass（tree `f1dd4df`）→ 09:23:47Z fail（tree `05a9fde`）。两树之间的 develop 合入带进 `9ccdc6eb7`。

<!-- dedup-ref --> **粒度与去重决定（separate）**：`task-granularity-advice.js` 报一个 peer：`gap-continuous-experience-busy-window-swallows-forward-row`（ready，`goal_ac: AC-361`），与本任务共享 `e2e/voiceRealtimeScriptedUpstream.ts` 与 `server/modules/debug-agent/debug-agent.provider.ts`。决定 **separate**——那是**另一条判据**（AC-361 连续体验 e2e 的 X-1 腿「忙窗口吞掉转发行」），机制不同（忙窗口吞可见行 vs 保持未合上 ⇒ 卡不画），验收面独立；调度器按 Touches 串行，二者不并行。`mentions` 里 `gap-ac364-supersede-after-sts-production-retirement` 只在散文中提到 `server/index.ts`，非 peer。
