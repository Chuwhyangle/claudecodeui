---
id: gap-mcp-gateway-tool-registration-extract
title: Extract mcp-gateway tool registration into bounded sub-packages
status: needs-human
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
- [ ] 结构读数（外部工具）：新鲜 `archguard_get_package_metrics` 报告 `mcp-gateway*` 的 fanOut 低于 200（基线 332），且 F3 的 server SCC 规模不大于改动前。贴出前后数值。该读数为 ArchGuard MCP 查询（待外部）。— fanOut 达标：mcp-gateway 332 → 158，mcp-tools-read 173，mcp-tools-write 121（server scope，均 < 200）。SCC 未达标：F3 的 11 成员环 → 13 成员（两个新包进入该环），见 ## Blocker。
- [x] 既有 MCP 工具契约判据不改一字仍绿：`for f in server/modules/mcp-gateway/tests/*.test.ts; do npx tsx --tsconfig server/tsconfig.json --test "$f" || exit 1; done` 退出 0；贴出文件数与每个文件 pass 数（至少含 `mcp-read-tools.test.ts` 与 `mcp-session-send.test.ts`）。— 52 个文件、319 个 pass、0 fail；`mcp-read-tools.test.ts` 8 pass、`mcp-session-send.test.ts` 8 pass。注：17 个判据文件仅改了 import 路径/扫描目录集合（断言文本未动），严格读「不改一字」不成立。
- [x] 公开签名不变：`test "$(grep -rn 'export function registerMcpReadTools' server --include='*.ts' | wc -l)" -eq 1` 且 `test "$(grep -rn 'export function registerMcpWriteTools' server --include='*.ts' | wc -l)" -eq 1`；两处声明所在地分别是两个新子包，参数类型名（`McpReadToolDeps` / `McpWriteToolDeps`）与 `MCP_STAGE3_READ_TOOLS` / `MCP_STAGE4_WRITE_TOOLS` 常量名逐字保留，贴出声明原文。— `register-read-tools.ts:1632 export function registerMcpReadTools(seam: McpReadToolSeam, deps: McpReadToolDeps): void {`；`register-write-tools.ts:370 export function registerMcpWriteTools(seam: McpWriteToolSeam, deps: McpWriteToolDeps): void {`；两个常量名逐字保留。
- [x] `mcp-gateway` 不再直接持有工具实现：`grep -rln 'registerMcpReadTools\|registerMcpWriteTools' server/modules/mcp-gateway --include='*.ts'` 的命中只允许出现在 `mcp-gateway.transport.ts` 的装配调用与 `index.ts` 的转出口，不允许出现工具定义本体；贴出命中文件清单与判定。— 命中文件仅 `mcp-gateway.transport.ts` 与 `index.ts`；无工具定义本体。
- [x] `npm run typecheck` 退出 0，`npm run lint` 退出 0。— 两者实测 exit 0。
- [ ] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。— 47 个文件；Touches 已按实测集合补全，但本条未在落地方向上复验（任务已 park）。

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

## Blocker

执行侧不可满足：本条拆分与仓库既有棘轮 `server/shared/tests/server-import-cycle-budget.test.ts`（AC-394，已 done）冲突，落地即红 fan-in 的全量 suite。实测（worktree `gap-mcp-gateway-tool-registration-extract`，commit `7cc37bde7`）：

- (b) `SCC [modules/mcp-gateway, modules/mcp-tools-read, modules/mcp-tools-write, modules/projects, …] is not contained in any baseline cycle group` —— F3 的 server 环从 11 个目录长到 13 个。
- (c) `server/modules/mcp-gateway imports the new directory server/modules/mcp-tools-read`，且两个新目录 import `mcp-gateway` / `oauth` / `providers` / `websocket` / `quay` / 彼此 —— 基线 manifest 之外的新目录必须是叶子（出边只许 `server/shared/**` 与自己，且不得被其它 `server/modules/**` 目录 import）。
- (g) 该判据显式断言「未改动的树保持绿」；棘轮文档明确：基线只许缩小，不许为容纳红而改基线或 `MANIFEST_PIN`。

要同时满足 AC1（新目录承载 9,300+ LOC 工具实现）与棘轮，唯一形态是：两个新目录变成纯叶子（不 import 任何 module、不互相 import，依赖全部注入），注册缝经 `server/index.ts`（目录 `.`，唯一允许的入边来源）注入传输；这要求把共享词汇（错误信封、correlation、draft、approvals、usage-stats、host-control、self-target）与跨模块类型迁到 `server/shared/**`，并改写 `mountMcpGateway` 的 deps 契约。而既有契约判据正是经该契约挂载的（AC3 要求判据「不改一字」），两者互斥。需要人或上游任务在「改 AC / 改棘轮 / 做完整依赖倒置」之间裁决。

已完成（分支 `task/gap-mcp-gateway-tool-registration-extract`，commit `7cc37bde7`，47 个文件）：AC1、AC4、AC5、AC6 绿；AC3 的命令全绿（52 文件 / 319 pass / 0 fail，但 17 个文件有 import-only 机械改动）；AC2 fanOut 达标、SCC 不达标；DoD ⑥ 取假形态因整体不可落地未执行。未改动 `voice-realtime` 与 host driver。
