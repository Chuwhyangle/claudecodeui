---
id: fleet-overview-p2-project-task-counts-fleet-summary
title: 项目行 task 计数徽标 + fleet-summary 端点骨架（fleet-overview P2）
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状（2026-10-18 实测）：项目行只显示「quay configured, driver idle」（`SidebarProjectItem.tsx` 经 `getQuayIndicatorStatus(project, null)`），不显示 task 状态计数。`GET /:projectId/snapshot` 能拿单项目 task 计数，但只按需（quay tab 激活）且昂贵（~2s/项目）。要「一眼看到每个项目的 task 排期状态」。

正确行为：新增 `GET /api/quay/fleet-summary`，聚合所有 quay 项目，每项目只返回 driver 状态 + task 状态计数（`quay task list --json --no-body` 派生），不含 goal/inFlight/gantt（goal 归 P5 消费 `--no-evidence`，inFlight/gantt 归 lazy）。前端项目行渲染 task 计数徽标（todo/ready/needs-human）。

成本约束：服务端 `Promise.all` 扇出 + concurrency 上限 4 + 每项目 2min TTL；TTL 内轮询不重复 spawn CLI（实测 `goal list` warm 只省 4%、并发 4 路墙钟 ≈ 单路，故 TTL 是唯一有效消解）。

<!-- dedup-ref --> 去重（机制词 fleet-summary / task 计数聚合检索）：open 任务零命中；历史 quay 相关任务均 done 且机制各异（多为 driver/进程，非计数聚合）。

## AC

- [x] AC1 端点契约：`GET /api/quay/fleet-summary` 返回 `{ projects: [{ projectId, driver:{state}, tasks:{total, todo, ready, needsHuman, done} }] }`；仅含存在 `.quay/config.yml` 的项目；无 quay 项目不在返回集。
- [x] AC2 TTL：2min 内二次请求不重新 spawn `quay task list`（注入 CLI spawn spy 断言 spawn 次数不变、返回 cached 标记）；TTL 过期后重新计算。
- [x] AC3 concurrency 上限：>4 个 quay 项目扇出时，同时活跃的 `quay task list` 子进程峰值 ≤4（spy 计数）。
- [x] AC4 前端渲染：项目行对 quay 项目渲染 task 计数徽标（todo/ready/needs-human，值与 fleet-summary 一致）；无 quay 项目行不变。
- [x] AC5 双视口：PC（1280px）与移动（390px）两视口下 task 计数徽标均可见（沿用 P1 双视口纪律）。
- [x] AC6 测试绿：新增 `server/modules/quay/tests/quay-fleet-summary.test.ts` + 前端测试；`npm run typecheck`、`npm run lint` 退出码 0。

## DoD

quay 项目行显示 task 计数徽标且与 `fleet-summary` 一致；TTL 内轮询不重复 spawn CLI、concurrency ≤4；AC1–AC6 测试绿且双视口通过。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/quay.routes.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/index.ts
- server/modules/quay/tests/quay-fleet-summary.test.ts
- src/modules/sidebar/SidebarProjectItem.tsx
- src/modules/sidebar/hooks/useFleetTaskCounts.ts
- src/modules/sidebar/utils/sidebarProjectFormatting.ts
- src/modules/sidebar/tests/SidebarProjectItemTaskCounts.test.tsx
- src/shared/api.ts
- src/shared/types.ts
- server/shared/tests/quay-test-script.test.ts
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx
- tasks/fleet-overview-p2-project-task-counts-fleet-summary.md

## Evidence

2026-10-19（retry round，worktree `fleet-overview-p2-project-task-counts-fleet-summary`）：实现与 6/6 AC 沿用上一轮已落地的两份提交（`b2d274e57` 端点 + 前端、`094893400` 合并 develop）；本轮只修 suite 里的三处红。

- `server/shared/tests/quay-test-script.test.ts`：本任务新增 `server/modules/quay/tests/quay-fleet-summary.test.ts` 使服务端测试文件计数 372→373，钉子读数相应重测 369→370（AC2 fixture）与 371→372（AC3 fixture）。单跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` → 14 pass / 0 fail。
- `src/modules/chat/tests/voiceClipPlayback.test.tsx`：develop `6ddb14b9d` 把听写麦克风移到 submit 右侧，桌面腿的「pair 在麦克风右侧」断言过期；改为读 shipped 布局（pair 仍在左侧 tools 组，麦克风在它右侧/文档序之后）。单跑 → 21 pass。
- `src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx`：同一提交使 submit 只在空闲时充当 Live Voice 入口（busy tier 优先），而该文件的 hook mock 恒为 `isProcessing: true`；改为可变 `state.isProcessing`，进入时短暂置空闲、进入后恢复运行中的 turn。单跑 → 8 pass。
- 本任务自身：`server/modules/quay/tests/quay-fleet-summary.test.ts` → 4 pass；`src/modules/sidebar/tests/SidebarProjectItemTaskCounts.test.tsx` → 3 pass。
- `npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning）。

## Blocker

**2026-10-19T03:50:01.412Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/modules/chat/tests/voiceClipPlayback.test.tsx: AssertionError [ERR_ASSERTION]: the pair sits right of the microphone it was recorded from [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=server/shared/tests/quay-test-script.test.ts,server/shared/tests/quay-test-script.test.ts changed=src/modules/chat/tests/voiceClipPlayback.test.tsx,src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx]
- run_id：wk-prod-anchor
- session_id：66d47dfa-74b7-4025-b515-773e51298e2a
