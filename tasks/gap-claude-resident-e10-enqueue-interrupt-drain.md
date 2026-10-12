---
id: gap-claude-resident-e10-enqueue-interrupt-drain
title: 真实常驻 CLI 实验 E10：入队—中断—出队（U1–U4），读数写入实验记录并回写 SPEC（阶段 0d）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-341
---
## Proposal

### 为什么要实测（SPEC §18.4 G1 的实现形态取决于此）

A+ 的「先入队后中断」需要回答四个今天**没有读数**的问题（E1–E9 未覆盖）：

- **U1**：resident 会话一轮进行中、CLI 队列里已有 k 条（k=1,3）未出队消息时调用 `interrupt()`，这些消息是保留、被丢弃，还是并入下一轮？
- **U2**：`interrupt()` 之后 CLI 多久出队？在中断前 0 ms、中断后 0/50/200/1000 ms 推入一条「修正」消息，它与旧排队消息落在**同一轮**还是**下一轮**（是否存在 stale-first 窗口）？
- **U3**：N=3 条排队消息在回合边界是否拼成**一条** user 消息（2026-10-12 生产 transcript `c6493eb6` 见到 7 条合一，但 E2/E3 只测过 2 条），拼接分隔符与顺序如何？
- **U4**：`cancel_async_message` 撤回**非最新**的未出队条目是否生效（E9 只测了最新一条）？

### 怎么测

在既有实验台 `scripts/resident-experiment.mjs`（E1–E9，真实 `claude` 二进制 + mock Anthropic 兼容端点，零模型费用）上新增子命令 `e10`：mock 端点让第一轮挂起一段可控时长（例如脚本化的慢工具调用），期间推入消息、调用 `query.interrupt()`、按上述偏移推入修正；读 `command_lifecycle` 事件、每轮发往 mock 端点的 user 消息正文、`result` 时刻。原始读数与「结论：」行写入 `docs/proposals/claude-resident-sessions-experiments.md` 新节 `## E10 …`；`--check-record` 改为要求 E1–E10。

护栏照旧：显式临时 `DATABASE_PATH`（并经 `/proc/<pid>/environ` 核对）、端口避开 3001、**不重启 :3001**、结束后无残留进程。结论一行写回 SPEC §18.6 阶段 0d。

<!-- dedup-ref --> 机制去重：`gap-claude-resident-phase0-experiments`（done）覆盖 E1–E9，无 interrupt×队列交互读数；open 任务 0 命中。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. `e10` 子命令（U1–U4 各一段）+ `SECTION_IDS` 增 `E10` + 标题表。
2. `scripts/resident-experiment.test.mjs` 增「缺 E10 节 ⇒ exit 1 并点名 E10」用例。
3. 真跑 `e10`，读数入记录；SPEC §18.6 写回一行结论（U1–U4 各一句）。
4. `npm run lint`。

## AC

- [ ] AC1：`node --test scripts/resident-experiment.test.mjs` 退出 0，且含「缺 E10 节 ⇒ exit 1 并点名 E10」用例。
- [ ] AC2：`node scripts/resident-experiment.mjs --check-record docs/proposals/claude-resident-sessions-experiments.md` 退出 0，且记录有 `## E10 ` 节，U1–U4 各有 `读数：` 与 `结论：`。
- [ ] AC3：E10 读数为原始输出：`command_lifecycle` 事件 JSON 原文或逐字摘录、时间戳、每轮 user 消息正文摘录、`claude --version` 与 SDK 版本、临时 `DATABASE_PATH` 核对行。
- [ ] AC4：SPEC §18.6 的 0d 行后写有 U1–U4 结论（`grep -n 'E10 结论' docs/proposals/voice-realtime-persistent-control-SPEC.md` 有输出）。
- [ ] AC5：`npm run lint` 退出 0。

## DoD

E10 **真实跑过**（真实 `claude` 二进制，mock 端点），结束后 `pgrep` 与 `systemctl --user list-units` 读数显示无本实验残留，:3001 进程 pid 前后相同（读数写入记录）。

## Touches

- scripts/resident-experiment.mjs
- scripts/resident-experiment.test.mjs
- docs/proposals/claude-resident-sessions-experiments.md
- docs/proposals/voice-realtime-persistent-control-SPEC.md（§18.6 写回 E10 结论一行）
- tasks/gap-claude-resident-e10-enqueue-interrupt-drain.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale 授权（GOAL-041 / AC-341）。阶段 1 的 `gap-live-voice-interrupt-after-revision-enqueued` 以本任务读数选择实现形态。
