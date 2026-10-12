---
id: gap-ac351-criterion-ledger-red-is-merge-race
title: AC-351 判据台账尾部红是 merge race：实现 6c5378b7（19:14:46+08）只提交在 task 分支，机械 fan-in
  ac1eda4e 于 12:45:57Z 才带进 develop/主检出，末拍红 12:34:53.243Z（约早 664s，树 a77de150 判据文件
  ABSENT）—— verification-only 归因入档（当前检出直跑 exit 0，9/9），不重新实现
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

- [ ] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑三次，`npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 均退出 **0**，`Test Files 1 passed (1)` / `Tests 9 passed (9)` 与九条用例名逐字入档（稳定绿：三跑一致）。红态基线：本轮立案现测 exit 0；台账末拍红 `2026-10-12T12:34:53.243Z` 退出 1，红在存在性闸 `缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`。
- [ ] AC2 承重的 ancestry 证据机械入档：`6c5378b7` = 修复新增提交 `2026-10-12 19:14:46 +0800`；`ac1eda4e` = 机械 fan-in `20:45:57 +0800`（=`12:45:57Z`）；`0e4315a9` = 清未落地原因 `20:46:07 +0800`；`git merge-base --is-ancestor 6c5378b7 5fc2ffb5; echo $?` → **非 0**；`… develop` / `… HEAD` / `… ac1eda4e` → 0；`git cat-file -e a77de150…:src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 与 `… 6e9ee1a4…:…` → 均报 `exists on disk, but not in '…'`（exit 128）；`git rev-parse HEAD:… develop:…` 逐字相等。命令与逐字输出入档；复算 `12:45:57 − 12:34:53.243 = 663.757s`。
- [ ] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-351`、`gate=goal`、`actor=goal-cli` 的判决计数（**28 fail + 0 pass**）与首/尾拍（首 `2026-10-12T07:38:01.930Z`、尾 `2026-10-12T12:34:53.243Z`，含逐字理由 `acceptance failed (exit 1) — 缺判据文件：src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`、`evaluationRoot=/data/home/yale/work/claudecodeui`、`treeSha`）；并抄出 `.quay/goal-round.jsonl` 最新 round（20，`2026-10-12T12:30:48.131Z`）的 AC-351 goal-ring fact；写明「末拍红早于 fan-in 落地约 `664s`」；用 per-tree 判据把红树（ABSENT）与现树（PRESENT）直接对上。
- [ ] AC4 机制去重复核：`grep -rn "^goal_ac: *AC-351" tasks/*.md` 的命中集合与其 `status:` 逐字入档（仅 `gap-live-voice-pending-utterance-withdraw`，done）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-351`）命中的只能是本条自身，须注明；并写明同族先例四条（各为另一条 AC）。
- [ ] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- src server goals scripts` **为空**；`src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx`、`src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts` 的 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空）；`git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `src/**`、`goals/**`）。
- [ ] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-351**（净树三跑 exit 0、9/9）」与「台账 28 拍 fail 尾部由修复 `6c5378b7` 最初只提交在 task 分支、机械 fan-in `ac1eda4e` 于 `12:45:57Z` 才把它带进 develop/主检出、而判据红拍发生在落地之前造成」，并给出残留未钉死假设（末拍红树无对应 ref 提交、归因据逐树存在性；判据语义由原任务覆盖）；⛔ 不得用单元层读数替代判据本体。

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
