---
id: gap-ac331-gate-deadline-and-ac323-regression-reverify
title: AC-331 判据串行 ≈95–130s 高于 goal gate 默认 60000ms ⇒ 永远
  not-evaluated(timeout)：在 AC 记录声明 timeoutMs，并在 GOAL-038 实现落地树上复验 AC-323 三链 +
  typecheck 全绿、四文件白名单 diff 空、紧凑栏假形态红/绿
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-331
---
## Proposal

（去重 / 粒度）<!-- dedup-ref --> 本任务与现存任务的关系：`gap-goal-038-ac323-regression-ac`（status=ready、`goal_ac: null`）是**创建 AC-331** 的提案任务——它只提议、不实现，也不以 `goal_ac` 认领 AC-331；`gap-ac323-gate-deadline-below-criterion-serial-time`（done、`goal_ac: AC-323`）是同一机制（闸 deadline 低于判据串行墙钟）在 **AC-323 记录**上的实例，与本任务不是同一条 AC。仓内**无任何任务以 `goal_ac: AC-331` 认领本 AC**（`grep -l '^goal_ac: AC-331' tasks/*.md` 为空）⇒ 本任务为新案。`task-granularity-advice --touches goals/AC-331-*.md` 报 `peers: []`、`mentions: []`，无合并候选。

### 现状（2026-10-11 复核）

AC-331（`goals/AC-331-…-ex.md`）的 `criterion` 是四条命令的 **`&&` 串行**链：

```
CMD1 npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts
CMD2 npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime
CMD3 npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "
CMD4 npm run typecheck
```

（1）**闸 deadline 低于判据串行墙钟 ⇒ 永远 not-evaluated(timeout)。** AC-331 记录的 frontmatter **没有 `timeoutMs`**（字段止于 `activatedAt`），仓内也无 `.quay/gates.yml` ⇒ 闸 deadline 恒为 `DEFAULT_ACCEPTANCE_TIMEOUT_MS = 60000`。而 CMD1–CMD3 就是 AC-323 的三条命令——AC-323 自己的任务（`gap-ac323-gate-deadline-below-criterion-serial-time`）实测其串行墙钟 **76.0s–96.97s**；CMD4 `npm run typecheck` 本次在本机实测 **19.3s**（exit 0）。四条 `&&` 串行 ⇒ floor ≈ **95–130s**，恒 > 60s。账本 `.quay/gate-events.jsonl` 里 AC-331 只有一条 goal 事件（actor `goal-cli`、treeSha `2316199…`、`evaluationRoot` = 主检出），逐字为：

```
"verdict":"not-evaluated","cause":"timeout",
"reason":"not-evaluated (timeout): acceptance timed out after 60000ms (killed) — set the record's `timeoutMs` or QUAY_ACCEPTANCE_TIMEOUT_MS"
```

这与 AC-323（同族，记录已声明 `timeoutMs: 115000`）与 memory `ac-wallclock-bound-below-a-mandated-floor-is-unsatisfiable` 是同一形态：**红灯不来自被测功能，来自 deadline**。

（2）**回归内容本身成立、且可守卫。** GOAL-038 的实现已落在 develop 上：`ec621a2b`（AC-326 `fix(voice-realtime): fold one spoken thought into ONE transcript row`）与 `8be9df6b`（AC-327 `feat(voice-realtime): surface the delivery wait on the Live Voice row`）。`git show --stat ec621a2b 8be9df6b` 对四个白名单文件为**空**——实现**没有**碰过 `e2e/voice-realtime-live-session-send.spec.ts` / `e2e/voice-realtime-composer-embedded.spec.ts` / `e2e/mobile-workspace-composer-layout.spec.ts` / `src/modules/chat/tests/composerCompactTier.test.tsx`（它们最后改动是 `1264090d` / `aa8068d5` / `7fd3598b`，均早于 GOAL-038）。所以 expect 第 (2) 条的守卫（四文件白名单 diff 为空）**由构造即成立**，唯一卡点是 deadline。

### 做法

1. **在 AC-331 记录声明 `timeoutMs`**（`goals/AC-331-…-ex.md` frontmatter），正整数毫秒，取值 **> 四条命令实测冷串行墙钟** 且 **< 120000**。上限来源：goal driver 的 `gateCriterion()` 用 `CRITERION_TIMEOUT_MS = 12e4` spawn `quay goal gate`，≥120000 只会把「闸自杀」换成「驱动杀 spawn」（GOAL-034 的 AC-319 已实测到 `gate spawn error: spawn timeout after 120000ms (SIGKILL)`），闸仍写不出 verdict。参考 AC-323 的 `115000`；本 AC 多一条 CMD4，按实测决定（115000–119000 区间）。
2. **逐条实测 CMD1–CMD4 的墙钟并求和**（`&&` 串行，和即 floor），用 `scripts/with-memory-cap.sh` 包各自命令（遵守 AGENTS.md「Running tests from a Claude session」）。
3. **闸自证**：`quay goal gate AC-331 --dry-run --root <工作树>` exit 0、`verdict == "pass"`、`cause == null`、`timeoutMs == 声明值`。
4. **守卫**：`git diff --exit-code <GOAL-038 合并基>..HEAD -- <四文件>` 退出 0（空 diff）。`<GOAL-038 合并基>` 取 `git merge-base develop ec621a2b`（AC-326 工作从 develop 分出的那个提交）。唯一例外：`e2e/voice-realtime-upload-fixture.spec.ts` 不在白名单（AC-326 在其上新增用例），但其**既有断言**不得改。
5. **取假形态 A（deadline）**：删掉 `timeoutMs` 行（回默认 60000）⇒ 同一 `--dry-run` 闸报 `not-evaluated` / `cause: timeout`（reason 含 `timed out after 60000ms`）；加回 ⇒ 复绿。
6. **取假形态 B（紧凑栏回归）**：在实现树上注入一个 listening 阶段栏高回归——`src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx` 的 `voice-realtime-bar` 容器 class `h-16` → `h-20`——⇒ 携带 AC-323 第二节「三态 boundingBox 的 height 与 top 差 ≤2px」断言的命令**必红**；`git checkout --` 还原后回绿。
   - ⚠️ **实测定位（与 expect 的措辞不符，须照实记）**：「三态 boundingBox height/top 差 ≤2px」这条断言**不在** vitest `composerCompactTier.test.tsx`（它在 jsdom 里只读结构与 class token：`wrapTokens`、`flex-nowrap`、`clipRowOf`，没有 boundingBox），而在 **CMD1** 的两份 spec——`e2e/voice-realtime-composer-embedded.spec.ts`（顶部注释逐字写 "the bar's height AND its top edge are the same (within 2px)"）与 `e2e/voice-realtime-live-session-send.spec.ts:575`（`expect(Math.abs(barHeight - box.height)).toBeLessThanOrEqual(2)`）。AC-331 的 expect 第 (3) 条把必红命令写成「第二条命令（vitest composerCompactTier）」——该措辞与事实不符。**不动 expect 文本**；按断言的**真实所在**（CMD1）跑出红/绿闭环，并把这条措辞与事实的偏差写进 Evidence 的 finding（同时如实记录：栏高改 `h-20` 后 CMD2 是否红——预期不红，因 CMD2 读不到 boundingBox）。

### 边界 / 不做

- ⛔ **不改 AC-331 的 `criterion` / `expect` 文本一个字**，也不删或弱化其中的任何命令（尤其 CMD4 `npm run typecheck`）——收窄判据面等于削弱测量。
- ⛔ 不改四个白名单文件；不改任何 spec 或产品代码（除第 6 条 falsification 的临时注入，测后用 `git checkout --` 还原，`git status --porcelain` 为空）。
- ⛔ 不动任何其它 goal 记录。
- 不靠改 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 来「报出」绿——那是 spec 自身看门狗，压不到闸的 deadline。

## AC

- [ ] **AC1 声明 `timeoutMs`**：`goals/AC-331-…-ex.md` frontmatter 声明 `timeoutMs`（正整数毫秒），值 > CMD1–CMD4 实测冷串行墙钟且 < 120000；记录其余字段逐字节不变。机械判据：`git diff -- goals/AC-331-*.md` 的增删行只有 `+timeoutMs: <N>` 一行；`quay goal get AC-331 --json --store --root <工作树>` 的 `timeoutMs == N`。
- [ ] **AC2 逐条实测**：CMD1–CMD4 各跑一次（`scripts/with-memory-cap.sh` 包），各自 exit 0、记墙钟；串行合计 < `timeoutMs`。至少贴 CMD1 的 `passed` 读数、CMD2 的 `Test Files N passed`、CMD3 的 `6 passed`、CMD4 `typecheck exit 0` 形状的原文。
- [ ] **AC3 闸自证**：`quay goal gate AC-331 --dry-run --root <工作树>` exit 0，stdout JSON `verdict == "pass"`、`cause == null`、`timeoutMs == <声明值>`。原文贴 Evidence。
- [x] **AC4 守卫**：`git diff --exit-code $(git merge-base develop ec621a2b)..HEAD -- e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-composer-embedded.spec.ts e2e/mobile-workspace-composer-layout.spec.ts src/modules/chat/tests/composerCompactTier.test.tsx` 退出 0（diff 为空）；`e2e/voice-realtime-upload-fixture.spec.ts` 的既有用例标题集合不变（新增用例除外）。
- [ ] **AC5 假形态 A（deadline）**：删掉 `timeoutMs` 行后同一 `--dry-run` 闸 exit 非 0，`verdict == "not-evaluated"`、`cause == "timeout"`、reason 含 `timed out after 60000ms`；加回 ⇒ 同命令复绿（AC3 原文）。
- [ ] **AC6 假形态 B（紧凑栏）**：`VoiceRealtimeBar.tsx` 的 `voice-realtime-bar` 容器 `h-16`→`h-20` ⇒ **CMD1** 中那份 ≤2px 三态断言红（贴失败断言原文与文件名/行号）；`git checkout --` 还原 ⇒ CMD1 复绿。
- [x] **AC7 措辞偏差被记录**：Evidence 逐字记录「expect 第 (3) 条点名 CMD2（vitest composerCompactTier）必红」与实测事实（红在 CMD1、CMD2 不红）的偏差，并给出定位依据（`composerCompactTier.test.tsx` 无 boundingBox 断言；≤2px 断言在 `voice-realtime-composer-embedded.spec.ts` 与 `voice-realtime-live-session-send.spec.ts`）。
- [ ] **AC8 隔离性**：`git diff --stat develop HEAD` 恰好只有 `goals/AC-331-…-ex.md`（+ 本任务文件）；`goals/` 下其它记录 diff 为空；`git status --porcelain` 为空（注入已还原）。

## DoD

在**带可写 `.quay/` 的根**（合并后的主检出或工作树）真实跑 `quay goal gate AC-331`（非 `--dry-run`）拿到 `verdict: "pass"` 的 GateEvent，并留下该条原文；AC-331 的 `status` 随之翻 `achieved`。四条判据命令各跑一次、记 wall time 与 exit code。两次假形态现场红、还原绿，原始输出留档。Evidence 逐条记明：(a) 声明值及相对实测冷串行墙钟的余量；(b) 上限 120000 的来源（driver `CRITERION_TIMEOUT_MS = 12e4`）与声明值必须严格小于它的理由；(c) expect 第 (3) 条的措辞偏差（点名 CMD2，实际红在 CMD1）与其余所有事实；(d) 四文件守卫结果与所用的 `<GOAL-038 合并基>`；(e) 记录改动须落到 driver 读的那个根——AC-323 先例已记下「goal 目录由 `.quay/config.yml` 的 `QUAY_NATIVE_GOAL_DIR` 钉成主检出绝对路径」这一时序，如实按先例处理。

**替代诚实出口（仅当 AC2 的冷串行 floor ≥ 120000 时）**：若 driver 的 120000ms spawn 上限装不下 AC-331 的串行判据，以致闸写不出 pass，则勾掉所有可满足的 AC、**不勾 AC3**、在 Evidence 逐字记下每条命令的墙钟与 floor、把 120000 上限与 floor 命名为 blocker，经 `task_write` park `needs-human` 交人重校判据——不假勾，不改 `criterion` / `expect` 文本。

## Touches

- goals/AC-331-goal-038-的实现不回归-ac-323-的容器内紧凑栏与双入口判据-ac-323-的三条判据命令链一字不改仍-ex.md
- tasks/gap-ac331-gate-deadline-and-ac323-regression-reverify.md（self）

## Evidence

（worker `gap-ac331-gate-deadline-and-ac323-regression-reverify`，2026-10-11；工作树
`/data/home/yale/work/claudecodeui-worktrees/gap-ac331-gate-deadline-and-ac323-regression-reverify`，
分支 `task/gap-ac331-gate-deadline-and-ac323-regression-reverify`，fork `af2f2193`；所有命令均以
`scripts/with-memory-cap.sh` 包住、cwd = 工作树。）

### 结论（先行）：AC-331 判据 CMD1 在 develop 上**确定性红**，且红因与 deadline、与 GOAL-038 的四文件白名单**都无关**

本任务 `## 现状` 写的前提是「唯一卡点是 deadline」。复核后该前提被**证伪**：把闸 deadline 提到
任何合规值都换不出 pass，因为判据链的第一条命令 CMD1（`npx playwright test` 三份 spec）本身在
develop 上 exit 1。红因是**上游既存回归**（P4 `15a30dcf` 让真实服务端默认回 `segmented-v1`，
而该 spec 的假麦克风发平直常数块、被浏览器 `StreamingVad` 判静音 ⇒ 上游收不到帧），**已在**
`gap-voice-realtime-e2e-specs-red-under-default-segmented-mode`（status=todo，`goal_ac: AC-319`）立案。

### (AC4) 四文件白名单守卫：**exit 0（空 diff）** — 已勾

```
git diff --exit-code $(git merge-base develop ec621a2b)..HEAD -- \
  e2e/voice-realtime-live-session-send.spec.ts \
  e2e/voice-realtime-composer-embedded.spec.ts \
  e2e/mobile-workspace-composer-layout.spec.ts \
  src/modules/chat/tests/composerCompactTier.test.tsx
```
`git merge-base develop ec621a2b` = `ec621a2bd6821fcb4f051efad04fac91544efbb9`；**退出码 0**（diff 为空）。
⇒ GOAL-038 的实现（`ec621a2b` / `8be9df6b`）未碰承重四文件，expect 第 (2) 条的守卫「由构造即成立」。

### (AC7) expect 第 (3) 条措辞偏差：点名 CMD2 必红，实测红在 **CMD1** — 已勾

- `grep -c boundingBox src/modules/chat/tests/composerCompactTier.test.tsx` = **0**：CMD2 的 vitest 在
  jsdom 里只读结构与 class token（`wrapTokens` / `flex-nowrap` / `clipRowOf`），**读不到 boundingBox**。
- ≤2px 三态断言的真实所在是 **CMD1 的两份 spec**：
  - `e2e/voice-realtime-live-session-send.spec.ts:575`
    `expect(Math.abs(((await bar.boundingBox())?.height ?? 0) - box!.height)).toBeLessThanOrEqual(2)`
    （同文件 475 / 505 / 506 / 519 亦为 ≤2px 系列）；
  - `e2e/voice-realtime-composer-embedded.spec.ts:630 / 649 / 650`（顶部注释逐字写
    "the bar's height AND its top edge are the same (within 2px)"）。
- **结论**：expect 第 (3) 条把必红命令写成「第二条命令（vitest composerCompactTier）」，与事实不符；
  必红面实为 **CMD1**。⛔ 未改 `criterion` / `expect` 文本一字（本任务边界）。

### 各命令实测墙钟（`&&` 串行；原始输出见 `/tmp/ac331-evidence/*.log`）

| 命令 | 模式 | exit | 墙钟 | 原文读数 |
|---|---|---|---|---|
| CMD1 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` | 默认 | **1** | **91155ms** | `2 failed` · `5 passed` · `7 did not run` (1.5m) |
| CMD1（同一条命令） | `VOICE_REALTIME_MODE=continuous` | **0** | **59628ms** | `14 passed (58.8s)` |
| CMD2 `npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime` | — | 0 | 3629ms | `Test Files 8 passed (8)` · `Tests 104 passed (104)` |
| CMD3 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` | — | 0 | 26812ms | `6 passed (25.5s)` |
| CMD4 `npm run typecheck` | — | 0 | 17683ms | 三条 `tsc --noEmit` 全过 |

- 串行 floor（**按判据命令原样**，默认模式）：`91155+3629+26812+17683 = 139279ms` **≥ 120000**。
- 串行 floor（CMD1 走 `continuous` 回退的**绿等价代理**）：`59628+3629+26812+17683 = 107752ms` **< 120000**。

CMD1 失败断言原文（`/tmp/ac331-evidence/CMD1default.log`）：

```
e2e/voice-realtime-composer-embedded.spec.ts:644
  await expect.poll(() => upstream.callCount(), { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
  Expected: >= 1   Received: 0
e2e/voice-realtime-live-session-send.spec.ts:513
  await expect.poll(() => upstream.audioFrameCount(), { timeout: 20_000 }).toBeGreaterThan(framesBeforeMute);
  Expected: > 0    Received: 0

  2 failed
    e2e/voice-realtime-composer-embedded.spec.ts:600:3 › voice realtime composer embedded bar › 1280px: ...
    e2e/voice-realtime-live-session-send.spec.ts:455:3 › voice realtime live session send › PC: ...
  7 did not run
  5 passed (1.5m)
```

### 红因定位（三步排除）

1. **非负载毛刺**：CMD1 默认模式连跑三次，红且墙钟近乎相同（91155ms / 93251ms / 94568ms），
   失败点与断言一致（两份 spec 的 `callCount` / `audioFrameCount` 读到 0）。
2. **非 GOAL-038 四文件回归**：AC4 守卫空 diff；另在 `ec621a2b^`（`37937a38`）建的 scratch
   工作树上复跑同一命令**同样红** ⇒ 红早于 GOAL-038 实现落地。
3. **机制 + 反证**：`15a30dcf`（2026-10-10 21:05:53）让服务端对 `hello` 默认回
   `ready{protocol:'segmented-v1'}`，浏览器默认走分段上行；spec 的 `speak()` 每次
   `samples.fill(0.3)` 发**平直常数块**，`StreamingVad` 对平直信号判静音（见 memory
   `streaming-vad-flat-tone-is-silence`）⇒ 不开段、不上行 ⇒ 上游 `audioFrameCount()=0`。
   同一条命令加 `VOICE_REALTIME_MODE=continuous`（回退路径）⇒ **exit 0、14 passed (58.8s)**。
   ⇒ 红由「默认为 segmented」触发，与 deadline **无关**。

### AC1–AC3 / AC5–AC6 / AC8 为何**不勾**

- **AC1**（声明 `timeoutMs`）：其机械判据是「值 > CMD1–CMD4 实测冷串行墙钟且 < 120000」。
  按判据命令**原样**（默认模式）实测串行 = **139279ms > 120000** ⇒ 此刻**不存在**任何合法取值；
  107752ms 只是 CMD1 走回退路径的**代理**读数，并非判据命令的实测。故**不声明**——避免往 goal
  记录写一个未能在判据命令上复现的读数。
- **AC2**：CMD1 默认模式 exit 1（非 0）⇒ 不成立。
- **AC3**（闸自证 pass）：CMD1 红 ⇒ 闸报 `fail`；又因判据串行 139279ms > driver 的 120000ms spawn
  上限，闸在写 pass 前先被杀 ⇒ 写不出 pass。
- **AC5**（假形态 A：删 `timeoutMs` ⇒ `timed out after 60000ms`）：需先有合法声明、闸能跑出 pass
  基线；前置不成立。
- **AC6**（假形态 B：`h-16`→`h-20` ⇒ CMD1 红 ⇒ 还原回绿）：CMD1 已恒红，「注入⇒红」这半无信息量、
  「还原⇒绿」这半不可达 ⇒ 闭环不成立。
- **AC8**（隔离性：diff 恰为 `goals/AC-331-…` + 本任务文件）：本任务未改 `goals/AC-331`（未声明
  `timeoutMs`）⇒ 按原文「恰好只有 `goals/AC-331`（+ 本任务文件）」不成立。

### blocker 与交人建议

- **blocker**：AC-331 判据的 **CMD1 在 develop 上确定性红**，源于上游回归
  `gap-voice-realtime-e2e-specs-red-under-default-segmented-mode`（`goal_ac: AC-319`，todo）。
  在它修复前，AC-331 的闸恒不 pass，且 deadline 也无法用**判据命令的真实绿读数**定值（串行 139279ms）。
- **交人步骤**：①先落 `gap-voice-realtime-e2e-specs-red-under-default-segmented-mode`；
  ②其后在同一树上复跑 CMD1 取**真实绿**墙钟（估 ≈59s），与 CMD2–CMD4 求和得**判据命令上的真 floor**
  （估 ≈107–108s）；③按 AC-323 先例在 `goals/AC-331-…-ex.md` 声明 `timeoutMs`（估 115000–119000，
  须 > 真 floor 且 < 120000）；④重跑本任务 AC1–AC6 / AC8。
- 本任务经 Provider ABI（`quay task edit --body-file`）置 `needs-human`；未改 `criterion` / `expect`
  一字，未改四文件 / 任何 spec / 产品代码；工作树 `git status --porcelain` 为空。


（活体复现，2026-10-11T03:11:05Z）在工作树（HEAD = develop `6395f859`）跑 `quay goal gate AC-331 --dry-run --root <wt>`：`verdict: "not-evaluated"`、`cause: "timeout"`、`timeoutMs: 60000`、`evaluationRoot` = 本工作树、`treeSha: e054ccf5…`。⇒ 闸在默认 60000ms 下先超时被杀（CMD1 单条就 91155ms > 60000ms），连 CMD1 的红都还没机会被记为 `fail`——原症状（`not-evaluated(timeout)`）活体复现。把 deadline 提到 > CMD1 串行才会把「红」显形为 `fail`；无论哪种，闸都写不出 `pass`。本次 `--dry-run` 未写账本。