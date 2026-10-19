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

- [ ] AC1 端点契约：`GET /api/quay/fleet-summary` 返回 `{ projects: [{ projectId, driver:{state}, tasks:{total, todo, ready, needsHuman, done} }] }`；仅含存在 `.quay/config.yml` 的项目；无 quay 项目不在返回集。
- [ ] AC2 TTL：2min 内二次请求不重新 spawn `quay task list`（注入 CLI spawn spy 断言 spawn 次数不变、返回 cached 标记）；TTL 过期后重新计算。
- [ ] AC3 concurrency 上限：>4 个 quay 项目扇出时，同时活跃的 `quay task list` 子进程峰值 ≤4（spy 计数）。
- [ ] AC4 前端渲染：项目行对 quay 项目渲染 task 计数徽标（todo/ready/needs-human，值与 fleet-summary 一致）；无 quay 项目行不变。
- [ ] AC5 双视口：PC（1280px）与移动（390px）两视口下 task 计数徽标均可见（沿用 P1 双视口纪律）。
- [ ] AC6 测试绿：新增 `server/modules/quay/tests/quay-fleet-summary.test.ts` + 前端测试；`npm run typecheck`、`npm run lint` 退出码 0。

## DoD

quay 项目行显示 task 计数徽标且与 `fleet-summary` 一致；TTL 内轮询不重复 spawn CLI、concurrency ≤4；AC1–AC6 测试绿且双视口通过。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/quay.routes.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/index.ts
- server/modules/quay/tests/quay-fleet-summary.test.ts
- src/modules/sidebar/SidebarProjectItem.tsx
- src/modules/sidebar/utils/sidebarProjectFormatting.ts
- src/modules/sidebar/tests/SidebarProjectItemTaskCounts.test.tsx
- tasks/fleet-overview-p2-project-task-counts-fleet-summary.md
