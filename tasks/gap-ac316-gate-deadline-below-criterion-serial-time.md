---
id: gap-ac316-gate-deadline-below-criterion-serial-time
title: AC-316 判据串行 102s 高于 goal gate 默认 60000ms ⇒ 今日 17 轮连续
  not-evaluated(timeout)：在 AC-316 记录声明 timeoutMs（< driver 12e4 硬闸）使闸可判
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-316
---
## Proposal

（去重 / 粒度）<!-- dedup-ref --> 声明 `goal_ac: AC-316` 的两个任务 `gap-live-voice-exclusive-mode-fixed-bar` 与 `gap-ac316-restore-criterion-two-regressions` 都已是 `done`，无 todo/ready/needs-human 任务声明该 AC ⇒ 本任务为新案，非重复。`task-granularity-advice --touches goals/AC-316-<slug>.md --touches playwright.config.ts --json`：`peers[]` 为 `gap-live-voice-replay-local-egress-guard(todo)` 与 `gap-live-voice-segmented-replay-closure(todo)`，两者**只**与 `playwright.config.ts` 重叠（本任务只在必要时碰它），不同机制 ⇒ **separate**；`task-granularity-advice --touches goals/AC-316-<slug>.md` 单独跑为 `peers: []`。

### 现象（2026-10-12 本轮直接重跑判据，不是台账尾巴）

判据链在本轮实测**逐腿全绿**（本仓主检出 `/data/home/yale/work/claudecodeui`，HEAD `903bf37a`）：

| 腿 | 命令 | 读数 | 墙钟 |
|---|---|---|---|
| CMD1 | `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts` | `11 passed`，0 failed，0 did not run | 78s（1.3m） |
| CMD2 | `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` | `ℹ tests 19 / ℹ pass 19 / ℹ fail 0` | ≈3s |
| CMD3 | `npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` | `1 passed` | 17s |

链式合跑（判据逐字、`bash scripts/with-memory-cap.sh bash -c '<原判据>'`）：**`CHAIN_EXIT=0  ELAPSED=102s`**。

即 **AC-316 的实质内容成立**，红灯不来自被测功能。红灯来自闸的预算：

- 账本（`.quay/gate-events.jsonl`）里 AC-316 在 **2026-10-12 07:24:30 → 10:18:52 之间连续 17 条 `not-evaluated`**，`cause: timeout`，reason 逐字为 `acceptance timed out after 60000ms (killed) — set the record's timeoutMs or QUAY_ACCEPTANCE_TIMEOUT_MS`，落在 17 个**互不相同**的 treeSha 上 —— 每一轮都真的在跑，每一轮都被 60s 杀掉。同一段窗口里另有一条 `fail`（10:30:26，tree `c55a7293` = 当前 HEAD 的树）。
- 上限来源：`resolveAcceptanceTimeout(recordTimeoutMs, env)` 的次序是 `record.timeoutMs → QUAY_ACCEPTANCE_TIMEOUT_MS → DEFAULT_ACCEPTANCE_TIMEOUT_MS`。安装版 quay 0.19.0 实测 `grep -roh 'DEFAULT_ACCEPTANCE_TIMEOUT_MS *= *[0-9e_]*' scripts/dist` → `6e4`。**AC-316 记录没有 `timeoutMs`**，且 `.quay/anchor.json` 显示 anchor 于 **2026-10-12T08:37:19Z 重启**，其 `/proc/<anchor-pid>/environ` 里**没有** `QUAY_ACCEPTANCE_TIMEOUT_MS`（只有 `QUAY_ANCHOR_ENVELOPE_SOURCE`）⇒ 上限恒为 60000ms < 判据 102s 的串行墙钟 ⇒ **闸结构性地判不出 pass**。
- 同族先例：`gap-ac323-gate-deadline-below-criterion-serial-time`（AC-323，floor 86s）已被同一机制红过，治法是在记录里写 `timeoutMs: 115000` 并落地。AC-316 与它同属 GOAL-033 的语音族，但**这一行至今没人在 AC-316 上补**。

### 为什么上一次修复没挺住（本任务要填的缺口）

前两个 AC-316 任务的 `## Touches` **都不含 `goals/AC-316-*.md`**：`gap-live-voice-exclusive-mode-fixed-bar` 列 `src/`、`server/`、`e2e/`、`tasks/`；`gap-ac316-restore-criterion-two-regressions` 列 `src/`、`e2e/`、`tasks/`。anti-drift 要求落地 diff ⊆ Touches，于是「给记录加一行 `timeoutMs`」两轮都被明文排除在 Touches 之外 —— **它们修的是判据的内容（互斥渲染、固定栏、两根因回归），没人修判据的可判性**。AC-323 那边同一个缺口正是被 `gap-ac323-gate-deadline-below-criterion-serial-time` 补上的。本任务把 `goals/AC-316-<slug>.md` 纳入 Touches。

### 本任务要做的

1. **在 `goals/AC-316-<slug>.md` 的 frontmatter 声明 `timeoutMs`**（正整数毫秒）：取值 **> 判据实测串行墙钟** 且 **< 120000**。上限来源：goal driver 的 `gateCriterion` 用 `CRITERION_TIMEOUT_MS = 12e4` spawn `quay goal gate`（安装版 0.19.0 实测该字面量仍在，无 env/字段通道）；声明 ≥120000 只会让 driver 先 SIGKILL 掉 spawn，闸写不出 verdict（memory `goal-criterion-deadline-record-timeoutms-wins`）。
2. **直面余量算术**：实测 floor **102s**，可行区间只有 `102000–120000`（最大余量 ≈15%，取 118000 时 ≈15.7%）。memory 的「留 ≥30% 余量」在本仓的 120s 硬闸下**不可达**——这一点必须写进 Evidence 的诚实说明，而不是默默取一个小值。作者可二选一：(i) 在区间内取最大安全值（≈118000）并记录残余风险；(ii) 真正压低链的 floor（改前/改后逐腿读数）以换取 ≥25% 余量。**二者都不是「收窄判据」**——命令集与用例集必须逐字不变（见边界）。
3. **用闸自己复验**：`quay goal gate AC-316 --dry-run --root <工作树>` 在声明值下 exit 0、`verdict == "pass"`；`--dry-run` 真跑判据但不写 `.quay/`，故不依赖工作树里有没有 `.quay/`（memory `quay-goal-gate-dry-run-does-not-write-the-ledger`）。

### 关于 10:30:26 那条 `fail (exit 1)`（给作者的线索，不是结论）

该轮 `payload.reason` 里 WebServer 的 boot 行落在 `10:29:34.956Z`/`10:29:45.186Z`、事件时间 `10:30:26.113Z` ⇒ 该轮总时长 ≈52s。两种机制都与这个读数相容，作者应在负载下复跑时**判定是哪一种并记录**：(a) 该轮闸被给了抬高的预算，CMD1 在 lane 负载下越过 `playwright.config.ts` 自身的看门狗上限（两个 spec 都未声明 `SPEC_BUDGET_MS` ⇒ 该选择 `RUN_CEILING_MS = 2 × SINGLE_SPEC_CEILING_MS(55_000) = 110000ms`；CMD1 静默 78s），被按「crossed its own ceiling」结束 ⇒ 链 exit 1；(b) 60s 预算下某用例在负载中失败（如 reload 后等待超时）。若判定为 (a)，则**光声明 `timeoutMs` 不够**：声明值 118000 会把失败形态从 `not-evaluated(timeout)` 换成负载下的 `fail(exit 1)`，此时须一并抬高该两文件的 `SPEC_BUDGET_MS`，使 `RUN_CEILING_MS` 落在「高于负载下 CMD1 实测、低于 120000」之间，并把 `playwright.config.ts` 写进 Touches。

### 边界 / 不做

- ⛔ **不改判据文本**（`criterion` / `expect` 一个字都不动）。`expect` 第四段明文要求第三条命令（AC-120）留在链里、第二条命令的协议模拟保 5 场景 —— 收窄命令集等于削弱测量面（memory `ac-wallclock-bound-below-a-mandated-floor-is-unsatisfiable` 的「do not optimise the criterion to fit」）。
- ⛔ 不改任何 voice-realtime 的 spec 断言、产品代码、`server/` 代码；三支腿的用例集逐字不变（CMD1 11 例、CMD2 19 例、CMD3 1 例）。
- ⛔ 不碰其它 goal 记录（AC-317 等逐字节不变）。
- 不靠「重设 anchor 的 `QUAY_ACCEPTANCE_TIMEOUT_MS`」解决：那是 operator 侧的环境而非仓里的修复，anchor 下次重启又回到 60000（memory `goal-gate-inherits-sweep-env-and-driver-kills-it-at-120s`）。

## AC

- [x] AC1（记录声明）`goals/AC-316-<slug>.md` 的 frontmatter 声明 `timeoutMs`（正整数毫秒），其值 > 判据实测串行墙钟且 < 120000；记录其余字段（`id`/`title`/`status`/`kind`/`goal`/`criterion`/`expect`/`origin`/`activatedAt`/`statusLog`/`supersedes`）与改动前逐字节相同。机械判据：`git diff -- goals/` 的增删行只有 `+timeoutMs:` 一行；`quay goal show AC-316 --json` 读回的 `timeoutMs` 等于声明值。
- [x] AC2（三条腿都不弱化）判据的三条命令各自 exit 0，用例数与改动前逐字相同：CMD1 `11 passed`（0 failed、0 did not run）、CMD2 `ℹ pass 19 / ℹ fail 0`、CMD3 `1 passed`；各记 wall time，串行合计墙钟写进 Evidence。
- [x] AC3（闸可判）`quay goal gate AC-316 --dry-run --root <工作树>` exit 0，stdout JSON 满足 `verdict == "pass"`、`cause == null`、`timeoutMs == <声明值>`。原文贴 Evidence。
- [x] AC4（取假形态，现场红后还原）删掉记录的 `timeoutMs`（回到默认 60000，且未设 `QUAY_ACCEPTANCE_TIMEOUT_MS`）后，同一 `quay goal gate AC-316 --dry-run --root <工作树>` 报 `verdict == "not-evaluated"` 且 `cause == "timeout"`（exit 1，reason 含 `timed out after 60000ms`）；加回后同命令 exit 0。红/绿两组原文都留档。
- [x] AC5（余量与负载，二选一，须给机械读数）(i) 若不动 floor：声明值 ≥ 实测串行墙钟 × 1.10（即 ≥112200ms），且给出一次**带 lane 负载**（驱动同时在跑套件，或并发一次 e2e）下判据链仍 exit 0 的读数，证明声明值覆盖负载上界而非仅静默值；或 (ii) 若压 floor：给出改前/改后逐腿墙钟，使 `声明值 ≥ 改后串行墙钟 × 1.25`。任一分支都必须把「声明值 / floor / 余量百分比」三个数字写进 Evidence。
- [x] AC6（隔离性）`git diff --stat develop HEAD`（落地树相对 develop）恰好只有 `goals/AC-316-<slug>.md` 与 `tasks/gap-ac316-gate-deadline-below-criterion-serial-time.md`，以及在判定为机制 (a) 时追加的 `playwright.config.ts`；`goals/` 下其它记录 `git diff` 为空。

## DoD

- 真实跑 `quay goal gate AC-316`（**非** `--dry-run`；判据是真浏览器 + 真 WebSocket 服务端、102s 串行）拿到 `verdict: "pass"` 的 GateEvent（在带可写 `.quay/` 的根上 —— 合并后的主检出；工作树内以 `--dry-run` 的 exit 0 作为落地前读数），留下该条原文与它的 `treeSha`。不是「记录里多了一行」——是闸真的跑完判据并写出 pass。
- 三条判据命令各跑一次，记 wall time 与 exit code（CMD1 贴 `11 passed (…)` 形状的原文，CMD2 贴 `ℹ pass 19 / ℹ fail 0`，CMD3 贴 `1 passed (…)`）。
- 假形态（删 `timeoutMs` ⇒ 60s 默认）红、还原绿，原始输出留档。
- Evidence 记明：(a) 声明值、实测 floor（102s）与余量百分比；(b) 上限 120000 的来源（安装版 0.19.0 的 `CRITERION_TIMEOUT_MS = 12e4`）与声明值必须 < 它的理由；(c) 前两个 AC-316 任务为何改不了这一行（Touches 不含 `goals/`）；(d) **诚实说明**：memory `goal-criterion-deadline-record-timeoutms-wins` 的 ≥30% 余量指引在 102s floor + 120s 硬闸下不可达，本任务取区间内的最大安全值（或压 floor 换取余量），并写明残余风险（lane 负载下 CMD1 越界时的失败形态）；(e) 10:30:26 那条 `fail` 被判定为机制 (a) 还是 (b)，依据是什么。

## Touches

- goals/AC-316-live-voice-与-chat-composer-互斥-固定紧凑底部采集栏-持续采集直到-mute-end-隐藏旧.md
- playwright.config.ts（仅当 10:30 的 `fail(exit 1)` 被判定为机制 (a)、须抬高该两文件的 `SPEC_BUDGET_MS` 时才碰；否则不改）
- tasks/gap-ac316-gate-deadline-below-criterion-serial-time.md（self）

## Notes

立项：gap-filing（AC-316 离开 reverify scope 后，账本把它记成当前为假）。本轮在**本仓主检出**上直接重跑了判据链全文（逐腿 + 链式合跑，`CHAIN_EXIT=0 ELAPSED=102s`），并核实了记录字段、anchor 重启时间与其 environ、安装版 quay 的两个常量、以及 2026-10-12 全天的 gate-events —— 故本任务是由直接测量得出的「判据不可判」，不是台账尾巴继承，也不是被测功能回归。

## Evidence

### 落地物（AC1）

工作树 `/data/home/yale/work/claudecodeui-worktrees/gap-ac316-gate-deadline-below-criterion-serial-time`
（分支 `task/gap-ac316-gate-deadline-below-criterion-serial-time`，从 `develop` 分叉，`dispatch-worktree-setup.sh`
provision 过）。`goals/AC-316-…-隐藏旧.md` 的 frontmatter 尾部加一行，`git diff -- goals/` 的增删行**只有它**
（`1 file changed, 1 insertion(+), 0 deletions`），记录其余字段（`id`/`title`/`status`/`kind`/`goal`/`criterion`/
`expect`/`origin`/`activatedAt`/`statusLog`/`supersedes`）逐字节未动：

```
@@ -48,4 +48,5 @@ statusLog:
     reason: "I2: criterion pass"
 supersedes:
   - AC-312
+timeoutMs: 118000
 ---
```

读回走与 `quay goal gate` 同一个 goal 目录解析的 store 方言（`quay goal show --root` 走 provider ABI 的
`QUAY_NATIVE_GOAL_DIR`，被 `.quay/config.yml` 钉成主检出，分支落地前读的是旧记录 —— 见 AC-323 先例同款说明）：

```
$ quay goal get AC-316 --json --store --root <工作树> | grep timeoutMs
  "timeoutMs": 118000,
```

提交 `5423a03f fix(goals): declare AC-316 timeoutMs above its serial criterion wallclock`
（commitlint conventional 头，任务 id 在 body 里）。

### AC2 三条腿（工作树内逐腿，`bash scripts/with-memory-cap.sh` 包一层）

| 腿 | 命令 | 命令自身读数 | exit | wall |
|---|---|---|---|---|
| CMD1 | `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts` | `11 passed (1.3m)`（0 failed / 0 did not run） | 0 | 80232ms |
| CMD2 | `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` | `ℹ tests 19 / ℹ pass 19 / ℹ fail 0` | 0 | 2180ms |
| CMD3 | `npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` | `1 passed (14.9s)` | 0 | 15792ms |
| **串行合计（floor）** | | | **0** | **98204ms** |

用例集逐字不变：CMD1 11 例、CMD2 19 例、CMD3 1 例。判据文本（`criterion`/`expect`）、任何 spec、任何
产品代码、任何其它 goal 记录均未动。

### (a) 声明值 / floor / 余量百分比

- 声明值 **118000ms**；本轮实测串行 floor **98204ms**（proposal 记的历史 floor 102s 同量级，闸端到端
  读数 95.8–99.3s）。
- 余量：`(118000 − 98204) / 118000 = 16.8%`（对 deadline）；对 floor 的倍数 `118000 / 98204 = 1.201×`。
- 满足 AC5(i) 的机械门槛：`118000 ≥ 98204 × 1.10 = 108024`，也 ≥ AC 字面的 `112200`。

### (b) 上限 120000 的来源，以及声明值为何必须严格小于它

闸自己的 deadline 由 `resolveAcceptanceTimeout(recordTimeoutMs, env)` 决定
（安装版 `scripts/dist/goal-driver.js:40135` 的 `quay goal gate` 路径读 `rec.timeoutMs`；
`resolveAcceptanceTimeout` 在 `:37744`）：`record.timeoutMs → QUAY_ACCEPTANCE_TIMEOUT_MS → 6e4`。
驱动侧另有一道更外的闸：goal driver 用 `CRITERION_TIMEOUT_MS = 12e4` **spawn** `quay goal gate <id>`
（`goal-driver.js` `gateCriterion()`），超时 `child.kill("SIGKILL")` 并记成 `not-evaluated` + 闸风
`spawn timeout`。⇒ **声明值 ≥120000 只会让 driver 先杀 spawn，拿到的是 driver 的 not-evaluated(spawn)**，
闸仍永远判不出 pass。取 **118000** 而非贴 120000，是要给闸在判 timeout 之后**自己写出 verdict** 留时间。

### (c) 为什么前两个任务改不了这一行

`gap-live-voice-exclusive-mode-fixed-bar` 与 `gap-ac316-restore-criterion-two-regressions` 的 `## Touches`
都**不含** `goals/AC-316-*.md`（见本任务 Proposal 的逐条列举）。anti-drift 要求落地 diff ⊆ Touches，所以
「给记录加一行 `timeoutMs`」正是被明文挡在门外的那个改动。本任务把该文件纳入 `## Touches` 后落地，填上缺口
（与 AC-323 被 `gap-ac323-gate-deadline-below-criterion-serial-time` 补齐的缺口同形）。

### AC3 原文（`--dry-run`，均 exit 0）—— 三棵树的连续复跑

判据输入是三条命令（真浏览器 + 真 WS 服务端），故每换一棵树就复跑一次；三棵树都 pass：

**树 1（本分支，未合并 develop）**：

```
$ quay goal gate AC-316 --dry-run --root <工作树>        # exit 0, wall 96906ms
{
  "id": "AC-316",
  "verdict": "pass",
  "cause": null,
  "reason": "acceptance passed (exit 0)",
  "timeoutMs": 118000,
  "timestamp": "2026-10-12T10:45:17.859Z",
  "dryRun": true,
  "event": { ..., "payload": { "reason": "acceptance passed (exit 0)",
    "evaluationRoot": "<工作树>", "treeSha": "9ec645e2792488c9000bd4bbfbdb063cd9d5e945" } }
}
```

**树 2（首次 `git merge --no-edit develop`，merge commit `6a74aab1`）** —— fan-in 真正评估的那棵树；
该合并带进了 develop 对 voice-realtime 模块的改动（`voice-realtime-bridge.service.ts`、
`-dashscope-transport.ts`、`-diagnose.service.ts`，新增 `voice-realtime-manual-vad-session-update.test.ts`
等 9 文件）⇒ **不继承树 1 的绿**，故重跑：

```
$ quay goal gate AC-316 --dry-run --root <工作树>        # exit 0, wall 95835ms
  "verdict": "pass", "cause": null, "timeoutMs": 118000,
  "treeSha": "a187440833e9f0c243001b5f484852b9570b5b13"
```

**树 3（本轮最终落地树：再次合并 develop 吸收了它中途的两笔推进，merge commit `e0023cee`）**：develop 在本轮
途中从 `4b926182` 推进到 `b0651eda`（详见 AC6），故再合一次并复跑：

```
$ quay goal gate AC-316 --dry-run --root <工作树>        # exit 0, wall 96922ms
{
  "id": "AC-316",
  "verdict": "pass",
  "cause": null,
  "reason": "acceptance passed (exit 0)",
  "timeoutMs": 118000,
  "timestamp": "2026-10-12T10:59:38.001Z",
  "dryRun": true,
  "event": { "id": "9f8ef87d-3583-40dd-9d06-ee53b66a4c63", "item_id": "AC-316",
    "gate": "goal", "actor": "goal-cli", "verdict": "pass",
    "payload": { "reason": "acceptance passed (exit 0)",
      "evaluationRoot": "<工作树>", "treeSha": "6fb40ec1f4a0aad7bd5b86a587e9de313c6d55df" } }
}
```

树 3 的 `treeSha` 与 `git rev-parse HEAD^{tree}` 逐字相等（`6fb40ec1f4a0aad7bd5b86a587e9de313c6d55df`），
即读的确是本分支自身的树。三次 `verdict == "pass"`、`cause == null`、`timeoutMs == 118000`。

### AC4 假形态（删 `timeoutMs` ⇒ 默认 60000）红、还原绿

红（删掉 `timeoutMs`，且确认 `QUAY_ACCEPTANCE_TIMEOUT_MS` 未设）：

```
$ env -u QUAY_ACCEPTANCE_TIMEOUT_MS quay goal gate AC-316 --dry-run --root <工作树>
exit 1, wall 60253ms
{
  "id": "AC-316",
  "verdict": "not-evaluated",
  "cause": "timeout",
  "reason": "not-evaluated (timeout): acceptance timed out after 60000ms (killed) — set the record's `timeoutMs` or QUAY_ACCEPTANCE_TIMEOUT_MS",
  "timeoutMs": 60000,
  "dryRun": true,
  "event": { ..., "payload": { "cause": "timeout", "reason": "…after 60000ms…" } }
}
```

绿（还原 `timeoutMs: 118000` 后同命令）：

```
$ quay goal gate AC-316 --dry-run --root <工作树>        # exit 0, wall 95869ms
  "verdict": "pass", "cause": null, "timeoutMs": 118000
```

两组原文都留档在 `/tmp/ac316-gate-fake.json` / `/tmp/ac316-gate-restored.json`（会话内临时文件）。

### AC5(i) 带 lane 负载的读数

构造：**3 条连续 sibling e2e lane**，每条循环跑完整 `npx playwright test e2e/voice-trim.spec.ts`
（每条自身读数 `1 passed (14.0s)` 量级），全程覆盖闸窗口；每秒采 `/proc/loadavg`。

| 读数 | 值 |
|---|---|
| loadavg 采样窗口内 min / max（field1） | 20.71 / **35.73**（闸开始前静默态 13.94） |
| `quay goal gate AC-316 --dry-run --root <工作树>` | **exit 0**，wall **99320ms**，`verdict: "pass"`，`cause: null`，`timeoutMs: 118000` |

⇒ 负载下判据链仍 exit 0，且端到端 99320ms < 声明值 118000ms（余量 18680ms）。**声明值 / floor / 余量百分比
= 118000 / 98204 / 16.8%**。

### AC6 隔离性

`develop` 在本轮**中途推进过**（`4b926182` → `693855c6 goals: AC-353 status active→achieved` →
`b0651eda tasks: gap-ac316-… task_write by cli:285239`）。这使第一次查 diff 时冒出两个**非本任务**的文件：

- **`goals/AC-353-…turn-detection-null-上.md`**：develop 的 `693855c6` 把它从 `status: active` 翻成 `achieved`，
  而本分支的分叉点在它之前 ⇒ `git diff develop HEAD` 把它显示成「本分支反向把 achieved 改回 active」。
  **本分支从未碰过该文件**——这是 memory `develop-tip-advances-during-a-worker-round` 的经典形态，不是本任务的改动。
- **`tasks/gap-ac316-…md`**：`task_write` 把 body 提交到了 develop 的 store 分支（memory
  `task-write-commits-to-the-store-branch-not-the-worktree`），落在 `b0651eda`，故首次查 diff 时它也在 develop 里。

按 memory 的做法**再次 `git merge --no-edit develop`**（merge commit `e0023cee`，无冲突）吸收这两笔后，隔离性干净：

```
$ git diff --stat develop HEAD                      # 本分支相对 develop 的落地 diff
 …-mute-end-隐藏旧.md | 1 +
 1 file changed, 1 insertion(+)

$ git diff --name-only develop HEAD -- goals/       # goals/ 下其它记录：空
（无输出）

$ git diff develop HEAD -- 'goals/AC-316*'
@@ -48,4 +48,5 @@ statusLog:
     reason: "I2: criterion pass"
 supersedes:
   - AC-312
+timeoutMs: 118000
 ---
```

⇒ 落地 diff 只有 `goals/AC-316-…-隐藏旧.md` 一行 `+timeoutMs: 118000`；本任务文件因 `task_write` 已把同一 body
提交进 develop 而不再单独出现在 diff 里（这正是 AC6 允许的 `tasks/<id>.md` 那个元素）；`goals/` 下其它记录
逐字节相同；`playwright.config.ts` **未改**（理由见 (e)）。工作树 `git status --porcelain` 干净。

### DoD：非 dry-run 的真实闸 + GateEvent 原文

```
$ quay goal gate AC-316 --root <工作树>                  # exit 0, wall 95341ms（树 2：已合并 develop，treeSha a1874408）
{
  "id": "AC-316",
  "verdict": "pass",
  "cause": null,
  "reason": "acceptance passed (exit 0)",
  "timeoutMs": 118000,
  "timestamp": "2026-10-12T10:55:54.317Z",
  "dryRun": false,
  "event": { ..., "payload": { "reason": "acceptance passed (exit 0)",
    "evaluationRoot": "<工作树>", "treeSha": "a187440833e9f0c243001b5f484852b9570b5b13" } }
}
```

GateEvent 落在 `<工作树>/.quay/gate-events.jsonl`（`.gitignore:155` 的 `.quay/*` 忽略它，`git status` 干净）：

```
{"id":"a397e252-…","item_id":"AC-316","gate":"goal","actor":"goal-cli","verdict":"pass",
 "timestamp":"2026-10-12T10:55:54.317Z","payload":{"reason":"acceptance passed (exit 0)",
 "evaluationRoot":"<工作树>","treeSha":"a187440833e9f0c243001b5f484852b9570b5b13"}}
```

⚠️ 时序如实记：真实（非 dry-run）闸跑在**工作树**（`.quay/` 可写），treeSha `a1874408…`（树 2）。此后 develop
又推进、本分支再合一次成**树 3**（`e0023cee`，treeSha `6fb40ec1…`），对树 3 复跑了 `--dry-run`（AC3 树 3：
exit 0 / pass）。树 2→树 3 的输入差异只有 develop 的两笔**非相关**提交（AC-353 的 `status` 字段 + 本任务
task_write 的 body），不触及 `criterion`/`expect`/任何 spec/任何产品代码，故树 3 的 pass 不可能被这两笔翻转；
fan-in 收口跑在合并后的主检出（worktree 不落 develop），其 pass 由 fan-in 的机械流程给出。

### (d) 诚实说明：≥30% 余量在本仓不可达，残余风险

memory `goal-criterion-deadline-record-timeoutms-wins` 的「留 ≥30% 余量」指引，在 **floor 98204ms + 硬闸
120000ms** 下**structurally 不可达**：可行区间 98204–120000ms 的最大余量就是 `(120000−98204)/120000 = 18.2%`，
乘以 1.30 需要 floor ≤ 92308ms。本任务**不动 floor**（判据命令集与用例集逐字不变是硬边界 —— 收窄即削弱测量面
是 memory `ac-wallclock-bound-below-a-mandated-floor-is-unsatisfiable` 的明文禁止），故取区间内的**最大安全值
118000**（留 2000ms 给闸写 verdict），余量 16.8%。

残余风险（写明，不粉饰）：

1. **非 timeout 形态的红仍在**：声明值只把失败形态从 `not-evaluated(timeout)` 换成「闸真的跑完判据」。
   若 lane 负载把 CMD1 推到 >118s，闸仍会 timeout（形态回到 `not-evaluated(timeout)`，只是阈值从 60s 抬到 118s）。
2. **用例级瞬态红无法被 timeoutMs 治**：10:30:26 那条 `fail` 就是这种（见 (e)）；任何「预算」都治不了它，
   它是被测 UI 的瞬态采样在负载下错过。
3. **CMD1 自身的 RUN_CEILING_MS = 295000ms > 118000ms**：CMD1 的 spec 看门狗不会先于闸触发，所以被负载推到
   118s 时是**闸**杀它，形态是 timeout，而不是 spec 自报的「crossed its own ceiling」。这是可读性的损失，但
   不是本任务能改的面（须动 `playwright.config.ts` 的 `SPEC_BUDGET_MS`，见 (e) 判定为不改）。

### (e) 10:30:26 那条 `fail (exit 1)` 判定为机制 (b)

**判定：机制 (b)（预算内某用例在负载下失败），不是 (a)。** 依据两重：

1. **机制 (a) 的算式在本树被证伪。** proposal 猜「两个 spec 都未声明 `SPEC_BUDGET_MS` ⇒ RUN_CEILING_MS =
   2 × 55000 = 110000ms」。但失败树 `c55a7293` 的 `playwright.config.ts:388` **已有**
   `'voice-realtime-upload-fixture.spec.ts': 240_000`（提交 `5bbfb1e0`，2026-10-11 落地，是 develop 的祖先），
   而 `voice-realtime-live-session-send.spec.ts` **无** budget 键 ⇒ 该选择
   `RUN_CEILING_MS = 55000 + 240000 = 295000ms`，不是 110000ms。且该轮总时长 ≈52s，**远低于** 110000ms 与
   295000ms —— 任何看门狗上限都不可能结束那一轮。⇒ (a) 的两条前提（110000ms 上限、CMD1 静默 78s）都不成立。
2. **那条 `fail` 的现场产物还在，直接读出失败点。** 该轮 `dataDir` / artifact
   `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-5YpHcI/test-results/voice-realtime-upload-fixt-3571a-ng-up-then-the-real-message/error-context.md`
   逐字为：

   ```
   - Name: voice-realtime-upload-fixture.spec.ts >> the delivery wait is visible on the one row: heard, then tidying up, then the real message
   - Location: e2e/voice-realtime-upload-fixture.spec.ts:1401:3
   Error: expect(locator).toBeVisible() failed
   Locator: getByTestId('voice-row-delivering')
   Expected: visible  Timeout: 2000ms  Error: element(s) not found
   ```

   即**用例体内**的 2000ms 瞬态断言（「heard → tidying up → real message」中间态那一帧）在负载下没被采到 ——
   与 (b) 逐字吻合，`fail` 是 `verdictFromAcceptance(exit 1)` 的正常映射，不是看门狗结束。同一用例在本任务
   两个树的直跑里都过（CMD1 的第 9 例，5.0s）。

**因为判定为 (b)，`playwright.config.ts` 未改**（Touches 里那条「仅当 (a) 才碰」的条件不触发）。

**因为判定为 (b)，也是本任务选择 118000 而非更小值的另一条理由**：光把闸的预算抬到覆盖 floor，并不能消灭
用例级瞬态红；能消灭的是「闸结构性判不出 pass」这一条 —— 而那正是本任务的交付面。