---
id: gap-database-connection-directory-cycle
title: Move the database connection module out of the repositories↔database
  directory cycle
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F4（架构校准报告 2026-10-20，ArchGuard 0.1.40 加独立源码扫描，HEAD `abc2b5ed9`）：`modules/database ↔ modules/database/repositories` 的目录级双包环。

度量：SCC 规模 2；`modules/database` 的 fanIn 93、fanOut 31。

已验证的边：`server/modules/database/index.ts:9-23` 再导出各 repository 模块；每个 repository 又导入 `@/modules/database/connection.js`——这个文件直接位于父包里（例：`server/modules/database/repositories/credentials.ts:9`、`notification-preferences.ts:7`、`app-config.ts:11`）。

为什么重要：严重度低——这是 barrel/父文件型环，不是设计倒置；但它仍意味着 `database/repositories` 离开父目录就无法理解，而把 connection 模块移出去后，它可以变成图里的叶子。

改法（报告给出的 remediation）：把 `connection.ts` 移进 `modules/database/connection/` 或 `modules/database/core/`，让 repositories 导入的是同级包；`index.ts` 只做纯再导出 barrel。

<!-- dedup-ref --> 相关但不同机制：`gap-ac394-server-import-cycle-budget`（done）是服务端目录图的棘轮与三组基线（只断言 SCC 是基线的子集、只让环缩小），不是把 connection 模块搬出父包；本条要让该 2 成员环真的消失。去重检索实测：`modules/database/connection` 的命中均为数据库迁移/测试任务（done，机制不同），`directory cycle` → 0，`database/connection cycle` → 0。

## AC

- [x] `test -z "$(grep -rn "@/modules/database/connection" server/modules/database/repositories --include='*.ts')"`：repositories 对父包 `connection.js` 的导入为 0（立案时 11+ 命中），命令退出 0；贴出前后计数。
- [x] connection 模块的新位置在 `server/modules/database/connection/` 或 `server/modules/database/core/` 下（贴出实际路径），`server/modules/database/connection.ts` 不再存在（`test ! -e server/modules/database/connection.ts`）。
- [x] `server/modules/database/index.ts` 只做再导出：`test -z "$(grep -nE '^(export )?(function|const|class) ' server/modules/database/index.ts)"`，且仍导出 repositories 与 connection 的公共面（贴出该文件全文或全部导出行）。
- [x] 既有数据库判据不改一字仍绿：`for f in server/modules/database/tests/*.test.ts; do npx tsx --tsconfig server/tsconfig.json --test "$f" || exit 1; done` 退出 0；贴出文件数与各文件 pass 数。
- [x] 结构读数（外部工具）：新鲜 `archguard_detect_cycles(outputScope=package)` 在 server 上不再报告同时含 `modules/database` 与 `modules/database/repositories` 的 SCC。该读数为 ArchGuard MCP 查询（待外部）。
- [x] `npm run typecheck` 退出 0。
- [x] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「repositories 真的只依赖一个同级 connection 包，2 成员环真的消失」，不是「多加了一层目录」。必须贴出：①`grep -rn "@/modules/database/connection" server/modules/database/repositories` 的前后计数（前 11+、后 0）；②connection 新路径与 repositories 的新 import 行原文（至少 `credentials.ts`、`notification-preferences.ts`、`app-config.ts` 三处）；③`index.ts` 的导出清单，证明它没有实现体；④`server/modules/database/tests/*.test.ts` 逐个文件 pass 读数；⑤ArchGuard 的 SCC 前后成员清单（前 `{modules/database, modules/database/repositories}`，后无该组）；⑥typecheck 退出码；⑦取假形态：把一条 `import ... from '@/modules/database/connection.js'` 临时加回 repository ⇒ 第一条 AC 红（计数 1），还原后复绿，附两次读数。若移动后仍有非 repositories 的消费者需要兼容路径，用 barrel 转出口解决，不得保留第二份实现。

## Touches

- server/modules/database/connection.ts
- server/modules/database/core/index.ts
- server/modules/database/index.ts
- server/modules/database/init-db.ts
- server/modules/database/schema.ts
- server/modules/database/repositories/access-tokens.ts
- server/modules/database/repositories/app-config.ts
- server/modules/database/repositories/credentials.ts
- server/modules/database/repositories/github-tokens.ts
- server/modules/database/repositories/mcp-audit-log.db.ts
- server/modules/database/repositories/notification-channel-endpoints.ts
- server/modules/database/repositories/notification-preferences.ts
- server/modules/database/repositories/oauth-authorization-codes.db.ts
- server/modules/database/repositories/oauth-clients.db.ts
- server/modules/database/repositories/oauth-code-redemptions.db.ts
- server/modules/database/repositories/oauth-grants.db.ts
- server/modules/database/repositories/projects.db.ts
- server/modules/database/repositories/provider-models.ts
- server/modules/database/repositories/push-subscriptions.ts
- server/modules/database/repositories/scan-state.db.ts
- server/modules/database/repositories/scheduled-messages.db.ts
- server/modules/database/repositories/session-drafts.db.ts
- server/modules/database/repositories/sessions.db.ts
- server/modules/database/repositories/ui-last-opened.db.ts
- server/modules/database/repositories/user-preferences.db.ts
- server/modules/database/repositories/users.ts
- server/modules/database/repositories/vapid-keys.ts
- server/modules/database/repositories/voice-settings.db.ts
- server/modules/database/repositories/voice-user-identifiers.db.ts
- server/modules/database/tests/api-keys-drop-migration.test.ts
- server/modules/database/tests/launch-profiles-drop-migration.test.ts
- server/modules/database/tests/projects.db.integration.test.ts
- server/modules/database/tests/sessions-provider-mapping.test.ts
- server/modules/database/tests/sessions.db.integration.test.ts
- server/modules/database/tests/voice-settings.db.integration.test.ts
- server/modules/voice/tests/voice-dashscope-settings.test.ts
- server/shared/tests/server-import-cycle-budget.test.ts
- server/shared/tests/server-import-cycle-budget.baseline.json
- tasks/gap-database-connection-directory-cycle.md (self)

## Evidence

Baseline: develop @ `166823331`; implementation commits `a31b39881`, `1c232db93`.

- AC1 — pre: `grep -rn "@/modules/database/connection" server/modules/database/repositories --include='*.ts' | wc -l` → 24; post → 0; the `test -z` form exits 0.
- AC2 — new home `server/modules/database/core/index.ts`; `test ! -e server/modules/database/connection.ts` exits 0.
- AC3 — `grep -nE '^(export )?(function|const|class) ' server/modules/database/index.ts` exits 1 (no matches); the file's connection export line is `export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/core/index.js';`, all other lines are `export {…}` / `export type {…}` re-exports (repositories barrel unchanged).
- AC4 — 10 files, loop exit 0; per-file pass counts: api-keys-drop-migration 3, db-file-permissions 2, launch-profiles-drop-migration 2, projects.db.integration 4, provider-models.db.integration 2, sessions.db.integration 9, sessions-name-source.integration 12, sessions-provider-mapping 4, user-preferences.db.integration 7, voice-settings.db.integration 7 (52 pass, 0 fail). Note: six of these files changed exactly one line each — the `@/modules/database/connection.js` import specifier → `@/modules/database/core/index.js`; no assertion body changed. The other four already imported through `@/modules/database/index.js` and are byte-identical. A compatibility `connection.ts` would have kept them untouched but is forbidden by AC2, so the specifier update is the only mechanical option.
- AC5 — fresh `archguard_analyze(projectRoot=<worktree>, sources=["server"], lang=typescript)` then `archguard_detect_cycles(outputScope=package, scope=server)`. Before (develop worktree): size-2 SCC `{modules/database, modules/database/repositories}`. After: no SCC contains either module; remaining SCCs are the pre-existing size-11 group and `{"", modules/browser-use}`. An intermediate step still showed size-3 `{modules/database, modules/database/core, modules/database/repositories}` because `core` imported `schema.ts` back; fixed by moving `APP_CONFIG_TABLE_SCHEMA_SQL` into `core/index.ts` and re-exporting it from `schema.ts`, making `core` a leaf.
- AC6 — `npm run typecheck` exit 0.
- AC7 — anti-drift Touches check run against develop; diff set is exactly the 36 code paths + the task file listed above, plus (2026-10-20 continuation round) the two AC-394 ratchet files.
- DoD ⑦ (false form) — appended `import { getConnection } from '@/modules/database/connection.js';` to `repositories/credentials.ts` → AC1 count 1 (red); `git checkout -- credentials.ts` → count 0 (green).
- AC-394 ratchet (2026-10-20 continuation round) — the prior fan-in suite red was real and task-caused, despite the mechanical UNRELATED label: `server/shared/tests/server-import-cycle-budget.test.ts` pinned the retired two-member cycle (`(b) the measured cycles must match the pinned baseline groups member-for-member`) and the new `modules/database/core` was absent from the committed manifest (`(c)` inbound-edge arm: `server/modules/database` / `server/modules/database/repositories` import it). Lowered the ratchet in its own sanctioned shrink direction: `cycleGroups.G2` → `[]` in both `CYCLE_GROUPS` and the baseline JSON (a re-introduced cycle still reds the exact-equality assertions), registered `modules/database/core` in `MANIFEST_PIN` + `directoryManifest` under AC-394 (c)'s leaf escape hatch (it imports only node builtins and `better-sqlite3`, no `server/` target, and is in no SCC), and re-measured `measuredAt`/`fileEdges.static`/`nodeCount` (2026-10-20, 1280 static / 6 dynamic, 48 nodes). Isolation rerun: `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` → 11 pass, 0 fail; summary `files=325 staticEdges=1280 dynamicEdges=6 sccs=[11,2]`, `(b)` and `(c)` green, `(c) directories present but absent from the manifest: []`.

## Blocker

**2026-10-20T06:49:06.781Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/shared/tests/server-import-cycle-budget.test.ts:   AssertionError [ERR_ASSERTION]: the measured cycles must match the pinned baseline groups member-for-member
- run_id：wk-prod-anchor
- session_id：76bb64ff-4a74-484d-b86d-4643c71f7af0
