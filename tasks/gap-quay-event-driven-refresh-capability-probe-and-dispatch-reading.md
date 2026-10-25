---
id: gap-quay-event-driven-refresh-capability-probe-and-dispatch-reading
title: Quay 服务端消费端：能力探测与降级、fs.watch + task log 事件触发刷新、读 worker-dispatch.json（TTL
  全量兜底保留）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 相关的已完成任务：`gap-mcp-changes-quay-status-index-async-bootstrap`（任务状态索引的异步引导，本任务的刷新入口之一）、`gap-session-hosts-poll-to-ws-invalidate` 与 `gap-session-watcher-native-or-adaptive-poll`（轮询改事件触发的同类做法，对象与机制不同）。没有同机制的在飞任务；quay 仓库里另有一批读取面任务（tail cursor、worker-dispatch 契约、live-state、lanes 读取成本、goal 瘦读），都在对方仓库，不在本库任务图里。结论：独立立案。

背景（2026-10-25 与 quay 一侧会话讨论后的实测事实）：今天 CloudCLI 服务端读 quay 状态全靠 spawn `quay` CLI 加 TTL。任务状态索引（`readTaskIndex` / `requestTaskIndexLoad`，被 MCP `changes` 工具与会话提及读数使用）的 TTL 是 120 秒、两次加载最小间隔 60 秒、并发不超过 2，所以一次状态变化最坏约 2 分钟后才可见；lanes 的缓存是 30 秒。quay 已发布一个增量事件读取面，可以把常见情况降到约 1 秒，但有几个必须按事实处理的边界：
- `quay task log --json --since <cursor|ISO8601> --limit <n≤500>` 从 quay v0.20.0 起存在；v0.19.0 没有。本项目的 `.quay/plugin` 目前指向 0.19.0，所以必须同时支持「有」与「没有」两种世界，没有时行为与今天逐字相同。`lanes` 从 v0.19.0 起就有。能力一律按探测判断，不比版本号。
- `task log` 返回 `{ transitions, nextCursor, complete, coverage, generatedAt, rebase, rebaseReason }`，单次约 115ms。`nextCursor` 是 `{v, carrierEpoch, seq}`，含语义且 at-least-once（恢复边界会重发最后一条，按 `eventId` 去重，cursor 必须原样回传）；本页零条已投递时 `nextCursor` 为 null；`rebase: true` 表示载体被替换、必须从头重同步。`complete` 在本库恒为 false（对方的 reconcile 没有调度面），一律忽略。
- 事件只在任务状态转移时写：标题、正文、标签的修改不发事件；创建事件不带 title 与 goal_ac；手改文件与 git 操作不发事件。所以全量 TTL 刷新必须原样保留，事件路径只加速、不替代。
- 目前拿不到「当前尾部」的 cursor（quay 一侧已立任务补 `tailCursor` / `--since tail`，尚未发布）。在它发布之前，用「全量加载开始时刻的 ISO 时间」作为起点播种；响应里若出现 `tailCursor` 字段就直接用它。
- 载体在 `<projectRoot>/.quay/task-status-events.jsonl`（本库被 `.quay/*` 忽略）。另有 `<projectRoot>/.quay/worker-dispatch.json`：worker-driver 在 spawn 后原子写（tmp 加 rename）、终态删除，按 taskId 索引，含 runId、workerPid、startedAtMs、timeoutDeadlineMs、cmdlineFingerprint；没有 phase、没有心跳，也不含机械 fan-in 窗口；无在飞时内容是 `{}`。

要做的四块：

一、能力探测与降级（新增 `quay-capabilities.ts`）
- 用现有进程适配器对项目解析出的 quay 入口跑一次 `--help`，解析出 `task log` 与 `lanes` 动词是否存在；`--help` 只用来探测动词，不用它判断响应字段：`tailCursor` 这类字段只出现在 JSON 响应里，是否写进帮助取决于实现者，字段一律看响应里有没有这个键（见下面的播种一条）。每项能力三态：`available`、`absent`、`unknown`。探测失败（spawn 错误、超时、非零退出且无输出）只能是 `unknown`，不得读成 `absent`。
- 探测结果按入口的 realpath 加 mtime 加 size 缓存（符号链接换了指向、二进制被更新都会重探）；`unknown` 不长期缓存，按 60 秒退避重试。能力状态变化时记一行日志（每个项目每次变化一行）。
- 只读白名单（`isReadOnlyQuayCommand`，现为整条参数精确匹配）要接纳两种新读法而不放过写动词：`['--help']`；以及 `task log --json --since <S> --limit <N>`，其中 S 必须是合法的 ISO8601 时刻或只含 `v`、`carrierEpoch`、`seq` 三个键且类型正确的 cursor JSON，N 是 1 到 500 的整数，多一个 token 都拒绝。固定条目保持精确匹配，任务日志这一条用结构化校验，不得退化成前缀匹配。

二、事件触发的任务状态刷新（新增 `quay-task-events.service.ts`）
- 条件：某项目的任务索引已成功加载过一次，且 `task log` 能力为 `available`，且该项目近 10 分钟被读过；否则这个项目没有监视器、没有 `task log` 调用。同时活跃的项目监视器上限 16，超过按最近最少使用淘汰，闲置 10 分钟自动停止。
- 监视对象是 `<projectRoot>/.quay` 目录而不是单个文件（原子 rename 会让文件级监视器指向旧 inode），按文件名过滤，只响应 `task-status-events.jsonl` 与 `worker-dispatch.json`；其它文件名（例如 `gate-events.jsonl`）的变化一律忽略。用注入的 `watchPath` 接缝，生产适配器基于 `fs.watch` 且 `persistent: false`；目录不存在时该项目为 off，不抛错，下次激活再试。监视器报错进入 `degraded` 并记录原因，之后只剩 TTL 路径，不得静默。进程退出时关闭全部监视器。
- 触发：变化通知防抖 250ms 合并，单飞（执行中又来变化则结束后恰好补一次），然后 `task log --json --since <cursor> --limit 500`；一页满 500 条就立刻再取，最多连续 5 页。
- 播种：全量加载完成后，起点是该次加载开始时刻减 2 秒的 ISO 时间；响应的 `nextCursor` 为 null 就继续用同一个 ISO 起点，非 null 之后改用 cursor 原样回传；响应带 `tailCursor` 就直接以它播种。
- 应用：按 seq 顺序处理；已知任务更新状态与更新时间；按 `eventId` 去重，重复投递幂等；事件的 `at` 早于该任务行的基线加载时刻时忽略（手改文件造成的状态不能被更早的事件回退）；创建事件或不在索引里的任务触发一次全量加载 `task list --json --no-body`，事件路径对它的最小间隔是 5 秒（不是现有的 60 秒），并发仍受现有上限约束；`rebase: true`、`carrierEpoch` 变化、响应不是合法 JSON 或缺字段，都触发全量加载并把 cursor 复位为未播种；`task log` 本身失败进入 `degraded`，按 5 秒起翻倍、封顶 60 秒的退避重试。
- 全量 TTL 刷新照旧：TTL 常量一个都不改，事件持续到达时 TTL 到点仍会全量加载一次。

三、读取 `worker-dispatch.json`（新增 `quay-dispatch-carrier.ts`）
- 服务端提供只读的 `readDispatchSet(projectId)`：文件不存在为 `absent`，内容 `{}` 为 `empty`，有条目时逐条判存活：workerPid 对应进程存在为 `live`、不存在为 `residue`（EPERM 算存在）；JSON 非法、不是对象、超过 1MB 一律是 `not-evaluated`，绝不当成 `empty`。路径只能是 `<projectRoot>/.quay/worker-dispatch.json`。
- 该文件的变化是 lanes 缓存的失效信号：监视到变化时，让该项目所有窗口的 lanes TTL 缓存失效，下一次 lanes 读取立刻重新 spawn，不必等 30 秒；其它项目的缓存不动。phase 仍然只来自 lanes，本文件不提供 phase。

四、边界
不做：客户端推送或 WebSocket 通道，也不缩短前端轮询间隔（服务端缓存变热以后这是后续的便宜决定）；改变 quay 二进制的解析策略（`<项目>/.quay/plugin` 优先、其次 PATH 的现行做法保持不变，因为同机其它项目有意钉版）；goal 一侧的读取（`goal log`、`goal list --no-body`，等 quay 发布后另立）；MCP 网关；`live-state.json`。本项目 `.quay/plugin` 指向哪个版本是环境问题，不在本任务内；本任务保证无论指向哪个版本都正确。

## AC

- [x] 能力探测：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/quay/tests/quay-live-refresh.test.ts` exit 0；其中探测用例以两份真实 `--help` 文本为夹具（放在 `server/modules/quay/tests/fixtures/`，分别取自 `~/.claude/plugins/cache/quay/quay/0.19.0/bin/quay --help` 与 `~/.claude/plugins/cache/quay/quay/0.22.0/bin/quay --help`）：0.19.0 夹具得到 `task log` 为 `absent`、`lanes` 为 `available`，0.22.0 夹具两者都为 `available`；spawn 错误、超时、非零退出且无输出一律得到 `unknown` 而不是 `absent`；同一入口第二次探测不再 spawn，入口 realpath 或 mtime 变化后重探；`unknown` 在退避期内不重探、退避后重探（假时钟）。
- [x] 白名单：同一测试文件含用例：`['--help']`、`task log --json --since <合法 ISO> --limit 500`、`task log --json --since <合法 cursor JSON> --limit 1` 被接纳；`--limit 0`、`--limit 501`、`--limit abc`、缺 `--since`、`--since` 为乱码、cursor JSON 含多余键或类型错误、尾部多一个 token、缺 `--json`，以及 `task create`、`task edit`、`goal write`、`goal batch`、`goal gate`、`promote`、`retreat`、`driver start` 一律被拒。取假：把 task log 条目改成 `task` 前缀匹配，拒绝写动词的那几例必须红。`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/quay/tests/quay.service.test.ts` exit 0 且 `git diff --stat -- server/modules/quay/tests/quay.service.test.ts` 无输出。
- [x] 事件应用：同一测试文件含用例（注入脚本化的命令桩与假时钟）：已知任务的状态转移更新索引行且不触发 `task list`；同一 `eventId` 重复投递幂等；乱序到达的 transitions 按 seq 应用；事件 `at` 早于该行基线加载时刻时不回退手改得到的状态；响应里 `complete: false` 不产生任何副作用。
- [x] 全量刷新触发：同一测试文件含用例：创建事件或不在索引里的任务在一个事件周期内触发恰好一次 `task list --json --no-body`（不等 60 秒），一阵创建事件下 5 秒内至多一次；`rebase: true`、`carrierEpoch` 变化、非法 JSON、缺字段各自触发全量加载并把 cursor 复位为未播种；`task log` 失败进入 `degraded` 且记录原因，按 5 秒起翻倍封顶 60 秒的退避重试，期间 TTL 路径不受影响。
- [x] cursor 处理：同一测试文件含用例：无 `tailCursor` 时第一次调用用「加载开始时刻减 2 秒」的 ISO；响应 `nextCursor` 为 null 时下一次仍用同一个 ISO；非 null 后每次调用回传的 cursor 与上次返回值深度相等且键序不变；响应带 `tailCursor` 时首次就以它播种、不用 ISO（无论夹具里的 `--help` 文本有没有 `tailCursor` 字样，判据只看响应里有没有这个键）；一页满 500 条立刻续取、最多连续 5 页。
- [x] 监视器：同一测试文件含用例（注入 `watchPath` 与假定时器）：250ms 内连续 10 次变化通知恰好 1 次 `task log`；执行中又来变化，结束后恰好补 1 次；`.quay` 里其它文件名（`gate-events.jsonl` 的 change 与 rename）不触发任何 spawn；`worker-dispatch.json` 与事件文件的原子替换（rename 通知）被正确处理；监视器 error 进入 `degraded` 而不是静默；`.quay` 目录不存在时为 off 且不抛错；第 17 个活跃项目淘汰最近最少使用者；闲置 10 分钟自动停止；进程退出钩子关闭全部监视器。
- [x] 降级与兜底：同一测试文件含用例：`task log` 能力为 `absent` 或 `unknown` 时零监视器、零次 `task log` spawn，任务索引的加载行为与今天一致；能力为 `available` 且事件持续到达时，TTL 到点仍会再做一次全量 `task list`（假时钟推进过 120 秒）；`QUAY_TASK_INDEX_TTL_MS`、`QUAY_TASK_INDEX_MIN_INTERVAL_MS`、`QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS` 三个常量的取值不变；`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/quay/tests/quay-fleet-summary.test.ts` exit 0 且 `git diff --stat -- server/modules/quay/tests/quay-fleet-summary.test.ts` 无输出。
- [x] dispatch 读取：同一测试文件含用例：文件不存在为 `absent`，`{}` 为 `empty`，条目 workerPid 存活为 `live`、不存在为 `residue`，JSON 非法、非对象、超过 1MB 为 `not-evaluated`；取假：把非法 JSON 读成 `empty`，对应用例必须红；读取路径只能落在 `<projectRoot>/.quay/worker-dispatch.json`。
- [x] lanes 失效：同一测试文件含用例：先让某项目的 lanes 缓存变热，模拟 `worker-dispatch.json` 变化后，该项目任一窗口的下一次 lanes 读取立刻再次 spawn `lanes`；另一个项目的缓存不受影响；`lanes` 能力缺失时 `plugin-lacks-lanes-verb` 的降级语义不变。
- [x] 其它消费者不受影响：`git diff --stat -- server/modules/mcp-gateway` 无输出；`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/mcp-gateway/tests/mcp-changes.test.ts server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts server/modules/mcp-gateway/tests/mcp-english-only.test.ts` exit 0。
- [x] 钉子不红：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts server/shared/tests/server-import-cycle-budget.test.ts` exit 0。新增 1 个 server 测试文件会移动覆盖率地板与 unknown 计数钉子：在 `scripts/suite-duration-baseline.tsv` 追加该文件的一行并同步 `quay-test-script.test.ts` 的计数；新增的三个源文件不得新增对其它 feature 模块的导入，导入环预算不得增长。
- [x] 类型与静态检查：`npx tsc --noEmit -p server/tsconfig.json` exit 0，且 `npx oxlint server/modules/quay` exit 0。

## DoD

真实读数（后端任务，不需要浏览器）：准备两个 quay 项目根：一个 `.quay/plugin` 指向不低于 0.20.0 的真实安装（例如把一个 `tmp/` 下的最小 quay 项目的 `.quay/plugin` 链到 `~/.claude/plugins/cache/quay/quay/0.22.0`，或使用 `.quay/plugin` 已指向该版本的真实项目），另一个指向 0.19.0（本项目现状）。在隔离实例（`scripts/isolated-instance.sh`；起之前按记忆关掉 residentRestore）里分别做：(1) 贴出两个项目的能力探测日志行（0.22.0 项目 `task log` 为 available，0.19.0 项目为 absent）。(2) 让一个会话的 transcript 正文提到某个任务 id，请求 `GET /api/quay/<projectId>/session-mentions?sessionId=<id>` 记下该任务的 status；随后用 `quay task edit <id> --status <另一状态>` 改它，每 200ms 轮询同一请求，贴出「改动时刻到响应显示新状态」的耗时：0.22.0 项目应在约 2 秒内，0.19.0 项目仍按 TTL（最坏约 2 分钟）。(3) 采样该期间的 `quay` 子进程：0.22.0 项目只出现少量 `task log`（每次变化各一次），没有周期性全量；贴出子进程采样与监视器状态日志。(4) 新建一个任务后贴出创建触发一次全量 `task list` 的耗时。(5) 对 `.quay/worker-dispatch.json` 做一次真实变化（派发或手工写入再还原），贴出该项目下一次 lanes 读取立刻 spawn 的证据，以及非法内容下 `readDispatchSet` 为 `not-evaluated` 的读数。(6) 把监视器的 `.quay` 目录改名后确认 off 而不是崩溃，再还原。

## Touches

- server/modules/quay/quay-capabilities.ts (new)
- server/modules/quay/quay-task-events.service.ts (new)
- server/modules/quay/quay-dispatch-carrier.ts (new)
- server/modules/quay/quay.service.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/index.ts
- server/modules/quay/tests/quay-live-refresh.test.ts (new)
- server/modules/quay/tests/fixtures/quay-help-0.19.0.txt (new)
- server/modules/quay/tests/fixtures/quay-help-0.22.0.txt (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-quay-event-driven-refresh-capability-probe-and-dispatch-reading.md
