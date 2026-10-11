---
id: gap-ac332-gate-and-ac323-second-segment-reverify
title: AC-332 判据（CMD2 vitest + CMD3 mobile -g idle + CMD4 typecheck，逐命令带
  VOICE_REALTIME_MODE=continuous）无任务以 goal_ac 认领：在 GOAL-038 实现落地树上复验三链全绿（段串行
  ≈47.6s < 声明 timeoutMs 100000）、闸 --dry-run 写出 pass、四文件白名单守卫、CMD2 紧凑栏判别力假形态
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-332
---
## Proposal

（去重 / 粒度）<!-- dedup-ref --> 本任务与现存任务的关系：仓内**无任何任务以 `goal_ac: AC-332` 认领本 AC**（`grep -l '^goal_ac: AC-332' tasks/*.md` 为空）；只有两处**散文提及**——`gap-ac331-gate-deadline-and-ac323-regression-reverify`（`goal_ac: AC-331`）的 `## AC` 口径变更块把本段列为「AC-332 段」，`gap-voice-realtime-live-session-send-375px-red-under-default-segmented-mode`（`goal_ac: null`）的 expect 引用块提到本段判据范围。两者都**不认领** AC-332 ⇒ 本任务为新案。`task-granularity-advice` 对 `goals/AC-332-…md` + 本任务路径报 `peers: []`、`mentions: []`，无合并候选。**粒度决定：separate** —— AC-331 与本段各由一条 AC 记录承载，`goal_ac` 是单值、driver 按 AC 独立验证，两条记录必须各有认领任务，不能合并进 AC-331 的任务。

### 现状（2026-10-11 复核，主检出 HEAD `945ff390`）

AC-332（`goals/AC-332-…-typecheck.md`，`timeoutMs: 100000`）的 `criterion` 是三条命令的 `&&` 串行链（逐命令带 `VOICE_REALTIME_MODE=continuous`）：

```
CMD2 VOICE_REALTIME_MODE=continuous npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime
CMD3 VOICE_REALTIME_MODE=continuous npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "
CMD4 npm run typecheck
```

（1）**判据在当前 develop 树上逐条绿**（本次实测，`scripts/with-memory-cap.sh` 包、cwd = 主检出、每命令带 continuous；日志 `/tmp/ac332-c2..c4.log`）：CMD2 rc=0 3572ms（`Test Files 9 passed (9)`、`Tests 124 passed (124)`）、CMD3 rc=0 26555ms（`6 passed`）、CMD4 rc=0 17484ms（三条 `tsc --noEmit` 全过）；**段串行 47611ms < 100000ms**。⇒ 本段不存在 AC-331 式的 deadline 问题。

（2）**GOAL-038 实现未碰承重四文件**：`git diff --stat ec621a2b^..8be9df6b -- <四文件>` 为空（`ec621a2b` = AC-326 实现、`8be9df6b` = AC-327 实现）；CMD3 的被判对象 `e2e/mobile-workspace-composer-layout.spec.ts` 在白名单内，最后改动 `7fd3598b`（早于 GOAL-038）。

（3）**闸 reason 的一个误导性读数（须照实记）**：账本里 AC-332 唯一一条 goal 事件（`2026-10-11T09:57:28Z`、`verdict:"fail"`、tree `6d10f96`）的 `reason` 逐字引了 `src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts Error: Not implemented: HTMLCanvasElement.prototype.getContext`。复核确认这是 **`@xterm/xterm` / `@xterm/addon-webgl` 在 jsdom 下 module-eval 期的非致命 stderr**（本次 CMD2 复跑 3/3 均 rc=0，该报错仍打印 14 次），acceptance runner 把它当作**最大 stderr 块**展示，并非失败命令。❗ 不得据此把 CMD2 判红。

### 做法

1. 在**合并了 develop（含 GOAL-038 实现 `ec621a2b`/`8be9df6b`）的工作树**里，按判据原文（每命令带 `VOICE_REALTIME_MODE=continuous`）逐条跑 CMD2–CMD4，`scripts/with-memory-cap.sh` 包住，记 rc/墙钟/读数。
2. `quay goal gate AC-332 --dry-run --root <工作树>` 自证闸能写 pass。
3. 四文件白名单守卫（限定在 GOAL-038 自身实现提交，避开 GOAL-038 之后无关落地的改动）。
4. 假形态 A（deadline 敏感性）：用 `--timeout <低于 floor>` 显式压出 `not-evaluated(timeout)`；不带 `--timeout` 复绿。⚠️ 本段 floor ≈47.6s **< 默认 60000ms**，故 AC-331 的「删 `timeoutMs` 行」形态在本段**不产生** timeout，改用显式 `--timeout` 做确定性证明。
5. 假形态 B（CMD2 判别力）：把 `src/modules/chat/composer/ChatComposer.tsx:904` 紧凑分支的 `'flex-nowrap'` 改成 `'flex-wrap'` ⇒ `composerCompactTier.test.tsx` 的 `the compact row may not wrap` 断言必红（本次实测 `wrapTokens:["flex-wrap"]`）；`git checkout --` 还原回绿。

### 边界 / 不做

- ⛔ 不改 AC-332 的 `criterion` / `expect` 文本一个字，不删或弱化其中任何命令（尤其 CMD4 `npm run typecheck`）。
- ⛔ 不改四个白名单文件、任何 spec 或产品代码（第 5 条的临时注入测后 `git checkout --` 还原，`git status --porcelain` 为空）。
- ⛔ 不动任何其它 goal 记录。
- ⛔ 不靠前置/放宽 mode 或配置换绿——判据自身已显式声明它判断的配置。

## AC

- [x] AC1 判据三链逐条绿：在合并了 develop（含 `ec621a2b`/`8be9df6b`）的工作树里，以 `scripts/with-memory-cap.sh` 包住、判据原文逐字（每命令带 `VOICE_REALTIME_MODE=continuous`）跑 CMD2/CMD3/CMD4，三条**各 exit 0**；贴 CMD2 的 `Test Files 9 passed (9)`+`Tests 124 passed (124)`、CMD3 的 `6 passed`、CMD4 的三条 `tsc --noEmit` 原文；记各自墙钟，**段串行合计 < 100000ms**。若某条红，附失败原文并定位是负载/端口毛刺还是真回归（⛔ 不做归因就放过）。
- [x] AC2 闸自证：`quay goal gate AC-332 --dry-run --root <工作树>` exit 0，stdout JSON `verdict == "pass"`、`cause == null`、`timeoutMs == 100000`。原文贴 Evidence。
- [x] AC3 四文件白名单守卫：`git diff --exit-code ec621a2b^1 ec621a2b -- <四文件>` 与 `git diff --exit-code 8be9df6b^1 8be9df6b -- <四文件>` **均须为空**（`<四文件>` = `e2e/voice-realtime-live-session-send.spec.ts`、`e2e/voice-realtime-composer-embedded.spec.ts`、`e2e/mobile-workspace-composer-layout.spec.ts`、`src/modules/chat/tests/composerCompactTier.test.tsx`；`^1` 让 merge 提交取第一父）。如实记：相对 `$(git merge-base develop ec621a2b)..HEAD` 的 diff **非空**（三份白名单文件被 GOAL-038 之后的无关落地改过 `d70968d8`/`ec6b0145`/`d5f97823`），故按原意把 diff 限定在 GOAL-038 实现提交自身。
- [x] AC4 假形态 A（deadline 敏感性）：`quay goal gate AC-332 --dry-run --timeout 20000 --root <工作树>` ⇒ exit 非 0、`verdict == "not-evaluated"`、`cause == "timeout"`、reason 含 `timed out after 20000ms`；不带 `--timeout`（用记录 100000）⇒ 复绿（AC2 原文）。Evidence 须注明：本段 floor ≈47.6s **< 默认 60000ms**，故「删 `timeoutMs` 行」不产生 timeout，改用低于 floor 的显式 `--timeout` 做确定性证明。
- [x] AC5 假形态 B（CMD2 判别力）：`src/modules/chat/composer/ChatComposer.tsx:904` 紧凑分支 `'flex-nowrap'`→`'flex-wrap'` ⇒ CMD2 中 `composerCompactTier.test.tsx` 的 `the compact row may not wrap` 断言必红，贴失败断言原文（`wrapTokens:["flex-wrap"]`）与文件名/行号；`git checkout --` 还原 ⇒ CMD2 复绿、`git status --porcelain` 为空。
- [x] AC6 隔离性：`git diff --stat develop HEAD` 恰为 `tasks/gap-…（self）`（若因「段串行 ≥ 声明值」需调 AC-332 记录的 `timeoutMs`，只允许多 `+timeoutMs: <N>` 一行）；`goals/` 下其它记录 diff 为空；`git status --porcelain` 为空（注入已还原）；未改 `criterion`/`expect` 一字、未改四文件/任何 spec/产品代码。

## DoD

在带可写 `.quay/` 的根真实跑 `quay goal gate AC-332`（非 `--dry-run`）拿到 `verdict: "pass"` 的 GateEvent 并留原文，AC-332 的 `status` 随之翻 `achieved`（driver 下一轮亦会独立复验：本任务携带顶层 `goal_ac: AC-332`，readTaskFacts 计数到它）。三条判据命令各跑一次、记 wall time 与 exit code。一次假形态（CMD2 紧凑栏判别力）现场红、还原绿，原始输出留档。Evidence 逐条记明：(a) 段串行 floor 与 100000ms 的余量；(b) 默认 60000 与本段 floor 的关系（47.6s < 60000 ⇒ 删行不产 timeout，故 AC4 用 `--timeout` 显式证明）；(c) `@xterm` jsdom canvas stderr 为非致命噪声、且曾被 gate reason 当证据展示这一误导；(d) 四文件守卫结果与所用的提交对。

## Evidence

**树 / 环境**：工作树 `/data/home/yale/work/claudecodeui-worktrees/gap-ac332-gate-and-ac323-second-segment-reverify`，分支 `task/gap-ac332-gate-and-ac323-second-segment-reverify`。⚠️ 本轮 develop 推进了两次，读数取在**最终合并树** `13ede961`（tree `604e7289`，含 AC-326 实现 `ec621a2b`、AC-327 实现 `8be9df6b`）；此前在 `8d9815a4`/`1b2aba45` 上的同形读数一并列出作佐证，三次全绿。除注明外，cwd = 工作树、`scripts/with-memory-cap.sh` 包住、逐命令前置 `VOICE_REALTIME_MODE=continuous`。

**AC1**（最终树 `13ede961`）
```
CMD2  rc=0  3655ms   Test Files  9 passed (9) / Tests  124 passed (124) / Duration 3.08s
CMD3  rc=0  25441ms    6 passed (24.6s)
CMD4  rc=0  18574ms  > tsc --noEmit -p tsconfig.json && tsc --noEmit -p server/tsconfig.json && tsc --noEmit -p scripts/tsconfig.json
```
CMD4 是 `&&` 链，rc=0 ⇒ 三条 `tsc --noEmit` 各 exit 0。**段串行合计 47670ms < 100000ms**（余量 52330ms，≈2.10×）。佐证：`1b2aba45` → 4118/27538/19346 = 51002ms；`8d9815a4` → 4184/28306/19265 = 51755ms。三条命令三次树、共 9 次执行**无一条红** ⇒ 无需归因。
`(c)` 噪声：CMD2 日志里 `Not implemented: HTMLCanvasElement.prototype.getContext` 打印 **14 次**而 rc=0 —— 与 Proposal (3) 一致：`@xterm` 在 jsdom 下 module-eval 期的非致命 stderr，⛔ 不得据此判红。

**AC2**（最终树，`--dry-run`）exit 0，墙钟 47294ms：
```json
{"id":"AC-332","verdict":"pass","cause":null,"reason":"acceptance passed (exit 0)","timeoutMs":100000,"dryRun":true,
 "event":{"id":"55a1c189-3cff-4fc1-829f-c7634e00069a","gate":"goal","actor":"goal-cli","verdict":"pass",
          "payload":{"reason":"acceptance passed (exit 0)",
                     "evaluationRoot":"/data/home/yale/work/claudecodeui-worktrees/gap-ac332-gate-and-ac323-second-segment-reverify",
                     "treeSha":"604e72891bed6020722b81687ef475d794620d2f"}}}
```
`treeSha` = 工作树 HEAD 的 tree ⇒ 判的是本工作树。

**AC3**
`git diff --exit-code ec621a2b^1 ec621a2b -- <四文件>` → rc=0、无输出；`git diff --exit-code 8be9df6b^1 8be9df6b -- <四文件>` → rc=0、无输出 ⇒ **两条守卫均空**。
如实记（AC3 原文要求）：`git merge-base develop ec621a2b` = `ec621a2bd6821fcb4f051efad04fac91544efbb9`（即 `ec621a2b` 自身），故 `ec621a2b..HEAD` 的 diff **非空**——`e2e/voice-realtime-composer-embedded.spec.ts |43 +`、`e2e/voice-realtime-live-session-send.spec.ts |93 +`、`src/modules/chat/tests/composerCompactTier.test.tsx |73 +`（3 files changed, 199 insertions(+), 10 deletions(-)），由 GOAL-038 之后的**无关落地** `d70968d8` / `ec6b0145` / `d5f97823` 所改（`src/modules/chat/composer/**` 与三份白名单文件之外的产品代码未被 GOAL-038 碰过）。⇒ 按原意把 diff 限定在 GOAL-038 实现提交自身，两条守卫均为空。

**AC4**（⚠️ **判据文本的机制前提被实测证伪，偏差照实记在此**）
AC4 指名的命令在**记录带着 `timeoutMs` 时不会产生 timeout**：
```
$ quay goal gate AC-332 --dry-run --timeout 20000 --root <工作树>        # 记录原样
  → exit 0, verdict:"pass", cause:null, timeoutMs:100000                 # 最终树 10:35Z
```
三棵树共 **4 次**同形复跑，读数一致（`8d9815a4` 10:21:42Z、10:22:28Z；`1b2aba45` 10:31Z；`13ede961` 10:35Z）。原因（源码）：`goal gate` 用 `resolveAcceptanceTimeout(rec.timeoutMs)` 定死线，实际优先级是 **记录 `timeoutMs` > `$QUAY_ACCEPTANCE_TIMEOUT_MS`（`--timeout` 写的正是它）> 60000**（`plugin/scripts/dist/cap-from-gate.js:36675` 定义、`:39039` 调用点；`timeoutKnobHint` 的 `case "record"` 返回 "raise this record's `timeoutMs` (the deadline in force)"）。CLI `--help` 写的是「`--timeout <ms>` > `QUAY_ACCEPTANCE_TIMEOUT_MS` > 60000」，**不含记录这一档 ⇒ 帮助文本与实现不符**（本任务按边界不修，另案）。
⇒ 指定红臂改用 AC-331 兄弟任务已验证过的「删 `timeoutMs` 行」形态 + 本 AC 指定的显式低 `--timeout`（**只**在工作树副本上删该一行）：
```
$ quay goal gate AC-332 --dry-run --timeout 20000 --root <工作树>        # 记录 timeoutMs 行已删
{"id":"AC-332","verdict":"not-evaluated","cause":"timeout",
 "reason":"not-evaluated (timeout): acceptance timed out after 20000ms (killed) — raise QUAY_ACCEPTANCE_TIMEOUT_MS",
 "timeoutMs":20000, ...}                                                # exit 1, 墙钟 20237ms
```
⇒ 本 AC 要求的四个读数（exit 非 0 / `not-evaluated` / `cause:"timeout"` / reason 含 `timed out after 20000ms`）**全部取得**。唯一偏差：记录级 `timeoutMs` 那一行必须先离开，`--timeout` 才在效——**这本身就是本条要记的发现**。还原：`git checkout -- goals/`，`sha256` 前后同为 `a7584c0675d40eb48c6dffbdbf3f02137fdce8363467953ef63cd0c98e83aa19`。复绿（记录还原、不带 `--timeout`）：exit 0、`pass`、`cause:null`、`timeoutMs:100000`（= AC2 原文）。
`(b)` **AC 文本「floor < 默认 60000 ⇒ 删行不产 timeout」这一理由不稳健，照实记**：同树 gate 墙钟实测 **47294ms**（dry-run）、**49978ms**（真闸）、更早一次 **61724ms** —— 最后这次 **> 60000ms**。即本段 floor 横跨 60000ms 默认线，删行后是否 timeout 取决于当时负载，并非结构性不可能。⇒ 本段真正的余量是记录 `timeoutMs: 100000`（对最高样本 ≈1.6×）与 goal driver 的 `CRITERION_TIMEOUT_MS = 12e4` 硬闸（对最高样本 ≈1.9×）。

**AC5**（最终树，现场红 → 还原绿）
`src/modules/chat/composer/ChatComposer.tsx:904` 由 `isCompactTier ? 'flex-nowrap' : 'flex-wrap gap-y-1',` 改为 `… 'flex-wrap' …`：
```
$ VOICE_REALTIME_MODE=continuous npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime
  → rc=1, 3553ms
FAIL  src/modules/chat/tests/composerCompactTier.test.tsx > (a) a wide window with a box under the threshold takes the compact arrangement
AssertionError: the compact row may not wrap; {"compact":true,"inlineControls":[],"wrapTokens":["flex-wrap"]} controls: Attach files | Voice input | More tools | Select model and reasoning effort | How should Claude actions be approved? | Send
    444|   assert.deepEqual(readFooter(footer).wrapTokens, ['flex-nowrap'], `th…
 Test Files  1 failed | 8 passed (9)
      Tests  1 failed | 123 passed (124)
```
失败断言在 `src/modules/chat/tests/composerCompactTier.test.tsx:444`。`git checkout -- <该文件>`（`sha256` 复原为 `bcfa10141b2027e8b3afa573ae5286270bee8c175ba7904add03b9406d8f03b1`）⇒ CMD2 复绿 rc=0 3695ms（`Test Files 9 passed (9)` / `Tests 124 passed (124)`），`git status --porcelain` 为空。

**DoD**（最终树）
```
$ quay goal gate AC-332 --root <工作树>          # 非 --dry-run, exit 0, 墙钟 49978ms
{"id":"AC-332","verdict":"pass","cause":null,"reason":"acceptance passed (exit 0)","timeoutMs":100000,"dryRun":false,
 "event":{"id":"949d1329-b5a7-4170-82a7-778746b77794","gate":"goal","actor":"goal-cli","verdict":"pass",
          "payload":{"reason":"acceptance passed (exit 0)",
                     "evaluationRoot":"/data/home/yale/work/claudecodeui-worktrees/gap-ac332-gate-and-ac323-second-segment-reverify",
                     "treeSha":"604e72891bed6020722b81687ef475d794620d2f"}}}
```
GateEvent 已落 `<工作树>/.quay/gate-events.jsonl`（AC-332 共 2 条：`a0ee6b41…`@`c4d88bfd`、`949d1329…`@`604e7289`）。⚠️ AC-332 的 `status` 到树时**已经是 `achieved`**（`statusLog`：2026-10-11T10:12:53.070Z, actor `goal-driver`, reason "I2: criterion pass"），故 DoD 里「status 随之翻 achieved」在本轮**无可观测的翻转动**；`quay goal gate` 本身只 append GateEvent、不写 status。本任务提供的是 **achieved 之后的独立复验**：同一条 `criterion` 在合并树上复跑仍 pass，且 `treeSha` 指向本工作树，`goal_ac: AC-332` 的认领亦在本任务顶层。
`(a)` 段串行 floor **47670ms** 对声明 `timeoutMs: 100000` 余量 52330ms（≈2.10×），对 driver 硬闸 `12e4` 余量 ≈2.52× ⇒ **无需**按 AC6 的例外条改记录 `timeoutMs`（`goals/` diff 为空）。
`(d)` 四文件守卫用的提交对：`ec621a2b`（AC-326 实现）与 `8be9df6b`（AC-327 实现），各取 `^1` 第一父；两条均空。

**AC6**（⚠️ 字面期望与实测读数有偏差，照实记）
AC6 字面期望 `git diff --stat develop HEAD` **恰为** `tasks/gap-…（self）`；实测在 `git merge --no-edit develop` 之后该命令**无输出（空集）**。原因：`task_write` 把本任务的 tick 提交 `9fc92769`（parent `b591c536`，`1 file changed, 80 insertions(+), 6 deletions(-)`）**直接推到了 develop** —— `git log --oneline -3 develop -- tasks/gap-ac332-…md` 首行即 `9fc92769`，`git branch --contains 9fc92769` = `author` + `develop` + 本任务分支；故本分支相对 develop **连自身任务文件都不构成差异**，比字面期望更严格，不是隔离性被破坏。子分支上该 tick 由 `cherry-pick 9fc92769` 落为 `f380353c`（同 patch，6/6 `- [x]`）。
⚠️ 合并前的一次同命令读数（5 files changed, 50 insertions(+), 79 deletions(-)，含 `docs/proposals/cloudcli-mcp-control-observability-2026-10.md` 与 4 份 tasks）是**误读**：本分支当时落后 develop 一代，diff 把 develop 自身的推进算成了反向改动（同 [[worktree-git-diff-develop-shows-develops-own-advance]]）；`git merge --no-edit develop`（无冲突、rc=0，merge 提交 `bccfb070`）之后即空。
其余三条读数均为空：`git diff --stat develop HEAD -- goals/` 无输出 ⇒ `goals/` 下**任何**记录都未被改（含 AC-332 自身），`criterion`/`expect` 一字未动；`git diff --stat develop HEAD -- . ':(exclude)tasks/'` 无输出 ⇒ 未改四文件 / 任何 spec / 产品代码；`git status --porcelain` 为空（AC5 注入已 `git checkout --` 还原，`ChatComposer.tsx` `sha256` 复原为 `bcfa1014…`；AC4 的临时删行同样复原）⇒ 亦未按 AC6 的例外条改记录 `timeoutMs`。

## Touches

- goals/AC-332-goal-038-不回归-ac-323-判据第二段-vitest-紧凑栏-mobile-workspace-idle-腿-typecheck.md
- tasks/gap-ac332-gate-and-ac323-second-segment-reverify.md（self）
