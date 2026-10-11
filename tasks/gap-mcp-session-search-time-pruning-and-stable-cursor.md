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
4. 每条命中结果增加 `turnIndex`：与 `session_read mode:"outline"` 给同一条消息的 `#index` 对齐（复用相同的用户轮计数逻辑，不要重新发明一套编号）。
5. 不新增任何表、索引或转录副本（D5 的硬约束）——本任务只做「扫描前先用已有列剪枝」与「扫描量设上限」，不做全文索引。
6. 网关薄封装 `server/modules/mcp-gateway/mcp-session-search.ts` 与 `inputSchema`（`mcp-gateway.read-tools.ts:907-921` 一带）透传 `since`/`until`，输出透传 `hasMore`/`scannedThrough`/`turnIndex`。只增字段，不删字段。

## AC

- [ ] AC-336 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-search-pruning.test.ts`，覆盖契约 (a)–(e)。(a) 用注入的扫描器断言「被 since/until 排除的会话一次也没被扫描」而不是只看最终结果；(b) 用一个人造的、文件数超过 200（或可配置成更小阈值以保持测试快速——测试里把两道上限当依赖注入，不要依赖真的扫 200 个文件）的夹具验证触顶行为与翻页覆盖全部历史且不重不漏；(c) 新旧两种 cursor 格式各一条；(d) 命中的 `turnIndex` 与同一会话 `session_read outline` 的 `#index` 比对相等；(e) 用 `grep -ri "CREATE VIRTUAL TABLE\|fts5"` 之类的静态检查或测试里的反向断言确认没有新表/索引文件产生。
- [ ] 取假：把扫描上限守卫删掉（或永远判定「未触顶」）⇒ (b) 必须红；记录变异 diff、失败行与恢复命令。
- [ ] 下列既有判据逐文件运行退出码 0：`mcp-session-search.test.ts`、`mcp-read-tools.test.ts`、`mcp-invalid-argument.test.ts`（若 `since`/`until` 加入了该文件的声明参数表）、`mcp-english-only.test.ts`。
- [ ] `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作一次（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得重启或改动正在运行的 CloudCLI 服务**）。播种若干会话（含时间跨度足够宽的几条），经 `/mcp` 调 `session_search {query:..., since:..., until:...}`，确认超出范围的会话确实不出现在结果里；再调一次不带时间范围、人为调小扫描上限环境变量或配置（若实现支持）或用较小的真实数据集观察 `hasMore`/`nextCursor` 字段形状正确。逐字记录请求与响应摘要。仅有测试夹具通过不算完成。

## Touches

- server/modules/providers/services/session-conversations-search.service.ts
- server/modules/mcp-gateway/mcp-session-search.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/tests/mcp-session-search-pruning.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-session-search.test.ts
- server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-session-search-time-pruning-and-stable-cursor.md（self）
