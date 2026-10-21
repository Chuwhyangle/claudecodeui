---
id: gap-ac345-run-ceiling-crossed-under-fanin-suite-load
title: AC-345 判据在 fan-in 全量 suite 同窗载荷下越过 240s 运行看门狗被杀（socket hang up / Channel
  closed，前 7 case 已过）：按红窗重标本文件 360s 运行预算并让 run-ceiling 越过不再误报
  webServer-start，八用例断言一字不动
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-345
---
## Proposal

**本轮直接测量（不是台账尾巴）。** AC-345 记录 `status: achieved`，其 GOAL-041 已 `achieved`、不再活跃，且未声明 `long-term: true`，故按 CURRENTLY FALSE 立案。本轮 driver 在评估根 `/data/home/yale/work/claudecodeui` 直跑判据物：`gate-events.jsonl` 的 `ffe23041-b229-41cb-a944-5bdfe3ba3cca`，`2026-10-21T05:30:43.688Z`，`verdict: fail`，`payload.treeSha = 34fc0d7b1dcec5430eae37c965f359ef1a0aa6ab`（= 当前 HEAD `0b5f7a89b` 的 tree），data dir `$HOME/.cache/quay-e2e-tmp/quay-e2e-vo3gdF`。判据物逐字：`f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test "$f"`。

**红在运行看门狗，不在断言。** `quay-e2e-vo3gdF/watchdog-state.json` 全文：

```json
{
  "armed": true,
  "fired": true,
  "ceilingMs": 240000,
  "detail": "ceiling crossed at 240001ms",
  "stage": "webServer-start",
  "stall": "port 7935 (server) accepts TCP but never answers an HTTP request — Playwright's pre-spawn availability probe for http://127.0.0.1:7935/health has no deadline, so it cannot return"
}
```

但同一次 run 早已过 boot 并在用例里：`voice-realtime-log/` 有 8 个会话文件，mtime 从 `05:27:59` 到 `05:30:39`（8 个 case 各自开过一次 Live Voice）；`test-results/` 只留 1 个失败目录 `voice-realtime-intent-cont-72f7a-d-before-the-turn-has-ended/`（`e2e/voice-realtime-intent-control.spec.ts:1787:3`），即它之前的 7 个 case 都已 pass。该目录 `error-context.md` 的 `# Error details` 逐字为 `Error: apiRequestContext.post: socket hang up`（`POST http://127.0.0.1:1273/api/session-hosts/b32d9a41-4a90-4292-9093-4b1e54fdebd4/start`）与 `Error: Channel closed` —— 这是进程在 240s 被 watchdog SIGKILL 时 in-flight 请求的形态，不是哪条读数为假。

⇒ `stage: webServer-start` 本身是读数缺陷：`playwright.config.ts` 已有 `bootCompletedAt` latch（`:861`，boot 一旦被观察到即固定，boot ceiling 只对从未过 boot 的 run 开火），但 run-ceiling 越过时 `endRun` 仍拿即时的 `describeStall()` 两秒采样当 stage（`:884-892`），把一次已 boot 的 mid-case 掐断写成「pre-spawn probe 无法返回」。

**载荷窗口（红的外因，机械可复现）。** 该次判据窗口 `05:26:42 → 05:30:43` 整个落在 fan-in `voice-speaker-tracker-shadow` 的全量 suite 内：`.quay/fan-in-voice-speaker-tracker-shadow-wk-prod-anchor.log` 的 `suite-start` `2026-10-21T05:25:40.644Z` → `suite-end` `2026-10-21T05:29:54.477Z`；`.quay/suite-load-mfi-voice-speaker-tracker-shadow-1792560325170-b31ad6.jsonl` 记 `loadavg 55.79`（05:26:31）→ `69.12`（05:30:46）。同窗口还有 gap-ac194 的第二次 fan-in suite（`…1792560362797-1f1a89.jsonl`：`05:30:01 loadavg 65.77` → `05:32:46 63.25`）。宿主 `nproc=128`。

**同一棵树的历史对照：判据本体是绿的。** 04:29 起同一判据连续 11 拍 pass（tree `2a6e927a` ×5、`56634553` ×2、`568a1212`、`f96f8cf5`、`d60fe1d0`），墙钟随 load 单调爬升：`105.8s → 134.6s → 121.3s → 147.9s → 174.1s`（round 1186-1190），随后在 loadavg 55-69 的 suite 窗口越过 240s 被杀。⇒ 不是断言回归，是运行级固定成本在并发 suite 载荷下的膨胀。

**为什么先前的修复没兜住。** `gap-ac345-omission-fill-race-and-loaded-criterion-budget`（done）把**记录**的 `timeoutMs` 抬到 `420000`（其 AC4：实测绿跑 165-205s 的 2.05×），但只抬了 gate 截止，没动 `playwright.config.ts` 的**运行看门狗预算**：本文件的 `SPEC_BUDGET_MS` 条目（`:447`）仍是 `240_000`，注释自认 "the value the sibling resident/voice entries above declare" —— 照抄姊妹条目，不是本文件实测。判据先撞 240s 运行看门狗，根本走不到 420s 的 gate 截止。本文件已从 6 个 case 长到 8 个（`grep -c "^  test(" e2e/voice-realtime-intent-control.spec.ts` = `8`），预算却没有随实测重标。

**实现面（按实测选杠杆，不预设结论）。**

1. 在可安全构造的并发载荷下重跑出货命令取读数：≥4 路兄弟 e2e lane + CPU burners（用 `bash scripts/with-memory-cap.sh` 包裹；⛔ 不跑全量 suite —— AGENTS.md 的 8G cgroup 约束），登记每次墙钟、`load1`、data dir、`watchdog-state.json`；与红窗的 240s crossing 对照。
2. 把 `playwright.config.ts:447` 的条目重标为 `360_000`：它是红窗 240s crossing 的 1.5×，且给 `goals/AC-345-…md` 的 `timeoutMs: 420000` 留 ≥60s（watchdog 自证、写 state、收尸都发生在 gate kill 之前）；注释逐字写清 240s 红窗、420s 记录门槛与 60s 余量。不新增别的常量、不改 `SINGLE_SPEC_CEILING_MS`。
3. 修 run-ceiling 的 stage 误报：`bootCompletedAt !== null` 时，越过 run ceiling 写入的 `stage` 一律为 `browser-launch-or-cases`，`describeStall()` 的静默读数只进 `detail`（措辞不得再声称 pre-spawn probe 无法返回）。
4. 判据面一字不动：8 个 case、断言、`DASHSCOPE_API_KEY=` 出货命令、`goals/` 的 `criterion:` / `expect:` / `timeoutMs` 全不改；不加 retry/fixme/skip。

**非目标。** 不改 Live Voice 产品代码；不做负载自适应 watchdog（本轮用声明式预算，读数可比）；不重做上面已 done 的 AC-345 修复；不动 spec 断言。

<!-- dedup-ref --> **去重与粒度读数（本轮实测）。** `grep -l '^goal_ac: AC-345' tasks/*.md` → 7 条，全部 `done`（无 todo/ready/needs-human 认领）；这些 done 不是重复，而是「先前修复没兜住」的证据。`task-granularity-advice.js --touches playwright.config.ts --touches e2e/voice-realtime-intent-control.spec.ts --json` → `peers: [gap-ac194-inwindow-firstload-fixed-cost (ready, shared playwright.config.ts)]`、`mentions: []`；判定 **separate**：该 peer 的机制是 AC-194 的 40s 用例体墙钟与 react-scan 首装（`playwright.config.ts` 仅条件触碰），本条是 watchdog 运行天花板的声明式预算与 stage 读数，验收独立（不同 AC、不同 spec），且该 peer 的 `## Blocker` 记录 exited-not-landed、重派未定。⇒ 单独立案。

## AC

- [x] AC1 红已定位到运行看门狗而非断言（承重）：完成记录逐字登记 gate event（id `ffe23041…`、`2026-10-21T05:30:43.688Z`、`treeSha 34fc0d7b…`）、`quay-e2e-vo3gdF/watchdog-state.json` 全文、失败 `error-context.md` 的 test name/location 与 `# Error details`、`ls -la` 的 8 个 `voice-realtime-log/*.jsonl`（mtime `05:27:59`→`05:30:39`）、`test-results/` 只有一个目录，以及 04:29→05:24 的 11 拍 pass 与 round 1186-1190 的 duration 序列；另贴 concurrent suite 的 `suite-start`/`suite-end` 两行与两段 `loadavg` 读数。
- [x] AC2 预算按实测重标（承重）：`grep -n "'voice-realtime-intent-control.spec.ts':" playwright.config.ts` 读到 `360_000`；改后一次直跑留下 `watchdog-state.json`，逐字含 `"ceilingMs": 360000` 与 `"fired": false`；`git diff <base>..HEAD -- playwright.config.ts` 只含该条目/注释（与 AC3 的 stage 行）。
- [x] AC3 run-ceiling 越过不再误报 boot stall：diff 与 `grep -n "bootCompletedAt" playwright.config.ts` 显示 run-ceiling 的 `endRun` 路径在 `bootCompletedAt !== null` 时把 stage 定为 `browser-launch-or-cases`，两秒静默读数只进 `detail`；若用强制越过做行为读数（临时把该条目降到 `20_000`、跑 1 个 case、随后恢复），贴出强制 run 的 `watchdog-state.json` 的 `stage`，并贴恢复后 `git diff -- playwright.config.ts` 只剩 AC2/AC3 的正式改动。
- [x] AC4 载荷窗读数：在 ≥4 路兄弟 e2e lane（+ CPU burners）的并发构造下跑出货命令 ≥2 次，逐次登记 exit、墙钟、运行前后 `load1`、data dir；若构造下的最坏墙钟 <180s，如实登记该构造不足以复现红窗，并以红窗的 240s crossing 作为 AC2 的预算基准（⛔ 不得把没发生的红写成已复现）。
- [x] AC5 判据为真（承重）：在最终 HEAD 上逐字执行 `f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test "$f"` 连续 ≥3 次 exit **0**，每次输出 `8 passed`；逐次登记墙钟、data dir，且至少 2 次贴 `"fired": false` 的 `watchdog-state.json`。
- [x] AC6 未弱化：`grep -c "^  test(" e2e/voice-realtime-intent-control.spec.ts` = `8`；`git diff <base>..HEAD -- e2e/voice-realtime-intent-control.spec.ts goals/` 为空；无新增 `retries`/`fixme`/`skip`；出货命令逐字未改。
- [x] AC7 契约面：`npm run lint` exit **0**；`npm run typecheck` exit **0**；`git diff --name-only $(git merge-base develop HEAD)..HEAD` 全部落在 `## Touches` 内。

## DoD

真实落地判据：在最终 HEAD 上，逐字出货命令 `DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-intent-control.spec.ts` 连续 ≥3 次 exit 0、每次 `8 passed`，且运行自证 `watchdog-state.json` 的 `"ceilingMs": 360000` 与 `"fired": false`；`playwright.config.ts` 的预算条目与注释同源（红窗 240s、记录门槛 420s、余量 ≥60s）；run-ceiling 越过在 boot 已完成后不再写 `webServer-start`；spec 的 8 个 case、断言、`goals/` 的 `criterion:` / `expect:` / `timeoutMs` 与出货命令一字未改。读数取自运行输出与 watchdog-state，不取自叙述。失败路径：若预算重标后判据在并发构造下仍不能稳定 exit 0，置 `needs-human` 并附逐字读数、已试杠杆与排除项。

## Touches

- `playwright.config.ts`（`SPEC_BUDGET_MS` 本文件条目 `240_000`→`360_000` 与注释；run-ceiling 越过时的 stage 读数）
- `e2e/voice-realtime-intent-control.spec.ts`（仅在并发窗内某 case 需要本地有界等待时改；8 个 case 与断言不动）
- `tasks/gap-ac345-run-ceiling-crossed-under-fanin-suite-load.md`（自触）

## Evidence（2026-10-21 实测；读数取自 gate-events / 运行输出 / watchdog-state，不取自叙述）

### AC1 — 红已定位到运行看门狗，而非断言

gate event（`.quay/gate-events.jsonl` 的 `ffe23041…` 行逐字字段）：`id ffe23041-b229-41cb-a944-5bdfe3ba3cca`、`item_id AC-345`、`gate goal`、`actor goal-cli`、`verdict fail`、`timestamp 2026-10-21T05:30:43.688Z`、`payload.treeSha 34fc0d7b1dcec5430eae37c965f359ef1a0aa6ab`。

`$HOME/.cache/quay-e2e-tmp/quay-e2e-vo3gdF/watchdog-state.json` 全文：

```json
{
  "armed": true,
  "fired": true,
  "ceilingMs": 240000,
  "detail": "ceiling crossed at 240001ms",
  "stage": "webServer-start",
  "stall": "port 7935 (server) accepts TCP but never answers an HTTP request — Playwright's pre-spawn availability probe for http://127.0.0.1:7935/health has no deadline, so it cannot return"
}
```

失败 `error-context.md`（`test-results/voice-realtime-intent-cont-72f7a-d-before-the-turn-has-ended/error-context.md`）：

- Name: `voice-realtime-intent-control.spec.ts >> voice realtime intent control >> a sentence spoken while busy is released on the upstream quiet window and started before the turn has ended`
- Location: `e2e/voice-realtime-intent-control.spec.ts:1787:3`
- `# Error details`: `Error: apiRequestContext.post: socket hang up`（`POST http://127.0.0.1:1273/api/session-hosts/b32d9a41-4a90-4292-9093-4b1e54fdebd4/start`）与 `Error: Channel closed`。

`test-results/` 除 Playwright 内部的 `.playwright-artifacts-0/` 外只有 1 个失败目录（上面那个）。

`voice-realtime-log/` 8 个会话文件（`stat -c %y`，本地 +0800 ⇒ UTC 减 8）：

```
05:27:59.889Z 80fcc3bf-c766-46c1-b573-9aaf167a7717.jsonl
05:28:15.035Z b5f800f0-d62a-4fd9-a579-a9c7b4a2401e.jsonl
05:28:25.300Z 68902e09-32c6-4f69-8112-53016fef5e76.jsonl
05:28:44.128Z 607ab40e-53f3-4001-8307-7e40f234bef4.jsonl
05:29:06.122Z a0f3b74b-6af0-4eb0-a5fa-78657a6960ad.jsonl
05:29:17.940Z 56e4becf-c96a-4b58-9573-e873b7283cbf.jsonl
05:30:02.516Z 8ccb9ae5-26aa-44fc-8ec0-2ca34593d2f6.jsonl
05:30:39.906Z fbe944a3-d54c-4b68-8146-2b1eaddf72da.jsonl
```

并发 suite（`.quay/fan-in-voice-speaker-tracker-shadow-wk-prod-anchor.log`）：

```
{"ts":"2026-10-21T05:25:40.644Z","step":"suite-start","exit":0,"wall_ms":0,"ok":true}
{"ts":"2026-10-21T05:29:54.477Z","step":"suite-end","exit":0,"wall_ms":253824,"ok":true}
```

两段 `loadavg`（同窗 JSONL）：

- `.quay/suite-load-mfi-voice-speaker-tracker-shadow-1792560325170-b31ad6.jsonl`（50 行）：首行 `05:25:46.391Z loadavg 55.79`（cpu_stall 7.84）→ 峰值 `05:28:16.540Z loadavg 71.02` → 末行 `05:29:51.635Z loadavg 67.03`。
- `.quay/suite-load-mfi-gap-ac194-inwindow-firstload-fixed-cost-1792560362797-1f1a89.jsonl`（95 行，与红窗重叠）：首行 `05:30:01.394Z loadavg 65.77` → 峰值 `05:33:51.689Z loadavg 129.14` → 末行 `05:37:51.934Z loadavg 48.94`。

历史 pass：`.quay/gate-events.jsonl` 中 AC-345 在 `2026-10-21T04:29:44.939Z` → `05:24:27.263Z` 之间连续 **10** 条 `pass`（trees `2a6e927a` ×5、`56634553` ×2、`568a1212`、`f96f8cf5`、`d60fe1d0`）。**DEVIATION（如实登记）**：立案文本写「11 拍」，逐条数 gate-events 是 10 条；tree 列表与 duration 序列不变。rounds 1186-1190（`.quay/goal-round.jsonl` `04:51:44.751Z`→`05:24:30.192Z`）记录的 duration 序列：`105.8 / 134.6 / 121.3 / 147.9 / 174.1 s`。

### AC2 — 预算按实测重标

- `grep -n "'voice-realtime-intent-control.spec.ts':" playwright.config.ts` → `463:  'voice-realtime-intent-control.spec.ts': 360_000,`
- 改后直跑（runB / runC / runD，见 AC5）的 `watchdog-state.json` 逐字含 `"ceilingMs": 360000` 与 `"fired": false`。
- `git diff $(git merge-base develop HEAD)..HEAD -- playwright.config.ts` 只含该条目/注释与 AC3 的 stage 行（无其它常量改动；`SINGLE_SPEC_CEILING_MS` 未动）。

### AC3 — run-ceiling 越过不再误报 boot stall

`grep -n "bootCompletedAt" playwright.config.ts` 的关键行：`:893 let bootCompletedAt: number | null = null;`、`:916 if (bootCompletedAt === null) return sampled;`（`classifyRunCeilingCrossing` 首行）、`:952 if (mayReArm && (bootCompletedAt !== null || stall.stage === 'browser-launch-or-cases'))`、`:974 if (bootCompletedAt !== null) return;` / `:975 bootCompletedAt = Date.now();`。`endRun` 现在收到 `classifyRunCeilingCrossing(stall)`：`bootCompletedAt !== null` 时它把 `stage` 定为 `browser-launch-or-cases`，探针读数只进 `detail`。

强制越过行为读数（临时把该条目降到 `20_000`，跑 1 个 case，随后 `git checkout -- playwright.config.ts` 恢复）：

- runE（探针恰好读到两端口都答）：`"stage": "browser-launch-or-cases"`，`"stall": "observed past boot at 3444ms, so this run was inside browser launch or a case; both webServers answered the 2000ms probe at the crossing"`。
- runF2（在 t+18s 对本 run 的 server 发 SIGSTOP，使 20s 越过的两秒探针读到 silent）：`"stage": "browser-launch-or-cases"`，`"stall": "observed past boot at 3051ms, so this run was inside browser launch or a case; the 2000ms probe at the crossing got no answer from port 14737 (server) — a loaded server missing the probe's own deadline, not a run stuck in boot"`。这条是判别性读数：同一 silent 采样在旧代码下会写成 `webServer-start` 与「pre-spawn probe 无法返回」。
- 恢复后 `git diff -- playwright.config.ts` 为空，`grep` 读回 `360_000`。

### AC4 — 载荷窗读数（如实登记：构造未复现红窗时长）

构造：4 路兄弟 e2e lane（`voice-realtime-scripted-scenarios`、`voice-realtime-upload-fixture`、`voice-realtime-continuous-experience`、`live-voice-stream-representation`，每路经 `bash scripts/with-memory-cap.sh` 包裹，`--output` 指向工作区外）+ 16 个 CPU burners；分 load1 / load2 两个窗口各跑一次出货命令：

| run | exit | 墙钟 | load1 前 | load1 峰 | load1 后 | data dir |
| --- | --- | --- | --- | --- | --- | --- |
| runB-loaded1 | 0 | 102s | 47.49 | 56.56（05:44:13Z） | 44.69 | `quay-e2e-7fIwN3` |
| runC-loaded2 | 0 | 98s | 43.15 | 64.77（05:46:57Z） | 75.84 | `quay-e2e-5lqj0U` |

lane 同窗结果（构造为真实并发；lane 自身成败不计入判据）：lane2 `7 passed (59.9s)`、lane3 `11 passed (34.8s)`，lane1 / lane4 各 `1 failed`（load 下的兄弟 flake）。最坏墙钟 102s < 180s ⇒ **该构造不足以复现红窗的 240s crossing**；AC2 的 360_000 仍以红窗的 240s crossing 为基准（×1.5），不把没发生的红写成已复现。

### AC5 — 判据为真（最终 HEAD `358eac650`，逐字出货命令，连续 3 次）

| run | exit | 墙钟 | 输出 | data dir | `watchdog-state.json` |
| --- | --- | --- | --- | --- | --- |
| runB-loaded1 | 0 | 102s | `8 passed (1.7m)` | `quay-e2e-7fIwN3` | `"armed": true, "fired": false, "ceilingMs": 360000, "detail": "boot completed at 3414ms, re-armed to 360000ms"` |
| runC-loaded2 | 0 | 98s | `8 passed (1.6m)` | `quay-e2e-5lqj0U` | `"armed": true, "fired": false, "ceilingMs": 360000, "detail": "boot completed at 3220ms, re-armed to 360000ms"` |
| runD-final | 0 | 99s | `8 passed (1.6m)` | `quay-e2e-E9g0AT` | `"armed": true, "fired": false, "ceilingMs": 360000, "detail": "boot completed at 4793ms, re-armed to 360000ms"` |

（另有一次 runA-quiet 在最终 HEAD 的前一个提交上 104s / `8 passed (1.7m)` / `fired:false`，不计入连续三次。）

### AC6 — 未弱化

- `grep -c "^  test(" e2e/voice-realtime-intent-control.spec.ts` = `8`
- `git diff $(git merge-base develop HEAD)..HEAD -- e2e/voice-realtime-intent-control.spec.ts goals/` 为空
- 该 diff 中无新增 `retries` / `fixme` / `skip`
- 出货命令逐字未改（运行脚本内以 `bash -c` 执行与判据物同一串）

### AC7 — 契约面

- `npm run lint` exit **0**
- `npm run typecheck` exit **0**（`tsc --noEmit` × 3：root / server / scripts）
- `git diff --name-only $(git merge-base develop HEAD)..HEAD` = `playwright.config.ts`（在 `## Touches` 内）

## Blocker

**2026-10-21T05:58:06.956Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=ff: fan-in-ff-merge: suite 证书 — suite_head..tip 恰为本任务的单个 flip-done 提交（身份判定：仅 M tasks/gap-ac345-run-ceiling-crossed-under-fanin-suite-load.md）⇒ 判惰性，⛔ 未调分类器
fan-in-ff-merge: FF FAILED — To .; not a fast-forward. Retry record written (attempt 1). Return to 无锁段 step 1 (merge develop again — 必须 merge 不得 rebase, AC75), re-judge the delta (step 2) and re-run.
fan-in-ff-merge: measure ff_only_locked=false
- run_id：wk-prod-anchor
- session_id：853ec641-ec32-494b-bcf2-c9a2595ada54
