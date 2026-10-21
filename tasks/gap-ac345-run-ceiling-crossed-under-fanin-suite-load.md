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

- [ ] AC1 红已定位到运行看门狗而非断言（承重）：完成记录逐字登记 gate event（id `ffe23041…`、`2026-10-21T05:30:43.688Z`、`treeSha 34fc0d7b…`）、`quay-e2e-vo3gdF/watchdog-state.json` 全文、失败 `error-context.md` 的 test name/location 与 `# Error details`、`ls -la` 的 8 个 `voice-realtime-log/*.jsonl`（mtime `05:27:59`→`05:30:39`）、`test-results/` 只有一个目录，以及 04:29→05:24 的 11 拍 pass 与 round 1186-1190 的 duration 序列；另贴 concurrent suite 的 `suite-start`/`suite-end` 两行与两段 `loadavg` 读数。
- [ ] AC2 预算按实测重标（承重）：`grep -n "'voice-realtime-intent-control.spec.ts':" playwright.config.ts` 读到 `360_000`；改后一次直跑留下 `watchdog-state.json`，逐字含 `"ceilingMs": 360000` 与 `"fired": false`；`git diff <base>..HEAD -- playwright.config.ts` 只含该条目/注释（与 AC3 的 stage 行）。
- [ ] AC3 run-ceiling 越过不再误报 boot stall：diff 与 `grep -n "bootCompletedAt" playwright.config.ts` 显示 run-ceiling 的 `endRun` 路径在 `bootCompletedAt !== null` 时把 stage 定为 `browser-launch-or-cases`，两秒静默读数只进 `detail`；若用强制越过做行为读数（临时把该条目降到 `20_000`、跑 1 个 case、随后恢复），贴出强制 run 的 `watchdog-state.json` 的 `stage`，并贴恢复后 `git diff -- playwright.config.ts` 只剩 AC2/AC3 的正式改动。
- [ ] AC4 载荷窗读数：在 ≥4 路兄弟 e2e lane（+ CPU burners）的并发构造下跑出货命令 ≥2 次，逐次登记 exit、墙钟、运行前后 `load1`、data dir；若构造下的最坏墙钟 <180s，如实登记该构造不足以复现红窗，并以红窗的 240s crossing 作为 AC2 的预算基准（⛔ 不得把没发生的红写成已复现）。
- [ ] AC5 判据为真（承重）：在最终 HEAD 上逐字执行 `f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test "$f"` 连续 ≥3 次 exit **0**，每次输出 `8 passed`；逐次登记墙钟、data dir，且至少 2 次贴 `"fired": false` 的 `watchdog-state.json`。
- [ ] AC6 未弱化：`grep -c "^  test(" e2e/voice-realtime-intent-control.spec.ts` = `8`；`git diff <base>..HEAD -- e2e/voice-realtime-intent-control.spec.ts goals/` 为空；无新增 `retries`/`fixme`/`skip`；出货命令逐字未改。
- [ ] AC7 契约面：`npm run lint` exit **0**；`npm run typecheck` exit **0**；`git diff --name-only $(git merge-base develop HEAD)..HEAD` 全部落在 `## Touches` 内。

## DoD

真实落地判据：在最终 HEAD 上，逐字出货命令 `DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-intent-control.spec.ts` 连续 ≥3 次 exit 0、每次 `8 passed`，且运行自证 `watchdog-state.json` 的 `"ceilingMs": 360000` 与 `"fired": false`；`playwright.config.ts` 的预算条目与注释同源（红窗 240s、记录门槛 420s、余量 ≥60s）；run-ceiling 越过在 boot 已完成后不再写 `webServer-start`；spec 的 8 个 case、断言、`goals/` 的 `criterion:` / `expect:` / `timeoutMs` 与出货命令一字未改。读数取自运行输出与 watchdog-state，不取自叙述。失败路径：若预算重标后判据在并发构造下仍不能稳定 exit 0，置 `needs-human` 并附逐字读数、已试杠杆与排除项。

## Touches

- `playwright.config.ts`（`SPEC_BUDGET_MS` 本文件条目 `240_000`→`360_000` 与注释；run-ceiling 越过时的 stage 读数）
- `e2e/voice-realtime-intent-control.spec.ts`（仅在并发窗内某 case 需要本地有界等待时改；8 个 case 与断言不动）
- `tasks/gap-ac345-run-ceiling-crossed-under-fanin-suite-load.md`（自触）
