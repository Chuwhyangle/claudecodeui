---
id: gap-ac306-criterion-ledger-red-is-merge-race
title: "AC-306 台账尾红是 store 分支落地竞态：判据 `check-prereg.mjs` 由
  `b1a60333`（17:31:47Z）在任务分支引入，直到 fan-in 快进 `dcac1fbc`（17:37:18Z，「merge develop:
  Fast-forward」）才进主检出 `author`；四拍红（17:24:27Z/17:28:15Z/17:31:41Z/17:34:33Z，末拍
  treeSha `49ba7da`=`79715b87` 的树）全测在「判据文件还不存在的树」上（`Cannot find module`）——
  verification-only 归因入档（净树直跑 exit 0 ×3 含并发 + 三种取假形态均红），不重新实现既有交付"
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-306
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。AC-306 `status: active`（GOAL-029 活），其唯一认领任务 `gap-voice-realtime-ambiguity-prereg` 已 `done`（fan-in 快进 `dcac1fbc` 于 17:37:18Z 翻 done）。台账 `gate=goal` 尾部因此按 CURRENTLY FALSE 交办。台账逐字（`.quay/gate-events.jsonl`，`item_id=AC-306`，`gate=goal`）末四拍：

```
2026-10-08T17:24:27.285Z fail treeSha=0b53560521de74dfa7902a94c75f669a327f3026
2026-10-08T17:28:15.332Z fail treeSha=0b53560521de74dfa7902a94c75f669a327f3026
2026-10-08T17:31:41.952Z fail treeSha=4fa508f4cabc873f695978dbc73b81794cddbba2
2026-10-08T17:34:33.195Z fail treeSha=49ba7da51620bfcefcaa7e0d58a91198184c5af1
```

fail 拍逐字理由（四拍同形）：`acceptance failed (exit 1) — node:internal/modules/cjs/loader:1568 throw err; ^ Error: Cannot find module '/data/home/yale/work/claudecodeui/experiments/voice-realtime-ambiguity/check-prereg.mjs' …`，`evaluationRoot=/data/home/yale/work/claudecodeui`。

判据物（逐字取自 `goals/AC-306-…md` 的 `criterion:`）：`node experiments/voice-realtime-ambiguity/check-prereg.mjs`。

**本轮直接现测：判据在主检出上退出 0（工作树满足 AC-306）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`，`git rev-parse HEAD` = `dcac1fbc2f57e2b9ca9a2108aec65cc97a08bc27`）直跑三次退出码全 0（一次单独 + 两次并发），末行逐字 `this script only checks prereg completeness, not answer quality`。判据为纯文件系统读取（读 JSON + 一个 markdown），零网络 / 零模型调用。

**机制：store 分支落地竞态（判据在任务分支先成，主检出 `author` 后快进），不是交付失效。**

- 判据文件 `experiments/voice-realtime-ambiguity/check-prereg.mjs` 由 `b1a60333`（`2026-10-09 01:31:47 +0800` = `17:31:47Z`）引入，**最初只提交在任务分支**（任务 worktree `worktrees/gap-voice-realtime-ambiguity-prereg`）。
- 主检出 `author` 的 HEAD 在 `17:32:18Z` 是 `79715b87`（本任务的 task_write store 提交，其树 `49ba7da` **不含**该判据文件），并一直停在这里，直到 fan-in 快进 `dcac1fbc`（`2026-10-09 01:37:18 +0800` = `17:37:18Z`；reflog 逐字 `merge develop: Fast-forward`）。
- 机械证据：`git merge-base --is-ancestor b1a60333 79715b87` → exit **1**（判据**不在**该树上），`git ls-tree -r --name-only 79715b87 -- …/check-prereg.mjs` → **0** 行；而 `git merge-base --is-ancestor b1a60333 HEAD` → exit **0**，`git ls-tree -r --name-only HEAD -- …/check-prereg.mjs` → **1** 行。
- 末拍红 `17:34:33Z` 的 treeSha `49ba7da` 正是 `79715b87` 的树（`git rev-parse 79715b87^{tree}` = `49ba7da…`）⇒ driver 在主检出 HEAD 仍停在 pre-快进 store 提交时求值，测到「判据文件还不存在的树」。

⇒ **早先的交付没有失效**（`gap-voice-realtime-ambiguity-prereg`，done）；台账 fail 尾部是任务分支交付与 store 分支快进落地之间的竞态。本条**不重新实现**任何交付。

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rl '^goal_ac: *AC-306' tasks/*.md` 命中 **1** 条 `gap-voice-realtime-ambiguity-prereg.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-306`）→ **0 命中** ⇒ 无在飞认领者，本条不是重复。同族先例 `gap-ac178-criterion-ledger-red-is-merge-race`（`goal_ac: AC-178`）与 `gap-ac135-criterion-ledger-red-is-merge-race`（`goal_ac: AC-135`）是**另一条 AC**，仅归因机制族相同（`goal-gate-red-can-race-the-fixs-own-landing`）。

**残留的未钉死假设（如实登记）**：判据成功态只在 stdout 打一行自述（`this script only checks prereg completeness, not answer quality`），**没有内建正控制**；本条用三种取假形态（删一类语料文件 / 清空一类语料 / 去掉一类负对照）在**一次性拷贝**上证明绿非空转，但绿本身的「模式已到达」不来自脚本内建读数的正控制。另：`expect` 的第 3 取假形态（PREREG 提交先于 fixtures 数据文件）留待 Task 3 取数时核对，不在本条范围。

本任务是 **verification-only 归因入档**：不改实现、判据、宿主配置一个字节，也不动任何在飞 WIP。

## Plan

1. 建本条隔离 worktree（起点 = 开工时的 `develop`），打印 worktree 路径与 `git rev-parse HEAD`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据三次：一次单独 + 两次并发（后台并行两进程），逐字抄退出码与 stdout 自述行。
3. 非空转证明：把 `experiments/voice-realtime-ambiguity/` 拷到 worktree 外的临时目录，在**拷贝**上跑三种取假形态（删 `fixtures/homophone.json`；把 `fixtures/coreference.json` 的 `entries` 置空；把 `fixtures/world-model.json` 的 `negativeControls` 置空），逐字抄退出码与「指名缺的类别」行，随后删除拷贝；worktree 本体零改动。
4. 机械复核落地竞态的 ancestry 证据：`git log -1 --format='%H %ci %s' b1a60333 79715b87 dcac1fbc`、`git rev-parse 79715b87^{tree} dcac1fbc^{tree}`、`git merge-base --is-ancestor b1a60333 79715b87; echo $?`、`git merge-base --is-ancestor b1a60333 HEAD; echo $?`、`git ls-tree -r --name-only 79715b87 -- …/check-prereg.mjs | wc -l`、`git ls-tree -r --name-only HEAD -- …/check-prereg.mjs | wc -l`、`git reflog show author --date=iso | head`（`79715b87` 直到 `dcac1fbc` 的 `merge develop: Fast-forward`）。
5. 从 `.quay/gate-events.jsonl` 抄出 AC-306 `gate=goal` 的 fail 尾部（四拍逐字时间戳 + treeSha + 理由）。
6. 交付只落在 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑三次均退出 **0**（一次单独 + 两次并发）；末行逐字 `this script only checks prereg completeness, not answer quality`。红态基线（本轮立案读数）：台账 `17:34:33.195Z` 拍退出 1，红在 `Error: Cannot find module '…/check-prereg.mjs'`。
- [x] AC2 非空转证明：在 worktree 外的一次性**拷贝**上跑三种取假形态，均退出 **1** 且 stderr 指名缺的类别/项：删 `fixtures/homophone.json` → `class "homophone-entity-ambiguity": fixture file not found …`；`fixtures/coreference.json` 的 `entries=[]` → `class "coreference": corpus is EMPTY (0 entries)`（并 `below the frozen minimum (4)`）；`fixtures/world-model.json` 的 `negativeControls=[]` → `class "world-model": MISSING a negative control`。命令与逐字输出入档；拷贝用后即删，worktree 本体 `git status --porcelain` 仍空。
- [x] AC3 承重的 ancestry 证据机械入档：`git log -1 --format='%H %ci %s' b1a60333` → 判据引入 `2026-10-09 01:31:47 +0800`；`… 79715b87` → `2026-10-09 01:32:18 +0800`；`… dcac1fbc` → fan-in `2026-10-09 01:37:18 +0800`；`git merge-base --is-ancestor b1a60333 79715b87; echo $?` → **非 0**（判据**不在**末拍红的求值树上）；`git ls-tree -r --name-only 79715b87 -- …/check-prereg.mjs | wc -l` → **0**；`git merge-base --is-ancestor b1a60333 HEAD; echo $?` → **0** 且 `git ls-tree -r --name-only HEAD -- …/check-prereg.mjs | wc -l` → **1**；`git rev-parse 79715b87^{tree}` = `49ba7da…`（= 末拍红 treeSha）。命令与逐字输出入档。
- [x] AC4 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-306`、`gate=goal` 的 fail 尾部（`17:24:27.285Z` / `17:28:15.332Z` / `17:31:41.952Z` / `17:34:33.195Z` 与各自 treeSha）逐字抄出，并写明「末拍红 `17:34:33Z` 早于 fan-in 快进 `dcac1fbc`（`17:37:18Z`）约 2m45s，且其 treeSha `49ba7da` = `79715b87` 的树、该树不含判据文件」。
- [x] AC5 机制去重复核：`grep -rl '^goal_ac: *AC-306' tasks/*.md` 的命中集合与其 `status:` 逐字入档；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-306`）若命中的是本条自身须注明；并写明同族先例 `gap-ac178-criterion-ledger-red-is-merge-race` / `gap-ac135-criterion-ledger-red-is-merge-race`（各属另一条 AC）。
- [x] AC6 承重面未被本条触碰：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`；`git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `experiments/**`、`goals/**`、`src/**`）。
- [x] AC7 如实登记：完成记录逐字写明「**被提交的树满足 AC-306**」与「台账 fail 尾部由判据 `b1a60333`（`17:31:47Z`）在任务分支引入、主检出 `author` 直到 fan-in 快进 `dcac1fbc`（`17:37:18Z`）才带来该文件造成」，并给出残留未钉死假设（判据无内建正控制；第 3 取假形态留待 Task 3）；⛔ 不得用非判据本体读数替代判据。

## DoD

- 出货命令（`node experiments/voice-realtime-ambiguity/check-prereg.mjs`，逐字不改；⛔ 不改判据、不改 fixtures）在净检出上真的跑过、退出 0 三次（含并发两次），自述行逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- 三种取假形态在拷贝上真的跑过、均退出 1 且指名缺项；命令与逐字输出写进完成记录。
- 落地竞态的每一条 ancestry 读数（判据引入时刻、末拍红求值树提交时刻、fan-in 快进时刻与 reflog、`merge-base --is-ancestor` 退出码、两个树上判据文件命中数、末拍红/快进时刻差）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「交付 `gap-voice-realtime-ambiguity-prereg` 有效；台账 fail 尾部是任务分支交付与 store 分支快进落地之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据脚本、fixtures、PREREG.md、goals 文件、工作树一个字节未动。
- 若净树直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— ⛔ 不得把环境红写成产品绿，也不得据此改判据。

## Touches

- `tasks/gap-ac306-criterion-ledger-red-is-merge-race.md`（自触）
- `experiments/voice-realtime-ambiguity/check-prereg.mjs`（本条只跑不改：判据本体）
- `experiments/voice-realtime-ambiguity/PREREG.md`（只读：`expect` 的主产物）
- `experiments/voice-realtime-ambiguity/fixtures/manifest.json`（只读：判据读取的四类场景清单）
- `goals/AC-306-四类歧义-world-model-场景的语料-标准答案与打分口径在取数前冻结.md`（只读：criterion/expect 逐字来源）

## 完成记录

（本条为 **verification-only 归因入档**：不改实现、判据、宿主配置一个字节，也不动任何在飞 WIP。）

### AC1 — 判据在净检出直跑三次皆 exit 0（一单独 + 两并发）

worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac306-criterion-ledger-red-is-merge-race`
分支：`task/gap-ac306-criterion-ledger-red-is-merge-race`；起点 = 开工时 `develop`；开工 `git rev-parse HEAD` = `95d77ed42c172d19d1fe9b2356d9b0756431f7da`；开工 `git status --porcelain` = 空。
命令（逐字，三跑同一命令）：`node experiments/voice-realtime-ambiguity/check-prereg.mjs`

三跑逐字读数：

- run1（单独）：`exit=0`；stdout 唯一行（末行）`this script only checks prereg completeness, not answer quality`
- run2（与 run3 **并发**）：`exit=0`；stdout 同上；stderr 空
- run3（与 run2 **并发**）：`exit=0`；stdout 同上；stderr 空

红态基线（本轮立案读数）：台账 `2026-10-08T17:34:33.195Z` 拍 `goal-cli` fail（exit 1），逐字理由 `acceptance failed (exit 1) — node:internal/modules/cjs/loader:1568 throw err; ^ Error: Cannot find module '/data/home/yale/work/claudecodeui/experiments/voice-realtime-ambiguity/check-prereg.mjs' …`。

### AC2 — 非空转证明（三种取假形态，跑在 worktree 外的一次性拷贝上，均 exit 1 且指名缺项）

命令：把 `experiments/voice-realtime-ambiguity/` 分别拷到 worktree 外的 `/tmp/ac306-falseforms/form{1,2,3}/`（每形态独立拷贝），各删/置空一处后跑 `node <copy>/check-prereg.mjs`：

- 形态 1（删 `fixtures/homophone.json`）：`exit=1`；stderr 逐字：
  ```
  prereg check FAILED (1 problem):
    - class "homophone-entity-ambiguity": fixture file not found at /tmp/ac306-falseforms/form1/fixtures/homophone.json
  this script only checks prereg completeness, not answer quality
  ```
- 形态 2（`fixtures/coreference.json` 的 `entries=[]`）：`exit=1`；stderr 逐字：
  ```
  prereg check FAILED (2 problems):
    - class "coreference": corpus is EMPTY (0 entries)
    - class "coreference": 0 entries, below the frozen minimum (4)
  this script only checks prereg completeness, not answer quality
  ```
- 形态 3（`fixtures/world-model.json` 的 `negativeControls=[]`）：`exit=1`；stderr 逐字：
  ```
  prereg check FAILED (1 problem):
    - class "world-model": MISSING a negative control
  this script only checks prereg completeness, not answer quality
  ```

拷贝用后即删（`rm -rf /tmp/ac306-falseforms`），worktree 本体 `git status --porcelain` 仍空。

### AC3 — ancestry 证据（逐字）

（在 worktree 上运行；git 历史跨 worktree 共享）

```
$ git log -1 --format='%H %ci %s' b1a60333
b1a6033308229cdf54cf54b0208436d6d2629003 2026-10-09 01:31:47 +0800 feat(voice-realtime-ambiguity): prereg the four ambiguity/world-model scenarios (AC-306)
$ git log -1 --format='%H %ci %s' 79715b87
79715b870b89f3435023b34db05099ecd849a146 2026-10-09 01:32:18 +0800 tasks: gap-voice-realtime-ambiguity-prereg task_write by cli:4144777
$ git log -1 --format='%H %ci %s' dcac1fbc
dcac1fbc2f57e2b9ca9a2108aec65cc97a08bc27 2026-10-09 01:37:18 +0800 tasks: 翻 gap-voice-realtime-ambiguity-prereg done（driver 机械 fan-in）
$ git merge-base --is-ancestor b1a60333 79715b87; echo $?
1
$ git ls-tree -r --name-only 79715b87 -- experiments/voice-realtime-ambiguity/check-prereg.mjs | wc -l
0
$ git merge-base --is-ancestor b1a60333 HEAD; echo $?
0
$ git ls-tree -r --name-only HEAD -- experiments/voice-realtime-ambiguity/check-prereg.mjs | wc -l
1
$ git rev-parse '79715b87^{tree}'
49ba7da51620bfcefcaa7e0d58a91198184c5af1
$ git rev-parse 'dcac1fbc^{tree}'
405abe9f7070a4cbfd9003ae1f2c7c4c9d3a85a4
$ git reflog show author --date=iso | grep -E '79715b87|dcac1fbc'
dcac1fbc author@{2026-10-09 01:37:18 +0800}: merge develop: Fast-forward
79715b87 author@{2026-10-09 01:32:18 +0800}: commit: tasks: gap-voice-realtime-ambiguity-prereg task_write by cli:4144777
```

即：判据文件 `b1a60333`（`2026-10-09 01:31:47 +0800` = `17:31:47Z`）**不在**末拍红的求值树 `79715b87`（`01:32:18 +0800` = `17:32:18Z`）上（`--is-ancestor` 退出 **1**；该树 `ls-tree` 命中 **0**）；它**在** develop/主检出上（`--is-ancestor HEAD` 退出 **0**；`ls-tree` 命中 **1**），首次进入 develop 即 fan-in 快进 `dcac1fbc`（`01:37:18 +0800` = `17:37:18Z`，reflog 逐字 `merge develop: Fast-forward`）。`79715b87^{tree}` = `49ba7da…` = 末拍红 treeSha。

### AC4 — 台账尾巴（逐字）

`.quay/gate-events.jsonl`，`item_id=AC-306`、`gate=goal`（全部 5 拍；fail 尾部四拍 + 其后一拍 pass）：

```
2026-10-08T17:24:27.285Z fail treeSha=0b53560521de74dfa7902a94c75f669a327f3026
2026-10-08T17:28:15.332Z fail treeSha=0b53560521de74dfa7902a94c75f669a327f3026
2026-10-08T17:31:41.952Z fail treeSha=4fa508f4cabc873f695978dbc73b81794cddbba2
2026-10-08T17:34:33.195Z fail treeSha=49ba7da51620bfcefcaa7e0d58a91198184c5af1
2026-10-08T17:43:49.642Z pass treeSha=0dfd4e3791fdc471716b21ad304b7295a55bbc7a  reason=acceptance passed (exit 0)
```

四条 fail 理由同形（逐字）：`acceptance failed (exit 1) — node:internal/modules/cjs/loader:1568 throw err; ^ Error: Cannot find module '/data/home/yale/work/claudecodeui/experiments/voice-realtime-ambiguity/check-prereg.mjs' …`，`evaluationRoot=/data/home/yale/work/claudecodeui`。

末拍红 `17:34:33Z` 早于 fan-in 快进 `dcac1fbc`（`17:37:18Z`）约 **2m45s**；其 treeSha `49ba7da` = `79715b87` 的树（`git rev-parse 79715b87^{tree}` 逐字一致），该树不含判据文件（`ls-tree` 命中 0）。其后 `17:43:49Z` 拍已转 `pass`（goal-driver `I2: criterion pass` 把 `goals/AC-306-…md` 的 `status` 置 `achieved`，`2026-10-08T17:43:49.816Z`），与「快进后判据即绿」一致。

### AC5 — 机制去重复核（逐字）

```
$ grep -rl '^goal_ac: *AC-306' tasks/*.md
tasks/gap-ac306-criterion-ledger-red-is-merge-race.md
tasks/gap-voice-realtime-ambiguity-prereg.md
$ # 各自 status：
tasks/gap-ac306-criterion-ledger-red-is-merge-race.md -> status: ready  （本条自身）
tasks/gap-voice-realtime-ambiguity-prereg.md -> status: done
$ # 在飞扫描（status ∈ {todo,ready,needs-human} 且 goal_ac=AC-306）：
IN-FLIGHT: tasks/gap-ac306-criterion-ledger-red-is-merge-race.md (status=ready)  ← 即本条自身
```

除**本条自身**外无在飞认领者；唯一既有认领者 `gap-voice-realtime-ambiguity-prereg` 已 `done`。同族先例 `gap-ac178-criterion-ledger-red-is-merge-race`（`goal_ac: AC-178`，`status: done`）与 `gap-ac135-criterion-ledger-red-is-merge-race`（`goal_ac: AC-135`，`status: done`）各属**另一条 AC**，仅归因机制族（`goal-gate-red-can-race-the-fixs-own-landing`）相同。

### AC6 — 承重面未被本条触碰

worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac306-criterion-ledger-red-is-merge-race`；合并 `develop` 后工作树 HEAD 的树与 `develop` 逐字相同。

- `git diff --name-only develop..HEAD` → **空**
- `git diff --name-only develop...HEAD` → **空**
- `git diff --name-only develop...HEAD -- experiments goals src` → **空**
- `git status --porcelain` → **空**（与本条开工快照逐字相同）

原因：本条的 ABI `task_write` tick 经 push-through 已落进 `develop`（`git log` 中 `tasks: gap-ac306-criterion-ledger-red-is-merge-race task_write by cli:…` 对 `develop` 是祖先），worktree 合并 `develop` 后 HEAD 与 `develop` 树逐字相同 ⇒ 两点树比较为空。这是 AC6 字面「只含 `tasks/<本条 id>.md`」的**更强形态**（连 task 文件都不在差集里，因为两侧同持 tick）；同族先例 `gap-ac135-criterion-ledger-red-is-merge-race` 的同一判据即记为「空」（`gap-ac178` 的判据字面另注『或为空，若 ABI tick 已 push-through 到 develop』）。⛔ 未 `stash`、未 `git checkout --`、未编辑任何 `experiments/**`、`goals/**`、`src/**`；判据脚本、fixtures、PREREG.md、goals 文件一个字节未动。交付只落 `tasks/<本条 id>.md`。

### AC7 — 如实登记

- **被提交的树满足 AC-306**：净检出（起点 = 开工时 `develop`；`git status --porcelain` 空）上判据 `node experiments/voice-realtime-ambiguity/check-prereg.mjs` 直跑三次（一次单独 + 两次并发）均退出 **0**，末行逐字 `this script only checks prereg completeness, not answer quality`。
- **台账 fail 尾部由落地竞态造成**：判据文件 `experiments/voice-realtime-ambiguity/check-prereg.mjs` 由 `b1a60333`（`2026-10-09 01:31:47 +0800` = `17:31:47Z`）在**任务分支**引入；主检出 `author` 直到 fan-in 快进 `dcac1fbc`（`2026-10-09 01:37:18 +0800` = `17:37:18Z`，reflog 逐字 `merge develop: Fast-forward`）才带来该文件。四条 fail 拍（`17:24:27.285Z` / `17:28:15.332Z` / `17:31:41.952Z` / `17:34:33.195Z`）**全测在「判据文件还不存在的树」上**（`Cannot find module`）；末拍红 `17:34:33Z` 早于快进 `17:37:18Z` 约 **2m45s**，其 treeSha `49ba7da` = `79715b87` 的树，该树不含判据文件。
- **判法**：交付 `gap-voice-realtime-ambiguity-prereg` **有效**；台账 fail 尾部是**任务分支交付与 store 分支快进落地之间的竞态**，不是交付失效。本条**不重新实现**任何交付。
- **残留未钉死假设**（如实登记）：判据成功态只在 stdout 打一行自述，**无内建正控制**；本条用三种取假形态在**一次性拷贝**上证明绿非空转，但绿本身的「模式已到达」不来自脚本内建读数的正控制。另：`goals/AC-306-…md` 的 `expect` 第 3 取假形态（PREREG.md 的提交先于 fixtures 数据文件）留待 Task 3 取数时核对，不在本条范围。⛔ 本条未用任何非判据本体读数替代判据（判法依据 = 判据本体退出码 + stdout 自述行）。