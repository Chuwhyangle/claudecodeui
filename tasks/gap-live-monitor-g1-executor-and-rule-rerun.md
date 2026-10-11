---
id: gap-live-monitor-g1-executor-and-rule-rerun
title: Live Monitor 续做：补 G1（状态迁移的执行者可识别）+ 按 D1/D2 改规则 + 同一窗口重跑做前后对照（⛔ 原型不并 develop）
status: todo
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

- [ ] AC1 **G1 取证**：对 38 段 needs-human episode 中**至少 30 段**给出「执行者」读数（机械停派 / `task_write` 写入 / 人工），每条带可回查证据（`file@byte` 或 `git sha`）；识别规则写进原型（`collect.mjs` 或 `lib.mjs`），并**如实标出识别不出的那部分**（⛔ 不许用启发式冒充成「人工」）。判据：同一窗口重跑后 `needs-human-episodes.json` 里每段都有 `executor` 字段，且 `executor === 'unknown'` 的段数 ≤ 8。
- [ ] AC2 **按 D1/D2 改规则**：① `failure-streak` 命中但最终落地 ⇒ 记**成本信号**（不计入误报）；② 机械停派 ⇒ **Record**（`human-decision` 只对 `task_write` 停派 Notify）；③ 过期规则改**积压摘要**（窗口前遗留的停派合并成一条「另有 N 条早于窗口」）。
- [ ] AC3 **同一窗口重跑 + 前后对照**：窗口仍为 `2026-10-08T17:00Z → 10-10T17:00Z`，输出对照表（告警条数 / precision / 误报漏报），并以人 yale 的 D3 校准集（`gap-live-monitor-48h-replay-experiment` 的 `## Resolution` 里那 14 条、标记为打扰 7 / Record 7）作为**固定标尺**：新规则下那 7 条「打扰」不得丢失。
- [ ] AC4 **取假必红**：关掉 D1 的改动 ⇒ 4 条成本信号（原 #1–4）从通知流里消失，AC3 的标尺断言变红；恢复后回绿。逐条记录 diff、失败行与恢复命令。
- [ ] AC5 **不并 develop**：`git merge-base --is-ancestor <本任务提交> develop` 退出非 0，且 `git diff --name-only develop...HEAD` ⊆ `## Touches`。

## DoD

真实读数：同一窗口重跑出的前后对照表（含 precision 变化与 14 条校准集的逐条落点）+ G1 的 executor 读数覆盖面（≥30/38、unknown ≤8，每条带证据）。⛔ 只在单测夹具上构造、或把原型并进 develop ⇒ 不算达成。

## Touches

（这些文件在 `proto/live-monitor-replay` 上；本任务的工作树从该分支切出，⛔ 不并 develop）

- experiments/live-monitor-replay/collect.mjs
- experiments/live-monitor-replay/lib.mjs
- experiments/live-monitor-replay/replay.mjs
- experiments/live-monitor-replay/RESULT.md
- experiments/live-monitor-replay/NOTIFICATIONS.md
- experiments/live-monitor-replay/needs-human-episodes.json
- tasks/gap-live-monitor-g1-executor-and-rule-rerun.md

## Notes

- 裁定来源：`gap-live-monitor-48h-replay-experiment` 的 `## Resolution`（D1/D2/D3 + 三条规则级决定）。
- ⚠️ 已知风险 G9：回放依赖载体未被轮转；若 `.quay/*.jsonl` 已轮转，须如实记下缺哪一段，⛔ 不要用现有数据顶替。
