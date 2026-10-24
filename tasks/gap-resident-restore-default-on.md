---
id: gap-resident-restore-default-on
title: resident 恢复默认开启：residentRestore.enabled 出厂缺省翻 true（同步改判据）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->承接 `gap-resident-restore-after-restart`（done）：其「待外部」真实读数已于 2026-10-24 通过——`enabled=true` 时重启实测 `[resident-restore] considered=16 started=16 failed=0 skipped=0`，16 个 resident 会话在 boot 自动恢复，人已确认 UI 里看到多个活着的 resident session。本任务是该计划的收尾：把出厂缺省从 opt-in 翻成 opt-out。

**差分**：
- `server/modules/settings/server-settings.ts` 的 `DEFAULT_RESIDENT_RESTORE_ENABLED` 由 `false` 翻 `true`（注释「shipped off」同步改「shipped on」）；`max`/`maxAgeMs` 缺省不变。
- `config/server.settings.example.json` 的 `residentRestore.enabled` 同步 `true`，并更新 `_residentRestore` 说明（默认开启，可显式 `false` 关闭）。
- 关闭方式不变：`~/.config/claudecodeui/server.settings.json` 设 `residentRestore.enabled: false` 即 opt-out。

**钉住「默认 off」的判据要同步（主要风险点）**：
- `server/modules/session-hosts/tests/resident-restore.service.test.ts`：`assert.equal(DEFAULT_RESIDENT_RESTORE_ENABLED, false)` 翻成 `true`；补/保留「文件显式 `enabled:false` 即关闭」的用例。
- `server/modules/session-hosts/tests/resident-server-restart.test.ts`：它 boot 真服务器并断言重启后 resident 会话 `running:false`（leg4）——默认 on 后 boot 会自动恢复，该腿语义失效。推荐做法：在该测试的临时 HOME 里写一份 `server.settings.json`（`residentRestore.enabled:false`）显式关掉 restore，让该判据继续测量它原本要测的「sweep + not-running」语义；或改写断言为自动恢复。其余真服务器测试/soak/e2e 若在 boot 时自造 resident 会话，同样排查。

**边界**：翻默认后，任何 boot 真服务器且用临时 HOME（无会话、无 settings 文件）的测试，恢复遍历天然是 no-op；只有自己造 resident 会话的判据需要显式关或改断言。

## AC

- [x] `grep -n "DEFAULT_RESIDENT_RESTORE_ENABLED" server/modules/settings/server-settings.ts` 命中且该常量赋值为 `true`。
- [x] `grep -n '"enabled"' config/server.settings.example.json` 命中 `"enabled": true`。
- [x] `resident-restore.service.test.ts` 改后通过（缺省 `enabled===true`；文件 `enabled:false` 关闭；非法值回落缺省）：`bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/session-hosts/tests/resident-restore.service.test.ts` exit 0。
- [x] `resident-server-restart.test.ts` 改后通过（默认 on 下该判据的测量仍有效——显式关 restore 或改断言）：`bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/session-hosts/tests/resident-server-restart.test.ts` exit 0。
- [x] `npm run typecheck` exit 0；`npx oxlint server/modules/settings/server-settings.ts server/modules/session-hosts/tests/resident-restore.service.test.ts server/modules/session-hosts/tests/resident-server-restart.test.ts` exit 0。
- [x] 全量无新增红：fan-in 门通过（`quay task check`）。

## DoD

- 上述 AC 全勾；`quay task check` 的 `missing` 为 `[]`。
- 真实读数：默认 on 下（无用户 settings 文件干预）重启一次，`GET /api/session-hosts` 里最近活跃的 resident 会话自动恢复 `running:true`。

## Touches

- server/modules/session-hosts/resident-restore.service.ts
- server/modules/settings/server-settings.ts
- server/index.ts
- config/server.settings.example.json
- server/modules/session-hosts/tests/resident-restore.service.test.ts
- server/modules/session-hosts/tests/resident-server-restart.test.ts
- tasks/gap-resident-restore-default-on.md
