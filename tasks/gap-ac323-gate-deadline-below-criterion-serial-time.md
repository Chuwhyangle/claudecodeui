---
id: gap-ac323-gate-deadline-below-criterion-serial-time
title: AC-323 判据串行 ≈86s 高于 goal gate 写死的 60000ms 默认上限 ⇒ 永远
  not-evaluated(timeout)：在 AC 记录声明 timeoutMs（< driver spawn 上限 12e4）使闸可判
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-323
---
## Proposal

（去重 / 粒度）<!-- dedup-ref --> 声明 `goal_ac: AC-323` 的两个任务 `gap-live-voice-composer-embedded-dual-entry` 与 `gap-live-voice-composer-embedded-acceptance-spec` 都已是 `done`，无 todo/ready/needs-human 任务声明该 AC ⇒ 本任务为新案，非重复。`task-granularity-advice --touches goals/AC-323-<slug>.md` 报 `peers: []`，无合并候选。

现状（2026-10-10 于 develop HEAD 3618bb0f 复核）：AC-323 记录里的 `criterion` 是三条命令的**串行**链

- CMD1 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts`
- CMD2 `npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime`
- CMD3 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "`

今天三条命令**各自 exit 0**（本任务复核实测：CMD1 `12 passed (45.4s)`、CMD2 `61 passed (3.8s)`、CMD3 `6 passed (36.9s)`，串行合计 ≈86s；既有读数在同量级：CMD1 52.3/59.2s、CMD3 26.0s、合计 83.71s）——即 AC-323 的**实质内容成立**，红灯不来自被测功能。

闸的上限来自 `resolveAcceptanceTimeout(rec.timeoutMs)`（goal gate 的运行器）：**record 的 `timeoutMs` → `QUAY_ACCEPTANCE_TIMEOUT_MS` → `DEFAULT_ACCEPTANCE_TIMEOUT_MS = 60000`**。AC-323 记录**没有 `timeoutMs`**，仓里也**没有 `.quay/gates.yml`**，所以上限恒为 60000ms < 判据的串行墙钟 ⇒ `quay goal gate AC-323` 每轮都被击杀在 60s，记成 `not-evaluated (timeout)`，AC 永远判不出 pass。账本（`.quay/gate-events.jsonl`）里 AC-323 有 9 条 `not-evaluated (timeout)`（reason 逐字为 `acceptance timed out after 60000ms (killed) — set the record's timeoutMs or QUAY_ACCEPTANCE_TIMEOUT_MS`，多条落在**同一个 treeSha** 上），另有 3 条 `fail`（冷缓存下 60s 内跑完、但兄弟 spec 的 375px reload 抖动）。这与 memory `ac-wallclock-bound-below-a-mandated-floor-is-unsatisfiable` 的「goal gate 自身 60000ms 上限压住一条只是很长的判据」同族。

为什么上一次修复没挺住：不是实现坏了（产品与三份 spec 都在、三条命令今天都 exit 0），而是前两个任务的 `## Touches` 都不含 `goals/AC-323-*.md`，而 anti-drift 要求落地 diff ⊆ Touches，于是「给记录加一行 `timeoutMs`」被明文留在 Touches 之外（见 `gap-live-voice-composer-embedded-acceptance-spec` 的 Evidence「遗留 / 风险」第 1 条，及其 `## DoD` 里 `quay goal gate AC-323` 无法报 0 的记录）。本任务把这一行纳入 Touches 后落地，填上那个缺口。

本任务要做的（一行数据改动 + 实测复验）：

1. 在 `goals/AC-323-<slug>.md` 的 frontmatter 声明 `timeoutMs`（正整数毫秒），取值 **> 判据实测串行墙钟（含冷缓存上界）** 且 **< 120000**。上限来源：goal driver 侧的 `gateCriterion` 用 `CRITERION_TIMEOUT_MS = 12e4` spawn `quay goal gate`；声明值 ≥120000 只会让 driver 先杀 spawn，得到 `not-evaluated(spawn)` 而非闸自己的 verdict。建议 ≈110000–118000，由实测决定。
2. 用 goal gate 自身复验：`quay goal gate AC-323 --dry-run --root <工作树>` 在该 deadline 下 exit 0、`verdict == "pass"`（`--dry-run` 会真跑判据但不写 `.quay/`，从而不依赖工作树里是否有 `.quay/`）。
3. 取假形态现场红再还原：把记录的 `timeoutMs` 删掉（回到默认 60000）后，同一 `quay goal gate AC-323 --dry-run` 报 `not-evaluated` / `timeout`（或 reason 含 `timed out after 60000ms`）；加回后同命令 exit 0。

## 边界 / 不做

- ⛔ 不改判据文本（`criterion` / `expect` 一个字都不动）、不改三个命令、不改任何 spec 或产品代码。依据 memory `ac-wallclock-bound-below-a-mandated-floor-is-unsatisfiable`：CMD2+CMD3 已 ≈30s，CMD1 要启真浏览器 + 真 WebSocket 服务端跑 12 例，「do not optimise the criterion to fit」——收窄判据等于削弱测量面。
- ⛔ 不动任何其它 goal 记录（AC-316 / AC-317 等逐字节不变）。
- 不做自动重连 / VAD / 分段中继，不依赖 GOAL-034。
- 不靠改 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 来「报出」绿——那是给 `-g` 选择的 spec 自身看门狗，压不到 goal gate 的 60000ms。

## AC

- [x] AC1 `goals/AC-323-<slug>.md` 的 frontmatter 声明 `timeoutMs`（正整数毫秒），其值 > 判据实测串行墙钟且 < 120000；记录其余字段（`id` / `title` / `status` / `kind` / `goal` / `criterion` / `expect` / `origin` / `activatedAt` / `statusLog` / `fidelity`）与改动前逐字节相同。机械判据：`git diff -- goals/` 的增删行只有 `+timeoutMs:` 一行；`quay goal show AC-323 --json` 的 `timeoutMs` 等于声明值。
- [x] AC2 `quay goal gate AC-323 --dry-run --root <工作树>` exit 0，stdout JSON 满足 `verdict == "pass"`、`cause == null`、`timeoutMs == <声明值>`。原文贴 Evidence。
- [x] AC3 三条判据命令各自 exit 0，且串行合计墙钟 < 声明值：CMD1 记 `12 passed`、CMD2 记 `61 passed`、CMD3 记 `6 passed`（数字可刷新，但三个 exit 0 与 `合计 < timeoutMs` 必须成立；各记 wall time）。
- [x] AC4 取假形态现场红再还原：删掉记录的 `timeoutMs`（默认 60000，且未设 `QUAY_ACCEPTANCE_TIMEOUT_MS`）后，同一 `quay goal gate AC-323 --dry-run --root <工作树>` 报 `verdict == "not-evaluated"` 且 `cause == "timeout"`（exit 1，reason 含 `timed out after 60000ms`）；加回后同命令 exit 0。
- [x] AC5 隔离性：`git diff --stat develop HEAD`（落地树相对 develop）恰好只有 `goals/AC-323-<slug>.md`（加本任务文件）；`goals/` 下其它记录 `git diff` 为空。

## DoD

- 真实跑 `quay goal gate AC-323`（非 `--dry-run`，判据是真浏览器 + 真 WebSocket 服务端）拿到 `verdict: "pass"` 的 GateEvent（在带可写 `.quay/` 的根上，例如合并后主检出或工作树内的 `.quay/`），并留下该条原文。
- 三条判据命令各跑一次，记 wall time 与 exit code（至少 CMD1 贴 `12 passed (45.4s)` 形状的原文）。
- 假形态（删 `timeoutMs`）红、还原绿，原始输出留档。
- Evidence 记明：(a) 声明值及相对实测串行墙钟的余量；(b) 上限 120000 的来源（driver `CRITERION_TIMEOUT_MS = 12e4`）与声明值必须 < 它的理由；(c) 前两个任务为何改不了这一行（Touches 不含 goals/）；(d) 声明值与「冷缓存首次运行」的关系（冷跑更慢，故声明值须覆盖冷上界而非仅暖值）。

## Touches

- goals/AC-323-composer-内双语音入口-容器内-live-voice-紧凑栏-波形-时长-字幕-模型-mute-end-桌面与.md
- tasks/gap-ac323-gate-deadline-below-criterion-serial-time.md (self)

## Evidence

### 落地物

`goals/AC-323-composer-…-桌面与.md` 的 frontmatter 尾部加一行，`git diff -- goals/` 的增删行只有它
（`1 file changed, 1 insertion(+), 0 deletions`），记录其余字段（`id`/`title`/`status`/`kind`/`goal`/
`criterion`/`expect`/`origin`/`activatedAt`/`statusLog`/`fidelity`）逐字节未动：

```
@@ -60,4 +60,5 @@ fidelity:
   verdict: faithful
   reason: "fidelity judge: faithful"
   at: 2026-10-10T01:44:15.202Z
+timeoutMs: 115000
 ---
```

提交 `19df2137 fix(goals): declare AC-323 timeoutMs above its serial criterion wallclock`
（commitlint conventional 头通过；任务 id 在 body 里）。

### (a) 声明值 115000 相对实测串行墙钟的余量

判据是三条命令的**串行**链。本任务在**工作树**逐条实测（命令按判据原文，`bash scripts/with-memory-cap.sh`
包一层给各自 cgroup；括号里是命令自身打印的读数）：

| 命令 | 命令自身读数 | exit | wall |
|---|---|---|---|
| CMD1 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` | `12 passed (45.2s)` | 0 | 46086ms |
| CMD2 `npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime` | `Test Files 4 passed (4)` / `Tests 61 passed (61)` / `Duration 3.72s` | 0 | 4240ms |
| CMD3 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` | `6 passed (24.9s)` | 0 | 25721ms |
| **串行合计** | | **0** | **76047ms** |

闸自己把同一条链跑完的**端到端**墙钟（含 store 读取 + 写 event）：`--dry-run` 73475ms、
非 dry-run 75270ms 与 93572ms —— 均在 115000 内。

余量（对 deadline 115000 而言）：

- 本次串行实测 76047ms ⇒ 余量 38953ms（51.2% 的 deadline）；
- 本次观测到的**最坏端到端**墙钟 96968ms（见 DoD 那条同树 flake run，它跑完了全程没被 kill）
  ⇒ 余量 18032ms（15.7%）；
- Proposal 记录的历史最坏串行读数（CMD1 59.2s + CMD2 ≈4s + CMD3 36.9s ≈ 100100ms）
  ⇒ 余量 ≈14900ms（13.0%）。

### (b) 上限 120000 的来源，以及声明值为何必须严格小于它

闸自己的 deadline 由 `resolveAcceptanceTimeout(rec.timeoutMs)`（`acceptance-runner.ts`）决定：
record 的 `timeoutMs` → 环境变量 `QUAY_ACCEPTANCE_TIMEOUT_MS` → `DEFAULT_ACCEPTANCE_TIMEOUT_MS = 6e4`。
AC-323 记录此前没有 `timeoutMs`、仓里也没有 `.quay/gates.yml`，故上限恒为 60000ms。

驱动侧是另一道更外的闸：goal driver 用 `CRITERION_TIMEOUT_MS = 12e4` **spawn** `quay goal gate <id>`
（`scripts/dist/goal-driver.js:56441` `var CRITERION_TIMEOUT_MS = 12e4;`，`gateCriterion()` 里
`await runAsync(goalStoreArgv(root, ["gate", id]), { timeoutMs: CRITERION_TIMEOUT_MS, collectStderr: true })`），
超时即 `child.kill("SIGKILL")` 并记成 `not-evaluated` + `gate spawn error: spawn timeout after 120000ms (SIGKILL)`。
⇒ **声明值 ≥120000 只会让 driver 先杀 spawn，拿到的是 driver 的 not-evaluated(spawn)，而不是闸自己的
verdict**，闸仍然永远判不出 pass —— 只是把「闸自杀」换成「驱动杀闸」。所以声明值必须严格 <120000。
取 115000 而不是贴着 120000，是为了给闸在判 timeout 之后**自己写出 verdict** 留 5000ms，而不是被
driver 的 spawn 上限连人带账一起杀。

### (c) 为什么前两个任务改不了这一行

`gap-live-voice-composer-embedded-dual-entry` 与 `gap-live-voice-composer-embedded-acceptance-spec` 的
`## Touches` 都**不含** `goals/AC-323-*.md`。anti-drift 要求落地 diff ⊆ Touches，所以「给记录加一行
`timeoutMs`」正是被明文挡在门外的那个改动——证据是 `gap-live-voice-composer-embedded-acceptance-spec`
的 Evidence「遗留 / 风险」第 1 条，及其 `## DoD` 里 `quay goal gate AC-323` 报不出 0 的记录。本任务把
该文件纳入 `## Touches` 后落地，填上这个缺口。

⛔ 判据文本（`criterion` / `expect`）一个字未动；三个命令、任何 spec、任何产品代码、任何其它 goal 记录
均未动。收窄/优化判据等于削弱测量面，不做。

### (d) 声明值与「冷缓存首次运行」的关系

判据要起真浏览器 + 真 WebSocket 服务端，且每次运行的 Vite 依赖目录都在**本次 run 自己的临时目录**里
（`playwright.config.ts`：`const viteCacheDir = path.join(dataDir, 'vite-cache')`，`dataDir` 每次 run
由 `resolveE2eDataDir()` 新建）⇒ 每次运行都是「冷优化器」，**热读数只是下界，不是上界**。所以声明值按
**冷/坏上界**（历史最坏 ≈100s 与本次最坏端到端 96.97s）定档，而不是按本次暖值 76.0s 定档；115000 对
最坏观测仍有 ≈13%–16% 余量。这也是判据链实测散布 73.5s–97.0s 的直接后果。

### AC1 读数

- `git diff -- goals/` 的增删行只有 `+timeoutMs: 115000` 一行，其余字段逐字节相同。✅
- `quay goal show AC-323 --json` 的 `timeoutMs`：⚠️ 该 Provider ABI 的 goal 目录由 `.quay/config.yml`
  的 `providers.native.env.QUAY_NATIVE_GOAL_DIR` **钉成主检出**（`/data/home/yale/work/claudecodeui/goals`，
  绝对路径），与 `--root` 无关 ⇒ 这条读数在**分支落地前**读的仍是主检出的旧记录（无 `timeoutMs`），
  落地后读的就是本文件、等于 115000。**同字节**的等价前置读数走 store 方言（与 `quay goal gate` 同一个
  目录解析）：`quay goal get AC-323 --json --store --root <工作树>` → `"timeoutMs": 115000`。⛔ 不谎报
  一个没取到的读数，故此处如实记下这个「落地后才成立」的时序。

### AC2 原文（`--dry-run`，exit 0）

```
$ quay goal gate AC-323 --dry-run --root <工作树>        # exit 0, wall 73475ms
{
  "id": "AC-323",
  "verdict": "pass",
  "cause": null,
  "reason": "acceptance passed (exit 0)",
  "timeoutMs": 115000,
  "timestamp": "2026-10-10T03:25:16.703Z",
  "dryRun": true,
  ...
```

### DoD：非 dry-run 的真实闸 + GateEvent 原文

```
$ quay goal gate AC-323 --root <工作树>                  # exit 0, wall 93572ms（已合并 develop 的落地树）
{
  "id": "AC-323",
  "verdict": "pass",
  "cause": null,
  "reason": "acceptance passed (exit 0)",
  "timeoutMs": 115000,
  "timestamp": "2026-10-10T03:34:54.474Z",
  "dryRun": false,
  "event": { ...,
    "payload": { "reason": "acceptance passed (exit 0)",
                 "evaluationRoot": "<工作树>",
                 "treeSha": "4d8807714f3a1e4798e4c94a3a26852655e7bb66" } }
}
```

GateEvent 落在 `<工作树>/.quay/gate-events.jsonl`（`.gitignore:155` 的 `.quay/*` 忽略它，不脏树）：

```
2026-10-10T03:28:47.311Z  fail  cause=None  treeSha=41d8ce9b…  acceptance failed (exit 1) — …
2026-10-10T03:30:55.683Z  pass  cause=None  treeSha=41d8ce9b…  acceptance passed (exit 0)
2026-10-10T03:34:54.474Z  pass  cause=None  treeSha=4d880771…  acceptance passed (exit 0)
```

⚠️ 如实记下第一条 `fail`：它落在 treeSha `41d8ce9b…` 上，而**同一个 treeSha** 紧接着的复跑是 `pass`
⇒ 那是**同树复跑即绿**的负载抖动，不是本改动引入的红灯（本任务只改了 `goals/` 下的一行数据，不触碰
任何被 e2e 断言的代码）。该次闸在 96968ms 内跑完、失败输出被 `runAcceptance` 的 `withFailureOutput`
截断在 4070 字符，**失败的那条命令因此未能具名**，不做超出证据的归因。

### AC3 原文

见 (a) 的实测表：三条命令各自 `exit 0`，读数 `12 passed (45.2s)` / `Tests 61 passed (61)` /
`6 passed (24.9s)`（CMD1 复跑另记 `12 passed (42.9s)`），串行合计 **76047ms < 115000**。

### AC4 假形态原文（删掉 `timeoutMs` ⇒ 默认 60000；`QUAY_ACCEPTANCE_TIMEOUT_MS` 未设）

```
$ quay goal gate AC-323 --dry-run --root <工作树>        # exit 1, wall 60279ms
{
  "id": "AC-323",
  "verdict": "not-evaluated",
  "cause": "timeout",
  "reason": "not-evaluated (timeout): acceptance timed out after 60000ms (killed) — set the record's `timeoutMs` or QUAY_ACCEPTANCE_TIMEOUT_MS",
  "timeoutMs": 60000,
  ...
```

把 `timeoutMs: 115000` 加回去后，同一命令 `exit 0`、`verdict == "pass"`（见 AC2）。现场红 → 还原绿闭环。

### AC5 隔离性

```
$ git diff --stat develop HEAD                            # 落地树相对 develop
 ...-模型-mute-end-桌面与.md" | 1 +
 1 file changed, 1 insertion(+)

$ git diff --name-only develop -- goals/                  # 恰好一条
"goals/AC-323-composer-…-桌面与.md"

$ git diff --name-only develop -- goals/ | wc -l
1
```

`goals/` 下其它记录（含 develop 上刚落地的 AC-322）diff 为空。本任务文件
`tasks/gap-ac323-gate-deadline-below-criterion-serial-time.md` 的勾选由 `task_write` 自提交到 store
（主检出的 `tasks/`），预合并 develop 后本分支副本与之一致。



### 第 2 轮（2026-10-10，工人重入）——上一轮 suite 红的归因与本轮复验

上一轮 fan-in 在 suite 步红，唯一失败文件 `server/modules/oauth/tests/oauth-dcr.test.ts`。核查结论：**red 与环境/跨 lane 有关，与本 delta 无关**。

- 机械 delta-relatedness = UNRELATED：本任务落地 diff 只有 `goals/` F 的一行，不触任何被该文件导入或断言的代码。
- 该文件**单跑复验绿**：`./node_modules/.bin/tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/oauth/tests/oauth-dcr.test.ts` → `tests 7 / pass 7 / fail 0`，exit 0，duration_ms 5448。
- 真正的失败是判据 (g) 的 `Error: ENOENT: no such file or directory, open '…/server/modules/debug-agent/__criterion-falsify-typed-turn-2493034-provider.ts'`（见该轮 per-file artifact `…/suite-logs/20261010T113708-2427983/server__modules__oauth__tests__oauth-dcr.test.ts.out` 第 74 行）。即**别的 lane 的「取假形态」临时文件**在 (g) 的 `server/**/*.ts` 枚举与读取之间被删掉 ⇒ 跨 lane TOCTOU（与 memory `suite-red-oauth-dcr-enoent-is-cross-lane-falsify-race` 同族）。suite 摘要里的 `not ok - …: [off] mounted=false … 404` 是该测试自己的 `console.log`（`oauth-dcr.test.ts:310`），**不是**失败断言。

本轮已 `git merge --no-edit develop`（结果 `Already up to date`）后**重跑 AC2**（fresh reading）：

```
$ quay goal gate AC-323 --dry-run --root <工作树>          # exit 0, wall 73095ms
{
  "id": "AC-323",
  "verdict": "pass",
  "cause": null,
  "reason": "acceptance passed (exit 0)",
  "timeoutMs": 115000,
  "timestamp": "2026-10-10T03:44:36.404Z",
  "dryRun": true,
  "event": { ..., "payload": { "reason": "acceptance passed (exit 0)",
    "evaluationRoot": "<工作树>",
    "treeSha": "1e6bead1fe5f8b6734bc6f356be9a5cae4eb5ba1" } }
}
```

该 treeSha `1e6bead1` **正是上一轮 suite 红所在的同一棵树**（`.quay/full-suite-state.json` 的 `tree`）⇒ 判据在这棵树上确实 pass，进一步佐证 suite 红与判据无关。

AC1 / AC5 本轮机械复验：`git diff develop HEAD -- goals/` 的增删行只有 `+timeoutMs: 115000`；`git diff --stat develop HEAD` = `1 file changed, 1 insertion(+)`；`goals/` 下非 AC-323 记录 diff 为空；`quay goal get AC-323 --json --store --root <工作树>` → `timeoutMs: 115000`。