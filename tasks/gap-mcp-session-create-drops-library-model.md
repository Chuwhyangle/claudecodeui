---
id: gap-mcp-session-create-drops-library-model
title: MCP session_create 丢弃模型库条目 model（v4.1flash）：行上 model=NULL、宿主 --model
  default、实跑账户缺省模型
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

**真实读数（2026-10-15T06:21Z）**：MCP `session_create`（经 3001 端口网关 pid 507915，启动于 2026-10-15 02:22 CST，晚于 `dist-server` 构建 02:21:19，构建含 `98a4fc6b1`「record a session's launch selection when the gateway mints the row」）。

- 网关自身审计 `mcp_audit_log`（correlation `quay-release-0.20.0-from-fleet-manager-2026-10-15`）：`args_digest` 含 `"model":{"length":9,"preview":"v4.1flash"}`、`permissionMode: bypassPermissions`、`lifecycleMode: resident`，outcome `ok`。
- 结果会话 `0aa4332a-c488-4d24-bd62-8a5870b68115`：`sessions` 行 `model = NULL`、`effort = NULL`、`permission_mode = bypassPermissions`、`lifecycle_mode = resident` ⇒ model 被丢，permissionMode / lifecycleMode 正常落行。
- 宿主进程 pid 3037494 argv：`--model default … --permission-mode bypassPermissions`，无代理环境；transcript `message.model = claude-sonnet-5`（7 条）。
- 对照：同一网关里经 Web UI 选择模型库条目 `v4.1flash` 创建的会话（如 `95b2f8db…`、`76d53305…`）行上 `model = v4.1flash`，进程 `--model v4.1flash` + 代理环境，transcript `deepseek-flash` ⇒ 缺陷只在 MCP 创建路径。
- `dist-server/server/modules/mcp-gateway/mcp-session-lifecycle.js` 约 157–181 行把 `model` 传入 `deps.sessions.create(provider, path, message, model ? { model } : undefined)`，但行上仍为 NULL ⇒ 怀疑 `assertSelectableModel` 对模型库（自定义）条目返回空/未识别，或 `sessions.create` 的 options 未落行——须实测定位，不臆断。

影响：quay-fleet 的 `src/session-provenance.mjs`（AC-072）按 ADR-010 显式传 `model: 'v4.1flash'`，在生产中被静默丢弃 ⇒ Fleet 经网关创建的所有会话实际跑账户缺省模型。

## Plan

1. 用真实请求形状写失败用例：MCP `session_create{project, model:'v4.1flash'(模型库条目), lifecycleMode:'resident', permissionMode, message}` ⇒ 断言行上 `model === 'v4.1flash'` 且首个 run 以该模型 + 条目环境启动。
2. 定位丢失点（`assertSelectableModel` 的返回 / `sessions.create` options 落行 / 首个 run 读取 options 的时机），只修该点。
3. 内置模型（`sonnet` 等）路径与未知模型拒绝路径保持不变。

## Acceptance Criteria

- [ ] AC1: 新用例：MCP `session_create` 带模型库条目 `v4.1flash` ⇒ 行上 `model = 'v4.1flash'`，首个 run 的 spawn 选项 model 为 `v4.1flash` 且带条目环境键（只断言键名，不断言 secret 值）。
- [ ] AC2: 同用例对内置模型 `sonnet` 与未知模型的既有行为不变（未知模型仍被 `INVALID_ARGUMENT` 拒绝）。
- [ ] AC3: 修复后真实复测一次（非 fixture）：粘贴网关行 model、宿主 argv `--model`、transcript `message.model` 三处读数。

## Definition of Done

AC1–AC3 带真实读数勾选；不改模型库条目内容与任何 secret；不重启他人会话。

## Touches

- server/modules/mcp-gateway/mcp-session-lifecycle.ts
- server/modules/mcp-gateway/tests/mcp-session-create-library-model.test.ts
- tasks/gap-mcp-session-create-drops-library-model.md
