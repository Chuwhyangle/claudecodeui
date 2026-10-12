---
id: gap-ac351-criterion-ledger-red-is-merge-race
title: AC-351 判据台账尾部红是 merge race：实现 6c5378b7（19:14:46+08）只提交在 task 分支，机械 fan-in
  ac1eda4e 于 12:45:57Z 才带进 develop/主检出，末拍红 12:34:53.243Z（约早 664s，树 a77de150 判据文件
  ABSENT）—— verification-only 归因入档（当前检出直跑 exit 0，9/9），不重新实现
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-351
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。GOAL-041 的 AC-351（`goals/AC-351-语音待投递条目逐条撤回-live-voice-中已入-cli-队列未出队的话语行带-ui-撤回按钮-走既有-cancel.md`，`status: active`）被判 CURRENTLY FALSE 交办：`.quay/gate-events.jsonl` 里 `item_id=AC-351`、`gate=goal`、`actor=goal-cli` 共 **28 拍全部 fail**，逐字理由皆为 `acceptance failed (exit 1) — 缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`，`evaluationRoot=/data/home/yale/work/claudecodeui`（主检出）。但认领 AC-351 的唯一任务 `gap-live-voice-pending-utterance-withdraw` 已是 `done`（fan-in `ac1eda4e`）。故本轮先做**直接现测 + ancestry 复核**，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
f=src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f"
```

**本轮直接现测：判据在当前检出上退出 0（工作树满足 AC-351）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`）直跑（`npx vitest run`，`PATH` 含 `node_modules/.bin`），读数逐字：

```
 ✓ src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx (9 tests) 42ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
   Duration  3.55s
EXIT=0
```

九条用例逐字通过：`a delivery with no queue id offers no button, and nothing can call cancelQueued`、`withdraw() on a sentence that already started sends nothing`、`a queued spoken sentence has a withdraw button`、`once the sentence starts, the button is gone`、`a click calls cancelQueued once with the session and the command id — and never aborts`、`the host's cancelled event marks the row withdrawn`、`an already-started verdict is an honest notice, not a button`、`a frame about another session moves nothing`、`a completed command drops the row entirely`。

而台账那 28 拍 fail 的逐字理由只到**存在性闸**：`缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`（判据文件在被测量的那棵树里根本不存在，测试未被执行，非断言失败）。

**机制：merge race（修复落地晚于判据测量），不是修复失效。** 内存 `gap-filing-signal-can-fire-on-a-stale-ac-verdict` 的又一实例（同族先例：`gap-ac245-criterion-ledger-red-is-merge-race`、`gap-ac244-…`、`gap-ac135-…`、`gap-ac178-…`，皆为 done）：

- 修复提交 `6c5378b7`「feat(voice): withdraw a single pending utterance from the Live Voice queue」（`2026-10-12 19:14:46 +0800` = `11:14:46Z`）是判据文件与实现的**新增提交**（`git log --all --diff-filter=A` 显示 `src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 与 `src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts` 两文件均由 `6c5378b7` 新增）。
- 末拍红 `2026-10-12T12:34:53.243Z` 的 `treeSha=a77de1508eb166ecadeb7f752326e0375ae56d4b` 缺该判据文件：`git cat-file -e a77de150…:src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 报 `fatal: path '…' exists on disk, but not in 'a77de150…'`（exit 128）；首拍红树 `6e9ee1a4…` 同（exit 128）。即红拍测的树上根本无此文件。
- `6c5378b7` **不是**首拍红树所属提交 `5fc2ffb5` 的祖先（`git merge-base --is-ancestor 6c5378b7 5fc2ffb5` = exit 1）。
- 机械 fan-in 提交 `ac1eda4e`「tasks: 翻 gap-live-voice-pending-utterance-withdraw done（driver 机械 fan-in）」（`2026-10-12 20:45:57 +0800` = `12:45:57Z`；其后 `0e4315a9` 于 `20:46:07 +0800` 清除未落地原因）才把它带进 develop/主检出：现 `git merge-base --is-ancestor 6c5378b7 develop` = 0、`… HEAD` = 0、`… ac1eda4e` = 0；`git cat-file -e develop:…/voicePendingWithdraw.test.tsx` 命中（PRESENT），`git rev-parse HEAD:… develop:…` 逐字相等（`93919b65f5ba258dd528ca3faaa8c32a7b1cf201`）。
- 即：**末拍红 `12:34:53.243Z` 比修复落进 develop/主检出 `12:45:57Z` 早 `663.757s ≈ 664s`（≈11.06 min）**。此后尚无新的一拍 goal 评估（`.quay/goal-round.jsonl` 最新 record 为 round 20 @ `2026-10-12T12:30:48.131Z`，其 AC-351 fact 仍读 fail —— 那是**上一拍 gate-event 判决的延续**，中间无新 gate-event，非修复未生效）。

⇒ **早先的修复是兜住的**（`gap-live-voice-pending-utterance-withdraw`，done；净树判据 exit 0、9/9）。本条**不重新实现**任何修复。

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rn "^goal_ac: *AC-351" tasks/*.md` 命中**仅 1 条** —— `tasks/gap-live-voice-pending-utterance-withdraw.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-351`）**0 命中** ⇒ 无在飞认领者，本条不是重复。同族先例 `gap-ac245-criterion-ledger-red-is-merge-race`（`goal_ac: AC-245`，done）、`gap-ac244-…`、`gap-ac135-…`、`gap-ac178-…` 各为**另一条 AC**，仅归因机制相同（merge race）。

**残留未钉死假设（如实登记）**：
1. 末拍红树 `a77de150` 不对应 `git log --all` 可达的任何提交（`git log --all --format='%H %T' | grep a77de150` 无命中）——它是主检出在 fan-in 前的**工作树 / 未纳入 ref 的树**；首拍红树 `6e9ee1a4` 对应提交 `5fc2ffb5`（`15:36:08 +0800`）。红因判定按 `git cat-file -e <treeSha>:<file>` 的逐树存在性（两树皆 128/ABSENT）成立，不依赖该树能否被 ref 命名。
2. 本条只按存在性闸 + 现测绿归因；判据的期望语义（UI 撤回按钮、`cancelQueued(sessionId, queuedMessageUuid)`、语音工具面、不 abort）由其原任务 `gap-live-voice-pending-utterance-withdraw` 的判据覆盖，本条不复述、不另立断言、不改判据。

本任务是 **verification-only 归因入档**：不改实现、判据、goals、宿主配置一个字节，也不动任何在飞 WIP。

## Plan

1. 建本条隔离 worktree（起点 = 开工时的 `develop`），打印 worktree 路径与 `git rev-parse HEAD`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据**三次**（产物命令逐字不改），逐字抄读数与三次退出码；九条用例名逐字入档（稳定绿：三跑读数一致）。
3. 机械复核 merge race 的 ancestry 证据：`git log -1 --format='%H %ci %s'` 取 `6c5378b7` / `b4f18100` / `ac1eda4e` / `0e4315a9`；`git merge-base --is-ancestor 6c5378b7 <ref>; echo $?` 对 `5fc2ffb5` / `develop` / `HEAD` / `ac1eda4e`；`git cat-file -e <redTreeSha>:src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`（`a77de150…`、`6e9ee1a4…`）；`git rev-parse HEAD:… develop:…`；复算「末拍红 `12:34:53.243Z` < fan-in 落地 `12:45:57Z`」= `663.757s`。
4. 从 `.quay/gate-events.jsonl` 抄出 AC-351 `gate=goal` 的 28 拍判决（首/尾含逐字理由、`evaluationRoot`、`treeSha`）；从 `.quay/goal-round.jsonl` 抄出最新 round（20，`12:30:48.131Z`）的 AC-351 goal-ring fact；用 per-tree 机械判据把红树（ABSENT）与现树（PRESENT）直接对上。
5. 交付只落 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑三次，`npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 均退出 **0**，`Test Files 1 passed (1)` / `Tests 9 passed (9)` 与九条用例名逐字入档（稳定绿：三跑一致）。红态基线：本轮立案现测 exit 0；台账末拍红 `2026-10-12T12:34:53.243Z` 退出 1，红在存在性闸 `缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`。
- [x] AC2 承重的 ancestry 证据机械入档：`6c5378b7` = 修复新增提交 `2026-10-12 19:14:46 +0800`；`ac1eda4e` = 机械 fan-in `20:45:57 +0800`（=`12:45:57Z`）；`0e4315a9` = 清未落地原因 `20:46:07 +0800`；`git merge-base --is-ancestor 6c5378b7 5fc2ffb5; echo $?` → **非 0**；`… develop` / `… HEAD` / `… ac1eda4e` → 0；`git cat-file -e a77de150…:src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 与 `… 6e9ee1a4…:…` → 均报 `exists on disk, but not in '…'`（exit 128）；`git rev-parse HEAD:… develop:…` 逐字相等。命令与逐字输出入档；复算 `12:45:57 − 12:34:53.243 = 663.757s`。
- [x] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-351`、`gate=goal`、`actor=goal-cli` 的判决计数（**28 fail + 0 pass**）与首/尾拍（首 `2026-10-12T07:38:01.930Z`、尾 `2026-10-12T12:34:53.243Z`，含逐字理由 `acceptance failed (exit 1) — 缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`、`evaluationRoot=/data/home/yale/work/claudecodeui`、`treeSha`）；并抄出 `.quay/goal-round.jsonl` 最新 round（20，`2026-10-12T12:30:48.131Z`）的 AC-351 goal-ring fact；写明「末拍红早于 fan-in 落地约 `664s`」；用 per-tree 判据把红树（ABSENT）与现树（PRESENT）直接对上。
- [x] AC4 机制去重复核：`grep -rn "^goal_ac: *AC-351" tasks/*.md` 的命中集合与其 `status:` 逐字入档（仅 `gap-live-voice-pending-utterance-withdraw`，done）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-351`）命中的只能是本条自身，须注明；并写明同族先例四条（各为另一条 AC）。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- src server goals scripts` **为空**；`src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`、`src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts` 的 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空）；`git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `src/**`、`goals/**`）。
- [x] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-351**（净树三跑 exit 0、9/9）」与「台账 28 拍 fail 尾部由修复 `6c5378b7` 最初只提交在 task 分支、机械 fan-in `ac1eda4e` 于 `12:45:57Z` 才把它带进 develop/主检出、而判据红拍发生在落地之前造成」，并给出残留未钉死假设（末拍红树无对应 ref 提交、归因据逐树存在性；判据语义由原任务覆盖）；⛔ 不得用单元层读数替代判据本体。

## DoD

- 出货命令（`f=src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f"`，逐字不改；⛔ 不改断言、不改判据）在净检出上真的跑过、退出 0，`1 passed (1)` / `9 passed (9)` 与九条用例名逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（修复新增提交时刻、fan-in 时刻、清未落地原因时刻、首/末红树 SHA 及其判据文件存在性、`merge-base --is-ancestor` 退出码、`git rev-parse HEAD:… develop:…`、红拍/落地时刻差 `663.757s`）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `6c5378b7` 有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据、实现、goals 文件、工作树一个字节未动。
- 若净树直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— ⛔ 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- tasks/gap-ac351-criterion-ledger-red-is-merge-race.md（自触）
- src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx（本条只跑不改：判据本体）
- src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts（本条只读不改：撤回 hook 实现）
- src/modules/chat/voice-realtime/VoicePendingUtterance.tsx（本条只读不改：撤回行渲染）
- goals/AC-351-语音待投递条目逐条撤回-live-voice-中已入-cli-队列未出队的话语行带-ui-撤回按钮-走既有-cancel.md（本条只读不改：criterion/expect 逐字来源）

## 完成记录（verification-only 归因入档；本轮 worker，2026-10-12）

**判法（逐字）**：修复 `6c5378b7` 有效；台账 28 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态。**被提交的树满足 AC-351**（净树三跑 exit 0、9/9）。本条未改实现、判据、goals、宿主配置一个字节，未动任何在飞 WIP。

### AC1 净检出直跑三次 —— 判据绿

- worktree 路径：`/data/home/yale/work/claudecodeui-worktrees/gap-ac351-criterion-ledger-red-is-merge-race`
- worktree `git rev-parse HEAD` = `94d7fef61c89f6f2ff569e28829bacca027a1c53`（= 开工时 `develop`；主检出 `author` 同此 SHA）
- worktree `git branch --show-current` = `task/gap-ac351-criterion-ledger-red-is-merge-race`
- worktree `git status --porcelain` = 空（0 行，与开工快照逐字相同）
- worktree 起点 = `develop`（`dispatch-worktree-setup.sh` 自检 `fork-point PASS — HEAD contains develop (94d7fef61c89f6f2ff569e28829bacca027a1c53)`），node_modules 已 `<main>/node_modules` 符号链接

出货命令（逐字，cwd = worktree）：

```
f=src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f"
```

三次读数（`Test Files 1 passed (1)` / `Tests 9 passed (9)` 三跑一致；退出码 `RUN1 EXIT=0`、`RUN2 EXIT=0`、`RUN3 EXIT=0`）：

```
RUN1:  ✓ src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx (9 tests) 46ms
       Test Files  1 passed (1)      Tests  9 passed (9)      Duration  3.89s   EXIT=0
RUN2:  ✓ src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx (9 tests) 50ms
       Test Files  1 passed (1)      Tests  9 passed (9)      Duration  3.56s   EXIT=0
RUN3:  ✓ src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx (9 tests) 44ms
       Test Files  1 passed (1)      Tests  9 passed (9)      Duration  3.37s   EXIT=0
```

（各跑 stderr 有 jsdom 对 `HTMLCanvasElement.prototype.getContext` 的 `Not implemented` 行，来自 `@xterm` 传递导入，非判据失败；三跑均 exit 0。）

九条用例名（逐字，均 `✓` 通过；`--reporter=verbose`）：

1. `the withdraw path calls cancelQueued only where it must (false forms) > a delivery with no queue id offers no button, and nothing can call cancelQueued`
2. `the withdraw path calls cancelQueued only where it must (false forms) > withdraw() on a sentence that already started sends nothing`
3. `a queued sentence is offered back; a started one is not > a queued spoken sentence has a withdraw button`
4. `a queued sentence is offered back; a started one is not > once the sentence starts, the button is gone`
5. `withdrawing one sentence > a click calls cancelQueued once with the session and the command id — and never aborts`
6. `withdrawing one sentence > the host's cancelled event marks the row withdrawn`
7. `withdrawing one sentence > an already-started verdict is an honest notice, not a button`
8. `withdrawing one sentence > a frame about another session moves nothing`
9. `withdrawing one sentence > a completed command drops the row entirely`

**红态基线（对照，取自台账，本轮未复现）**：主检出 `2026-10-12T12:34:53.243Z` 那拍退出 1，红在**存在性闸** `缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` —— 判据文件在**被测量的那棵树**里根本不存在，测试未被执行（非断言失败）。

### AC2 ancestry 证据（机械复核，命令与逐字输出）

```
$ git log -1 --format='%H %ci %s' 6c5378b7
6c5378b757f3ff3c23c6caa3b41d8bdd45c47bca 2026-10-12 19:14:46 +0800 feat(voice): withdraw a single pending utterance from the Live Voice queue
$ git log -1 --format='%H %ci %s' b4f18100
b4f1810056be8bcfbafa51aa794d38ebb91c21f0 2026-10-12 20:43:02 +0800 Merge branch 'develop' into task/gap-live-voice-pending-utterance-withdraw
$ git log -1 --format='%H %ci %s' ac1eda4e
ac1eda4e64ee9fc3ffccbae2ec5ce99c8a060073 2026-10-12 20:45:57 +0800 tasks: 翻 gap-live-voice-pending-utterance-withdraw done（driver 机械 fan-in）
$ git log -1 --format='%H %ci %s' 0e4315a9
0e4315a9ec953bf1f2bda5ed4ed3de37d686997c 2026-10-12 20:46:07 +0800 tasks: gap-live-voice-pending-utterance-withdraw 清除未落地原因（已落地）
$ git log -1 --format='%H %ci %s' 5fc2ffb5
5fc2ffb584a9e8ed568070c040d9ea07c86c86cd 2026-10-12 15:36:08 +0800 tasks: gap-ac317-criterion-killed-by-its-own-budget task_write by cli:603252

$ git merge-base --is-ancestor 6c5378b7 5fc2ffb5; echo $?
1
$ git merge-base --is-ancestor 6c5378b7 develop; echo $?
0
$ git merge-base --is-ancestor 6c5378b7 HEAD; echo $?
0
$ git merge-base --is-ancestor 6c5378b7 ac1eda4e; echo $?
0

$ git cat-file -e a77de1508eb166ecadeb7f752326e0375ae56d4b:src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx; echo $?
fatal: path 'src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx' exists on disk, but not in 'a77de1508eb166ecadeb7f752326e0375ae56d4b'
128
$ git cat-file -e 6e9ee1a4:src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx; echo $?
fatal: path 'src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx' exists on disk, but not in '6e9ee1a4'
128

$ git rev-parse HEAD:src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx develop:src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx
93919b65f5ba258dd528ca3faaa8c32a7b1cf201
93919b65f5ba258dd528ca3faaa8c32a7b1cf201
```

读法：`6c5378b7` 在**被测量树 `5fc2ffb5` / `a77de150` 里不是祖先**（exit 1；判据文件 `exists on disk, but not in …`，exit 128），而它**已是 `develop` / `HEAD` / `ac1eda4e` 的祖先**（exit 0），`HEAD:…` 与 `develop:…` blob 逐字相等（`93919b65…`）。

**时刻换算**：`6c5378b7` = `11:14:46Z`；`b4f18100` = `12:43:02Z`；`ac1eda4e` = `12:45:57Z`；`0e4315a9` = `12:46:07Z`；`5fc2ffb5` = `07:36:08Z`。→ **末拍红 `12:34:53.243Z` 比修复落进 develop/主检出 `12:45:57Z` 早 `663.757s ≈ 664s`（≈11.06 min）。**

### AC3 台账尾巴 + 竞态闭合

`.quay/gate-events.jsonl` 里 `item_id=AC-351`、`gate=goal`、`actor=goal-cli` 的判决计数：**28 fail + 0 pass**（共 28 拍；`evaluationRoot` 逐字恒为 `/data/home/yale/work/claudecodeui`；首拍 `2026-10-12T07:38:01.930Z`、尾拍 `2026-10-12T12:34:53.243Z`）。28 拍理由逐字一致：`acceptance failed (exit 1) — 缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`。

首拍（逐字，整条）：

```json
{"id":"ac80e376-857c-4cf2-b019-6dadec556829","item_id":"AC-351","pipeline_id":"AC-351","gate":"goal","actor":"goal-cli","verdict":"fail","timestamp":"2026-10-12T07:38:01.930Z","payload":{"reason":"acceptance failed (exit 1) — 缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx","evaluationRoot":"/data/home/yale/work/claudecodeui","treeSha":"6e9ee1a49073d91647b2f8a90a49e71f7f267edd"}}
```

尾拍（逐字，整条）：

```json
{"id":"de746844-3e24-428d-9811-307655e8e228","item_id":"AC-351","pipeline_id":"AC-351","gate":"goal","actor":"goal-cli","verdict":"fail","timestamp":"2026-10-12T12:34:53.243Z","payload":{"reason":"acceptance failed (exit 1) — 缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx","evaluationRoot":"/data/home/yale/work/claudecodeui","treeSha":"a77de1508eb166ecadeb7f752326e0375ae56d4b"}}
```

`.quay/goal-round.jsonl` 最新 round（20，`2026-10-12T12:30:48.131Z`）的 AC-351 goal-ring fact（逐字）：

```json
{"id":"AC-351","goal":"GOAL-041","status":"active","verdict":"fail","reason":"acceptance failed (exit 1) — 缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx"}
```

（本轮另测：`goal-round.jsonl` 已出现**更新**一拍 round 21 @ `2026-10-12T12:50:54.406Z`，其 AC-351 goal-ring fact **仍逐字读 fail** —— 因该环形 fact 是**上一拍 gate-event 判决的延续**，其间无新 gate-event；round 21 的墙钟虽晚于 fan-in 落地（`12:45:57Z`），但仍未重测判据。此为台账 carry-over，非修复未生效。仍 `28 fail + 0 pass` 即其证。）

**per-tree 机械判据（决定性）**：把被测量树与判据文件的存在性直接对上 ——

```
6e9ee1a49073d91647b2f8a90a49e71f7f267edd -> ABSENT   (07:38:01.930Z 首拍红, exit 128; = 5fc2ffb5^{tree})
a77de1508eb166ecadeb7f752326e0375ae56d4b -> ABSENT   (12:34:53.243Z 尾拍红, exit 128; = 66024b2d^{tree})
HEAD:… / develop:…  blob 93919b65f5ba258dd528ca3faaa8c32a7b1cf201 -> PRESENT (现树, exit 0)
```

即：**同一判据、同一命令，只在「修复已落地」的树上才存在判据文件** —— 红/绿的唯一自变量是**被测量树含不含修复**。

**「最后一拍红（`12:34:53.243Z`）早于 fan-in 落地（`12:45:57Z`）约 664s（`663.757s`）」** —— 成立。

### AC4 机制去重复核

```
$ grep -rn "^goal_ac: *AC-351" tasks/*.md
tasks/gap-ac351-criterion-ledger-red-is-merge-race.md:13:goal_ac: AC-351
tasks/gap-live-voice-pending-utterance-withdraw.md:14:goal_ac: AC-351
--- statuses ---
tasks/gap-ac351-criterion-ledger-red-is-merge-race.md -> status: ready
tasks/gap-live-voice-pending-utterance-withdraw.md   -> status: done
```

- 认领 AC-351 的唯一既有任务 `gap-live-voice-pending-utterance-withdraw` = `status: done`（fan-in `ac1eda4e`）。
- 在飞扫描（`status` ∈ todo/ready/needs-human 且 `goal_ac: AC-351`）**唯一命中是本条自身**（`gap-ac351-criterion-ledger-red-is-merge-race`，`ready`）⇒ 无第二条在飞认领者，本条不是重复。
- 同族先例（各为**另一条 AC**，非本 AC 重复）：`gap-ac245-criterion-ledger-red-is-merge-race`（`goal_ac: AC-245`，done）、`gap-ac244-…`（`AC-244`，done）、`gap-ac135-…`（`AC-135`，done）、`gap-ac178-…`（`AC-178`，done）。仅归因机制相同（merge race）。

### AC5 承重面未被本条触碰

```
$ git diff --name-only develop...HEAD -- src server goals scripts
(空，0 行)

$ git diff --stat develop -- src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx
(空)
$ git diff --stat develop -- src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts
(空)
$ git rev-parse HEAD:…/voicePendingWithdraw.test.tsx develop:…/voicePendingWithdraw.test.tsx
93919b65f5ba258dd528ca3faaa8c32a7b1cf201
93919b65f5ba258dd528ca3faaa8c32a7b1cf201
$ git rev-parse HEAD:…/useVoicePendingWithdraw.ts develop:…/useVoicePendingWithdraw.ts
b5d6c785b44fc927ba1985c6e225e1ab2b8094f2
b5d6c785b44fc927ba1985c6e225e1ab2b8094f2

$ git status --porcelain
(空，0 行 —— 与开工快照逐字相同)
$ git diff --name-only develop...HEAD
(空，0 行)
```

未 `stash`、未 `git checkout --`、未编辑任何 `src/**`、`goals/**`；本 worktree 的唯一提交是 `tasks/<本条 id>.md`（`task_write` 自提交）。

### AC6 残留未钉死假设（如实登记）

1. **末拍红树 `a77de150` 现可由 ref 命名 → 对应主检出提交 `66024b2d`**：`git log --all --format='%H %T %ci %s' | grep a77de150` 命中 `66024b2d15ee88c993c44e99229b454bd838f704 2026-10-12 20:34:37 +0800 tasks: gap-live-voice-scripted-upstream-protocol-state-machine todo→ready（promotion-driver 机械晋升）`（=`12:34:37Z`，develop/author 可达）。该树判据文件 ABSENT（exit 128）。红因判定按 `git cat-file -e <treeSha>:<file>` 的逐树存在性成立，**不依赖**该树能否被 ref 命名。（提案里「`a77de150` 无对应 ref 提交」的假设本轮实测已细化：它正是主检出在 red 拍那一刻的 promotion-driver task-bump 提交 `66024b2d` 之树——与「红拍测的是一棵尚未含修复的树」一致。）首拍红树 `6e9ee1a4` = `5fc2ffb5^{tree}`（`15:36:08 +0800`）。
2. 本条只按存在性闸 + 现测绿归因；判据的期望语义（UI 撤回按钮、`cancelQueued(sessionId, queuedMessageUuid)`、语音工具面、不 abort）由其原任务 `gap-live-voice-pending-utterance-withdraw` 的判据覆盖，本条不复述、不另立断言、不改判据。

**⛔ 未使用单元层读数替代判据本体**：AC1 的 9/9 是判据本体（`npx vitest run <判据文件>`）在净检出上的真实执行读数；AC2 / AC3 是 git ancestry 与台账逐字记录，非复述 AC 文字。
