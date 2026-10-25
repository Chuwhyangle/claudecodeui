---
id: gap-notices-server-registry-and-dismissal
title: Notice 注册表 P1（服务端）：notices module + 按用户的忽略表 + GET /api/notices + POST
  dismiss + 部署 provider
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

出处：`docs/proposals/notice-registry-and-dismissal.md`（P1 的服务端半边，用户 2026-10-25 确认：忽略状态存服务端、打断位同时只显示 1 条加折叠、先只接部署）。起因是聊天页顶部的部署 banner（`DeployReadiness compact`）无法关闭，而系统里「需要人知道的事」散落在三套互不相通的实现里。

本任务只做服务端，客户端另有任务 `gap-notices-client-slot-replaces-compact-deploy-strip`，依赖本任务提供的接口。

<!-- dedup-ref -->相关但不同机制：`deploy-readiness-build-and-safe-restart`（已完成）提供部署读数与 `POST /api/system/deploy`，本任务只把它的读数适配成 Notice，不改其读数与执行逻辑。已用 task-granularity-advice 核对：Touches 与任何开放任务无重叠，决定 separate（独立的服务端交付物，客户端任务以 depends_on 排在其后）。

做什么：
1. 新 module `server/modules/notices/`（遵循 `$backend-module-standards`：叶子目录、`index.ts` barrel、测试放 `tests/`、不建 module 内 types/utils 文件）。其中 `notice-registry.service.ts` 持有 `NoticeProvider[]`（`{ source, read(): Promise<Notice[]> }`），`list(userId)` 汇总各 provider 的条目、套用忽略、排序后返回 `{ active, dismissed }`。`Notice` 含 `id / source / lifecycle('event'|'condition'|'decision') / severity('info'|'attention'|'blocking') / revision / scope('global') / title(i18n key) / params / primaryAction? / raisedAt`；P1 只实现 condition，其余两种只留类型不接线。
2. 忽略表：`user_notice_dismissals(user_id, notice_id, revision, dismissed_at)`，主键 `(user_id, notice_id)`，写入为 upsert（只保留最近一次忽略的 revision）；schema 写进 `server/modules/database/schema.ts`，仓库 `repositories/notice-dismissals.ts` 经 `database/index.ts` barrel 导出。
3. 路由 `notices.routes.ts`（薄路由）：`GET /api/notices` → `{ active, dismissed }`；`POST /api/notices/:id/dismiss` body `{ revision }`。服务端校验条目存在、请求的 revision 等于当前 revision、`severity !== 'blocking'`；不满足分别返回 404 / 409 / 403，不静默成功。经 `authenticateToken` 挂载，userId 取自认证用户。
4. 部署 provider：由 `system` module 导出一个把 `deployService.readReadiness()` 映射成 Notice 的 provider，由 `server/index.ts`（组合根）注入注册表；`notices` 不得 import `system`（N8）。映射：`fresh` 与 `unknown` 无条目；`pending-build` / `built-pending-restart` → `deploy:pending-build`（condition / attention，`revision = headSha`，主操作「构建并重启」）；`building` / `restarting` 为同一条目的进行中态且不带主操作；`failure !== null` 或 `lastDeploy.ok === false` → `deploy:failed`（condition / blocking，`revision = failure.at` 或 `lastDeploy.at`，不可忽略）。
5. 不改 `notifications` module，也不改 `POST /api/system/deploy` 与部署读数。

AC-394 提示：`server/modules/notices` 是新目录，`server/index.ts` 会 import 它；按仓库惯例需要在 `server/shared/tests/server-import-cycle-budget.baseline.json` 的 `directoryManifest`、该测试里的 `MANIFEST_PIN`、并同步 `nodeCount` 登记，保持叶子（不加入任何环）。

## AC

- [ ] `tsx --tsconfig server/tsconfig.json --test server/modules/notices/tests/notice-registry.test.ts` 退出码 0；用例覆盖：无忽略 → 条目在 active；忽略当前 revision → 不在 active、在 dismissed；revision 变化 → 重新在 active（N1）。
- [ ] 同一测试文件覆盖：对 `deploy:failed`（blocking）的 dismiss 返回 403 且不写表；revision 与当前不符返回 409；条目不存在返回 404（N2）。
- [ ] 同一测试文件覆盖：两个 userId 各自忽略互不影响；同一 userId 先后读取结果一致（N5）。
- [ ] `tsx --tsconfig server/tsconfig.json --test server/modules/system/tests/deploy-notice-provider.test.ts` 退出码 0，对 §5 映射表逐行断言：`fresh` / `unknown` 无条目，`pending-build` 的 revision 等于 headSha，`building` 不新增条目且无主操作，`failure` 与 `lastDeploy.ok === false` 为 blocking。
- [ ] 假形态：把忽略比较改成只按 `id` 不带 revision，N1 用例必须变红；去掉服务端对 blocking 的拒绝，N2 用例必须变红（在完成记录里贴出两次变红的输出，随后还原）。
- [ ] `grep -rn "modules/system" server/modules/notices --include=*.ts` 零命中（N8）；`grep -n "notices" server/modules/system/system.module.ts` 零命中。
- [ ] `npm run typecheck` 与 `npx oxlint server/modules/notices server/modules/system server/modules/database` 退出码 0。
- [ ] `tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出码 0（新目录已按叶子登记，`cycleGroups` 未被撑大）。

## DoD

真实落地的标准：在隔离实例（不得在 live :3001 上触发构建或重启；复制库、关掉 residentRestore）上，用一个真实用户的登录令牌对 `GET /api/notices` 读到部署 provider 给出的真实条目（构造一个未构建的提交使 `deploy:pending-build` 出现），`POST /api/notices/deploy:pending-build/dismiss` 带当前 headSha 后该条目移入 `dismissed`，再提交一个触及 `src/` 的新提交后它重新回到 `active`；对 blocking 条目的 dismiss 真实返回 403。把四次 curl 的请求与响应原文贴进完成记录。仅有单元测试与夹具不算落地。

## Touches

- server/modules/notices/index.ts
- server/modules/notices/notice-registry.service.ts
- server/modules/notices/notices.routes.ts
- server/modules/notices/tests/notice-registry.test.ts
- server/modules/system/deploy-notice-provider.ts
- server/modules/system/index.ts
- server/modules/system/tests/deploy-notice-provider.test.ts
- server/modules/database/schema.ts
- server/modules/database/index.ts
- server/modules/database/repositories/notice-dismissals.ts
- server/index.ts
- server/shared/tests/server-import-cycle-budget.baseline.json
- server/shared/tests/server-import-cycle-budget.test.ts
- tasks/gap-notices-server-registry-and-dismissal.md
