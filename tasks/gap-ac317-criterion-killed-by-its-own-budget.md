---
id: gap-ac317-criterion-killed-by-its-own-budget
title: AC-317 判据即便内容为真也被自己的闸预算杀掉：记录未声明 timeoutMs（逐字节同判据的姊妹 AC-315 声明 115000，其
  60s 超时串在声明落地那一刻结束）；本轮实测修好内容后整文件 7 passed / exit 0 / wall 67s > 60000ms 默认 ——
  不声明预算，台账尾永远读出 not-evaluated(timeout) 而不是 pass
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac316-restore-criterion-two-regressions
goal_ac: AC-317
---
## Proposal

### 本轮直接测量（不是台账尾巴），树 `d449486a`（= 台账最新 fail 记录的 treeSha）

AC-317 的 criterion 是两条命令的合取：

```
npx playwright test e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
```

1. **第二条命令确定性绿**：`tests 19 / pass 19 / fail 0`，exit 0（1.69s）。AC-317 的结构性保证（bridge 对 `conversation.item.input_audio_transcription.delta` / `.completed` 各有 dispatch 分支、转发为 outbound `caption` 帧、caption 文本与 `session_send` 的 `message` 是两条互不相通的通路）**成立，未回退**。
2. **第一条命令 exit 1**：全文件 `1 failed, 3 did not run, 3 passed (38.8s)`；`-g "three transcriptions of one thought"` 单独跑同样 exit 1 ⇒ **确定性红，不是负载 flake**。红在 `:1337`（`Math.max(counts) <= 1`，`counts=[0,1×60,2×8]`）与 `:1343`（`toHaveCount(1)` 收到 2，14 次轮询）。
3. **该内容红已被在飞任务认领，本任务不重复修**：`gap-ac316-restore-criterion-two-regressions`（status `ready`，`goal_ac: AC-316`）的「根因二」逐字就是它 —— `14b8e9ed` 把 `useVoiceRealtimeSession.ts:963` 的 `carried` 从「全部未归属 final caption」改成 `relayed === '' ? [] : matched.length > 0 ? matched : pending.slice(-1)`，rewrite 形态的中继只认领最后一条待定 caption，折叠行（`placeCaptions.ts` 的 `foldCaptionsIntoTranscriptRow`，行 id 取首条 `voice-caption-<itemId>`）于是存活并与交付行并存。该任务 Touches 正是 `useVoiceRealtimeSession.ts` / `placeCaptions.ts` / `e2e/voice-realtime-upload-fixture.spec.ts`，其 AC3(b) 已把 `:1337`/`:1343` 定为取假形态。⛔ 本任务不得再动这三类文件。

### 本任务闭合的是未被认领的那一半：闸预算

4. `goals/AC-317-*.md` 的 frontmatter **没有 `timeoutMs`**；姊妹 AC-315 的 criterion 与本 AC **逐字节相同**（同一条 `... upload-fixture.spec.ts && ... protocol-simulation.test.ts`），却声明了 `timeoutMs: 115000`。
5. 台账对照（同一命令、同一窗口）：

   - **AC-317（无声明）**：`2026-10-11T11:54:57` / `17:34:23` / `22:01:47` / `2026-10-12T02:02:14` 连续四条 `not-evaluated (timeout): acceptance timed out after 60000ms (killed)`，随后 `06:58:33` / `07:01:31` 两条 fail。
   - **AC-315（有声明）**：自己的 60s 超时串（`2026-10-11T12:13`–`13:40Z`）在 `753d249f` 于 `13:36:16Z` 声明 timeoutMs 之后**当刻结束**，`13:47:03Z` 起连续 pass。AC-323（115000）、AC-331（118000）、AC-332（100000）同一惯例。
6. **实测 wall（本任务的核心读数）**：在本树做单变量受控实验 —— 把 `:963` 暂时恢复成 `carried = pending`（随后立即还原：POST hash == PRE hash `37561fb35eb68edee62508082d317773fe1f2dc6`，`git status --porcelain` 空），整文件读数 **`7 passed (1.1m)`、exit 0、wall 67s**。⇒ 内容修好之后，这条命令本身就 > 60000ms 默认；不声明预算，闸仍会把它杀成 `not-evaluated (timeout)`，**永远读不出 pass**。这就是「内容为真 ≠ 判据可读为真」。

### 排序由 `depends_on` 承担，不写进 AC

本任务的前置 `gap-ac316-restore-criterion-two-regressions` 已用顶层 `depends_on` 编码（`ready-pool-check` 读到 `blockingDeps: [gap-ac316-restore-criterion-two-regressions]`），调度器只在该依赖 done 且合入后才派发本任务。**故 AC 里不再写「某任务落地后」这类限定语** —— 这类措辞会被 `ready-pool-check` 的 `unsatisfiableUnannotatedAc` 判成「结构上无法满足且未标注」而让本任务不可提级（本轮已实测命中一次：AC2 原文即被点中）。

### 为什么早先的 done 没止住

<!-- dedup-ref --> `gap-live-voice-realtime-asr-caption-transcript`（done）交付的实现仍成立（第二条命令今天绿，interim 去重也仍成立 —— 交付前的 user 行计数全程为 1）；`gap-ac317-upload-fixture-criterion-nondeterministic`（done）修的是判据自身的时序（fixture 可提交性 + 往返窗有界重放），且明确「⛔ 不改 `goals/**`」，从未碰过 `timeoutMs` —— 本条是它够不到的机制。内容那一半由在飞的 `gap-ac316-restore-criterion-two-regressions` 认领，故不在本任务范围内。

### 已知限制（登记，不在本任务改）

AC-317 的判据第一条命令跑的是**整份 serial spec 文件**，其中还载有姊妹 AC（AC-326 / AC-327 / AC-331 等）的用例，所以 AC-317 的裁决与它们耦合：任一条红都会把本 AC 判红。收窄判据属人的裁定，本任务不改 criterion 文本。

### 边界 / 不做

- ⛔ 不改 AC-317 的 `criterion` / `expect` 文本（只加 frontmatter 一行 `timeoutMs`）。
- ⛔ 不动 `useVoiceRealtimeSession.ts` / `placeCaptions.ts` / `e2e/voice-realtime-upload-fixture.spec.ts` —— 内容红归在飞的 AC-316 任务，本任务重复编辑那三处会与其并发改同一行。
- ⛔ 不加 retries / skip、不放松任何断言、不改 `playwright.config.ts`。
- 若依赖未合入致使内容仍红：如实登记并停在 `depends_on` 上，**不得把「预算已声明」写成「判据已绿」**。

## AC

- [x] AC1（预算声明，承重）`goals/AC-317-*.md` 的 frontmatter 出现 `timeoutMs`，取值 ≥115000；回读（frontmatter / `goal_get`）证明该字段存在，并在任务或 commit 里写明依据：与逐字节同判据的姊妹 AC-315 取齐 + 本轮实测 wall 67s。
- [x] AC2（端到端翻绿，承重）AC-317 的 criterion 命令 exit 0，登记逐字读数与 wall；且该轮 AC-317 的闸裁决为 `pass` —— `gate_log AC-317` 的最后一条 `verdict` 为 `pass`（不是 `not-evaluated`）。
- [x] AC3（取假形态）同一命令留红/绿两组读数：以旧默认（`timeoutMs`/`--timeout` = 60000）跑一次得 `not-evaluated (timeout): acceptance timed out after 60000ms (killed)`，以声明预算跑一次得 `pass`；读数须落在 `wall ∈ (60000ms, 声明预算)` 区间内。
- [x] AC4（判据未改）`git diff` 对 `goals/AC-317-*.md` 的新增/删除行只有一行（新增的 `timeoutMs:`）；`criterion` 与 `expect` 文本逐字节相同。
- [x] AC5（静态门）`npm run typecheck` exit 0；相对 develop 无新增 lint 诊断。

## DoD

真实落地：AC-317 的台账尾由 `fail` / `not-evaluated` 翻成 **pass**，留下那一轮的 wall 读数与闸裁决（`gate_log AC-317` 的 `verdict: pass`），而不是「我加了配置」的自述；声明本身落在 store 的提交里。⛔ 不得以「预算已声明」替代「判据已绿」：若依赖未合入而内容仍红，如实登记并停在 `depends_on` 上。

## Touches

- goals/AC-317-实时-asr-interim-final-transcript-作为用户消息展示-不混入模型推理输入-依赖-ac-316.md（仅 frontmatter 的 `timeoutMs` 一行；criterion/expect 文本不动）
- tasks/gap-ac317-criterion-killed-by-its-own-budget.md（self）

## Notes

- 判据本体（`goals/AC-317-*.md`）**不是**本任务的「测试文件」：本任务不写代码，它的验收读数就是 AC-317 自己那条 criterion 命令的闸裁决（`gate_log AC-317` 的 `verdict`）与 wall。`e2e/voice-realtime-upload-fixture.spec.ts` 只被**读取/执行**用于取证，⛔ 不在本任务 Touches 内，因为它由在飞的 `gap-ac316-restore-criterion-two-regressions` 独占。
- 本条与在飞任务的机制不同、交付面不相交（前者改 `useVoiceRealtimeSession.ts:963` 的归属启发式，后者只改 `goals/**` 的一行预算），故按 granularity 判为 **separate**；Touches 无重叠，scheduler 不会把它们串行到互相阻塞。

## Evidence

### 落地物

commit `c3db6533 chore(goals): declare AC-317 gate timeoutMs 115000` —— `1 file changed, 1 insertion(+)`，
落在 `goals/AC-317-…-依赖-ac-316.md` 的 frontmatter 尾（`fidelity` 块之后、`---` 之前）：

```
@@ -39,4 +39,5 @@ fidelity:
   verdict: not-evaluated
   reason: no judge configured
   at: 2026-10-09T10:36:35.596Z
+timeoutMs: 115000
 ---
```

### 依赖前置已合入（内容那一半）

`depends_on` 的 `gap-ac316-restore-criterion-two-regressions` 已 `done` 且其内容修已在 develop：
`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:985` 现为
`const carried = relayed === '' ? [] : matched.length > 0 ? matched : thought;`。本轮第一条判据命令
`7 passed` 即该修复生效的读数 —— 内容为真。

### AC1 读数

- `git diff develop -- goals/AC-317-…md` 的增删行只有 `+timeoutMs: 115000` 一行（AC4 同证）。
- **store 方言回读**（与 `quay goal gate` 同一个目录解析）：`quay goal get AC-317 --json --store --root <工作树>`
  → `"timeoutMs": 115000`。
- ⚠️ 时序如实登记：Provider ABI 的 goal 目录被 `.quay/config.yml` 的
  `providers.native.env.QUAY_NATIVE_GOAL_DIR` 钉成**主检出的绝对路径** `/data/home/yale/work/claudecodeui/goals`，
  与 `--root` 无关 ⇒ `quay goal show AC-317`（ABI 默认方言）在分支落地**前**读的仍是主检出的旧记录（无 `timeoutMs`）。
  不谎报一个没取到的读数；同字节等价的前置读数走上一条 store 方言取得（与 precedent
  `gap-ac323-gate-deadline-below-criterion-serial-time` 的登记方式一致）。
- 依据（写进上条 commit 的 message）：姊妹 **AC-315 的 criterion 与本 AC 逐字节相同**且已声明
  `timeoutMs: 115000`；本轮实测判据墙钟 67.3–68.1s。115000 同时 < driver 的
  `CRITERION_TIMEOUT_MS = 12e4`（`scripts/dist/goal-driver.js:56711`），与 AC-315 取同一个余量，
  以免 driver 先杀 spawn、拿到 `not-evaluated(spawn)` 而不是闸自己的 verdict。

### AC2 原文（criterion exit 0 + 闸裁决 pass）

两条命令各自跑（工作树，已合 develop）：

| 命令 | 命令自身读数 | exit | wall |
|---|---|---|---|
| `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` | `7 passed (1.2m)` | 0 | 71839ms |
| `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` | `tests 19 / pass 19 / fail 0 / duration_ms 2291.5` | 0 | 2832ms |

闸自己把合取跑完（落地树 `treeSha 736e1ec32f371711cf015cc63ee0f48673f72007`，`HEAD e2997c31`，已 `git merge --no-edit develop`）：

```
$ quay goal gate AC-317 --store --root <工作树>          # exit 0, wall 68089ms
{
  "id": "AC-317",
  "verdict": "pass",
  "cause": null,
  "reason": "acceptance passed (exit 0)",
  "timeoutMs": 115000,
  "timestamp": "2026-10-12T07:34:42.889Z",
  "dryRun": false,
  "event": {
    "id": "57e2d615-a6db-4a1f-a756-46390ac11eb9",
    "item_id": "AC-317", "pipeline_id": "AC-317", "gate": "goal", "actor": "goal-cli",
    "verdict": "pass", "timestamp": "2026-10-12T07:34:42.889Z",
    "payload": { "reason": "acceptance passed (exit 0)",
                 "evaluationRoot": "<工作树>",
                 "treeSha": "736e1ec32f371711cf015cc63ee0f48673f72007" } }
}
```

`gate_log AC-317`（`file=<工作树>/.quay/gate-events.jsonl`，即该轮真正写入的那本台账）的最后一条：

```
2026-10-12T07:30:41.206Z  not-evaluated  cause=timeout  treeSha=e078721d…  not-evaluated (timeout): acceptance timed out after 60000ms (killed) — …
2026-10-12T07:31:53.684Z  pass           cause=None     treeSha=e078721d…  acceptance passed (exit 0)
2026-10-12T07:34:42.889Z  pass           cause=None     treeSha=736e1ec3…  acceptance passed (exit 0)   ← 尾条
```

⚠️ **如实登记**：ABI **默认根**（主检出）那本 `.quay/gate-events.jsonl` 里 AC-317 的尾条此刻仍是
`not-evaluated (timeout)`（`2026-10-12T07:25:37.637Z`，treeSha `ef6d8b4a…`）。把它翻成 pass 的机制**就是本任务的声明**：
声明经 fan-in 合入 develop、主检出再取到之后，goal driver 在同一棵树上按 115000 跑即得 pass。
本条的读数取自本工作树自己那本闸（`evaluationRoot` = 工作树），用的是**与 driver 相同的 store 方言**
（`goal-driver.js` 的 `goalStoreArgv(root, ["gate", id])` → `--store --root <dataRoot>`），与 precedent
`gap-ac323-gate-deadline-below-criterion-serial-time` 的取证方式一致（其 DoD 明写「在带可写 `.quay/` 的根上，
例如合并后主检出**或工作树内的 `.quay/`**」）。

### AC3 取假形态原文（同树、同判据，只差预算；`QUAY_ACCEPTANCE_TIMEOUT_MS` 未设）

| 记录 | 闸裁决 | cause | exit | wall | treeSha |
|---|---|---|---|---|---|
| 无 `timeoutMs`（旧默认 60000） | `not-evaluated` | `timeout` | 1 | 60253ms | e078721d… |
| `timeoutMs: 115000` | `pass` | `null` | 0 | 67286ms | e078721d… |

```
$ quay goal gate AC-317 --store --root <工作树>          # 记录无 timeoutMs, exit 1, wall 60253ms
{ "verdict": "not-evaluated", "cause": "timeout",
  "reason": "not-evaluated (timeout): acceptance timed out after 60000ms (killed) — set the record's `timeoutMs` or QUAY_ACCEPTANCE_TIMEOUT_MS",
  "timeoutMs": 60000, "event": { …, "payload": { "treeSha": "e078721d5dfcd00661992d9dc4e9c8f3d8959d1e" } } }

$ quay goal gate AC-317 --store --root <工作树>          # 记录声明 115000, exit 0, wall 67286ms
{ "verdict": "pass", "cause": null, "reason": "acceptance passed (exit 0)",
  "timeoutMs": 115000, "event": { …, "payload": { "treeSha": "e078721d5dfcd00661992d9dc4e9c8f3d8959d1e" } } }
```

两次读数的 **treeSha 相同**（`e078721d…`，判据文件是未提交的工作区改动，`HEAD^{tree}` 不变）⇒ 单变量受控：
同树、同判据，只有记录的 `timeoutMs` 不同，verdict 从 `not-evaluated(timeout)` 翻成 `pass`。
判据实测墙钟 67.3–68.1s **落在 `(60000ms, 115000ms)` 区间内** —— 比旧默认长、比声明预算短，
这正是「只有声明预算才让这条永久性长判据可读为 pass」的直接证据。

### AC4 判据未改

```
$ git diff --numstat develop HEAD -- goals/AC-317-…md
1       0       "goals/AC-317-…-依赖-ac-316.md"        # 新增 1 行、删除 0 行
$ git diff develop HEAD -- goals/AC-317-…md | grep -E '^[+-][^+-]'
+timeoutMs: 115000
```

`criterion` 与 `expect` 一个字节未动（整份 diff 只有上面那一个 `+` 行）。

### AC5 静态门

```
$ npm run typecheck      # tsc --noEmit 三份 tsconfig（根 / server / scripts）→ exit 0
$ npm run lint           # oxlint src/ server/ scripts/ shared/ → exit 0（仅存量 warning）
```

本 delta 只改 `goals/` 下的一行 markdown，不在 oxlint 的输入面（`src/ server/ scripts/ shared/`）内，
故相对 develop **无新增 lint 诊断**。

### 边界（复核）

⛔ 未动 `criterion` / `expect` 文本；⛔ 未动 `useVoiceRealtimeSession.ts` / `placeCaptions.ts` /
`e2e/voice-realtime-upload-fixture.spec.ts`（落地 diff 只有 `goals/` 那一行）；⛔ 未加 retries/skip、
未放松任何断言、未改 `playwright.config.ts`；⛔ 未动任何其它 goal 记录。
