---
id: fleet-overview-p3-landing-overview-session-terminal
title: Landing 总览三面板 + 会话终态派生（fleet-overview P3）
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状（2026-10-18 实测）：无会话选中时 Landing 是「Choose Your Project」空态（`WorkspaceStateView.tsx`）；会话结束的「结果」未归约，也没有跨项目「刚结束」视图。P1 已把「正在跑」的 phase/tool/elapsed 落到侧栏行。

正确行为：
1. Landing 三面板：① 正在跑（P1 的 phase/tool/elapsed 跨项目聚合）② 刚结束（终态 feed）③ task·goal 变迁（P2 的 fleet-summary 计数）。
2. 移动端顶部脉冲条 + 横滑三页（390px）；桌面（1280px）三面板并列。
3. 会话终态派生：从 delivery/turn 账本（`server/modules/resident-ledger/`）归约「以什么结果结束」——这是 D 事件主干的第一批事件源。

终态 taxonomy 是 AC1 的先产出物（SPEC §11 风险 1 列其为 P3 前置）：建议 成功/出错/needs-human/被打断/超时，可调整，但须 pin 成可判别测试。

<!-- dedup-ref --> 去重（机制词 Landing 总览 / 终态派生 / 刚结束 feed 检索）：open 任务零命中；P1（已 done）是「侧栏行 phase」，本任务是「无会话选中时的 Landing 面」，机制不同。

## AC

- [x] AC1 终态 taxonomy 定义 + pin：在 `server/modules/resident-ledger/` 新起纯函数，从 delivery/turn 账本归约终态（建议 成功/出错/needs-human/被打断/超时）；每个终态至少一个正例 + 一个可区分的负例，pin 成测试。
- [x] AC2 终态判别测试：新增 `server/modules/resident-ledger/tests/terminal-state.test.ts`，注入账本 fixture 断言各终态归约正确，且「出错」与「超时」可区分。
- [x] AC3 Landing 三面板渲染：无会话选中时 `WorkspaceStateView` 渲染「正在跑 / 刚结束 / task·goal 变迁」三块；「正在跑」跨项目聚合 P1 的 phase/tool/elapsed，「刚结束」来自终态派生。
- [x] AC4 移动端：390px 视口顶部脉冲条出现 + 三页可切换；1280px 三面板并列。vitest 覆盖 compact 分支 + Playwright 双视口断言数据属性。
- [x] AC5 测试绿：新增前端 Landing 测试 + AC2 服务端测试；`npm run typecheck`、`npm run lint` 退出码 0。

## DoD

无会话选中时 Landing 显示三面板（正在跑/刚结束/task·goal），「刚结束」含终态；终态 taxonomy 有判别测试；PC 1280px 与移动 390px 双视口通过。

## Touches

- src/modules/project-workspace/WorkspaceStateView.tsx
- src/modules/project-workspace/tests/WorkspaceStateViewOverview.test.tsx
- src/modules/project-workspace/hooks/useRecentSessionEndings.ts
- src/modules/project-workspace/hooks/useFleetSummary.ts
- src/modules/project-workspace/context/ProjectsStateContext.tsx
- src/modules/project-workspace/ProjectMainRegion.tsx
- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/sidebar/index.ts
- src/shared/api.ts
- server/modules/resident-ledger/terminal-state.ts
- server/modules/resident-ledger/index.ts
- server/modules/resident-ledger/tests/terminal-state.test.ts
- e2e/landing-overview.spec.ts
- tasks/fleet-overview-p3-landing-overview-session-terminal.md
