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

- [x] `tsx --tsconfig server/tsconfig.json --test server/modules/notices/tests/notice-registry.test.ts` 退出码 0；用例覆盖：无忽略 → 条目在 active；忽略当前 revision → 不在 active、在 dismissed；revision 变化 → 重新在 active（N1）。
- [x] 同一测试文件覆盖：对 `deploy:failed`（blocking）的 dismiss 返回 403 且不写表；revision 与当前不符返回 409；条目不存在返回 404（N2）。
- [x] 同一测试文件覆盖：两个 userId 各自忽略互不影响；同一 userId 先后读取结果一致（N5）。
- [x] `tsx --tsconfig server/tsconfig.json --test server/modules/system/tests/deploy-notice-provider.test.ts` 退出码 0，对 §5 映射表逐行断言：`fresh` / `unknown` 无条目，`pending-build` 的 revision 等于 headSha，`building` 不新增条目且无主操作，`failure` 与 `lastDeploy.ok === false` 为 blocking。
- [x] 假形态：把忽略比较改成只按 `id` 不带 revision，N1 用例必须变红；去掉服务端对 blocking 的拒绝，N2 用例必须变红（在完成记录里贴出两次变红的输出，随后还原）。
- [x] `grep -rn "modules/system" server/modules/notices --include=*.ts` 零命中（N8）；`grep -n "notices" server/modules/system/system.module.ts` 零命中。
- [x] `npm run typecheck` 与 `npx oxlint server/modules/notices server/modules/system server/modules/database` 退出码 0。
- [x] `tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出码 0（新目录已按叶子登记，`cycleGroups` 未被撑大）。

## DoD

真实落地的标准：在隔离实例（不得在 live :3001 上触发构建或重启；复制库、关掉 residentRestore）上，用一个真实用户的登录令牌对 `GET /api/notices` 读到部署 provider 给出的真实条目（构造一个未构建的提交使 `deploy:pending-build` 出现），`POST /api/notices/deploy:pending-build/dismiss` 带当前 headSha 后该条目移入 `dismissed`，再提交一个触及 `src/` 的新提交后它重新回到 `active`；对 blocking 条目的 dismiss 真实返回 403。把四次 curl 的请求与响应原文贴进完成记录。仅有单元测试与夹具不算落地。

## Touches

- server/modules/notices/index.ts
- server/modules/notices/notice-registry.service.ts
- server/modules/notices/notices.routes.ts
- server/modules/notices/tests/notice-registry.test.ts
- server/modules/system/deploy-notice-provider.ts
- server/modules/system/index.ts
- server/modules/system/system.module.ts
- server/modules/system/tests/deploy-notice-provider.test.ts
- server/modules/database/schema.ts
- server/modules/database/index.ts
- server/modules/database/repositories/notice-dismissals.ts
- server/index.ts
- server/shared/tests/server-import-cycle-budget.baseline.json
- server/shared/tests/server-import-cycle-budget.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-notices-server-registry-and-dismissal.md

## 完成记录

实现提交：`7cde88f82`（worktree `task/gap-notices-server-registry-and-dismissal`，已 merge develop `67a34a635`）。

Touches 追加 `server/modules/system/system.module.ts`：组合根需要从 system module 取到部署读数端口（`createSystemModule` 返回值新增 `readDeployReadiness`，即 `deployService.readReadiness`），而 `notices` 不得反向 import `system`（N8），所以这个端口的暴露是必要接线；原清单漏了该文件，经 `task_write` 补声明。

### AC 逐条证据

- **AC1（N1）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/notices/tests/notice-registry.test.ts` → `pass 5 / fail 0`。用例覆盖：无忽略 → active；忽略当前 revision → 不在 active、在 dismissed；revision 变化 → 重新 active。
- **AC2（N2）**：同一文件断言 blocking dismiss 403 且 `user_notice_dismissals` 无行；revision 不符 409；条目不存在 404。另外用真实 express 路由断言同一组 HTTP 状态（200 / 409 / 404 / 403，匿名 401）。
- **AC3（N5）**：同一文件断言 user1 忽略后 user1 `dismissed`、user2 仍 `active`；同一 userId 连续两次 `list` 深比较一致。
- **AC4**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/system/tests/deploy-notice-provider.test.ts` → `pass 9 / fail 0`，§5 映射表逐行：`fresh`/`unknown` 无条目；`pending-build` revision = headSha 且有主操作；`built-pending-restart` 同一条目；`building`/`restarting` 同 id/revision 且无主操作、不新增条目；`failure !== null` 与 `lastDeploy.ok === false` 均为 blocking，revision 分别取 `failure.at` / `lastDeploy.at`。
- **AC5（假形态）**：两次变红输出见下，随后从备份还原并重跑 `pass 5 / fail 0`。
- **AC6（N8）**：两条 grep 均 0 命中（实录见下）。
- **AC7**：`npm run typecheck` 退出 0；`npx oxlint server/modules/notices server/modules/system server/modules/database` 退出 0。
- **AC8**：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` → `pass 11 / fail 0`。`modules/notices` 已登记 `directoryManifest` + `MANIFEST_PIN`（`nodeCount` 55 → 56），`cycleGroups` G1/G2/G3 未变（`modules/notices` 入边只有 `modules/system` 的 type import，无回边）。

### AC5 假形态实录（先变红，随后还原）

假形态①：忽略比较去掉 revision（`getDismissedRevision(...) !== null`）：

```
✖ N1: no dismissal → active; dismiss the current revision → dismissed; a NEW revision re-raises it (384.015502ms)
  AssertionError [ERR_ASSERTION]: a new revision is a new message: the old dismissal must not suppress it
ℹ pass 4
ℹ fail 1
```

假形态②：去掉服务端对 blocking 的拒绝（`isDismissible` 只判 lifecycle）：

```
✖ N2: a blocking notice refuses dismissal with 403 and writes no row (12.727682ms)
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✖ the router answers the four outcomes with the HTTP statuses the contract names (216.689882ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
ℹ pass 3
ℹ fail 2
```

还原后：`pass 5 / fail 0`。

### AC6 实录

```
$ grep -rn "modules/system" server/modules/notices --include=*.ts
count=0
$ grep -n "notices" server/modules/system/system.module.ts
count=0
```

### DoD 实录（隔离实例，复制库、residentRestore 关闭，127.0.0.1:31821）

实例：`ISOLATED_INSTANCE_STATE_DIR=<worktree>/tmp/notices-dod QUAY_DEPLOY_STATE_FILE=<worktree>/tmp/notices-dod/deploy-state.json bash scripts/isolated-instance.sh start` → `resident_restore_started: 0`；`dist-server/build-info.json` 的 gitSha = `7cde88f82`。

① 构造一个未构建的提交（B = `ac66b3b420fd…`，触及 `src/main.tsx`）后：

```
GET /api/system/deploy-readiness
{"status":"pending-build","pendingCommits":[{"sha":"ac66b3b420fdc70a0a7a7f64319b3e2d90bdde8e","subject":"dod probe B: src change for notices pending-build","taskId":null}],"runningSha":"7cde88f82deae8e69124a90d5662c44b821eb430","builtSha":"7cde88f82deae8e69124a90d5662c44b821eb430","clientBuiltSha":null,"headSha":"ac66b3b420fdc70a0a7a7f64319b3e2d90bdde8e","lastDeploy":null,"failure":null,"checkedAt":"2026-10-25T03:25:39.084Z"}

GET /api/notices
{"active":[{"id":"deploy:pending-build","source":"deploy","lifecycle":"condition","severity":"attention","revision":"ac66b3b420fdc70a0a7a7f64319b3e2d90bdde8e","scope":"global","title":"notices.deploy.pendingBuild.title","params":{"count":1,"headSha":"ac66b3b420fdc70a0a7a7f64319b3e2d90bdde8e"},"primaryAction":{"id":"deploy.build-and-restart","labelKey":"notices.deploy.pendingBuild.action"},"raisedAt":"2026-10-25T03:25:39.084Z"}],"dismissed":[]}
```

② 带当前 headSha 忽略：

```
POST /api/notices/deploy:pending-build/dismiss {"revision":"ac66b3b420fdc70a0a7a7f64319b3e2d90bdde8e"}
{"ok":true}
HTTP 200
```

③ 重新读取，条目移入 dismissed：

```
GET /api/notices
{"active":[],"dismissed":[{"id":"deploy:pending-build","source":"deploy","lifecycle":"condition","severity":"attention","revision":"ac66b3b420fdc70a0a7a7f64319b3e2d90bdde8e","scope":"global","title":"notices.deploy.pendingBuild.title","params":{"count":1,"headSha":"ac66b3b420fdc70a0a7a7f64319b3e2d90bdde8e"},"primaryAction":{"id":"deploy.build-and-restart","labelKey":"notices.deploy.pendingBuild.action"},"raisedAt":"2026-10-25T03:25:39.084Z"}]}
```

④ 再提交一个触及 `src/` 的新提交（C = `0a9190175ed2…`）后重新回到 active：

```
GET /api/notices
{"active":[{"id":"deploy:pending-build","source":"deploy","lifecycle":"condition","severity":"attention","revision":"0a9190175ed259242749223e6259ed84102951eb","scope":"global","title":"notices.deploy.pendingBuild.title","params":{"count":2,"headSha":"0a9190175ed259242749223e6259ed84102951eb"},"primaryAction":{"id":"deploy.build-and-restart","labelKey":"notices.deploy.pendingBuild.action"},"raisedAt":"2026-10-25T03:25:50.665Z"}],"dismissed":[]}
```

⑤ blocking 条目的 dismiss 真实返回 403（隔离实例的 deploy state 文件写入 `failure` 后）：

```
GET /api/notices
{"active":[{"id":"deploy:failed","source":"deploy","lifecycle":"condition","severity":"blocking","revision":"2026-10-25T03:26:00.000Z","scope":"global","title":"notices.deploy.failed.title","params":{"step":"build","at":"2026-10-25T03:26:00.000Z"},"raisedAt":"2026-10-25T03:26:00.000Z"}],"dismissed":[]}

POST /api/notices/deploy:failed/dismiss {"revision":"2026-10-25T03:26:00.000Z"}
{"success":false,"error":{"code":"NOTICE_NOT_DISMISSIBLE","message":"Notice deploy:failed is not dismissible"}}
HTTP 403
```

隔离库实读：`user_notice_dismissals` 只有 `(user_id=1, notice_id='deploy:pending-build', revision='ac66b3b420…')` 一行；403 那次未写行。验证后已 `isolated-instance.sh stop`（`ok:true`、无残留 scope）并 `git reset --hard 7cde88f82` 丢弃 B/C 两个探针提交。

### 续跑轮（2026-10-25）：suite 红是本任务新增测试文件顶破了计数 pin

上一轮 `exited-not-landed` 的 suite 红（`server/shared/tests/quay-test-script.test.ts`，rc=1）经隔离复跑确认不是环境抖动，而是本任务自己的 delta：两个新判据文件把 `find server -name '*.test.ts' -o -name '*.test.js'` 的收集数 437 → 439，三条腿同时红：

- AC7：`baseline covers 394/439 collected files (< 90%)`（89.75%）；
- AC2 dispatch pin：实读 `known=3 unknown=436`，钉的是 434；
- AC3 dispatch pin：实读 `known=1 unknown=438`，钉的是 436。

修法（提交 `7a464cc0e`）：

1. `scripts/suite-duration-baseline.tsv` 追加两行，实测 `2879` / `1872` ms（单文件 `npx tsx --tsconfig server/tsconfig.json --test <file>` 量的），覆盖回到 `396/439 = 90.2%`；头部收集数同步 427 → 439。
2. `server/shared/tests/quay-test-script.test.ts` 两条 exact pin 移到 `unknown=436` / `unknown=438`，注释里的收集数与来源记到 439。
3. 两个文件经 `task_write` 补进 `## Touches`（否则 anti-drift 报 out-of-declared）。

复量：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` → `pass 14 / fail 0`（80.5s）。两个新判据文件本身仍为 `pass 5 / fail 0` 与 `pass 9 / fail 0`。
