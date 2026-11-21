---
id: gap-hidden-tab-timer-raf-audit
title: 隐藏标签页仍在跑的持久 timer/RAF：inventory 并条件暂停/清理
status: done
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

## Inventory

Measured 2026-11-21 on the task worktree (non-test sources). Scope = app shell / sidebar / transcript / composer plus the shell-shared hooks·context·api seam. `setInterval` with a >=1s cadence: **`persistentTimers=12`**. Visibility-gated before the fix: **`hiddenPaused=3/12`**; after: **`hiddenPaused=12/12`**. Persistent rAF loops: **`persistentRafLoops=0`** (11 `requestAnimationFrame` sites in scope are all one-shot measure/position/focus calls).

| # | Site | Cadence | Trigger | Work per tick | Gated before | Cleanup |
|---|------|---------|---------|---------------|--------------|---------|
| 1 | `src/modules/sidebar/hooks/useTickingNow.ts` | 1000ms | `active` (running row) | setState elapsed label | no → **yes** | effect return `clearInterval` |
| 2 | `src/modules/chat-support/activity/ActivityDockPanel.tsx` | 1000ms | `schedules.length > 0` | setState countdown | no → **yes** | effect return `clearInterval` |
| 3 | `src/modules/chat/SessionTaskChain.tsx` | 30000ms (prop) | component mounted | GET session-task-chain | no → **yes** | effect return `clearInterval` |
| 4 | `src/modules/project-workspace/WorkspaceMain.tsx` | 2000ms | session selected | GET sessionHostState | no → **yes** | effect return `clearInterval` + `cancelled` |
| 5 | `src/modules/chat-composer/hooks/useDraftState.ts` | 5000ms | queued draft present | `hydrateChatDrafts` + local read | no → **yes** | effect return `clearInterval` + `cancelled` |
| 6 | `src/modules/sidebar/hooks/useFleetTaskCounts.ts` | 60000ms | >=1 subscriber | GET fleet-summary | yes (kept) | `stopPolling` + `visibilitychange` listener |
| 7 | `src/modules/sidebar/hooks/useSidebarDialogs.ts` | 60000ms | sidebar controller mounted | setState local `Date` clock | no → **yes** | effect return `clearInterval` |
| 8 | `src/modules/project-workspace/hooks/useFleetSummary.ts` | 120000ms | landing view mounted | GET fleet-summary | no → **yes** | effect return `clearInterval` + `cancelled` |
| 9 | `src/shared/context/SessionProtectionContext.tsx` | 5000ms | provider mounted | GET runningSessions | no → **yes** | effect return `clearInterval` |
| 10 | `src/shared/hooks/useVersionCheck.ts` | 300000ms | hook mounted | GitHub latest-release fetch | no → **yes** | effect return `clearInterval` |
| 11 | `src/shared/hooks/useSessionHosts.ts` | 30000ms connected / 2000ms disconnected | fallback poller | GET session hosts | yes (per-tick `document.hidden` return; kept) | `stopFallbackPoll` |
| 12 | `src/shared/api/viewEvents.ts` | 30000ms | tracker attached | POST view-event batch | yes (`visibilitychange` settles/pauses; kept) | `visibilitychange` listener cleanup |

All eleven newly gated React consumers share one seam, `src/shared/hooks/usePageVisibility.ts` (`usePageVisible` / `isPageHidden` / `subscribeToPageVisibility`); no component attaches its own listener. `useFleetTaskCounts` now imports the same `isPageHidden` predicate instead of keeping a local copy, preserving its existing stop-timer-on-hidden + catch-up-on-return behavior.

Out of AC1's stated scope and untouched: architecture viewport 2s poll + 1s tick, cockpit cards/page, notices, diagnostics log drawer, voice/chat-voice timers, settings AccessTokens 30s clock.

## AC

- [x] AC1 Inventory：列出 app shell/sidebar/transcript/composer 中 >=1s 的持久 timer/RAF，记录触发条件、是否 visibility-gated、cleanup 位置；先打印 `persistentTimers=12 hiddenPaused=3/12` 表格再改。
- [x] AC2 隐藏标签页：用 code-level 证明（`usePageVisible` → effect 提前 return + cleanup）确认 12 个受审 timer 在 hidden 状态不再执行；对确认的项加 visibility gate；fleet/quay 等既有 visibility-aware 轮询保持原行为（`useFleetTaskCounts`/`useSessionHosts`/`viewEvents` 的判据与清理未改）。
- [x] AC3 可见行为：elapsed 标签、draft reconcile、session activity、workspace 时钟在可见时仍按原语义更新（回到标签页时立即补读的项：SessionTaskChain、WorkspaceMain、useFleetSummary、SessionProtectionContext、useVersionCheck；纯本地钟：useTickingNow、ActivityDockPanel、useSidebarDialogs 由下一 tick 补齐）；typecheck（client/server/scripts）与 oxlint 全绿，相关组件测试全绿。
- [x] AC4 回归判据：`src/modules/chat/tests/SessionTaskChain.test.tsx` 新增 fake-timer 用例「pauses its poll while the tab is hidden and catches up with one read on return」：hidden 挂载 0 次读取、90s 推进仍 0 次、visible 立即 1 次、再 30s 2 次、再 hidden 120s 仍 2 次。

## DoD

- 持久 timer/RAF 有 inventory；hidden 状态不再无意义地跑；可见行为不变。
- 不删除功能、不引入新的全局 timer、不把 visibility 逻辑散落到多个组件（优先复用/扩展已有 store/visibility seam）。
- 既有测试/typecheck/lint 全绿；Touches 一致。

## Verification

- `usePageVisibility` seam: `src/shared/hooks/usePageVisibility.ts`（`isPageHidden` / `subscribeToPageVisibility` / `usePageVisible`），所有消费者只读它。
- Tests: `SessionTaskChain`（5, incl. new visibility fake-timer case）、`activityDock*`（7 files）、`SidebarProjectItemTaskCounts`（11）、`SidebarModeSwitch`（10）、`workspaceTabsResponsive`（22）、`src/modules/sidebar/tests` + `src/modules/chat-composer/tests` + `busySessionIds` + `aboutTabCommunityLinks` + `WorkspaceStateViewOverview`（236 files / 2123 tests）— all pass.
- `npx tsc --noEmit -p tsconfig.json` / `-p server/tsconfig.json` / `-p scripts/tsconfig.json`: exit 0.
- `npx oxlint src/ server/ scripts/ shared/`: exit 0 (only pre-existing warnings).
- L_G import-graph: src_files=774, src_edges=2396, pinned_sccs=3, new_cycles=0 (server/shared/tests/frontend-import-cycle-budget.test.ts 15/15 pass).

## Touches

- src/modules/sidebar/hooks/useTickingNow.ts
- src/modules/chat/SessionTaskChain.tsx
- src/modules/chat-support/activity/ActivityDockPanel.tsx
- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/sidebar/hooks/useFleetTaskCounts.ts
- src/modules/chat-composer/hooks/useDraftState.ts
- src/shared/hooks/usePageVisibility.ts
- src/modules/sidebar/hooks/useSidebarDialogs.ts
- src/modules/project-workspace/hooks/useFleetSummary.ts
- src/shared/context/SessionProtectionContext.tsx
- src/shared/hooks/useVersionCheck.ts
- src/modules/chat/tests/SessionTaskChain.test.tsx
- tasks/gap-hidden-tab-timer-raf-audit.md
