---
id: gap-projects-services-cycle-port-break
title: 把 projects 组拉出 7 成员依赖环：projects-with-sessions-fetch 的两条跨组
  import（sessionSynchronizerService、connectedClients）改经端口注入，projects 出环、环缩为 5
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22，HEAD 0acd5b0227fd）**：机制词 grep `grep -rlE 'projects-with-sessions-fetch|projects/services.*(环|出环|拆|port)|拉.*projects.*出环' tasks/*.md` → 命中若干，逐条读：`gap-server-provider-websocket-init-cycle-ports`（done）是 ports 手法样板（拆的是 provider/websocket/mcp-gateway/session-hosts 环）；`gap-ac253-gateway-shares-single-control-service` 等是行为任务；**无一认领「把 projects 组拉出当前 7 成员环」**。合并候选（granularity-advice `--touches projects-with-sessions-fetch.service.ts`）报 `peers: []` ⇒ **separate**。

### 现状（立案时实测，archguard server scope 新鲜读数）

- 7 成员目录环（voice 已出，8→7）：`projects / projects/services / providers / providers/list/claude / providers/services / websocket / websocket/services`。
- **projects 组的全部跨组出边集中在一个文件**：`server/modules/projects/services/projects-with-sessions-fetch.service.ts` 的 `:7`（`sessionSynchronizerService`←providers）与 `:8`（`WS_OPEN_STATE, connectedClients`←websocket）。projects 组其余出边只到 database/shared/architecture/quay；入边（providers/services→projects 2 处、websocket/services→projects 1 处 `generateDisplayName`）是「被依赖」，不是环的成因。
- 断掉这 2 条出边，projects 组变「只进不出」的 sink，退出 SCC ⇒ 环 **7→5**（剩 providers 组 + websocket 组）。
- 刀5 直接样板：`voice-lexicon.ts` 的 providers 动态 import 改经端口注入（`voice-lexicon.port.ts`），voice 已出环。
- 现成资产：`server/shared/ports/connected-clients.port.ts` 已有 `installConnectedClientsPort`，但只暴露 `readConnectedClientCount()`；本文件需要**遍历** clients 判 `readyState === WS_OPEN_STATE`，可能需扩展迭代能力。

### 改法

把 `projects-with-sessions-fetch.service.ts` 的 2 条跨组运行时依赖改经**端口注入**：新增一个端口承载 `sessionSynchronizer` 与 connected-clients 两段能力（或复用/扩展既有 `connected-clients.port.ts`），assembly（`server/index.ts`）安装。断掉后 projects 组退出 SCC，7→5。**行为保持**：该服务只在 fetch 路由被调用，注入后语义不变。

⛔ 护栏：端口文件落 `server/shared/ports/`（不新建模块目录）；**扩展 `connected-clients.port.ts` 时新成员必须可选、或新增独立 read 函数，不得给既有 `ConnectedClientsPort` 类型加必填成员**（会逼改兄弟判据）；判据复用 AC-394 的 `strongComponents`/`collectServerSources`（`server/shared/import-graph.ts`），不另写一份。

<!-- dedup-ref --> 相关但不同机制：`gap-voice-provider-cycle-port-break`（done）是本条同款断边手法的直接前例（voice 出环 8→7）；`gap-server-provider-websocket-init-cycle-ports`（done）是 ports 手法样板（不同环）。两者均不构成本条前置。

## Plan

1. **读边**：确认 `projects-with-sessions-fetch.service.ts:7/8` 是 projects 组仅有的跨组出边（以当前树为准，若漂移按实测更新）。
2. **定端口**：新增 `projects-session-fetch.port.ts`（install/uninstall + 取 `synchronizeSessions` 与 connected-clients 能力）；确定 `connected-clients.port.ts` 的复用/扩展方式（可选成员或独立 read 函数）。
3. **接线**：projects-with-sessions-fetch 改经端口取能力，删除 2 条跨组 import；调用方路径不变。
4. **判据**：复用 AC-394 扫描器断言 `modules/projects` 与 `modules/projects/services` 都不在任何非平凡 SCC；AC-394 棘轮自身仍绿（G1 7→5 属允许缩小）。
5. **收口**：既有调用方判据单跑仍绿、tsc/lint、collateral、范围受控。

## AC

- [x] (a) **projects 组不再 import providers/websocket**：`grep -rnE "@/modules/(providers|websocket)" server/modules/projects --include='*.ts' --exclude-dir=tests` 计数 = **0**（含动态 `import('@/modules/…')` 字面量）。ℹ️ 立案原文未排除 `tests/`，该树上有 2 条既有测试引用（`server/modules/projects/tests/projects-session-filter.integration.test.ts:12`、`tests/session-filter-realdata.test.ts:51`，均为 `@/modules/providers`，非 shipping 代码，AC-394 扫描器本就 prune `tests/`），字面口径不可满足，故按扫描口径收紧到 shipping 代码；`grep -n "projects-session-fetch" server/index.ts` 命中 import 行与端口清单注释，安装调用为 `installProjectsSessionFetchPort({...})`。
- [x] (b) **端口存在**：`test -f server/shared/ports/projects-session-fetch.port.ts` 退出 0；`grep -q "projects-session-fetch" server/index.ts` 退出 0。
- [x] (c) **判据存在且跑通（projects 出环）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/tests/projects-session-fetch-cycle.test.ts` 退出 0；其 import AC-394 的 `strongComponents` / `collectServerSources`（`server/shared/import-graph.ts`），打印 `projectsInAnyScc=false projectsServicesInAnyScc=false`（并打印每段非平凡 SCC 成员）。
- [x] (d) **AC-394 棘轮仍绿**：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出 0（G1 7→5 属允许的缩小；G1/G2/G3 逐成员仍是基线的子集）。
- [x] (e) **既有行为判据不改一字仍绿**：调用 `getProjectsWithSessions / getArchivedProjectsWithSessions / getProjectSessionsPage` 的既有测试单跑、各自退出 0（`server/modules/mcp-gateway/tests/mcp-changes.test.ts`、`server/modules/mcp-gateway/tests/mcp-session-search-pruning.test.ts` 均退出 0；另复跑 `server/modules/projects/tests/projects-session-filter.integration.test.ts`、`session-filter-realdata.test.ts`、`server/modules/mcp-gateway/tests/mcp-overview.test.ts` 亦退出 0）。
- [x] (f) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (g) **collateral**：`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 实测 = **400**（399 + 1，merge develop 后复量仍 400）；`server/shared/tests/quay-test-script.test.ts` 两条计数 pin 各 +1（AC2 unknown 396→397、AC3 398→399）并改写其上方注释算术；`scripts/suite-duration-baseline.tsv` 追加了新文件一行：不加时覆盖读数为 360/400 = 恰好 90.0% 地板、无余量，加后 361/400；单文件复跑 quay-test-script.test.ts 退出 0。
- [x] (h) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列（anti-drift-touches-check 报 8 actual files 全部在 Touches 内）。

## DoD

真实落地的标准是「projects 组真的**退出了目录环**、且退出是经端口注入（不是把依赖静默塞到别处）」，不是「多了一个端口文件」。必须贴出：①(a)(b) 的 grep/test 读数与端口安装行原文；②(c) 判据打印的逐段 SCC 成员与 `projectsInAnyScc=false projectsServicesInAnyScc=false`（并写明扫描器复用自 `server/shared/import-graph.ts`）；③(d) AC-394 判据单跑退出码与其自打印的 G1/G2/G3 逐成员（证明 7→5 后仍是基线子集）；④(e) 既有判据退出码；⑤(f) tsc/lint；⑥(g) collateral；⑦纯位移核对（`sessionSynchronizerService`/`connectedClients` 取用方式从直接 import 改为端口注入，业务语义不变）。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/projects/services/projects-with-sessions-fetch.service.ts`（2 条跨组 import 改经端口注入，业务语义不变）
- `server/shared/ports/projects-session-fetch.port.ts` (new)（install/uninstall + synchronizeSessions 与 connected-clients 能力）
- `server/shared/ports/connected-clients.port.ts`（条件性：扩展只读迭代能力；新成员可选或独立 read 函数，不给既有类型加必填成员）
- `server/index.ts`（assembly 处安装 projects-session-fetch 端口）
- `server/modules/projects/tests/projects-session-fetch-cycle.test.ts` (new)（判据：复用 AC-394 扫描器断言 projects 出环）
- `server/shared/tests/quay-test-script.test.ts`（collateral：两条计数 pin 各 +1 及注释算术）
- `server/shared/tests/server-import-cycle-budget.test.ts`（棘轮：G1 7→5 成员并同步注释/读数，属允许的缩小）
- `server/shared/tests/server-import-cycle-budget.baseline.json`（棘轮：G1 去掉 projects 组）
- `scripts/suite-duration-baseline.tsv`（collateral：仅当覆盖率地板跌破 90%）
- `tasks/gap-projects-services-cycle-port-break.md`（自触）
