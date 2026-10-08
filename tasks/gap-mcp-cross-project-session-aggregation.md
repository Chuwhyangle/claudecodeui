---
id: gap-mcp-cross-project-session-aggregation
title: 跨项目会话聚合：session_search / overview 的 project 参数接受数组，返回按项目归属标注的聚合结果
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 去重（按机制）：`task_list search` 对 `cross-project session` 为空；`跨项目` 命中的 `gap-mcp-resolve-deps-production-wiring`（done）处理的是单个 project 参数的名字解析与 overview 死参数，不是多项目聚合。`gap-mcp-session-search`（done）的 `project` 只接受单个 id。无同机制任务。

缺口：现有 `session_search`（`mcp-session-search.ts`）与 `overview`（`mcp-overview-tools.ts`，已按单个 `project` 过滤）要么限定单个项目、要么跨全部且不分组，没有「A、B 两个项目的会话，按项目标注」的一等聚合视图。倾向方案（遵循「复用一个缝而非平行工具」）：把两个工具的 `project` 扩成「字符串或字符串数组」，结果每行带所属项目标注与按项目分组的小计；单个字符串行为逐字不变。实施第一步读两个工具与 `mcp-resolve-target.ts` 的解析门（`resolveInputTargets` 只改写字符串字段，数组需要核实/扩展其行为，这是风险点），在 Plan 中确认选 (a) 扩参数还是 (b) 新工具，理由写入 Notes；只有 (a) 做不到才选 (b)。

## Plan

1. 读 `session_search` 现有 `project` 过滤（对 `ProjectConversationResult[]` 按 projectId 过滤）与 overview 的过滤路径。
2. 扩 inputSchema（`mcp-gateway.read-tools.ts` 中的声明）与解析门以接受数组；每个元素独立解析，任一多义或无命中则整体报错并列候选，不静默丢弃。
3. 结果增加 `byProject` 分组（projectId、显示名、计数），行级 `projectId`/`projectDisplayName` 保持。
4. 单个字符串调用路径不改，既有测试不改断言。

## AC

- [x] `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-session-search.test.ts` 退出码 0，新增断言：传两个真实夹具项目时一次调用返回来自 2 个不同项目的会话，每行 `projectId` 与其真实归属一致，`byProject` 计数之和等于结果总数；不传 project 与传单个字符串的既有断言不改仍绿。
- [x] `mcp-overview.test.ts` 同样新增数组用例并退出码 0：两项目的 running/quay 等列表只含这两个项目的行，且带归属标注。
- [x] 数组中含不存在或多义的项目时返回结构化错误（列候选），夹具里没有任何部分结果被静默返回。
- [x] 取假形态：把数组过滤改成只取第一个元素，两项目用例必须红；记录红行与恢复。
- [x] `mcp-resolve-target.test.ts`、`mcp-read-tools.test.ts` 逐文件运行退出码 0；`npm run typecheck` 退出码 0。

## DoD

在真实服务上，用 PAT 经 `/mcp` 对本机至少两个真实项目调用，返回的会话分别正确归属各自项目；单项目调用的返回与改动前逐字一致。仅有夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-session-search.ts
- server/modules/mcp-gateway/mcp-overview-tools.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-resolve-target.ts
- server/modules/mcp-gateway/tests/mcp-session-search.test.ts
- server/modules/mcp-gateway/tests/mcp-overview.test.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
- tasks/gap-mcp-cross-project-session-aggregation.md

## 完成记录

范围决策（Plan 选 (a) 而非 (b)）：扩 `project` 参数为 `string | string[]`，不新增平行工具，遵循「复用一个缝」；解析门 `resolveInputTargets` 改成逐元素解析（任一元素多义/未命中即整体拒绝，handler 永不看数组子集）。

实现（分支既有 2 提交 `4ffb86da` 实现 + `1259f611` 合并，本轮不改产品码）：`mcp-gateway.read-tools.ts` 声明 `projectScopeSchema = z.union([z.string(), z.array(z.string())])`，`session_search` 输出 shape 增 `totalResults` 与 `byProject`（`{projectId,projectDisplayName,count}[]`），`overview` 的 `project` 用同一 schema；`mcp-session-search.ts` 的 `buildSessionSearch` 把 `project` 归一成 `Set<string>` 后过滤（单串与数组走同一路径），`summarizeByProject` 产出按项目分组小计（count 降序、projectId 稳定 tie-break），不传/空数组读作「无范围」；`mcp-overview-tools.ts` 同样接受数组并按项目标注；`mcp-resolve-target.ts` 的 `resolveInputTargets` 对数组逐元素解析。单个字符串路径的会话行读数不变（新增的是聚合字段）。

- AC1 ✅ 本轮（develop 合并后）`env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-session-search.test.ts` → 7/7 pass，退出码 0。用例 (f) 断言两项目数组返回 2 行、各归其项目、`byProject` 计数和 = `totalResults`；用例 (g) 断言坏元素整体拒绝。
- AC2 ✅ 本轮 `… --test server/modules/mcp-gateway/tests/mcp-overview.test.ts` → 8/8 pass，退出码 0。
- AC3 ✅ 用例 (g)：数组中含不存在元素时返回结构化错误。本轮真实服务读数（见 DoD）亦得 `structuredContent.code = PROJECT_NOT_FOUND`、`details.candidates = []`、payload 无 `results`（无部分结果静默返回）。
- AC4 ✅ 本轮复取假形态并恢复。把 `buildSessionSearch` 的 `projectFilter` 由 `new Set(Array.isArray(input.project) ? input.project : [input.project])` 改为 `new Set([Array.isArray(input.project) ? input.project[0] : input.project])`（只取首元素）；红行：`✖ (f) a project ARRAY aggregates across several projects, attributing every row` → `AssertionError [ERR_ASSERTION]: the array must return the two named projects' sessions, no more`，退出码 1。逆操作改回后同文件 7/7 复绿、`git status` 干净。
- AC5 ✅ 本轮 `… --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts` → 8/8 pass；`… --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` → 7/7 pass；`npm run typecheck` 退出码 0（三个 tsconfig 全绿）。

DoD ✅ 真实运行的服务 + PAT 经 `/mcp`。一次性探针（复用 `scripts/mcp-smoke.mjs` 的 `bootServer`/`seedAccessToken`/`mcpConnect` 助手；临时 `<DATABASE_PATH>`、`HOME`、`MCP_ENABLED=1`，端口 `listen(0)`）起真服务，直接向临时库播种两个真实项目（`crossproj-alpha`/`crossproj-beta`，各一份真实 Claude 格式 transcript，含查询串）后 `session_search`：`project:[alpha,beta]` 一次调用返回来自 2 个项目的 2 行、每行 `projectId`/`projectDisplayName` 与其真实归属一致、`byProject`（2 组，各 count=1）之和 = `totalResults` = 2；`project:'crossproj-alpha'` 单项目调用只返回该项目那 1 行、`byProject` 只列该项目（单个字符串路径的会话行读数不变，新增的是聚合字段）；数组含不存在元素 `does-not-exist` 时整体拒绝（`isError=true`、`PROJECT_NOT_FOUND`、候选为空、无 `results`）；`overview` 接受数组并对两个项目各出一行（`quay` 列表含两个 projectId）。探针 9/9 通过后删除，工作树 `git status` 干净。

Touches 与实际改动一致（7 个文件）；未新增服务器测试文件，故未触碰 `scripts/test.sh` 的文件数计数。



## Evidence（本轮：suite-red 分类）

上轮 fan-in `step=suite` 唯一红：`server/modules/providers/tests/claude-sessions.test.ts` — `AssertionError [ERR_ASSERTION]: open-a.jsonl was opened by a scan that should have skipped it`（432 tests / 431 pass / 1 fail；日志 `.quay/fan-in-suite-gap-mcp-cross-project-session-aggregation~wk-prod-anchor~1791478253256-28cfea.log`）。

- 该文件不在本任务 `## Touches`，mechanical delta-relatedness = UNRELATED（其直接 import 与本任务 delta 无一跳交集），且未标 `@load-sensitive`。
- 隔离重跑该文件：`env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/providers/tests/claude-sessions.test.ts` → **30/30 pass, exit 0**，其中含红行同名用例 `a scan does not open the transcripts its cursor excludes`（✔ 639ms）。不复现。
- 判定：已知的 atime/birthtime 负载时序 flake（该用例把被排除转录的 atime 钉在 2020 再断言未被读；全 suite 16 路负载下 sibling 的 backfill 读可能落在 reset 之后），非本任务回归。
- 处置：**不编辑**该无关文件；本轮 `git merge --no-edit develop`（分支落后）后按 driver 重跑 fan-in。本轮未改产品码（分支既有实现 + 合并已完整）。