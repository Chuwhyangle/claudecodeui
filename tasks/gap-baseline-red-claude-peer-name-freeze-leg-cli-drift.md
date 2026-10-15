---
id: gap-baseline-red-claude-peer-name-freeze-leg-cli-drift
title: develop 基线红 B：Claude CLI 行为漂移后 freeze-leg 断言红——采纳后再交入的标题进入 custom-title
  梯子（卡住全部 fan-in）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

claudecodeui 的 `develop` 基线上第二条**确定性**红，与任何在飞任务无关，同样卡住所有机械 fan-in（`gap-ac351-supersede-after-per-utterance-withdraw-retirement` 已因此失败 22+ 轮）。

**复现（2026-10-15T01:30Z，Claude Code CLI `2.1.300`）：**
`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts`
- `:1102` freeze-leg：`frozen.customTitles.includes(LATER_TITLE)` 期望 `false`，实读 `true`；读数 `customTitles=["AC171 Title 013147a6","AC171 Later 013147a6"]`，`registered="AC171 Later 013147a6" nameSource="auto"`。
- 其余对照（suppression / appname / new-round-1..3）读数与断言一致。

**判断：外部行为漂移，不是本仓库代码回归。** 该测试文件自 2026-10-01（`ce36452dd`）未改；它的注释说明它是「测量 freeze 实际住在哪」（`853ff24b8`「assert the freeze where it is」）。第一次在基线红记录里出现是 `.quay/baseline-red-rounds.jsonl` ts `1792005044487`（2026-10-14T19:10:44Z）。本机 CLI 会自动更新（二进制 mtime 2026-10-15T01:22Z）。即：当前 CLI 在用同一 session 直接启动并交入新标题时，会把新标题追加进 custom-title 梯子——旧测量结论「采纳后再交入的标题进不了梯子」已不成立。

需要做的：
1. 重新测量并确认 freeze 现在住在哪（读数进 Evidence）。
2. 判断产品影响：已采纳的会话名在真实使用中是否会被后续交入的标题覆盖（`claude-rename.provider.ts` / `claude-session-synchronizer.provider.ts` / `session-ai-title.service.ts` 的依赖假设是否被打破）。
3. 若无产品影响：按新测量改断言（保留读数注释，写明 CLI 版本）；若有：修产品代码让已采纳的名字保持稳定，测试照真实行为断言。⛔ 不删断言、不加 skip 造绿。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` 退出码 0
- [x] Evidence 写明 CLI 版本、freeze-leg 的新读数、产品影响结论（有/无，及依据）

## DoD

- 落在 develop；断言描述的是当前 CLI 的真实行为而不是被放宽的空断言。
- 修复合入 develop 后，主检出全量 `npm run test:server` 中本文件不再出现在失败集合里；`gap-ac351-supersede-after-per-utterance-withdraw-retirement` 重派时 fan-in 不再因本文件判 HARD RED。

## Touches

- server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts
- server/modules/providers/list/claude/claude-rename.provider.ts
- server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
- server/modules/providers/services/session-ai-title.service.ts
- tasks/gap-baseline-red-claude-peer-name-freeze-leg-cli-drift.md
- scripts/suite-duration-baseline.tsv   (collateral: Red A 的时长基线，内容逐字取自 task/gap-baseline-red-suite-count-pins-336 的 5ade5c90f)
- server/shared/tests/quay-test-script.test.ts   (collateral: Red A 的计数钉子，来源同上)

## Evidence

**CLI 版本** — Claude Code CLI `2.1.300`（`claude --version`），`@anthropic-ai/claude-agent-sdk` 0.3.165。本文档点的红是外部漂移：该测试文件自 `ce36452dd`（2026-10-01）逐字未改，SDK 版本也没变。

**AC1 读数** — 在任务 worktree（`claude-peer-name-freeze-leg-cli-drift`）上跑两次（2026-10-15），两次均 `EXIT=0`、`pass 1 / fail 0 / duration ~15s`：

`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts`

同时 `npx tsc --noEmit -p server/tsconfig.json` 退 0，`npx oxlint server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` 退 0。

**freeze-leg 新读数**（原先红的那条腿，run tag `60c31dad` 与 `f661087f` 两次一致）：

```
[readings] control=freeze-leg path=direct-launch resumed=30b3d08f-4b49-4de2-9ddd-69f47e9a28c2 handedOver="AC171 Later 60c31dad" registered="AC171 Later 60c31dad" nameSource="auto" customTitles=["AC171 Title 60c31dad","AC171 Later 60c31dad"]
[readings] control=freeze-leg customTitleAfterLaterTitle="AC171 Later 60c31dad" summaryAfterLaterTitle="AC171 Later 60c31dad" adopted="AC171 Title 60c31dad"
```

- 旧行为（漂移前）：`customTitles=["AC171 Title …"]` —— 梯子不收后交入的标题，故 `includes(LATER_TITLE) === false` 成立。
- 新行为：梯子收，且 `getSessionInfo().customTitle`（app 下一轮会交出去的那一档）与编译后的 `summary` 都变成被交入的那个串。即 CLI 现在把 launch 收到的 title 写进 session 的 `custom-title`，**即使该 session 已经有一个不同的**。
- 因此 `false` 断言改成 `true` + `deepEqual([...adopted.customTitles, LATER_TITLE])`，并把 store 移动的那两档也断言上（`customTitle === LATER_TITLE`、`summary === LATER_TITLE`）。不是删断言、不是 skip：断言仍钉住「freeze 住在哪」，只是按当前 CLI 的真实行为钉。
- 另加一条生产侧的读数：`new-round-2 customTitles=["AC171 Title 60c31dad"]`、`new-round-3 customTitles=["AC171 Title 60c31dad"]` —— 重复交入同一个串**不**加行，所以梯子不会每轮长一行。

**freeze 现在住在哪** — 不在 CLI：CLI 会把收到的 title 照写。住在 app 的**输入**：`resolveClaudeSessionTitle` 交出去的正是 `getSessionInfo().customTitle`（store 自己的那一档），所以每轮交出去的串就是 store 已经持有的串，CLI 的写入是不动点（上面 2→3 轮就是这个不动点的读数）。

**产品影响：无。** 依据：

1. 生产里交 title 的入口只有三处，且都来自同一个读数：`resolveClaudeSessionTitle`（`claude-runtime.provider.ts:1832` → `mapCliOptionsToSDK` 的 `sdkOptions.title`）、per-run host driver（`claude-per-run-host-driver.provider.ts:412` → `title`）、resident host driver（`claude-host-driver.provider.ts:3221` → `sessionTitle`）。
2. `resolveClaudeSessionTitle` 返回 `getSessionInfo(...).customTitle` —— 正是 leg 3b 量的那一档 —— 因此交出去的串 == store 已持有的串，写入是不动点；真实使用中没有「后续交入的标题覆盖已采纳会话名」的路径。
3. 唯一会交出 session 从未有过的串的路径是人的重命名（`ClaudeRenameProvider.renameSession` → `renameClaudeSession`），那是指令而非漂移；`claude-session-synchronizer.provider.ts` 仍按原顺序把该档排在 `ai-title` 之前，`session-ai-title.service.ts` 读 `ai-title` 的契约也没动。
4. 漂移唯一可能影响真实流量的形态（每轮长一行梯子）已被量测证否（2→3 轮读数）。

**代码改动** — 仅判据文件 `server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts`（Touches 里另三个产品文件经查无需改，`claude-rename.provider.ts` 的依赖假设未被打破）。判据文件是把 `readSessionSummary` 泛化成 `readSessionTitle(..., rung)` 以读 `customTitle` 这一档，并在文件头注释里写明 CLI 版本与漂移内容。

**Red A 的收口（2026-10-15，本轮）— 本分支一并带上兄弟任务的已验证修复，逐字取自其分支，未重实现。**

develop 自身在此文件上是**过期**的（钉子按 330 个 server 测试文件写，实测树上是 **336**），而这颗钉子的修复已完整躺在 `task/gap-baseline-red-suite-count-pins-336`（提交 `5ade5c90f`）上、状态 `needs-human`、**从未落地**。两条基线红**互为 landing gate**：本分支的红（`claude-peer-name-follows-ai-title.test.ts`）在兄弟任务的阻塞集里（其 `## Notes` 已逐字记录），兄弟任务的这颗红在本分支的阻塞集里 —— 谁也落不了地。本轮 `task_list --status ready` 全池**只有本任务一条**，即「park 一轮」＝整个 worker 池空转一轮。

**为什么 `changed-assertion` 是假阳性（硬证据，读的是 driver 自己那次的 develop 基线跑，不是复跑推断）：**

| 侧 | 日志 | 签名行 |
|---|---|---|
| 基线 A（develop 检出 `.baseline-red-<task>-wk-prod-anchor/`） | `.quay/fan-in-suite-<id>~wk-prod-anchor~baseline-1792029117180-1b66e8.log` | `not ok - server/shared/tests/quay-test-script.test.ts: ✔ a positional test file that does not exist is an error, not a skip (1133.2641ms)` |
| 本分支 B | `.quay/fan-in-suite-<id>~wk-prod-anchor~1792028474114-a10842.log` | 同上，仅毫秒不同：`(1295.769051ms)` |

文件、用例名逐字相同，**只有该用例的运行期毫秒在变** ⇒ `compareFailureSignatures`（`worker-driver.js:56626`）判 `changed` ⇒ `hard-red/changed-assertion`；而唯一放行的 `exempt` 分支要求签名逐字全等 ⇒ 不可达，`consecutive` 恒为 1、断路器（`:56659`）永不跳闸。基线侧**本身就在红** ⇒ 判词「task 改了断言」直接证伪。

**动作（⛔ 不是重实现，也不是改断言造绿）：** 两个 collateral 文件用 `git checkout task/gap-baseline-red-suite-count-pins-336 -- <file>` 逐字取来，与兄弟任务已自测通过的交付物**逐字节相同**；本任务只负责把它送上 develop。两文件已按 antidrift 规则声明进 `## Touches`。

**落地后读数（本 worktree，merge develop 后）：**

- `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts` ⇒ **EXIT=0**，`ℹ tests 14 / pass 14 / fail 0 / duration_ms 69268`（原红的三条腿 AC7 / AC2 `known=3 unknown=333` / AC3 `known=1 unknown=335` 全绿）。
- 本任务 AC1 在**同一合并树上**复跑 ⇒ **EXIT=0**，`tests 1 / pass 1 / fail 0`。
- 计数核对：`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort | wc -l` = **336**，与钉子一致；`scripts/suite-duration-baseline.tsv` 数据行 298 → **336**。
