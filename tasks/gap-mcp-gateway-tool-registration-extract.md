---
id: gap-mcp-gateway-tool-registration-extract
title: Extract mcp-gateway tool registration into bounded sub-packages
status: todo
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

- [x] 包体上限：`for d in server/modules/mcp-gateway server/modules/mcp-tools-read server/modules/mcp-tools-write; do test "$(find "$d" -name '*.ts' -not -path '*/tests/*' | wc -l)" -le 20 || exit 1; test "$(cat $(find "$d" -name '*.ts' -not -path '*/tests/*') | wc -l)" -le 8000 || exit 1; done` 退出 0；逐包贴出文件数与 LOC（基线 `mcp-gateway` 41 文件 / 17,308 LOC）。— 实测 exit 0：mcp-gateway 20 / 6,966；mcp-tools-read 11 / 6,981；mcp-tools-write 12 / 3,845。
- [ ] 结构读数（外部工具）：新鲜 `archguard_get_package_metrics` 报告 `mcp-gateway*` 的 fanOut 低于 200（基线 332），且 F3 的 server SCC 规模不大于改动前。贴出前后数值。该读数为 ArchGuard MCP 查询（待外部）。— fanOut 部分达标：mcp-gateway 332 → 158，mcp-tools-read 173，mcp-tools-write 121（server scope，均 < 200；该读数为上一轮 ArchGuard 查询结果；本轮 ArchGuard 对 worktree 无新鲜索引，`archguard_get_package_metrics` 返回 `packages: []`）。SCC 部分未达标：AC-394 目录棘轮在合入 develop 后的 worktree 上实测 `sccs=[13,2,2]`（静态读 `[11,2,2]`，动态读 `[13,2,2]`；基线 pin 为 `[11,2,2]` 且成员集不含两个新包），两个新包进入 11 成员环 → 13 成员；同一判据的叶子规则也红。见 ## Blocker：本条 AC 与 AC-394 棘轮定义上冲突，需人工裁决。
- [x] 既有 MCP 工具契约判据不改一字仍绿：`for f in server/modules/mcp-gateway/tests/*.test.ts; do npx tsx --tsconfig server/tsconfig.json --test "$f" || exit 1; done` 退出 0；贴出文件数与每个文件 pass 数（至少含 `mcp-read-tools.test.ts` 与 `mcp-session-send.test.ts`）。— 52 个文件、319 个 pass、0 fail；`mcp-read-tools.test.ts` 8 pass、`mcp-session-send.test.ts` 8 pass。注：17 个判据文件仅改了 import 路径/扫描目录集合（断言文本未动），严格读「不改一字」不成立。
- [x] 公开签名不变：`test "$(grep -rn 'export function registerMcpReadTools' server --include='*.ts' | wc -l)" -eq 1` 且 `test "$(grep -rn 'export function registerMcpWriteTools' server --include='*.ts' | wc -l)" -eq 1`；两处声明所在地分别是两个新子包，参数类型名（`McpReadToolDeps` / `McpWriteToolDeps`）与 `MCP_STAGE3_READ_TOOLS` / `MCP_STAGE4_WRITE_TOOLS` 常量名逐字保留，贴出声明原文。— `register-read-tools.ts:1632 export function registerMcpReadTools(seam: McpReadToolSeam, deps: McpReadToolDeps): void {`；`register-write-tools.ts:370 export function registerMcpWriteTools(seam: McpWriteToolSeam, deps: McpWriteToolDeps): void {`；两个常量名逐字保留。
- [x] `mcp-gateway` 不再直接持有工具实现：`grep -rln 'registerMcpReadTools\|registerMcpWriteTools' server/modules/mcp-gateway --include='*.ts'` 的命中只允许出现在 `mcp-gateway.transport.ts` 的装配调用与 `index.ts` 的转出口，不允许出现工具定义本体；贴出命中文件清单与判定。— 命中文件仅 `mcp-gateway.transport.ts` 与 `index.ts`；无工具定义本体。
- [x] `npm run typecheck` 退出 0，`npm run lint` 退出 0。— 两者实测 exit 0。
- [x] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。— 合入 develop 后实测：47 个文件；`anti-drift-touches-check.js --task gap-mcp-gateway-tool-registration-extract --worktree <wt> --merge-target develop` 输出 `ANTI-DRIFT OK: ... 47 actual file(s), all within declared Touches (52 glob(s))`，exit 0。

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
- server/modules/mcp-tools-read/mcp-changes.ts (new)（读工具实现迁入）
- server/modules/mcp-tools-read/mcp-session-search.ts (new)
- server/modules/mcp-tools-read/mcp-run-get.ts (new)
- server/modules/mcp-tools-read/mcp-overview-tools.ts (new)
- server/modules/mcp-tools-read/mcp-ui-visible-context.ts (new)
- server/modules/mcp-tools-read/mcp-session-background.ts (new)
- server/modules/mcp-tools-read/mcp-ui-clients-list.ts (new)
- server/modules/mcp-tools-read/mcp-gateway.resident-tools.ts (new)
- server/modules/mcp-tools-read/mcp-ui-tools.ts (new)
- server/modules/mcp-tools-write/mcp-session-send.ts (new)（写工具实现迁入）
- server/modules/mcp-tools-write/mcp-session-lifecycle.ts (new)
- server/modules/mcp-tools-write/mcp-ui-navigation.ts (new)
- server/modules/mcp-tools-write/mcp-session-reconfigure.ts (new)
- server/modules/mcp-tools-write/mcp-session-cancel-queued.ts (new)
- server/modules/mcp-tools-write/mcp-ui-open-session.ts (new)
- server/modules/mcp-tools-write/mcp-ui-focus-turn.ts (new)
- server/modules/mcp-tools-write/mcp-ui-open-task.ts (new)
- server/modules/mcp-tools-write/mcp-session-write-deps.ts (new)
- server/modules/mcp-tools-write/mcp-ui-show-diff.ts (new)
- server/modules/mcp-gateway/mcp-approvals.ts（export 面补齐：toPendingInteraction / McpPendingInteraction）
- server/modules/mcp-gateway/mcp-draft.ts（import 路径与消费方注释随迁）
- server/modules/mcp-gateway/mcp-self-target.ts（import 路径与消费方注释随迁）
- server/modules/mcp-gateway/mcp-session-host-control.ts（import 路径与消费方注释随迁）
- server/modules/mcp-gateway/mcp-tool-annotations.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts（既有契约判据，不改一字，作覆盖）
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts（既有契约判据，不改一字，作覆盖）
- server/modules/mcp-gateway/tests/mcp-changes.test.ts（import 路径/别名随迁，断言未动）
- server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts（扫描目录集合随迁，断言未动）
- server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-session-search-pruning.test.ts（硬编码文件路径随迁，断言未动）
- server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-tool-annotations.test.ts（注释措辞随迁）
- server/modules/mcp-gateway/tests/mcp-ui-clients-list.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-ui-focus-turn.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-ui-navigation-harness.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-ui-open-session.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-ui-open-task.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-ui-show-diff.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-ui-visible-context.test.ts（import 路径随迁）
- server/modules/mcp-gateway/tests/mcp-usage-stats.test.ts（注释措辞随迁）
- tasks/gap-mcp-gateway-tool-registration-extract.md (self)

## Evidence

2026-10-20 本轮（续做，worktree 已在 `task/gap-mcp-gateway-tool-registration-extract`，HEAD = `7cc37bde7` + 合入 develop 的 merge commit；本轮未改任何代码，只做逐条复验）：

| AC | 读数 | 判定 |
|---|---|---|
| AC1 | 包体命令 exit 0；mcp-gateway 20 / 6,966，mcp-tools-read 11 / 6,981，mcp-tools-write 12 / 3,845 | 绿 |
| AC2 fanOut | 上轮 ArchGuard：mcp-gateway 332 → 158，read 173，write 121（< 200） | 达标（读数待外部新鲜索引） |
| AC2 SCC | AC-394 棘轮 `sccs=[13,2,2]`（基线 pin `[11,2,2]`）；两个新包进入 11 成员环 | 红 |
| AC3 | 上轮 52 文件 / 319 pass；本轮复验 `mcp-read-tools.test.ts` 8/8、`mcp-session-send.test.ts` 8/8 | 绿 |
| AC4 | `export function registerMcpReadTools` = 1 处（`server/modules/mcp-tools-read/register-read-tools.ts:1632`）；`export function registerMcpWriteTools` = 1 处（`server/modules/mcp-tools-write/register-write-tools.ts:370`）；`MCP_STAGE3_READ_TOOLS` / `MCP_STAGE4_WRITE_TOOLS` 逐字保留 | 绿 |
| AC5 | `grep -rln` 命中仅 `mcp-gateway.transport.ts` 与 `index.ts`，无工具定义本体 | 绿 |
| AC6 | `npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning） | 绿 |
| AC7 | 合入 develop 后 anti-drift：`47 actual file(s), all within declared Touches (52 glob(s))`，exit 0 | 绿 |

AC-394 棘轮红的三条判据（`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts`，merged tree）：`(b)` SCC 包含性、`(c)` 目录 manifest / 新目录叶子规则、`(g)` 真实树注入臂；`tests 11 / pass 8 / fail 3`，`files=327 staticEdges=1325 dynamicEdges=6 sccs=[13,2,2]`。

结构上不可同时满足的理由：AC5/DoD ② 要求 `mcp-gateway.transport.ts` 装配调用两个注册函数，等价于必须有 `server/modules/mcp-gateway → server/modules/mcp-tools-read|write` 的入边；AC5 又允许 `index.ts` 转出口，同向入边。AC-394 的叶子规则要求新目录「零入边（来自其它 `server/modules/**` 目录）」且出边只允许 `server/shared/**` 与自己，并明确基线 JSON / `MANIFEST_PIN` 不得为容纳红而改。故本条的拆分形状与 AC-394 棘轮定义上冲突；该冲突不是实现瑕疵，无法在 Touches 内（且不修改棘轮）消解。

## Blocker

**2026-10-20T06:54:08.165Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 6/7，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：4b17b119-f6cd-46da-8f54-52d6e70f4951
