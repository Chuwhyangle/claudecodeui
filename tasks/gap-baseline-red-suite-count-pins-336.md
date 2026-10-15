---
id: gap-baseline-red-suite-count-pins-336
title: develop 基线红 A：服务器测试数涨到 336，quay-test-script 的计数钉子与时长基线未跟上（卡住全部 fan-in）
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

claudecodeui 的 `develop` 基线上有一条**确定性**红，与任何在飞任务无关，正在卡住所有任务的机械 fan-in（`baselineEquivalence` 判 `changed-assertion` ⇒ HARD RED）。实测把 `gap-ac351-supersede-after-per-utterance-withdraw-retirement` 卡成 22+ 轮「重派—失败—needs-human」。

**复现（2026-10-15T01:2xZ，author 与 develop 在 server/scripts/src 上零 diff，主检出直接跑）：**
`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts`
- AC7：`baseline covers 298/336 collected files (< 90%)`
- AC2：期望 `known=3 unknown=327`，实读 `known=3 unknown=333`
- AC3：期望 `known=1 unknown=329`，实读 `known=1 unknown=335`

成因：服务器测试文件数涨到 336，计数钉子与时长基线未跟上。先例提交 `87918c258`、`d347fc11f`、`ee1a62fa5`（同一类「移动计数钉子 / 补基线行」）。

修法：按现树重钉两个字面量；给 `scripts/suite-duration-baseline.tsv` 补上缺的文件行（真实测得的时长，不编造），使覆盖率回到 ≥ 90%。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts` 退出码 0
- [x] 基线新增行的时长来自真实测量（Evidence 里写明测量命令与原始读数）

## DoD

- 落在 develop；之后 `gap-ac351-supersede-after-per-utterance-withdraw-retirement` 的 fan-in 不再因本文件红而判 HARD RED（另一条红见 `gap-baseline-red-claude-peer-name-freeze-leg-cli-drift`）。

## Touches

- scripts/suite-duration-baseline.tsv
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-baseline-red-suite-count-pins-336.md

## Evidence

本轮（2026-10-15）在任务 worktree
`/data/home/yale/work/claudecodeui-worktrees/gap-baseline-red-suite-count-pins-336`
（分支 `task/gap-baseline-red-suite-count-pins-336`，实现提交 `5ade5c90f`，fork 点 = develop `24d26f5df`）自己直跑的原始读数，不是台账推断。

### AC1 — 判据文件整跑退出 0

命令（与 AC 逐字一致）：

`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts`

原始读数：**EXIT=0**；`ℹ tests 14 / ℹ pass 14 / ℹ fail 0 / ℹ duration_ms 68762`；14 条用例逐条 ✔（含 AC7 / AC2 / AC3）。

改前在同一 worktree 上直跑同一命令，三条腿按同一形状红（这就是 develop 上的确定性红）：

| 腿 | 改前（复现） | 改后 |
|---|---|---|
| AC7 | `baseline covers 298/336 collected files (< 90%)`（88.7%） | `336/336`，绿 |
| AC2 | 期望 `known=3 unknown=327`，实读 `known=3 unknown=333` | 钉到 `known=3 unknown=333`，绿 |
| AC3 | 期望 `known=1 unknown=329`，实读 `known=1 unknown=335` | 钉到 `known=1 unknown=335`，绿 |

### AC2 — 新增 38 行的时长来源与原始读数

基线数据行 298 → 336（`grep -c '^[0-9]'` 两次读数）；`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort` 收 336 行；`comm -23` 差集为空 ⇒ 覆盖 336/336，不再贴着 90% 地板。格式自检：`grep -E '^[0-9]' … | grep -vcE '^[0-9]+\tserver/[^[:space:]]+\.test\.(ts|js)$'` 读 **0**（无非法行）。

两类取数，两种都写明：

**(a) 32 行取自台账里最近一个 GREEN round —— 文件头自己的 DATA SOURCE。**

文件头 REGENERATE 命令用的同一台账：`/data/home/yale/work/claudecodeui/.quay/verification-round.jsonl`。选中 round = **1129**（`startedAt 2026-10-14T13:06:00.073Z`，`fail=0`，`perFile` 542 条），即该命令今天会挑中的那一个。

取数表达式（与文件头 REGENERATE 同一形状，只是从该 round 的 `perFile` 里按缺件名单取）：

`node -e '…const g=[...rows].reverse().find(r=>r.fail===0&&Array.isArray(r.perFile)); const m=new Map(g.perFile.map(x=>[x.file,x.durationMs])); …' /data/home/yale/work/claudecodeui/.quay/verification-round.jsonl`

逐行原始读数（`durationMs`，路径省略 `server/modules/` 前缀之外的部分）：

```
3643   auth/tests/auth-request-log.test.ts
8139   mcp-gateway/tests/mcp-audit-route.test.ts
5444   mcp-gateway/tests/mcp-draft.test.ts
5019   mcp-gateway/tests/mcp-english-only.test.ts
4936   mcp-gateway/tests/mcp-error-envelope.test.ts
4892   mcp-gateway/tests/mcp-error-vocabulary.test.ts
6721   mcp-gateway/tests/mcp-insufficient-scope.test.ts
3928   mcp-gateway/tests/mcp-invalid-argument.test.ts
6533   mcp-gateway/tests/mcp-not-found-semantics.test.ts
7791   mcp-gateway/tests/mcp-session-search.test.ts
3707   mcp-gateway/tests/mcp-tool-annotations.test.ts
3711   mcp-gateway/tests/mcp-ui-clients-list.test.ts
4843   mcp-gateway/tests/mcp-ui-focus-turn.test.ts
5584   mcp-gateway/tests/mcp-ui-last-opened.test.ts
5034   mcp-gateway/tests/mcp-ui-open-session.test.ts
4849   mcp-gateway/tests/mcp-ui-open-task.test.ts
4748   mcp-gateway/tests/mcp-ui-show-diff.test.ts
5118   mcp-gateway/tests/mcp-ui-visible-context.test.ts
6002   mcp-gateway/tests/mcp-write-notification.test.ts
1496   oauth/tests/oauth-request-log.test.ts
12668  providers/tests/claude-resident-merged-queued-turn.test.ts
913    session-hosts/tests/live-host-for-session.test.ts
841    static-assets/tests/service-worker-transient-failure.test.ts
2917   voice-realtime/tests/voice-realtime-bridge.false-forms.test.ts
3118   voice-realtime/tests/voice-realtime-bridge.test.ts
2580   voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts
3162   voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
1362   voice-realtime/tests/voice-realtime-uplink-vad.test.ts
1224   voice/tests/voice-sensevoice-adapter.test.ts
1152   voice/tests/voice-sensevoice-health.routes.test.ts
3841   voice/tests/voice-sensevoice-real.test.ts
2190   websocket/tests/ui-client-registry.test.ts
```

**(b) 6 行在任何 GREEN round 里都不存在**（对全部 709 个 `fail===0` round 逐 round 查 `perFile`，命中 0 次）⇒ 逐文件实测，一次一个，用 fan-in 车道自己那条命令；读数是 wall-clock ms（`date +%s%3N` 前后夹取）：

命令：`env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test <file>`

```
4611  server/modules/providers/tests/session-creation-selection.test.ts          rc=0
3317  server/modules/providers/tests/session-selection-launch-spec.test.ts       rc=0
3195  server/modules/voice-realtime/tests/voice-realtime-browser-keepalive.test.ts    rc=0
3166  server/modules/voice-realtime/tests/voice-realtime-queue-reconcile-poll.test.ts  rc=0
3025  server/modules/voice-realtime/tests/voice-realtime-unclaimed-utterance-relay.test.ts rc=0
1140  server/modules/voice-realtime/tests/voice-realtime-uplink-vad-hold-open.test.ts  rc=0
```

六条全部 `rc=0`。这 6 个文件在 develop 上从未进过任何记为绿的 round，所以没有台账读数可引用——与文件头里「measured one file at a time」那一段同一处理法（先例 `ee1a62fa5` 也是这个形状）。

文件头（`scripts/suite-duration-baseline.tsv` 第 122 行起）同步改写了来源段：写明这 32 行取自 round 1129、那 6 行是 2026-10-15 逐文件实测，并把「本文件覆盖 298/330」改成「336/336」。

## Notes

**2026-10-15 第二轮（worker 本回合直跑读数）— park needs-human：本任务已做完且已复验，但无法机械落地**

### 1. 本任务自身：实现与两条 AC 全部满足（本轮**重新**验证，不是继承上一轮读数）

- **AC1**：在 worktree 内逐字跑 AC 那条命令 ⇒ **EXIT=0**，`ℹ tests 14 / pass 14 / fail 0 / duration_ms 69649`，14 条逐条 ✔（含 AC7 `336/336`、AC2、AC3）。
- **AC2**：新增行的时长来源与原始读数已在上面 Evidence 逐行写明（32 行取自 green round 1129 的 `perFile`；6 行 2026-10-15 逐文件实测，`rc=0`）。
- **Touches 自检**：`anti-drift-touches-check … --merge-target develop` ⇒ `ANTI-DRIFT OK — 2 actual file(s), all within declared Touches (3 glob(s))`；`git diff --stat develop...HEAD` = 恰好这 2 个代码文件。
- 已 `git merge --no-edit develop`（无冲突，仅带入 driver 的 `## Blocker` 段，故无 unmerged path）。

### 2. 卡住 fan-in 的那条红**不是**本任务的 delta（字节级证明）

`server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts`

| 读数（本轮实测） | 值 | 退出码 |
|---|---|---|
| worktree standalone | `customTitles=["AC171 Title 144850fe","AC171 Later 144850fe"]` | `EXIT=1` |
| develop 主检出 standalone | `customTitles=["AC171 Title b993f04e","AC171 Later b993f04e"]` | `EXIT=1` |
| `git diff develop task/gap-baseline-red-suite-count-pins-336 -- <该文件>` | 空 ⇒ 与 develop **逐字节相同** | — |

⇒ develop 自身的红（外部 CLI 行为漂移），不是本分支引入的。它**已有主**：`gap-baseline-red-claude-peer-name-freeze-leg-cli-drift`（`ready`，两条 AC 均已勾，修复在其分支上、尚未落地）。本任务 DoD 也已把它显式划归该兄弟任务。

### 3. 为什么「只 exit」＝无限重派（读的是 driver 源码，不是推断）

- `.quay/worker-outcome.jsonl`（ts `2026-10-15T01:45:02.799Z`）本任务的 `baselineEquivalence.verdict`：`added: []`，`changed` 两条都指向该文件。第一条 `taskText: ""`（全量日志版式：`__PERFILE__ … passed=false` 在**第 26 行**、`not ok -` 在**第 562 行**，远超 marker 的 8 行窗口）；第二条两侧只差**每次运行都变的随机后缀**（基线 `66994a0d` vs 任务 `50bdccde`）。
- `worker-driver.js:56626` `compareFailureSignatures`：`changed.length > 0` 直接返回 `hard-red / changed-assertion`；唯一能放行的 `kind:"exempt"` 分支要求签名 key **逐字全等**，故**不可达**。
- `worker-driver.js:56659` `decideBaselineRedCircuitBreaker`：`consecutive` 仅在 `same[i].signature === current.signature` 时递增，而 signature 内嵌上面那个随机后缀 ⇒ `consecutive` 恒为 1 ⇒ **cap 永不触发** ⇒ driver 自己那段「LOOP DEADLOCK … land ANY ONE of them first」的诊断**永远打不出来**。⇒ exit 不会有下一轮的好结果，只会每轮烧一个 session。

### 4. 本任务与兄弟任务互为 landing gate（同一假阳性的镜像）

develop 上**本任务所修的那个文件**仍是红的，且其 AC2/AC3 断言消息里带随机临时路径（本轮主检出读数：`source=/tmp/quay-ac2-nYyAbP/baseline.tsv known=3 unknown=333`、`source=/tmp/quay-ac3-FdtPtA/valid.tsv known=1 unknown=335`）。⇒ 兄弟任务的 suite 里唯一那条红就是本文件，签名同样带运行期变量 ⇒ 它同样判 `changed-assertion` HARD RED。**各自的修复都落在对方的阻塞集里，谁也落不了地**。

### 5. 收口三选一（需人裁定）

1. **直接落地任一条分支** —— driver 自己的建议就是这条（「land ANY ONE of them first」）。本分支已核验：AC1 绿 14/14、anti-drift 干净、diff 恰为 2 个已声明代码文件。落地本分支 ⇒ develop 的 `quay-test-script` 转绿 ⇒ 兄弟任务阻塞集少一个红点 ⇒ 兄弟转而落地。手工落地程序见记忆 `needs-human-task-branch-manual-landing-recipe`（worktree 内 merge develop → 主检出 `--ff-only <分支>` → `git push . author:develop`）。
2. **给 driver 的签名取法做归一化**（比较前剥掉 `/tmp/<name>-<rand>/`、`Title <hex>` 这类运行期变量）—— 在 quay dist 里，不在本仓库。
3. **人裁定 complete**。

⛔ 未放宽任何门：没有为了过门改断言、没有加 skip、没动 `scripts/test.sh`。
