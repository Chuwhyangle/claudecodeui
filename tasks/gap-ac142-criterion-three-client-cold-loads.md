---
id: gap-ac142-criterion-three-client-cold-loads
title: AC-142 判据在 fan-in 车道载荷下越过 55s 运行看门狗而假红（Channel closed）：把整轮的客户端冷加载从 3 次收敛到
  1 次，让 e2e/voice-dashscope-written.spec.ts -g "AC-142" 在 60s 门限内稳定跑绿，载重读数一条不动
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-142
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-10-10）：`grep -l 'goal_ac: AC-142' tasks/*.md` 命中 4 条 —— `tasks/gap-voice-dashscope-written-browser-e2e.md`、`tasks/gap-ac142-refusal-leg-copy-repoint.md`、`tasks/gap-ac142-recording-evidence-load-flake.md`、`tasks/gap-voice-dashscope-criterion-boot-dep-reopt-race.md`，逐条 `grep -m1 '^status:'` 均 `done` ⇒ 无 todo/ready/needs-human 认领，本条既非重复也不受在途任务阻塞。这 4 条已 done 是「上一次修复没扛住」的证据（见下）。`node /home/yale/work/quay-plugin-dist/scripts/dist/task-granularity-advice.js --touches e2e/voice-dashscope-written.spec.ts --json` 的 `peers: []`、`mentions: []` ⇒ 无同文件在途任务、无可合并对象；`perFile` 显示该文件已落地 4 次、中位改动 215.5 行 —— 是返工热点。

**判据物。** 逐字取自 `goals/AC-142-真实浏览器里选择-dashscope-后-语音按钮经代理拿到书面指令并写入-composer-上游失败时报错且草稿不丢.md` 的 `criterion:`：`npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"`。

**担保（仍是现行意图）。** 在真实浏览器里选择 DashScope 后，语音按钮经服务端代理拿到书面指令并写入 composer；页面不向任何 `aliyuncs.com` 主机发请求；上游 403 语义错误时 UI 报错且已有草稿逐字不变。

**本轮读数（自己直跑，不是台账推断）。** 隔离态 `bash scripts/with-memory-cap.sh npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"` 连跑 5 次全部 exit **0**、`2 passed`，`criterion-wall-ms` = **20890 / 21528 / 22341 / 20766 / 21276**（中位 21276ms），逐腿 written 5.5s、refusal 4.8s，`[e2e] client warm-up: 2938ms`。⇒ **担保今天是真的**；这是载荷假红，不是行为回归（见 [[left-reverify-ac-ledger-red-can-be-a-flaky-rerun]]）。

**driver 红在哪（读判据自己的工件，不读台账 reason）。** 同一棵树 `4a5d459b3866099e8f0698dbb4d7f6883d3da5e9` 上 AC-142 的 gate 事件 **7 绿 1 红**：pass `06:25:02Z` / `06:29:39Z` / `06:33:57Z` / `06:38:11Z` / `06:42:03Z` / `06:46:25Z` / `06:50:21Z`；fail `06:54:57Z`（exit 1）。红的两处工件逐字：

1. `~/.cache/quay-e2e-tmp/quay-e2e-wzR7Kx/watchdog-state.json` = `{"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55003ms"}`。
2. `…/test-results/voice-dashscope-written-AC-1a870--leaves-the-draft-untouched/error-context.md`：`- Location: e2e/voice-dashscope-written.spec.ts:1157:1`、`Error: Channel closed`、`Error: locator.click: Target page, context or browser has been closed`，Call log 等的是 `getByRole('button', { name: /^voice-dashscope-workspace/ }).first()`（`expandProject` 的 `projectRow(page).click()`，即 refusal 腿的进入点）。页面快照里 sidebar 已渲染、`voice-dashscope-workspace` 在，**没有任何断言失败**。

⇒ 是**整条 run** 在 fan-in 车道载荷下越过 `playwright.config.ts` 的 55s run watchdog（`SINGLE_SPEC_CEILING_MS`）：refusal 腿进入点的一次 `click` 等了 ~38.5s，watchdog 关掉浏览器、exit 非零，台账记为 `verdict: fail`。

**载荷佐证（driver 自己的 frozenRecheck）。** `.quay/goal-round.jsonl` 里 AC-142：round 2947（`06:46:39Z`）`verdict pass, durationMs 41591, load1 39.65`；round 2948（`06:50:37Z`）`verdict pass, durationMs 23041, load1 16.07`。⇒ 同一判据 duration 随当轮车道载荷从 ~23s 涨到 ~41.6s（≈1.8×），而红的那轮涨到越过 55000ms（≈2.6×）。绿红只差当轮载荷，判据本身没坏。

**为什么「上一次修复」没扛住。** 4 条已 done 的前身分别加固过：refusal 腿文案重指（`gap-ac142-refusal-leg-copy-repoint`）、录音证据的载荷读数登记（`gap-ac142-recording-evidence-load-flake`）、boot 依赖重优化竞态（`gap-voice-dashscope-criterion-boot-dep-reopt-race`）。真正在载荷下膨胀的是**运行级固定成本**：config 评估 + 两个 webServer 启动（API `tsx server/index.ts` 与 `vite`）+ 浏览器启动 + `warmClientStartup` 预热 + `beforeAll` 的 onboarding 走查（`browser.newContext` → `context.newPage` → `goto('/?voiceDebug=0&voiceTrim=off')` → 账号向导 → 等 sidebar），再加 `-g` 选中的两条 serial 腿**各自**一次 `context.newPage()` + `page.goto(...)` 的**整次客户端冷加载** —— 失败 run 的 `1-trace.network` 逐字 3 个文档 / 3 次 `main.tsx` 冷加载（`?voiceDebug=0&voiceTrim=off` @06:54:08.100Z、`?voiceTrim=off&voiceDebug=0` @06:54:12.459Z、`?voiceTrim=off&voiceDebug=1` @06:54:17.908Z，每次 ~3535 个模块请求）。这些当时没动，正是要削掉的运行级固定成本。

**要建的东西（最小充分集）。** 削减判据的**运行级**墙钟，使载荷下的 run 在 55s watchdog 之下留出余量。主要手段（供执行者取用，不排他）：把 serial 各腿的整次客户端冷加载**复用**起来 —— 让 onboarding 与两条腿部共享**一个** page 文档（不同腿之间只在必须换 `?voiceDebug` 旗标处做一次**同页导航**，而不是各自 `newPage()` + 冷 `goto`），并把 `beforeAll` 的 onboarding 走查与首条腿的进入合并成一次导航。若实测该手段不足，可用等价的有界手段（例如把进入/探针步里凑时的固定等待换成对该步「下一读」的有界 `waitFor`），但不得改变任何断言与读数。目标：after 五次 `criterion-wall-ms` 的**中位数 ≤ 17000ms**（比基线中位 21276ms 下降 ≥ 4276ms ≈ 20%），使观测到的 ~2.6× 载荷膨胀仍落在 55s 以内（17000 × 2.6 ≈ 44.2s，余量 ~10.8s）。

**非目标。** 不改语音/代理/设置页的任何生产语义；**不弱化任何载重读数**（见 AC3/AC4/AC5）；**不放宽任何门限** —— 既不抬 `playwright.config.ts` 的 `SINGLE_SPEC_CEILING_MS`，也不给本文件加 `SPEC_BUDGET_MS` 覆盖，更不碰验收门的 60s 上限（在仓外，不在 Touches）；不新增 `retries`/`test.skip`/`test.fixme`；不额外起并发压测（见 [[defer-load-problems-do-not-stress-test-inline]]）。

## Plan

1. **红态与定位（第一步）**：读 `~/.cache/quay-e2e-tmp/quay-e2e-wzR7Kx` 的 `watchdog-state.json` 与 `error-context.md` 逐字登记；隔离态连跑判据 5 次，登记每次 `criterion-wall-ms`、逐腿 duration、`watchdog-state.json` 的 `fired`。
2. **冷加载收敛（承重）**：把 `beforeAll` 的 onboarding 文档与 `-g` 两条腿合并到**一个** page 文档上；`openLeg` 改成复用共享 page 并只做同页导航（旗标不同的腿在导航前把 `?voiceDebug` 写进 URL）；需要干净状态时用 `page.reload()` 而不是 `context.newPage()`。目标：整次客户端冷加载 3 次 → 1 次。
3. **有界等待替换（可选）**：把进入/探针步里仅用于凑时的固定 `waitForTimeout` 换成对该步「下一读」的有界 `waitFor`；语义所需的等待（`CAPTURE_MS` 录音窗、轮询 100ms）保留。
4. **读数收敛与稳定**：隔离态连跑 5 次，登记 after 表；确认每次 run 自身 watchdog `fired:false`。
5. **分辨力回归**：整文件（含对照腿）跑一次，登记 `control-aliyuncs≥1 control-proxy-posts=0`。
6. **契约面**：`npm run lint`、`npm run typecheck` 退出 0；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全落在 `## Touches` 内。

## AC

- [ ] AC1 红已定位到运行 watchdog 而非断言：`## Evidence` 逐字登记 `quay-e2e-wzR7Kx` 的 `watchdog-state.json`（`armed:true`、`fired:true`、`ceilingMs:55000`、`ceiling crossed at 55003ms`）与 `error-context.md`（`Location: e2e/voice-dashscope-written.spec.ts:1157:1`、`Error: Channel closed`、`locator.click: Target page, context or browser has been closed`），以及同一棵树 `4a5d459b3866` 上 7 绿 1 红（7 个 pass 时间戳 + `06:54:57Z` fail）。
- [ ] AC2 运行级墙钟削减（承重）：隔离态 `-g "AC-142"` 连跑 5 次的 `criterion-wall-ms` **中位数 ≤ 17000ms**（比本轮登记基线中位 21276ms 下降 ≥ 4276ms ≈ 20%）；登记 before/after 各次的 `criterion-wall-ms` 与逐腿 duration；实现方式为把 serial 各腿的整次客户端冷加载从 3 次收敛（共享页面文档 + 同页导航）。
- [ ] AC3 载重读数不弱化（承重）：`-g "AC-142"` 两条腿仍都 passed 且 exit 0，逐条打印的读数与今天逐字相同：`proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=<n>`；`before-said-unauthorized=false after-said-unauthorized=true`；`copy[UNAUTHORIZED]=… copy[NO_SPEECH_DETECTED]=… copy[unknown]=… distinct=3/3`；`draft-kept=true posts=1 aliyuncs-refusal=0`。
- [ ] AC4 选择面不弱化：`grep -c "^test('AC-142" e2e/voice-dashscope-written.spec.ts` = **2**，且 `grep -n "AC-142"` 的全部命中仍只落在 `:1044` 与 `:1157` 两条标题（对照腿 `:1253` 标题仍不带该 id）；`grep -cE "retries|test\.skip|test\.fixme" e2e/voice-dashscope-written.spec.ts` = **0**；`git diff … -- playwright.config.ts` 为空（未抬 `SINGLE_SPEC_CEILING_MS`、未加 `SPEC_BUDGET_MS` 覆盖）。
- [ ] AC5 分辨力不弱化（对照腿）：整文件（含对照腿）`npx playwright test e2e/voice-dashscope-written.spec.ts` 退出 0，打印 `control-aliyuncs≥1 control-proxy-posts=0` —— 即 AC-142 期望取假形态「前端忽略 proxy-only 而直连 ⇒ 必须红」的分辨力仍在（该腿不带 AC-142 标题、不被 `-g` 选中；可执行的变异工装属 AC-140 的脚本，本条不另造）。
- [ ] AC6 稳定（承重）：连续 5 次隔离态 `-g "AC-142"` 均 exit **0**，逐次登记 `criterion-wall-ms` 与本次 run 自身 `watchdog-state.json` 的 `fired:false`。
- [ ] AC7 契约面：`npm run lint` 退出 0；`npm run typecheck` 退出 0；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内。

## DoD

真实落地判据：不是「把某条腿的等待删短了」，而是让判据的**运行级**固定成本真降下来 —— after 五次 `criterion-wall-ms` 中位数 ≤ 17000ms（基线 21276ms），使观测到的 ~2.6× 车道载荷膨胀仍落在 55s watchdog 之下（`4a5d459b3866` 上红态 `ceiling crossed at 55003ms`）。承重由三件读数证明：(a) 整次客户端冷加载从 3 次收敛到 1 次（失败 run 的 trace 逐字 3 个文档 → after 一次运行只 1 个文档）；(b) 两条腿的四组载重读数逐字不变（AC3）；(c) 对照腿分辨力仍在（AC5）。

**不放宽门限**：`SINGLE_SPEC_CEILING_MS`、`SPEC_BUDGET_MS`、验收门 60s 上限一字未动 —— 抬门限买的是报告、不是绿（[[task-added-whole-run-wallclock-guard-rescale-buys-reporting-not-green]]）。

**如实登记**：本条只做运行级成本削减与稳定化，不改语音/代理/设置页的生产语义，不动任何断言与载重读数；AC-142 期望里的取假形态（前端直连 ⇒ 红）由不带 AC-142 标题的对照腿承载，其可执行**变异**工装属 AC-140 的脚本，本条不另造一份 Playwright 变异工装。判据把 `/api/voice/transcribe` 与 aliyuncs 主机都拦在浏览器侧，不等于真实 DashScope 与真机浏览器；`qwen3.8-omni-flash` 是别名，服务端升级后可能漂移。

## Touches

- e2e/voice-dashscope-written.spec.ts
- tasks/gap-ac142-criterion-three-client-cold-loads.md（自触）

## Evidence

<!-- 本轮（2026-10-10）自己直跑登记的原始读数，不是台账推断。 -->

### 绿态基线（AC-2 的被减数）

命令：`bash scripts/with-memory-cap.sh npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142" --reporter=list`（隔离态；未显式设置 `QUAY_E2E_DATA_DIR`，watchdog 由本 run 拥有）。

5 次全部 exit 0、`2 passed`：

| # | criterion-wall-ms |
|---|-------------------|
| 1 | 20890 |
| 2 | 21528 |
| 3 | 22341 |
| 4 | 20766 |
| 5 | 21276 |

中位 21276ms（最慢 22341ms）。第 1 次逐字读数：written 腿 `5.5s`、refusal 腿 `4.8s`、`[e2e] client warm-up: pre-bundle committed in 2937ms` / `2938ms`；`proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=67`；`before-said-unauthorized=false after-said-unauthorized=true`；`copy[UNAUTHORIZED]="The speech service rejected its key — check the voice provider credentials in Settings, then try again." copy[NO_SPEECH_DETECTED]="No speech was found in the recording — record again and speak closer to the microphone." copy[unknown]="The transcription failed — try again, or check the voice provider settings." distinct=3/3`；`draft-kept=true posts=1 aliyuncs-refusal=0`；`criterion-wall-ms=20890`。

### 红态定位（AC-1）

`~/.cache/quay-e2e-tmp/quay-e2e-wzR7Kx/watchdog-state.json`：

```json
{
  "armed": true,
  "fired": true,
  "ceilingMs": 55000,
  "detail": "ceiling crossed at 55003ms"
}
```

`…/test-results/voice-dashscope-written-AC-1a870--leaves-the-draft-untouched/error-context.md`：

```
- Name: voice-dashscope-written.spec.ts >> AC-142 refusal: a refused recognition shows the sentence its code selects and leaves the draft untouched
- Location: e2e/voice-dashscope-written.spec.ts:1157:1

# Error details

Error: Channel closed

Error: locator.click: Target page, context or browser has been closed
Call log:
  - waiting for getByRole('button', { name: /^voice-dashscope-workspace/ }).first()
```

**同一棵树 `4a5d459b3866099e8f0698dbb4d7f6883d3da5e9` 的 gate 事件：** pass `06:25:02.069Z` / `06:29:39.039Z` / `06:33:57.937Z` / `06:38:11.370Z` / `06:42:03.231Z` / `06:46:25.654Z` / `06:50:21.548Z`；fail `06:54:57.120Z`（exit 1，`acceptance failed (exit 1) — [WebServer] [BABEL] Note: …`）。⇒ 同树同判据 7 绿 1 红。

**载荷佐证（`.quay/goal-round.jsonl`）：** round 2947（`06:46:39Z`）AC-142 `verdict pass, durationMs 41591, load1 39.65`；round 2948（`06:50:37Z`）`verdict pass, durationMs 23041, load1 16.07`。

**成本定位（失败 run 的 trace 逐字）：** `1-trace.network` 3 个文档 / 3 次 `main.tsx` 冷加载 —— `?voiceDebug=0&voiceTrim=off` @06:54:08.100Z（onboarding）、`?voiceTrim=off&voiceDebug=0` @06:54:12.459Z（written）、`?voiceTrim=off&voiceDebug=1` @06:54:17.908Z（refusal）；`test.trace` 里 refusal 腿进入点 click 在 t=17.1s、报错在 t=55.6s（挂 ~38.5s）。
