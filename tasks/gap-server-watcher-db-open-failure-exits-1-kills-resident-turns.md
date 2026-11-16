---
id: gap-server-watcher-db-open-failure-exits-1-kills-resident-turns
title: Cloudpit server crashes twice with exit code 1, killing resident session turns
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

### 背景

On 2026-11-16 (local CST) the systemd user unit `claudecodeui-server.service` (ExecStart `node dist-server/server/index.js`, port 3001) exited with code 1 twice:
- 2026-11-16T14:43:13+08:00 — main process exited, code=exited, status=1/FAILURE; systemd restarted at 14:43:18 (restart counter 2).
- 2026-11-16T14:46:19+08:00 — same; restarted at 14:46:24 (restart counter 3). Current main pid 984604.
Each crash tore down all 16 `claudecodeui-session-<serverPid>-*.scope` resident Claude CLI processes (journal shows all scopes "Consumed" in the same second), killing in-flight turns and background Bash. Three resident sessions were interrupted mid-turn: 3ccf0c92-ed6e-4cfe-9493-35ed8e8c57f1 (ppwr, provider session 08e1acbe..., last record 14:46:19.371 a Bash tool_use with no tool_result), 70837f4b-c757-4e08-8c52-07f63d645e59 (falcon, 5260a312..., last 14:46:19.200 a Bash tool_use with no tool_result), and e98e6966-5fd7-4528-9a60-69c670000937 (falcon, 7ede25c1..., API request in flight at 14:46:16.497; its background download was killed at 14:43:13 and again at 14:46:18). resident-restore resumed 16/16 after each restart but does not replay the interrupted turns.

### 证据

- `server.log` (415 MB append log) around lines 4838560-4838600 and 4839180-4839250:
  - repeated `SqliteError: unable to open database file` (ui-last-opened.repository / recordOpenedSession) at 06:42:53.637Z, 06:43:06.548Z, 06:43:10.235Z;
  - `Session watcher sync failed for provider "claude" { error: 'unable to open database file' }` at 06:43:01.960Z and 06:33:44Z etc.;
  - at 06:46:18.786Z the log line is truncated mid-write at `Session watcher sync failed for provider "claud` and the process ends; no stack trace / no uncaught-exception message was captured.
- `journalctl --user -u claudecodeui-server.service` confirms `code=exited, status=1/FAILURE` both times; no SIGKILL/OOM entry; dmesg has no OOM/segfault.
- `~/.cloudpit/auth.db` currently opens fine and `PRAGMA quick_check` = ok; 11097 sessions. So DB corruption is not the state now.
- Server code: `server/modules/providers/services/sessions-watcher.service.ts:839` logs the failure inside try/catch (should not exit). The only `process.exit(1)` in `server/index.ts:2840` is the startup-failure path. So the exit-1 path is currently unexplained.

### 要求

1. Explain the exit-1 path with captured evidence (uncaughtException/unhandledRejection handler + stack, or identify the library/handler that exits 1). Reproduce under a test (fault injection: make the DB briefly unopenable / emit a watcher sync failure) and show the process exits or is guarded.
2. Add a guard so a single watcher/DB open failure cannot kill the server, and so the process logs the full stack before any exit (fail-closed without silent truncation).
3. Prove that, after a server crash/restart, in-flight resident turns are either replayed or explicitly surfaced to the user as interrupted (not silently stuck at a dangling tool_use). If replay is out of scope, make the limitation explicit and produce the user-visible signal.
4. Regression evidence must be runnable from a Claude session under the project's memory-cap rules (single test file / scoped runner; never full-suite fan-out).

### 落点（本检出复核过的两处事实纠正 + 一条范围纪律）

- **路径纠正（不许照抄错误路径）**：`server/modules/database/repositories/ui-last-opened.db.ts` 在本检出**不存在**；实际文件是 `server/modules/database/repositories/sessions/ui-last-opened.db.ts`（`server/modules/database/index.ts:102` 逐字 `export { uiLastOpenedDb } from '@/modules/database/repositories/sessions/ui-last-opened.db.js';`，该文件 `record()` 里第一行即 `const db = getConnection();`）。Touches 按真实路径登记。
- **退出点复核**：`server/index.ts:2840` 逐字 `process.exit(1);`，其上 `:2839` 为 `console.error('[ERROR] Failed to start server:', error);`，所在 `catch` 是启动路径；`:2851` 起的 `RESIDENT_RESTORE_STARTUP_DELAY_MS` 注释逐字说明重启只做「把最近活跃的常驻会话拉回来」（bring the most recently active resident sessions back at boot），**不重放**被打断的 turn。
- **范围纪律**：只允许改 `## Touches` 列出的文件。若守卫 / 中断标记必须落到别的文件（例如数据库连接层、常驻会话服务、或新增的崩溃处理模块），**先用 `task_write` 把它加进 Touches 再改**，不要先改后补。

### 去重与粒度

<!-- dedup-ref -->
- **机制去重**（本 agent 无 Bash，按 ABI 检索：`task_list` 的 `search` 是 title+body 的大小写不敏感子串匹配）：`exit code 1`（全状态 2 条，均无关）、`unable to open database file`（1 条，见下）、`watcher sync failed`、`sessions-watcher`、`sessions-watcher.service.ts`（todo 0 / ready 0 / needs-human 0）、`ui-last-opened`（todo 0 / ready 0）、`recordOpenedSession`、`session watcher`、`uncaughtException`、`unhandledRejection`、`server crash`、`interrupted turn`、`resident-restore`（ready 0）、`SqliteError`（todo 0 / ready 0）⇒ **无在飞重复**。
- **相关但机制不同（仅溯源，非前置、非依赖）**：`gap-ac175-criterion-ledger-red-is-host-boot-death`（done）遇到的确是同一个 sqlite 文案，但机制是**宿主配额（EDQUOT）在 e2e 判据的 server 启动迁移阶段**把进程打死，交付物是归因判法；本条是**长跑中的服务进程**在 watcher/DB 打开失败后以 exit 1 退出、不留栈，并连带杀死 16 个常驻 scope。两者不重复，本条不以那条任务为任何前提。
- **粒度（merge-candidate）**：`task-granularity-advice.js` 需要 Bash，本 agent 没有，**未能运行脚本（如实登记）**；按 skill 的 fallback 改用 ABI 检索上面这批 Touches 文件名，`todo` / `ready` / `needs-human` 上命中 = **0** ⇒ **no peers found**。保留为本条独立任务：它有一条独立验收面（进程不因单次失败退出 + 退出前栈完整 + 中断可机读），与任何在飞 peers 无文件重叠。

## AC

- [x] AC1 **退出路径被指名，判据能跑**：新增判据 `server/modules/providers/tests/sessions-watcher-failure-guard.test.ts`；`bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sessions-watcher-failure-guard.test.ts` 退出 0 且输出 `fail 0`。完成记录必须写出 exit-1 路径的**具体来源**——具体 handler 名，或库的 `file:line`，或「没有任何 handler，异常帧穿到顶层」这一读数；并逐字贴 `grep -n "process.exit(1)" server/index.ts` 与新增守卫的 `file:line`。⛔「可能是 better-sqlite3 / 可能是 systemd」这类猜测不算读数。
- [x] AC2 **故障注入红→绿双向**：(a) 在**修复前**的树（或把新守卫临时注释掉）上注入「DB 不可打开 / watcher 同步抛 `unable to open database file`」，子进程实测 **exit 1**，把退出码与该进程最后几行输出逐字记下（红态基线）；(b) 修复后**同一条注入**下该子进程不因这次失败退出（父进程断言它仍在服务：例如仍能应答一次请求或仍打印后续活动），退出码读数写进完成记录。两读都必须来自判据本身，⛔ 不得用 transcript 或「看起来对」代替。
- [x] AC3 **退出前完整栈、不截断**：注入路径上进程 stderr/stdout 至少出现 1 行 `    at ` 形式的栈帧，且同时含错误的 `name` 与完整 `message`；判据机械断言「日志末行是完整行」（该行不是被截断的半个 token，例如不是以 `claud` 这类断词结尾）。⛔ 只 `console.error(error.message)`、不含栈 ⇒ 本 AC 红。
- [x] AC4 **中断可机读（重放或显式中断标记）**：崩溃 + 重启后，被打断 turn 的悬挂 `tool_use` 要么被重放，要么在状态面 / API 面带一个可读的中断标记；判据断言该字段名与其值（逐字）。若该标记经 UI 呈现，按 AGENTS.md 的 UI 要求另补 MCP 浏览器实际操作 + `tmp/` 截图，以及 `node scripts/ui-scenario.mjs <scenario.json>` 的 JSON 报告；若重放明确不在范围内，完成记录必须逐字写明「本任务不做重放」并给出用户可见信号的入口。
- [x] AC5 **范围受控**：`git diff --name-only $(git merge-base HEAD develop)` 的每一行都在 `## Touches` 内；本任务新增的每个 server 测试文件都在 Touches 里。
- [x] AC6 **仓库门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0。
- [x] AC7 **新测试文件的既有 pin 同步**：`bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0；本任务新增 server 测试文件后，把该文件里的收集数 `unknown=` pin 按实测上调并逐字贴出改动前后两个数字（该 pin 在本仓确有先例：同批任务记录过 `unknown=486→487`）。若 suite 的时长基线覆盖闸因新文件转红，同一轮按实测值同步并贴读数。

## DoD

真实落地判据（不是「加了个 try/catch」）：

- **真实运行的服务读数**：`systemctl --user show -p NRestarts -p MainPID claudecodeui-server.service` 与 `journalctl --user -u claudecodeui-server.service --since <窗口>` 给出崩溃计数与 `code=exited, status=1/FAILURE` 的读数；若 journal / `server.log` 已轮转，逐字写「已轮转」并给出所跑命令，⛔ 不得编造读数。重启前后的常驻 scope 数用 `pgrep -fc 'claudecodeui-session-'` 与启动日志里的 `[resident-restore]` 行给出（事故当次是 16 个 scope 同秒 Consumed、恢复 16/16）。
- **注入证据**：AC2 的红态退出码 + 绿态读数、AC3 的栈行原文，全部由判据打印后贴进完成记录。
- **中断证据**：AC4 的字段名 + 值；或「不重放」的明示 + 用户可见信号入口。
- **可复现性**：所有命令都能在 Claude 会话里按 `docs/operations/process-isolation-and-memory-caps.md` →「Running tests from a Claude session」跑（单文件直跑，或多文件时 `bash scripts/with-memory-cap.sh … --test --test-concurrency=<N>` 两者齐备）；⛔ 不在会话里跑全量 suite。
- **诚实边界**：若重放确认为范围外，完成记录必须写「本任务只保证显式中断信号，不保证 turn 重放」，⛔ 不得用「重启后 16/16 恢复」冒充「被打断的 turn 被恢复」。

## Evidence

### AC1 — exit-1 路径的具体来源

**读数：没有任何 handler，异常帧穿到顶层。** `server/` 全树没有 `uncaughtException` / `unhandledRejection` / `setUncaughtExceptionCaptureCallback` 安装点（`grep -rn "uncaughtException\|unhandledRejection\|setUncaughtExceptionCaptureCallback" server/ --include=*.ts` 只命中三处测试文件）。服务端唯一的 `process.exit(1)` 是启动失败路径：

```
$ grep -n 'process\.exit(1)' server/index.ts
2853:        process.exit(1);
```

崩溃发生在 boot 之后，走的是另一条路：`server.listen(port, host, async () => { … await initializeSessionsWatcher(); … })`（`server/index.ts`，修复前为 `await initializeSessionsWatcher();`）的 `async` 回调返回值没有 `.catch`；`SessionsWatcher.start()` 的**第一次** `await sessionSynchronizerService.synchronizeSessions()` 当时不在任何 `try` 内。DB 短暂不可打开时该 promise reject，成为无人处理的 rejection，Node 默认 `--unhandled-rejections=throw` 抛出未捕获异常并 `exit(1)`。进程在同一时刻正用异步 stderr 写 `Session watcher sync failed for provider "claud…`，退出截断了这次写 —— 与 `server.log` 里那行断词完全吻合。

新增守卫的 `file:line`：

```
$ grep -n 'export function installProcessCrashGuard\|export function writeCrashReportSync\|export function formatCrashReport' server/shared/process-crash-guard.ts
73:export function formatCrashReport(label: string, error: unknown, disposition: CrashDisposition): string {
87:export function writeCrashReportSync(label: string, error: unknown, disposition: CrashDisposition): void {
108:export function installProcessCrashGuard(options: ProcessCrashGuardOptions = {}): () => void {
```

接线读数：`server/index.ts:2668 installProcessCrashGuard();`；`server/index.ts:2764 await startSessionsWatcherSafely();`；`server/modules/providers/services/sessions-watcher.service.ts:916 export async function startSessionsWatcherSafely(`。

判据运行（单文件直跑）：

```
$ bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json \
    --test server/modules/providers/tests/sessions-watcher-failure-guard.test.ts
✔ AC2(a): the pre-fix wiring exits 1 on a database-open failure (red baseline) (444.8ms)
✔ AC2(b)+AC3: the fixed wiring survives the same failure, still serves, and reports a complete stack (454.2ms)
✔ AC3: the fatal path writes the whole stack synchronously and exits 1 on a complete line (218.2ms)
✔ AC4: a crash-interrupted turn reads back as a machine-readable turnInterrupted marker (317.0ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

### AC2 — 故障注入红→绿（读数来自判据本身）

注入 = 把 `sessionSynchronizerService.synchronizeSessions` 换成抛 `name=SqliteError, message=unable to open database file`。

- **红态（修复前 wiring，`isolateInitialSyncFailure: false`）**：子进程 `exit code = 1`（判据 `assert.equal(run.code, 1, …)` 通过）；`RED_SHOULD_NOT_REACH` 没有打印；stderr 含 `SqliteError`、`unable to open database file` 与 `    at ` 帧（见 AC3 段）。
- **绿态（修复后 wiring）**：同一注入下，子进程 `startSessionsWatcherSafely()` 先吞下 inner sync 失败、再吞下 outer start 失败；父进程真的向子进程监听的 `http://127.0.0.1:<port>/` 发了一次请求，读回 `200 "alive"` —— 判据 `assert.ok(run.served, …)` 通过，证明它仍在服务而不是"看起来没退出"。

### AC3 — 退出前完整栈、不截断

判据打印并断言（原文）：

```
[crash-guard] initial-session-sync-failure name=SqliteError message=unable to open database file
    at sessionSynchronizerService.synchronizeSessions (…)
    …
[crash-guard] initial-session-sync-failure served-through
[crash-guard] watcher-start-failure name=SqliteError message=unable to open database file
    at …
[crash-guard] watcher-start-failure served-through
```

fatal 路径（未捕获异常）末行逐字为 `[crash-guard] uncaughtException exit-code=1`，`assert.equal(lastLine, …)` 通过；退出码 1。守卫用 `writeSync(2, …)` 同步落盘（`server/shared/process-crash-guard.ts:87`），所以末行不可能是半个 token；判据另断言 `!stderr.endsWith('claud')`。

### AC4 — 中断可机读

**本任务不做重放。** 重启只恢复常驻进程（`RESIDENT_RESTORE_STARTUP_DELAY_MS` 段注释逐字写明 bring back, **不重放**），本任务只保证显式中断信号，不保证 turn 重放。

中断信号的**用户可见入口**：`GET /api/providers/sessions/:sessionId/messages` 的响应 `data.turnInterrupted`（由 `sessionsService.fetchHistory` → `ClaudeSessionsProvider.fetchHistory` 产出；字段定义在 `server/shared/types/provider-launch.ts`）。判据逐字断言的字段名与值：

```
history.turnInterrupted === { toolUseId: 'toolu_interrupted_1', reason: 'transcript-ended-mid-tool-call' }
```

读取口径：转录文件的最后一条非 thinking 消息是 `tool_use` 且没有 `toolResult`，并且该 session 当前不在运行（`running === false`；崩溃后进程已无运行态）。判据同时给出负控：同一文件在 `running: true` 下 `turnInterrupted === null`，避免把正在跑的工具误报成中断。诚实边界：本标记是磁盘形态读数，区分不了"崩溃打断"与"进程外被关掉后留下的同一形态"，两者都确实表示"该 turn 已不在运行且工具永不返回"；它不重放、不补 tool_result。

### AC5 — 范围受控

```
$ git diff --name-only $(git merge-base HEAD develop)
server/index.ts
server/modules/database/repositories/sessions/ui-last-opened.db.ts
server/modules/providers/index.ts
server/modules/providers/list/claude/claude-sessions.provider.ts
server/modules/providers/services/sessions-watcher.service.ts
server/modules/providers/tests/sessions-watcher-failure-guard.test.ts
server/shared/process-crash-guard.ts
server/shared/types/provider-launch.ts
```

8 个文件全部在 `## Touches` 内；新增 server 测试文件已登记。`server/shared/process-crash-guard.ts`、`server/shared/types/provider-launch.ts`、`server/modules/providers/list/claude/claude-sessions.provider.ts`、`server/modules/providers/index.ts` 是本轮按「先 task_write 登记再改」补进 Touches 的。

### AC6 — 仓库门

```
$ npm run typecheck   # tsc -p tsconfig.json && tsc -p server/tsconfig.json && tsc -p scripts/tsconfig.json
TYPECHECK_EXIT=0
$ npm run lint        # oxlint src/ server/ scripts/ shared/
LINT_EXIT=0           # 仅既有 warning
```

### AC7 — pin 同步读数

```
$ bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json \
    --test server/shared/tests/quay-test-script.test.ts
ℹ tests 14  ℹ pass 14  ℹ fail 0
✔ AC7: the committed duration baseline is valid data, covers the suite, and documents its source
```

`unknown=` pin 的前后读数：**改动前 `unknown=501`，改动后 `unknown=501`（未变）**。原因如实登记：该 pin（`server/shared/tests/quay-test-script.test.ts:327`）由**合成** manifest 驱动（同文件 288 行 `for (let i = 0; i < 507; i += 1)` 造 507 条 `server/synthetic/…`），不读真实收集；真实收集的两条判据（AC1 的 `rest.length`、AC3 的 `collectedServerFiles()`）都是运行时计算、没有字面量可撞。因此新增一个真实 test 文件既不改 501 的合成 pin，也没有让时长基线覆盖闸转红（AC7 判据同轮 14/14 绿），无需上调。

### DoD — 真实运行读数（2026-11-16 本检出复核）

```
$ systemctl --user show -p NRestarts -p MainPID claudecodeui-server.service
MainPID=984604
NRestarts=3

$ journalctl --user -u claudecodeui-server.service --since "2026-11-16 14:40:00" --until "2026-11-16 14:50:00"
Nov 16 14:43:13 … claudecodeui-server.service: Main process exited, code=exited, status=1/FAILURE
Nov 16 14:43:13 … claudecodeui-server.service: Failed with result 'exit-code'.
Nov 16 14:43:18 … Scheduled restart job, restart counter is at 2.
Nov 16 14:43:18 … Started claudecodeui-server.service - claudecodeui server.
Nov 16 14:46:19 … claudecodeui-server.service: Main process exited, code=exited, status=1/FAILURE
Nov 16 14:46:19 … claudecodeui-server.service: Failed with result 'exit-code'.
Nov 16 14:46:24 … Scheduled restart job, restart counter is at 3.
Nov 16 14:46:24 … Started claudecodeui-server.service - claudecodeui server.

$ pgrep -fc 'claudecodeui-session-'
1
```

journal **未轮转**：上面窗口的两条 `code=exited, status=1/FAILURE` 是事故原文，`NRestarts=3` 与 Proposal 的 restart counter 3 一致。事故当次「16 个 scope 同秒 Consumed、恢复 16/16」来自 Proposal 已记录的 `server.log` 取证；该 415 MB append 日志不在本 worktree，且当前 `pgrep` 只剩 1 个常驻 scope（会话已空闲退出），因此事故时点的 scope 计数**无法在本轮重新复现**，按原文引用而不重造。journalctl 过滤 `resident-restore` 在本 unit 无命中（该日志走 append 文件而非 journal），如实登记。

诚实边界（再次声明）：本任务的绿态读数来自判据的子进程注入（修复后进程不退出且仍应答请求），**不是在部署后的 `claudecodeui-server.service` 上**取得。合并 ≠ 部署；本任务不声称线上服务已完成部署验证，部署后应以 `NRestarts` 不再增长作为线上复核。

### ADR-007 暗轴

该轴仍暗,理由:本任务只改服务端崩溃守卫、数据库指针写与历史读取，不改变模块依赖图的环/扇入扇出，L_D/L_G 无适用读数

## Touches

- server/modules/providers/services/sessions-watcher.service.ts
- server/index.ts
- server/modules/database/repositories/sessions/ui-last-opened.db.ts
- server/shared/process-crash-guard.ts (new)
- server/shared/types/provider-launch.ts
- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/modules/providers/index.ts
- server/modules/providers/tests/sessions-watcher-failure-guard.test.ts (new)
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-server-watcher-db-open-failure-exits-1-kills-resident-turns.md
