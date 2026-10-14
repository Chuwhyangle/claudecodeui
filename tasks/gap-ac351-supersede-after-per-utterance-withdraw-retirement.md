---
id: gap-ac351-supersede-after-per-utterance-withdraw-retirement
title: AC-351 的「语音待投递条目逐条撤回」已被 2026-10-14 裁定整体退役（逐行撤回控件与其 cancelQueued 接线由
  9ccdc6eb7 删除，判据文件不在树上 ⇒ 现必红）⇒ 把 AC-351 记录置 superseded 并写明理由，同步 GOAL-041 退出条件与
  SPEC D-11
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-351
---
## Proposal

### 判据现状（本轮直接复量，2026-10-15，仓库 HEAD `98a4fc6b119d0c980e7a935692cdddc47bd7103e`，branch `author`）

AC-351 的判据逐字为

```
f=src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f"
```

本轮在 `/data/home/yale/work/claudecodeui` 直跑：**exit 1**，stderr 逐字 `缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`。红在**存在性闸**，测试未被执行。判据文件确实不在树上：`ls src/modules/chat/voice-realtime/tests/` 的 17 项里没有它（同目录存在后继文件 `voicePendingMessageCard.test.tsx`）。

### 机制：不是「上一次的修法没兜住」，也不是 merge race，是一次人裁定的整体退役

1. 原修法 `6c5378b7`（`2026-10-12 19:14:46 +0800`，`feat(voice): withdraw a single pending utterance from the Live Voice queue`）新增 `useVoicePendingWithdraw.ts`、`VoicePendingUtterance.tsx`、`voicePendingWithdraw.test.tsx`。它**确实落地并生效**：此前那条「台账尾部红」已由 `gap-ac351-criterion-ledger-red-is-merge-race`（status: **done**）归因为 fan-in 落地与判据测量之间的竞态，并实测净树 `9 passed (9)`、exit 0。
2. 2026-10-14 人裁定「屏上唯一一张合并卡」。落地提交 `9ccdc6eb7`（`2026-10-14 16:38:11 +0800`，`feat(voice): hold ONE merged pending message in the relay (ruling 2026-10-14)`）**删除**了上述三个文件与 `e2e/voice-pending-utterance-withdraw.spec.ts`（`git show --stat 9ccdc6eb7` 里四者均为删除），改为 relay 侧一条合并 hold + 页面一张只读卡 `src/modules/chat/voice-realtime/VoicePendingMessageCard.tsx`。其提交信息逐字：「The per-utterance withdrawal control is retired with the per-sentence rows it drew: the ruling allows no withdraw/interrupt affordance in Live Voice.」
3. 同一条禁令在 done 任务 `gap-voice-relay-busy-hold-host-rounds-and-queue-visibility` 里被逐字写下：「读它的逐行撤回控件已被 2026-10-14 裁定移除」「**不得**恢复已被裁掉的撤回按钮」。

### 为什么合法终态是 (b) supersede，而不是 (a) 硬改绿

要让判据重新为真，必须把逐行撤回控件与其 `cancelQueued` 接线搬回 Live Voice。但这会：

- 正面违反 2026-10-14 裁定与上述 done 任务的明文禁令；
- 红掉后继钉子 `src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx:182` 的 `expect(drawn[0]!.querySelectorAll('button').length, 'the held-message card offers no control').toBe(0)`（其注释写明「The card is READ-ONLY: nothing inside it can be pressed, so nothing can be read as "withdraw"」）；
- 且 AC-351 自己的 `expect` 要求「语音投递且 queued 的话语渲染为**可撤回的待执行行**」（逐行、按 `queuedMessageUuid` 寻址），与「屏上唯一一张**只读**卡」在**保证层**互斥 —— 这不是 AC-178 那种「锚退役、产品保证仍在」的量具错位，而是被断言的保证本身已退出本仓意图。本仓先例同形：`gap-ac364-supersede-after-sts-production-retirement`（done，`goal_ac: AC-364`）。

⇒ 走 (b)：把 AC-351 记录置 `superseded` 并**书面写明理由**。

### 后继读数载体

- 退役的是「撤回」这一能力本身；它按裁定**没有**后继（`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3 D-2「模型工具面不暴露撤回/清空队列」不变，非目标里也早已含「模型侧撤回/清空队列」）。
- 促使那些行存在的「等待中的话要看得见」这一关切，由只读合并卡承接：单元钉子 `src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx`，浏览器面 AC-345 / `e2e/voice-realtime-intent-control.spec.ts`（其 `expect` 逐字要求「屏上是唯一一张合并的 pending 卡」）。

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rn "^goal_ac: *AC-351" tasks/*.md` 命中 **2** 条 —— `tasks/gap-live-voice-pending-utterance-withdraw.md`（status **done**，那条是原修法本身）与 `tasks/gap-ac351-criterion-ledger-red-is-merge-race.md`（status **done**，那条是上一轮的竞态归因）；按规则 done 不是重复，而是「需要重新为真」的证据。在飞扫描（`status` ∈ todo/ready/needs-human 且 `goal_ac: AC-351`）**0 命中** ⇒ 无在飞认领者。机制扫描：`grep -rln "supersede\|退役" tasks/*.md` 命中的同族先例 `gap-ac364-supersede-after-sts-production-retirement`（AC-364）、`gap-voice-single-continuous-input-path`（AC-122）各为**另一条 AC**，仅处置机制相同；没有一份是「把 AC-351 按 2026-10-14 裁定退役」。merge-candidate 读数：`node …/task-granularity-advice.js --touches goals/AC-351-*.md --touches goals/GOAL-041-*.md --touches docs/proposals/voice-realtime-persistent-control-SPEC.md --root <root> --json` → `peers: []`（**separate**）；共享 SPEC 的 10 份任务（`gap-ac345-gate-deadline-below-criterion-wallclock`、`gap-claude-resident-cancel-queued-capability-truth`、`gap-claude-resident-e10-enqueue-interrupt-drain`、`gap-id-relations-and-projection-invariants-review`、`gap-live-voice-continuous-calibration-run`、`gap-live-voice-double-drop-signatures-carry-actuals`、`gap-live-voice-busy-utterance-preemption-proposal`、`gap-live-voice-continuous-transport-opt-in`、`gap-live-voice-double-drop-browser-e2e`、`gap-live-voice-interrupt-run-utterance-fence`）**全部 done**。

## Plan

1. **复量并归档读数**：按 `## AC` 的判据命令逐字跑一次（不跑则判据红态无凭），把 exit 码与 stderr 逐字写入 `## Notes`；另记 `ls src/modules/chat/voice-realtime/tests/` 的 17 项与 `git show --stat 9ccdc6eb7` 的四条删除行。
2. **退役 AC-351 记录**：走本仓既有的授权 goal 写入路径（`quay goal write`，**先 `--dry-run`** 观测一次确认不落盘）。写 `status: superseded`，书面理由须同时含：(a) 2026-10-14 裁定（「屏上唯一一张合并卡」；逐行撤回控件随其行一并退役，Live Voice 不留撤回/中断的可按控件）；(b) 落地提交 `9ccdc6eb7`；(c) 后继读数载体 `voicePendingMessageCard.test.tsx`（并注明撤回能力本身无后继）。**不改 `criterion` 行** —— 判据是「它当时断言了什么」的记录，退役不改写它。写完复读核对：`status: superseded`、理由在位、`criterion` 逐字未变。
3. **同步 GOAL-041 的 `## 退出条件`**：其现文本逐字含「AC-338..AC-345、AC-350、AC-351 的判据全部通过」与范围句里的「阶段 2：AC-351（语音待投递条目逐条撤回，仅 UI 确定性按钮）」。AC-351 既已 `superseded`，两处改写为退役态读法（引 superseded / 2026-10-14 裁定），同样走授权写入路径并记读数。
4. **同步 SPEC 正本**：`docs/proposals/voice-realtime-persistent-control-SPEC.md` 的 §0.3 D-11 行（现文本把「逐条撤回」列为阶段 2 并点名 AC-351）与 §18 阶段表里那一行（现文本为「2 | 语音待投递条目逐条撤回（UI 确定性按钮，D-11） | — | AC-351 / `gap-live-voice-pending-utterance-withdraw`」）改写为退役态。**只动这两处语义行**，不重写文档、不改 D-2 / I-4 / C-1 的既有裁定。
5. **回归**：`npm run typecheck`、`npm run lint` 退出 0（本条只动 `goals/`、`docs/` 与 `tasks/`，无产品代码改动，仍按仓库惯例跑一遍）；写出 `## Notes` 读数表。

## AC

- [x] AC1（取假形态排最前）**判据不是被改绿消掉的**：AC-351 记录的 `criterion` 行**逐字未改**（仍要求那份判据文件、仍含存在性闸与 `npx vitest run "$f"`）；`git diff -- goals/AC-351-*.md` 的 hunk 只含 `status` / `statusLog` / `origin` 或 `body` 一类字段，**无任何 `criterion:` 行 hunk**（before/after 逐字相同）。取假形态：若把 `criterion` 换成别的文件、删掉存在性闸、或把它指向 `voicePendingMessageCard.test.tsx` 以让判据转绿 ⇒ 本断言红。
- [x] AC2 AC-351 记录的 `status` 为 `superseded`（`quay goal show AC-351` 读数），且记录内含**书面理由**，理由文本同时出现：(a) 2026-10-14 裁定；(b) 提交 `9ccdc6eb7`；(c) 后继载体 `voicePendingMessageCard.test.tsx`；并写明撤回能力本身无后继。写入经授权 goal 写入路径，证据里记 `--dry-run` 那一次的读数（不落盘）与实际写入后的复读。⚠️ 若执行侧确定无权写 goal 记录 ⇒ **停在 needs-human** 并把待写文本备好，⛔ 不得改判据或改测试去制造假绿。
- [x] AC3 GOAL-041 的退出条件不再把 AC-351 当作在域保证：`grep -n "AC-351" goals/GOAL-041-*.md` 的每条命中都在退役态读法里（引 superseded / 2026-10-14 裁定），全文**不再**出现「AC-351 的判据全部通过」这一原句。读数（grep 前后）记入证据。
- [x] AC4 SPEC 正本不再把逐条撤回列为在域阶段 2：`grep -n "AC-351" docs/proposals/voice-realtime-persistent-control-SPEC.md` 的 §0.3 D-11 行与 §18 阶段表行均为退役态读法；`git diff develop -- docs/proposals/voice-realtime-persistent-control-SPEC.md` 的改动行**只落在**这两处语义行（不重写文档、不动 D-2 / I-4 / C-1 的既有裁定）。
- [x] AC5 **承重面未被本条触碰**：`git diff --name-only develop...HEAD -- src server e2e playwright.config.ts` 为空；`e2e/voice-pending-utterance-withdraw.spec.ts` 仍不存在（退役是 `9ccdc6eb7` 做的，本条不复活任何文件）；`src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx` 的 blob 与 `develop` 相等。⛔ 未编辑任何 `src/**`、`server/**`、`e2e/**`。
- [x] AC6 **如实登记**：完成记录逐字写明「原修法 `6c5378b7` 曾真实生效并被机械 fan-in 落地（净树 9/9、exit 0）；本轮红因是 2026-10-14 人裁定的退役提交 `9ccdc6eb7` 把逐行撤回控件与其判据一并删除，**不是**修法失效、**也不是** merge race（该机制已由 `gap-ac351-criterion-ledger-red-is-merge-race` 归因完毕）」，并给出后继读数载体与残留假设。⛔ 不得用「测试文件缺失」这一现象当作理由的全部，必须引到那笔裁定与那个提交。

## DoD

AC-351 在 goal store 里被**显式退役**：`status: superseded` + 一条引用 2026-10-14 裁定与提交 `9ccdc6eb7` 的书面理由，且 `criterion` 逐字未改。GOAL-041 的退出条件与 SPEC 正本（§0.3 D-11、§18 阶段表）随之对齐，不再把一条已退役的判据当作在域保证。产品代码、测试、e2e spec 一件不删不改；本任务**不**恢复撤回按钮、**不**改判据、**不**造绿。

若执行侧无权写 goal 记录：置 `needs-human` 并写明「已把待写文本备好，退役需授权写入路径」，⛔ 不得改判据或改测试去制造假绿。

## Touches

- goals/AC-351-语音待投递条目逐条撤回-live-voice-中已入-cli-队列未出队的话语行带-ui-撤回按钮-走既有-cancel.md
- goals/GOAL-041-live-voice-意图控制-a-cli-回合边界聚合-语义主动中断-深度真实与可审计-先入队后中断与栅栏.md
- docs/proposals/voice-realtime-persistent-control-SPEC.md
- tasks/gap-ac351-supersede-after-per-utterance-withdraw-retirement.md

## Notes

立项：GOAL-041 gap-filing agent，2026-10-15。AC-351 的 GOAL 已不在 reverify scope（`longTerm: false`），本轮直接复量判据 ⇒ 判据红（上 `Proposal` 的读数），故立案。

**授权路径**：AC2 / AC3 的 goal 记录写入用 `quay goal write`（先 `--dry-run`）。本仓既有先例：`gap-ac364-supersede-after-sts-production-retirement`（done，`goal_ac: AC-364`）的 worker 即用该路径把 AC-364 置 `superseded` 并同步了 GOAL-044 的退出条件；`gap-voice-single-continuous-input-path`（done）执行 AC-122 的退役（`reason` 含「人 yale 2026-10-04 授权退役」）。本条的人授权即 2026-10-14 那次裁定本身。

**为什么不是 (a)**：见 `## Proposal`「为什么合法终态是 (b)」。把撤回控件搬回来会正面违反该裁定与 `gap-voice-relay-busy-hold-host-rounds-and-queue-visibility` 的明文禁令，并红掉后继钉子 `voicePendingMessageCard.test.tsx:182`。

**边界**：本条**不**删除、**不**复活任何文件；`e2e/voice-pending-utterance-withdraw.spec.ts` 早已被 `9ccdc6eb7` 删除，故不存在「归档 spec 拖红默认 playwright 集合」的问题（对照 AC-364 需要排除归档 spec —— 本条不需要，`playwright.config.ts` 一字不动）。
### 执行读数（2026-10-15，分支 `task/gap-ac351-supersede-after-per-utterance-withdraw-retirement`，工作树 `/data/home/yale/work/claudecodeui-worktrees/gap-ac351-supersede-after-per-utterance-withdraw-retirement`）

**判据复量（Plan 1）**：判据命令逐字跑一次 → **exit 1**，stderr 逐字 `缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`（红在存在性闸，测试未被执行）。`ls src/modules/chat/voice-realtime/tests/` 的 17 项里无该文件（同目录有后继 `voicePendingMessageCard.test.tsx`）。`git show --stat 9ccdc6eb7` 的四条删除行：`e2e/voice-pending-utterance-withdraw.spec.ts`、`src/modules/chat/voice-realtime/VoicePendingUtterance.tsx`、`src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`、`src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts`。

**AC1 — 判据逐字未改**：`criterion` 块 before（`develop:goals/AC-351-*.md`）对 after（`HEAD`）逐字节相同，两端 md5 均 `8c3a772a11ac281b9e786ebc3212a750`。改后 criterion 仍点名 `voicePendingWithdraw.test.tsx`、仍含存在性闸字面量与 `npx vitest run "$f"`（各 `grep -c` = 1）。`git diff develop -- goals/AC-351-*.md` 的顶层字段 hunk 只有 `-status: achieved` / `+status: superseded`；`grep -c "^[+-].*criterion:"` = **0**。取假形态（把 criterion 指向别的文件、或删掉存在性闸）会同时改到这两条读数 ⇒ 本断言红。

**AC2 — superseded + 书面理由**
- `--dry-run` 读数（不落盘）：`quay goal write AC-351 --store --root <WT> --status superseded --reason "$(cat reason)" --body "$(cat body)" --actor worker:gap-ac351-supersede --dry-run` → exit 0，打印记录 `status: superseded` + 新 statusLog 条 + body；执行前后工作树 `HEAD` 同为 `57f1b78e6`、`goals/AC-351-*.md` md5 同为 `8e4ee22e616a8351d942ce940c7af0df`（未落盘）。
- 实际写入：提交 `106d6743b`（`goals: AC-351 status achieved→superseded`，落在本任务分支）。复读 `quay goal get AC-351 --store --root <WT>` → `status = superseded`；`statusLog[-1] = {from: achieved, to: superseded, actor: worker:gap-ac351-supersede, reason: …}`；body 首行 `## 退役记录（2026-10-15）`。三条必含文本在 `reason` 与 `body` 中均逐字在位 —— `2026-10-14`、`9ccdc6eb7`、`voicePendingMessageCard.test.tsx`，并有「撤回能力本身无后继」一句。
- ⚠️ 读数口径（同 AC-364 先例）：无参数的 `quay goal show AC-351` 走 **Provider ABI**，其 goal 目录由本仓 `.quay/config.yml` 钉到**主检出** `/data/home/yale/work/claudecodeui/goals`（绝对路径），且 **Provider 路径不认 `--root`**（实测带 `--root <WT>` 仍打印主检出读数）。本条的写入落在任务分支，故**合并前**该命令仍打印 `[achieved]`；工作树内的授权读数是 store 方言 `quay goal get AC-351 --store --root <WT>`。分支合入 develop、主检出同步后即为 `superseded`。
- ⚠️ 一条如实登记：为确认写入路径，本轮先跑过一次**未知标志探测**（`quay goal write AC-351 --origin x --bogus-flag-xyz`，未带 `--root`）；外层解析器**静默丢弃未知标志后照常写盘**，且 Provider ABI 路径会 propagate 到 develop，故一行 `origin: x` 短时落到 develop 上（提交 `c5072af94`）。随即用同一授权路径按原值写回（提交 `52280b0e0` `goals: AC-351 field:origin`）：**写回后该文件与事故前逐字节相同**（`git diff 57f1b78e6 -- goals/AC-351-*.md` 无输出；md5 `8e4ee22e616a8351d942ce940c7af0df`），净效果为零。此后所有写入均带 `--root <WT>`。

**AC3 — GOAL-041 退出条件对齐**：改前（`develop:` 版本）`grep -n "AC-351" goals/GOAL-041-*.md` → 2 命中（第 28 行范围句、第 32 行退出条件句），且 `grep -c "AC-351 的判据全部通过"` = **1**；改后同为 2 命中，两条都是退役态读法（引 `superseded` / 2026-10-14 裁定 / 落地提交 `9ccdc6eb7` / 后继载体），`grep -c "AC-351 的判据全部通过"` = **0**。写入走 store 方言 `quay goal write GOAL-041 --store --root <WT> --body "$(cat body)"`（先 `--dry-run`：exit 0 且文件 md5 未变），提交 `62428ed10`；`git diff develop -- goals/GOAL-041-*.md` 恰 2 行（范围句、退出条件句）。

**AC4 — SPEC 只动两处语义行**：`grep -n "AC-351" docs/proposals/voice-realtime-persistent-control-SPEC.md` → 第 47 行（§0.3 D-11）与第 578 行（§18.6 阶段表）各 1 命中，两条均为退役态读法（引 2026-10-14 裁定 / `9ccdc6eb7` / `superseded` / 后继载体）。`git diff --numstat develop -- docs/proposals/voice-realtime-persistent-control-SPEC.md` = `2 2`（恰两行改写）；D-2 / I-4 / C-1 与文档其余部分一字未动。提交 `39fceba9b`。

**AC5 — 承重面未触碰**：`git diff --name-only develop...HEAD -- src server e2e playwright.config.ts` 无输出；`e2e/voice-pending-utterance-withdraw.spec.ts` 仍不存在；`voicePendingMessageCard.test.tsx` 的 blob 与 develop 相等（两端 `00994052a079fa6bc32a49d376e75362e8f9c753`）。本分支相对 develop 的全部改动只有三份文件：`docs/proposals/voice-realtime-persistent-control-SPEC.md`、`goals/AC-351-*.md`、`goals/GOAL-041-*.md`。

**AC6 — 如实登记（完成记录）**：原修法 `6c5378b7` 曾**真实生效**并被机械 fan-in 落地（净树 `9 passed (9)`、exit 0）；本轮红因是 **2026-10-14 人裁定的退役提交 `9ccdc6eb7` 把逐行撤回控件与其判据一并删除**（判据文件不在树上 ⇒ 存在性闸 exit 1），**不是**修法失效，**也不是** merge race（该机制已由 `gap-ac351-criterion-ledger-red-is-merge-race`（done）归因完毕）。后继读数载体：单元钉子 `src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx` + 浏览器面 AC-345 / `e2e/voice-realtime-intent-control.spec.ts`；**撤回能力本身无后继**。残留假设：「等待中的话要看得见」这一关切现由**只读合并卡**承接；若将来出现「逐条寻址待投递话语」的真实需求，只能在不恢复任何撤回/中断可按控件的前提下另立 AC（2026-10-14 裁定的禁令仍在），本任务不复活任何文件。

**回归**：`npm run typecheck` → exit 0（三条 tsc 全过）；`npm run lint` → exit 0（仅既有 warning）。本条无产品代码改动。

## Blocker

**2026-10-14T19:10:44.501Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts:   AssertionError [ERR_ASSERTION]: a title offered after adoption must not reach the ladder, where the adopted custom-title already outranks it (customTitles=["AC171 Title 5322fd33","AC171 Later 5322fd33"]) [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts,server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts,server/shared/tests/quay-test-script.test.ts]
- run_id：wk-prod-anchor
- session_id：ee81100a-eb85-4592-b4db-dad17ec5f03e
