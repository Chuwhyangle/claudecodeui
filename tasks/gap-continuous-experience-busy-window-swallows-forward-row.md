---
id: gap-continuous-experience-busy-window-swallows-forward-row
title: 连续体验 e2e 的 X-1 腿红：第一句转发落在忙窗口内（walk+2817ms vs turn-end 3000ms）被当作 busy
  push、永不成行，判据不再确定性绿（只改测试/夹具，保持 X-1 直接断言）
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

**判据现状（本轮直接复量，2026-10-14，仓库当前 HEAD）**：AC-361 的判据命令
`for f in server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts e2e/voice-realtime-continuous-experience.spec.ts; do [ -f "$f" ] || exit 1; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts && npx playwright test e2e/voice-realtime-continuous-experience.spec.ts`
**退 1**。红腿**不在** server 侧文件——`voice-realtime-fake-vad-upstream.test.ts` 单跑 13 pass / 0 fail、退 0；红在 e2e spec 的 X-1 用例（`e2e/voice-realtime-continuous-experience.spec.ts:1013` 起，断言在 1038-1039）：

```
Error: "把 server 的日志贴出来" must be on screen once:
[{"style":"user","text":"seeded turn for continuous experience"},
 {"style":"unattended","text":"常驻会话里正在跑的一轮（先占住执行面）"},
 {"style":"user","text":"我想想然后跑一下测试"},
 {"style":"unattended","text":"常驻会话里正在跑的一轮（先占住执行面）"}]
```

U1（第一句被转发的 utterance，`把 server 的日志贴出来`）**根本没有成行**；合并消息 `我想想然后跑一下测试`（U3+U4）成了行。同一 spec 的其余 10 个用例在 `mode: 'serial'` 下因为这条失败而「did not run」。

**根因（实测读数，非推断）**：
- 同一轮 run artifact 的 `routing.sends` 记：U1 于 walk+**2817 ms** `outcome:"delivered"`；合并消息于 walk+**9380 ms** `outcome:"delivered"`。deck 的 `turn-end` 落在 `TURN_END_AT_MS = 3_000` ms（spec:116）。
- 2817 < 3000 ⇒ **U1 落在忙窗口内**。debug-agent 的 host driver 在忙时把这次 dispatch 判为 busy push（`DEBUG_AGENT_BUSY_INPUT_OPTION`，`server/modules/debug-agent/debug-agent.host-driver.ts:492-509` → `registerPushedCommand`）；provider 的 `acceptPushedCommand` 对这次 push **只写一条 `queued` 的 command-lifecycle frame**（`server/modules/debug-agent/debug-agent.provider.ts:576-582`），**不写 transcript 的用户行**。队列里的命令要变成一行，只能靠 deck 的 `dequeue` 步（`server/modules/debug-agent/debug-agent.engine.ts:610-625`）再加 `openQueuedCommandRound`（`debug-agent.provider.ts:696-698`）——而连续体验的 deck（spec:176-180）**没有 `dequeue` 步**。
- 对照：U3+U4 于 walk+9380 ms 送达（**空闲**）⇒ 走 `CHAT_TURN_OPTION` 的 `appendTypedTurnRow`（`debug-agent.provider.ts:610-616`），成行。
- 直接读夹具自己的 transcript jsonl（`<e2e-tmp>/debug-agent-home/.claude/projects/.../<session>.jsonl`）实测恰是 `[seed, busy, 合并的 U3+U4, busy]`——**U1 不在里面**（journal 说 delivered，transcript 里没有，正是「投递了但看不见」）。

**为什么这条腿时绿时红**：U1 的送达时刻与首个 `turn-end` 只差约 **183 ms**，是与调度器/机器负载赛跑。本轮同一代码同一机器：早先单跑 2 次 11/11 绿，随后一次 verbatim 链 + 连续 5 次单跑**全红**，且每次都是同一条 X-1 报错。spec 自己的文件头（第 25-29 行）已声明「X-1 的『执行面忙闲交替』是 READING 的性质、而不是调度器运气」——现状正好违背该声明，判据因此不可能满足 AC-361(e) 的「同一种子连续 3 次读数一致」。

**修法方向**：
- **首选（测试侧）**：让每一句转发的**可见性不再取决于它与忙窗口的 183 ms 赛跑**——对齐 spec 文件头声明的语义：一次转发的送达应落在**它自己随后会占用**的空闲平面上（这次送达再开一个忙回合，供 dock 读 `busy→idle` 交替），而不是落进一个**已经由别的东西占着**的忙窗口。首选做法是在 spec / e2e harness 侧重排 walk 与时间线的相对时刻（例如让首个 `turn-end` 早于 U1 的送达，或让 `playFakeMic` 晚于首个忙窗口开始），使每个 forwarded 送达都在空闲平面上完成成行；读数里 `busy→idle` 交替仍须可读（X-1 的「执行面忙闲交替」条件不得被抹掉）。
- **备选（仅当重排被证明行不通）**：若设计上确实要求「转发落在别的忙窗口内」，则必须在假体里**建模真实 CLI 在回合边界把排队命令变成一个 user 回合**的行为，使被 push 的命令在 drain 之后落一行——这可能改到 `server/modules/debug-agent/`（属 `server/` 代码，须按 `AGENTS.md` 加载并遵循 `$backend-module-standards`）。
- **不得**：放松 X-1 的可见处置断言、引入 `voiceRealtimeKnownDefect` / `test.fail` / `test.skip` / `expect.soft`、用 deck 的 `row` 步直接写死 U1 文本（那是夹具自造行，属实空绿）、或加一个「等超时再看一眼」的轮询把丢句掩盖成真空绿。X-1 的可见处置腿在 2026-10-13 裁定后已是直接断言（spec 文件头第 50-55 行），本任务不得把它退回 known-defect。

<!-- dedup-ref -->
**与在飞任务的关系（separate）**：`gap-voice-proxy-holds-one-merged-pending-message`（当前 `ready`，`goal_ac: null`）会改「忙时排队 / 空闲时一次投递」的**代理侧**语义，与本任务同一片区域但机制不同（代理持有一条合并消息 vs 连续体验 e2e 夹具的忙窗口吞掉转发行）。本任务只要求在**当前**代码上让 AC-361 判据确定性绿，不依赖也不阻塞该任务。若该任务先落地、忙时投递语义随之改变，本 spec 的可见处置期望需按新投影重新核对（同类重锚已有先例：`gap-live-voice-continuous-experience-spec-realign-*`）。

## AC

- [x] AC1 AC-361 的判据命令**连续 3 次各自退出 0**，逐次读数（每次的 pass/fail 计数）写入 `## 验证读数`。命令逐字同上（`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 单跑；server 侧文件应保持 13 pass / 0 fail）。
- [x] AC2 **非真空守卫**：以 `QUAY_CONTINUOUS_EXPERIENCE_DUMP=<file>` 跑一次后，`jq -r '.transcript.rows[] | select(.style=="user" and .testid==null) | .text' <file>` 的输出里 `把 server 的日志贴出来` 与 `我想想然后跑一下测试` **各恰一次**；且该次 `jq -c '.fold' <file>` 显示读取时待落地的话已在屏（腿不是读到一个还没到位的快照而恰好通过）。读数记入 `## 验证读数`。
- [x] AC3 **直接断言未被削弱**：`grep -nE "voiceRealtimeKnownDefect|test\.fail|test\.skip|expect\.soft" e2e/voice-realtime-continuous-experience.spec.ts` 无输出（退出 1）；且 1038-1039 那条断言仍要求 U1 行恰一次、`style === 'user'`、`testid === null`。
- [x] AC4 **反向读数（假形态）**：把「让首个转发落进忙窗口」的形态复原（例如回退时序/重排改动，或临时把 U1 的送达推回 `turn-end` 之前且不建模 drain）后单跑该 spec，X-1 那条腿**必须红**；复现的报错原文与恢复后的绿读数都记入 `## 验证读数`（防止用恒真方式过关）。

## 验证读数

冻结修订 sha256 `82277aaee0443973eff14c05e6fc65d8cef2b8fc8cb5af4e70d099f8637cb2fe`（`git diff --stat` = 仅 `e2e/voice-realtime-continuous-experience.spec.ts` 一处，`+203 / -22`，`server/` 零改动）。

**读数所在的树**：AC1 / AC2 / AC4(a) 三组读数都在 `git merge develop` **之后**的工作树上取得。这次合入把 sibling `gap-voice-proxy-holds-one-merged-pending-message` 带进了同一棵树（`VoicePendingMessageCard` 取代 `VoicePendingUtterance`、新增 `voice-realtime-single-pending-message.test.ts`），正好命中本任务 `<!-- dedup-ref -->` 的告警条件，因此**按新投影重核了一遍**：重跑三次仍全绿、行投影与 fold 逐项同形，**无需重锚**。AC4(b) 的读数取自合入之前的同一份冻结修订（该假形态只动 spec 自身的常量与门控，与 develop 侧改动正交）。

**落地的是「修法方向」的首选（测试侧）**，两处改动：①时间线在**首个 busy→idle 交替已闭合**之后才开始（不再与 `turn-end` 赛跑）；②把原来只能读 dock 的「平面已释放」门改成读**产品自己的 turn 租约**（`GET /api/session-hosts/:sessionId` 的 `bindings[].leases` 里 `kind === 'turn'`，即 dispatcher 自己求值的 `turnByAppSession`），未在 `TURN_RELEASE_TIMEOUT_MS` 内读到 held→released 就**指名失败**，而不是默默让下面的行腿变红。

- **AC1（合入 develop 后，判据命令逐字连跑 3 次，三次各自 `exit=0`）**：
  - run1：server `ℹ tests 13 / ℹ pass 13 / ℹ fail 0 / ℹ skipped 0`；e2e `11 passed (38.7s)`
  - run2：server `ℹ pass 13 / ℹ fail 0 / ℹ skipped 0`；e2e `11 passed (39.2s)`
  - run3：server `ℹ pass 13 / ℹ fail 0 / ℹ skipped 0`；e2e `11 passed (34.5s)`
  （日志 `/tmp/cebwsf/merged-run{1,2,3}.log`。合入前同一份修订也连跑过 3 次、同样全绿：`11 passed (35.1s / 36.0s / 35.0s)`，server 同为 13 pass / 0 fail，日志 `/tmp/cebwsf/ac1b-run{1,2,3}.log`。改前的同一命令在本机可复现地退 1，见 Proposal。）
- **AC2（合入 develop 后，`QUAY_CONTINUOUS_EXPERIENCE_DUMP=/tmp/cebwsf/merged-run1.json` 那一次）**：
  - `jq -r '.transcript.rows[] | select(.style=="user" and .testid==null) | .text'` →
    `seeded turn for continuous experience` / `把 server 的日志贴出来` / `我想想然后跑一下测试`；`group_by(.) | map({text, n})` 三条各 `n: 1` —— 两句话**各恰一次**（run2 / run3 的 dump 逐字相同）。
  - `jq -c '.fold'` → `{"resolved":false,"waitedMs":8098,"lastInFlight":["不对，改成跑 lint"]}`（run2 `8097` / run3 `8107`，同形）。`lastInFlight` 非空即「读取时待落地的话已在屏」（那是 U5 的打断更正文本，按设计搭 stop 的 `intent` 走、不成行）；`resolved:false` **不是本任务引入的形态**：夹具契约本身把「fold 8.4 s 内未解除」钉为结构性读数（`tasks/gap-live-voice-continuous-experience-e2e-harness.md:118`），develop 基线同形 —— `/tmp/cebwsf/baseline.json` → `{"resolved":false,"waitedMs":8321,"lastInFlight":["不对，改成跑 lint"]}` —— 故腿读到的不是「还没到位的快照」。
  - 同一次 dump 的时序/投影读数（相对 walk 起点）：turn 租约 walk+592 读 `held`、walk+3534 读 `released`（`TURN_END_AT_MS = 3_000`）；时间线 walk+5764 起，`heldAtPlayStart: false`；U1 送达 walk+8422（= 时间线开始后 2.66 s，即租约释放后 ≈4.9 s，对照改前的 −183 ms）；合并送达 walk+14950。行序列 `seed(user) / busy / U1(user, testid null) / busy / 合并(user, testid null) / busy` —— 与合入前同形。
- **AC3**：`grep -nE "voiceRealtimeKnownDefect|test\.fail|test\.skip|expect\.soft" e2e/voice-realtime-continuous-experience.spec.ts` → **无输出、退出 1**。
  （改前文件头第 64 行曾在散文里点出那个 helper 字面量——正是 `absence-ac-grep-counts-the-prose-that-explains-the-absence` 记下的形态；本次改写为不点名地说明它已不在，改后 grep 干净。）
  U1 那条断言逐字仍是三句 —— `toHaveLength(1)` / `style === 'user'` / `testid === null`；因为本任务在文件头与门控处净增行，现位于 spec 第 **1200-1203** 行（改动前的 1038-1039 行，即本 AC 里写的那个行号）。
- **AC4 假形态（两种都复原过，X-1 都红）**：
  - **(a) 回退重排**（把 spec 整份还原成改动前 develop 那一份后单跑；在**合入 develop 后**的树上复取一次）：`exit=1`，`✘ X-1: the endpoint's disposition table…`，
    `Error: "把 server 的日志贴出来" must be on screen once: [{"style":"user",…"seeded turn…"},{"style":"unattended",…"常驻会话里正在跑的一轮（先占住执行面）"},{"style":"user",…"我想想然后跑一下测试"},{"style":"unattended",…}]`，指针 `> 1039`；`1 failed / 2 passed (31.6s)`。
    该次 dump（`/tmp/cebwsf/merged-false-a.json`）里 U1 送达 walk+**2770**，**早于** `turn-end`(3000) ⇒ 落进忙窗口被吞（合并送达在 walk+9362、自由面上，成行）——正是本任务要修掉的形态，且证明绿读数不是恒真。
  - **(b) 只回推时序**（同一份冻结修订上临时三改：`TURN_END_AT_MS = 10_000`、释放等待 `+ 0`、不抛未释放的错）：`exit=1`，X-1 红在 `> 1201`（同一句 `must be on screen once`；行集只剩 seed + busy 两行，两次投递都被吞）；`1 failed / 2 passed (1.0m)`。
    该次 dump（`/tmp/cebwsf/ac4-pushback-final.json`）里 `heldAtPlayStart: true`、租约序列只有 1 个采样点且 `heldAtMs` / `releasedAtMs` 均为 `null` —— 本次新增的租约断言自身也会独立抓到这一形态。
- **恢复后的绿读数**：两处假形态都改回、并核对回上面的 sha256（`sha256sum` 逐字相同）之后，AC1 的三次连跑与 AC2 的 dump 取得于恢复之后，X-1 复原为直接断言绿。

## DoD

在仓库当前代码上，AC-361 的判据命令可重复地（连续 3 次）全绿：fake mic 固定时间线走当前 continuous 代码路径跑完，X-1 的可见处置表里每个 **forwarded** 的 utterance 都在对话区有一行真实 user 行（U1 与合并的 U3+U4 各恰一次、无「语音专用」标记），沉默 / 打断的处置仍按既有裁定直接断言，执行面 `busy→idle` 交替仍从 dock 读数可读；且没有任何 known-defect / skip / soft 或夹具自造行把这条腿变成真空绿。若最终采用的是假体侧的 drain 建模（改 `server/modules/debug-agent/`），该改动同样满足上述读数。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- e2e/voiceRealtimeFakeMic.ts
- e2e/voiceRealtimeScriptedUpstream.ts
- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/debug-agent/debug-agent.host-driver.ts
- tasks/gap-continuous-experience-busy-window-swallows-forward-row.md