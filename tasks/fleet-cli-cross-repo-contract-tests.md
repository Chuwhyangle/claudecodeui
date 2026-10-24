---
id: fleet-cli-cross-repo-contract-tests
title: M2 跨仓库契约测试：对着已安装的 quay-fleet 校验 CloudCLI 消费的全部 CLI 契约形状，不兼容在合入前变红
status: ready
labels:
  - contract
  - quay
  - testing
parent: null
children: []
extra: {}
---
## Proposal

决策出处：用户 2026-10-24 同意的跨项目机制 M2——跨仓库契约测试。今天的 URI 项目段分歧（fleet 产出 `quay://task/<id>`、CloudCLI 用 `quay://<project>/task/<id>`）是两边都合入后才发现的；契约应当是长在写入路径上的硬形变，在合入前变红。

现状：CloudCLI 消费 quay-fleet 的这些 CLI 契约——`--version --json`（握手 contracts）、`wall resolve|summary|probe`、`registry list`、`registry interface-session get|set|clear`、`status --json`（以及即将落地的 `liveness --json`、`initiative …`）。CloudCLI 侧只有桩测试，没有任何测试对着**真实已安装的 fleet** 校验形状。

方案：
1. `server/modules/quay/tests/contracts/` 下为每个消费的 CLI 契约写一份 JSON 形状声明（字段、类型、必填、三态取值），与 `quay-fleet-locator` 声明支持的契约版本放在一起。
2. 契约测试 `fleet-cli-contracts.test.ts`：用 `quay-fleet-locator` 定位已安装的 fleet（`~/.quay-fleet/bin/quay-fleet` 等），先做握手；契约版本不兼容 ⇒ 失败并点名哪份契约；兼容 ⇒ 逐个调用只读动词（写类动词用 `--dry-run` 或临时 `QUAY_FLEET_HOME`，不得写用户真实的 fleet home）并按形状声明校验输出。
3. 找不到已安装 fleet ⇒ 测试**失败**并说明原因（fail-closed，不得静默跳过）；为没有 fleet 的环境提供显式开关 `CONTRACT_TESTS_ALLOW_MISSING_FLEET=1`，此时输出醒目的 skipped 并在 fan-in 日志里可见。
4. 新增契约时的规则写进该目录 README：消费方新增一个 fleet CLI 调用，必须同时新增形状声明与测试用例。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/contracts/fleet-cli-contracts.test.ts` exit 0（本机已安装 fleet）——握手通过；`wall resolve`（含 `#ac-<n>` 片段）、`wall summary`、`registry list`、`registry interface-session get`、`status` 的输出逐个符合形状声明。
- [x] AC2: 同一测试文件的控制臂——把形状声明里一个必填字段改名（测试内构造），校验读红并点名该字段；把 CloudCLI 声明支持的 `wallUri` 改为 `v1`，握手读红并点名 `wallUri`。
- [x] AC3: 未设开关且定位不到 fleet 时测试失败（不是 skip）；设了 `CONTRACT_TESTS_ALLOW_MISSING_FLEET=1` 时输出 skipped 原因。
- [x] AC4: 测试运行前后 `~/.quay-fleet/` 下文件的 mtime 不变（写类动词只在临时 home 上执行）；`npm run typecheck` 通过。

## DoD

- 对当前安装的 fleet 版本跑一次全绿，贴出握手版本与每份契约的校验结果；再人为把一份声明改错，贴出变红输出。

## Touches

- server/modules/quay/tests/contracts/fleet-cli-contracts.test.ts (new)
- server/modules/quay/tests/contracts/shapes.ts (new)
- server/modules/quay/tests/contracts/README.md (new)
- server/modules/quay/quay-fleet-locator.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/fleet-cli-cross-repo-contract-tests.md

## Blocker

**2026-10-24T09:01:51.878Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=merge-develop: Auto-merging scripts/suite-duration-baseline.tsv
CONFLICT (content): Merge conflict in scripts/suite-duration-baseline.tsv
Auto-merging server/shared/tests/quay-test-script.test.ts
CONFLICT (content): Merge conflict in server/shared/tests/quay-test-script.test.ts
Automatic merge failed; fix conflicts and then commit the result.
- run_id：wk-prod-anchor
- session_id：f318a611-8c73-4ed2-8ab7-86f6ab30aa14
