---
id: gap-observer-token-residue-on-live-auth-db
title: 生产 auth.db 上的 observer 探针残留：给 mint-token 增可复核的 sweep（dry-run/apply/自证），并清掉现存那一行
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状（2026-10-11 复核）：生产库 `~/.cloudcli/auth.db`（服务端签名/验签与 users 判定用的就是它）的 `users` 表里有一行探针残留：`id=7`、`username='observer-20261010T123639Z-abd91964bd19'`、`is_active=1`、`created_at='2026-10-10 12:36:39'`（UTC，= 本地 20:36）、`last_login` 为 null。这正是 `scripts/mint-token.mjs` 铸造时创建的「一次性 subject」（该工具的 invariant 1：token 绑在它新建的 users 行上，revoke = 删掉这一行并自证 401），而那一次**没有执行 revoke**。工具自带的 30 分钟 TTL 让那个 token 早已无害，但这一行留在生产库里；这类残留会随每次「mint 了没 revoke」累积而无人复核，而且它本身就证明探针是直接对**生产库**操作的（工具设计如此——它必须用目标库自己的 `jwt_secret` 签名），所以「谁在生产库上留下了什么」需要一个可复核的清点手段。

对照复核（不夸大）：`access_tokens` 现有 134 行经查是 OAuth 轮转的正常历史（66 `oauth_access` / 66 `oauth_refresh`，其中 63 个 refresh 的 `revoked_at` 是轮转时主动撤销的）加上 2 个 operator 自己的 `pat` 行——**不是残留，本任务不碰**。真正的残留就是上面那一行 observer 用户。

修法：给 `scripts/mint-token.mjs` 增 `sweep` 子命令——`node scripts/mint-token.mjs sweep --db <auth.db> [--apply]`：默认 dry-run，列出所有 `username LIKE 'observer-%'` 的行（id、username、created_at、是否已过 TTL）；`--apply` 时删除这些行并像 `revoke` 一样**自证**（删后 SELECT 为空 + 打印删除行数）。硬约束：匹配只认 `observer-` 前缀，前缀不匹配的行一个都不删（尤其 operator 行）；退出码沿用既有 `EXIT_OK/EXIT_REFUSED/EXIT_USAGE` 语义。`scripts/mint-token.test.mjs` 就地加用例（**不新增测试文件**）。

非目标：不改 mint/probe/revoke 的既有语义与那 6 条 invariant；不清理 `access_tokens` 与 `oauth_*` 表（那是轮转历史）；不动 `users` 表里任何非 `observer-` 前缀的行；不实现自动定时清理（「要不要定期 sweep」是运维决定，不是本任务的实现内容）。

<!-- dedup-ref -->
去重（按机制）：`gap-scripts-static-gates-and-mint-token`（done）把 `scripts/` 纳入静态门禁并新增该工具本身，`gap-session-lapse-only-on-server-401`（todo）是客户端会话判据——两者机制都不同；本任务是**探针残留的可清点/可清理**。merge 候选检查 `task-granularity-advice.js --touches scripts/mint-token.mjs --touches scripts/mint-token.test.mjs` 返回 `peers: []`。

## AC

- [x] AC1 红态基线逐字记录（改动前）：`node scripts/mint-token.mjs sweep --db <隔离副本>` ⇒ 该子命令尚不存在，逐字记录 usage/错误输出与退出码。
- [x] AC2 dry-run 只列不删：在**隔离副本**（把真库拷到临时目录，绝不直接对 `~/.cloudcli/auth.db` 做实验）上跑 `sweep --db <copy>`（不带 `--apply`）⇒ 打印 observer 行清单，且 `SELECT COUNT(*) FROM users` 前后读数相同。
- [x] AC3 `--apply` 只删 observer 行：同一副本上 `sweep --apply` ⇒ observer 行消失；把前后 `SELECT id,username,is_active,created_at FROM users` 的全量输出逐字对比，**必须只少掉了 observer 行**，operator 行（`username='yale'`）与其它任何非 observer 行逐字不变；且工具自证输出的删除行数与实际差值一致。
- [x] AC4 幂等与空集：再跑一次 `sweep --apply` ⇒ 删除数 0、退出 0（不是错误也不是 usage）。
- [x] AC5 判据就地加：`scripts/mint-token.test.mjs` 增用例覆盖 AC2–AC4（全部在临时库上，不碰真库），`node --test scripts/mint-token.test.mjs` 单文件运行退出 0，写下 passed/总数。
- [ ] AC6 真库清理读数：对 `~/.cloudcli/auth.db` 执行 `sweep --apply`，把命令与前后 `SELECT id,username FROM users` 逐字读数贴进 Notes；该行只能由人在生产库上确认后删除，执行者不得自行代跑（待外部）
- [x] AC7 取假形态（先提交实现再变异，逐条记录变异 diff、逐字红行与恢复命令）：把 `sweep` 的匹配条件从 `observer-%` 放宽成 `%`（或去掉前缀过滤）⇒ AC3 的「operator 行逐字不变」断言红；恢复后回绿。
- [x] AC8 范围纪律：`git diff --name-only develop...HEAD -- scripts/` 只列出 `scripts/mint-token.mjs` 与 `scripts/mint-token.test.mjs`；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐。

## DoD

- 真实对象走通（不是只写代码）：在**真库的副本**上依次跑 dry-run → `--apply` → 再 `--apply`（幂等）三次真实运行，把三次的逐字输出与三次 `users` 全量读数贴进 Notes，证明「只删 observer 行」这件事是被量出来的、不是被断言的。
- 生产库那一行由人在场时清理，命令与前后读数入 Notes（AC6）。
- 输出无秘密：`sweep` 的任何输出只含 username/id/created_at/TTL 判定，不含任何 token、hash 或 provider 材料（判据里断言）。
- 遵守 AGENTS.md；无新依赖；脚本测试单文件运行，不做无界扇出。

## Touches

- scripts/mint-token.mjs（新增 sweep 子命令：默认 dry-run、只匹配 observer- 前缀、自证删除行数；mint/probe/revoke 语义不变）
- scripts/mint-token.test.mjs（就地加 sweep 用例：dry-run/apply/幂等/只碰 observer 前缀，全部临时库）
- tasks/gap-observer-token-residue-on-live-auth-db.md

## Notes

worker 记录（2026-10-11）。实现：`scripts/mint-token.mjs` 新增 `sweep` 子命令（导出 `listObserverSubjects` / `parseSqliteUtc` / `sweepObserverSubjects`，`parseArgs` 加 `--apply` 布尔旗标），`scripts/mint-token.test.mjs` 就地加 6 个用例。代码提交：`8a4f8dc6 feat(mint-token): add sweep subcommand to clear leftover observer-* subjects`（分支 `task/gap-observer-token-residue-on-live-auth-db`，从 develop `f1bbe4b6` 分叉）。

匹配谓词是**单个** `username.startsWith(OBSERVER_PREFIX)`（大小写敏感、位置 0），与 `revoke` 同一条；`--apply` 逐行 `DELETE ... WHERE id = ? AND username = ?`，随后重读 observer 集合自证为空、删除行数与列出数一致，否则拒绝报成功（沿用 `revoke` invariant 5 的形状）。`sweep` 不签名、不读 `jwt_secret`，故不调用 `assertNoServerSecret`。

### AC1 红态基线（改动前，逐字）

```
$ node scripts/mint-token.mjs sweep --db /tmp/mint-sweep-probe/auth.db
mint-token: unknown command: sweep
usage:
  node scripts/mint-token.mjs mint   --db <auth.db> --out <token-file> [--ttl-minutes N]
  node scripts/mint-token.mjs probe  --token-file <f> --base-url <url>
                                     [--method GET|POST] [--path /api/auth/user] [--out <file>]
  node scripts/mint-token.mjs revoke --db <auth.db> --token-file <f> --base-url <url>
                                     [--path /api/auth/user]
EXIT=2
```

（带 `--apply` 同法基线：`mint-token: --apply needs a value` + 同一 usage，`EXIT=2`。）

### AC2 / AC3 / AC4 / DoD —— 真库副本三次真实运行（逐字）

真库读数（只读，未被本任务改动）：`users` 两行 —— `id=1 username=yale`、`id=7 username=observer-20261010T123639Z-abd91964bd19`（`created_at=2026-10-10 12:36:39`）。以下全部在**副本** `/tmp/mint-sweep-probe/real.db`（`cp ~/.cloudcli/auth.db`）上执行：

```
### COPY: cp ~/.cloudcli/auth.db /tmp/mint-sweep-probe/real.db
### R0 (users before any run):
[{"id":1,"username":"yale","is_active":1,"created_at":"2026-09-19 14:37:51","last_login":"2026-10-10 15:51:39"},{"id":7,"username":"observer-20261010T123639Z-abd91964bd19","is_active":1,"created_at":"2026-10-10 12:36:39","last_login":null}]

### RUN 1: node scripts/mint-token.mjs sweep --db /tmp/mint-sweep-probe/real.db   (dry run)
sweep (dry run): 1 observer subject(s) in /tmp/mint-sweep-probe/real.db
  id=7 username=observer-20261010T123639Z-abd91964bd19 created_at=2026-10-10 12:36:39 ttl=expired
nothing deleted (dry run); re-run with --apply to delete
EXIT=0
### R1 (users after RUN 1):
[{"id":1,"username":"yale","is_active":1,"created_at":"2026-09-19 14:37:51","last_login":"2026-10-10 15:51:39"},{"id":7,"username":"observer-20261010T123639Z-abd91964bd19","is_active":1,"created_at":"2026-10-10 12:36:39","last_login":null}]

### RUN 2: node scripts/mint-token.mjs sweep --db /tmp/mint-sweep-probe/real.db --apply
sweep --apply: 1 observer subject(s) in /tmp/mint-sweep-probe/real.db
  id=7 username=observer-20261010T123639Z-abd91964bd19 created_at=2026-10-10 12:36:39 ttl=expired
deleted 1 observer subject row(s)
verified: no observer-* row remains
EXIT=0
### R2 (users after RUN 2):
[{"id":1,"username":"yale","is_active":1,"created_at":"2026-09-19 14:37:51","last_login":"2026-10-10 15:51:39"}]

### RUN 3 (idempotent): node scripts/mint-token.mjs sweep --db /tmp/mint-sweep-probe/real.db --apply
sweep --apply: 0 observer subject(s) in /tmp/mint-sweep-probe/real.db
deleted 0 observer subject row(s)
verified: no observer-* row remains
EXIT=0
### R3 (users after RUN 3):
[{"id":1,"username":"yale","is_active":1,"created_at":"2026-09-19 14:37:51","last_login":"2026-10-10 15:51:39"}]
```

读数判定：`R0 == R1`（dry-run 零改动，AC2）；`R1 → R2` 只少掉 `id=7`，`id=1 username=yale` 逐字不变，自证 `deleted 1` = 实际差值 1（AC3）；`RUN 3` = `deleted 0`、`EXIT=0`，`R2 == R3`（AC4）。AC3 的逐字断言即 `scripts/mint-token.test.mjs` 里的 `assert.deepEqual(after, before.filter(...))`，本 DoD 读数与它同构。

### AC5

```
$ node --test scripts/mint-token.test.mjs
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
（退出 0）
```

新增 6 个用例：dry-run 只列不删并报 TTL、`--apply` 只删 observer 行（operator 与含 "observer" 的 look-alike 行逐字不变、删除数=差值）、幂等（第二次 `deleted 0`/`EXIT 0`）、输出无 token/hash/secret、`sweepObserverSubjects` 前缀是唯一谓词（`Observer-UPPER` 与 `xobserver-prefix` 均存活）、`parseSqliteUtc`。全部在 `makeDb()` 临时库上，不碰真库。

### AC7 取假形态（先提交实现，再变异）

变异 diff（对已提交的 `8a4f8dc6` 工作树）：
```
-    .filter((row) => row.username.startsWith(OBSERVER_PREFIX))
+    .filter(() => true) // FALSIFICATION (AC7): prefix filter widened away
```
逐字红行（`node --test scripts/mint-token.test.mjs`，4 个 sweep 用例红，其中 AC3 用例）：
```
✖ sweep --apply deletes exactly the observer-* rows and leaves every other row byte-identical
  AssertionError [ERR_ASSERTION]: only the observer-* rows may change
  + actual - expected
  + []
  - [ { created_at: '…', id: 1, is_active: 1, username: 'yale' },
      { created_at: '…', id: 2, is_active: 1, username: 'not-observer-1' } ]
```
恢复命令：`git checkout -- scripts/mint-token.mjs` ⇒ 重跑 `15 pass / 0 fail` 回绿。

### AC8 范围纪律

```
$ git diff --name-only develop...HEAD -- scripts/
scripts/mint-token.mjs
scripts/mint-token.test.mjs
$ git diff --stat develop...HEAD
 scripts/mint-token.mjs      | 151 ++++++++++++++++++++++++++++++++++++++++++-
 scripts/mint-token.test.mjs | 154 ++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 303 insertions(+), 2 deletions(-)
$ npm run typecheck   # 退出 0
$ npm run lint        # 无 `: error ` 行（grep -c ': error ' = 0，仅 warning）
```
与 `## Touches` 对齐：脚本两条即上述两文件；第三条 `tasks/<id>.md` 由 `task_write` 自身提交（不经工作树 diff）。

### AC6（待外部）

未对 `~/.cloudcli/auth.db` 执行 `sweep --apply`——按 AC6 要求，该清理由人在生产库上确认后执行。真库现仍为 `id=7` 残留（本 worker 全程只读真库、只写其副本）。人工执行步骤：`node scripts/mint-token.mjs sweep --db ~/.cloudcli/auth.db`（先看清单），确认后 `node scripts/mint-token.mjs sweep --db ~/.cloudcli/auth.db --apply`，把命令与前后 `SELECT id,username FROM users` 读数补记于此。