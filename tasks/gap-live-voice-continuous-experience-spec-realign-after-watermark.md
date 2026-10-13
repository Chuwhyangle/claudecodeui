---
id: gap-live-voice-continuous-experience-spec-realign-after-watermark
title: 连续体验验收 spec 随投递归属水位线（AC-375 / 31e72dfd）回归：重锚可见处置断言、翻转已落地的 RunDigest 已知缺陷腿（只改测试）
status: todo
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

- [ ] AC1：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，11 个用例全部运行（无 did not run、无 skip）。
- [ ] AC2：spec 内不再出现 `fixTask: 'gap-live-voice-run-digest-evaluation-signal'`（该任务已 done）；每处 `expectKnownDefect` 的 `fixTask` 都用 `task_get` 读出为非 done（todo / ready / needs-human）。
- [ ] AC3：「每句话语一个可见处置、无静默丢失」仍被断言：`:991` 的 `[U1,U2,U5]` carrier 断言、X-2、X-6 各自的「unforwarded 片段必须可见」断言仍在（直接断言或带实际 rows 签名的已知缺陷二者之一），并在 `## Notes` 说明选择依据。
- [ ] AC4：三次运行读数一致；零外联（AC-360 守卫读数）；`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` 退出 0。

## DoD

continuous 体验基线 spec 在当前 develop 上恢复全量运行且通过，AC-361 判据重新为真（Playwright 半边 exit 0）；不削弱「每句一个可见处置、无静默丢失」的验收；只改 spec，不改产品代码（若必须改产品才能恢复保证，停在 needs-human）。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-live-voice-continuous-experience-spec-realign-after-watermark.md

## Notes

立项：Opus 常驻会话 2026-10-13（GOAL-044 / AC-361，达成后判据再红）。证据：本地单跑输出（X-1 `:991`）与本 Proposal 中逐字的 rows；L1 半边 13/13 绿、exit 0。

<!-- dedup-ref --> 机制去重：`gap-live-voice-continuous-experience-spec-realign-after-ac355`（done，AC-361）是同一机制的前一次发生（AC-355 投影变化后的 spec 重锚）；本次是 `31e72dfd` 水位线投影变化的再次发生，按「done 的 AC 声明不是重复、而是前次修复未持久的证据」立新任务。`gap-voice-unforwarded-utterance-visible-disposition`（ready，`goal_ac` 空）是「听了、未转发必须有可见处置」的**产品侧**任务，本任务不改产品，只把它作为已知缺陷腿 `fixTask` 的引用目标。merge-candidate：`task-granularity-advice.js --touches e2e/voice-realtime-continuous-experience.spec.ts` → `peers: []`、`mentions: []`，无同文件在飞实现任务，**separate**。
