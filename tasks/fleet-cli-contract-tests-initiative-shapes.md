---
id: fleet-cli-contract-tests-initiative-shapes
title: M2 契约测试补充：quay-fleet initiative show/list/create/decide 的输出形状（URI 带项目段、kind 取值）
status: todo
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

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/contracts/fleet-cli-contracts.test.ts` exit 0——新增的 initiative show/list 用例对真实已安装 fleet 通过；create/decide 用例在临时 home 下通过。
- [ ] AC2: 同一测试文件的控制臂——把一条 edge 的 from 改成无项目段的 `quay://task/x`（测试内构造），URI 校验读红；把 decision 的 kind 改成未知值，读红。
- [ ] AC3: 测试运行前后 `~/.quay-fleet/` 下文件 mtime 不变；`npm run typecheck` 通过。

## DoD

- 贴出对当前安装 fleet 的通过结果，以及控制臂变红的输出。

## Touches

- server/modules/quay/tests/contracts/fleet-cli-contracts.test.ts
- server/modules/quay/tests/contracts/shapes.ts
- server/modules/quay/tests/contracts/README.md
- tasks/fleet-cli-contract-tests-initiative-shapes.md
