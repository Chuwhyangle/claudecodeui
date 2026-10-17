---
id: gap-frame-without-turn-subagent-false-positive
title: frame-without-turn 对子代理帧是假阳性：recordFrameWithoutTurn 应排除 parent_tool_use_id 帧
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
<!-- dedup-ref --> 机制去重（立案时实测 2026-10-17）：`grep -rln 'isSubagentPromptEcho\|parent_tool_use_id' tasks/*.md` 命中的六个任务（gap-activity-task-reducer / gap-activity-lease-parity / gap-claude-runtime-per-run-occupied-session-gate / gap-claude-runtime-frame-forwarding-coverage / gap-claude-stream-frames-carry-block-key / gap-claude-turn-phase-real-signals）都在正文顺带提到子代理帧，没有一条认领「frame-without-turn 对子代理帧是假阳性」。`grep -rln 'frame-without-turn' tasks/*.md` 只命中 gap-ac390-resident-reconcile-observability，它把 frame-without-turn 当**异常码注入用例**（(d) 腿）测「无 turn 帧得到一行 [reconcile]」，不是「子代理帧不该被记」。机制词「排除子代理」全库 0 命中。separate。

## Finding

### 缺陷面

`recordFrameWithoutTurn`（server/modules/providers/list/claude/claude-host-driver.provider.ts:6225-6235）只判两件事就记异常：`message.type` 是 `assistant`/`user`，且账本没有开着的 turn。它**不排除子代理帧**（带 `parent_tool_use_id` 的帧）。而子代理（Task 工具）的帧正是经父 CLI 的 stream-json 中继进主线程、在父 turn 之间到达——它们**本就该**无父 turn。把这种正常流量记成 `frame-without-turn`（语义是「账本与流分道扬镳」）是假阳性。

实测（2026-10-17）：会话 050a5ac0（ClaudeCodeUI 的 quay 架构分析能力，重度用 Task 子代理建 archguard 任务）log 里 119 条 frame-without-turn；被标记的帧 uuid（抽样 6 个）在 quay 项目目录 3360 个 transcript 文件里全部搜不到（父 transcript 里 `parent_tool_use_id` 0 次、`isSidechain` 356 行），异常逐批落在子代理完成时刻（最后一批 05:05:03.779，子代理 endedAt 05:05:03.788）。转发路径本就有子代理排除——`isSubagentPromptEcho`（claude-runtime.provider.ts:924）注释「Subagent traffic carries parent_tool_use_id… disappears on reload」——但异常记录这条腿没做同样的排除。

结果：这个异常码被子代理流量淹掉（119 条全是噪声），真分歧（无 turn 且不带 parent_tool_use_id 的帧）会埋在噪声里失去信噪。它不改变转发行为（转发照旧，只是多记一条异常），也不导致 phantom run。

### 修法

`recordFrameWithoutTurn` 在判定「无 turn」之前，先跳过 `message.parent_tool_use_id` 为真的帧（snake_case——`recordFrameWithoutTurn` 收的是原始 stream 帧，`transformResidentMessage` 读的也是 `message.parent_tool_use_id`）。与转发路径的 `isSubagentPromptEcho` 排除对齐。不碰 `isSubagentPromptEcho` 本身（它滤的是 user 提示回声，本任务滤的是「无 turn 子代理帧记异常」）。

## AC
- [ ] AC1 红态基线（先写判据、改动前运行）：经 scripted fake 进程向真实 ClaudeResidentHostDriver 注入「带 parent_tool_use_id 的 user/assistant 帧 + 无 turn」⇒ 现状产出一条 frame-without-turn（红；本任务要把它翻绿）。
- [ ] AC2 排除生效：同一注入在改动后不产出 frame-without-turn；反向对照——「无 turn + 不带 parent_tool_use_id」的帧仍恰好产出一条（真分歧仍被抓）。
- [ ] AC3 转发行为零变化：改动前后，两类注入帧仍照旧走 forwardNormalizedFrames（isSubagentPromptEcho 那条路不变），读数证明「只少记一条异常，不多转/少转任何帧」。
- [ ] AC4 取假形态：删掉「跳过 parent_tool_use_id」这一判据 ⇒ AC2 的排除腿红（子代理帧又被记）；还原恢复绿。红落在排除腿本身。
- [ ] AC5 兄弟判据不被打红：单文件跑 server/modules/providers/tests/claude-resident-reconcile.test.ts（其 (d) 腿注入不带 parent_tool_use_id 的 frame-without-turn）仍绿；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `。

## DoD
真实落地判据（不是「测试存在」）：在交付树上把「带 parent_tool_use_id 的无 turn 帧」与「不带 parent_tool_use_id 的无 turn 帧」各注入一次，前者 0 条 frame-without-turn、后者恰好 1 条；删掉排除 ⇒ 前者变红。`git diff` 只含 `claude-host-driver.provider.ts` 的 `recordFrameWithoutTurn` 一处、判据文件、本任务 task 文件。

## Touches
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （recordFrameWithoutTurn 加 parent_tool_use_id 排除）
- `server/modules/providers/tests/claude-resident-reconcile.test.ts` （就地加「子代理帧不记、无 turn 帧仍记」两臂；若 grep 契约不允许加缝则另起同级文件）
- `tasks/gap-frame-without-turn-subagent-false-positive.md` （自触）
