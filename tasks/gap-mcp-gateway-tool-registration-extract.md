---
id: gap-mcp-gateway-tool-registration-extract
title: Extract mcp-gateway tool registration into bounded sub-packages
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F6（架构校准报告 2026-10-20，ArchGuard 0.1.40；`archguard_detect_god_packages` 对 TypeScript 不适用，故用 `get_package_metrics` + 文件系统体积 + `summary` 推导）：`server/modules/mcp-gateway` 是 god package，工具注册把它撑得过大。

度量（生产文件，排除测试）：

| 包 | 文件 | LOC | entities | fanIn | fanOut | 方法 |
|---|---|---|---|---|---|---|
| `server/modules/mcp-gateway` | 41 | 17,308 | 137 | 27 | 332 | 2 classes / 135 functions |
| `server/modules/voice-realtime` | 30 | 21,195 | 122 | 69 | 232 | 10 classes / 112 functions |
| `server/modules/providers/list/claude` | 12 | 13,229 | 59 | 1 | 271 | 139 |
| `server/modules/providers/services` | 21 | 10,245 | 44 | 18 | 179 | 0 |
| `server/modules/websocket/services` | 18 | 7,415 | 29 | 0 | 177 | 13 |

另有单文件级 god：`server/modules/providers/list/claude/claude-host-driver.provider.ts` 6,650 LOC，`ClaudeResidentHostDriver` 有 87 个方法；180 天窗口内 ownership `primaryOwnerShare 0.81`、`busFactor 1`。

为什么重要：`mcp-gateway` 的 fanOut 332 与 `voice-realtime` 的 232 使它们依赖几乎所有模块，是 F3 那条 11 包初始化环与变更风险的主要来源；工具注册集中在同一个包内，任何工具改动都要碰这个巨包。

改法（报告给出的增量 remediation，本条只取第一项）：把 `mcp-gateway` 的读/写工具注册拆进 `mcp-tools-read/` 与 `mcp-tools-write/` 两个子包，用显式的 dependency-bag 接口连接；`mcp-gateway` 只保留传输、审计与装配。`voice-realtime` 的四分与 `claude-host-driver.provider.ts` 的按关注点拆分是报告同段里的另外两项，属于独立交付，不在本条。

<!-- dedup-ref --> 相关但不同机制：`gap-ac394-server-import-cycle-budget`（done）是目录图棘轮，只数 SCC 与基线，不做包拆分；`gap-ac245-mcp-read-tools-fixture-readings` 与 `gap-ac249-session-send-immediate-runid`（均 done）交付的是只读/写工具的行为与注册集合，不是把注册代码迁到有界子包。去重检索实测：`god package` → 0，`mcp-tools-write` → 0，`registerMcpReadTools` 的命中是 AC-245 的工具实现任务（done，机制不同），`registerMcpWriteTools` 的命中是 AC-249（done，机制不同）。

## AC

- [ ] 包体上限：`for d in server/modules/mcp-gateway server/modules/mcp-tools-read server/modules/mcp-tools-write; do test "$(find "$d" -name '*.ts' -not -path '*/tests/*' | wc -l)" -le 20 || exit 1; test "$(cat $(find "$d" -name '*.ts' -not -path '*/tests/*') | wc -l)" -le 8000 || exit 1; done` 退出 0；逐包贴出文件数与 LOC（基线 `mcp-gateway` 41 文件 / 17,308 LOC）。
- [ ] 结构读数（外部工具）：新鲜 `archguard_get_package_metrics` 报告 `mcp-gateway*` 的 fanOut 低于 200（基线 332），且 F3 的 server SCC 规模不大于改动前。贴出前后数值。该读数为 ArchGuard MCP 查询（待外部）。
- [ ] 既有 MCP 工具契约判据不改一字仍绿：`for f in server/modules/mcp-gateway/tests/*.test.ts; do npx tsx --tsconfig server/tsconfig.json --test "$f" || exit 1; done` 退出 0；贴出文件数与每个文件 pass 数（至少含 `mcp-read-tools.test.ts` 与 `mcp-session-send.test.ts`）。
- [ ] 公开签名不变：`test "$(grep -rn 'export function registerMcpReadTools' server --include='*.ts' | wc -l)" -eq 1` 且 `test "$(grep -rn 'export function registerMcpWriteTools' server --include='*.ts' | wc -l)" -eq 1`；两处声明所在地分别是两个新子包，参数类型名（`McpReadToolDeps` / `McpWriteToolDeps`）与 `MCP_STAGE3_READ_TOOLS` / `MCP_STAGE4_WRITE_TOOLS` 常量名逐字保留，贴出声明原文。
- [ ] `mcp-gateway` 不再直接持有工具实现：`grep -rln 'registerMcpReadTools\|registerMcpWriteTools' server/modules/mcp-gateway --include='*.ts'` 的命中只允许出现在 `mcp-gateway.transport.ts` 的装配调用与 `index.ts` 的转出口，不允许出现工具定义本体；贴出命中文件清单与判定。
- [ ] `npm run typecheck` 退出 0，`npm run lint` 退出 0。
- [ ] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「注册代码真的搬进了有界子包且网关经 dependency bag 调用」，不是「新增了两个目录」。必须贴出：①三个包各自的生产文件数与 LOC（`mcp-gateway` 从 41 / 17,308 降到上限内）；②`registerMcpReadTools` / `registerMcpWriteTools` 的新声明原文与 `mcp-gateway.transport.ts` 的调用行原文，证明工具注册经依赖包注入而不是网关内直接定义；③ArchGuard 的 fanOut 前后读数（332 → 实际值）与 server SCC 前后规模；④既有 MCP 工具契约判据逐个文件的 pass 读数（未改判据文本）；⑤typecheck / lint 退出码；⑥取假形态：把任一工具注册实现临时搬回 `server/modules/mcp-gateway/` ⇒ 包体上限 AC 红或结构读数变差，还原后复绿，附两次读数。本条不包含 `voice-realtime` 拆分与 host driver 拆分，二者不得因本条被改动。

## Touches

- server/modules/mcp-gateway/mcp-gateway.read-tools.ts（实现迁出，保留薄装配或删除）
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts（实现迁出，保留薄装配或删除）
- server/modules/mcp-gateway/mcp-gateway.transport.ts（经 dependency bag 调用两个注册函数）
- server/modules/mcp-gateway/index.ts（转出口指向新子包）
- server/modules/mcp-tools-read/index.ts (new)（barrel 与消费方注释）
- server/modules/mcp-tools-read/register-read-tools.ts (new)（`registerMcpReadTools` 与 `MCP_STAGE3_READ_TOOLS` 的新家）
- server/modules/mcp-tools-write/index.ts (new)（barrel 与消费方注释）
- server/modules/mcp-tools-write/register-write-tools.ts (new)（`registerMcpWriteTools` 与 `MCP_STAGE4_WRITE_TOOLS` 的新家）
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts（既有契约判据，不改一字，作覆盖）
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts（既有契约判据，不改一字，作覆盖）
- tasks/gap-mcp-gateway-tool-registration-extract.md (self)
