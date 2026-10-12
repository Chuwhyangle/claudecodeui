---
id: gap-goal-044-section9-human-adjudication
title: GOAL-044 充分性补口：决策文档 §9 的 H-E1..H-E7 人裁定记录无 AC 覆盖，提议新增人工关卡 AC-365
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**选型 (a)：提议新增一条 AC（人工关卡），不修订退出条件文本；⛔ 不改任何 GOAL/AC 状态、⛔ 不写 goal-store、⛔ 不改 `goals/*.md`。** 本条由 GOAL-044 的充分性跟进 agent 立案，仅供人裁定。

### 未被覆盖的部分（逐字引用）

`goals/GOAL-044-live-voice-体验优先-可用-低延迟-连续交互-模型决定投递边界-vad-只服务传输节奏-先建本地确定性验证与真.md` 的 `## 退出条件` 逐字全句：

> AC-361 判据通过且读数表覆盖 X-1..X-7；AC-362、AC-363 报告读数齐全；AC-364 判据通过且开关仍默认关闭；决策文档 §9 的 H-E1..H-E7 已由人裁定并记录。

其中**第 4 分句即未被覆盖的部分**，逐字：

> 决策文档 §9 的 H-E1..H-E7 已由人裁定并记录

### 为何现有 AC 集覆盖不到

退出条件四分句 ↔ 在域 AC 逐条对齐：

| 退出条件分句（逐字） | 覆盖它的 AC |
|---|---|
| AC-361 判据通过且读数表覆盖 X-1..X-7 | AC-361 |
| AC-362、AC-363 报告读数齐全 | AC-362、AC-363 |
| AC-364 判据通过且开关仍默认关闭 | AC-364 |
| **决策文档 §9 的 H-E1..H-E7 已由人裁定并记录** | **无** |

在域 AC 全在做两件事：**产读数**（AC-361 的 X-1..X-7、AC-362 的 C-1/C-2/C-4/C-5、AC-363 的 V-1..V-8）与**实现 STS（开关默认关）**（AC-364 的 S-1..S-7）。**没有任何一条读 §9，也没有任何一条要求 §9 的七项被裁定并记录。** 因此 AC-361..AC-364 全绿时，§9 可以原封不动停在「推荐」栏而判据全过——这正是决策文档抬头逐字记的现状：

> **§9 的 ⚖️ 项仍待人裁定**

而 §9 恰是本 GOAL 自己指定的门禁。同一文档 §8 逐字：

> 体验修复（§4 R-1 的 1–5 项）与默认模式切换**不在本轮立项**：要等 AC-361 的基线与 AC-362 的读数出来、人裁定 §9 之后再立，避免在未验证的参数上实现。

即「人裁定 §9」是 GOAL-044 的收尾条件，却无人用 AC 钉住它。

### 现状读数（2026-10-12，本轮实测）

- `grep -n 'H-E' docs/proposals/live-voice-experience-first-decision-2026-10.md` → 仅 §9 表内 7 行（H-E1..H-E7）；第三列全部是**推荐**：`采纳`（H-E1/H-E2/H-E4/H-E7）、`按 §3 先行，基线读数出来后再定`（H-E3）、`退回并改挂（另行执行）`（H-E5）、`取决于 C-5；先立校准`（H-E6）。**无任何由人写入的裁定记录。**
- `grep -rln 'H-E1\|H-E7\|H-E[0-9]' tasks/` → 0 命中：全库无任何任务（在飞或已落地）涉及 §9 的裁定记录。
- `ls goals/ | grep AC-365` → 不存在；现有最高 AC 为 **AC-364**，`goals/` 无第 5 条 GOAL-044 的 AC。
- **裁定所依赖的读数已就绪**：H-E3（X-1..X-7 首版数值）依赖 AC-361 的读数表——`gap-live-voice-continuous-experience-e2e-harness` 的 `## Notes` 已落盘 X-1..X-7 逐项读数；H-E6（prompt 是否改）依赖 C-5——AC-362 已完成并给出读数（C-5：指令没有让模型等待 0/10）。⇒ §9 的裁定条件已成熟，缺的只是「记录」这一条 AC。

### 为何本提议覆盖得住

新增 **AC-365** 是**人工关卡** AC：其 `criterion` 机械要求决策文档出现七条由人写入的裁定记录行（`H-E1：…` … `H-E7：…`）与出处（`裁定人：人 yale`、`裁定于：YYYY-MM-DD`），且 H-E3 / H-E6 两行须引用各自依赖的读数。它取假的对象正是上表那个空单元格——**一个把读数做全、却让 §9 永远停在「推荐」栏的 GOAL-044**：AC-361..AC-364 全绿而 §9 未记录时 AC-365 必红；人到 §9 写入七条裁定后它转绿。该形状照抄本仓既有的人类关卡形态（`gap-ac257-mcp-nested-smoke-human-gate`、`gap-ac270-external-client-human-gate`：criterion 是 grep 一行只能由人写入的字样，执行者不得代写，判据不过时终止态是 needs-human）。

<!-- dedup-ref --> 机制去重（2026-10-12）：本 GOAL 现有 4 条任务 `gap-live-voice-continuous-calibration-run`（AC-362, done）、`gap-live-voice-continuous-experience-e2e-harness`（AC-361, ready）、`gap-live-voice-silence-tail-suppression-probe`（AC-363, done）、`gap-live-voice-silence-tail-suppression`（AC-364, todo），逐条 grep `H-E` / `§9` / `裁定` / `新 ?AC` → **0 命中修改性内容：没有任何一条提议新增/修订 AC 或退出条件**。全库 `task_list` grep `H-E[0-9]` → 0 任务命中；open 任务对「§9 裁定记录」0 命中。merge-candidate 工具（`task-granularity-advice.js --touches docs/proposals/live-voice-experience-first-decision-2026-10.md`）`peers: []`（仅两条 `mentions` 是散文提及，非 Touches 重叠）⇒ 无同文件在飞实现任务，**separate**。

### 给裁定人的两个选项（二选一，都由人定）

1. **采纳 AC-365（推荐）**：新增 `goals/AC-365-人工关卡-决策文档-9-的-h-e1-h-e7-由人裁定并记录-之后-goal-044-才算达成.md`，`criterion` **逐字为下方命令**，`goal: GOAL-044`，并把它加进 GOAL-044 的 `## 退出条件`（经授权的 goal 写入路径，⛔ 非本 agent）。随后本任务可被派发：执行者只汇编 §9 的待裁事项与各自依赖的读数（§9.1 骨架），**七条裁定行只能由人 yale 写入**；不齐时停在 needs-human。
2. **若人认为 §9 的裁定不该是退出条件**：修订 GOAL-044 的 `## 退出条件`，把第 4 分句移出（例如不为「§9 由人裁定」单列达成条件），并相应更新 §8 的门禁措辞。选此项则本任务撤回、不派发。

### criterion（选项 1 的逐字判据）

```
d=docs/proposals/live-voice-experience-first-decision-2026-10.md; miss=0; for i in 1 2 3 4 5 6 7; do grep -qE "^H-E$i：" "$d" || { echo "§9 缺 H-E$i 的裁定记录行（须逐字以「H-E$i：」开头，只能由人 yale 写入）" >&2; miss=1; }; done; grep -qE "^裁定人：人 yale" "$d" || { echo "§9 裁定记录缺「裁定人：人 yale」" >&2; miss=1; }; grep -qE "^裁定于：2[0-9]{3}-[0-9]{2}-[0-9]{2}" "$d" || { echo "§9 裁定记录缺「裁定于：YYYY-MM-DD」" >&2; miss=1; }; grep -qE "^H-E3：.*(X-[1-7]|AC-361)" "$d" || { echo "H-E3 裁定未引用 X-1..X-7 / AC-361 读数" >&2; miss=1; }; grep -qE "^H-E6：.*(C-5|AC-362)" "$d" || { echo "H-E6 裁定未引用 C-5 / AC-362 读数" >&2; miss=1; }; [ "$miss" = 0 ]
```

### expect（选项 1 的逐字 expect）

> 决策文档 §9 出现七条由人 yale 写入的裁定记录行（`H-E1：…` … `H-E7：…`），并带出处（`裁定人：人 yale`、`裁定于：YYYY-MM-DD`）；H-E3 与 H-E6 两行的裁定须引用各自依赖的读数（H-E3 → AC-361 的 X-1..X-7；H-E6 → AC-362 的 C-5）——它们原始「推荐」栏逐字就是「基线读数出来后再定」/「取决于 C-5；先立校准」。执行者只汇编待裁事项与读数，**不得代写任何一条裁定行**；汇编产物里不得出现以 `^H-E…：` 开头的行，否则判据被模板自点亮。AC-361..AC-364（读数与实现）齐全而本条仍不过时，正确终止状态是 **needs-human**，不是 done。（红先行）当前必红：§9 现为「推荐」栏，七个 `H-E*：` 行均不存在，grep 非零并输出缺失原因。

## Resolution

（待裁定：人于复核本任务时在此写入「选项 1」或「选项 2」的结论。选 2 则本任务撤回，⛔ 不得派发。）

## AC

- [ ] AC1 人已裁定上面两个选项之一，裁定结论记入本任务 `## Resolution`；选 2 则本任务撤回，不得派发。**这条不得由 worker 自行勾选**；人尚未裁定前本任务停在 `needs-human`，不得置 done。
- [ ] AC2（若选 1）`goals/AC-365-人工关卡-决策文档-9-的-h-e1-h-e7-由人裁定并记录-之后-goal-044-才算达成.md` 记录存在，`criterion` 逐字为 `## Proposal` 中 `### criterion` 一节给出的命令、`goal: GOAL-044`，且 GOAL-044 的 `## 退出条件` 增列 AC-365（经授权的 goal 写入路径，⛔ 非本 agent）。
- [ ] AC3（若选 1）新判据转绿：同一命令退出 **0**。**这条同样不得由 worker 自行勾选**（七条裁定行只能由人 yale 写入）。红态基线（本轮实测）：§9 现为「推荐」栏、无任何 `H-E*：` 行，判据命令非零退出并输出缺失项。
- [ ] AC4 只写本任务文件：`git diff --name-only "$(git merge-base develop HEAD)" -- . ':!tasks/gap-goal-044-section9-human-adjudication.md'` 无输出（产品代码、决策文档与 `goals/*.md` 一行未改）。

## DoD

本提案经人复核裁定。选 1 时：`goals/AC-365` 的逐字判据与 GOAL-044 退出条件的增列，均由**授权的 goal 写入路径**落地（⛔ 本 agent 不写 goal-store、⛔ 不翻任何状态、⛔ 不改 `goals/*.md`）；判据现状必红，且只能由人 yale 在 §9 写入七条裁定记录后转绿——落地的对象是**真的被记录的裁定**，不是「测试存在」。选 2 时本任务撤回、不派发。

## Touches

- docs/proposals/live-voice-experience-first-decision-2026-10.md（选项 1 采纳并派发后：§9.1 待裁事项与读数汇编骨架；七条裁定行由人 yale 写入）
- tasks/gap-goal-044-section9-human-adjudication.md
