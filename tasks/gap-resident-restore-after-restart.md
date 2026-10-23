---
id: gap-resident-restore-after-restart
title: 重启后自动恢复 resident 会话（最小可行版：默认 off，CLAUDE_RESIDENT_RESTORE=on 开启）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->与 `gap-ops-doc-restart-claim-contradicts-graceful-shutdown`（done）同域不同机制：那是订正「重启不杀会话」的运维文档，这是新增「重启后把常驻会话自动拉起来」的代码能力，不合并。与 `cockpit-hub-cross-device-state`（ready）共享 `server/index.ts`，但机制无关（跨设备状态中枢 vs resident 恢复），且对方已 ready 将派发，故单独立案。

**现状（两轮探查已核）**：重启会杀掉本服务托管的 resident Claude 进程，之后只在下次 `chat.send` / MCP `session_send` 时惰性重启，导致跨会话 peer 寻址（`SendMessage` 按 `peerName`）找不到目标。`lifecycle_mode='resident'` 是唯一能持久判定「应当常驻」的标记；实测库 350 个 resident 会话全为 `claude`、无一落在 quay worktree 根下——quay worker 是 `claude -p --session-id` 的一次性 per-run 进程，天然被 resident 过滤排除，无需额外识别。

**最小可行版**：boot 时枚举 resident 会话（`updated_at` 即 transcript 内容重推导的最后活跃时间），按最后活跃取前 N，逐个复用既有 `providerRuntimeService.startResidentSession` 拉起。默认 off（不改变现有行为），`CLAUDE_RESIDENT_RESTORE=on` 开启；由人先在自己 `.env` 验证，另立「翻默认值」任务再改。

**设计要点**：
- 新叶模块 `server/modules/session-hosts/resident-restore.service.ts`（工厂 + 注入缝，遵守 `$backend-module-standards`）：不从 session-hosts 反向 import `sessionsDb`/`providerRuntimeService`——两者经 `server/index.ts` 组合根注入，与既有 `listSessions`/`startResidentSession` 缝同形，经 `session-hosts/index.ts` barrel 导出。
- 三个 env 旋钮：`CLAUDE_RESIDENT_RESTORE`（缺省 off）、`CLAUDE_RESIDENT_RESTORE_MAX`（数量上限，缺省 16，实测最近 6h 活跃 8、12h 10，16 有富余）、`CLAUDE_RESIDENT_RESTORE_MAX_AGE_MS`（活跃窗，缺省 24h = resident 空闲上限 `RESIDENT_IDLE_TIMEOUT`，语义即「重启前确实还活着的会话」）。
- `sessionsDb` 新增 `listRestorableResidentSessions({maxAgeMs, limit})`：`isArchived=0 AND lifecycle_mode='resident' AND provider_session_id IS NOT NULL`，排序口径复用 `getRecentSessionsPage`（`julianday(COALESCE(updated_at,created_at)) DESC, session_id DESC`）+ limit。
- boot 接线：`initializeDatabase()` 与 orphan sweep 之后，fire-and-forget（不阻塞 ready），并发 1–2、计时器 unref、全局预算，单会话失败 try/catch 隔离，绝不让一个坏会话打断 boot。

**已知代价**：默认 on 会让 `resident-server-restart.test.ts` leg4（钉「重启后 running:false」）变红；本 MVP 默认 off，故该判据仍绿，翻默认值的后续任务须同步改它。

## AC

- [ ] 新增 `server/modules/session-hosts/tests/resident-restore.service.test.ts` 通过（`bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/session-hosts/tests/resident-restore.service.test.ts` exit 0），断言：`resolveResidentRestoreEnabled({})===false`、`{CLAUDE_RESIDENT_RESTORE:'on'}===true`、`'off'`/`'0'`/`' OFF '`===false；`readResidentRestoreMax`/`readResidentRestoreMaxAgeMs` 对非法值回落缺省。
- [ ] 同一测试文件断言恢复集选择：只恢复 resident 且 `provider_session_id` 非空、provider 挂 resident 驱动的会话；按最后活跃降序；超过 max 截断；`updated_at` 旧于 maxAge 的跳过；单个 `startResidentSession` 抛错时其余仍执行且服务不抛（失败隔离）。
- [ ] `sessionsDb.listRestorableResidentSessions` 在临时库上验证：过滤（archived / `lifecycle_mode` 非 resident / `provider_session_id` NULL 排除）、排序口径 `COALESCE(updated_at,created_at) DESC, session_id DESC`、limit 生效。
- [ ] 启动接线存在：`grep -nE "residentRestore|restoreResident|resident-restore" server/index.ts` exit 0，且该调用行号大于 `sweepOrphanClaudeSessionScopes()` 调用行号。
- [ ] 默认 off 不改变现有行为：`bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/session-hosts/tests/resident-server-restart.test.ts` exit 0（现判据仍绿）。
- [ ] `npm run typecheck` exit 0；`npx oxlint server/index.ts server/modules/session-hosts/resident-restore.service.ts server/modules/session-hosts/index.ts server/modules/database/repositories/sessions.db.ts server/modules/session-hosts/tests/resident-restore.service.test.ts` exit 0。

## DoD

- 上述 AC 全勾；`node packages/quay/bin/quay.ts task check gap-resident-restore-after-restart --json` 的 `missing` 为 `[]`。
- 真实机制读数（待外部，翻默认值前由人验证）：在 `.env` 设 `CLAUDE_RESIDENT_RESTORE=on`，重启 server，`GET /api/session-hosts` 中最近活跃的 resident 会话恢复为 `running:true`（自动恢复而非下次 send 惰性拉起），且 quay worker 会话未被拉起；验证后另立「翻默认值」任务。

## Touches

- server/index.ts
- server/modules/session-hosts/resident-restore.service.ts
- server/modules/session-hosts/index.ts
- server/modules/database/repositories/sessions.db.ts
- server/modules/session-hosts/tests/resident-restore.service.test.ts
- tasks/gap-resident-restore-after-restart.md
