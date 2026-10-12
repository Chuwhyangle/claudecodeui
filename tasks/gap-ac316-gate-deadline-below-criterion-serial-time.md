---
id: gap-ac316-gate-deadline-below-criterion-serial-time
title: AC-316 判据串行 102s 高于 goal gate 默认 60000ms ⇒ 今日 17 轮连续
  not-evaluated(timeout)：在 AC-316 记录声明 timeoutMs（< driver 12e4 硬闸）使闸可判
status: todo
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

- [ ] AC1（记录声明）`goals/AC-316-<slug>.md` 的 frontmatter 声明 `timeoutMs`（正整数毫秒），其值 > 判据实测串行墙钟且 < 120000；记录其余字段（`id`/`title`/`status`/`kind`/`goal`/`criterion`/`expect`/`origin`/`activatedAt`/`statusLog`/`supersedes`）与改动前逐字节相同。机械判据：`git diff -- goals/` 的增删行只有 `+timeoutMs:` 一行；`quay goal show AC-316 --json` 读回的 `timeoutMs` 等于声明值。
- [ ] AC2（三条腿都不弱化）判据的三条命令各自 exit 0，用例数与改动前逐字相同：CMD1 `11 passed`（0 failed、0 did not run）、CMD2 `ℹ pass 19 / ℹ fail 0`、CMD3 `1 passed`；各记 wall time，串行合计墙钟写进 Evidence。
- [ ] AC3（闸可判）`quay goal gate AC-316 --dry-run --root <工作树>` exit 0，stdout JSON 满足 `verdict == "pass"`、`cause == null`、`timeoutMs == <声明值>`。原文贴 Evidence。
- [ ] AC4（取假形态，现场红后还原）删掉记录的 `timeoutMs`（回到默认 60000，且未设 `QUAY_ACCEPTANCE_TIMEOUT_MS`）后，同一 `quay goal gate AC-316 --dry-run --root <工作树>` 报 `verdict == "not-evaluated"` 且 `cause == "timeout"`（exit 1，reason 含 `timed out after 60000ms`）；加回后同命令 exit 0。红/绿两组原文都留档。
- [ ] AC5（余量与负载，二选一，须给机械读数）(i) 若不动 floor：声明值 ≥ 实测串行墙钟 × 1.10（即 ≥112200ms），且给出一次**带 lane 负载**（驱动同时在跑套件，或并发一次 e2e）下判据链仍 exit 0 的读数，证明声明值覆盖负载上界而非仅静默值；或 (ii) 若压 floor：给出改前/改后逐腿墙钟，使 `声明值 ≥ 改后串行墙钟 × 1.25`。任一分支都必须把「声明值 / floor / 余量百分比」三个数字写进 Evidence。
- [ ] AC6（隔离性）`git diff --stat develop HEAD`（落地树相对 develop）恰好只有 `goals/AC-316-<slug>.md` 与 `tasks/gap-ac316-gate-deadline-below-criterion-serial-time.md`，以及在判定为机制 (a) 时追加的 `playwright.config.ts`；`goals/` 下其它记录 `git diff` 为空。

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