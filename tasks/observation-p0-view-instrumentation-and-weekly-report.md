---
id: observation-p0-view-instrumentation-and-weekly-report
title: 观察墙 T0：本地查看事件埋点（会话/tab 打开、停留、来源）+ 负载周报脚本入库
status: todo
labels:
  - cockpit
  - observation
  - metrics
parent: null
children: []
extra: {}
---
## Proposal

决策出处：2026-10-24 与用户确定的「观察墙」方案（驾驶舱首先是观察面）。依据：14 天负载分析（2159 条人类输入、相邻输入一半落在不同会话、切换中位间隔 2.4 分钟；只看不打字的切换未被记录，真实观察负载更高）；用户确认观察会话输出 / quay 状态 / 架构以及为此做的切换是最大负载。硬约束（quay references）：读数三态（取不到 = 未评估 + 原因，不得显示为绿）、每盏绿灯带活性时间戳、语义判断标注「仅建议」、驾驶舱本身比被治理对象小一个量级。

问题：负载分析只能看到打字的输入，看不到「点开会话读输出、切去 Quay/架构 tab 看状态」这类只看不打字的切换，而它正是用户确认的最大负载。没有基线就无法衡量观察墙是否真的减负。

方案：
1. 前端记录查看事件：`{at, kind:'session'|'tab'|'cockpit-tile'|'cockpit-preview', target(uri 或 session id/tab 名), fromTarget, dwellMs, deviceId}`；进入/离开、页面可见性变化时结算停留时长。批量（每 30 秒或 50 条）POST 到服务端。
2. 服务端只追加写本机文件 `~/.cloudcli/ui-view-events.jsonl`（路径可在 `server.settings.json` 的 `observation.viewEvents` 块配置，含开关，默认开），不出本机、不进数据库同步。
3. 把 `/tmp/workload-analysis/` 的分析脚本整理进仓库 `scripts/workload-report/`（Python，`-I` 运行），新增读取查看事件：每日观察型切换次数、停留分布、按目标类型（会话/Quay/架构/驾驶舱）的占比、驾驶舱内预览 vs 跳转的比例；输出 Markdown 周报。

## AC

- [ ] AC1: `npx vitest run src/shared/tests/viewEvents.test.ts` exit 0——进入与离开一个会话产生一条带 dwellMs 的事件；页面隐藏时结算并暂停计时；批量阈值触发一次上报（假定时器 + 桩 fetch 计数）；关闭开关后不上报。
- [ ] AC2: `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/view-events.test.ts` exit 0——上报写入配置路径的 jsonl、逐行合法 JSON；超过单批上限或非法字段被拒绝；开关关闭时返回 204 不写入。
- [ ] AC3: `python3 -I scripts/workload-report/report.py --fixture scripts/workload-report/testdata --out /tmp/wr-test.md` exit 0，输出包含「观察型切换」「停留」「按目标类型」三节；对夹具的计数与手算一致（脚本自带 `--self-check` 断言）。
- [ ] AC4: `npm run typecheck` 通过。

## DoD

- 真实使用半天后跑一次周报，贴出观察型切换次数与按目标类型占比（这是观察墙的基线）。
- **浏览器实际操作 + 截图（必做）**，截图存 `tmp/`；场景运行器可用时补场景与报告（AGENTS.md「UI 验证」）。——在会话、Quay tab、架构 tab 之间切换几次，确认 jsonl 里出现对应事件。

## Touches

- src/shared/viewEvents.ts (new)
- src/shared/tests/viewEvents.test.ts (new)
- src/App.tsx
- server/modules/observation/index.ts (new)
- server/modules/observation/observation.module.ts (new)
- server/modules/observation/view-events.routes.ts (new)
- server/modules/observation/view-events.service.ts (new)
- server/modules/observation/tests/view-events.test.ts (new)
- server/index.ts
- config/server.settings.example.json
- server/shared/tests/server-import-cycle-budget.test.ts
- scripts/workload-report/report.py (new)
- scripts/workload-report/README.md (new)
- scripts/workload-report/testdata/sample.jsonl (new)
- tasks/observation-p0-view-instrumentation-and-weekly-report.md
