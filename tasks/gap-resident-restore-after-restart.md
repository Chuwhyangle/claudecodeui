---
id: gap-resident-restore-after-restart
title: 重启后自动恢复 resident 会话（配置面走通用 server settings 文件，默认 off）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->与 `gap-ops-doc-restart-claim-contradicts-graceful-shutdown`（done）同域不同机制：那是订正「重启不杀会话」的运维文档，这是新增「重启后自动拉起 resident 会话」的代码能力，不合并。与 `cockpit-hub-cross-device-state`（ready）共享 `server/index.ts`，但机制无关且对方已 ready，故单独立案。

**退回重做的原因（第一版已 done 但配置面做错）**：第一版把旋钮做成三个裸 env（`CLAUDE_RESIDENT_RESTORE` / `_MAX` / `_MAX_AGE_MS`），违背本项目正在执行的「部署旋钮从 env 迁移到自有配置文件」方向（`voice-realtime-settings.ts` 的 env-to-file migration：settings 文件是 normal entry、env 是 escape hatch、优先级 env > file > default）。本次差分只改配置面，恢复机制本身保留。

**机制（已落地、保留）**：boot 时枚举 `lifecycle_mode='resident'` 且 `provider_session_id` 非空、provider 挂 resident 驱动的会话，按 `updated_at` 降序取前 N，逐个复用既有 `providerRuntimeService.startResidentSession`。quay worker 是 `claude -p --session-id` 的一次性 per-run 进程，天然被 resident 过滤排除，无需额外识别。`updated_at` 是 transcript 内容重推导的最后活跃时间，排序口径复用 `getRecentSessionsPage`（`COALESCE(updated_at,created_at) DESC, session_id DESC`）。

**配置面（本次差分）**：改用**通用 server settings 文件**：
- 出货示例 `config/server.settings.example.json`（提交进仓），用户副本 `~/.config/claudecodeui/server.settings.json`；唯一 env `SERVER_SETTINGS_PATH` 指路（逃生舱），不再有任何 per-key env。
- 键 `residentRestore: { enabled, max, maxAgeMs }`：`enabled` 缺省 `false`（默认 off）；`max` 缺省 16；`maxAgeMs` 缺省 86400000（= resident 空闲上限 `RESIDENT_IDLE_TIMEOUT` 24h，语义「重启前确实还活着的会话」）。
- boot 时读一次；未知键忽略；非法值回落缺省并 log 到 `problems`（同 voice settings 的 shape-error 口径）；优先级 env（仅指路）> file > default。
- 通用文件是后续其它**服务器级**（非 per-user）旋钮的同族载体；per-user 旋钮仍走既有 settings store，不进此文件。

**已落地、需小改的接线**：`restoreResidentSessionsAfterRestart()` 仍在 `initializeDatabase()` 与 orphan sweep 之后、fire-and-forget（不阻塞 ready）、并发 1–2、计时器 unref、单会话失败隔离——不变；只把「读三个 env」换成「从 server settings 注入的 `residentRestore` 块读」。

**已知代价（不变）**：默认 off 时 `resident-server-restart.test.ts` leg4（钉「重启后 running:false」）仍绿；将来翻默认值时同步改它。

## AC

- [ ] 测试通过：`bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/session-hosts/tests/resident-restore.service.test.ts` exit 0，断言 settings 解析：默认 `enabled===false`；文件 `residentRestore.enabled=true` 才开启；`max`/`maxAgeMs` 非法值回落缺省；`SERVER_SETTINGS_PATH` 指向不存在文件/非法 JSON 时回落缺省并记录 problem。
- [ ] 同一测试文件断言恢复集选择（保留）：只恢复 resident 且 `provider_session_id` 非空、provider 挂 resident 驱动的会话；按最后活跃降序；超过 max 截断；`updated_at` 旧于 maxAge 跳过；单个 `startResidentSession` 抛错时其余仍执行且服务不抛（失败隔离）。
- [ ] `sessionsDb.listRestorableResidentSessions` 在临时库上验证（保留）：过滤（archived / `lifecycle_mode` 非 resident / `provider_session_id` NULL 排除）、排序口径、limit 生效。
- [ ] 启动接线存在：`grep -nE "residentRestore|restoreResident|resident-restore" server/index.ts` exit 0 且该调用行号大于 `sweepOrphanClaudeSessionScopes()` 调用行号；`grep -nE "SERVER_SETTINGS_PATH|server\.settings" server/index.ts` exit 0。
- [ ] 旧配置面已迁走：`grep -rnE "CLAUDE_RESIDENT_RESTORE" server/ --include=*.ts` 零命中（exit 1）。
- [ ] 默认 off 不改变现有行为（保留）：`bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/session-hosts/tests/resident-server-restart.test.ts` exit 0。
- [ ] `npm run typecheck` exit 0；`npx oxlint config 2>/dev/null; npx oxlint server/modules/settings/server-settings.ts server/modules/settings/index.ts server/modules/session-hosts/resident-restore.service.ts server/modules/session-hosts/index.ts server/index.ts server/modules/session-hosts/tests/resident-restore.service.test.ts` exit 0。

## DoD

- 上述 AC 全勾；`quay task check` 的 `missing` 为 `[]`。
- 真实机制读数（待外部，翻默认值前由人验证）：在用户副本 `~/.config/claudecodeui/server.settings.json` 设 `residentRestore.enabled=true`，重启 server，`GET /api/session-hosts` 中最近活跃的 resident 会话恢复为 `running:true`（自动恢复而非下次 send 惰性拉起），且 quay worker 会话未被拉起；验证后另立「翻默认值」任务。

## Touches

- config/server.settings.example.json
- server/modules/settings/server-settings.ts
- server/modules/settings/index.ts
- server/modules/session-hosts/resident-restore.service.ts
- server/modules/session-hosts/index.ts
- server/index.ts
- server/modules/session-hosts/tests/resident-restore.service.test.ts
- tasks/gap-resident-restore-after-restart.md
