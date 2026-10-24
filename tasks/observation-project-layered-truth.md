---
id: observation-project-layered-truth
title: 观察墙 T3：项目磁贴生产者——分层真相（在飞/落地/部署/验证/活性）+ 差量，取不到如实三态
status: todo
labels:
  - cockpit
  - observation
  - quay
parent: null
children: []
extra: {}
depends_on:
  - observation-object-model-seen-cursor-and-delta
---
## Proposal

决策出处：2026-10-24 与用户确定的「观察墙」方案（驾驶舱首先是观察面）。依据：14 天负载分析（2159 条人类输入、相邻输入一半落在不同会话、切换中位间隔 2.4 分钟；只看不打字的切换未被记录，真实观察负载更高）；用户确认观察会话输出 / quay 状态 / 架构以及为此做的切换是最大负载。硬约束（quay references）：读数三态（取不到 = 未评估 + 原因，不得显示为绿）、每盏绿灯带活性时间戳、语义判断标注「仅建议」、驾驶舱本身比被治理对象小一个量级。

负载数据：「检查进展」69 次、「检查重启是否成功」约 42 次、「Build + 安全重启」19 次——都是在问分层真相。

方案：对每个已登记到 quay-fleet 的项目，周期性（与 quay 快照同 TTL）与事件触发（任务状态变化）生成项目对象：
| 层 | 来源 | 取不到 |
|---|---|---|
| 在飞 | quay 快照 in-flight 任务与 worker 阶段 | 未评估 + 原因 |
| 落地 | 自游标以来转为 done 的任务 | — |
| 部署 | 运行版本 vs HEAD（复用 `scripts/check-deploy-freshness.mjs` 的逻辑）；目前只有 CloudCLI 自身有部署概念 | 其他项目为「不适用」，不显示绿 |
| 验证 | goal/AC 的 gate 三态（pass/fail/not-evaluated） | 未评估 |
| 活性 | driver 最近 tick、fleet 心跳时间（经 fleet CLI 读口；读口未就绪时读 `~/.quay-fleet/heartbeat.json` 并标注来源）、最近一次 gate 事件时间 | 超过阈值 ⇒ red |
差量条目：「落地 X」「X 转红」「goal Y 推进」「driver 静默 25 分钟」。状态：任一层 red ⇒ red；有 needs-human ⇒ attention。

## AC

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/project-truth.test.ts` exit 0——快照夹具生成五层读数；非 CloudCLI 项目的部署层为「不适用」且不计入绿；driver 最近 tick 超过阈值时状态为 red 且差量含静默时长；gate 结果为 not-evaluated 时该层为未评估而非绿。
- [ ] AC2: 同一测试文件——游标之后新转为 done 的任务出现在差量中、游标之前的不出现；fleet 读口不可用时活性层注明来源为心跳文件或未评估。
- [ ] AC3: `npm run typecheck` 通过。

## DoD

- 对 3 个真实项目（含 claudecodeui）贴出五层读数，并与 `quay task list`、`check-deploy-freshness`、fleet 心跳逐项核对。
- - 隔离实例验证必须关闭常驻会话恢复（`SERVER_SETTINGS_PATH` 指向含 `{"residentRestore":{"enabled":false}}` 的文件，或使用 T7 的隔离实例脚本），否则会对线上同一批会话重复起进程。

## Touches

- server/modules/observation/project-truth.ts
- server/modules/observation/project-truth.producer.ts
- server/modules/observation/tests/project-truth.test.ts
- server/modules/observation/index.ts
- server/modules/quay/quay.service.ts
- server/modules/quay/index.ts
- scripts/check-deploy-freshness.mjs
- tasks/observation-project-layered-truth.md
