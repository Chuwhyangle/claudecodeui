---
id: gap-ac319-criterion-serial-over-driver-spawn-cap-split
title: AC-319 三命令 `&&` 串行 floor 实测 131s 高于 goal driver 的
  CRITERION_TIMEOUT_MS=120000 硬闸（记录无 timeoutMs ⇒ 闸默认 60000）⇒ 结构性
  not-evaluated、永不到 pass：把判据按闸切成两段（并集与原链逐条相同）、各段声明
  timeoutMs∈(floor,120000)，复验三命令全绿 + 闸自证 pass + 取假形态
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-319
---
## Proposal

<!-- dedup-ref --> 现网**无任何任务以 `goal_ac: AC-319` 认领**——`grep -l '^goal_ac: AC-319' tasks/*.md` 的四个命中 status 全为 `done`（`gap-voice-segmented-relay-segmenter-relay-profile`、`gap-voice-segmented-relay-protocol-server-commit`、`gap-voice-segmented-relay-client-wiring`、`gap-voice-realtime-e2e-specs-red-under-default-segmented-mode`）⇒ 本任务为新案。相关但**不同机制 / 不同 AC**：`gap-ac331-gate-deadline-and-ac323-regression-reverify`（done，`goal_ac: AC-331`）是**同一 deadline 机制在 AC-331 记录**上的实例——它只改 AC-331/AC-332 两条记录，正文里明写「GOAL-034 的 AC-319 已实测到 `gate spawn error: spawn timeout after 120000ms (SIGKILL)`」，却**从未改 AC-319 记录**；`gap-ac352-replay-criteria-record-timeoutms`（done，`goal_ac: AC-352`）是记录级 `timeoutMs` 的另一实例。`task-granularity-advice --touches goals/AC-319-*.md` 报 `peers: []`、`mentions: []`，无合并候选。

### 现状（2026-10-13 复核）

**一句话**：AC-319 的三条命令**在开发树上全绿**（本日实测串行 131s，见 (1)），但判据是**单条 `&&` 串行链**，其串行 floor ≈131s **恒高于 goal driver 的 `CRITERION_TIMEOUT_MS = 120000` 硬闸**，而 AC-319 记录又**没有 `timeoutMs`**（frontmatter 止于 `fidelity`/`statusLog`；仓内无 `.quay/gates.yml`）⇒ 闸默认 60s ⇒ AC-319 **结构性写不出 pass**，与被测功能对不对无关。这正是 AC-331「四命令串行 floor 126–130s」形态在 AC-319 上的副本。

**（1）判据串行 floor 实测 131s**（2026-10-13，clean worktree @ develop `e57565af`，`scripts/with-memory-cap.sh` 包住）：

```
CMD1 npx vitest run src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts src/modules/chat/voice-realtime            exit 0  wall 36s   (Test Files 17 passed / 216 tests)
CMD2 npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-segmented-protocol.test.ts  exit 0  wall 10s   (pass 21 / fail 0)
CMD3 npx playwright test e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-live-session-send.spec.ts --workers=1        exit 0  wall 85s   (11 passed)
SERIAL_TOTAL = 131s
```

`&&` 串行 ⇒ floor = 131s。**三条命令本身全绿** ⇒ 红不在被测功能（同一 worktree 三次 exit 0）。

**（2）闸 deadline 的两把锁。** 记录无 `timeoutMs` ⇒ 闸用 `DEFAULT_ACCEPTANCE_TIMEOUT_MS = 60000`；账本指纹即 memory `ac-wallclock-bound-below-a-mandated-floor-is-unsatisfiable` 描述的那条 streak——`.quay/goal-round.jsonl` rounds 75/76（2026-10-13T01:46 / 01:55）逐字：

```
"verdict":"not-evaluated","cause":"timeout",
"reason":"not-evaluated (timeout): acceptance timed out after 60000ms (killed) — set the record's `timeoutMs` or QUAY_ACCEPTANCE_TIMEOUT_MS"
```

另一把锁在驱动侧：`plugin/scripts/goal-driver.ts` 的 `export const CRITERION_TIMEOUT_MS = 120_000`（无 env/字段通道）用它 spawn `quay goal gate`，到 120000ms 对 spawn 发 SIGKILL ⇒ 记录里写 `timeoutMs ≥ 120000` 只是把「闸自杀」换成「驱动杀 spawn」，判据照样写不出 verdict（memory `goal-gate-inherits-sweep-env-and-driver-kills-it-at-120s`）。**可行区间是 `floor < timeoutMs < 120000`——而 floor 131s ≥ 120000 ⇒ 区间为空 ⇒ 单条记录无论怎么写都不可满足，只能拆段。**

**（3）为什么早前的 AC-319 任务没能让这条 AC 变绿。** 四个 `goal_ac: AC-319` 任务都 done，且确实把三条命令做绿了（(1) 实测）——但它们**没有一个碰过 AC-319 记录的 deadline**，三命令链一字未拆。判据的「红」从来不是产品，是 deadline；AC-331 那轮记录甚至已经点名 AC-319 撞过 120s SIGKILL，却只修了 AC-331/AC-332 两条记录。

**（4）被测 root 的污染（执行前提，DoD 前须核实）。** `goal-store` 按 AC 所属 GOAL 解析判据 cwd：GOAL-034 **没有 `branch: true`** ⇒ `criterionCwdForGoal` 落 `mainRoot` ⇒ 驱动那次 `quay goal gate AC-319` 的 `payload.evaluationRoot = /data/home/yale/work/claudecodeui`（`.quay/gate-events.jsonl` 2026-10-13T01:57 那条逐字如此，`treeSha f44bbffa` = `e57565af^{tree}` = develop 树）。而该主检出当前带**未提交 WIP**，其中 `src/modules/chat/voice-realtime/tests/voiceAttributionRewriteGap.test.tsx`（**untracked**，写于 2026-10-13，第 162 行 `expect(attributed.has('first'))` 红）落在 **CMD1 的目录 glob `src/modules/chat/voice-realtime` 之内** ⇒ 同一 CMD1 在主检出红、在 clean worktree 绿。同一 WIP 还带 `docs/operations/voice-realtime-idle-history-probe.md`、`experiments/voice-realtime-idle-history-probe/` 与一批 modified 追踪文件——**属他人在途工作，不是 AC-319 的产品**。

### 做法

1. **逐条量 floor 再拆**：在 clean worktree @ develop 上、用 `scripts/with-memory-cap.sh` 分别计时 CMD1–CMD3 并求和，复核 floor > 120000ms（本次为 131s）。
2. **按闸把三命令 `&&` 链切成两段记录**（人 yale 2026-10-11 对 AC-331 裁定的同形做法：driver 的 120s 硬闸下，拆段是唯一可行形态）：
   - 每段**并集与原链逐条相同**（⛔ 不许删/弱化/合并成更短命令）；
   - 每段串行 floor **< 其声明的 `timeoutMs` < 120000**；每段在 frontmatter 声明 `timeoutMs`（正整数毫秒）。若某段 floor > 92308ms，余量 ≥30% 结构性不可达 ⇒ 取区间内最大安全值 **118000**，并在 Evidence 写「声明值 / floor / 余量%」三数（memory `goal-criterion-deadline-record-timeoutms-wins`）。
   - **推荐切法（margin 最优）**：AC-319 保留 **CMD1 + CMD2**（切分器 + 服务端分段协议，串行 46s），把 **CMD3**（两条 e2e spec，85s）拆成**新 AC**（本任务创建；建议 id `AC-376`，标题自拟）。新记录经 `goal_write` 创建，其文件名 `goals/AC-376-<slug>.md` 由 goal-store 依标题生成——**创建后必须把该实际路径追加进本任务 `## Touches`**（自触；⛔ 不得在 Touches 里留 glob——glob 令 `touchesNarrow=false`、任务晋升不 eligible）。两段各声明 `timeoutMs`（建议 118000 / 115000，按实测取）。
   - 新记录 `expect` 须如实描述 CMD3 那段语义（旧连续协议兼容 / e2e）；AC-319 原 `criterion`/`expect` 文本**除拆出的命令外一字不动**，并在记录里留一条「口径变更/拆分」注记说明拆法与理由（照 AC-331 先例）。
3. **闸自证**：`quay goal gate AC-319 --dry-run --root <clean worktree>` 与 `quay goal gate <新 AC> --dry-run --root <clean worktree>` **各一次**，两次 exit 0，stdout JSON `verdict == "pass"`、`cause == null`、`timeoutMs == <该记录声明值>`。原文贴 Evidence。
4. **取假形态 A（deadline）**：删掉 AC-319（或新 AC）记录的 `timeoutMs` 行 ⇒ 同一 `--dry-run` 报 `not-evaluated` / `cause: timeout`，reason 含 `timed out after 60000ms`；加回 ⇒ 复绿。⚠️ 想用 `--timeout` 证 deadline 敏感性，必须**先摘掉记录字段**（记录级 `timeoutMs` 优先于 `--timeout`，memory `goal-criterion-deadline-record-timeoutms-wins`）。
5. **取假形态 B（产品）**：在实现树上注入一个该段的真回归——例如改坏 relay 档的最小段长/停顿参数、或去掉段合并——⇒ 含该断言的段**必红**（CMD1 的 `voiceLiveSegmenter` 有冻结期望表用例；CMD3 的 e2e 有 relay 用例）；`git checkout --` 还原 ⇒ 复绿。贴文件名/行号与失败断言原文。
6. **主线 root 的核实与处置（现状 (4)）**：在**驱动实际读的 root**（GOAL-034 无 `branch: true` ⇒ 主检出 `/data/home/yale/work/claudecodeui`）复跑该 root 下 AC-319 段的判据命令。若主检出 untracked `voiceAttributionRewriteGap.test.tsx` 仍在且红，该红**不是 AC-319 的产品**——**不要**并入本任务的判据、**不要**去改它（他人在途）。处置：(a) 让该 stray 先离开主检出（由它自己的任务/人落地或清理）；或 (b) 给 GOAL-034 声明 `branch: true` 使闸在独立 goal worktree 求值（须确认 `goalBranchRefExists`）。若 DoD 时该 stray 仍使驱动闸红，按 `task-gated-by-unpublished-upstream-artifact-parks-needs-human` 如实 park `needs-human` 并点名该 stray。
7. ⛔ **不改** AC-319/新 AC 之外任何 goal 记录；⛔ **不改** `mainRoot` 任何 WIP（含 `voiceAttributionRewriteGap.test.tsx`、`experiments/voice-realtime-idle-history-probe/`、那批 modified 追踪文件）；⛔ 不靠放宽/收窄判据换绿；⛔ 不动 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 来「报出」绿。

## AC

- [ ] **AC1 拆段已落记录**：AC-319 记录声明 `timeoutMs`（正整数，`< 120000`）且 `criterion` 只保留拆分后的一段命令；新 AC 记录存在、声明 `timeoutMs`、承载原链其余命令；两段命令**并集逐字等于**原三命令 `&&` 链。机械判据：`quay goal get AC-319 --json`（与 `… <新 AC> --json`）的 `timeoutMs` 为声明值；两段 `criterion` 拼回的字符串 == 原 criterion（`git diff` 增删行可核）。
- [ ] **AC2 逐条实测**：CMD1–CMD3 各跑一次（`scripts/with-memory-cap.sh` 包），各自 exit 0、记墙钟；贴 (1) 同形读数（CMD1 `Test Files … passed`、CMD2 `pass 21`、CMD3 `11 passed`）。**每段**串行合计 < 该段声明 `timeoutMs`，且声明值 < 120000。跑 CMD1 必须与判据同形（含目录 glob `src/modules/chat/voice-realtime`）。
- [ ] **AC3 闸自证**：`quay goal gate AC-319 --dry-run --root <clean worktree>` 与 `quay goal gate <新 AC> --dry-run --root <clean worktree>` 各一次，两次 exit 0，stdout JSON `verdict == "pass"`、`cause == null`、`timeoutMs == <该记录声明值>`。贴原文。
- [ ] **AC4 假形态 A（deadline）**：删掉 AC-319（或新 AC）记录的 `timeoutMs` 行 ⇒ 同一 `--dry-run` exit 非 0、`verdict == "not-evaluated"`、`cause == "timeout"`、reason 含 `timed out after 60000ms`；加回 ⇒ 复绿（AC3 原文）。
- [ ] **AC5 假形态 B（产品）**：注入一个被测回归 ⇒ 对应段**红**（贴文件名/行号/失败断言原文）；`git checkout --` 还原 ⇒ 该段复绿。
- [ ] **AC6 主线 root 核实**：在 `/data/home/yale/work/claudecodeui` 复跑该 root 下 AC-319 段的判据命令，如实记录 exit code 与（若有）红因；若红因是主检出 untracked `voiceAttributionRewriteGap.test.tsx`，逐字记明「非 AC-319 产品、系他人在途 WIP」，并给出处置结论（stray 先离开 / GOAL-034 `branch:true` 隔离 / park）。
- [ ] **AC7 隔离性与登记**：`git diff --stat develop HEAD` 只含 `goals/AC-319-…md`、新 AC 记录、（+ 本任务文件）；`goals/` 下其它记录 diff 为空；`git status --porcelain` 为空（注入已还原）；且本任务 `## Touches` 已含新 AC 记录的**实际路径**（非 glob）。机械判据：`grep -n 'AC-376' tasks/gap-ac319-criterion-serial-over-driver-spawn-cap-split.md` 的 `## Touches` 段命中一行无通配符的路径。

## DoD

在**驱动实际读的那个 root** 上真实跑 `quay goal gate AC-319`（非 `--dry-run`）拿到 `verdict: "pass"` 的 GateEvent（AC-319 `status` 随之翻 `achieved`），并留下该条原文；新 AC 同样拿到 pass。三条命令各跑一次、记 wall time 与 exit code，**每段串行 floor 与其声明 `timeoutMs` 一并记明**。两处假形态现场红/还原绿，原始输出留档；拆分前后每段并集可机械对照。Evidence 逐条记明：(a) 拆法与依据（floor 131s ≥ driver 120000，区间空）；(b) 各段声明值 / floor / 余量%；(c) 两把锁（闸默认 60000、driver `CRITERION_TIMEOUT_MS=120000`）出处；(d) 记录改动须落到 driver 读的那个根——goal 目录由 `.quay/config.yml` 的 `QUAY_NATIVE_GOAL_DIR` 钉成主检出绝对路径，照先例处理；(e) 主检出 WIP/stray 的核实结果与处置；(f) 新 AC 记录的实际文件路径（并已写入本任务 Touches）。

**诚实出口**：若在驱动 root 上实测仍写不出 pass，或 deadline 区间因新测 floor 变化变为空（某段 floor ≥ 120000），或主检出 stray 使该段恒红且无法在不动他人在途工作的前提下消除，按 `task-gated-by-unpublished-upstream-artifact-parks-needs-human` park `needs-human`，逐字写明卡在哪一段、哪一把锁、哪条读数；⛔ 不得勾 AC1/AC3/DoD 充数、不得收窄判据换绿。

## Touches

- goals/AC-319-p1-切分与协议-浏览器端-segmentvad-relay-档-只上送语音段-服务端按段提交-旧连续协议兼容-不吃字.md
- tasks/gap-ac319-criterion-serial-over-driver-spawn-cap-split.md
