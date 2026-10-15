---
id: gap-live-voice-interrupt-aftermath-note-rides-the-correction
title: Live Voice 打断说明（aftermath note）要骑在触发中断的更正消息上，而不是之后无关的下一条：现状 note 在 abort
  之后才 arm，落点处「上一轮被打断」不实，且「以下为当前指令」的优先级语句把更正排到了下面
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现象（2026-10-16 01:04–01:07 live 实测，journal `cae49fed-56a7-4877-9265-d4e7f3de0db6.jsonl`，本会话亲历三次）

带 `message` 的 `session_interrupt`（G1：更正先入 CLI 队列、再 abort）发生后：

- 更正本身（「前面这句不用再跑了」「停掉前面那个慢的 bash 命令，直接列出当前目录文件」）进入 CLI 时**没有** note。
- note（`[The previous turn was interrupted … Any partial changes … may still be present. Everything after this note is your current instruction and takes precedence over any conflicting thing said earlier.]`）落在**之后无关的下一条**消息上。该落点处的「上一轮」是 CLI 已经正常答完更正的那一轮，句子不实；而「Everything after this note … takes precedence over any conflicting thing said earlier」字面上把更正（在它之前）排在了下面。

### 机制（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`，逐行核对）

- `sessionInterrupt`（约 `:3979`）：更正经 `deliverSessionSend` 入队时 `aftermathNote === null`；note 只在 abort 与 backlog 释放之后才 arm（`:4168-4170`，`if (aborted && !mergesHold)`），随后被下一条 `deliverSessionSend` 前置并花掉（`:2903-2909`）。
- `aftermathNote` 的注释（`:2567-2571`）为「放在 backlog 释放之后」给出的理由是「否则会把打断告诉被它打断的那一轮」。但按 G1/SPEC §18.4，更正在 abort 时被 CLI 投进「中断收尾的那一轮」（E10/U1/U2），CLI 自己的标记 `[Request interrupted by user for tool use]` 就紧贴在更正文本前面——**更正就是中断后进入 CLI 的第一条消息**，该理由对更正不成立。
- 2026-10-14 的裁定（提交 `9ccdc6eb7`，`mergesHold`）已经把「note 骑在本条更正上」做成了 hold 折进打断这一种情形（`:4054-4056`、`:4168` 的 `!mergesHold`）。本缺陷是把它推广到**所有**带更正的 stop。

### 方案 A（人 yale 2026-10-16 裁定立案）

1. 带更正（`correctionText !== ''`）的 stop：在更正入队**之前** arm note（与 `mergesHold` 同路径，位置在 fence 的 `covered` 判定之后），使 note 随这一条更正同一个 message 前置送入。
2. 入队未被确认 ⇒ 撤销 note（`mergesHold` 分支已有 `:4083-4088`，推广到全部带更正的 stop）。
3. note 已随更正发出 ⇒ abort 之后不再给下一条 arm（把 `!mergesHold` 换成「note 是否已随更正发出」）。
4. 不带更正的 stop 保持原样：note 在 abort 之后 arm、落在下一条（AC3/AC4/DoD 原用例不变）。
5. 审计行（`session_interrupt audit {json}`）增 `noteCarried: boolean`，使「note 已随更正发出、但 abort 结果为 `no-run`」可度量。
6. 措辞保留「may still be present」的对冲（SPEC §11.4：不得暗示撤销）。是否把「was interrupted」软化为「a stop was issued while …」留给执行者按测试钉子（`voice-realtime-interrupt-aftermath.test.ts:725` 的 `startsWith('[The previous turn was interrupted')`、`:811` 的正则）一并裁量；不改措辞则不需动这两处。

### 执行者必须先读的开放问题

`base.session_interrupt` 的拒绝（外来会话、D-2 禁用动词）发生在更正入队**之前**还是**之后**？若在之后，note 已随更正发出而 stop 被拒，句子落空：要么把该校验挪到入队之前，要么在 Notes 里如实记下并让 `noteCarried` 与 `refused` 并存。读完后以 Notes 一行写明结论。

<!-- dedup-ref -->相关但不同机制：`gap-live-voice-interrupt-honest-aftermath`（已 done，AC3 只覆盖不带 message 的 stop，note 在「下一条」）、`gap-voice-proxy-holds-one-merged-pending-message`（`mergesHold` 裁定）。本任务不改 note 的措辞契约，只改**它骑在哪一条消息上**。与 `gap-live-voice-phantom-resend-exit-pair-and-no-new-heard-guard` 同改 `voice-realtime-ws-proxy.service.ts` 但机制与验收独立，分开立案（调度器按 Touches 串行，不损并行度）。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-log.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-audit.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-missing-intent.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-revision-order.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
- tasks/gap-live-voice-interrupt-aftermath-note-rides-the-correction.md

## AC

- [x] 新增用例（同文件 `voice-realtime-interrupt-aftermath.test.ts`）：带 `message` 的 `session_interrupt`，进入 CLI 的更正文本以 `[The previous turn was interrupted` 开头、以更正原文结尾，且其后第一条普通 `session_send` 的文本不含 `previous turn was interrupted`。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts` exit 0。
- [x] 新增用例：更正入队未被确认（`revision-not-enqueued`）时，该更正与其后的下一条消息都不含 note（note 不遗留）。同一命令 exit 0。
- [x] 新增用例：fence 判 `covered`（同一 triggerSeq 重复）时不 arm、不发 note。同一命令 exit 0。
- [x] 不带 `message` 的 stop 行为不变：原 AC3 / AC4 / DoD 三个用例在不改断言的情况下全绿（同一命令 exit 0）。
- [x] 审计行带 `noteCarried`：`grep -n "noteCarried" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 命中写入处，且新增用例断言带更正的 stop 为 `true`、不带更正的为 `false`。
- [x] `npm run typecheck` 与 `npm run lint` 均 exit 0。

## DoD

真 proxy + 假 resident host（沿用 `voice-realtime-interrupt-aftermath.test.ts` 的 DoD 夹具，零云调用）：第 1 轮停在长 `Bash`，对其发带更正的 stop；把「进入 CLI 的更正全文」「紧随其后下一条的全文」「磁盘 journal 的 `interrupt` 行原文（含 `noteCarried`）」三段逐字贴入 Notes。仅有测试断言、没有这三段实录不算落地。开放问题（`session_interrupt` 拒绝发生在入队前还是后）的结论写入 Notes 一行。

## Notes

### 开放问题的结论（读码，不是猜）

**拒绝发生在更正入队之后。** 白名单是执行器自己的（`voice-realtime-live-executor.ts` 的 `assertBoundSession`，在其 `sessionInterrupt` 的第一句），而 proxy 的 `sessionInterrupt` 是在更正已经 `deliverSessionSend` 出去之后才 `await base.session_interrupt(args)`。所以「外来会话」的 stop 已经把更正——连同骑在它上面的 note——送进了 CLI，note 撤不回来。取「如实记下、让 `noteCarried` 与 `refused` 并存」这一臂，不把校验挪到入队之前：那要在 proxy 里复制一份白名单，两份注定漂移。（同一条读法已在 `voice-realtime-interrupt-missing-intent.test.ts` 的 AC3 用例里钉住，那里的假执行器就是按这个次序拒绝的。）

### DoD 三段实录

来源：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts` 的 `DoD(correction)` 用例（真 DashScope transport + 脚本化 stand-in 端点 + 假 resident host，零云调用，唯一拨号地址 `ws://scripted.invalid`）。

**1. 进入 CLI 的更正全文**（`harness.sends` 里这一次投递的 `message`，逐字）：

```
[The previous turn was interrupted while it was running the `Bash` tool. Any partial changes that tool had already made may still be present. Everything after this note is your current instruction and takes precedence over any conflicting thing said earlier.]

stop the bash run and list the current directory instead
```

**2. 紧随其后下一条的全文**（同一次运行里再发的一条普通 `session_send`）：

```
now do the small thing instead
```

**3. 磁盘 journal 的 `interrupt` 行原文**（`<tmp>/conn-aftermath.jsonl` 里的 `"kind":"interrupt"` 行，逐字，含 `noteCarried`）：

```json
{"at":"2026-10-15T18:16:24.356Z","kind":"interrupt","connectionId":"conn-aftermath","runId":"run-1","triggerSeq":1,"intent":"the user changed direction","intentMissing":false,"heard":"run the long bash thing","queuedStillPending":0,"inFlightTool":"Bash","noteCarried":true,"by":"model","outcome":"aborted"}
```

同一支夹具里不带更正的对照跑出 `"noteCarried":false`（原 `DoD` 用例的那一行），所以这两个读数是同一支夹具上的两个取值，不是两次不同的搭台。

### 落地的读法（供复核者对齐）

- **`noteCarried` 读的是投递本身**（`lastDeliveryCarriedNote`，在 `deliverSessionSend` 里唯一花掉 note 的那一处写），不是「这条 stop 带不带更正」。因此 `no-run` / `refused` 而 note 已随更正发出时它是 `true`——这正是 plan 第 5 条要的可度量读数：note 出去了、abort 没成，这件事不再隐形。
- **入队未被确认有两条路径**，用例各覆盖一条，且它们对 note 的答案不同，所以分开断言：(a) `sending` 在飞 ⇒ 更正根本没交出去 ⇒ note 撤销，更正与其后消息都不含 note（`an enqueue that never happened revokes the note…`）；(b) 交出去了但没被确认 ⇒ note 已出、撤不回 ⇒ `noteCarried: true` 与 `outcome: 'refused'` 并存（用例名以 `LIMIT:` 开头）。第二条是「note 不可能撤回」这一事实的如实记录，不是遗漏；AC 第一条的「该更正不含 note」在第 (a) 条路径上成立（更正压根没进 CLI）。
- **措辞一字未改**（plan 第 6 条留的裁量取「不改」）：`[The previous turn was interrupted` 前缀与「may still be present」的对冲原样保留，所以原 AC3 / AC4 / DoD 三处断言一字未动，AC 第 4 条是这么绿的。§11.4 的禁词（`revert`/`rollback`/`undo`/「撤销」/「回滚」）在带更正的投递文本上同样被断言。
- **Touches 扩了 5 个文件**，都是这次改动直接推到的，不是顺手：`voice-realtime-log.ts`（`noteCarried` 要落进 journal 记录，DoD 第 3 段要的就是磁盘上那一行；`InterruptAuditFields` 与逐字段校验随之加一项）、以及 4 个把「CLI 收到的更正文本」逐字比对的兄弟用例文件（`voice-realtime-interrupt.test.ts`、`-revision-order`、`-missing-intent`、`voice-realtime-scripted-scenarios`）。它们的更正投递现在带 note 前缀，比较改为「前缀 + 更正原文」或包含式匹配——改的是夹具读的那段文本，判据本身（enqueue-before-abort、次序、只送一次、stale-first=0）一字未改。
- 全套 voice-realtime 用例（`server/modules/voice-realtime/tests/*.test.ts`，619 个）在 `with-memory-cap.sh … --test-concurrency=8` 下全绿；`npm run typecheck`、`npm run lint` 均 exit 0。