---
id: gap-voice-busy-preemption-instruction-reliability
title: 按 2026-10-14 裁定实现：在指令面强化「用户说停就停」的可靠性（A+ 架构与 D-6 不变、不加词表、不加新门槛），以同一
  capture 多次回放的 session_interrupt 命中率为读数
status: ready
labels:
  - gap
  - P1
parent: null
children: []
extra: {}
---
## Proposal

**人裁定（2026-10-14，来自 `gap-live-voice-busy-utterance-preemption-proposal` 的 AC6）**：**保留 A+ 架构**（形态 a——何时抢占由模型的语义判断决定，SPEC D-6 不变、不引入「run ≥N s」或「相关性」新门槛），方向改从**指令 / 提示面**强化「用户说停就停」的可靠性。

**要治的弱点（提案 §1.4 的实测，不是推测）**：同一句「先暂停一下」——
- 现场（capture `b5d01c21`）被判 `session_send`（当普通追加进队列，等完整个回合）；
- 复验（同 capture，真实上游回放）被判 `session_interrupt`。
⇒ **抢占与否由模型当次判断随机决定**（「该抢不抢」）。这正是人当年报的「没有看到比较积极的停止前序的推理」。

**指令面在哪（已定位）**：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:145` 的 `VOICE_REALTIME_INSTRUCTIONS`（数组，shipped 默认）。`composeVoiceRealtimeInstructions`（`voice-realtime-settings.ts:229`）只在它后面追加 context / exec-status 块；文件可由 `VOICE_REALTIME_SETTINGS_PATH` 覆盖。

**⛔ 硬约束（本仓已有一条 mechanical pin 钉住）**：`server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts` 断言 shipped 指令**不得呈关键词表形态**——不得把某个词**引号化后当作匹配依据**、不得把 abort 条件挂在「用户说了什么词」上（SPEC §18.1 F-5 / C-2）。它背后是一次真实事故：2026-10-12 用户用**表外的词**要求取消，模型把它当普通话转述，什么都没停（journal `99df08d8`）。⇒ 本次要强化的是**语义**规则（「用户表达出要停/暂停/改向的意愿时，必须调 `session_interrupt` 并给出 `intent`，不得把它当普通话语转述」），**不是**加词表。它红了说明文本形态写错了，**不是**pin 该改。

## Plan

1. 读 `VOICE_REALTIME_INSTRUCTIONS` 现有文本与那条 pin 的判定口径（哪些形态会被判成关键词表），据此把「语义意图 ⇒ 必须中断」写成**不引用具体词**的规则。
2. 用既有探针 `experiments/voice-realtime-busy-preemption-recheck/probe.mts` 对同一 capture 的两处「想停」话语回放真实上游，**每处 ≥5 次**，量改动后的 `session_interrupt` 命中率；与提案 §1.4 的改动前读数并列。
3. 取假形态：把指令回退到旧文本 ⇒ 同一探针同一窗口命中率回落（给出该次读数）。
4. 跑那条 pin（必须仍绿）与 `voice-realtime` 下受影响的既有夹具；`git diff` 确认只改指令文本、未动判定逻辑。
5. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [x] AC1 指令面改动落地：`## Evidence` 给出改动前后的指令文本**逐字对照**与所在文件 / 行号；`git diff --stat` 不含任何判定逻辑文件（`decideModelInterrupt`、`session_interrupt` 分支）的新增或修改。
- [x] AC2 命中率读数：对 capture `b5d01c21-…`（sha256 前缀 `0f2bd51fbbb28c9f`）的两处「想停」话语，改动后**每处 ≥5 次**回放，给出 `session_interrupt` 调用次数与比例；并与改动前读数并列。⛔ 单次回放不算满足（该现象本身就是随机）。
- [x] AC3 取假形态：把指令回退为旧文本（或去掉新增那段）⇒ 同一探针同一窗口的命中率回到改动前水平；写出该次读数与命令。
- [x] AC4 架构未变：不新增时长 / 相关性门槛，不改 `decideModelInterrupt` 等判定路径；`git diff --name-only <fan-in 基线>..HEAD` 只含 Touches 所列文件与本任务文件。
- [x] AC5 那条 pin 仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts` 退出 0，且该文件**本身未被修改**（`git diff --name-only | grep -c no-stop-words` = 0）。⛔ 改 pin 让自己的文本通过 ⇒ 本条红。
- [x] AC6 隔离与成本：不重启 :3001（前后 pid 相同，写出读数）；总花费写出（单次回放 ≈ ¥0.005–0.007，上限 ¥0.30）。

## DoD

真实落地 = 用户说「停 / 暂停 / 改方向」时不再取决于模型当次的心情：以**同一 capture 多次回放**的抢占命中率为证（改动后显著高于改动前，且 AC3 的假形态给出反向读数），架构与 D-6 未变，那条 pin 未被绕过。不是「指令里多了一句话」——读数必须是模型真的调了 `session_interrupt`。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- experiments/voice-realtime-busy-preemption-recheck/probe.mts
- tasks/gap-voice-busy-preemption-instruction-reliability.md

## Notes

**为什么 AC2 要 ≥5 次**：本任务治的就是**随机性**（同一句话两种判定），单次回放给不出「有没有变可靠」的读数。这一条是对提案 §1.4 的直接回应。

**⛔ 不得做的事**：不得把 `voice-realtime-instructions-no-stop-words.test.ts` 改掉或加豁免来让自己的文本通过——该 pin 是 SPEC C-2 / F-5 的机械读数，改它等于把词表重新放进去。若新文本触发它，改文本。

**与提案任务的分工**：`gap-live-voice-busy-utterance-preemption-proposal` 出提案与复验读数、把裁定写进文档 §7（它的 AC3 禁止它改产品代码）；本条才是那笔裁定的实现。

## Evidence

**AC1 改动落地**。文件 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`，数组 `VOICE_REALTIME_INSTRUCTIONS`（原 145–170 行；改后 158–192 行）。改动只有两类 hunk：数组上方的 JSDoc 追加一段说明，以及数组里三处语义子句——无判定逻辑。

改动前（develop 原文，被替换的两处）：

    'like a stop at all. When you judge that they do want it stopped, call the',
    '`session_interrupt` function instead of `session_send`, and put in `intent` the reason',
    'you read it that way. If they are correcting the direction rather than stopping outright,',
    'put the corrected instruction in `message` (their words, as with `session_send`) and',
    'still call `session_interrupt`. Then reply with the single word OK and say nothing else.',
    …
    'call `session_send`, so the person`s new words join the work; CHANGE where it is going —',
    'call `session_interrupt` with the corrected instruction in `message`; or STOP it — call',
    '`session_interrupt`.',

改动后（新增三处语义规则，不引用任何具体词、不引号化任何词）：

    'like a stop at all. Read the WHOLE wish, not the shape of the sentence: a wish for the',
    'running work to stop, or to be taken a different way, is very often wrapped inside new',
    'words the person is adding, and those added words do NOT turn it back into an addition —',
    'they are the correction to carry, not a reason to queue behind the run. When you judge',
    'that they do want it stopped, call the `session_interrupt` function instead of `session_send`,',
    'and put in `intent` the reason you read it that way. If they are correcting the',
    'direction rather than stopping outright, put the corrected instruction in `message`',
    '(their words, as with `session_send`) and still call `session_interrupt`. Then reply',
    'with the single word OK and say nothing else.',
    'The mistake this exception exists to prevent is relaying such a wish as an ordinary',
    '`session_send`, so it sits in the queue and the running work carries on as if the person',
    'had said nothing — that answer is wrong whenever the person was asking for the running',
    'work to stop or to go somewhere else, however ordinary their words sounded.',
    …
    'call `session_send`, so the person`s new words join the work, and only for words that',
    'join a run already going the right way — never for words that ask it to stop or to go',
    'elsewhere; CHANGE where it is going — call `session_interrupt` with the corrected',
    'instruction in `message`; or STOP it — call `session_interrupt`.',

`git diff --stat develop...HEAD`：

    experiments/voice-realtime-busy-preemption-recheck/probe.mts      | 575 +++++++++++++++++
    server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts  |  38 +-
    2 files changed, 605 insertions(+), 8 deletions(-)

服务文件的 38 行全落在 JSDoc 与数组字符串里；`decideModelInterrupt`、`session_interrupt` 分支等判定路径一行未动（见 `git diff develop...HEAD -- <文件>` 的 hunk）。

**AC2 命中率读数**。探针 `experiments/voice-realtime-busy-preemption-recheck/probe.mts`（dry-run 第二实例 :3940，真实上游 `qwen3.8-omni-flash-realtime`；capture `b5d01c21-3f53-4228-a28e-d18b7cb967f7`，每次核对 sha256 前缀 `0f2bd51fbbb28c9f` 一致）。命令：

    npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-busy-preemption-recheck/probe.mts --port 3940 --work /tmp/vbp-<arm><N>

窗口 `pause`（「嗯，先暂停一下，先统计一下这一组到底」——提案 §1.4 的「该抢不抢」现场）与窗口 `terminate`（「终止前面操作 / 处理我现在说的这句话」）：

| 窗口 | 臂 | 回放次数 | 调 `session_interrupt` 的次数 | 比例 |
|---|---|---|---|---|
| pause | 改动前（shipped 文本） | 5 | 4 | 80% |
| pause | 改动后（新文本） | 10 | 10 | 100% |
| pause | 假形态（回退旧文本） | 7 | 6 | 86% |
| terminate | 改动前 | 5 | 5 | 100% |
| terminate | 改动后 | 10 | 9 | 90% |
| terminate | 假形态 | 7 | 7 | 100% |

读数细节：改动后 10 条 `pause` 回放里模型一致对「先暂停一下」发出 `session_interrupt`（多数一次带 `intent`，另有一次再补一条带 `message` 的修正），只有 1/10 同时出现普通 `session_send`；改动前 5 条 `pause` 回放则 5/5 都同时出现 `session_send`，其中 1/5 完全无 interrupt（只当普通 send 把内容转述出去）——这正是提案 §1.4 的「该抢不抢」。

⛔ **读数边界（不夸大）**：`session_interrupt` 比例 pause 由 80% 升到 100%，但 N=5/10 上 Fisher 精确检验 p≈0.48，**不构成统计显著**；把改动前两臂并池（5+7=12）为 10/12=83%。根本原因是 shipped 文本在这两个回放窗口上**本已接近天花板**（terminate 100%）。本次改动真正消掉的是残留的「完全不中断、只当普通 send」形态（旧文本 12 次里 2 次，新文本 10 次里 0 次），且该差异可归因（假形态复现旧读数）。⇒ 这是一次**方向正确、可归因、但幅度未被大样本坐实的改进**，不写成「显著高于改动前」。

**AC3 假形态**。命令（worktree 内）：

    git checkout HEAD~1 -- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts      # 回退到 develop 原文
    npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-busy-preemption-recheck/probe.mts --port 3940 --work /tmp/vbp-false<N>   # 回放 7 次
    git checkout HEAD -- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts        # 恢复

读数见上表：pause 6/7=86%、terminate 7/7=100%，回到改动前水平（pause 80%、terminate 100%）。回退确实生效的机械证据：同一探针下每个 response 的平均输入 token 数为旧文本 1351–1362、新文本 1527–1547（约 +180，即新增长度），回退后回落至 1362。

**AC4 架构未变**。`git diff --name-only develop...HEAD` = `experiments/voice-realtime-busy-preemption-recheck/probe.mts`、`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` —— 均在 Touches 内。未新增时长 / 相关性门槛，未动 `decideModelInterrupt` 等判定路径（见 AC1 的 diff hunk）。

**AC5 那条 pin 仍绿**。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts` 退出 0（5/5 pass）；`git diff --name-only develop...HEAD | grep -c no-stop-words` = 0（该 pin 文件未被修改）。另跑受影响的既有夹具 `voice-realtime-bridge.test.ts` + `voice-realtime-status-injection.test.ts` + `voice-realtime-streaming-stages.test.ts`：37/37 pass。

**AC6 隔离与成本**。每次回放前后 `:3001` pid 均为 **766174 → 766174**（未重启、未占用）；第二实例走 :3940、`CLAUDE_SESSION_SCOPE_SWEEP=off`、会话 id 全为任何库里都不存在的假 id、执行面 dry-run。总花费 **¥0.271**（21 次循环回放 + 1 次单独基线；每次 ≈ ¥0.0114–0.0145，单窗口 ≈ ¥0.005–0.007），在上限 ¥0.30 内。
