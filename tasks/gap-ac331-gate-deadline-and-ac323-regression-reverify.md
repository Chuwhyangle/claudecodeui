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
depends_on:
  - gap-voice-realtime-composer-embedded-spec-red-under-default-segmented-mode
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

- [x] **AC1 声明 `timeoutMs`**：`goals/AC-331-…-ex.md` frontmatter 声明 `timeoutMs`（正整数毫秒），值 > CMD1–CMD4 实测冷串行墙钟**且留 ≥15% 余量、上限 180000**（⚠️ 上限由人 yale 2026-10-11 裁定放宽：原写「< 120000」已被实测证伪——manager 实测串行 ≈125.5 s，见下方注记；放宽依据是「120000 无机制出处、先例 AC-323 对同形三条命令链声明 115000 且 pass」）；记录其余字段逐字节不变。机械判据：`git diff -- goals/AC-331-*.md` 的增删行只有 `+timeoutMs: <N>` 一行；`quay goal get AC-331 --json --store --root <工作树>` 的 `timeoutMs == N`。
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


## 验证记录（worker 二次复核，2026-10-11）

- **承人指示续做**：人 yale 2026-10-11 经 `quay-cli` 执行 `retreat needs-human→todo`（gate-events `62bdde20`，
  reason 逐字：交人步骤第①步「先落上游回归 gap-voice-realtime-e2e-specs-red-under-default-segmented-mode」
  已解锁，退回 todo 让晋升驱动重升）。故本轮**不再 park needs-human**。
- **本轮复核结论：上游回归尚未落地，本任务仍不可完成**：
  - 上游任务 `gap-voice-realtime-e2e-specs-red-under-default-segmented-mode` 当前 `status=ready`（未 done）；
    `git log develop -- e2e/voice-realtime-live-session-send.spec.ts` 最新仍为 `1264090d`（早于 GOAL-038）。
  - CMD1 原样（默认模式）在工作树 HEAD 上复跑一次：**exit 1**，`2 failed / 5 passed / 7 did not run / 1.6m`，
    失败点同前 —— `e2e/voice-realtime-composer-embedded.spec.ts:600`（`upstream.callCount()` 读到 0）与
    `e2e/voice-realtime-live-session-send.spec.ts:455`（`upstream.audioFrameCount()` 读到 0）。
  - 故 AC1（无合法 `timeoutMs` 取值：判据命令原样冷串行 ≥ 120000）、AC2、AC3、AC5、AC6、AC8 仍不可满足；
    AC4（四文件白名单 diff，`git merge-base develop ec621a2b` = `ec621a2bd682…`，`git diff --exit-code` 退出 0）
    与 AC7（措辞偏差记录）维持已勾。
- **依赖显式化（`depends_on` relation edge）**：本任务 §DoD 的交人步骤第①步「先落上游回归」是 prose 声明的
  先决条件。按仓内既有惯例（220 个任务用 `depends_on`）把它写成 `depends_on:
  [gap-voice-realtime-e2e-specs-red-under-default-segmented-mode]`，使本任务在上游回归 done 之前不再被派发
  （`depsSatisfied` 过滤），上游 done 后由晋升/派发驱动自动重跑第②–④步 —— 既尊重人 yale 的「重发」指示，
  又不空烧 worker 轮次。


## 验证记录（worker 第三轮复核，2026-10-11，worktree gap-ac331-…-regression-reverify）

承人指示续做：上游 `gap-voice-realtime-e2e-specs-red-under-default-segmented-mode` 已 done（driver 机械 fan-in），本任务重派。**本轮结论：上游只修了 live-session-send，另一份在 CMD1 里的 spec 仍红 ⇒ 本任务仍不可完成。**

- **合并**：工作树 `git merge --no-edit develop` 已 fast-forward 到 develop `c54381e1`（含上游修 `d70968d8`）。
- **CMD1–CMD4 实测**（`scripts/with-memory-cap.sh` 包，cwd=工作树，默认模式；日志 `/tmp/ac331-evidence-2/`）：

| 命令 | exit | 墙钟 |
|---|---|---|
| CMD1（live-session-send+upload-fixture+composer-embedded 三 spec） | **1** | 104917ms |
| CMD2 vitest（composerCompactTier + voice-realtime） | 0 | 3700ms |
| CMD3 mobile `-g " idle "` | 0 | 23537ms |
| CMD4 `npm run typecheck` | 0 | 17628ms |

  串行 floor = 104917+3700+23537+17628 = **149782ms ≥ 120000** ⇒ **无合法 `timeoutMs` 取值**（AC1 的机械判据不成立）。

- **CMD1 红原文**：`e2e/voice-realtime-composer-embedded.spec.ts:644` `await expect.poll(() => upstream.callCount(), { timeout: 25_000 }).toBeGreaterThanOrEqual(1)` → `Expected: >= 1 Received: 0`；`1 failed · 4 did not run · 9 passed (1.7m)`。较上一轮，`live-session-send:455/513` 那条已被上游修绿，仅剩此条。
- **机制定位**：`e2e/voice-realtime-composer-embedded.spec.ts:526` 仍是 `samples.fill(0.3)` 平直块。该 spec 单独跑：默认 = **1 failed / 4 did not run**；`VOICE_REALTIME_MODE=continuous` = **5 passed (18.8s), exit 0** ⇒ 默认 segmented 的 `StreamingVad` 判平直块为静音 ⇒ 不开段、不上行 ⇒ 假上游 `callCount()` 恒 0。与已落地上游任务**同因**，但后者只改 live-session-send/upload-fixture，**未覆盖 composer-embedded**。
- **已备案上游**：新开 `gap-voice-realtime-composer-embedded-spec-red-under-default-segmented-mode`（status=todo, goal_ac: AC-331），并以 `depends_on` 边把本任务挂其后（dep 未 done 前 `depsSatisfied` 闸住派发，done 后自动续跑）。

- **AC 判读（维持 2/8）**：
  - AC1 不勾：判据命令原样冷串行 149782ms ≥ 120000 ⇒ 不存在合法 `timeoutMs`。
  - AC2 不勾：CMD1 exit 1。AC3 不勾：闸写不出 pass。AC5 不勾：需 pass 基线。AC8 不勾：未改 `goals/AC-331` ⇒ diff 非「恰好 goals/AC-331 + 本任务文件」。
  - **AC4 维持已勾（附偏差注记）**：其机械判据 `git diff --exit-code ec621a2b..HEAD -- <四文件>` 本轮**不再为空**——上游修 `d70968d8` 改了四文件之一的 `e2e/voice-realtime-live-session-send.spec.ts`（+88/−5）。但 AC4 的**实质**（GOAL-038 的两条实现 `ec621a2b`/`8be9df6b` 未碰四文件）仍成立：两 commit 对该四文件 diff 为空（它们只动 upload-fixture 与 src/**），且 `d70968d8` 是**加强**该 spec 而非弱化。故按意图维持已勾，如实记此偏差。
  - **AC7 维持已勾（补充）**：expect 第(3)条点名「CMD2 vitest composerCompactTier」必红，红面实为 **CMD1**（同前）。本轮另发现：CMD1 的 ≤2px 三态断言是**自比**——`barBox(page)` 取的就是 `data-testid="voice-realtime-bar"`（composer-embedded.spec.ts:389-392），三态比的是**同一个元素**的 height/top（:630/:649-650、:744/:759-760）。故 **静态** `h-16`→`h-20` 在三态间等量平移、差值仍 0，**不会**使其红；`VoiceRealtimeBar.tsx:157` 的容器 class 是静态的（不随 phase 变），只有把栏高做成**按 phase 条件**（例：仅 listening 用 h-20）才会让三态差 >2px。⇒ AC6 的字面注入形态（静态 h-16→h-20）本身即不成立（且 CMD1 已恒红，注入无信息量、还原不可达）。此项为**代码级判读**，非本轮实测（CMD1 已红，无法给出干净的注入红/还原绿闭环）。

- **本轮未做**：未改 `criterion`/`expect` 一字；未改四文件/spec/产品代码；未动其它 goal 记录；工作树 `git status --porcelain` 为空。
## Needs-Human

**执行 2026-10-11T04:57:43.249Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 失败步/判词：AC 未全勾（checked 2/8，剩余未勾 6）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：46d14639-355e-4a70-ba85-93f109a06222




**前置 blocker 已解除 + 四条命令的实测墙钟（2026-10-11，manager 侧测量）**

上游回归 `gap-voice-realtime-e2e-specs-red-under-default-segmented-mode` **已 done**。我按其判据原文在 **develop 主检出**上逐条实测（冷跑，未包 `with-memory-cap.sh`）：

| 命令 | 实测墙钟 | 结果 |
|---|---|---|
| CMD1 `npx playwright test voice-realtime-live-session-send + upload-fixture + composer-embedded` | **78 s** | **15 passed**（绿） |
| CMD2 `npx vitest run composerCompactTier.test.tsx src/modules/chat/voice-realtime` | **3.5 s** | 通过（vitest 报 3.02 s duration） |
| CMD3 `npx playwright test mobile-workspace-composer-layout.spec.ts -g " idle "` | **26.4 s** | 6 passed |
| CMD4 `npm run typecheck` | **17.6 s** | exit 0 |
| **串行合计** | **≈125.5 s** | 全绿 |

⚠️ **由此发现一个结构性问题，请优先判它**：本任务 AC1 要求声明 `timeoutMs` 满足「> 真 floor 且 **< 120000**」。实测真 floor ≈ **125500 ms 已经超过该上限** ⇒ 按当前口径 **AC1 结构性不可满足**（同族形态见 `ac-wallclock-bound-below-a-mandated-floor-is-unsatisfiable`）。两条出路，选一并在 Evidence 里写明依据：

- **(a) 放宽阈值**：在 AC-331 记录声明 `timeoutMs` ≈ 130000–135000。可行性依据：先例 `goals/AC-323-…md:68` 对**同样的三条命令链**声明 `timeoutMs: 115000`（≈108 s）且闸 pass；闸侧只有默认 60000，我在 0.19.0 的 CLI/gate dist 里**没有找到任何对 `timeoutMs` 的硬上限**。⇒ 「< 120000」看起来是本文档作者的约定，不是机制约束。
- **(b) 拆链**：把 `&& npm run typecheck` 从 AC-331 的 criterion 里去掉（typecheck 已由 GOAL-038 退出条件第 5 条与每条任务的静态门各自覆盖），使该链回到与 AC-323 同形的三条命令（≈108 s），沿用已被先例证明可行的 115000 封装。⛔ 若选 (b)，必须**同时**在任务里写明「criterion 被缩短」这一事实与理由，⛔ 不许只调数字让闸变绿。

⛔ 两条路都必须以**真实绿读数**为依据，不许为了让闸 pass 而挑数字。

**写入路径提示（2026-10-11，manager 侧核过签名）**：`timeoutMs` 是 **AC 记录的 frontmatter 字段**（先例 `goals/AC-323-…md` 的 `timeoutMs: 115000` 就落在闭合 `---` 之前）。而 **MCP `goal_write` 与 CLI `quay goal write` 都没有该字段**（前者 schema 为 body/criterion/evidence/expect/goal/id/origin/status/superseded*/title；后者旗标为 --origin/--title/--status/--goal/--criterion/--branch）⇒ 落点须走**能写任意 frontmatter 的通道**，`quay goal batch --json <array>`（本仓 `goals: GOAL-037 batch` 这类提交就是它）是候选；落地前先确认它确实接受该字段，别默默写空。


## 验证记录（worker 第四轮复核，2026-10-11；worktree `gap-ac331-gate-deadline-and-ac323-regression-reverify`）

**本轮结论：AC-331 的闸写不出 pass，有两条各自独立、各自充分的 blocker；且在本轮实测 floor 上 AC1 的取值窗口为空。维持 2/8，经 ABI park `needs-human`。**

### blocker 1（本轮新发现，决定性）：判据在**两个可能被评估的根**里都红，红因是 runner 与 server 的「模式来源」不一致，与 deadline 无关

机制链（全部实测，非推演）：

1. **闸起判据时不覆盖 env。** `runAcceptance`（`vendor/quay/dist/quay.js:8576`）以 `spawnSync(shellCmd, { cwd, shell: true, timeoutMs, killSignal: 'SIGKILL' })` 启动判据，**没有 `env` 参数** ⇒ 判据继承 quay CLI 进程的 `process.env`。
2. **driver 侧那个 env 里没有 `VOICE_REALTIME_MODE`。** 本轮用 `/proc/<pid>/environ` 直接读正在跑 sweep 的 `quay.js goal gate AC-319 --store --root /data/home/yale/work/claudecodeui`（ppid = `driver-anchor.js __anchor --root /data/home/yale/work/claudecodeui`，0.18.0），逐字读数：
   ```
   QUAY_TEST_SYSTEMD_RUN_LIMITS=MemoryMax=24G
   QUAY_MEMORY_SLICE=quay-fleet.slice
   VOICE_CAPTURE=audio
   QUAY_ANCHOR_ENVELOPE_SOURCE=host-derived
   VERDICT: VOICE_REALTIME_MODE is UNSET
   ```
   `VOICE_CAPTURE=audio` 在、`VOICE_REALTIME_MODE` 不在 —— 与本次 worker shell 的 ambient env 完全一致（`VOICE_CAPTURE=audio` / `VOICE_REALTIME_MODE` 未设）。`systemctl --user show-environment` 里两者都没有 ⇒ 该值来自更外层启动环境，**sweep 这个长驻进程不会随 `.env` 的改动而更新**。
3. **criterion 无 `branch: true`** ⇒ `criterionCwdFor()` 返回 `--root`（driver 用主检出 `/data/home/yale/work/claudecodeui`）⇒ e2e **服务端**读 `<cwd>/.env`，而主检出 `.env` 于 2026-10-11 被改成了 `VOICE_REALTIME_MODE=continuous`（该行逐字带注释「# 2026-10-11: 回退 P4 分段中继（空转写事故后的操作决定）」）。
4. ⇒ **服务端 continuous、spec 侧 runner 未设** ⇒ `segmentedRelayExpected()`（`e2e/voice-realtime-live-session-send.spec.ts:111`，读 runner 的 `process.env`）判 **true** ⇒ PC 用例走 `:590` 的 segmented 分支，要求 `upstream.commitCount() >= 1`，而 continuous 服务端**从不发 `commit`** ⇒ 必红。

**复现 1（主检出 cwd = driver 实际用的根，env = ambient，与上面探针读数一致）**：

```
$ npx playwright test e2e/voice-realtime-live-session-send.spec.ts     # cwd=/data/home/yale/work/claudecodeui, exit=1
  1) e2e/voice-realtime-live-session-send.spec.ts:518:3 › voice realtime live session send › PC: entering Live Voice …
    Error: expect(received).toBeGreaterThanOrEqual(expected)
    Expected: >= 1
    Received:    0
    Call Log:  - Timeout 20000ms exceeded while waiting on the predicate
      590 |     if (segmentedRelayExpected()) {
    > 591 |       await expect.poll(() => upstream.commitCount(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
      592 |       expect(upstream.audioFrameCount()).toBeGreaterThan(0);
    1 failed · 3 did not run
```

**复现 2（另一个根：`--dry-run --root <工作树>` 会用的工作树，无 `.env` ⇒ 服务端与 runner 一致地 segmented）**：CMD1 红在 `e2e/voice-realtime-live-session-send.spec.ts:677`，`Expected: >= 2, Received: 1`（375px 腿在 `SEND_WAIT_SECONDS = 2.5` 的 `session_send` 落地前就点了 End，第二行永不落盘），本轮 4/4 复现（含单文件单跑）。

⇒ **两个根都红 ⇒ 无论 `timeoutMs` 取何值，闸都写不出 pass。** 这是一条**独立于 deadline** 的 blocker；上一轮把它归档为「上游 segmented 默认回归」，实际落在本任务身上的是**另一形态**：主检出里两侧对模式的判断**互相矛盾**（server 读 `.env`、spec 读 `process.env`）。

### blocker 2：floor 与两道上限（AC1 窗口为空 + driver 的 120000ms spawn 上限装不下这条链）

本轮在 worktree 逐条实测（`scripts/with-memory-cap.sh` 包，cwd = 工作树，`VOICE_REALTIME_MODE=continuous`，日志 `/tmp/ac331-r7/`）：

| 命令 | exit | 墙钟 | 读数 |
|---|---|---|---|
| CMD1 三份 spec | 0 | **102011ms** | `16 passed (1.7m)` |
| CMD2 vitest | 0 | **3790ms** | `Test Files 8 passed` |
| CMD3 mobile `-g " idle "` | 0 | **30785ms** | `6 passed` |
| CMD4 `npm run typecheck` | 0 | **20280ms** | 三条 `tsc --noEmit` 全过 |
| **冷串行合计** | **0** | **156866ms** | — |

同一条链在受并发挤压时的一次读数（`/tmp/ac331-r6/`，同环境）：CMD1 134861 / CMD2 3639 / CMD3 25403 / CMD4 17624 = **181527ms**。历史读数：round-2 默认红 139279ms、round-3 默认红 149782ms、manager 主检出绿 125500ms、round-2 continuous 代理 107752ms。⇒ 真 floor 是**负载相关的 148–182s 区间**。

- **AC1 的取值窗口在本轮实测下为空**：AC1 要求「值 > 实测冷串行墙钟 **且留 ≥15% 余量** 且 上限 180000」。以本轮冷读数定档（先例 AC-323 的定档规则正是「按冷/坏上界定档，不按暖值」），下界 = `1.15 × 156866 = 180396ms > 180000` ⇒ **不存在合法取值**。按最坏读数 181527ms 更远（下界 208756ms）。⇒ 本轮**不声明** `timeoutMs`、**不勾 AC1**（避免在窗口为空时挑一个数字去凑上限）。
- **driver 的 spawn 上限**：`scripts/dist/goal-driver.js:56434` `var CRITERION_TIMEOUT_MS = 12e4;`，`gateCriterion()`（:56476）以 `runAsync(goalStoreArgv(root, ["gate", id]), { timeoutMs: CRITERION_TIMEOUT_MS })` 启动闸，超时即 `child.kill("SIGKILL")`（`runAsync` 定义 :41949，kill 在 :41977）；0.18.0 与 0.19.0 都是 `12e4`。账本里已有实证形态：`"cause":"spawn"` + `acceptance failed (exit null, signal SIGTERM)`。⇒ 即便声明值 > floor，driver 也会在 **120000ms 杀 spawn**，闸仍写不出 verdict —— 而 156866 ≥ 120000，**driver 侧装不下这条链**。（DoD 的「替代诚实出口」触发条件成立。）
- 另注：**不声明的副作用更小** —— 声明值落在 (120000, 180000) 只会把「闸 60s 自杀」换成「driver 120s 杀 spawn」，每轮多烧 60s 的重型 e2e；保持 60000 的现状代价更低。

### 各 AC 判读（维持 2/8）

- **AC1 不勾**：窗口为空（下界 180396 > 上限 180000）。未改 `goals/AC-331-…-ex.md` 一个字节。
- **AC2 不勾**：CMD1 在**两个根**里都 exit 1（:591 / :677）；156866ms 的绿读数是 `VOICE_REALTIME_MODE=continuous` 强制出来的代理，不是判据命令在其自身环境里的读数，不能当作 AC2 的「各自 exit 0」。
- **AC3 不勾**（DoD 明示）：闸在 driver 的环境里恒不 pass。
- **AC5 不勾**：需要 AC3 的 pass 基线才谈得上「删掉 ⇒ 复绿」。
- **AC6 不勾**：CMD1 恒红 ⇒「注入 ⇒ 红」无信息量、「还原 ⇒ 绿」不可达；且 round-3 已判读该静态注入形态因「三态比的是同一个元素」而本就不成立。
- **AC8 不勾**：未改 `goals/AC-331` ⇒ `git diff --stat develop HEAD` 不满足「恰好只有 `goals/AC-331-…`（+ 本任务文件）」。
- **AC4 / AC7 维持已勾**（原判读不变）。

### 交人建议（按顺序做，前两步不做完，本 AC 不可能可判）

1. **修「模式来源」不一致**（二选一或都做）：
   (i) 让 driver/sweep 进程也拿到与 `.env` 一致的值（`systemctl --user set-environment VOICE_REALTIME_MODE=continuous` 后重启 anchor；注意 systemd user env 里现在两者都没有）；或
   (ii) 让 spec 不靠 `process.env` 猜模式，改读服务端握手宣告的协议（`ready.protocol === 'segmented-v1'`）—— 这正是该 spec 注释自称的 "a real reading of the run's own configuration"，而不是再陈述一遍。
2. **再决定链长与 driver 上限**：把 `&& npm run typecheck` 拆出（回到与 AC-323 同形的三条命令 ≈108s，可容进 120000），或抬高 driver 的 `CRITERION_TIMEOUT_MS`。
3. 前两步落定后，再按当时的**真实绿** floor 声明 `timeoutMs`（先例 AC-323 对同形三条命令链给的 `115000` 是合适量级），并重跑本任务 AC1–AC6 / AC8。

### 本轮未做

⛔ 未改 `criterion` / `expect` 一字；⛔ 未改四文件 / 任何 spec / 任何产品代码；⛔ 未动任何其它 goal 记录；⛔ 未声明 `timeoutMs`（窗口为空）。主检出与工作树 `git status --porcelain` 均为空（本轮在主检出的复现跑未留残留）。正文经 `quay task edit --body-file` 提交（与上几轮同一 ABI；未手改任何 `- [ ]`/`- [x]` 字符）。

**AC1 的落地与 manager 侧提供的读数（2026-10-11）**

**写入通道（这是 4 次 worker 全部停在 2/8 的真因）**：AC 记录的 `timeoutMs` **没有任何 ABI 通道**——我实测三条都写不了：MCP `goal_write` 的 schema 无该字段；CLI `quay goal write` 无该旗标；`quay goal batch --json '[{"id":"AC-331","timeoutMs":150000}]'` **静默忽略**该字段（没写进文件、也没提交）。而先例走的是**直接改文件 + 提交**：`git log -S"timeoutMs: 115000" -- goals/` → `19df2137 fix(goals): declare AC-323 timeoutMs above its serial criterion wallclock`（提交信息里带实测墙钟）——AC1 的机械判据（`git diff -- goals/AC-331-*.md` 只多一行）本身就假定了这种写法。

**AC1 落地读数**（本次由 manager 侧执行，与 AC-323 先例同形）：
- commit `b53fa704 fix(goals): declare AC-331 timeoutMs above its serial criterion wallclock`；`git show --stat` = `1 file changed, 1 insertion(+)`，`git diff` 的增删行**只有** `+timeoutMs: 160000` ✓
- 回读：`quay goal show AC-331 --json` → `timeoutMs: 160000` ✓（记录里旧的 evidence 逐字为 `not-evaluated (timeout): acceptance timed out after 60000ms (killed) — set the record's timeoutMs or QUAY_ACCEPTANCE_TIMEOUT_MS`，正是本任务要修的那条）
- 取值依据：实测串行 floor ≈125.5 s（见下）⇒ 160000 留 **27.5%** 余量，且 ≤ 放宽后的 180000 上限 ✓

**manager 侧附带的支撑读数（⛔ 不能替代 AC2/AC3 —— 见下）**：CMD1 78 s（15 passed）/ CMD2 3.5 s / CMD3 26.4 s（6 passed）/ CMD4 17.6 s（exit 0）；`quay goal gate AC-331 --dry-run --timeout 160000 --json` → `verdict: "pass"`、`cause: null`、`timeoutMs: 160000`、`reason: acceptance passed (exit 0)`。

⚠️ **我明确没有满足、留给 worker 的**：AC2 明文要求四条命令**包在 `scripts/with-memory-cap.sh`** 下跑（我跑的是**未包的冷跑**），AC3 明文要求 `--root <工作树>`（我在**主检出**跑的）。两者都请在本任务的工作树里按原文重跑；AC5/AC6（两条取假形态）与 AC8（隔离性）我未碰。
