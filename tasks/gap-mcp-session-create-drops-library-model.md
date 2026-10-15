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

- [x] AC1: 新用例：MCP `session_create` 带模型库条目 `v4.1flash` ⇒ 行上 `model = 'v4.1flash'`，首个 run 的 spawn 选项 model 为 `v4.1flash` 且带条目环境键（只断言键名，不断言 secret 值）。
  - 用例：`server/modules/mcp-gateway/tests/mcp-session-create-library-model.test.ts`（真 express + 真 MCP SDK 客户端 + 真 SQLite + 真 `sessionsService` / `providerModelsService` / `providerCapabilitiesService`，经 `server/index.ts` 同款导出的 `buildSessionCreateDeps` 装配）。
  - 读数：`adapterArgs=[{"model":"v4.1flash"}]`、`row model=v4.1flash effort=null permissionMode=bypassPermissions`、`launchModel="v4.1flash"`、`spawnModel="v4.1flash"`、`envKeys=["ANTHROPIC_LIBRARY_PROBE_BASE_URL","ANTHROPIC_LIBRARY_PROBE_TOKEN"]`（只比对键名，未读取、未打印、未比对任何值）。
  - 反向对照（同一探针，把装配换成修复前的三参适配器形态）：`adapterArgs=[null]`、`row model=null` ⇒ 该断言确实判得出丢失，不是恒真。
  - 定位结论：丢失点是 `buildSessionCreateDeps` 的 `create` 适配器只声明了前三个形参、第四个 `selection` 被丢弃；`assertSelectableModel` 对模型库条目正常返回该 id（`Supported models: …, v4.1flash`），`sessionsDb.createAppSession` 落行也正常——Proposal 里的两个怀疑都不是丢失点。
  - 修复触及的文件（Touches 已据此更新）：`server/modules/mcp-gateway/mcp-session-write-deps.ts`（转发生效）、`server/modules/mcp-gateway/mcp-session-lifecycle.ts`（工具侧本就把 `selection` 交给 `sessions.create`，无需改动，留在 Touches 备查）。
- [x] AC2: 同用例对内置模型 `sonnet` 与未知模型的既有行为不变（未知模型仍被 `INVALID_ARGUMENT` 拒绝）。
  - 读数：内置 `sonnet` ⇒ `row model=sonnet`、`launchModel="sonnet"`、`spawnModel="sonnet"`、`libraryKeysPresent=[]`（条目环境键缺席——这同时证明 AC1 读到的键来自条目而非宿主环境）；未知模型 `v4.1flash-typo-not-a-model` ⇒ `code=INVALID_ARGUMENT`（`Supported models: default, best, fable, sonnet, sonnet[1m], opus, opus[1m], haiku, opusplan, v4.1flash`），且未新建任何行、未开任何 run。
- [x] AC3: 修复后真实复测一次（非 fixture）：粘贴网关行 model、宿主 argv `--model`、transcript `message.model` 三处读数。
  - 真实实例（非 fixture）：`npx tsx --tsconfig server/tsconfig.json server/index.ts`，cwd = 本任务 worktree（跑的是修复后的代码）；临时 `DATABASE_PATH`（真实库的字节副本，未改动真实库）、临时 `HOME` / `CLAUDE_CONFIG_DIR`；端口 21683（`listen(0)` 探得、断言 ≠ 3001，全程未触碰 3001 上的生产网关）；`MCP_ENABLED=1`；经 3001 之外的这条实例播种真 PAT，用真 MCP HTTP 调用 `session_create{project, provider:'claude', model:'v4.1flash', lifecycleMode:'resident', permissionMode:'bypassPermissions', message:…}`。
  - 网关行 model：会话 `9a528ee0-4497-497f-a20a-361e8690a75d` 的 `sessions` 行 `model = "v4.1flash"`、`effort = null`、`permission_mode = "bypassPermissions"`。
  - 宿主 argv `--model`：宿主进程 pid 4126757（该实例 server pid 4101640 的后代；实例自身收尾行 `shutdown-close host=host-504e3861-a11b-4bc2-ab41-9a7f5085473c provider=claude mode=resident pid=4126757 closeReason=server-shutdown`）argv `["…/bin/claude","--output-format","stream-json","--verbose","--input-format","stream-json","--model","v4.1flash", …]`。
  - transcript `message.model`：`deepseek-flash`（`claude-config/projects/-tmp-ac3-libmodel-2ylLyr-project/ae90a861-641c-4da9-93d4-b7bbfa064e32.jsonl`，24 条）——与 Proposal 里 Web UI 建的同条目会话一致。
  - 该复测的判别力（同一条探针对修复前代码再跑一次）：行 `model = null`、宿主 argv `--model default` —— 与 Proposal 的缺陷读数逐项吻合，说明这条真实复测确实走的是修复分支。诚实说明：transcript 那一处在两臂都是 `deepseek-flash`（本机宿主环境自身就把端点指向同一网关），因此它**不具判别力**；有判别力的是「行」与「宿主 argv」两处。
  - 约束核对：未修改模型库条目内容与任何 secret（临时实例读的是库副本，仅比对键名）；未重启或触碰任何他人会话；探针临时目录（含库副本）已删除。

## Definition of Done

AC1–AC3 带真实读数勾选；不改模型库条目内容与任何 secret；不重启他人会话。

## Evidence

2026-10-15（重试轮，exited-not-landed 复验）：本任务新增的 server 测试文件把 develop 的收集数从 336 抬到 337，`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin 因此过期——单文件复跑确定性复现：AC2 实读 `known=3 unknown=334`（钉 `333`）、AC3 实读 `known=1 unknown=336`（钉 `335`），整轮 fan-in suite 唯一红腿即此文件（`__PERFILE__ … passed=false`，非环境抖动：isolated 复跑 rc=1）。这**不是**无关 flake，正是本仓既有的「新增 server 测试文件即搬钉子」系统性地板（前例 `ee1a62fa5` / `a169eb60b` / `d87945aca`）。

修法（本仓既有惯例）：
- `server/shared/tests/quay-test-script.test.ts`：AC2 pin `unknown=333` → `334`、AC3 pin `unknown=335` → `336`，两条注释里的收集数 336 → 337。
- `scripts/suite-duration-baseline.tsv`：追加 `3491<TAB>server/modules/mcp-gateway/tests/mcp-session-create-library-model.test.ts`（单文件实测，本仓 fan-in lane 同款命令），并把头部 `so this file now covers` 由 336/336 改为 337/337，同时在「row by <task>」清单里记一条本任务。AC7 地板由 336/337 = 99.7% 升到 337/337。
- 两个文件经 task_write 补进 `## Touches`（它们不在原定 Touches 里，否则 anti-drift 报 out-of-declared）。

修后单文件复跑 `server/shared/tests/quay-test-script.test.ts`：14/14 绿（AC7 / AC2 / AC3 三条腿全过）。

## Touches

- server/modules/mcp-gateway/mcp-session-lifecycle.ts
- server/modules/mcp-gateway/mcp-session-write-deps.ts
- server/modules/mcp-gateway/tests/mcp-session-create-library-model.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-session-create-drops-library-model.md

## Blocker

**2026-10-15T06:56:55.393Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=209882 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1792046805421
- run_id：wk-prod-anchor
- session_id：81e465cc-c395-449e-afae-16b16489a13a
