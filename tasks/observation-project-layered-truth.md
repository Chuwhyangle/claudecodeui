---
id: observation-project-layered-truth
title: 观察墙 T3：项目磁贴生产者——分层真相（在飞/落地/部署/验证/活性）+ 差量，取不到如实三态
status: done
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
| 活性 | 目标契约：`quay-fleet liveness --json`（fleet 任务 `fleet-liveness-read-port`：`fleet.{state,lastTickAt,ageSec}`、`projects[].driver.{state,ageSec}`、`lastGateAt`、`halted`，三态 ok/stale/unknown，stale 阈值由 fleet 配置）。**过渡期读 `quay-fleet status --json`**（已存在：`projects[].drivers.{worker,promotion,goal,outer}.state/ageSec/anchorAlive` 与 heartbeat 的 service 段）；不要只读 `~/.quay-fleet/heartbeat.json`——它没有每项目 driver 状态。读法集中在一个函数里，liveness 落地后只换这一处 | stale ⇒ red；unknown ⇒ 未评估 + 原因 |
差量条目：「落地 X」「X 转红」「goal Y 推进」「driver 静默 25 分钟」。状态：任一层 red ⇒ red；有 needs-human ⇒ attention。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/project-truth.test.ts` exit 0——快照夹具生成五层读数；非 CloudCLI 项目的部署层为「不适用」且不计入绿；driver 最近 tick 超过阈值时状态为 red 且差量含静默时长；gate 结果为 not-evaluated 时该层为未评估而非绿。
- [x] AC2: 同一测试文件——游标之后新转为 done 的任务出现在差量中、游标之前的不出现；fleet 读口不可用时活性层为未评估并带原因；桩 `status --json` 与桩 `liveness --json` 两种输入都能得出同样的五层读数。
- [x] AC3: `npm run typecheck` 通过。

## DoD

- 对 3 个真实项目（含 claudecodeui）贴出五层读数，并与 `quay task list`、`check-deploy-freshness`、fleet 心跳逐项核对。
- 隔离实例验证必须关闭常驻会话恢复（`SERVER_SETTINGS_PATH` 指向含 `{"residentRestore":{"enabled":false}}` 的文件，或使用 T7 的隔离实例脚本），否则会对线上同一批会话重复起进程。

## Touches

- server/modules/observation/project-truth.ts
- server/modules/observation/project-truth.producer.ts
- server/modules/observation/tests/project-truth.test.ts
- server/modules/observation/index.ts
- server/modules/quay/quay.service.ts
- server/modules/quay/index.ts
- scripts/check-deploy-freshness.mjs
- server/shared/tests/quay-test-script.test.ts
- tasks/observation-project-layered-truth.md

## Evidence

- AC1/AC2 — `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/project-truth.test.ts` → 10/10 passed. Covers: five layers from one snapshot fixture (在飞 phase/task, 落地 window, 部署 fresh, 验证 pass, 活性 age) with an activity instant on every green layer; a non-CloudCLI project (`deploy: null`) reading 部署 `not-applicable` while a deliberately failing deploy reader is ignored (and no 「部署 红」 delta); a 1500s-silent driver reading the object `red` with 「driver 静默 25 分钟」; an active AC with gate `not-evaluated` reading the layer `unevaluated` (object attention, never green); needs-human → attention; producer cursor semantics (first read claims no landings; only a task done after the previous observation appears as 「落地」); a failed task-list read preserving the landing cursor so a later read still catches that window; an unavailable fleet port reading 活性 `unevaluated` with its reason; and stubbed `liveness --json` + `status --json` documents normalizing to the identical five layers and delta.
- AC3 — `npm run typecheck` exit 0 (client, server and scripts projects; the new `--json` switch in `scripts/check-deploy-freshness.mjs` type-checks under `scripts/tsconfig.json` as well).
- New server test file — `server/shared/tests/quay-test-script.test.ts` pins the collected file count, so the two numbers were re-measured for the added criterion: 419 → 420 collected, AC2 `known=3 unknown=417`, AC3 `known=1 unknown=419`; that criterion passes 14/14, and the AC-394 import-cycle budget criterion passes 11/11 with the new `modules/observation → modules/quay` type/reader edge (no new SCC, no manifest change).
- DoD manual pass — a throwaway probe (in `tmp/`, not committed) built the same readings from real sources: `quay task list --json --no-body`, `quay goal list --json`, `quay lanes --json --window-hours 3` (in-flight = intervals with `finalState === null`), `quay-fleet liveness --json` through the shipping reader, and `scripts/check-deploy-freshness.mjs --json` with a 24h landing window.
  - Fleet liveness (source `liveness`, at 2026-10-24T10:39:23Z): quay-fleet ok/2s, quay ok/4s, claudecodeui ok/1s, archguard ok/9s, plantuml-js ok/4s. Cross-checked against `~/.quay-fleet/heartbeat.json` (tick 218, at 10:39:07Z, errors 0) and `quay-fleet status --json` (`anchorAlive: true`, worker state `ok` for all five).
  - claudecodeui: tasks `{done:1031, ready:12, superseded:20}` — exactly the counts in `quay-fleet status --json`; 在飞 5 (`observation-project-layered-truth@implementing`, `architecture-readout-minimap-hover-layout@implementing`, `gap-reply-suggestions-model-chip-fill-only@implementing`, `observation-prediction-scoring-24h-ratios@fan-in`, `gap-reply-suggestions-compact-footer-icon-only-suggest@implementing`); 落地 36 in 24h; 部署 red — `{"verdict":"stale","buildSha":"2d995e88e0d90b219991fb4455cc07259b0d8abb","refSha":"54f928b91435a454dd1db355f08b9046d472ddec","behindBy":61}` (the live server is 61 commits behind HEAD); 验证 unevaluated (4/282 AC gates not-evaluated, 0 failing); 活性 ok age 1s.
  - quay: tasks `{done:2908, todo:1, ready:2, superseded:75}` — exact match with the fleet status counts; 在飞 0; 落地 14 in 24h; 部署 not-applicable; 验证 red (2 failing / 3 not-evaluated of 227); 活性 ok age 23s.
  - quay-fleet: tasks `{done:173, needs-human:1, superseded:9}` — exact match; 在飞 0; 落地 7 in 24h; 部署 not-applicable; 验证 red (5 failing / 1 not-evaluated of 82); 活性 ok age 0s.
  - The deploy layer was read with the updated script from this worktree against the running instance and main's HEAD, because the running checkout still carries the pre-`--json` script; after fan-in the shipped script is the one the producer invokes.
- Isolated-instance note — no server instance was started for this task (the producer is a primitive; the composition root wiring lands with the wall UI task), so the resident-restore constraint never came into play.
