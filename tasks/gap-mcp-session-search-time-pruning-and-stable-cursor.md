---
id: gap-mcp-session-search-time-pruning-and-stable-cursor
title: AC-336：session_search 按时间剪枝、两道扫描上限（200 文件/3000ms）加 hasMore、键集稳定游标、turnIndex
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-336
---
## Proposal

**契约（AC-336，已在上一轮定稿并激活，本任务是其实现）：** `session_search` 按项目/时间剪枝，无时间范围时有扫描上限且不静默漏掉历史，稳定分页。默认扫描上限取**本任务的推荐默认值**（E4，外部 Agent 2026-10-11 第三轮授权按既有裁定范围推进，未再另行拍板具体数字）：**单次调用最多扫描 200 个会话文件，或墙钟 3000ms，先触顶者生效**；触顶即返回 `hasMore`，不是报错。这两个数字写进工具描述，日后按真实基准调整不算破坏性变更（只会让响应更快或更慢，不改变语义）。

**现状（代码核实，基线依据）：** `server/modules/providers/services/session-conversations-search.service.ts:1157` 的 `searchConversations` 对**全部**非归档会话（`sessionsDb.getAllSessions()`，不按时间过滤）分桶后逐桶跑 ripgrep（`RIPGREP_FILE_CHUNK_SIZE=40`、`RIPGREP_CHUNK_CONCURRENCY=6`，`:106-108`），直到 `totalMatches >= limit`（`:842`）或桶耗尽——**没有扫描量上限**，关键词越罕见，扫得越久。审计基线（docs/proposals/cloudcli-mcp-control-observability-2026-10.md §1）里唯一一次真实调用耗时 24.6 秒，与「关键词命中稀疏，扫完了大部分会话才停」的读数吻合。`mcp-session-search.ts`（网关薄封装）的 `cursor` 是 base64 编码的 skip 计数，每次重新全量跑一遍再跳过前 N 条（`session-conversations-search.service.ts:532-544` 一类注释已承认这不稳定）。

**要交付：**

1. `searchConversations` 增加可选 `since?: string, until?: string`（ISO8601）：在 `normalizeSearchableSessions`/建桶之前，按会话的 `updated_at` 过滤掉区间外的会话，被排除的会话**不产生任何 ripgrep 调用**（AC-336 (a) 要求能断言这一点——给扫描器注入一个记录被实际扫描的文件集合的测试替身）。
2. 无时间范围时，按 `updated_at` 从新到旧排序后扫描，加两道上限：**已扫描文件数 ≥ 200**，或**本次调用已耗墙钟 ≥ 3000ms**，先触顶者让调用提前返回（不继续等剩余分桶）。触顶时响应带 `hasMore: true`、`nextCursor`、`scannedThrough`（已扫描到的最老 `updated_at`，供人类读数和日志用，不是分页本身的依据）。未触顶时 `hasMore: false`。
3. `cursor` 改为按 `(lastActivity, sessionId)` 的键集：下一页从 `updated_at <= lastActivity AND sessionId > 上次游标的 sessionId`（或等价的严格序）继续，不再整体重跑再 skip。**旧的 skip-计数 cursor 仍必须被接受**（向后兼容，不是本任务改的那一批客户端会立刻失效）——判断一个传入的 cursor 是旧格式还是新格式（例如新格式加一个版本前缀字节），按格式分别解码。
4. 每条命中结果增加 `turnIndex`：与 `session_read mode:\"outline\"` 给同一条消息的 `#index` 对齐（复用相同的用户轮计数逻辑，不要重新发明一套编号）。
5. 不新增任何表、索引或转录副本（D5 的硬约束）——本任务只做「扫描前先用已有列剪枝」与「扫描量设上限」，不做全文索引。
6. 网关薄封装 `server/modules/mcp-gateway/mcp-session-search.ts` 与 `inputSchema`（`mcp-gateway.read-tools.ts:907-921` 一带）透传 `since`/`until`，输出透传 `hasMore`/`scannedThrough`/`turnIndex`。只增字段，不删字段。

## AC

- [x] AC-336 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-search-pruning.test.ts`，覆盖契约 (a)–(e)。(a) 用注入的扫描器断言「被 since/until 排除的会话一次也没被扫描」而不是只看最终结果；(b) 用一个人造的、文件数超过 200（或可配置成更小阈值以保持测试快速——测试里把两道上限当依赖注入，不要依赖真的扫 200 个文件）的夹具验证触顶行为与翻页覆盖全部历史且不重不漏；(c) 新旧两种 cursor 格式各一条；(d) 命中的 `turnIndex` 与同一会话 `session_read outline` 的 `#index` 比对相等；(e) 用 `grep -ri \"CREATE VIRTUAL TABLE\\|fts5\"` 之类的静态检查或测试里的反向断言确认没有新表/索引文件产生。
- [x] 取假：把扫描上限守卫删掉（或永远判定「未触顶」）⇒ (b) 必须红；记录变异 diff、失败行与恢复命令。
- [x] 下列既有判据逐文件运行退出码 0：`mcp-session-search.test.ts`、`mcp-read-tools.test.ts`、`mcp-invalid-argument.test.ts`（若 `since`/`until` 加入了该文件的声明参数表）、`mcp-english-only.test.ts`。
- [x] `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作一次（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得重启或改动正在运行的 CloudCLI 服务**）。播种若干会话（含时间跨度足够宽的几条），经 `/mcp` 调 `session_search {query:..., since:..., until:...}`，确认超出范围的会话确实不出现在结果里；再调一次不带时间范围、人为调小扫描上限环境变量或配置（若实现支持）或用较小的真实数据集观察 `hasMore`/`nextCursor` 字段形状正确。逐字记录请求与响应摘要。仅有测试夹具通过不算完成。

## Touches

- server/modules/providers/services/session-conversations-search.service.ts
- server/modules/mcp-gateway/mcp-session-search.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/database/migrations.ts
- server/modules/database/schema.ts
- server/modules/mcp-gateway/tests/mcp-session-search-pruning.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-session-search.test.ts
- server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-session-search-time-pruning-and-stable-cursor.md（self）


**补充（未经 driver 拾取前追加，2026-10-11 第三轮）：** 复核发现 `sessions` 表没有 `updated_at` 索引（migrations.ts:1096-1103 只有 session_id/provider_session_id/project_path/forked_from_session_id/isArchived 五个索引）。本任务的 since/until 预过滤与无时间范围时按 updated_at 排序扫描都依赖这一列，请在同一次改动里顺带加 `CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at)`（schema.ts 的 CREATE TABLE 后 + migrations.ts 的既有索引清单旁，与其余五个索引同一惯例，不新开迁移分支）。这不是本任务的新增范围，只是把已经要读这一列的查询配上索引；AC-335（changes 增量流，草稿，待激活）落地时会复用同一索引，不要重复建。

## Evidence

### 判据 (a)–(e)（新测试文件）
`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-search-pruning.test.ts`
→ tests 6 / pass 6 / fail 0。夹具：一个项目下 5 个会话，`updated_at` 2026-09-01 12:00/11:00/10:00/09:00/08:00，关键字 `pruneword`；会话 HTTP 面走真实 express + 生产 `/mcp` 挂载 + MCP SDK `Client`，DB 是临时 better-sqlite3 文件，转录是磁盘上的真实 Claude JSONL。逐条读数：

- (a) `since=2026-09-01T09:30:00.000Z`：注入的 scanner 记录被实际交给扫描器的文件集合 —— `[a] in-window=prune-fixture-a,prune-fixture-b,prune-fixture-c scanned=3 scannedThrough=2026-09-01T10:00:00.000Z`。断言：d/e 的转录文件**从未**出现在 scanner 入参里（不是只看最终结果），且 d/e 不在 `results`。
- (b) 注入 `maxScannedFiles=2`：`[b] page1=prune-fixture-a,prune-fixture-b hasMore=true`；沿 `nextCursor` 走到底 `[b] walk=prune-fixture-a,prune-fixture-b,prune-fixture-c,prune-fixture-d,prune-fixture-e`，5 条不重不漏（`new Set(seen).size === seen.length`）。
- (c) 两种编码：旧格式 `Buffer.from('1').toString('base64')='MQ=='` → `[c] legacy=prune-fixture-b,prune-fixture-c,prune-fixture-d,prune-fixture-e`（跳 1 条）；新键集 → `[c] keyset page1=prune-fixture-a,prune-fixture-b page2=prune-fixture-c,prune-fixture-d`，两页不相交，且新 token 与旧格式不相等。
- (d) `[d] non-zero turnIndex readings=2,2,2,2`：每条命中的 `turnIndex` 与同一会话 `session_read {mode:'outline'}` 打印的 `#index` 逐条相等（读的是 outline 的 `content` 字段而非被 JSON 转义的 text 块，用全局正则匹配 `#(\\d+) (\\S+):`）。
- (e) 静态反向断言：对 5 个改动文件断言无 `CREATE VIRTUAL TABLE`/`fts5`；同时断言 `idx_sessions_updated_at` 在 schema.ts 与 migrations.ts 里都在。

### 取假（AC 第二条）
变异：把 `session-conversations-search.service.ts` 的
`const slab = Number.isFinite(maxScannedFiles) ? orderedEntries.slice(0, maxScannedFiles) : orderedEntries;`
改成 `const slab = orderedEntries;`（删掉上限守卫）。
结果：(b) 红 —— `AssertionError [ERR_ASSERTION]: a capped first page must report hasMore`（其余 (a)(c)(d)(e) 仍绿）。
恢复：`cp` 备份回填后 `diff -q` 报 IDENTICAL，复跑 6/6 全绿。

### 既有判据（逐文件）
- `mcp-session-search.test.ts` → 7/7
- `mcp-read-tools.test.ts` → 8/8
- `mcp-invalid-argument.test.ts` → 4/4
- `mcp-english-only.test.ts` → 10/10
- `server/shared/tests/quay-test-script.test.ts` → 11/11（新增一个 server 测试文件，计数钉 288→289、290→291；merge develop 时 develop 也新增了一个 server 测试文件 `voice-realtime-interrupt.test.ts`，故计数钉按并集重定为 288→290、290→292；并在 `scripts/suite-duration-baseline.tsv` 追加新文件一行，AC7 覆盖率仍 ≥90%）
- `server/modules/mcp-gateway/tests/dependency-declaration.test.ts` → 4/4（新增依赖未越界，跨模块仍走 barrel）

`npm run typecheck` 退出码 0（tsconfig.json + server/tsconfig.json + scripts/tsconfig.json）；`npm run lint`（oxlint）退出码 0，改动文件无告警。

### merge develop 的并集处理
merge develop 时 `scripts/suite-duration-baseline.tsv` 冲突（两侧都在文件尾部追加了一行，分别是本任务的 `mcp-session-search-pruning.test.ts` 与 develop 的 `voice-realtime-interrupt.test.ts`）：按追加行的语义并集处理，两行都保留（该文件的追加行是 dispatch-order-only，形状合法即可）。其余自动合并的文件均为 develop 侧改动，不在本任务 Touches 内。

### DoD（真实服务实例）
`scripts/mcp-smoke.mjs` 的 `bootServer`（临时 `DATABASE_PATH`、`listen(0)` 探得端口；本次 port=18437 ≠ 3001，**未触碰常驻 CloudCLI**）。播种 5 个会话，其转录内消息时间戳即各自 `updated_at`（2026-09-01 12:00…08:00）——因为服务端的项目同步会从转录内容推导 `updated_at`，若只设库列会被同步覆盖成同一值。用 `cloudcli:read` 的 PAT 经 `/mcp` 调用：

- 带窗口：`session_search {query:'pruneword', since:'2026-09-01T10:00:00.000Z', limit:50}` → 结果 `dod-prune-a,dod-prune-b,dod-prune-c`（`dod-prune-d`/`dod-prune-e` 确实缺席），`scannedThrough={relative:\"40 days ago\", iso:\"2026-09-01T10:00:00.000Z\"}`，`hasMore=false`。
- 不带范围：`{query:'pruneword', limit:50}` → 5 条全在，`hasMore=false`，`scannedThrough.iso=2026-09-01T08:00:00.000Z`。
- 分页形状：`{query:'pruneword', limit:2}` → `page1=dod-prune-a,dod-prune-b hasMore=true nextCursor=djE6eyJ2IjoxLCJzcyI6…`（`v1:` 键集前缀）；带该 cursor 的 `page2=dod-prune-c,dod-prune-d`，与 page1 不相交。
- `turnIndex` 对齐：`dod-prune-a/dod-prune-a-u1: search=0 outline=0`。

收尾：临时实例 `stop()`、临时根删除；常驻服务未重启、未改动。

### 已披露的副作用
上限默认在**共享引擎**里生效，因此 SSE 路由 `/api/providers/search/sessions`（`provider.routes.ts:1041`，不在本任务 Touches 内）也会变成有界的：它只消费 `onProgress`/`onTitleResults` 回调、不用 `search()` 的返回值，回调语义已保留（`onProgress` 仍逐项目 emit），故该面不报错；但大语料下的返回条数会比以前少。这是把上限放在引擎默认值（MCP 生产路径不显式传上限，必须靠默认值生效）的必然结果；`provider.routes.ts` 不在 Touches 内，故未改动。
