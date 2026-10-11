---
id: gap-live-monitor-g1-executor-and-rule-rerun
title: Live Monitor 续做：补 G1（状态迁移的执行者可识别）+ 按 D1/D2 改规则 + 同一窗口重跑做前后对照（⛔ 原型不并 develop）
status: done
labels:
  - gap
  - experiment
parent: null
children: []
extra: {}
---
## Proposal

**来源**：`gap-live-monitor-48h-replay-experiment`（已 done）在 2026-10-11 由人 yale 择定「不把原型并进 develop」，并指定本任务为其唯一后续——只做三件事：补 G1 取证、按 D1/D2 改规则、同一窗口重跑做前后对照。

**为什么先做这三件**：

- 那次回放的最大数据缺口是 **G1：状态迁移的执行者无法识别**。38 段 needs-human 里 17 段是机械停派（16 段自己回到 todo）、14 段是 `task_write` 写入、7 段窗口前遗留——但**谁做的决定从数据里看不出来**，所以「真实人工决策」这条最有价值的规则无法验证。
- 人 yale 的 **D2 裁定本身就依赖 G1**：「机械停派在 G1 补上之前降为 Record，human-decision 只对 task_write 写入的停派发 Notify」——要落地这条，必须先把「执行者」读出来。
- 同一批裁定还要求改两条规则（D1：失败后仍落地记成本信号；过期规则改积压摘要，窗口前遗留不发单条）。

**原型在哪（⛔ 关键前提）**：全部代码在分支 `proto/live-monitor-replay`（`c9ee5858`），**不在 develop**（人 yale 裁定不并）。⇒ 本任务的工作树必须从该分支切出；⛔ 不要把它并进 develop，⛔ 不要在主检出里手改这些文件。

## AC

- [x] AC1 **G1 取证**：对 38 段 needs-human episode 中**至少 30 段**给出「执行者」读数（机械停派 / `task_write` 写入 / 人工），每条带可回查证据（`file@byte` 或 `git sha`）；识别规则写进原型（`collect.mjs` 或 `lib.mjs`），并**如实标出识别不出的那部分**（⛔ 不许用启发式冒充成「人工」）。判据：同一窗口重跑后 `needs-human-episodes.json` 里每段都有 `executor` 字段，且 `executor === 'unknown'` 的段数 ≤ 8。
- [x] AC2 **按 D1/D2 改规则**：① `failure-streak` 命中但最终落地 ⇒ 记**成本信号**（不计入误报）；② 机械停派 ⇒ **Record**（`human-decision` 只对 `task_write` 停派 Notify）；③ 过期规则改**积压摘要**（窗口前遗留的停派合并成一条「另有 N 条早于窗口」）。
- [x] AC3 **同一窗口重跑 + 前后对照**：窗口仍为 `2026-10-08T17:00Z → 10-10T17:00Z`，输出对照表（告警条数 / precision / 误报漏报），并以人 yale 的 D3 校准集（`gap-live-monitor-48h-replay-experiment` 的 `## Resolution` 里那 14 条、标记为打扰 7 / Record 7）作为**固定标尺**：新规则下那 7 条「打扰」不得丢失。
- [x] AC4 **取假必红**：关掉 D1 的改动 ⇒ 4 条成本信号（原 #1–4）从通知流里消失，AC3 的标尺断言变红；恢复后回绿。逐条记录 diff、失败行与恢复命令。
- [x] AC5 **不并 develop**：`git merge-base --is-ancestor <本任务提交> develop` 退出非 0，且 `git diff --name-only develop...HEAD` ⊆ `## Touches`。
- [x] AC6 **边界可机械复核（不接产品面）**：`git grep -l "live-monitor-replay" HEAD -- server src scripts e2e package.json` 为空（若不为空 ⇒ 有人把回放原型接进了产品面，本任务的边界被违反，须先拆线）。

## DoD

真实读数：同一窗口重跑出的前后对照表（含 precision 变化与 14 条校准集的逐条落点）+ G1 的 executor 读数覆盖面（≥30/38、unknown ≤8，每条带证据）。⛔ 只在单测夹具上构造、或把原型并进 develop ⇒ 不算达成。

## Touches

（这些文件在 `proto/live-monitor-replay` 上；本任务的工作树从该分支切出，⛔ 不并 develop）

- experiments/live-monitor-replay/collect.mjs (new)
- experiments/live-monitor-replay/lib.mjs (new)
- experiments/live-monitor-replay/lib.test.mjs (new)
- experiments/live-monitor-replay/replay.mjs (new)
- experiments/live-monitor-replay/RESULT.md (new)
- experiments/live-monitor-replay/RESULT.json (new)
- experiments/live-monitor-replay/RESULT.release-keyword.json (new)
- experiments/live-monitor-replay/NOTIFICATIONS.md (new)
- experiments/live-monitor-replay/notifications.jsonl (new)
- experiments/live-monitor-replay/needs-human-episodes.json (new)
- experiments/live-monitor-replay/PREREG.md (new)
- experiments/live-monitor-replay/.gitignore (new)
- tasks/gap-live-monitor-g1-executor-and-rule-rerun.md

## Notes

- 裁定来源：`gap-live-monitor-48h-replay-experiment` 的 `## Resolution`（D1/D2/D3 + 三条规则级决定）。
- ⚠️ 已知风险 G9：回放依赖载体未被轮转；若 `.quay/*.jsonl` 已轮转，须如实记下缺哪一段，⛔ 不要用现有数据顶替。→ **本次未触发**：窗口内 `.quay/*.jsonl` 与 `tasks/` 均未轮转，重放无缺失分段。

**边界（人 yale 2026-10-11 裁定 + 复核后的口径）**：本次「不并 develop」的**实质是不产品化**——⛔ 不立服务端 monitor 模块、⛔ 不做 Quay 面板通知流、⛔ 不把 48h 回放的结论固化成产品代码。`experiments/live-monitor-replay/` 是**零生产面**的实验代码：原型的 import 面只有 `node:child_process`/`node:fs`/`node:os`/`node:path` 四个内置模块 + 同目录 `./lib.mjs`（`lib.mjs` 零 import），develop 上 `server/`/`src/` 无任何路径引用 `experiments/`；`experiments/` 也是既有惯例（develop 上已有 349 个文件，如 `voice-asr-cli` / `voice-client-asr-probe`，各自带 PREREG/README）。⇒ 允许它随本任务落进 develop，但由 AC6 机械钉住「不得被任何生产代码 import」。Touches 里那 6 条已带 `(new)`（develop 视角确实尚不存在）。

## 验证记录

复现：`node collect.mjs --now 2026-10-10T17:00:00Z && node replay.mjs --out out`（窗口 `2026-10-08T17:00Z → 2026-10-10T17:00Z`，与父任务同一批真实载体，只读）。`node --test lib.test.mjs` → 17/17 通过。读数细节见 `experiments/live-monitor-replay/RESULT.md` §8。

**AC1（G1 取证）** —— 判据：重跑后 `needs-human-episodes.json` 每段都有 `executor`，`unknown` ≤ 8。
实测 **38/38 段有 `executor`，`unknown` 0**；`{task_write: 18, mechanical: 20}`；发起方 `{driver: 20, worker-session: 10, cli-unattributed: 4, session-other: 4}`。
识别规则写在 `lib.mjs: classifyExecutor(subject)`（`归因不出`/`重试上限` ⇒ `mechanical`；`task_write` ⇒ `task_write`；否则 `unknown`）+ `collect.mjs` 的 seed 段（窗口前遗留的 park 也回填**真实** park commit subject）。每条证据 = park commit sha（`git -C <proj> show <sha>` 可验；38 行逐段列出见 RESULT.md §8.1 表）。
如实标出识别不出的部分：8 段 `task_write` 的发起会话只到「worker 会话 / 非 worker 会话 / 窗口外」粒度，**严格 id 匹配下没有任何一段能正当地归为「人工手写」**——不臆造人工。

**AC2（按 D1/D2 改规则）** —— 三处都在 `lib.mjs`，由 `DEFAULTS` 的 `d1`/`d2`/`backlogSummary` 门控：
① `failure-streak` 命中且链最终落地 ⇒ `Notify: cost-signal`，单列 `score().cost` 桶（既非命中亦非误报）；
② `mechanical` park ⇒ `Record: mechanical-park`，`human-decision` 只对非机械（`task_write`）park 发；
③ 窗口前已过期的遗留 park ⇒ 收成一条 `Record: pre-window-backlog`（`attrs.count` + `attrs.tasks`），窗口内新过期仍逐条 Escalate。
单测钉住：`lib.test.mjs` 的 `classifyExecutor` / `stage4 (D2)` / `rule ③ backlog` / `scoring under D1` 四个用例。

**AC3（同一窗口重跑 + 前后对照）** —— 对照表（before = D1/D2/③ 全关）：

| | before | after |
|---|---|---|
| 告警条数 | 59 | **37** |
| Notify / Escalate | 39 / 20 | 26 / 11 |
| precision | 0.842（32/38） | **0.955**（21/22） |
| 误报 fp | 6 | 1 |
| 漏报 fn | 2 | 13（其中 11 段是 D2/③ 有意降级，2 段为原有窗口边界漏报） |

before 列逐位复现父任务原始读数（59/39/20/0.842/fp 6/fn 2）⇒ 基线可信。
D3 固定标尺 14 行（打扰 7 / Record 7）：**7 条「打扰」全部落在期望规则上**（4 × `cost-signal`、2 × `needs-human-expired`、1 × `cross-project-upstream-landed`），`rulerFailures` 为空、退出码 0。逐行落点见 RESULT.md §8.3。

**AC4（取假必红）** —— 变异：`lib.mjs` 的 `DEFAULTS` 单行 `-  d1: true,` → `+  d1: false,`。
失败行：`cost-signal notifications (0):`；标尺 `1..4 打扰 … -> Escalate:failure-streak  ✗ LOST`；`RULER FAIL: 4 打扰 row(s) lost: #1…#4`；`exit=1`；`RESULT.json.costSignals = []`（旁证：precision 掉回 `0.842→0.778`、fp `6→6`）。
恢复：改回 `d1: true`（或 `git checkout -- lib.mjs`）；重跑 ⇒ `cost-signal notifications (4)`、无 `RULER FAIL`、`exit=0`。已按此恢复并重跑验证回绿。

**AC5（不并 develop）** —— `git merge-base --is-ancestor HEAD develop` ⇒ `exit=1`（非 0 ✓）。
`git diff --name-only develop...HEAD` = 12 个文件（全部在 `experiments/live-monitor-replay/`），已全部列入上方 `## Touches`（+ 本任务 md）。任务分支上只做了一次 develop→worktree 的**吸收合并**（`git merge develop`），未把本分支并回 develop——「不并 develop」的实质是不产品化（见 Notes 边界）。

**AC6（边界可机械复核）** —— `git grep -l "live-monitor-replay" HEAD -- server src scripts e2e package.json` ⇒ 空（退出码 1 ✓）。原型零生产面 import。
