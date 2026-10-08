---
id: gap-claude-default-resident-lifecycle
title: "session_create: default Claude to resident lifecycle when lifecycleMode
  is omitted (provider-scoped default, not a schema change)"
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

Confirmed gap (code read 2026-10-08, re-verified against the current tree): `server/modules/mcp-gateway/mcp-session-lifecycle.ts:297-302`'s `buildSessionCreate` only calls `deps.sessions.switchLifecycle(provider, created.sessionId, input.lifecycleMode)` when `input.lifecycleMode !== undefined`:

```
if (input.lifecycleMode !== undefined) {
    // Before any send: the mode is read at dispatch time, so a resident session
    // whose preference were stored after the first turn would run that turn
    // per-run and only become resident once it had already ended.
    deps.sessions.switchLifecycle(provider, created.sessionId, input.lifecycleMode);
}
```

There is no provider-aware default when the caller omits `lifecycleMode`. `server/modules/database/repositories/sessions.db.ts:84` confirms the DB column `lifecycle_mode` carries `DEFAULT 'per-run'` for every provider ("Never NULL on a row read from the database: the column carries `DEFAULT 'per-run'`"). `server/modules/providers/services/provider-capabilities.service.ts` confirms (re-read today, lines verified exactly): only `claude` (line 126) declares `lifecycleModes: ['per-run', 'resident']`; `cursor` (line 187), `codex` (line 206), and `opencode` (line 224) each declare `lifecycleModes: ['per-run']` only — a capability constraint, not a default-selector. Net effect: an MCP caller doing `session_create` for Claude without explicitly passing `lifecycleMode: 'resident'` gets a `per-run` session even though Claude is the one provider the whole resident-host subsystem (`server/modules/session-hosts/`) was built for.

Task: when `input.lifecycleMode` is omitted AND the resolved `provider` (`input.provider ?? 'claude'`, per `buildSessionCreate`'s own resolution at line 270) is `'claude'`, default to `'resident'` inside `buildSessionCreate` — call `deps.sessions.switchLifecycle(provider, created.sessionId, 'resident')` in that branch, before the opening send, mirroring the existing explicit-mode call site's ordering comment ("Before any send: the mode is read at dispatch time..."). Every other provider keeps falling through to the unchanged DB default `per-run` (no new branch for them). Do NOT change the DB column default (other providers may gain resident later; the default must stay provider-scoped in the handler, not in schema).

<!-- dedup-ref --> 机制上去重已核对：`task_list search="lifecycleMode"`/`search="buildSessionCreate"`/`search="resident lifecycle default"`/`search="session_create default lifecycle"` 均核对过命中——唯一相关的是已完成的 `gap-ac250-session-create-interrupt-lifecycle`（交付 `session_create`/`session_interrupt` 本体，`lifecycleMode` 仅在显式传入时生效，当前代码逐字确认未变）与已完成的 `gap-mcp-session-create-permissionmode-race`（加 `permissionMode` 参数与其竞态修复，不涉及 `lifecycleMode` 的默认选择）。两者都不处理"省略 `lifecycleMode` 时按 provider 选默认值"这一机制，不是重复。

## AC

- [ ] AC1: a new/extended test in `server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts` asserts: `session_create({ project })` with NO `lifecycleMode` and NO `provider` (so it resolves to `claude`) results in `deps.sessions.switchLifecycle` being called with `(provider, sessionId, 'resident')` — read back via the injected spy's call args, logged verbatim.
- [ ] AC2: the same test asserts `session_create({ project, provider: 'codex' })` (and `'cursor'`, `'opencode'`) with NO `lifecycleMode` results in `deps.sessions.switchLifecycle` NEVER being called (call count 0) — the DB default `per-run` is left untouched, logged verbatim call counts.
- [ ] AC3: explicit `lifecycleMode` always wins over the new default, both directions: `session_create({ project, lifecycleMode: 'per-run' })` (provider defaulting to claude) results in `switchLifecycle` called with `'per-run'` (NOT silently overridden to `'resident'`); `session_create({ project, provider: 'claude', lifecycleMode: 'resident' })` behaves identically to the new implicit-default path (both produce the same `switchLifecycle('resident')` call) — both call sites' args logged verbatim for comparison.
- [ ] AC4: regression — the existing AC-250 assertions in the same test file (no-message zero-run case, ambiguous-project case, scope-denial cases) remain green unmodified; `npm run typecheck` exits 0.
- [ ] AC5: a negative control (false form): temporarily remove the new default branch (revert to only the explicit-mode `if`) and confirm AC1 reds with the exact assertion line and value pinned (e.g. `switchLifecycle` call count 0 where 1 with `'resident'` was expected); then restore and re-confirm AC1 green. Record the diff, the red line, and the restore command.

## DoD

A real `session_create` call (through the existing criterion's real-mount + real DB + real control-service harness used by AC-250, not a new throwaway) for a Claude-targeted session with no `lifecycleMode` argument ends with the session's row actually carrying `lifecycle_mode = 'resident'` (read back from the real DB row, not just the spy's call args) — and the same call for a non-Claude provider ends with the row still carrying the untouched DB default `'per-run'`. Logged DB reads for both, not just an assertion that a function was called.

## Touches

- server/modules/mcp-gateway/mcp-session-lifecycle.ts
- server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts
- tasks/gap-claude-default-resident-lifecycle.md
