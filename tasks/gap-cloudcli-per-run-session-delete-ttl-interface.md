---
id: gap-cloudcli-per-run-session-delete-ttl-interface
title: Finding：CloudCLI MCP 网关缺少 per-run 会话删除/TTL 接口（跨项目发现，来自 quay-fleet 的
  2026-10-12 风暴清理）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Finding

**发现方（跨项目）**：quay-fleet（Fleet Manager）在 2026-10-12 的 wake 会话风暴事故取证与清理过程中发现——清理方（人工+另一条调查会话）为了清掉风暴残留的 per-run 会话，只能逐个 `session_interrupt` + `session_close`，而 `session_close` 对 per-run 会话的既有读数是 `mode:'resident'` 专属、per-run 场景答 "only-resident" 属预期拒绝（`src/delegate-smoke.mjs` 头注释已有记录）——即 **CloudCLI MCP 网关目前没有任何批量/TTL 清理 per-run 会话的接口**：

- 没有「删除/归档一个已结束的 per-run 会话记录」的写工具。
- 没有「per-run 会话超过 N 分钟无活动自动过期」的 TTL/生命周期策略。
- 清理只能逐条走 `sessions_list` 全量扫描 + 人工判断 + `session_interrupt`（仅对活跃会话有意义）——没有真正的"删除会话记录本身"的路径，所以像本次事故那样一次性产生几十个 per-run 会话残留时，只能让它们一直留在 `sessions_list` 里，无法清空。

**跨项目边界（Fleet 自己遵守的原则，供本项目参考）**：Fleet 侧的结论是"不得直接改网关数据库、不得未经授权误删活跃会话"——这正是因为**网关本身没有提供一个安全、幂等、范围明确的删除/TTL 接口**，任何客户端（包括 Fleet 自己）想清理，只能手搓脚本直接碰底层数据，风险很高。这条 Finding 只是如实转交现象，不代为设计 claudecodeui 侧的解决方案（那是本项目自己的决定）。

## AC

- [ ] 核实现有 `session_close`/`session_interrupt`/`sessions_list` 的真实语义是否确实不覆盖"删除一个已结束的 per-run 会话记录"（本次 Finding 的前提，需要本项目自己复核，不采信转述）
- [ ] 若确认缺口成立，提出至少一种方案的技术选型（例如显式 `session_delete` 工具 vs 基于 `lastActivity` 的自动 TTL 清理任务 vs 两者结合），并裁定由谁决策（人/本项目既有机制）
- [ ] 如果本项目认为不是缺口（例如已有未暴露在 MCP 层的清理机制），如实记录结论并关闭本任务，而不是强行实现一个不需要的接口

## DoD

本项目对"per-run 会话缺少删除/TTL 接口"这个现象给出一次权威判断（缺口成立/不成立），若成立则有一个被采纳的技术方向；不要求本任务内就实现完整方案。

## Touches

- tasks/gap-cloudcli-per-run-session-delete-ttl-interface.md

（本项目自行决定，Finding 本身不预设实现文件）
