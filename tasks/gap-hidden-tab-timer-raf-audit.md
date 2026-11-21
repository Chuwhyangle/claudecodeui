---
id: gap-hidden-tab-timer-raf-audit
title: 隐藏标签页仍在跑的持久 timer/RAF：inventory 并条件暂停/清理
status: ready
labels:
  - gap
  - performance
  - frontend
parent: null
children: []
extra:
  schema: execution
---
## Finding

前端有约 244 处 `setInterval`/`setTimeout`/`requestAnimationFrame`。其中一批是持久的 1s 时钟：`useTickingNow.ts`（processing 行的 elapsed）、`SessionTaskChain.tsx:143`、`ActivityDockPanel.tsx:274`、`WorkspaceMain.tsx:264`；`useFleetTaskCounts.ts` 已经是 visibility-aware 的单例轮询，`useSidebarDialogs.ts` 是 60s 的共享时钟，`useDraftState.ts` 是 5s reconcile。问题不是数量本身，而是**隐藏标签页/不可见区域是否仍在跑**，以及清理是否完整。

本任务先做 inventory，再只修确认会持续消耗的 timer/RAF；不要把所有定时器都改成 rAF，也不要无测量地删除功能。

## AC

- [ ] AC1 Inventory：列出 app shell/sidebar/transcript/composer 中 >=1s 的持久 timer/RAF，记录触发条件、是否 visibility-gated、cleanup 位置；先打印 `persistentTimers=... hiddenPaused=...` 表格再改。
- [ ] AC2 隐藏标签页：用 60s 隐藏窗口（或等价的 code-level 证明）确认没有 timer/RAF 在 hidden 状态持续执行；对确认的项加 visibility gate 或卸载时清理；fleet/quay 等轮询必须保持现有 visibility-aware 行为。
- [ ] AC3 可见行为：elapsed 标签、draft reconcile、session activity、workspace 时钟在可见时仍按原语义更新；既有 tests/typecheck/lint 全绿。
- [ ] AC4 回归判据：为至少一个 visibility pause 增加 fake-timer 测试或明确记录无法测的原因；不得只改代码不留读数。

## DoD

- 持久 timer/RAF 有 inventory；hidden 状态不再无意义地跑；可见行为不变。
- 不删除功能、不引入新的全局 timer、不把 visibility 逻辑散落到多个组件（优先复用/扩展已有 store/visibility seam）。
- 既有测试/typecheck/lint 全绿；Touches 一致。

## Touches

- src/modules/sidebar/hooks/useTickingNow.ts
- src/modules/chat/SessionTaskChain.tsx
- src/modules/chat-support/activity/ActivityDockPanel.tsx
- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/sidebar/hooks/useFleetTaskCounts.ts
- src/modules/chat-composer/hooks/useDraftState.ts
- tasks/gap-hidden-tab-timer-raf-audit.md
