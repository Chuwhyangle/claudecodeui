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

- [ ] AC1 `goals/AC-323-<slug>.md` 的 frontmatter 声明 `timeoutMs`（正整数毫秒），其值 > 判据实测串行墙钟且 < 120000；记录其余字段（`id` / `title` / `status` / `kind` / `goal` / `criterion` / `expect` / `origin` / `activatedAt` / `statusLog` / `fidelity`）与改动前逐字节相同。机械判据：`git diff -- goals/` 的增删行只有 `+timeoutMs:` 一行；`quay goal show AC-323 --json` 的 `timeoutMs` 等于声明值。
- [ ] AC2 `quay goal gate AC-323 --dry-run --root <工作树>` exit 0，stdout JSON 满足 `verdict == "pass"`、`cause == null`、`timeoutMs == <声明值>`。原文贴 Evidence。
- [ ] AC3 三条判据命令各自 exit 0，且串行合计墙钟 < 声明值：CMD1 记 `12 passed`、CMD2 记 `61 passed`、CMD3 记 `6 passed`（数字可刷新，但三个 exit 0 与 `合计 < timeoutMs` 必须成立；各记 wall time）。
- [ ] AC4 取假形态现场红再还原：删掉记录的 `timeoutMs`（默认 60000，且未设 `QUAY_ACCEPTANCE_TIMEOUT_MS`）后，同一 `quay goal gate AC-323 --dry-run --root <工作树>` 报 `verdict == "not-evaluated"` 且 `cause == "timeout"`（exit 1，reason 含 `timed out after 60000ms`）；加回后同命令 exit 0。
- [ ] AC5 隔离性：`git diff --stat develop HEAD`（落地树相对 develop）恰好只有 `goals/AC-323-<slug>.md`（加本任务文件）；`goals/` 下其它记录 `git diff` 为空。

## DoD

- 真实跑 `quay goal gate AC-323`（非 `--dry-run`，判据是真浏览器 + 真 WebSocket 服务端）拿到 `verdict: "pass"` 的 GateEvent（在带可写 `.quay/` 的根上，例如合并后主检出或工作树内的 `.quay/`），并留下该条原文。
- 三条判据命令各跑一次，记 wall time 与 exit code（至少 CMD1 贴 `12 passed (45.4s)` 形状的原文）。
- 假形态（删 `timeoutMs`）红、还原绿，原始输出留档。
- Evidence 记明：(a) 声明值及相对实测串行墙钟的余量；(b) 上限 120000 的来源（driver `CRITERION_TIMEOUT_MS = 12e4`）与声明值必须 < 它的理由；(c) 前两个任务为何改不了这一行（Touches 不含 goals/）；(d) 声明值与「冷缓存首次运行」的关系（冷跑更慢，故声明值须覆盖冷上界而非仅暖值）。

## Touches

- goals/AC-323-composer-内双语音入口-容器内-live-voice-紧凑栏-波形-时长-字幕-模型-mute-end-桌面与.md
- tasks/gap-ac323-gate-deadline-below-criterion-serial-time.md (self)
