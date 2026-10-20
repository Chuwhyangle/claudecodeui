---
id: gap-server-root-browser-use-cycle-relocate-mcp-entry
title: Break the server root ↔ modules/browser-use cycle by relocating the MCP
  entry/bootstrap
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F5（架构校准报告 `/tmp/arch-analysis-calibration-2026-10-20.md`，HEAD `abc2b5ed9`，ArchGuard 0.1.40 的 edge-evidence 新读数）：server 包图里有一个真实的二元强连通分量 `G3 = [".", "modules/browser-use"]`（ArchGuard 用 `""` 表示 server 根包，基线 JSON 用 `"."`）。**这不是假阳性**：新 build 的 `edges[]`（`{from,to,specifier,file,line}`）给出四条边，逐条在本树复核过：

- `server/index.ts:87` → `./modules/browser-use/browser-use.routes.js`
- `server/index.ts:91` → `./modules/browser-use/browser-use-mcp.routes.js`
- `server/index.ts:140` → `./modules/browser-use/browser-use.service.js`
- `server/modules/browser-use/browser-use-mcp.ts:4` → `../../load-env.js`（server 根的 bootstrap）

早先那次「false positive」读数是错的，原因具体：它只看了 `browser-use.service.ts:10-12`（模块内部的 import），漏掉了同目录下另一个独立可执行入口 `browser-use-mcp.ts`；该文件唯一的跨目录 import 就是 `../../load-env.js`。`browser-use-mcp.ts:2-4` 自己的注释写明「The MCP executable must load the root environment bootstrap before reading configuration」，所以这条边是承重的，不是手滑，不能简单删掉。

现状读数：`server/shared/tests/server-import-cycle-budget.baseline.json` 的 `cycleGroups.G3 = [".", "modules/browser-use"]`。修复方向是让 G3 向空收缩（只减不增）。

改法（优先最小切口，且必须让 MCP 入口继续工作）：

- **Arm A（首选）**：把 `browser-use-mcp.ts` 移出 `modules/browser-use`——例如放进已有的 `server/modules/cli/`，或新建 `server/entrypoints/`。`modules/browser-use → "."` 这条边消失；入口自身仍有 `entry → "."`，但根包不再有指向它的入边，因此不再成环。移走后必须改 `server/modules/browser-use/index.ts` 里 `startBrowserUseMcp()` 的 lazy `await import('./browser-use-mcp.js')`，并清查其它对旧路径的引用。
- **Arm B**：把 `server/load-env.ts` 移到 `server/shared/load-env.ts`，让 MCP 入口改为 import 一个 shared 叶子。立案时发现的约束：`server/load-env.ts:7` 为 `installTimestampedConsole` 导入了 `./modules/logging/index.js`。原样搬进 `shared/` 会让 `server/shared` 反向 import `server/modules/**`，直接红掉 AC-394 棘轮的 (d) 条（shared 对 modules 零入边）。所以 Arm B 还须把 timestamped-console installer 一起迁到 shared 或改为注入（实现文件 `server/modules/logging/timestamped-console.ts`，由 `server/modules/logging/index.ts` 转出口），切口明显大于 Arm A。

无论选哪臂，有两条棘轮约束必须同时满足：(i) **新目录**（如 `server/entrypoints/`）按 AC-394 (c) 的叶子规则原文只允许 import `server/shared/**` 与自身；一个 import 根包 `"."` 的新入口目录不满足该原文，必须在 baseline 的 `directoryManifest` 与测试的 `MANIFEST_PIN` 里登记为具名例外并重测 `nodeCount`——直接用已有的 `server/modules/cli/` 可绕开这条；(ii) baseline JSON 的 `G3` 与测试内 `CYCLE_GROUPS` 的 `G3` 必须同向、同值下调。

为什么值得修：根包与一个 feature 模块在彼此的初始化语义里；MCP 可执行文件依赖这条 bootstrap 边拿 `.env` 与默认 `DATABASE_PATH`，所以正确解法是把入口或 bootstrap 挪位，而不是把边删掉留下一个加载顺序敏感的接缝。

新 smoke test 的验证形状：以子进程启动该入口，向 stdin 写一行 JSON-RPC `initialize`，断言回复里 `serverInfo.name == "cloudcli-browser"`（见 `browser-use-mcp.ts:302-309`）；第二条腿用 `DATABASE_PATH` 未设置的子进程环境断言 bootstrap 装上了用户级默认值 `path.join(os.homedir(), '.cloudcli', 'auth.db')`（`server/load-env.ts:53-57`）——这是「load-env 跑过」的确定性可观察量，因为 `.env` 是否存在没有保证。

<!-- dedup-ref --> 机制去重（立案时 `task_list` 实测，2026-10-20）：`search=browser-use status=todo` → 0、`status=ready` → 0；`search=browser-use-mcp status=todo` → 0；`search=load-env status=todo|ready` → 0；`search=cycle status=todo` → 0；`search=archguard status=todo|ready` → 0 ⇒ 没有开放任务认领这个机制。相关但不同机制：`gap-ac394-server-import-cycle-budget`（done）是数并卡住 SCC 的棘轮判据本身，不是本产品修复；`gap-server-provider-websocket-init-cycle-ports`（done）用 port 把 G1 从 11 缩到 8，是另一个环、另一套机制。立案请求里点名的架构侧任务 `gap-module-graph-root-dynamic-import-attribution` 在本 store **不存在**（`prefix=gap-module-graph` → 0、`task_get` → no such task），故不写回指。合并候选：本 agent 无 Bash，无法运行 `task-granularity-advice.js`（不谎称已跑）；以 `task_list` 的上述开放任务检索替代，未发现声明同批文件的 peer ⇒ 判定 **separate**（独立性：本条是可观测的产品修复，AC-394 是判据棘轮，两者验收不同）。

## AC

- [ ] (a) 入口不再从 `modules/browser-use` 内部 import 根 bootstrap：`test -z "$(grep -rn "\.\./\.\./load-env" server/modules/browser-use --include='*.ts' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//')"` 退出 0；**或**入口已移出该模块：`test ! -e server/modules/browser-use/browser-use-mcp.ts` 退出 0 并贴出新绝对路径。贴出改动前计数（当前 1 条，`browser-use-mcp.ts:4`）与改动后计数。
- [ ] (b) 棘轮收缩且仍绿：`server/shared/tests/server-import-cycle-budget.baseline.json` 的 `cycleGroups.G3` 改为 `[]`（或 `[".", "modules/browser-use"]` 的真子集；**新增成员即判失败**），测试内 `CYCLE_GROUPS` 同值同步；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出 0，并贴出它的 `files=… staticEdges=… dynamicEdges=… sccs=[…]` 首行。若目录有增删，同一次改动里更新 `directoryManifest` / `nodeCount` / `MANIFEST_PIN`。
- [ ] (c) 新鲜 `archguard_detect_cycles(outputScope=package)` 在 server scope 上不再报告同时含 `"."` 与 `modules/browser-use` 的 SCC；贴出前（本条立案读数 `{size:2, modules:["", "modules/browser-use"], edges:4}`）与后的成员清单。（待外部）
- [ ] (d) 新 smoke 判据 `server/modules/browser-use/tests/browser-use-mcp-entry.test.ts`（入口若移位则判据跟随到新模块的同名 `tests/` 下）跑通：`npx tsx --tsconfig server/tsconfig.json --test <该文件>` 退出 0。第一条腿 spawn 该 MCP 入口并向 stdin 写一行 `initialize` 请求，断言回复中 `serverInfo.name == "cloudcli-browser"`；第二条腿在 `DATABASE_PATH` 未设置的子进程环境里断言 bootstrap 装上 `~/.cloudcli/auth.db` 默认值。贴出测试文件数 / pass / fail 与原始回复行。
- [ ] (e) 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。
- [ ] (f) 新 server 测试文件的注册钉子：按 `<duration_ms>\t<path>` 向 `scripts/suite-duration-baseline.tsv` 追加一行，并按复测值把 `server/shared/tests/quay-test-script.test.ts` 的两条 `unknown=` pin 各上移 1；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [ ] (g) 范围受控：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件，不多一个。

## DoD

真实落地的标准是「真实 `server/` 树上那个 SCC 消失了、棘轮是向下收缩读出来的绿、且 MCP 入口仍能端到端启动并拿到 bootstrap 的效果」，不是「文件搬家了」。必须贴出：① ArchGuard 的 SCC 前后成员清单（前：`{size:2, modules:["", "modules/browser-use"], edges:4}`；后：实际读数）；② 棘轮判据的首行 `files=… staticEdges=… dynamicEdges=… sccs=[…]` 与 `tests / pass / fail`；③ smoke 判据两条腿的读数与原始 `initialize` 回复行；④ (a) 的 grep 前后计数与新入口路径；⑤ typecheck / lint 退出码；⑥ **取假形态（真实树）**：把 `../../load-env.js` 临时加回 `server/modules/browser-use` 下某个文件 ⇒ 棘轮判据必须在 G3 上红，随后字节级还原（`git checkout -- <file>`）⇒ 复绿，两次读数逐字贴出；⑦ 若目录有增删，manifest + `MANIFEST_PIN` + `nodeCount` 的登记与重测值。若切口后棘轮反而红，**不得**改 G3 迁就读数——按遗留 import 或新形成的 SCC 归因。

## Touches

- server/modules/browser-use/browser-use-mcp.ts（MCP stdio 入口，移出或改写）
- server/modules/cli/browser-use-mcp.ts (new)（Arm A 目标：并入已有 cli 目录）
- server/entrypoints/browser-use-mcp.ts (new)（Arm A 备选目标；新目录须按 (b) 登记）
- server/modules/browser-use/index.ts（`startBrowserUseMcp()` 的 lazy import 路径更新）
- server/load-env.ts（Arm B：bootstrap 迁出）
- server/shared/load-env.ts (new)（Arm B 目标）
- server/modules/logging/index.ts（Arm B：`installTimestampedConsole` 转出口调整）
- server/modules/logging/timestamped-console.ts（Arm B：installer 迁往 shared 或改为注入）
- server/shared/timestamped-console.ts (new)（Arm B only）
- server/index.ts（bootstrap / browser-use import 若变化）
- package.json（仅当有 script/bin 指向该入口旧路径）
- server/modules/browser-use/tests/browser-use-mcp-entry.test.ts (new)（smoke 判据，两条腿）
- server/shared/tests/server-import-cycle-budget.baseline.json（G3 下调；目录清单 / nodeCount 若变动）
- server/shared/tests/server-import-cycle-budget.test.ts（`CYCLE_GROUPS` G3 同步下调；`MANIFEST_PIN` 若变动）
- server/shared/tests/quay-test-script.test.ts（新 server 测试文件 ⇒ 两条 `unknown=` pin 各 +1，按复测值）
- scripts/suite-duration-baseline.tsv（新测试文件的时长行）
- tasks/gap-server-root-browser-use-cycle-relocate-mcp-entry.md (self)