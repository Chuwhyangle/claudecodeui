---
id: gap-resident-merged-queued-turn-leaves-stale-run-running
title: 常驻 Claude 会话「Working…」永不消失 — CLI 把多条忙时 send 合并成一个 turn 只发一个 result，而
  resident driver 每个 result 只 rounds.shift() 一个 ⇒ round FIFO 永久错一位、陈旧 run 一直
  running；让一个 result 结算它所合并的全部排队 round，且不得过度结算未被合并的下一轮
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

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-13）：`task_list search=rounds.shift` → 0 条，`search=一个 result` → 0 条；`grep -lE "claude-host-driver.provider.ts" tasks/*.md` 里 status 为 todo/ready 的 → 0 条；`task-granularity-advice` 对本任务 Touches 返回 `peers=[]`、`mentions=[]`。相关但机制不同的已落地任务：`gap-claude-resident-unattended-turn`（无人轮的识别与开 run，走 `state.unattended` 分支，不涉及合并的排队 round）、`gap-chat-lifecycle-started-must-not-blank-message`（前端把 `started` 当成清空气泡，与服务端 round 结算无关）。本条是第三种：宿主侧 round 与 CLI turn 的对应关系错位。决定：separate（独立验收、独立机制）。

**现象（人 yale 在第四次 live voice 测试中报告）**：底部「Working… 3m 0s」在轮次早已结束后一直不消失，刷新页面也不消失。没有任何后台任务。服务端 `GET /api/providers/sessions/running` 在我方明显空闲的时刻仍返回该会话，且 `startedAt` 是某条**忙时 send** 的时刻，不是真实轮次的开始。

**实测证据（2026-10-13，会话 74ba573d，UTC）**：
- 转录 `queue-operation`：05:04:44.879 `enqueue`（语音 send B）、05:05:34.808 `enqueue`（语音 send C）、05:05:36.982 **两条 `dequeue` 同一毫秒**、05:05:36.998 **一条** user 消息，内容是 B、C 两段文字拼在一起。CLI 把两条排队消息合成了**一个** turn。
- 注册表采样：05:08:25 那一轮的 `result` 之后，`/sessions/running` 在 05:08:35…05:09:15 每次仍返回 `startedAt=05:07:55`；`lastSeq` 在自己那一轮期间一直为 0（帧被写进了别的 round 的 writer）。之后新的忙时 send 又开出 `startedAt=05:09:44` 的新 run，同样不会结束。
- 线上 `dist-server/build-info.json` gitSha `0541d1b`，构建 04:55:58；驱动文件最后一次提交早于该构建，线上跑的就是这份源码。

**机制（`server/modules/providers/list/claude/claude-host-driver.provider.ts`）**：
1. 忙时 send 走 `chat-websocket.service.ts:817` 的 `supersedeRunning` 另开一个 run，并抢走该会话的槽位；随后 driver 在 `:3372` `state.rounds.push(round)`，并在 `:3373` 为它 `leaseAdded`。每条忙时 send 一个 round、一个 run。
2. 一轮的所有帧发给 `state.rounds[0].writer`（`:4268`、`:4325`）。
3. 结束的唯一途径：CLI 每发一个 `result`，`observe()` 在 `:4417` 做 `state.rounds.shift()` **一个** round，往它的 writer 写 `complete`（`:4444`）并 `settle()`。注册表看到 `complete` 才把 run 翻成 completed。
4. 同文件 `:2614-2619` 的注释已经写明实测：「seven entries dequeued in one millisecond into a single turn」。CLI 会把多条排队输入合进同一个 turn，只发一个 `result`；`:4417` 仍然是一个 `result` 对一个 round。
5. 结果：合并后的 turn 的 `result` 只结算队首的 B，C 留在队首之后；之后每个 `result` 结算的都是「前一个」round，最新一轮的 run 永远留在注册表里。错位不会自愈：只要还有新的忙时 send，就总有一个 round 在等下一个 `result`。
6. 兜底也救不了：`completeRunIfCurrent`（`chat-websocket.service.ts:924`）只在 `runtime.run` 返回之后执行，而卡住的 round 从没被 shift、从没 `settle()`。

**要做的事（最小充分集）**：
1. 在 `observe()` 处理 `result` 时，结算队首 round 之后，再把「被同一个 turn 合并的」后续 round 一并结算：同样写 `complete`、`reportRoundEnd`、`settle()`，并按 lease 的实际记账方式同步移除对应的 `turn` lease（每个 round push 时 `leaseAdded` 一次，结算时必须 `leaseRemoved` 一次，不得泄漏也不得多减）。
2. **判定「被合并」的依据必须来自 CLI 自己的生命周期读数，不得靠位置猜**：driver 已经在 `:4146-4150` 读 `command_lifecycle state=started` 并写 `queuedInputs[].startedAt`，`ResidentRound.queuedUuids`（`:1656`）能把 uuid 对回 round。合并组＝在**同一次 dequeue** 里 `started` 的那些 uuid 所属的 round（同一个 turn 只会有一个 `result`）。实现可以在 `started` 时记「此刻已读到的 `result` 个数」（沿用 `resultsSeenAtPush`/`resultTimes` 的口径）或按 turn 边界分组，二选一，但必须在完成记录里写明依据。
3. **不得过度结算**：CLI 在上一轮 `result` 之后才 dequeue 下一轮，所以排在后面、尚未 `started` 的 round（`startedAt === null`）不属于当前 turn，必须保持 running，等它自己的 `result`。判定里要显式排除它，并有反例判据钉住。
4. 回归判据 `server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts`：沿用 `claude-resident-process.test.ts` 的 fake 进程做法喂 CLI 形态的帧序列（A 的 `result`、B 与 C 的 `command_lifecycle started`、一个 `result`）；另有一个真实 `claude` 二进制的臂（真二进制 + mock Anthropic 兼容端点 + 临时 `DATABASE_PATH`/`CLAUDE_CONFIG_DIR`，做法照 `claude-resident-unattended-turn.test.ts`）：让一条长 Bash 轮在飞，期间连推两条命令，读到 CLI 确实把它们合成一个 turn 且结束后 `listRunningRuns()` 为空。

**非目标**：不改语音转发、VAD、静音上传、空回复；不改前端「Working…」的计算（前端如实反映服务端状态）；合并 turn 的**帧**仍只写进队首 round 的 writer，本条只修「终态结算」，帧的逐 run 归属是另一个问题，不在本条范围。实现须遵守 `AGENTS.md` 中 `$backend-module-standards` 对 `server/` 后端代码的约束。

## AC

- [x] 回归判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 在修复完成的树上退出 **0** 且输出 `fail 0`，并打印整体墙钟 `elapsed=<n>ms` 且 `< 60_000`。命令逐字含文件路径，不用 glob。红态基线：修复前同命令退出 **1**（文件不存在，文案含 `Could not find`）。
- [x] 合并正例：判据先让 driver 在忙时压入 B、C 两个 round（前面有在飞的 A），再喂 `A.result`、B 与 C 的 `command_lifecycle started`（同一次 dequeue）、一个 `result`。打印 `roundsPushed=3 resultsObserved=2 completeFrames=3 roundsOpen=0 turnLeasesOpen=0`，且 B、C 各自的 run 各收到恰好 1 条 `complete`（打印每个 run 的 `completeCount`，不得为 0 或 2）。
- [x] 不过度结算（反例）：C **没有**与 B 同批 `started`（CLI 分成两轮）时，B 的 `result` 只结算 B：打印 `settledAfterFirstResult=1 roundsOpenAfterFirstResult=1`；C 自己的 `result` 到达后才结算：打印 `roundsOpenAfterSecondResult=0`。保证该修复不是「一个 result 清空全部」。
- [x] 假形态承重：把修复处临时改回单次 `rounds.shift()`（判据文件一字不动）⇒ 合并正例命令退出 **1**，且红落在 `completeFrames`/`roundsOpen`/`turnLeasesOpen` 这条读数上（不是别的腿先红）；实测退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原。
- [x] 真实二进制臂：同一判据文件里的真实 `claude` 臂打印 `claudeBinary=<path>`（不得 skip、不得空）、`cliMergedIntoOneTurn=true resultsObserved=1`、`runsOpenAtRest=0`；真实臂在合并发生时之后 `listRunningRuns()` 读数为空数组。若真实二进制读到 CLI **没有**合并（两条各成一轮），判据必须如实打印 `cliMergedIntoOneTurn=false` 并红，不得把它当绿。
- [x] 不使既有判据变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-process.test.ts` 与 `…/claude-resident-idle.test.ts` 各自单文件运行退出 **0**（逐条打印命令与退出码），这两个文件在 `git diff --name-only` 里不出现。
- [x] 契约面：`npm run typecheck`、`npm run lint` 退出 **0**。
- [ ] 服务重启读数：生产服务由人重启后，在忙时连发多条语音 send 并等本会话空闲，`/api/providers/sessions/running` 读到 `[]`（待外部）

## DoD

判据在**修复完成的树**上按原命令重跑：退出 0、`fail 0`、`elapsed < 60_000`。真实落地不是「测试存在」：判据的真实 `claude` 臂里，真的有一个常驻进程在一条长 Bash 轮里，真的在飞行中连推两条命令，真的读到 CLI 把它们合成了一个 turn，真的在合并 turn 的 `result` 之后 `listRunningRuns()` 为空，且每个 run 恰好收到 1 条 `complete`、lease 无泄漏。假形态（回退为单次 shift）把终态读数打红（绿 = 判据有洞，必须补判据再继续），反例钉住「未被合并的下一轮不会被前一个 result 结算」。既有 resident 判据逐字不变且仍绿。**生产服务要吃到修复必须重启 `claudecodeui-server.service`，这会断开当前所有会话**：执行者不得自行重启，须向人说明并由人决定时机；重启后的真实读数由人确认，对应最后一条 AC。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts`
- `server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` (new)
- `server/shared/tests/quay-test-script.test.ts`
- `tasks/gap-resident-merged-queued-turn-leaves-stale-run-running.md`

## Notes

**合并判定依据（AC2/AC4 要求写明）**：`ResidentRound` 新增 `resultsSeenAtStart: number | null`。CLI 每 dequeue 一条排队消息就发一次 `command_lifecycle state=started`；`recordQueueFacts` 在该 `started` 到达时把「此刻 `state.resultTimes.length`（已读到的 `result` 个数）」写进其所属 round 的 `resultsSeenAtStart`。同一 turn 合并的 B、C 在同一次 dequeue 里 `started`，读到同一个 `resultTimes.length`；下一个 turn 的输入在本次 `result` 之后才 dequeue，其值必然更大；尚未 `started` 的 round 保持 `null`。`observe()` 收到 `result` 时，从队首起把 `resultsSeenAtStart` 等于队首该值的 round 连续 shift 出来一并结算（遇到第一个不等即停），`null` 的下一轮被显式排除、留待它自己的 `result`。`leaseRemoved(appSessionId, 'turn')` 按 kind 清除全部 turn lease，一次即覆盖本次全部结算的 round；若仍有 round 在等，再 `leaseAdded` 一次。

**实测读数（修复树上，逐字）**：
- AC1/AC2：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` ⇒ 退出 0，`fail 0`；`roundsPushed=3 resultsObserved=2 completeFrames=3 roundsOpen=0 turnLeasesOpen=0`、`completeCount: A=1 B=1 C=1`；`[budget] budget=60000ms elapsed=9062ms exit=0`。
- AC3：`settledAfterFirstResult=1 roundsOpenAfterFirstResult=1`、`roundsOpenAfterSecondResult=0`。
- AC5：`claudeBinary=/data/home/yale/.nvm/versions/node/v24.21.0/bin/claude`、`cliMergedIntoOneTurn=true resultsObserved=1 runsOpenAtRest=0 roundsOpenAtRest=0 totalResults=2 agentRequests=3`。
- AC6：`claude-resident-process.test.ts` ⇒ 退出 0（tests 10 / pass 10 / fail 0）；`claude-resident-idle.test.ts` ⇒ 退出 0（tests 1 / pass 1 / fail 0）；`git diff --name-only` 仅含 `server/modules/providers/list/claude/claude-host-driver.provider.ts`（两个兄弟判据文件不出现；新判据文件为 untracked）。
- AC7：`npm run typecheck` 退出 0；`npm run lint` 退出 0（告警均为既有，匹配 `merged-queued|claude-host-driver` 为 0 条）。

**计数钉子（本轮落地的机械修复，续做轮补）**：新增的 server 判据文件使 `scripts/` 派发口径里 server 测试文件收集数 +1，`server/shared/tests/quay-test-script.test.ts` 的两处 `known/unknown` 采集计数钉子必须同步：`unknown=317→318`（AC2 行）与 `unknown=319→320`（AC3 行）；develop 侧的 317/319 已含此前各任务的 bump，本分支只 +1。上一轮 exited-not-landed 的真实原因就是这两条钉子未同步（全量 suite 里该文件 `AC2`/`AC3` 红：`unknown=318` 对钉 `317`、`unknown=320` 对钉 `319`）。同步后单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` ⇒ 14 pass / 0 fail / 退出 0。

**假形态（AC4）实测**：把 `observe()` 里合并扫描整段删掉（`const merged: ResidentRound[] = [];` 仅保留），判据文件一字不动，重跑合并正例命令 ⇒ 退出 **1**。逐字红态读数：`roundsPushed=3 resultsObserved=2 completeFrames=2 roundsOpen=1 turnLeasesOpen=1`、`completeCount: A=1 B=1 C=0`；断言红文案 `C received exactly one terminal complete`；真实臂同次红在 `every run must settle (runsOpenAtRest=1)`（`cliMergedIntoOneTurn=true resultsObserved=1 runsOpenAtRest=1 roundsOpenAtRest=1`）。反例 AC3 在假形态下仍绿（`settledAfterFirstResult=1 roundsOpenAfterFirstResult=1`），证明修复不是「一个 result 清空全部」。随后 Edit 还原该段并重跑，复归退出 0 / `fail 0`。

## Blocker

**2026-10-13T05:56:49.538Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=65460 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1791870968717
- run_id：wk-prod-anchor
- session_id：dba29a00-3e75-473b-b7bf-e58612926ef8
