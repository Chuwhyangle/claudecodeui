---
id: fleet-overview-p1-running-phase-tool-elapsed
title: Running sessions 视图与会话行：渲染 activity snapshot 的
  phase/tool/elapsed（fleet-overview P1）
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状（2026-10-18 实测，见 docs/proposals/fleet-overview-SPEC.md §1.2）：`RunningView`（src/modules/sidebar/RunningView.tsx）与 `SidebarSessionItem`（src/modules/sidebar/SidebarSessionItem.tsx）只渲染会话名字（running 行带 spinner，resident-idle 行带 Close）；activity snapshot 已算好的 phase（thinking/writing/tool/compacting/awaitingPermission）、toolName、elapsedMs 一个都没渲染到侧栏。用户要「一眼看出会话在干嘛」，现在必须点进会话。

数据源已就绪（SPEC §3）：`SessionProtectionContext` 的 `useProcessingSessions()` 返回 `SessionActivityMap`（`ReadonlyMap<sessionId, SessionActivity>`），`SessionActivity` 带 `phase`/`toolName`/`elapsedMs`（src/shared/types.ts:510）。phase 的显示词由 `activityPhaseLabelKey`（src/modules/chat/utils/activityDockView.ts，返回 `claudeStatus.phases.*` 等 i18n key）归约，直接复用不新造词表。

正确行为：running 会话行渲染 阶段标签 +（tool 相位时）工具名 + 耗时；resident-idle 行显示 idle、不渲染 phase。本任务只做渲染（纯前端、0 新后端），不做 unreachable/awaitingServer 状态判定（归 P3）。

实现注意：`activityPhaseLabelKey` 现居 chat/utils，若侧栏跨模块深导入触发 frontend-module-standards 的 boundaries 门，按标准提为共享（src/shared/）或经 barrel 再导出，不要为了绕过门而硬编码新词表。

<!-- dedup-ref --> 去重（机制词 RunningView / SidebarSessionItem / activity phase / elapsed 检索）：open 任务零命中；所有 Touches 到 RunningView/SidebarSessionItem 的历史任务均 done、机制各异（gap-claude-resident-running-view 是「running 视图存在性」，gap-activity-single-dock-global-consistency 是「dock 全局一致」）。merge-candidate：无。

## AC

- [x] AC1 渲染契约：running 行渲染 `data-activity-phase`/`data-activity-tool`/`data-activity-elapsed`，值与 `useProcessingSessions()` 里该 sessionId 的 `SessionActivity` 一致；resident-idle 行不渲染 `data-activity-phase`。
- [x] AC2 标签归约：phase 标签词经 `activityPhaseLabelKey` 归约（非硬编码新表）；`tool` 相位显示 toolName，toolName 为空回退 `toolGeneric`。
- [x] AC3 测试绿：新增 `src/modules/sidebar/tests/RunningViewPhase.test.tsx`，覆盖「有 phase / 无 phase（resident-idle）/ tool 无名字」三例；`bash scripts/with-memory-cap.sh vitest run src/modules/sidebar/tests/RunningViewPhase.test.tsx` 退出码 0。
- [x] AC4 双视口适配：phase/tool/elapsed 在 `SidebarSessionItem` 的 compact（移动浏览器窄视口）与非 compact（桌面）两分支均渲染；`RunningViewPhase.test.tsx` 覆盖 `useCompactSidebar()` 返回 true/false 两态，断言两态下行内 `data-activity-phase`/`-tool`/`-elapsed` 均存在；`RunningView` 在窄视口下同样携带数据属性（组件渲染断言，不依赖像素）。

## DoD

Running sessions 视图与 Projects 视图的会话行，running 会话显示阶段+工具+耗时、resident-idle 显示 idle，均与 activity snapshot 一致；AC1/AC2 断言 + AC3 测试随代码落地且绿；**PC 桌面视口（1280px）与移动浏览器视口（390px）两档下 AC4 双视口验证通过**；`npm run typecheck`、`npm run lint:client` 退出码 0。

## Touches

- src/modules/sidebar/RunningView.tsx
- src/modules/sidebar/SidebarSessionItem.tsx
- src/modules/sidebar/tests/RunningViewPhase.test.tsx
- src/modules/sidebar/hooks/useTickingNow.ts
- src/modules/sidebar/utils/sessionActivityPresentation.ts
- src/shared/types.ts
- src/shared/context/SessionProtectionContext.tsx
- src/modules/chat/index.ts
- tasks/fleet-overview-p1-running-phase-tool-elapsed.md

## Completion notes

- 现状校正：`SessionActivity` 在本分支并不带 `phase`/`toolName`/`elapsedMs`（原 Proposal 的 SPEC §3 引文与代码不符）。实现把 activity snapshot 的 `turn.phase`/`turn.toolName`（snapshot/upsert、heartbeat、subscribe hello 三个来源）折进 `SessionActivity`，并为每个 running 会话补发 `activity.subscribe`（绝不能走 `chat.subscribe`，其 reply 是冻结的 run replay 流）。elapsed 由 `SessionActivity.startedAt`（activity map 自身的起跑锚）按秒推进。
- 验证：`bash scripts/with-memory-cap.sh vitest run src/modules/sidebar/tests/RunningViewPhase.test.tsx` → 5 tests pass，exit 0；`npm run typecheck` exit 0；`npx oxlint src/`（= `npm run lint:client`）exit 0。
- AC4 的两条腿由 `RunningViewPhase.test.tsx` 中 compact=true / compact=false 两个用例分别验证，且断言桌面分支的 `<a href="/session/...">` 只在非 compact 出现，确保测的是真实分支。
