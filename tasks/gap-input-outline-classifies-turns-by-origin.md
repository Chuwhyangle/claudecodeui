---
id: gap-input-outline-classifies-turns-by-origin
title: '"Your inputs" 大纲按来源（origin）而非传输形态判定用户轮次：`<task-notification>` Monitor
  事件与跨会话 peer 消息不再出现在抽屉与 MCP `session_read mode=outline`'
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象（实测，2026-10-10，CloudCLI v1.39.0 跑在 `127.0.0.1:3001`）。** 会话 `任务看板状态推进`（`/session/80da77c8-9db7-4650-9676-c6f2e566dabb`）右侧 "Your inputs" 抽屉共 15 条，其中 **10 条是 `<task-notification>` Monitor 事件**（preview 形如 `<task-notification> <task-id>biig0cfg1</task-id> <summary>Monitor event: "fan-in`），只有 5 条是人打的字。点进去看到的是 Claude Code 的 Monitor 事件，不是用户输入。

**面比这一个会话大。** 扫最近 100 个 claude 会话的 `GET /api/providers/sessions/:id/outline`：**23 个会话共 123/450 条条目项（27.3%）不是人打的字**，最严重的 `项目新版本发布` 是 35/51（69%）。另有一类同机制泄漏：**18 个会话的 76/76 条跨会话 peer 消息 100% 出现在 outline 里**（peer 消息是别的会话说的话，同样不是"我的输入"）。

**根因：大纲用传输形态定义"用户轮次"。** `server/modules/providers/services/sessions.service.ts` 的 `fetchOutline`（`:852`）判据是 `message.kind !== 'text' || message.role !== 'user'`，**完全不读 `origin`**。而 `server/shared/types.ts:786-795` 已经把 `origin` 的语义写死为「不是人打的那一轮」（`MessageOrigin` 的注释原文："Present only on turns the host layer opened on its own behalf — a background task reporting back, a timer firing, another session writing in"），`MessageOriginTrigger` 里 `'background-task'` 早已存在，divider 文案就是 `📡 Monitor notification · {{time}}`（`src/modules/i18n/locales/en/chat.json:456`）。两条泄漏由此分叉：

- **通知行没有 origin。** `readClaudeRowOrigin`（`claude-sessions.provider.ts:982-993`）只认 `origin.kind === 'peer'`，别的一律返回 null——尽管 transcript 行本身**一等携带** `origin: {kind: 'task-notification'}`。语料校验：全量 `~/.claude/projects` 里 745 行以 `<task-notification>` 开头的 user 行，**100% 都带该字段**（无需内容嗅探）。这些行为什么没被折掉：`collectTaskNotifications`（`:282-319`）只折带 `<tool-use-id>` 的通知（`:302-305` 无 id 就 `continue`），而 Monitor 事件的 XML 没有该标签——168 行如此（其中 159 行 summary 是 `Monitor event:`）。
- **peer 行有 origin，大纲不看它。** 所以 `origin.trigger === 'cross-session'` 的行照漏。

**同一行，两个读面已经互相矛盾。** 聊天视图把 `<task-notification>` 重投影成 `type: 'assistant'` + `isTaskNotification`/`isMonitorEvent`（`src/modules/chat/hooks/useChatMessages.ts:457-481`），`ChatMessagesPane` 的轮次边界也只认 `type === 'user'` 与 `unattended`——**只有大纲还认为它是用户输入**，所以抽屉标题 "Your inputs" 对它是假的。

**要做的事（三处，一个机制）。**

1. **provider 把来源读出来。** `claude-sessions.provider.ts:1295` 那段 user 行分支里，对 `origin.kind === 'task-notification'` 的行写 `origin: { trigger: 'background-task', sender: null }`。⚠️ **不要扩展 `readClaudeRowOrigin`**：它的非 null 返回值在 `:1306` 会把行**路由进 cross-session 分支**（还会 `unwrapCrossSessionMessage`）——这是两个不同的问题，要两个读法。
2. **大纲加一个条件。** `sessions.service.ts:852` 改成 `if (message.kind !== 'text' || message.role !== 'user' || message.origin) return;`。这一行同时修掉通知与 peer 两类泄漏，而且是 provider 无关的；MCP 读工具 `session_read mode=outline`（`mcp-gateway.read-tools.ts:1266`）调同一个 `fetchOutline`，自动跟着修好。
3. **前端保持现有渲染。** 把 `parseTaskNotification` 的分支提到 `msg.origin` 分支之前（`useChatMessages.ts:427`）。这不是可选项：不改的话通知行会掉进 `if (msg.origin)` 的 unattended 分支，而那个分支的 `content` 是**未解析的原始 XML**，会把整块 `<task-notification>…` 当正文画出来。

**刻意不新增 server 测试文件。** `server/shared/tests/quay-test-script.test.ts` 的 AC2/AC3 逐字钉住 `server/**/*.test.ts` 总数（当前 `find server -name '*.test.ts' | wc -l` = 270 = known 3 + unknown 267），AC7 另钉 90% 覆盖率地板（`scripts/suite-duration-baseline.tsv`）。新文件要同时改两处计数并追加 baseline 行，且历史上这类红会被 driver 报成 UNATTRIBUTABLE。复用既有的 `session-turn-outline.test.ts` 与 `src/modules/chat/tests/useChatMessages.test.ts` 完全避开。

**不在本任务内（同机制的另一面，另案）。** 会话搜索（`server/modules/providers/services/session-conversations-search.service.ts`，自己的原始行扫描，`:970`/`:1101` 处按 `role === 'user'` 归类）也把这些行标成 user。它问的是**不同的问题**——peer 消息是另一个会话的真实内容、值得被搜到，Monitor 事件不是——判据不同，故不并入本条。

<!-- dedup-ref --> 机制去重：`tasks/session-turn-outline-endpoint.md`（AC-209，done）建立的是大纲读面本身，其 Proposal 原文就把用户轮次定义成「过滤 `kind === 'text' && role === 'user'`」——那正是本条要修的定义，不是同一机制的重复立案；`tasks/transcript-turn-rail-and-jump.md`（AC-213，done）消费同一个读面，同样是已落地的前序。`task-granularity-advice.js` 对本条 Touches 返回 `peers: []` / `mentions: []`（无合并候选）。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-turn-outline.test.ts` 退出 0；夹具新增的 `<task-notification>` 行（带 `origin: {kind:'task-notification'}`）与一条 peer 行（`origin: {kind:'peer'}`）都不出现在 `turns` 里，而夹具原有的 4 条真实提示一条不少、id/顺序/预览逐字不变。红态基线：先在夹具里加这两行并断言它们不在 `turns`，跑同一命令读红。
- [x] AC2 路由腿（真实 HTTP，AC-209 AC3 的做法）：在 node 内起真实 express、按 `server/index.ts` 同款挂载 `app.use('/api/providers', authenticateToken, providerRoutes)`，带合法 JWT 对同一夹具会话 `GET /sessions/:id/outline` 得 200，`data.turns` 的 id 序列与直调 `fetchOutline` 逐字相等且不含通知/peer 的 anchor id；未带鉴权仍 401。写下两条读数。
- [x] AC3 MCP 读面同步：驱动 `session_read mode=outline`（`mcp-gateway.read-tools.ts`），对同一会话返回的行数与 AC2 的 `turns` 数一致，且没有一行含 `<task-notification>`。写下两边的行数。
- [x] AC4 不回归渲染：`npx vitest run src/modules/chat/tests/useChatMessages.test.ts src/modules/chat/tests/taskNotificationRow.test.tsx src/modules/chat/tests/monitorEventCollapse.test.ts` 退出 0。新增一条投影断言：一条带 `origin: {trigger:'background-task', sender:null}` 的 `<task-notification>` 行仍投影成 `type === 'assistant'` + `isTaskNotification === true`，`content` 是 `<summary>` 的文本而**不是**原始 XML，且**不**产生 `unattended-divider` 行。
- [x] AC5 取假形态必须红（先提交再变异，逐条记录 diff、逐字失败行与恢复命令）：(a) provider 不回填 origin、只加 `|| message.origin` ⇒ AC1/AC2 的 Monitor 断言红（通知行仍在 `turns` 里）；(b) 前端两个分支的顺序不改 ⇒ AC4 新断言红（投影成 unattended 且 content 是原始 XML）。
- [x] AC6 仓库门与反漂移：`npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐；`server/shared/tests/quay-test-script.test.ts` 仍绿（本条不新增 server 测试文件，计数钉子不动）。
- [ ] AC7 交付后在运行中的 CloudCLI（`127.0.0.1:3001`，`任务看板状态推进` 会话）实测抽屉条目从 15 降到 5、无一条 preview 以 `<task-notification>` 开头（待外部）

## DoD

- 大纲与聊天视图对同一行给出**同一个**判断：只有「人打的轮次」出现在 "Your inputs" 与 MCP `session_read mode=outline` 里。落地判据是同一条归一化历史读出两个一致的答案，不是"多加了一个过滤条件"。
- 通知行在 transcript 里的画法**一字不变**：仍是一条紧凑的 `data-task-notification-text` 行，Monitor 事件仍按 `collapseMonitorEventRows` 折叠。
- peer 消息在 transcript 里仍按 cross-session divider + unattended 行渲染（它只是不再冒充"我的输入"）。
- 遵守 `backend-module-standards`（server 侧三处）与 `frontend-module-standards`（`src/modules/chat/hooks/useChatMessages.ts`）。
- 只动 `## Touches` 列出的文件。

## Touches

- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/modules/providers/services/sessions.service.ts
- src/modules/chat/hooks/useChatMessages.ts
- server/modules/providers/tests/session-turn-outline.test.ts
- src/modules/chat/tests/useChatMessages.test.ts
- tasks/gap-input-outline-classifies-turns-by-origin.md

## Notes

**验证记录（2026-10-10，工作树 `gap-input-outline-classifies-turns-by-origin`，实现提交 `87a16a1a`）。**

- AC1：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-turn-outline.test.ts` 退出 0（3 pass）。红态基线（夹具已加两行、provider/service 未修）：`actual: ['u-prompt-1','u-prompt-2','u-monitor-event','u-peer','u-same-ms-a','u-same-ms-b']`，`expected: ['u-prompt-1','u-prompt-2','u-same-ms-a','u-same-ms-b']`，失败行 `session-turn-outline.test.ts:389`。
- AC2（两条读数）：带合法 JWT 的 `GET /api/providers/sessions/<id>/outline` → 200，`data.turns`/`total` 与直调 `sessionsService.fetchOutline` 逐字相等，id 序列 `['u-prompt-1','u-prompt-2','u-same-ms-a','u-same-ms-b']`，不含 `u-monitor-event`/`u-peer`；不带鉴权 → 401（`AUTH_TOKEN_INVALID`，与 messages 路由同一读数）。失败行 `session-turn-outline.test.ts:555`（红态）。
- AC3（两条读数）：同一夹具会话，`fetchOutline.turns.length = 1`（ids `['u-prompt-1']`）；经真实 `registerMcpReadTools` seam 驱动的 `session_read mode=outline` 返回 1 行 `"[2026-09-01T10:00:00.000Z] #0 u-prompt-1: A real question a person typed"`，无一行含 `<task-notification>`，两数相等。
- AC4：`npx vitest run src/modules/chat/tests/useChatMessages.test.ts src/modules/chat/tests/taskNotificationRow.test.tsx src/modules/chat/tests/monitorEventCollapse.test.ts` 退出 0（3 files / 18 tests）。
- AC5(a) 变异：`readClaudeNotificationOrigin` 的回填改为 `return null`（service 的 `|| message.origin` 保留）⇒ AC1 与 AC2 红，`actual` 重现含 `u-monitor-event`，失败行 `:389` 与 `:555`；恢复 `git checkout -- server/modules/providers/list/claude/claude-sessions.provider.ts`。
- AC5(b) 变异：`useChatMessages.ts` 令 origin 先于解析（`msg.origin ? null : parseTaskNotification(content)`）⇒ AC4 新断言红，`2 !== 1`（投影成 `unattended-divider` + `unattended`，content 为原始 XML）；控制用例仍绿；恢复 `git checkout -- src/modules/chat/hooks/useChatMessages.ts`。
- AC6：`npm run typecheck` 退出 0；`npm run lint` 退出 0（仅既有 warning）；`git diff --stat` 只含 Touches 的 5 个代码文件；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0（11 pass），未新增 server 测试文件（`find server -name '*.test.ts' | wc -l` = 269）。


## Needs-Human

**执行 2026-10-10T08:31:12.956Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 1 failing lines and attributed none to a file; pseudo-stage tokens: suite-watchdog); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：959f2709-8282-4619-bcc2-db1927fe0d25
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-input-outline-classifies-turns-by-origin~wk-prod-anchor~1791621014104-b4e082.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-input-outline-classifies-turns-by-origin-wk-prod-anchor.log




**复核与解封（2026-10-10，manager 侧）**

上面的停派理由（「基建/契约疑似，失败无法归因」）现在有了**确切的成因**，且**不是实现缺陷**：

- 两轮 fan-in（08:26、08:30）里 `merge-develop / anti-drift / delta / typecheck / ac-precheck` **全部 ok=True**，只有 `step=suite` 红（`suite red` + `rerun-not-evaluated: failing-lines-unattributable-to-files`）。
- 判词里的 "terminated by an external signal" 其实就是**同一个 cgroup 内的 OOM kill**，逐字对上（本地时间）：`16:27:01 run-u174250.scope: Failed with result 'oom-kill'`、`16:31:11 run-u174523.scope: Failed with result 'oom-kill'` —— 与两次 `suite-end` 的时刻一一吻合。`journalctl -k` / `dmesg` 都干净（cgroup OOM 只记在 unit 自己身上），所以先前按 dmesg 的排查会漏掉它。
- 绑定约束是 suite 自己的 `MemoryMax=16G`（宿主 246G total / 157G available ⇒ **不是**宿主内存），且 `scripts/test.sh:94-97` 已把 `--test-concurrency=128` 夹到 16 ⇒ 是「(16 路, 16G) 这一对在当前负载下装不下」，不是并发放大。正解是本仓已 ready 的三条族任务（并发上限/内存上限按 effective 容量自适应），⛔ 不要在实现里绕。

**AC7 的形态（⛔ 不要当成实现缺口）**：AC7 带「（待外部）」标注——它要求在**运行中**的 CloudCLI（`127.0.0.1:3001`）里实测抽屉条目 15→5、无 `<task-notification>` 开头 preview，这只能在落地之后由外部读一次，所以现在保持未勾是**正确**的；⛔ 不得用本地读数伪造它，也⛔ 不要为了凑勾选改动 AC7 的措辞。除它之外 6 条已勾。

**处置**：`needs-human → todo`，交晋升驱动重升、worker 复核（⛔ 实现已在分支上，不要重做）后重跑机械 fan-in；若 suite 再被同一次 OOM 打断，按同样方式退回重试即可（探测任务已用同法在重试后落地）。
## Needs-Human

**执行 2026-10-10T09:55:40.946Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 1 failing lines and attributed none to a file; pseudo-stage tokens: suite-watchdog); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：cb555032-7606-4d23-83ca-6b4dda046e1c
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-input-outline-classifies-turns-by-origin~wk-prod-anchor~1791625488993-858f8b.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-input-outline-classifies-turns-by-origin-wk-prod-anchor.log




**第三次复核（2026-10-11，manager 侧）：两次 park 都是修复前的陈旧停派**

- 两条 Needs-Human 记录的执行时刻是 `2026-10-10T08:31:12Z` 与 `09:55:40Z`，**都早于 10:47:10Z** —— 本工作区的 anchor 在那个时刻被重启，且 `/proc/<pid>/environ` 实测已带 `QUAY_TEST_SYSTEMD_RUN_LIMITS=MemoryMax=24G` 与 `QUAY_MEMORY_SLICE=quay-fleet.slice`（本仓 `scripts/start-drivers-scoped.sh` 就是这套；此前那个 anchor 没走它启动，suite scope 落回插件默认的 16G）。⇒ 判词里的 "external signal" 是 suite scope 内任一进程被 OOM 后 systemd 按默认 `stop` 把**整 scope** TERM 的产物（同族取证见 `gap-effective-capacity-probe-cgroup-cpu-mem-quota` 的「复核与解封」段）。
- **修复后的实测**：10:47Z 之后被 OOM 杀掉的 scope 里**真 suite 数为 0**（全是探针）；同窗口多条任务的 suite 都是 exit 0 并成功落地。⇒ 这两次 park 属于"墙拆了没人通知它"。
- **现状核实**：`grep -n "readClaudeRowOrigin" server/modules/providers/list/claude/claude-sessions.provider.ts` 的现体**仍是只认 `origin.kind === 'peer'`**（其余返回 null）⇒ 本任务的修复**尚未进 develop**，所以 AC7 现在确实读不到（这是正确形态，不是缺口）。
- **处置**：`needs-human → todo`，交晋升驱动重升、worker 复核（⛔ 实现已在分支上，不要重做）后重跑机械 fan-in；落地后 AC7 才由外部读一次（:3001 的抽屉 15→5）。