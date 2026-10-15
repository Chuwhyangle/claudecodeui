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

## Evidence

**第 3 轮收口读数（2026-10-15）—— 六条 AC 逐条在合并树上复量，全部为真：**

| AC | 读数 | 结果 |
|---|---|---|
| AC1 | `git diff develop -- "goals/AC-351-*.md" | grep -c '^[+-].*criterion:'` = **0**；criterion 块两端 md5 同为 `8c3a772a11ac281b9e786ebc3212a750`；顶层字段 hunk 仅 `-status: achieved` / `+status: superseded` | ✅ |
| AC2 | `grep -n '^status:' goals/AC-351-*.md` = `5:status: superseded`；理由文本逐字含 `2026-10-14`(×5)、`9ccdc6eb7`(×2)、`voicePendingMessageCard.test.tsx`(×2)、`无后继`(×2)；`--dry-run` 读数与实际写入后复读已记入 `## Notes`（提交 `106d6743b`） | ✅ |
| AC3 | `grep -n "AC-351" goals/GOAL-041-*.md` = 2 命中（第 28 行范围句、第 32 行退出条件句），两条均为退役态读法；`grep -c "AC-351 的判据全部通过"` = **0** | ✅ |
| AC4 | `grep -n "AC-351" docs/proposals/voice-realtime-persistent-control-SPEC.md` = 第 47 行（§0.3 D-11）+ 第 578 行（§18.6 阶段表）；`git diff --numstat develop -- …SPEC.md` = `2 2`（恰两行改写，D-2 / I-4 / C-1 一字未动） | ✅ |
| AC5 | `git diff --name-only develop...HEAD -- src server e2e playwright.config.ts` **无输出**；`e2e/voice-pending-utterance-withdraw.spec.ts` 仍不存在；`voicePendingMessageCard.test.tsx` 两端 blob 同为 `00994052a079fa6bc32a49d376e75362e8f9c753` | ✅ |
| AC6 | 见 `## Notes` 的「AC6 — 如实登记（完成记录）」 | ✅ |

`node …/scripts/dist/fan-in-ac-completion-gate.js --task <id> --worktree <WT>` → `AC 全勾（6/6）——可翻 done`，**exit 0**。

### 为什么本轮仍不可落地（执行侧不可满足 ⇒ park needs-human）

1. **本任务零代码 delta。** `git diff --name-only HEAD develop` 只有四份文件：`docs/proposals/voice-realtime-persistent-control-SPEC.md`、`goals/AC-351-*.md`、`goals/GOAL-041-*.md`、`tasks/<id>.md`；`git diff --name-only HEAD develop -- src server e2e playwright.config.ts` **为空** ⇒ 代码树与 develop 逐字节相同 ⇒ **本分支上的任何 suite 红都必然是 develop 自身的红**，不存在「本任务引入的红」。
2. **两条红都在 develop 侧且都与本任务无关：**
   - `server/shared/tests/quay-test-script.test.ts` —— 计数钉子 / 覆盖率地板过期（纯算术）：树上 server 测试文件 **336** 个，`scripts/suite-duration-baseline.tsv` 只有 **298** 条数据行 ⇒ AC7 读 `298/336 = 88.7% < 90%` 红；两条 pin 逐字期望 `known=3 unknown=327`（总 330）与 `known=1 unknown=329`（总 330），实读 `unknown=333` / `unknown=335`（总 336）。**6 个新 server 测试文件落进 develop 而没人搬钉子** —— 即本仓已知的系统性地板（新增 server 测试文件即压破 AC7 90% 地板）。
   - `server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts:1102` —— **真实失败**（标题 ladder：adoption 之后 offered 的 title 不得再进 ladder），单文件隔离复现。
3. **单文件复量（本轮亲跑，非引用驱动读数）：两条都 exit 1。**
   - `claude-peer-name-follows-ai-title.test.ts` → `AssertionError [ERR_ASSERTION]: a title offered after adoption must not reach the ladder … customTitles=["AC171 Title e9a64142","AC171 Later e9a64142"]`，断点 `:1102:12`，`ℹ fail 1`。
   - `quay-test-script.test.ts` → AC7 `baseline covers 298/336 collected files (< 90%)`；AC2 实读 `unknown=333` vs 期望 `327`；AC3 实读 `unknown=335` vs 期望 `329`；`ℹ fail 3`。
4. **执行侧不能修：** 修 Red A 要动 `server/shared/tests/quay-test-script.test.ts`（pin）与 `scripts/suite-duration-baseline.tsv`，修 Red B 要动产品代码 —— 两者都落在本任务 **AC5 明文禁止**的 `server/**` 面内，也与 DoD「产品代码、测试、e2e spec 一件不删不改」正面冲突。**改它们＝篡改本任务自己的 AC5，正是本任务下令禁止的「造绿」。**

### 为什么不再 exit 等下一轮（保险丝分析，读驱动源码得出）

- `decideBaselineRedCircuitBreaker`（`worker-driver.js:56659`）的 `consecutive` 要求 `same[i].signature !== current.signature` **逐字全等**。而本任务的签名里嵌着**每次运行都变**的字节：`.quay/baseline-red-rounds.jsonl` 里连续两轮的签名只差 `AC171 Title 5322fd33`→`57b44c77` 与 `(1254.156327ms)`→`(1281.685961ms)`；本轮我亲跑的隔离复现给出**第三个**值 `e9a64142`。⇒ **该断路器的 `consecutive` 永远停在 1，`cap` 永不跳闸。**
- `judgeRetryExemption`（`worker-driver.js:59493`）只有在「同一签名跨 ≥2 个不同任务复现」时才给 `unrelated-flaky-exempt`；因签名带每轮随机后缀，跨任务不可能逐字相等 ⇒ 落 `own-defect-counted`。三条收口路径（断路器 / 跨任务豁免 / 重试上限）里，前两条依赖运行期不可控状态、第三条依赖驱动进程存活期内的内存计数 —— 都不是确定终态。

### 给人 / manager 的收口菜单（三选一）

1. **先修 develop 的两条红**（搬 6 个新 server 测试文件的 pin + 补 `suite-duration-baseline.tsv` 行；另修标题 ladder 的真实失败），再 `quay retreat <id> --reason …` → `promote` 重派 —— 本分支已完成且零代码 delta，**merge develop 后即可直接 ff 落地**，不需要重做任何实现。
2. 改驱动把签名里的运行期变量（随机后缀 / 毫秒）归一化，让 baseline-red 断路器能真正跳闸。
3. 人裁定 `complete` —— 本任务的交付物（AC-351 记录退役 + GOAL-041 退出条件 + SPEC D-11/§18.6 对齐）已在任务分支上全部完成，并经 6/6 AC 逐条复量 + `fan-in-ac-completion-gate` exit 0。

⛔ 本任务**不**改正 relocated，**不**改判据，**不**改测试造绿。

## Needs-Human（第 5 轮，2026-10-15）

**状态：执行侧不可满足 ⇒ park。分支交付物已完整（6/6 AC 已勾、零代码 delta），阻塞全在 develop 自身。**

**本轮先合并 develop 再复量**：`git merge --no-edit develop`（develop 领先 3 个 task-file-only 提交：`47074ed83` 记录未落地原因、`b1c2d3c95` **外部把 status 从 needs-human 重置回 todo**、`269699291` promotion 晋升 todo→ready）⇒ 无冲突。合并后 `git diff --name-only develop HEAD` 仍只有四份声明文件（SPEC + 两份 goals + 本任务文件）⇒ **零代码 delta 不变**；两条失败文件与 develop 的 blob 仍逐字节相同（`claude-peer-name-follows-ai-title.test.ts` = `03adf1bfee8f1c097b50e38720c46e9f22caf812`，`quay-test-script.test.ts` = `620cbec18f043e4b4aacae04c51b4520e91ef1d4`）。

**单文件亲跑复量（本轮实跑，非引用驱动读数）：两条都 exit 1。**

- Red A `server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` → `AssertionError … (customTitles=["AC171 Title 8552b663","AC171 Later 8552b663"])`，断点 `:1102:12`，`ℹ fail 1`；本轮随机后缀 `8552b663`（历轮 `3e859db7/f928b263/a9009cce/6c57deff/adb1af94/4d097326` 之后又一个不同值）⇒ **确定性失败 + 签名含运行期变量**。
- Red B `server/shared/tests/quay-test-script.test.ts` → AC2 实读 `known=3 unknown=333`（钉 `unknown=327`）、AC3 实读 `known=1 unknown=335`（钉 `unknown=329`）、AC7 地板 `298/336 < 90%`；**失败消息里嵌着每轮都变的临时目录** `source=/tmp/quay-ac2-rC19tn/baseline.tsv`（基线轮是 `/tmp/quay-ac2-CKPoQW/`）⇒ 与 Red A 同类，断路器签名永不逐字相等。

**为什么 exit 不是终态**：`decideBaselineRedCircuitBreaker` 的 `consecutive` 要求签名逐字全等，而本任务两条签名都带运行期变量（随机 hex / `/tmp/…-<rand>/`）⇒ 断路器永不跳闸；`advanceRetryCap` 的进程内计数又被 `b1c2d3c95` 那次外部 `needs-human→todo` 经 `reconcileNeedsHumanWithDisk` 清零 ⇒ 两条保险丝可同时失效，`exit` = 无限重派（`.quay/baseline-red-rounds.jsonl` 本任务已累积 **12** 条：`blocked` 逐轮相同、`signature` 逐轮不同）。

**本轮不做任何实现改动**；**不改判据、不改测试、不碰 `src/**` / `server/**` / `e2e/**`**（修两条红必须编辑 `server/**`，正是本任务 AC5/DoD 明文禁止的面 ⇒ 执行侧不可满足）。

**收口建议（三选一）**：

1. 先修 develop 的两条红（搬 6 个新 server 测试文件的计数钉 + 补 `scripts/suite-duration-baseline.tsv` 行；另修标题 ladder 的真实失败），再 `quay retreat <id> --reason …` → `promote` 重派 —— 本分支零代码 delta，merge develop 后即可直接 ff 落地，不需要重做任何实现；
2. 改驱动把签名里的运行期变量（随机后缀 / 毫秒 / `/tmp/…-<rand>/`）归一化，让 baseline-red 断路器能真正跳闸；
3. 人裁定 `complete` —— 交付物（AC-351 记录退役 + GOAL-041 退出条件 + SPEC D-11/§18.6 对齐）已在任务分支上全部完成，并经 6/6 AC 逐条复量 + `fan-in-ac-completion-gate` exit 0。

## Needs-Human（本轮复量，2026-10-15）

**结论不变：执行侧不可满足 ⇒ 再次 park。本分支零代码 delta，交付物完整（6/6 AC 已勾；本轮 `task_check` = `ok:true 6/6`；anti-drift-touches-check exit 0）。两条红全部在 develop 侧。**

**本轮先 merge develop（3 个 task-file-only 提交）后再复量**：`git diff --name-only develop HEAD -- src server e2e playwright.config.ts` **为空**（零代码 delta）；两条失败文件的 blob 与 develop 逐字节相同（`claude-peer-name-follows-ai-title.test.ts` = `03adf1bfee8f1c097b50e38720c46e9f22caf812`、`quay-test-script.test.ts` = `620cbec18f043e4b4aacae04c51b4520e91ef1d4`）。

**单文件亲跑复量（本轮实跑，非引用历轮读数）**：两条都 exit 1。
- Red A `server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` → `AssertionError [ERR_ASSERTION]: a title offered after adoption must not reach the ladder … (customTitles=["AC171 Title b7e38f93","AC171 Later b7e38f93"])`，断点恒 `:1102:12`，`ℹ fail 1` ⇒ **确定性失败**，且签名含每轮都变的随机后缀（历轮已见 3e859db7/f928b263/a9009cce/6c57deff/adb1af94/4d097326/3c64f0a9/8552b663/… 之后又一个新值 b7e38f93）。
- Red B `server/shared/tests/quay-test-script.test.ts` → AC7 `baseline covers 298/336 collected files (< 90%)`；AC2 实读 `known=3 unknown=333`（钉 327）；AC3 实读 `known=1 unknown=335`（钉 329）；失败消息嵌每轮都变的 `/tmp/quay-ac2-KoruUk/`。

**本轮新增核对（历轮未记）**：两处红当前**无任何在飞承载者**。逐条查证提及 `claude-peer-name-follows-ai-title` / `quay-test-script` 的任务：除本任务外全部 done 或 superseded（`gap-voice-realtime-test-files-restore-quay-test-script-pins` = done、`gap-claude-peer-name-follows-ai-title` = done、`gap-claude-peer-name-follows-ai-title-suite-load-flake` = superseded、`gap-fan-in-suite-load-flake-one-per-run` = done、`gap-claude-peer-name-title-guard` = done）⇒ 修它们**需有人新立任务**，不是「已有任务在修」。

**本轮一条如实登记**：本次 `git merge develop` 由 ort 自动解掉了 task 文件，结果取了 develop 版 —— 6/6 AC 勾与 `status: ready` 保留（ac-precheck 不受影响），但分支上一轮追加在 `## Blocker` 之后的诊断 Notes 块被丢弃。⛔ 未手工改判据、未改测试、未碰 `src/**` / `server/**` / `e2e/**`。

**收口三选一（同前）**：
1. 先修 develop 两条红（搬 6 个新 server 测试文件的计数钉 + 补 `scripts/suite-duration-baseline.tsv` 行；另修标题 ladder 的真实失败），再 `quay retreat <id> --reason …` → `promote` 重派 —— 本分支零代码 delta，merge develop 后即可直接 ff，**不需要重做任何实现**。
2. 改驱动把签名里的运行期变量（随机后缀 / 毫秒 / `/tmp/…-<rand>/`）归一化，让 baseline-red 断路器能真正跳闸。
3. 人裁定 `complete` —— 交付物（AC-351 记录退役 + GOAL-041 退出条件 + SPEC D-11/§18.6 对齐）已在任务分支上全部完成。

⚠️ 历轮事实：本任务已被 park 多次，每次都在分钟级内被外部 `task_write by cli:<pid>` 把 `needs-human`→`todo` 重置并重派，故本次 park 亦不能保证停摆。

## Needs-Human（第 7 轮，2026-10-15）

**结论不变：执行侧不可满足 ⇒ 再次 park。分支交付物完整（`task_check` = ok 6/6；`anti-drift-touches-check` exit 0），零代码 delta。两条红本轮亲跑复现，且本轮新增决定性证据：驱动自己的 develop 基线日志就含这两条红。**

**本轮亲跑单文件复量（非引用历轮读数）**：
- Red A `server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` → exit 1，断点恒 `:1102:12`，判词 `a title offered after adoption must not reach the ladder … (customTitles=["AC171 Title 3cbbd09b","AC171 Later 3cbbd09b"])`（又一个新随机后缀）。
- Red B `server/shared/tests/quay-test-script.test.ts` → exit 1，AC7 `baseline covers 298/336 collected files (< 90%)`；AC2 实读 `known=3 unknown=333`（钉 327）；AC3 实读 `known=1 unknown=335`（钉 329）；失败消息嵌每轮都变的临时目录 `/tmp/quay-ac2-Zhcchj/`。

**本轮新增决定性证据（历轮未记）**：驱动的 **develop 基线日志本身**就把这两条文件判红 —— `.quay/fan-in-suite-gap-ac351-supersede-after-per-utterance-withdraw-retirement~wk-prod-anchor~baseline-1792021427360-a16960.log` 逐字含 `not ok - server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts: … (customTitles=["AC171 Title 88905902", …])` 与 `not ok - server/shared/tests/quay-test-script.test.ts: ✔ a positional test file that does not exist is an error, not a skip (1164.235293ms)`；该基线跑在 `.baseline-red-<task>-wk-prod-anchor/` 检出里，与任务分支无关。⇒ 两条红**是 develop 自身的红**（基线侧即在红），driver 的 `changed-assertion`/HARD RED 判词只是签名取法的假阳性（marker 8 行窗口的「全量日志 vs 单文件日志」版式差 + 断言文本带每轮都变的随机 hex / 毫秒 / `/tmp/<name>-<rand>/`）。

**零代码 delta 硬证明**：`git diff --name-only develop...HEAD -- src server e2e playwright.config.ts` **为空**；两条失败文件的 blob 与 develop 逐字节相同（`claude-peer-name-follows-ai-title.test.ts` = `03adf1bfee8f1c097b50e38720c46e9f22caf812`、`quay-test-script.test.ts` = `620cbec18f043e4b4aacae04c51b4520e91ef1d4`）⇒ 本分支上的任何 suite 红都必然是 develop 自身的红。

**为什么 exit 不是终态**：`decideBaselineRedCircuitBreaker` 的 `consecutive` 逐字要求签名全等，本任务两条签名都带运行期变量 ⇒ 断路器永不跳闸；`advanceRetryCap` 的进程内计数又被外部把 `needs-human` 重置回 `todo` 时经 `reconcileNeedsHumanWithDisk` 清零 ⇒ 两条保险丝可同时失效，纯 `exit` = 无限重派（`.quay/baseline-red-rounds.jsonl` 本任务已累积 ≥24 条：`blocked` 逐轮相同、`signature` 逐轮不同）。

**本轮不做任何实现改动**；**不改判据、不改测试、不碰 `src/**` / `server/**` / `e2e/**`**（修两条红必须编辑 `server/**`，正是本任务 AC5/DoD 明文禁止的面 ⇒ 执行侧不可满足）。

**收口三选一**：
1. 先修 develop 两条红（搬 6 个新 server 测试文件的计数钉 `unknown=327→333` / `329→335`，并把 `scripts/suite-duration-baseline.tsv` 补到 ≥302 行以过 90% 地板；另修标题 ladder 的真实失败），再 `quay retreat <id> --reason …` → `promote` 重派 —— 本分支**零代码 delta**，`merge develop` 后即可直接 ff，**不需要重做任何实现**。
2. 改驱动把签名里的运行期变量（随机后缀 / 毫秒 / `/tmp/<name>-<rand>/`）归一化，让 baseline-red 断路器能真正跳闸。
3. 人裁定 `complete` —— 交付物（AC-351 记录退役 `superseded` + GOAL-041 退出条件 + SPEC §0.3 D-11 / §18.6 阶段表对齐）已在任务分支上全部完成，本轮 6/6 AC 逐条复量 + `anti-drift-touches-check` exit 0。

⚠️ 历轮事实：本任务多次 park 均在分钟级内被外部 `task_write by cli:<pid>` 把 `needs-human`→`todo` 重置并重派，故本次 park 亦不能保证停摆。

## Needs-Human（第 18 轮，2026-10-15）

**结论不变：执行侧不可满足 ⇒ 再次 park。合并树上 `task_check` = ok 6/6；`anti-drift-touches-check` exit 0；`fan-in-ac-completion-gate` 6/6 exit 0。**

**零代码 delta 硬证明（本轮，merge develop 后）**：`git diff --name-only develop HEAD -- src server e2e playwright.config.ts scripts` **为空**；两条失败文件 blob 与 develop 逐字节相同（peer-name = `03adf1bfee8f1c097b50e38720c46e9f22caf812`、quay-test-script = `620cbec18f043e4b4aacae04c51b4520e91ef1d4`）⇒ 本分支上任何 suite 红必然是 develop 自身的红。

**单文件亲跑复量（本轮实跑，各 exit 1）**：
- Red A `server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` → `AssertionError [ERR_ASSERTION]: a title offered after adoption must not reach the ladder … (customTitles=["AC171 Title 3ba48f0c","AC171 Later 3ba48f0c"])`，断点恒 `:1102:12`，`ℹ fail 1` ⇒ 确定性失败，签名带每轮都变的随机后缀。
- Red B `server/shared/tests/quay-test-script.test.ts` → AC7 `baseline covers 298/336 collected files (< 90%)`；AC2 实读 `known=3 unknown=333`（钉 327）；AC3 实读 `known=1 unknown=335`（钉 329）；失败消息嵌每轮都变的 `/tmp/quay-ac2-ME3FBl/` 与 `/tmp/quay-ac3-K6Gnqv/`。

**红仍无在飞承载者**（本轮 task_list 复查）：peer-name 族唯一非 done 者仍是 `superseded` 的 `gap-claude-peer-name-follows-ai-title-suite-load-flake`；计数钉子无人承载 ⇒ 修它们需新立任务。

**为什么 exit 不是终态**：`decideBaselineRedCircuitBreaker` 的 `consecutive` 逐字要求签名全等，本任务两条签名都带运行期变量 ⇒ 断路器永不跳闸；`advanceRetryCap` 的进程内计数又被外部 `task_write by cli:<pid>`（`needs-human→todo`）经 `reconcileNeedsHumanWithDisk` 清零 ⇒ 两条保险丝可同时失效。`.quay/baseline-red-rounds.jsonl` 本任务累计 **19** 条（`blocked` 逐轮相同、`signature` 逐轮不同）。

**收口三选一（同前）**：
1. 先修 develop 两条红（搬 `unknown` 钉 `327→333` / `329→335`，并补 `scripts/suite-duration-baseline.tsv` 到 ≥302 行以过 90% 地板；另修标题 ladder 的真实失败），再 `quay retreat <id> --reason …` → `promote` 重派 —— 本分支**零代码 delta**，`merge develop` 后即可直接 ff，**不需要重做任何实现**。
2. 改驱动把签名里的运行期变量（随机后缀 / 毫秒 / `/tmp/<name>-<rand>/`）归一化，让 baseline-red 断路器能真正跳闸。
3. 人裁定 `complete` —— 交付物（AC-351 记录退役 `superseded` + GOAL-041 退出条件 + SPEC §0.3 D-11 / §18.6 阶段表对齐）已在任务分支上全部完成。

⚠️ 历轮事实：本任务多次 park 均在分钟级内被外部 `task_write by cli:<pid>` 把 `needs-human`→`todo` 重置并重派，故本次 park 亦不能保证停摆。

## Needs-Human（第 19 轮，2026-10-15T00:2xZ）

**结论不变：执行侧不可满足 ⇒ 再次 park。合并树上 `task_check` = ok 6/6；`anti-drift-touches-check` exit 0。分支零代码 delta。**

**本轮先 merge develop 再复量**（develop 期间又添 task-file-only 提交：外部把 `needs-human` 重置回 `todo`、promotion 再晋升 `todo→ready`）⇒ 无冲突；`git diff --name-only develop HEAD -- src server e2e playwright.config.ts scripts` **为空**；两条失败文件 blob 与 develop 逐字节相同（`claude-peer-name-follows-ai-title.test.ts` = `03adf1bfee8f1c097b50e38720c46e9f22caf812`、`quay-test-script.test.ts` = `620cbec18f043e4b4aacae04c51b4520e91ef1d4`）。

**本轮最直接证据——读驱动自己那次 develop 基线跑（写于派发前约 5 分钟，同一 run 前缀）**：`.quay/fan-in-suite-<task>~wk-prod-anchor~baseline-1792023399954-58577f.log` 逐字含 `__PERFILE__ … claude-peer-name-follows-ai-title.test.ts passed=false` 紧随 `not ok - … (customTitles=["AC171 Title e0d23156", …])`，以及 `__PERFILE__ … quay-test-script.test.ts passed=false` 紧随 `not ok - … (1246.688135ms)`。⇒ **两条红在 develop 基线侧即为红**；任务侧的 `changed-assertion`/HARD RED 是签名取法的假阳性（全量日志把 `not ok -` 攒到末尾打印，marker 的 8 行窗口取不到文本；且断言文本带每轮都变的字节）。

**本轮单文件亲跑复量（非引用历轮读数，两条都 exit 1）**：

- Red A `server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` → `AssertionError [ERR_ASSERTION]: a title offered after adoption must not reach the ladder … (customTitles=["AC171 Title e85645c0","AC171 Later e85645c0"])`，断点恒 `:1102:12` ⇒ 确定性失败，签名含每轮都变的随机后缀（历轮已见 3e859db7/f928b263/a9009cce/6c57deff/adb1af94/4d097326/3c64f0a9/8552b663/b7e38f93/3ba48f0c/… 之后又一个新值 `e85645c0`）。
- Red B `server/shared/tests/quay-test-script.test.ts` → AC7 `baseline covers 298/336 collected files (< 90%)`；AC2 实读 `known=3 unknown=333`（钉 `327`）；AC3 实读 `known=1 unknown=335`（钉 `329`）；失败消息嵌每轮都变的 `/tmp/quay-ac2-Hk1YVu/`、`/tmp/quay-ac3-VpHy15/`。

**红仍无在飞承载者**（本轮全 store `grep` 复查）：除本任务外提及这两条文件的非 done 任务，只有 `superseded` 的 `gap-claude-peer-name-follows-ai-title-suite-load-flake` ⇒ 修它们**需新立任务**，不是「已有任务在修」。

**为什么 exit 不是终态**：`decideBaselineRedCircuitBreaker` 的 `consecutive` **逐字全等**才累加，而本任务两条签名都带运行期变量（随机 hex / 毫秒 / `/tmp/<name>-<rand>/`）⇒ 断路器永不跳闸；`advanceRetryCap` 的进程内计数又被外部把 `needs-human` 重置回 `todo` 时经 `reconcileNeedsHumanWithDisk` 清零 ⇒ 两条保险丝可同时失效，纯 `exit` = 无限重派（`.quay/baseline-red-rounds.jsonl` 本任务已累积 ≥28 条：`blocked` 逐轮相同、`signature` 逐轮不同）。

**本轮不做任何实现改动**；**不改判据、不改测试、不碰 `src/**` / `server/**` / `e2e/**`**（修两条红必须编辑 `server/**`，正是本任务 AC5/DoD 明文禁止的面 ⇒ 执行侧不可满足）。

**收口三选一**：

1. 先修 develop 两条红（搬 6 个新 server 测试文件的计数钉 `unknown=327→333` / `329→335`，并把 `scripts/suite-duration-baseline.tsv` 补到 ≥302 行以过 90% 地板；另修标题 ladder 的真实失败），再 `quay retreat <id> --reason …` → `promote` 重派 —— 本分支**零代码 delta**，`merge develop` 后即可直接 ff，**不需要重做任何实现**。
2. 改驱动把签名里的运行期变量（随机后缀 / 毫秒 / `/tmp/<name>-<rand>/`）归一化，让 baseline-red 断路器能真正跳闸。
3. 人裁定 `complete` —— 交付物（AC-351 记录退役 `superseded` + GOAL-041 退出条件 + SPEC §0.3 D-11 / §18.6 阶段表对齐）已在任务分支上全部完成，本轮 6/6 AC 逐条复量 + `anti-drift-touches-check` exit 0。

⚠️ 历轮事实：本任务多次 park 均在分钟级内被外部 `task_write by cli:<pid>` 把 `needs-human`→`todo` 重置并重派，故本次 park 亦不能保证停摆。

## Blocker

**2026-10-15T00:35:14.622Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts:   AssertionError [ERR_ASSERTION]: a title offered after adoption must not reach the ladder, where the adopted custom-title already outranks it (customTitles=["AC171 Title de02d0be","AC171 Later de02d0be"]) [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts,server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts,server/shared/tests/quay-test-script.test.ts]
- run_id：wk-prod-anchor
- session_id：e72173a8-6e75-4232-b958-ece3e9b1e198
