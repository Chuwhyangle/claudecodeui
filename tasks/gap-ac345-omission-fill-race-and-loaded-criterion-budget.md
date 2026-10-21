---
id: gap-ac345-omission-fill-race-and-loaded-criterion-budget
title: AC-345 判据负载下连红两次：用例 4 的 omission-fill 在中断前投递「听了未转发」句（转 composer 腿读成空串）、用例
  5 页面 30s 未渲染，且记录 118s 预算低于实测 138s 墙钟
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

**本轮直接测量（不是台账尾巴）。** AC-345 记录 `status: achieved`，GOAL-041 已 `achieved`、不再活跃且未声明 `long-term: true`，故台账尾按 CURRENTLY FALSE 交办。本轮在评估根 `/data/home/yale/work/claudecodeui`（tree `f327fe666e47b05d2726fa3ff5e30df5c4b24b15`，即 HEAD `1b1f8356f` 的 tree）直跑判据，连续两次 exit 1：

- `2026-10-21T03:39:17.500Z`，data dir `quay-e2e-KnPtZK`；
- `2026-10-21T03:45:29.525Z`，data dir `quay-e2e-kIKT3J`。

同一 checkout 的静跑对照：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-intent-control.spec.ts` → `8 passed (2.3m)`、exit 0，data dir `quay-e2e-c2f7ul`。⇒ 判据并非结构性不可满足；红是负载下的两条竞态，外加一个低于实测墙钟的记录预算。

**红一（03:45，用例 4）：omission-fill 在中断之前把「听了未转发」的句子投递了，转 composer 那条腿因此为空。** `quay-e2e-kIKT3J/test-results/voice-realtime-intent-cont-ba06e--re-homes-into-the-composer/error-context.md` 的 `# Error details` 逐字：

```
Error: the composer draft was ""

expect(received).toContain(expected) // indexOf

Expected substring: "and this phrase is never relayed to the session"
Received string:    ""
```

落点 `e2e/voice-realtime-intent-control.spec.ts:1472`。同一 data dir 的连接日志 `voice-realtime-log/0b39a881-5469-4568-9300-179744a020fc.jsonl` 逐字给出成因链：

- `03:45:12.504` `<< transcription.completed "and this phrase is never relayed to the session"`；
- `03:45:20.066` `omission_fill {"i":1,"dueAt":1792554315504,"coverage":0,"reason":"fill"}`（`dueAt` = 12.504 + `silence_ms` 3000）；
- `03:45:20.907` 才听到 CORRECTION，`03:45:21.013` 才 `session_interrupt`；
- `03:45:21.018` `session_send delivered in 1 ms ... message "and this phrase is never relayed to the session"`。

⇒ 该句在中断前已被补发交给会话，退出时没有「未认领句」可回填，draft 只能是空串。

根因是**屏障的位置**：用例 4 在 `hearUtterance(page, upstream, 'drop-heard-phrase', PHRASE)`（`:1423`）之后才取 `const vacancy = Date.now(); await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000)`（`:1433-1434`），然后才听 CORRECTION。负载下这一步等了 ≈8.4 s，越过 omission-fill 的 3 s 窗口。静跑对照的同一连接（`quay-e2e-c2f7ul/voice-realtime-log/3fa8d4dd-...jsonl`）里 PHRASE→CORRECTION 只隔 118 ms，中断成功路径在 `03:48:23.328` 记 `omission_fill {"i":1,"reason":"stop"}`——候选被中断关闭，补发不触发，draft 正常回填。⇒ 只要中断在 `dueAt` 前到达，规则本身会守住这条腿；本条要把「屏障」移出 PHRASE→中断这段，而不是改读数。

**红二（03:39，用例 5）：页面 30 s 内没渲染出 `.chat-messages-pane`。** `quay-e2e-KnPtZK/test-results/voice-realtime-intent-cont-853c9-n-screen-and-aborts-nothing/error-context.md` 逐字：

```
Error: expect(locator).toBeVisible() failed
Locator: locator('.chat-messages-pane')
Expected: visible
Timeout: 30000ms
Error: element(s) not found
```

落点 `e2e/voice-realtime-intent-control.spec.ts:511`（`openSession` 的 PANE 等待）。spec 是 `test.describe.configure({ mode: 'serial', timeout: 120_000 })`（`:840`），一次红会中止同文件后续用例，所以台账里一次红会读成 4–5 条失败（本轮两次红的 `.last-run.json` 分别列 4 / 5 条）。这一腿必须在同一并发突发下复现，判定是「客户端在负载下晚就绪」（同族：vite dep-optimize 抢跑 / boot 膨胀）还是页面确有产品侧错误（pageerror / dynamic-import 失败）；不得用 retry 掩盖读数。

**红三（预算）：记录声明 `timeoutMs: 118000`，低于本轮实测的 138 s 绿跑墙钟。** `goals/AC-345-...md:36` 逐字 `timeoutMs: 118000`。上一任务 `gap-ac345-gate-deadline-below-criterion-wallclock`（done）把默认 60 s 抬到 118 s，依据是 2026-10-18 静跑 89.7 s；本机现在（128 核、e2e fleet 并发、load1 数十到上百）同一套实测 `8 passed (2.3m)`。⇒ 即便全绿，判据也会被自己记录的截止线杀掉；预算必须按「门实际会跑的负载区间」重测并留 ≥2× 余量。

**为什么先前的修复没兜住。**

- `gap-ac345-gate-deadline-below-criterion-wallclock`（done）：118 s = 89.7 s 静跑 + 28 s 余量；本轮绿跑 138 s，余量为负。
- `gap-omission-fill-wire-into-ws-proxy`（done，2026-10-18）把 settle 兜底换成 rule v2 的 `T_i` 补发（`silence_ms=3000`）：它合法地会在 3 s 后把「听了没转发」的句子投出去；用例 4 的「未认领句回到 composer」前提只在这个窗口内成立，而用例把最慢的一步（转写行屏障）放在了窗口内。
- `bd9ac22c5`、`8c3c60c99`、`af3f21b9b` 等只改首帧/读数锚点，没有动屏障与中断之间的时序。

**实现方向（worker 按复现读数选，不得放宽读数）。**

1. 复现：用与 `gap-ac194-criterion-pretest-boot-inflation` 同构的并发构造（≥4 路兄弟 e2e lane，必要时加 CPU burners）跑出货命令 ≥2 次，记录 load1 / data dir / 首个红；确认用例 4 的红由 `reason:"fill"` 触发、用例 5 的红是客户端未就绪。
2. 用例 4：把 `waitForTurnAfter` 屏障移到 `hearUtterance(...PHRASE)` 之前（屏障只依赖开场 push 结束后的下一次 turn，与 PHRASE 无关）。若复现后 PHRASE→中断仍能越过 3 s，则给本 spec 选择接一个固定 omission-fill 窗口的 settings fixture（`VOICE_REALTIME_SETTINGS_PATH` + `omissionFill.silence_ms`/`h_ms`），让回填腿不依赖负载。两条读数 `expect(order.some(text => text.includes(PHRASE))).toBe(false)` 与 `expect(draft).toContain(PHRASE)` 逐字保留。
3. 用例 5 / `openSession`：对 PANE 的 30 s 等待加一次有界 reload（与 `beforeAll` 的 project-row 兜底同形），仍断言 PANE 可见；若复现显示 pageerror / dynamic-import 失败，按真实成因修，不放宽可见性断言。
4. 预算：在修复态、同一并发构造下测绿跑墙钟 W，把 `goals/AC-345-...md` 的 `timeoutMs` 设为 ≥2×W（且 ≥240000），`criterion:` / `expect:` 一字不改。注意 goal-driver 的 spawn 截止 = record `timeoutMs` + 15 s 宽限（`goalDriverChildTimeoutMs`）。

<!-- dedup-ref --> 去重与粒度：`goal_ac: AC-345` 的 7 条任务全部 done，todo/ready/needs-human 下没有任何在飞认领者；`task-granularity-advice --touches ...` 的 peer 只有 `gap-ac194-criterion-pretest-boot-inflation`（ready），共享 `playwright.config.ts`，但机制不同（它是 test-runner 之前的 server boot bundle；本条是 voice e2e 的补发竞态、页面就绪与记录预算），保持独立；两者对同一文件的改动各自累加，不互相覆盖。

## AC

- [ ] AC1 复现读数入档：并发构造下 ≥2 次出货命令运行，每次记 lane 数、load1、data dir、首个红用例与逐字 error-context；至少一次红是用例 4，且其连接日志含 `"reason":"fill"` 的 `omission_fill` 与该句的 `session_send delivered`。
- [ ] AC2 用例 4 的修复有判别力：`grep -n "waitForTurnAfter" e2e/voice-realtime-intent-control.spec.ts` 显示屏障调用出现在 `hearUtterance(page, upstream, 'drop-heard-phrase', PHRASE)` 之前，或（走 fixture 臂时）贴出 fixture 路径、`VOICE_REALTIME_SETTINGS_PATH` 接线 diff 与窗口值；同一并发构造下用例 4 单独 ≥3 次绿（`npx playwright test e2e/voice-realtime-intent-control.spec.ts -g "re-homes into the composer"`）；取假形态一次并贴出红（把屏障放回 PHRASE 之后，或把补发窗口恢复 3000 ms）。
- [ ] AC3 用例 5 的页面就绪：`openSession` 的有界 reload diff 入档；同一并发构造下用例 5 单独 ≥3 次绿（`-g "cannot be confirmed as enqueued"`）；`git diff` 证明 PANE 可见性断言未放宽、未加 retry、未加 `test.fixme/skip`。
- [ ] AC4 预算与本轮实测同源：`grep -n "timeoutMs" goals/AC-345-*.md` 读数 ≥ 2× 修复态实测绿跑墙钟且 ≥240000，同一次运行贴出该墙钟；`git diff <base>..HEAD -- goals/` 只有 `timeoutMs` 一行变化，`criterion:` 与 `expect:` 逐字不变。
- [ ] AC5 判据为真：出货命令 `f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || exit 1; DASHSCOPE_API_KEY= npx playwright test "$f"` 逐字 ≥3 次 exit 0，其中 ≥2 次在同一并发构造下，贴出每次墙钟与 data dir。
- [ ] AC6 未弱化：`grep -c "PHRASE" e2e/voice-realtime-intent-control.spec.ts` 与基线相同；`expect(order.some((text) => text.includes(PHRASE))` 与 `expect(draft, ...).toContain(PHRASE)` 仍在；无 `retries`、无 `-g` 收窄出货命令、无 `fixme/skip`。

## DoD

真实落地标准：在能复现本轮红的并发构造（≥4 路兄弟 e2e lane、load1 与红窗同量级）下，AC-345 的出货判据命令逐字 exit 0，且用例 4 的「未转发句不进队列、退出时回到 composer」与用例 5 的「中止不动」读数逐字仍在；记录 `timeoutMs` 按同一构造的实测绿跑墙钟留 ≥2× 余量；`criterion:`/`expect:` 未改。读数取自运行输出与连接日志，不取自叙述。失败路径：若 3 轮修复后并发构造下仍不能稳定 exit 0，置 `needs-human` 并附逐字读数、已试杠杆与排除项。

## Touches

- e2e/voice-realtime-intent-control.spec.ts
- goals/AC-345-live-voice-意图控制浏览器验收-scripted-fake-paced-audio-playwright-覆盖.md
- playwright.config.ts（仅当走 settings fixture 臂、需要给本选择接 `VOICE_REALTIME_SETTINGS_PATH` 时）
- config/voice-realtime.e2e-intent-control.settings.json（仅当走 fixture 臂；新文件）
- tasks/gap-ac345-omission-fill-race-and-loaded-criterion-budget.md
