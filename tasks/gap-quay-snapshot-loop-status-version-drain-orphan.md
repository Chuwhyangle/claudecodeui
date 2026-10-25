---
id: gap-quay-snapshot-loop-status-version-drain-orphan
title: Quay 服务端：snapshot 增加 loop 整体状态读数（版本偏差、drain、版本目录 orphan 倒计时、.quay/plugin 指针状态）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 相关的已完成任务：`gap-workspace-header-quay-pulse-trigger-and-session-popover`（标题栏触发器与 popover）与 `gap-quay-event-driven-refresh-capability-probe-and-dispatch-reading`（能力探测与事件触发刷新）。它们都不产出 loop 整体状态读数；没有同机制的在飞任务。结论：独立立案。

背景（2026-10-25 的实测与用户裁定）：Quay tab 要重排成「整体运行状态横带 + 三张时间图 + 本会话」在前、其余详情降级。横带需要几项目前 snapshot 没有的读数：loop 加载的 quay 版本与已安装版本是否一致、worker 等 driver 是否处于 drain、loop 所用的插件版本目录是否已被 Claude Code 标记为孤儿并将被清理。这些读数的来源都已存在，不需要新增 CLI 命令：
- snapshot 每次已经 spawn 一次 `quay driver status --kind worker --json`（`summarizeDriver` 只取了其中 4 个字段）。同一份 JSON 里已有 `loaded_version`（`current`、`behind`、`ahead`、`not-evaluated`）、`loaded`、`installed`、`loaded_kernel`、`anchor_pid`、`supervisor_stale`、`last_record_ts`，以及 quay 自己维护的 `pointer` 段（`state`、`core_version`、`link_target`、`link_version`，反映 `<项目>/.quay/plugin` 链接与已安装版本的偏差）。0.19.0 的二进制输出同样带这些字段，缺失时必须如实读成「未评估」。
- drain 状态在 `<项目根>/.quay/worker-control.json`、`promotion-control.json`、`quality-control.json` 的 `halted` 布尔值里（`quay driver drain` 写入，`resume` 清除）。
- Claude Code 的官方文档写明：插件 update 或 uninstall 后，旧版本目录里会写入 `.orphaned_at`（内容是毫秒时间戳），14 天后由后台清理删除。2026-10-25 实测：这个标记会在编辑安装记录后的下一次 `claude` 启动时出现，去掉标记不会被立即重标。长驻 anchor 从这些版本化目录运行，超期后其脚本会消失，所以这是 loop 必须能看见的风险。

要做的事：
- 在 `QuaySnapshot` 上增加一个**纯增量、可选**的字段 `loop`（`QuayLoopStatus | null`，缺失与 null 等价于「未读到」，不得读成「正常」）。不得加宽 `QuayDriverSummary` 或 `QuayDriverState`：它们有 9 个消费者（侧栏徽标、cockpit、fleet 汇总、观察层等），形状一变就波及它们的钉子。类型定义放在 `server/shared/types.ts`（`QuaySnapshot` 所在处），带完整文档注释。
- `QuayLoopStatus` 包含：`anchorPid`（数字或 null）；`kernel`：`{ loaded, installed, relation, reason }`，`relation` 取 `current`、`behind`、`ahead`、`not-evaluated`，来源是 `loaded_version`，遇到未知取值或字段缺失一律是 `not-evaluated` 并写明 `reason`，绝不默认成 `current`；`pointer`：`{ state, linkVersion, coreVersion }` 或 null，来源是 `pointer` 段；`drain`：`{ worker, promotion, quality }` 各为 true、false 或 null；`orphan`：`{ state, markedAt, removeAfter }`；`observedAt`。
- 零额外 spawn：`loop` 从 snapshot 已经取得的那份 `driver status` JSON 解析，不新增、不替换任何 CLI 命令（可复用现有的 `readJson` 结果）。drain 与 orphan 两项通过服务已有的文件读取接缝（`QuayFileReader`）读取，路径都在项目根或 Claude 插件缓存之下。
- drain：文件不存在读成 false（从未 drain 过），JSON 不合法或 `halted` 不是布尔读成 null，不得读成 false。
- orphan：只有当 `loaded_kernel` 是 Claude 插件缓存布局（`<插件根>/cache/<marketplace>/<plugin>/<版本>/…`，插件根默认 `~/.claude/plugins`，被 `CLAUDE_CODE_PLUGIN_CACHE_DIR` 覆盖）下的路径时才有意义：版本目录里有 `.orphaned_at` 为 `marked`（`markedAt` 取其时间戳，`removeAfter` = `markedAt` 加 14 天，14 天作为带文档出处的常量）；没有标记为 `none`；标记内容不合法或读取失败为 `not-evaluated`；`loaded_kernel` 不在缓存里（例如 scratch 构建）为 `not-applicable`。从 CLI 输出里取来的路径要做限定：规整后必须仍在缓存根之内，含 `..`、符号链接逃逸、非绝对路径一律为 `not-evaluated` 且不得读取缓存根之外的任何文件。
- `loop` 随 snapshot 一起被 TTL 缓存（现有 30 秒），不另设缓存；`driver status` 读取失败时 `loop` 为 null，不得编造。

不做：界面（由后续客户端任务做）；改 `quay driver` 的任何行为；对孤儿目录做任何清理或保护动作（只读）；MCP 网关；修改 `QuayDriverSummary`。

## AC

- [x] 解析：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/quay/tests/quay.service.test.ts` exit 0；新增用例以两份真实 `driver status --json` 输出为夹具（放在 `server/modules/quay/tests/fixtures/`，分别取自 `~/.claude/plugins/cache/quay/quay/0.22.0/bin/quay driver status --kind worker --json` 与 `~/.claude/plugins/cache/quay/quay/0.19.0/bin/quay driver status --kind worker --json`）：`loaded_version` 的四种取值逐一映射为 `relation`，`loaded`、`installed`、`anchorPid`、`pointer` 正确；未知取值与缺字段得到 `not-evaluated` 并带 `reason`，取假：把缺字段默认成 `current`，对应用例必须红。
- [x] drain：同一测试文件含用例：三个控制文件各自 `halted` 为 true、false、文件不存在、JSON 非法、`halted` 为字符串，分别得到 true、false、false、null、null；三个文件相互独立；读取路径只能落在 `<项目根>/.quay/` 之下。
- [x] orphan：同一测试文件含用例（注入文件读取接缝与假时钟）：缓存布局路径加合法标记得到 `marked` 且 `removeAfter` 恰为 `markedAt` 加 14 天；无标记得到 `none`；标记内容为空、非数字、读取抛错得到 `not-evaluated`；`loaded_kernel` 在缓存之外得到 `not-applicable`；`CLAUDE_CODE_PLUGIN_CACHE_DIR` 覆盖缓存根时按覆盖后的根判断；路径含 `..`、指向缓存根之外的符号链接、相对路径时得到 `not-evaluated`，并断言文件读取接缝没有被以缓存根之外的路径调用。取假：去掉路径限定，逃逸那几例必须红。
- [x] 零额外 spawn：同一测试文件含用例：用记录调用的命令桩调用 `getQuaySnapshot`，`driver status` 的调用次数与改动前相同（恰一次，kind 为 worker），`loop` 非空；`driver status` 失败时 `loop` 为 null 且 snapshot 其它部分不受影响；`loop` 与 snapshot 一起被 TTL 缓存，TTL 内第二次读取不再读控制文件与 `.orphaned_at`。
- [x] 形状安全：`git diff -U0 -- server/shared/types.ts` 中不含对 `QuayDriverSummary` 与 `QuayDriverState` 的任何改动；新增字段在 `QuaySnapshot` 上是可选的。以下兄弟测试全部通过：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/quay/tests/quay-uri-resolve.test.ts server/modules/mcp-gateway/tests/mcp-overview.test.ts server/modules/mcp-gateway/tests/mcp-read-tools.test.ts server/modules/mcp-gateway/tests/mcp-english-only.test.ts server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts`（exit 0）。若这些测试对 snapshot 做整体深度比较而需要改动，先在本任务的 Touches 里追加声明再改，且只加不改既有断言。
- [x] 导出与文档：`server/modules/quay/index.ts` 导出 `QuayLoopStatus` 类型；该类型及每个字段在 `server/shared/types.ts` 里有说明取值含义与「未评估」语义的文档注释；新增常量（14 天与出处）有注释。
- [x] 类型与静态检查：`npx tsc --noEmit -p server/tsconfig.json` exit 0，`npx oxlint server/modules/quay server/shared` exit 0，且 `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/server-import-cycle-budget.test.ts` exit 0（新增代码不得新增对其它 feature 模块的导入）。

## DoD

真实读数（后端任务，不需要浏览器）：在隔离实例（`scripts/isolated-instance.sh`；起之前按记忆关掉 residentRestore）里请求本项目与 cantus 项目的 `GET /api/quay/<projectId>/snapshot?refresh=1`，贴出两份 `loop` 字段：两者的 `kernel.relation` 应为 `current`、`loaded` 与 `installed` 均为 0.22.0（loop 已于 2026-10-25 迁到 user scope 的 0.22.0），`pointer.state` 与 `quay driver status` 的 `pointer.state` 一致，`orphan.state` 为 `none`。再用生产读取适配器直接读一个真实的孤儿目录：对 `~/.claude/plugins/cache/quay/quay/0.10.0/scripts/dist/driver-anchor.js` 这个路径求 orphan 读数，贴出 `marked`、`markedAt` 与 `removeAfter`（该目录的 `.orphaned_at` 记录的是 2026-10-25 21:24，预计清理时间 2026-11-08），与 `cat` 出的标记内容对照；对一个 scratch 构建路径（例如 `/data/home/yale/work/quay-scratch/official-dist-020-dev-r6-restart/scripts/dist/driver-anchor.js`）贴出 `not-applicable`。最后对本项目执行一次 `quay driver drain --kind worker` 再 `resume`，各贴一次 snapshot 的 `loop.drain.worker`（true 再 false），并确认整个过程中 `quay` 子进程里 `driver status` 只出现一次。

## Touches

- server/modules/quay/quay.service.ts
- server/shared/types.ts
- server/modules/quay/index.ts
- server/modules/quay/tests/quay.service.test.ts
- server/modules/quay/tests/fixtures/driver-status-worker-0.22.0.json (new)
- server/modules/quay/tests/fixtures/driver-status-worker-0.19.0.json (new)
- tasks/gap-quay-snapshot-loop-status-version-drain-orphan.md

## Blocker

**2026-10-25T14:30:46.669Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/providers/tests/claude-resident-busy-input.test.ts:   AssertionError [ERR_ASSERTION]: the leg-2 frame must be readable with its own uuid
- run_id：wk-prod-anchor
- session_id：2bfce5d5-3e5c-4c71-bfe8-87cf1255d5b2
