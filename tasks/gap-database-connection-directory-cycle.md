---
id: gap-database-connection-directory-cycle
title: Move the database connection module out of the repositories↔database
  directory cycle
status: todo
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

- [ ] `test -z "$(grep -rn "@/modules/database/connection" server/modules/database/repositories --include='*.ts')"`：repositories 对父包 `connection.js` 的导入为 0（立案时 11+ 命中），命令退出 0；贴出前后计数。
- [ ] connection 模块的新位置在 `server/modules/database/connection/` 或 `server/modules/database/core/` 下（贴出实际路径），`server/modules/database/connection.ts` 不再存在（`test ! -e server/modules/database/connection.ts`）。
- [ ] `server/modules/database/index.ts` 只做再导出：`test -z "$(grep -nE '^(export )?(function|const|class) ' server/modules/database/index.ts)"`，且仍导出 repositories 与 connection 的公共面（贴出该文件全文或全部导出行）。
- [ ] 既有数据库判据不改一字仍绿：`for f in server/modules/database/tests/*.test.ts; do npx tsx --tsconfig server/tsconfig.json --test "$f" || exit 1; done` 退出 0；贴出文件数与各文件 pass 数。
- [ ] 结构读数（外部工具）：新鲜 `archguard_detect_cycles(outputScope=package)` 在 server 上不再报告同时含 `modules/database` 与 `modules/database/repositories` 的 SCC。该读数为 ArchGuard MCP 查询（待外部）。
- [ ] `npm run typecheck` 退出 0。
- [ ] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「repositories 真的只依赖一个同级 connection 包，2 成员环真的消失」，不是「多加了一层目录」。必须贴出：①`grep -rn "@/modules/database/connection" server/modules/database/repositories` 的前后计数（前 11+、后 0）；②connection 新路径与 repositories 的新 import 行原文（至少 `credentials.ts`、`notification-preferences.ts`、`app-config.ts` 三处）；③`index.ts` 的导出清单，证明它没有实现体；④`server/modules/database/tests/*.test.ts` 逐个文件 pass 读数；⑤ArchGuard 的 SCC 前后成员清单（前 `{modules/database, modules/database/repositories}`，后无该组）；⑥typecheck 退出码；⑦取假形态：把一条 `import ... from '@/modules/database/connection.js'` 临时加回 repository ⇒ 第一条 AC 红（计数 1），还原后复绿，附两次读数。若移动后仍有非 repositories 的消费者需要兼容路径，用 barrel 转出口解决，不得保留第二份实现。

## Touches

- server/modules/database/connection.ts（迁出，文件删除或变为薄转出口）
- server/modules/database/connection/index.ts (new)（connection 的新家；若选 `core/` 则为 `server/modules/database/core/index.ts`）
- server/modules/database/index.ts（纯再导出 barrel）
- server/modules/database/repositories/credentials.ts（import 改指同级 connection 包）
- server/modules/database/repositories/notification-preferences.ts（同上）
- server/modules/database/repositories/app-config.ts（同上）
- server/modules/database/tests/api-keys-drop-migration.test.ts（既有数据库判据，不改一字，作覆盖）
- tasks/gap-database-connection-directory-cycle.md (self)
