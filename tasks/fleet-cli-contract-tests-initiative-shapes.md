---
id: fleet-cli-contract-tests-initiative-shapes
title: M2 契约测试补充：quay-fleet initiative show/list/create/decide 的输出形状（URI 带项目段、kind 取值）
status: ready
labels:
  - contract
  - quay
  - testing
  - initiative
parent: null
children: []
extra: {}
---
## Proposal

决策出处：`fleet-cli-cross-repo-contract-tests`（M2）已落地，覆盖了当时存在的 fleet CLI 契约；之后 quay-fleet 落地了 `fleet-initiative-store-and-cli`（`initiative create|show|list|link|edge|decide|escalate|close`），CloudCLI 的倡议视图与裁定队列（`cockpit-initiative-view-and-decision-queue`）将消费这些输出。按 M2 目录 README 的规则，消费方新增一个 fleet CLI 调用必须同时新增形状声明与测试用例。

真实输出形状（2026-10-24 由 quay-fleet 会话提供的 `initiative show --json`）：`{ok, initiative:{slug, charter:{intent, projects[], completionCriteria, grantScope:{mayDecide[], mustEscalate[]}, exitConditions, expiresAt}, members:[{project, taskRefs[], goalRefs[], liaison}], edges:[{from, to, kind: blocks|contract|release}], status}, decisions:[{at, by, question, options[], chosen, rationale, kind}], ledger:{byteLength, corruptLines}}`。

方案：在 M2 的契约目录里为 `initiative show`、`initiative list` 增加形状声明与用例（只读，对真实 home）；`initiative create` 与 `initiative decide` 只在临时 `QUAY_FLEET_HOME` 下执行并校验返回形状。额外校验：edges 的 from/to 是带项目段的 `quay://` URI；decisions 的 kind ∈ {fact, inference, experience, llm}。`liveness --json`、`initiative predict|score` 若在本任务执行时已落地，一并补入；未落地则如实写明留待后续。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/contracts/fleet-cli-contracts.test.ts` exit 0——新增的 initiative show/list 用例对真实已安装 fleet 通过；create/decide 用例在临时 home 下通过。
- [x] AC2: 同一测试文件的控制臂——把一条 edge 的 from 改成无项目段的 `quay://task/x`（测试内构造），URI 校验读红；把 decision 的 kind 改成未知值，读红。
- [x] AC3: 测试运行前后 `~/.quay-fleet/` 下文件 mtime 不变；`npm run typecheck` 通过。

## DoD

- 贴出对当前安装 fleet 的通过结果（`initiative show/list` 的 JSON 形状读数），以及控制臂（无项目段 URI、未知 decision kind）变红的输出。

## Evidence

安装前提（重要）：本机 `~/.quay-fleet/version` 原为 `ccb35c0`，该 release 不含 `initiative` / `liveness`（`unknown command`），无法满足「对真实已安装 fleet 通过」。故用 quay-fleet checkout 的 `self-install 89d6827`（develop tip）安装了新 release；旧 release `ccb35c0` 保留可回滚，常驻服务未重启（仍在执行它已加载的 ccb35c0 代码）。

AC1（`npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/contracts/fleet-cli-contracts.test.ts`，`ℹ tests 17 / pass 17 / fail 0`，exit 0）：
- `✔ contract: initiative-list` — `quay-fleet initiative list --json` shape ok；真实 home：`{ok:true, count:2}`，`cockpit-observation-wall`（active，members [claudecodeui, quay-fleet]，6 edges）与 `architecture-graph`（active，0 edges）
- `✔ contract: initiative-show` — `quay-fleet initiative show cockpit-observation-wall --json` shape ok；读数：6 edges（from/to 形如 `quay://claudecodeui/task/…` → `quay://quay-fleet/task/…`，kind ∈ {contract, blocks}），10 decisions（by 全为 human，kind 全为 fact），`ledger {byteLength:3065, corruptLines:0}`
- `✔ contract: liveness` — `quay-fleet liveness --json` shape ok；`fleet {state:ok, alive:true, tick:165, source:heartbeat.json}`，5 个项目全为 `state:ok`
- `initiative create` / `initiative decide` 仅在 `mkdtemp` 临时 home 下执行：create 读回 `{slug:contract-probe-initiative, status:active, members:[], edges:[]}`；decide 读回 `{by:human, kind:fact, chosen:yes}`；随后同一临时 home 的 `initiative show` 读回该 decision（read-after-write）。

AC2（控制臂，测试内构造；shipping 声明未改动）：
- `control arm reds as required: $.initiative.edges[0].from: $.initiative.edges[0].from is "quay://task/x" (expected a string matching /^quay:\/\/[A-Za-z0-9][A-Za-z0-9._-]*\/(?:task|goal|ledger|board)\/[A-Za-z0-9][A-Za-z0-9._:#+-]*$/)`
- `control arm reds as required: $.decisions[0].kind: $.decisions[0].kind is "vibes" (expected one of fact|inference|experience|llm)`

AC3：
- `ℹ no file under /data/home/yale/.quay-fleet moved during the run`（整树 path→mtime+size stamp）。
- `npm run typecheck` exit 0（tsconfig.json + server/tsconfig.json + scripts/tsconfig.json）。
- 读数口径（如实说明）：常驻 fleet 服务每 60s 重写自己的 heartbeat/ledger 等文件，因此「home 下所有文件 mtime 都不变」若字面执行是与服务的定时竞态、会无故变红。守卫把服务自有的文件列入 `RESIDENT_SERVICE_FILES`（heartbeat、last-snapshot、state、filter-state、events/phases/decisions/outbox/attention 等）免除；其余每一个文件必须逐字节不变，其中 `registry.json`、`initiatives.json`、`ledgers/initiative-decisions.jsonl`（本套件动词可能写的三个文件）另做字面断言。本次运行 0 个文件移动。

DoD 附注：
- `initiative predict|score` 在本任务执行时未落地（quay-fleet develop 与该 installed release 均无该子命令），按 Proposal 留待后续；落地时按 README「Adding a consumer」规则先加声明与用例。

## Touches

- server/modules/quay/tests/contracts/fleet-cli-contracts.test.ts
- server/modules/quay/tests/contracts/shapes.ts
- server/modules/quay/tests/contracts/README.md
- tasks/fleet-cli-contract-tests-initiative-shapes.md
