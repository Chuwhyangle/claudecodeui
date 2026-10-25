---
id: gap-session-mentions-reads-event-fresh-index-and-caches-goals
title: 会话提及读数改读事件保鲜的任务索引、goal 读数加单飞缓存：popover 打开不再每次拉两个 CLI（约 1.1s 降到毫秒级）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-quay-entrypoint-resolver-via-claude-plugin-scopes
---
## Proposal

<!-- dedup-ref --> 相关的已完成任务：`gap-quay-event-driven-refresh-capability-probe-and-dispatch-reading`（给 `readTaskIndex` 做了能力探测、fs.watch 加 `task log` 事件刷新、读 `worker-dispatch.json`，但明确没有改会话提及读数）与 `gap-quay-session-mentions-and-lanes-only-readings`（会话提及读数本身）。本任务是两者之间没接上的那一段，不是重复。相关的在飞任务：`gap-quay-entrypoint-resolver-via-claude-plugin-scopes`（解析 quay 入口，见 frontmatter 的 depends_on，它决定 `runQuayCommand` 用哪个二进制）、`gap-quay-snapshot-loop-status-version-drain-orphan`。三者在 `quay.service.ts` 与 `quay.module.ts` 上有 Touches 重叠，由调度器串行；本任务不拆进它们。

现状（2026-10-25 实测，运行构建 gitSha 440e5dcbd）：
- `server/modules/quay/quay.module.ts` 里 `sessionMentions` 的 `readTaskRows` 与 `readGoalRows` 每次请求都分别 spawn `quay task list --json --no-body`（约 254ms，565KB）与 `quay goal list --json`（约 790ms，1.28MB，`--kind goal` 不省时），没有缓存，也不经过 `readTaskIndex`。浏览器里 popover 每次打开请求 `session-mentions` 实测 1076ms 与 1349ms。
- 事件刷新只喂 `readTaskIndex`（MCP `changes` 工具在用），而且事件监视器要等有人 `readTaskIndex` 之后才激活（`taskIndexReadListener.current = quayTaskEvents.noteProjectRead`）。popover 从不读索引，所以这套事件机制对它零帮助，也永远不会被它激活。
- 数据本身是新鲜的（每次都重读），代价是每次打开约 1.1 秒和两次大体量 CLI 解析。

要做的事：
一、任务状态走索引，条件是「此刻索引由事件保鲜」
- `session-mentions` 取任务状态、标题与 `goal_ac` 时，先 `readTaskIndex(projectId)`（这同时触发活动信号，让事件监视器激活）。满足下面全部条件才直接用索引，零次 spawn：`quayTaskEvents.readMonitorState(projectId).state` 为 `active`，且索引读数 `state` 为 `ready`（在新鲜窗口内）。
- 其余情况（监视器 `off` 或 `degraded`；索引 `cold`、`warming`、`stale`、`error`）一律退回今天的直接 `task list --json --no-body` 读取，保证新鲜度不比今天差；索引为 `stale` 或 `cold` 时同时调一次 `requestTaskIndexLoad`，让下一次打开能走索引。
- 这样做的代价要写清楚：手改任务文件不发事件，事件路径下 popover 看到的最坏陈旧度等于索引的新鲜窗口（与 MCP `changes` 一致），而不是每次都现读。循环里的状态流转（晋升、fan-in、撤回）由事件在约 250ms 防抖后刷新。
- 索引行需要 `goal_ac` 才能做任务 → AC → goal 的反查：给服务内部的索引行加可选字段 `goalAc: string | null`，由现有加载器从同一次 `task list --json --no-body` 的行里解析 `goal_ac` 得到（不新增 CLI 调用）；事件应用时对已知任务保持 `goalAc` 不变。MCP 网关读到的对外形状与输出一律不变，这是它与会话提及读数当初分开取数的原因，必须用测试证明没有波及。
- 索引里的标题已按 `QUAY_TASK_INDEX_TITLE_LIMIT`（80 字符）截断；popover 的标题行本来就是单行省略，这个上限就是它的显示边界，响应里的 `title` 直接取索引值。

二、goal 读数加单飞缓存
- `goal list --json` 在进程内按项目缓存：TTL 60 秒，并发请求共享同一次 spawn（单飞）。goal 状态与 AC → goal 归属变化很慢。TTL 内第二次请求零次 spawn。读取失败（非零退出、解析失败）不缓存为「没有 goal」：该次返回与今天相同的「goal 读数不可用」语义，下一次请求立即重试，不做负缓存。
- quay 的 `goal list --no-body`、`--since`、`goal log` 尚未发布（0.22.0 没有），本任务不采用；等发布后另立任务，用能力探测接入。

三、响应里加只读的来源标记，便于判据与排障
- `session-mentions` 的响应增加 `sources: { tasks: 'index' | 'cli', goals: 'cache' | 'cli' }`，仅作加字段，不改任何既有字段；前端的类型与组件不改（多出的字段被忽略）。

不做：任何前端改动（popover 界面、轮询间隔、WebSocket 推送）；`live-state.json`；`goal list --no-body` 与 `goal log` 的采用；MCP 网关；索引 TTL、最小间隔、并发上限等现有常量。

## AC

- [ ] 索引新鲜时零 spawn：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/quay/tests/session-mentions.test.ts` exit 0；含用例：注入索引读数（`state: 'ready'`，行带 `goalAc`）与监视器状态 `active`，请求会话提及后，任务的 status、title、goalId 都来自索引，命令桩记录到的 `task list` 调用数为 0，响应 `sources.tasks` 为 `index`。
- [ ] 不新鲜就退回直读：同一测试文件含用例，逐一令监视器为 `off`、`degraded`，或令索引为 `cold`、`warming`、`stale`、`error`，每种情形都恰好发生一次 `task list --json --no-body` 直读、`sources.tasks` 为 `cli`；`stale` 与 `cold` 两种还恰好触发一次 `requestTaskIndexLoad`。取假：去掉对监视器状态的判断，`degraded` 那一例必须红；去掉对索引状态的判断，`stale` 那一例必须红。
- [ ] 事件链路端到端：同一测试文件含用例，用真实的 `createQuayTaskEvents` 加假时钟与 `task log` 桩：先让监视器激活，再投递一条某任务 `ready → done` 的事件页，推进防抖时间，之后的会话提及请求报出该任务为 `done`，期间 `task list` 的 spawn 数为 0。
- [ ] goal 缓存：同一测试文件含用例：TTL 内两次请求只发生一次 `goal list`；并发的三次请求只发生一次；推进时钟越过 TTL 后再请求发生第二次；`goal list` 返回非零退出时，该次的 goal 相关字段与今天的「读数不可用」语义一致，且紧接着的下一次请求会再 spawn 一次（没有把失败缓存成空）。
- [ ] 索引行带 `goal_ac` 且不波及 MCP：`server/modules/quay/tests/quay.service.test.ts` 新增用例：加载器把 `task list --json --no-body` 行里的 `goal_ac` 解析进索引行的 `goalAc`（缺省为 null），事件应用状态转移后已知任务的 `goalAc` 保持不变；`git diff --stat -- server/modules/mcp-gateway` 无输出，`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/mcp-gateway/tests/mcp-changes.test.ts server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts server/modules/mcp-gateway/tests/mcp-english-only.test.ts` exit 0。
- [ ] 既有行为不变：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/quay/tests/quay.service.test.ts server/modules/quay/tests/session-mentions.test.ts server/modules/quay/tests/session-task-chain.test.ts` exit 0；会话提及响应对除 `sources` 之外的字段，与改动前在同一组输入下逐字段深度相等；`git diff --stat -- src/` 无输出（不动前端）。
- [ ] 钉子与静态检查：不新增 server 测试文件，只在既有文件里加用例；`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts server/shared/tests/server-import-cycle-budget.test.ts` exit 0；`npx tsc --noEmit -p server/tsconfig.json` exit 0 且 `npx oxlint server/modules/quay` exit 0。

## DoD

真实读数（后端任务，不需要浏览器截图，但要有真实对象的读数）：在隔离实例（`scripts/isolated-instance.sh`；起之前按记忆关掉 residentRestore）里对本项目贴出：(1) 冷启动后第一次 `session-mentions` 与随后连续 5 次的 `curl -w` 耗时与响应里的 `sources`——第一次应为 `cli`，随后应为 `index` 与 `cache`，后 5 次中位耗时应明显低于 300ms，并贴出改动前同一会话的耗时作对照（约 1.1 秒）；(2) 事件保鲜的实证：在 repo 之外的临时目录（不要放进 repo，Vite 的 watcher 会被拖垮）用 `quay init` 建一个只有 3 个任务的临时 quay 项目并登记到隔离实例，让该项目的监视器激活后，用 `quay task edit <id> --status ...` 改一个任务的状态，贴出 1 秒内会话提及响应里该任务状态已变且 `sources.tasks` 仍为 `index`，同时贴出这一段期间服务端没有新的 `task list` 子进程的证据；(3) 监视器被关掉或 `task log` 能力缺失时（可在该临时项目上令入口缺失）`sources.tasks` 为 `cli`，行为与今天相同。

## Touches

- server/modules/quay/session-mentions.service.ts
- server/modules/quay/quay.service.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/tests/session-mentions.test.ts
- server/modules/quay/tests/quay.service.test.ts
- tasks/gap-session-mentions-reads-event-fresh-index-and-caches-goals.md
