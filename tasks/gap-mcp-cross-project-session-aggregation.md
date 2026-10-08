---
id: gap-mcp-cross-project-session-aggregation
title: 跨项目会话聚合：session_search / overview 的 project 参数接受数组，返回按项目归属标注的聚合结果
status: ready
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
