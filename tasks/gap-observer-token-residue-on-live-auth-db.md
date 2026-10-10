---
id: gap-observer-token-residue-on-live-auth-db
title: 生产 auth.db 上的 observer 探针残留：给 mint-token 增可复核的 sweep（dry-run/apply/自证），并清掉现存那一行
status: ready
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

- [ ] AC1 红态基线逐字记录（改动前）：`node scripts/mint-token.mjs sweep --db <隔离副本>` ⇒ 该子命令尚不存在，逐字记录 usage/错误输出与退出码。
- [ ] AC2 dry-run 只列不删：在**隔离副本**（把真库拷到临时目录，绝不直接对 `~/.cloudcli/auth.db` 做实验）上跑 `sweep --db <copy>`（不带 `--apply`）⇒ 打印 observer 行清单，且 `SELECT COUNT(*) FROM users` 前后读数相同。
- [ ] AC3 `--apply` 只删 observer 行：同一副本上 `sweep --apply` ⇒ observer 行消失；把前后 `SELECT id,username,is_active,created_at FROM users` 的全量输出逐字对比，**必须只少掉了 observer 行**，operator 行（`username='yale'`）与其它任何非 observer 行逐字不变；且工具自证输出的删除行数与实际差值一致。
- [ ] AC4 幂等与空集：再跑一次 `sweep --apply` ⇒ 删除数 0、退出 0（不是错误也不是 usage）。
- [ ] AC5 判据就地加：`scripts/mint-token.test.mjs` 增用例覆盖 AC2–AC4（全部在临时库上，不碰真库），`node --test scripts/mint-token.test.mjs` 单文件运行退出 0，写下 passed/总数。
- [ ] AC6 真库清理读数：对 `~/.cloudcli/auth.db` 执行 `sweep --apply`，把命令与前后 `SELECT id,username FROM users` 逐字读数贴进 Notes；该行只能由人在生产库上确认后删除，执行者不得自行代跑（待外部）
- [ ] AC7 取假形态（先提交实现再变异，逐条记录变异 diff、逐字红行与恢复命令）：把 `sweep` 的匹配条件从 `observer-%` 放宽成 `%`（或去掉前缀过滤）⇒ AC3 的「operator 行逐字不变」断言红；恢复后回绿。
- [ ] AC8 范围纪律：`git diff --name-only develop...HEAD -- scripts/` 只列出 `scripts/mint-token.mjs` 与 `scripts/mint-token.test.mjs`；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐。

## DoD

- 真实对象走通（不是只写代码）：在**真库的副本**上依次跑 dry-run → `--apply` → 再 `--apply`（幂等）三次真实运行，把三次的逐字输出与三次 `users` 全量读数贴进 Notes，证明「只删 observer 行」这件事是被量出来的、不是被断言的。
- 生产库那一行由人在场时清理，命令与前后读数入 Notes（AC6）。
- 输出无秘密：`sweep` 的任何输出只含 username/id/created_at/TTL 判定，不含任何 token、hash 或 provider 材料（判据里断言）。
- 遵守 AGENTS.md；无新依赖；脚本测试单文件运行，不做无界扇出。

## Touches

- scripts/mint-token.mjs（新增 sweep 子命令：默认 dry-run、只匹配 observer- 前缀、自证删除行数；mint/probe/revoke 语义不变）
- scripts/mint-token.test.mjs（就地加 sweep 用例：dry-run/apply/幂等/只碰 observer 前缀，全部临时库）
- tasks/gap-observer-token-residue-on-live-auth-db.md
