---
id: gap-live-voice-continuous-experience-spec-realign-after-watermark
title: 连续体验验收 spec 随投递归属水位线（AC-375 / 31e72dfd）回归：重锚可见处置断言、翻转已落地的 RunDigest 已知缺陷腿（只改测试）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-361
---
## Proposal

### 现状（2026-10-13 Opus 常驻会话复核，确定性复现一次）

`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 在当前 develop 上 **1 failed / 8 did not run / 2 passed**（AC-361 落地与 `gap-live-voice-continuous-experience-spec-realign-after-ac355` 落地时均为 11 passed）。首个失败在 `e2e/voice-realtime-continuous-experience.spec.ts:991`（`test.describe.configure({ mode: 'serial' })` 使后续 8 条不运行）：

```
Error: "嗯…那个…" must be on screen: [{"style":"user","testid":null,"text":"seeded turn for continuous experience"},{"style":"unattended","testid":null,"text":"常驻会话里正在跑的一轮（先占住执行面）"},{"style":"user","testid":null,"text":"把 server 的日志贴出来"},{"style":"unattended","testid":null,"text":"常驻会话里正在跑的一轮（先占住执行面）"},{"style":"user","testid":"voice-row-delivering","text":"然后跑一下测试"},{"style":"user","testid":"voice-row-heard","text":"不对，改成跑 lint"}]
Expected length: 1   Received length: 0   Received array: []
```

判据的 L1 半边**是绿的**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` → 13 pass / 0 fail / exit 0。失败只在 Playwright 半边。

### 成因（读代码与提交，实测 rows）

- 提交 `31e72dfd`（AC-375，「continuous default, drop transport toggle, attribute deliveries by committed-item watermark」，2026-10-13 11:41）把客户端的认领步骤改成按**上游提交水位线**归属：`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` 的 `sent` 分支新增 `readCoveredThroughItemId(frame)` + `claimThrough(pending, coveredThroughItemId)`，把「该投递答到的 `input_audio_buffer.committed` 边界之前的所有 pending caption」一次性标记为已归属。
- 后果：模型**没转发**的「嗯…那个…」（`item_vad_1`，detector disposition `unforwarded`）与合并投递的前半句「我想想」（`item_vad_2`，位于水位线边界之内）都被水位线一并吞掉，两条字幕行从界面上消失。实测 rows 里 U2 与 U3 都不再出现（见上）。
- 这与该文件**自身**的既有注释冲突：`useVoiceRealtimeSession.ts:1427-1429` 仍写着「14b8e9ed 的保证：模型识别到但从不转发的一句话不产生投递，故后续改写不得吞掉它」；AC-355 的「每段显示为已听到 / 未识别，绝不显示为投递中」也被绕过。

### 第二条 stale：已 done 的 fixTask

X-1 里那条已知缺陷腿（`e2e/voice-realtime-continuous-experience.spec.ts:1010-1024`）仍以 `expectKnownDefect(... { fixTask: 'gap-live-voice-run-digest-evaluation-signal' })` 记录「已投递的合并消息不可见 + 两半停在 delivering」。该 fix task **已经 done**（`d95dd0ac`，2026-10-13 02:52 把 RunDigest 折进状态行与 `session_status`），但它的 Touches 未含本 spec，故这条腿从未被翻转。当前它的签名（要求两行 `voice-row-delivering`，文本分别为「我想想」与「然后跑一下测试」）也不再匹配（「我想想」行已消失），因此一旦运行会以 `unexpected failure signature` 或 `defect no longer reproduces` 变红。

### 要做的事（只改测试；若判定必须改产品则停下）

AC-361 是**验证设施**类判据：它要求这份 spec 在当前代码路径上跑绿并给出诚实的 X-1..X-7 读数，不达标项以 `expectKnownDefect` 签名记录而非 `test.fail`。因此本任务把 spec 重新锚到 `31e72dfd` 之后的真实投影上：

1. 翻转那条已落地的 RunDigest 已知缺陷腿（`fixTask` 已 done）：按当前真实读数二选一 —— 若 RunDigest 落地后「已投递的消息可见」已成立，改为直接断言（去掉 `expectKnownDefect` 包裹，也不再引用已 done 的 fixTask）；若不成立，以当前实际的 rows/签名重新记录，`fixTask` 改指一个**在飞（todo/ready）**的任务。
2. X-1 的「one visible disposition per spoken run, no silent loss」三条腿（`:991` 的 `[U1,U2,U5]` 各一 carrier、`:1086` 的 X-2、`:1247` 的 X-6）重新取当前 rows 读数并二选一：
   - 若「听了、未转发」的处置在新的水位线投影下仍**可见**（例如以别的行承载）⇒ 断言改为读那一行并写明 `testid` / 状态；
   - 若该处置已被水位线静默吞掉（回归）⇒ 以 `expectKnownDefect` 记录，签名包含**当前实际的 rows**（变体部分用 `.*`），`fixTask: 'gap-voice-unforwarded-utterance-visible-disposition'`（在飞、ready，正是「听了、未转发必须有可见处置」那条），**保留断言、不得删弱**。
3. 其余因投影改变的腿（X-3 投递链、X-4 合并单条、X-5 打断）按当前真实读数同样处理：成立就直接断言，不成立就带实际签名记录。
4. 判断依据（读代码 + 实测 rows）写进 `## Notes`，逐条给出「直接断言 / 已知缺陷记录」的选择与理由。
5. 若判定必须改产品代码才能恢复某条 AC-361 保证，**停在 needs-human** 并写明理由，不得顺手改产品。

## Plan

1. 本地复现失败并取全部 rows 读数（`QUAY_CONTINUOUS_EXPERIENCE_DUMP`）；2. 逐条重锚 / 翻转；3. 三次运行读数一致；4. 零外联读数；5. `npx oxlint e2e/voice-realtime-continuous-experience.spec.ts`（`npm run lint` 的 glob 不含 `e2e/`）。

## AC

- [x] AC1：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，11 个用例全部运行（无 did not run、无 skip）。
- [x] AC2：spec 内不再出现 `fixTask: 'gap-live-voice-run-digest-evaluation-signal'`（该任务已 done）；每处 `expectKnownDefect` 的 `fixTask` 都用 `task_get` 读出为非 done（todo / ready / needs-human）。
- [x] AC3：「每句话语一个可见处置、无静默丢失」仍被断言：`:991` 的 `[U1,U2,U5]` carrier 断言、X-2、X-6 各自的「unforwarded 片段必须可见」断言仍在（直接断言或带实际 rows 签名的已知缺陷二者之一），并在 `## Notes` 说明选择依据。
- [x] AC4：三次运行读数一致；零外联（AC-360 守卫读数）；`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` 退出 0。

## DoD

continuous 体验基线 spec 在当前 develop 上恢复全量运行且通过，AC-361 判据重新为真（Playwright 半边 exit 0）；不削弱「每句一个可见处置、无静默丢失」的验收；只改 spec，不改产品代码（若必须改产品才能恢复保证，停在 needs-human）。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-live-voice-continuous-experience-spec-realign-after-watermark.md

## Notes

立项：Opus 常驻会话 2026-10-13（GOAL-044 / AC-361，达成后判据再红）。证据：本地单跑输出（X-1 `:991`）与本 Proposal 中逐字的 rows；L1 半边 13/13 绿、exit 0。

<!-- dedup-ref --> 机制去重：`gap-live-voice-continuous-experience-spec-realign-after-ac355`（done，AC-361）是同一机制的前一次发生（AC-355 投影变化后的 spec 重锚）；本次是 `31e72dfd` 水位线投影变化的再次发生，按「done 的 AC 声明不是重复、而是前次修复未持久的证据」立新任务。`gap-voice-unforwarded-utterance-visible-disposition`（ready，`goal_ac` 空）是「听了、未转发必须有可见处置」的**产品侧**任务，本任务不改产品，只把它作为已知缺陷腿 `fixTask` 的引用目标。merge-candidate：`task-granularity-advice.js --touches e2e/voice-realtime-continuous-experience.spec.ts` → `peers: []`、`mentions: []`，无同文件在飞实现任务，**separate**。

### 完成记录：重锚读数与逐条选择（2026-10-13，实现 worktree 实测）

**复现（改动前）**：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` = 1 failed / 8 did not run / 2 passed，首红 `:991` 的 U2，错误逐字同上面 Proposal（`serial` 模式使后 8 条不运行）。

**根因（读代码 + 逐帧 dump 实测，`QUAY_CONTINUOUS_EXPERIENCE_DUMP`）**：帧流显示浏览器按序收到 `caption item_vad_0 / item_vad_1 / item_vad_2`（三句皆 final），随后**第一条** `sent` 帧携带 `message:"把 server 的日志贴出来"` 与 `coveredThroughItemId:"item_vad_2"`。`claimThrough(pending, "item_vad_2")` 因此在 pending 上切到 `item_vad_0..item_vad_2`，把**模型没转发的** `item_vad_1`（`嗯…那个…`，disposition `unforwarded`）与**合并投递的前半句** `item_vad_2`（`我想想`）一并归属给这条投递；该投递是「已显示」的（U1 的真实行在），于是这两条字幕行被 `markDeliveredVoiceMessages` 吸收、离开界面。**第二条** `sent` 的水位线是 `item_vad_3`，只认领 `item_vad_3`，于是「然后跑一下测试」单独停在一行 `voice-row-delivering`，而合并消息 `我想想然后跑一下测试` 在任何行上都不出现（该会话的 `transcript.jsonl` 也没有对应行）。即：**水位线不是「按投递实际答到的句子」归属，而是「按转发那一刻已提交的全部句子」归属**，转发时刻晚于模型决策时刻，这条超集就吞掉了决策之外的话语。

**逐条选择与依据（AC3 要求的依据）**：

1. `:991` 的 `[U1,U2,U5]` carrier 断言：U1、U5 仍是**直接断言**（实测各恰好 1 行承载，分别是真实 user 行与 `voice-row-heard` 行）。U2 的「恰好 1 行承载」**原样保留、不删弱**，改为带**当前实际 rows** 的签名（锚 `"testid":"voice-row-delivering","text":"然后跑一下测试"` 与 `"testid":"voice-row-heard","text":"不对，改成跑 lint"`，变体部分 `.*`）的 `expectKnownDefect`，`fixTask: 'gap-voice-unforwarded-utterance-visible-disposition'`——该任务用 `task_get` 读出 **status=ready（非 done）**，其 Touches 含 `useVoiceRealtimeSession.ts`，即 `claimThrough` 所在文件；它当天有一次 exited-not-landed 记录（与 spec pin 无关的 suite 红），但仍是「听了、未转发必须有可见处置」的在飞产品侧所有者。
2. 合并投递腿（原 `fixTask` 指向**已 done** 的 RunDigest 任务）：**未成立**（实测合并消息仍在 0 行上），故不翻转成直接断言，而是按当前投影**重新记录**：签名由「两行 `voice-row-delivering`（我想想 + 然后跑一下测试）」改为「一行 `voice-row-delivering`（然后跑一下测试）+ 一行 `voice-row-heard`（不对，改成跑 lint）」，`fixTask` 改指同一个 ready 任务（同一根因、同一产品面）；该腿的注释写明「原 fixTask 已落地但未使合并消息可见，故按当前投影重记而非翻转」。已 done 任务的 id 在本 spec 中**一处不剩**，连同下一条绿色腿（`X-1: a message the journal recorded as delivered is not still shown as delivering`）里对它的交叉引用一并改指新 `fixTask`。
3. X-2（`the fragment must still be visible as a voice row`）与 X-6（`the unforwarded fragment must be marked, not silently dropped`）：断言**原文不动**，各自包进同签名 `expectKnownDefect`，同一 `fixTask`。X-2 里「任何已投递消息不得承载该片段」的负半边仍是直接断言（成立：`routing.sends` 两条消息都不含该片段）。
4. X-3（投递链）、X-4（合并单条）、X-5（打断 + 纠正）、X-7（延迟表）及其余各腿：投影改变后**仍成立**，未改断言内容、未加包装、未降级为已知缺陷（实测三次运行全绿）。

**AC 读数**：

- AC1：三次正式运行均 **11 passed / 11 run / exit 0**（另有改动过程中的一次探针运行同为 11 passed / exit 0）；四份日志里都没有 `did not run`、`skipped`、`✘`、`test.skip/fixme/fail` 字样，每份都有 11 个 `✓`。
- AC4（三次读数一致）：三次正式运行的 dump 归一化读数 sha256 **逐字相同**（`dc49dea2da96124f`）。归一集＝detector 处置表 / items / forwarded / 三次计数、`transcript.rows`、routing（`sends` 消息、`transcripts` / `captions` 文本、speechStops / toolCalls / queued / statusInjections 计数）、`commits`、`declaredSegmented`、`phase`、journal `mode`、status 行、fold、`pageErrors`、egress、dock 状态集。逐次不同的只有 run-scoped 字段（`sessionId`、`activityFrames` 7/8、`warnings` 14/15、`probes` 80/83），均不是断言对象。
- AC4（零外联，AC-360 守卫读数）：`{logExists:true, blocked:false, dials:1, authorizationSeen:false}`；被拒列表全是非 loopback（`fonts.googleapis.com`、`api.github.com` ×2），**loopback 拒绝数 0**。
- AC4（lint）：`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` → exit **0**（`npm run lint` 的 glob 不含 `e2e/`，故按 AC 逐字用文件路径）。
- AC2：`fixTask:` 共 4 处，全部是 `gap-voice-unforwarded-utterance-visible-disposition`，`task_get` 读出 status=ready（非 done）；`grep -c "gap-live-voice-run-digest-evaluation-signal" <spec>` = **0**。
- 未改产品代码（水位线本身的产品侧修复属上面那个 ready 任务，本任务只把它记为 fixTask）；未动 develop；未跑 fan-in（按 worker 约定交给 driver）。
