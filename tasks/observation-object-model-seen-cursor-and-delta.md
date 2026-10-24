---
id: observation-object-model-seen-cursor-and-delta
title: 观察墙 T1：观察层——ObservedObject / SeenCursor / 差量 API / 经驾驶舱中枢推送，定义 cloudcli:// URI
status: ready
labels:
  - cockpit
  - observation
  - contract
parent: null
children: []
extra: {}
---
## Proposal

决策出处：2026-10-24 与用户确定的「观察墙」方案（驾驶舱首先是观察面）。依据：14 天负载分析（2159 条人类输入、相邻输入一半落在不同会话、切换中位间隔 2.4 分钟；只看不打字的切换未被记录，真实观察负载更高）；用户确认观察会话输出 / quay 状态 / 架构以及为此做的切换是最大负载。硬约束（quay references）：读数三态（取不到 = 未评估 + 原因，不得显示为绿）、每盏绿灯带活性时间戳、语义判断标注「仅建议」、驾驶舱本身比被治理对象小一个量级。

方案：服务端 `observation` 模块持有被观察对象的统一模型，生产者（T2 会话、T3 项目、T4 架构）只往里写，驾驶舱只读。
1. `ObservedObject = {uri, kind:'session'|'project'|'architecture', title, status:{state:'ok'|'attention'|'red'|'unevaluated', reason?}, digest:{...按 kind 的结构化字段}, revision(单调递增), updatedAt, provenance:{producer, tier:'deterministic'|'llm', evaluatedAt}}`；每次修订追加一条 `ObservedRevision {uri, revision, at, deltaItems[]}`（差量条目：「新增 2 轮」「落地 X」「新环 A→B→A」）。
2. `SeenCursor {userId, uri, revision, at}` 存服务端 DB（跨设备一致）。差量 = 游标之后的修订条目。
3. 观察列表：`WatchEntry {userId, uri, pinnedAt}`；自动浮现规则：未钉选但 `status.state ∈ {attention, red}` 的对象临时进入墙，处理（游标前移且状态复原）后退出。墙上同时显示上限 12 块（配置项），按 状态（red > attention > ok）× 最近修订排序，超出折叠。
4. API：`GET /api/observation/wall`（墙上对象 + 各自差量）、`POST /api/observation/seen {uri, revision}`、`PUT/DELETE /api/observation/watch/:uri`；状态变化经驾驶舱中枢 websocket 推送 `observation.update`。
5. URI：会话 `cloudcli://session/<id>`，架构 `cloudcli://architecture/<fleetProjectId>`，项目沿用 `quay://<fleetProjectId>/board`。解析/格式化放在共享位置（遵守 server→根 shared 导入预算的记忆约束：前端放 src、服务端放 server，不跨根 shared）。
6. 新模块目录按 AC-394 棘轮登记 manifest 与 pin。
7. **观察层自身的活性**（用户 2026-10-24 确认）：墙安静不等于没事，生产者也会静默失败。每个生产者（session-digest、project-truth、architecture-delta，以及以后新增的）向观察层登记 `ProducerHeartbeat {producer, lastAttemptAt, lastWriteAt, lastError?, expectedIntervalMs}`；观察层按 `now - lastAttemptAt > 2 × expectedIntervalMs` 判 stale、有 lastError 判 red、从未运行判 unevaluated。`GET /api/observation/wall` 返回顶层 `producers[]`（三态 + 原因 + 时间）；任一生产者非 ok 时，墙的整体状态带一条「观察层自身」的 attention 条目，该条目不受 12 块上限的折叠。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/observation-store.test.ts` exit 0——写入修订后 revision 单调递增；游标之后的差量条目正确；游标存在 DB 中，换一个连接读到相同游标；status 为 unevaluated 时必须带 reason（缺 reason 的写入被拒）。
- [x] AC2: 同一测试文件——墙的组成：钉选对象常驻；未钉选的 attention/red 对象自动浮现，游标前移且状态复原后退出；超过上限 12 时按 red>attention>ok×最近修订排序并返回折叠数。
- [x] AC3: `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/observation-routes.test.ts` exit 0——三个 API 的成功/鉴权/非法 URI 路径；`seen` 回退游标（revision 小于现值）被忽略。
- [x] AC4: `npx vitest run src/modules/cockpit/tests/observationUri.test.ts` exit 0——`cloudcli://session/<id>`、`cloudcli://architecture/<p>` 解析/格式化往返，非法形式被拒。
- [x] AC5: `npm run typecheck` 通过；`server/shared/tests/server-import-cycle-budget.test.ts` 通过。
- [x] AC6: `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/producer-liveness.test.ts` exit 0——假时钟：生产者按期心跳时为 ok；超过 2 × expectedIntervalMs 未尝试为 stale；最近一次带 lastError 为 red；登记后从未运行为 unevaluated；任一非 ok 时 wall 响应含「观察层自身」attention 条目且不被上限折叠。

## DoD

- 用两个浏览器上下文（同一用户）验证：一端打开预览使游标前移，另一端的差量随之清零（截图存 `tmp/`）。
- 隔离实例验证必须关闭常驻会话恢复（`SERVER_SETTINGS_PATH` 指向含 `{"residentRestore":{"enabled":false}}` 的文件，或使用 T7 的隔离实例脚本），否则会对线上同一批会话重复起进程。

## Notes

### 「已看到」的写者边界（与 quay-fleet 对齐，2026-10-24；本任务不实现，只保持可演进）

写者由 URI 前缀机械推出，不另立分类表：`quay://*` 是 fleet 拥有的对象，其「已看到」将来写回 fleet attention 的 `acked`（fleet 单写）；`cloudcli://*`、`view://*`、`git://*` 由 CloudCLI 自己持有。本任务的 SeenCursor 先统一存在 CloudCLI，但游标写入要集中在一个函数里，并按 URI 前缀分派，以便下一阶段把 `quay://` 一支改成调用 fleet 的写口。接口细节等观察墙用起来、有真实数据后再定。

## Touches

- server/modules/observation/index.ts (new)
- server/modules/observation/observation.module.ts (new)
- server/modules/observation/observation-store.ts (new)
- server/modules/observation/observation.routes.ts (new)
- server/modules/observation/observation-uri.ts (new)
- server/modules/observation/tests/observation-store.test.ts (new)
- server/modules/observation/tests/observation-routes.test.ts (new)
- server/modules/observation/producer-liveness.ts (new)
- server/modules/observation/tests/producer-liveness.test.ts (new)
- server/modules/database/migrations.ts
- server/modules/database/schema.ts
- server/modules/database/index.ts
- server/modules/database/repositories/observation.repository.ts (new)
- server/modules/cockpit/cockpit-hub.service.ts
- server/modules/settings/server-settings.ts
- server/modules/settings/index.ts
- server/index.ts
- server/shared/tests/server-import-cycle-budget.test.ts
- server/shared/tests/server-import-cycle-budget.baseline.json
- config/server.settings.example.json
- src/modules/cockpit/observationUri.ts (new)
- src/modules/cockpit/tests/observationUri.test.ts (new)
- tasks/observation-object-model-seen-cursor-and-delta.md

## Blocker

**2026-10-24T08:49:13.841Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=83984 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1792831366924
- run_id：wk-prod-anchor
- session_id：aa904633-4093-4082-8e84-18a1bca9db5d
