---
id: gap-ac188-case-budget-red-is-postturn-renavigation-tail
title: AC-188 用例体预算负载下再红：尾部 14.3s 几乎全是回合后重新导航（goto 等 load 撞 5s
  探针→reload），修掉这段负载敏感固定成本而非再抬预算
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-188
---
## Proposal

**现象（门账本 + 直接重跑，两次独立读数）**

门账本里 AC-188 的 `gate=goal` 事件在同一棵树 `834d1d8e809160196bfb737f9ef538565b87a1d8` 上交错：
2026-10-08T15:24:42.412Z **fail** → 15:25:46.364Z **pass** → 15:27:30.810Z **pass** → 15:29:29.305Z
**pass** → 15:31:50.216Z **fail**。fail 的 `reason` 又一次被截断到 WebServer 的 stderr（`[BABEL] Note …
exceeds the max of 500KB`、`[DEP0190]`），读不出失败落点，所以本轮**没有再依赖 reason 尾巴**，而是
直接重跑判据。

本轮立案前直接重跑（HEAD `9fc12599089d7382131c2d4c61729c569a62ccb4`，tree `834d1d8e` == `git rev-parse
HEAD^{tree}`，`e2e/activity-dock-truthful.spec.ts` 与 `playwright.config.ts` 均 clean；本机 `load1 ≈
110`）：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` → **exit 1，整次调用 54237ms**。

**失败断言（逐字，`/tmp/ac188-rerun-1.log`）**

```
Error: the case body must land inside its own budget
expect(received).toBeLessThanOrEqual(expected)
Expected: <= 30000
Received:    30607
  at e2e/activity-dock-truthful.spec.ts:1589
```

即 `dock.wall=30607ms` 撞上用例自己的 `toBeLessThanOrEqual(30_000)`。

**关键：红的仍是预算，不是读数。** 同一次失败运行里，AC-188 的**每一个实质读数都是对的**（逐字）：

- `dock.count.desktop=1 legacy.tab=0 legacy.inline=0 resident.activityMarkers=[]`，mobile 同形
- `consistency.turn.desktop={"dock":"in-turn","sidebar":true,"send":"stop"}`，mobile 同形
- `consistency.afterTurnLive.desktop`：`in-turn`×4 → `absent`×20，`sidebar:false, send:"send"` 全程；
  mobile 同形（`in-turn`×5 → `absent`×19）
- `consistency.afterTurn.{desktop,mobile}` 8/8 全 `{"dock":"absent","sidebar":false,"send":"send"}`
- `resident.panel.controls={"start":1,"close":1,"copy":1,"address":1,"pid":1}`

于是这不是「判据假」（单坞数量、旧标记计数、resident 忙闲迁移、活页面与收尾两处一致性全部成立），
而是**判据在负载下会红**。

**地板再测（为什么 30_000 不够，且这次不是被行走顶破的）**

本轮逐字步骤（`ac188.step`，相对 `startedAt`）：`walk-done @15074ms` → `live-window @16399ms` →
`turn-closed @29378ms` → `sampled @30594ms`。把尾部拆开：

| 段 | 耗时 |
|---|---|
| 行走（`await clock`，`unattended-turn@0 → turn-end@5000 → wait@5500`） | `walk-done` 15074ms（结构性，压不动） |
| 活页面 after-turn 窗口（`consistency.afterTurnLive.window=1325ms fromWalkDone=0ms`） | 1325ms |
| **回合后重新导航两个视口 + `toHaveCount(0)`** | **12979ms** |
| 每视口 8×55ms 收尾采样（`sampled`−`turn-closed`） | 1216ms |

**这 12.979s 几乎全是回合后的重新导航**，逐 hop 见日志：

- 两页同时起 hop 1（`page.goto /session/<id>`，默认等 **`load`**，hop 预算 5000ms）；
- 一页 `navigated in 4757ms`（贴着 5s 边缘），另一页 **`did not finish navigating in 5000ms: page.goto:
  Timeout 5000ms exceeded … waiting until "load"`**；
- 超时的那页进 replay：`page.reload` → `navigated in 1085ms`，但整条 `navigateBounded` 已是
  `landed after 12105ms (attempt 2, page.reload)`。

即 **`page.goto` 等 `load` 在负载下越过 5s 探针 → 守卫 replay 一次**，把这段固定成本从安静时的 ~2s
抬到 ~12s。行走本身仍是 ~15s（`walk-done` 14969–15112ms，历次检查都对负载不敏感）。

**为什么早先的修法没守住**

`gap-ac188-criterion-body-budget-below-its-turn-walk-floor`（现 `done`）把该守卫从 `20_000` 抬到
`30_000`，前提是「行走 ~15s + 尾部 3.5–4.2s」。那次尾部之所以只有 ~4s，是因为**当时的重新导航没有踩到
5s 探针**（安静时 hop 在 ~2s 内落下）。本轮负载更高（立案 `load1≈110`，当年立案记录是 `load1 43.5`），
`goto` 等 `load` 越过探针、触发 replay，尾部变成 14.3s。**30_000 从来不是被行走顶破的，是被这段负载
敏感的重新导航顶破的**——所以再抬一次预算不是根治，只是把线画到别处。

**为什么「再抬预算」这条路已经被堵死。** 本轮的整次调用是 **54237ms**，距 60s 闸只剩 ~5.76s；把 body
守卫再抬（例如 40s）会在同量级负载下**直接撞上闸**（闸一红，reason 又只剩 webServer stderr）。AC-188
记录的 `expect:` **没有要求任何墙钟上限**——它要求的是单坞、旧标记计数为 0、resident 忙闲迁移、各处一致、
双视口，外加两个假形态。所以主修法必须是**削掉这段负载敏感的固定成本**，不是抬线。

**边界。** ⛔ `SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸不动；AC-188 的**每一条实质读数一字不删**
（`dock.count.*`、`legacy.*`、`resident.activityMarkers`、`resident.panel.controls`、`consistency.turn.*`、
`consistency.afterTurn.*`、`consistency.afterTurnLive.*`）；AC5/AC6 的断言一条不放松。

<!-- dedup-ref -->
机制去重读数（立案前实测）：`grep -l '^goal_ac: AC-188' tasks/*.md` → 3 份，
`gap-activity-single-dock-global-consistency`、`gap-ac188-criterion-body-budget-below-its-turn-walk-floor`、
`gap-ac188-criterion-agreement-loses-poll-source-falsifiability` **全部 `done`**（门账本口径：done 恰恰是「早先修法没兜住」的证据，故本条为新立，不是重复）。granularity instrument（`--touches
e2e/activity-dock-truthful.spec.ts`）`peers=[]`、`mentions=[]`——无在飞任务与本条同文件或同机制，
**不合并**。

## Plan

1. **先量，再动。** 不改任何断言前，在同一棵树上重复跑判据并采集：`dock.wall=`、整次调用 wall、
   `walk-done`/`turn-closed`/`sampled` 步骤时刻、以及回合后重新导航的逐 hop 日志（`hop N
   (page.goto|page.reload)`、`navigated in Xms`、任何 `did not finish navigating in …ms`），把尾部按段
   分解写进 `## Evidence`。
2. **主修法：削掉尾部里负载敏感的重新导航，二选一，必须给实测理由。**
   - **(a) 不再重新导航**：回合后的 settled `afterTurn` 读数改在**已经活着**的两个视口页上取——live
     window 结束时它们已经 settle（坞 `absent`、sidebar `false`、send `send`，立案读数已逐字证明）。
     settle 的确定性信号本就是「坞自己离开 `in-turn`」，而 live window 已经断言并观察到它
     （`afterTurnLive.some(!inTurn)`）；把这段改成在活页面上直接采 8×55ms，删掉那两次 `navigateBounded`
     的 `page.goto`。
   - **(b) 让重新导航不再等 `load`**：若必须保留一次重新导航（例如要保留「新文档也不会复活旧忙态」这条
     证伪），把该次导航改成挂载即可完成的有界等待（SPA 已 `domcontentloaded` 即 `appears(PANE)` 可知），
     并**证明**改后的 hop 在同等负载下不再踩满探针。⛔ 若改的是共享的 `navigateBounded`，必须回归同文件
     其它用例（AC-184/AC-185/AC-187）或把改动限制在本用例自己的导航调用上。
   两路都⛔不得删/放松任何实质读数与 AC5/AC6 断言。
3. **预算重标（次修法，仅在 step 2 落地后）。** 以改后实测地板重新定 body 守卫：必须覆盖负载下的尾部，
   且**整次调用距 60s 闸留 ≥8s**；若削尾后守卫可保持 30_000 甚至收紧，优先保持/收紧（收紧要有实测依据，
   不要把余量削掉）。
4. **假形态回归（承重）。** 重跑 AC-188 的 `expect:` 写死的两个假形态，各给一条红：
   (i) 恢复 `.chat-activity-tab` 与 `data-slot="chat-activity-inline"` 的挂载 ⇒ 数量读数必须红；
   (ii) 让 `src/modules/sidebar/RunningView.tsx` 改读 1 秒 `/api/session-hosts` 轮询 ⇒ live window 的
   `consistency.afterTurnLive` 必须红（这条证伪力由 `gap-ac188-criterion-agreement-loses-poll-source-
   falsifiability` 建出的活页面窗口承担，本任务只回归，不改它）。
5. **稳定性。** 改后判据连续 ≥8 次 pass，其中至少一次在与立案同量级的负载下运行（记录当时的 `load1`）；
   若仍见红，先判定是地板、闸还是别的机制，不要把红藏起来。
6. **静态闸。** 改动文件过 `npm run typecheck` 与 oxlint（`e2e/` 不在 lint 路径内时，单独
   `npx oxlint e2e/activity-dock-truthful.spec.ts` 并说明既存错误）。
7. **落账并自检。** `task-schema-check.js` exit 0、`quay task check <id> --json` 的 `missing: []`，
   只把 Touches 里列出的文件加进提交。

## AC

- [x] 复现并记录：在 HEAD 树上重复跑判据 ≥4 次，逐次记下 `dock.wall=`、整次调用 wall、`load1`，把序列写进 `## Evidence`（立案读数：一次 exit 1，整次调用 54237ms，`dock.wall=30607ms`）
- [x] 尾部分解实测：一次运行逐字记 `walk-done`/`turn-closed`/`sampled` 与回合后重新导航的逐 hop 日志（含任何 `page.goto … Timeout … waiting until "load"` 与随后的 `page.reload`），按段算出各自的耗时
- [x] 主修法落地：走 (a) 或 (b)（二选一，给出以 step 2 实测为依据的理由），削掉尾部里负载敏感的重新导航固定成本，且未改 `SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸
- [x] 实质读数保留：`dock.count.{desktop,mobile}`、`legacy.tab`、`legacy.inline`、`resident.activityMarkers`、`resident.panel.controls`、`consistency.turn.*`、`consistency.afterTurn.*`、`consistency.afterTurnLive.*` 一条未删（`git diff` 逐条核对），AC5/AC6 断言未放松
- [x] 预算重标：body 守卫按改后实测重新校准，整次调用实测距 60s 闸 ≥8s，并记下该次整次调用 wall
- [x] 假形态 (i)：恢复旧标记挂载后重跑，数量读数**必须红**，逐字记下红的输出
- [x] 假形态 (ii)：`RunningView.tsx` 改读 1 秒轮询后重跑，`consistency.afterTurnLive` 在回合刚结束的窗口内**必须红**，逐字记下红的输出
- [x] 稳定性：改后判据连续 ≥8 次 pass，其中至少一次在与立案同量级的负载下运行（记录该次 `load1`），每次 `dock.count`/`legacy.*`/`resident.*`/`consistency.*` 读数与 AC-188 的 `expect:` 相符
- [x] 静态闸：改动文件过 `npm run typecheck` 与 oxlint（或本仓对该 spec 的等价静态检查），exit 0
- [x] 任务自身 `tasks/gap-ac188-case-budget-red-is-postturn-renavigation-tail.md` 已落账（自触）

## DoD

这是一次**判据可复现性**的落地，不是「测试存在」。判据是真实浏览器上的
`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"`，运行在真实宿主负载下：

- 改后该判据连续 ≥8 次绿，并跨过一次与立案同量级的负载（立案 `load1≈110`）；门账本里那种同树
  pass/fail 交错不再出现。**真实对象是被操作过的**：真实 webServer + Vite 客户端 + 调试 agent 时钟，
  桌面与移动两个视口各读一次。
- 负载敏感的固定成本被**真实削掉**（活页面读数替换了重新导航，或重新导航不再等 `load`），不是把 body
  守卫抬过闸：整次调用实测仍 `< 60s` 闸并留 ≥8s 余量，`SINGLE_SPEC_CEILING_MS = 55_000` 未动。
- AC-188 的每一条实质读数一条未删，AC5/AC6 的断言一条未放松——判据的读数与证伪力都不因削地板而变弱。
- 两个假形态**仍然会红**，各有其机读记录：数量读数（旧标记挂载）与 `consistency.afterTurnLive`
  （1 秒轮询）。
- `## Evidence` 里逐字留档：重跑序列与 wall、尾部逐段分解与逐 hop 导航日志、改后 8 次稳定性读数、
  两个假形态的红、以及整次调用 wall 与 60s 闸的余量。

## Evidence

**测量环境。** `-g "AC-188"`，真实 webServer + Vite 客户端 + 调试 agent 时钟，桌面 `page` 1280×800 与
移动 `mobile` 390×844；所有运行都用 `bash scripts/with-memory-cap.sh` 包住。`load1` 为运行时
`/proc/loadavg` 的第一字段（本机 runnable 计数）。全部日志在 `/tmp/`，文件名逐条给出。改后提交
`2b774f6d`（父 `9c32dc9a`）。

### §1 复现（AC1）：pre-fix 树上判据序列

pre-fix 树 = `HEAD^`（`9c32dc9a`）的 `e2e/activity-dock-truthful.spec.ts`，即 develop 上的 AC-188 用例。

**§1a 立案读数。** 一次 `exit 1`，**整次调用 54237ms**，`dock.wall=30607ms`（撞 `toBeLessThanOrEqual(30_000)`），
load1≈110（`/tmp/ac188-rerun-1.log`）。

**§1b 立案前存档 baseline（12 次，逐次 dock.wall + 步骤时刻；当时未逐次记整次调用 wall 与 load1）。**

| 日志 | walk-done | turn-closed | 尾段(Δ) | dock.wall | `page.goto` 探针超时次数 |
|---|---|---|---|---|---|
| baseline-1 | 15041 | 18729 | 3688 | 19811 | 0 |
| baseline-2 | 15396 | 21892 | 6496 | 23243 | 0 |
| baseline-3 | 15105 | 19134 | 4029 | 20297 | 2 |
| baseline-4 | 15020 | 18713 | 3693 | 19806 | 0 |
| baseline-5 | 15044 | 18787 | 3743 | 19898 | 0 |
| baseline-6 | 15004 | 18617 | 3613 | 19724 | 0 |
| load-1 | 16045 | 22472 | 6427 | 23933 | 0 |
| load-7 | 16140 | 23984 | 7844 | 25847 | 1 |
| load-9 | 15063 | 19056 | 3993 | 20168 | 0 |
| load-10 | 15015 | 19071 | 4056 | 20222 | 0 |
| load-11 | 15057 | 18945 | 3888 | 20053 | 0 |
| load-13 | 16165 | 24281 | 8116 | 26171 | 1 |

`walk-done` 15004–16165ms（跨负载稳定）；尾段（`turn-closed`−`walk-done`）3613–8116ms，随负载抬升，即**负载敏感**。

**§1c 立案后重跑 4 次（本次，逐次记 dock.wall + 整次调用 wall + load1）。** 在 worktree 内临时恢复 `HEAD^`
的用例（`git show HEAD^:e2e/activity-dock-truthful.spec.ts`，跑完 `git checkout --` 还原；源内
`grep -c 'after the turn closed'` = 1 ⇒ pre-fix）：

| 运行 | load1 | walk-done | turn-closed | 尾段(Δ) | dock.wall | 整次调用 wall | exit |
|---|---|---|---|---|---|---|---|
| prefix1 (`/tmp/ac188-prefix-rerun-1.log`) | 22.60 | 15380 | 19646 | 4266 | 20891 | 38930 | 0 |
| prefix2 (`…-2.log`) | 60.06 | 15090 | 20299 | 5209 | 22036 | 37308 | 0 |
| prefix3 (`…-3.log`) | 65.73 | 15215 | 19424 | 4209 | 20611 | 38936 | 0 |
| prefix4 (`…-4.log`) | 81.53 | — | — | — | — | 34434 | **1（失败）** |

§1 结论：pre-fix 树上 `dock.wall` 与尾段随负载抬升（quiet ~20.6–20.9s / tail ~3.6–4.2s → loaded ~22.0s /
tail ~5.2s → 探针连超 ⇒ 守卫死、`exit 1`），复现了 `## Proposal` 的「负载下再红」。

### §2 尾部分解（AC2）：pre-fix 逐 hop

§1c 的 prefix4（`/tmp/ac188-prefix-rerun-4.log`）在**回合后的重新导航**上逐字踩中立案机理：

```
[e2e] client startup: hop 1 (page.goto /session/3293a041-…-6a71fdb1bcde) begins with 5000ms of navigation budget
[e2e] client startup: hop 1 (page.goto) did not finish navigating in 5000ms: page.goto: Timeout 5000ms exceeded.
  - navigating to "http://127.0.0.1:13639/session/3293a041-…-6a71fdb1bcde", waiting until "load"
[e2e] client startup: hop 2 (page.reload /session/3293a041-…) begins with 5000ms of navigation budget
[e2e] client startup: hop 2 (page.reload) did not finish navigating in 5000ms: page.reload: Timeout 5000ms exceeded.
[e2e] client startup: hop 3 (page.reload /session/3293a041-…) begins with 1987ms of navigation budget
[e2e] client startup: hop 3 (page.reload) did not finish navigating in 1987ms: page.reload: Timeout 1987ms exceeded.
```

该次失败逐字：`Error: the chat pane on the desktop page for 3293a041-… never rendered, so this run's client
never came up to a document that stays (the navigation itself failed: page.reload: Timeout 1987ms exceeded.)`
（用例体 21.9s；`1 failed`）。

按段分解（立案读数：`walk-done @15074` → `live-window @16399` → `turn-closed @29378` → `sampled @30594`）：

| 段 | 立案耗时 | 本次实测（§1b/§1c） |
|---|---|---|
| 行走 `await clock`（`walk-done`） | 15074ms（结构性） | 15004–16165ms |
| 活页面 after-turn 窗口（`fromWalkDone=0ms`） | 1325ms | ~1300ms |
| **回合后重新导航两视口 + `toHaveCount(0)`** | **12979ms** | 3613–8116ms（不踩探针时）；> 5s 探针 ×3 ⇒ 守卫死（prefix4） |
| 每视口 8×55ms 收尾采样 | 1216ms | ~1030–1072ms |

即尾段的增量**几乎全是回合后的重新导航**：`page.goto` 等 `load` 在负载下越过守卫自己的 5s 探针 → replay
一次（`page.reload`）→ 固定成本从安静 ~2.4s 抬到 ~6.7s，最重时探针连超、守卫抛 `never rendered`。行走
本身 ~15.0–16.2s，对负载不敏感。

### §3 主修法（AC3）：走 (a)

**取 (a)：settled `afterTurn` 读数改在已经活着的两个视口页上取，删掉回合后那两次 `navigateBounded` 的
`page.goto`。** 依据：§2 显示重新导航的耗散几乎全落在它自己 `page.goto`/`page.reload` 等 `load` 的启动上，
而它要产生的状态**已经在这两个页面上**——活窗口（同一段代码，起点 `fromWalkDone=0ms`）已断言并观察到坞
离开 `in-turn`（其后的 `some(!inTurn)` 守卫），窗口末样本读 `absent`/`false`/`send`，正是下面 settled
断言的状态；一次新 `chat_subscribed` 只能复述窗口已量到的东西。(b) 需要改共享的 `navigateBounded`
（AC-184/185/187 与启动探针共用），不动是更小的爆炸半径。

改后 `live-window`→`turn-closed` = **11–13ms**（§8 表；1307–1413ms 的尾段几乎全是 8×55ms 收尾窗口），重新
导航固定成本被真实削掉。**边界：`SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸逐字未动**，见 §4。

### §4 实质读数保留（AC4）

`git diff 2b774f6d^..2b774f6d -- e2e/activity-dock-truthful.spec.ts` 只有三处：活窗口文档注释、回合后
重新导航块的删/评注、body 守卫注释与 `30_000`→`25_000`。逐条核对：

- 保留且逐字未改的实质读数：`dock.count.{desktop,mobile}`、`legacy.tab`、`legacy.inline`、
  `resident.activityMarkers`、`resident.panel.controls`、`consistency.turn.*`、`consistency.afterTurn.*`、
  `consistency.afterTurnLive.*`（含 `consistency.afterTurnLive.window.*` 与 `sampled`）。
- AC5 断言（`reading.docks`、`reading.legacy`、`residentActivityMarkers`、`panel.*`、`consistency.turn.*`）
  与 AC6 断言（`disagreements`、`liveDisagreements`、`some(!inTurn)`、`settled.*`）一条未放松。
- `git diff … | grep -E '^[-+].*(55_000|60_000)'` 为空。

### §5 预算重标（AC5）

body 守卫 `30_000` → `25_000`，理由见改后注释：改后实测地板 = 行走 15.0–16.9s（跨负载稳定）+ 8×55ms 收尾
窗口 ≈ body 17.4–20.1s。**一次负载下整次调用 wall = 49219ms（load1 161→164），距 60s 闸 10781ms（10.78s）
≥ 8s**；`dock.wall=19503ms` < 25000。安静次整次调用 28896–42300ms，余量 17.7–31.1s（见 §8）。

### §6 假形态 (i)：恢复旧标记挂载 ⇒ 数量读数必须红（AC6）

在 `src/modules/chat/composer/ActivityIndicator.tsx` 的 `[data-activity-dock-surface]` 上恢复
`chat-activity-tab` 类与 `data-slot="chat-activity-inline"`（即 `ad1bb63a` 拆掉的那两个挂载），跑完还原
（`git checkout --`，工作区回到仅 spec 一处改动）。`/tmp/ac188-false-i.log`：

```
dock.count.desktop=1 legacy.tab=1 legacy.inline=1 resident.activityMarkers=[]
dock.count.mobile=1 legacy.tab=1 legacy.inline=1 resident.activityMarkers=[]
  ✘  … AC-188 one dock, no legacy surface, …
    Error: desktop: the old tab class and the inline slot must not match anything
    expect(received).toEqual(expected) // deep equality
    - Expected  - 1
    + Received  + 4
      > 1524 |       ).toEqual([]);
  1 failed
exit=1 invocation_ms=30756
```

数量读数由 `0` 变 `1`（两视口），断言 red，`exit 1`。

### §7 假形态 (ii)：`RunningView.tsx` 改读 1 秒轮询 ⇒ `consistency.afterTurnLive` 必须红（AC7）

忠实复原前序任务存档的「字面 1 秒轮询」形式（`/tmp/ac188-falsification/fake-ii-literal-poll.RunningView.tsx`，
与今日 worktree 文件同源）：`useState(new Set())` + 挂载即 `tick()`，随后 `setInterval(() => void tick(), 1000)`，
`tick` 读 `api.sessionHosts.list()` 收 `binding.leases.some(l => l.kind === 'turn')`，交给
`classifyRunningSessions(polledBusy, snapshot)`；跑完从备份还原并断言 `restored IDENTICAL`。`/tmp/ac188-false-ii.log`：

```
consistency.afterTurnLive.desktop=[{in-turn,false,send}×4, {absent,false,send}×20]
consistency.afterTurnLive.mobile=[{in-turn,true,send}×5, {absent,true,send}×4, {absent,false,send}×15]
consistency.afterTurnLive.window=1300ms fromWalkDone=0ms
  ✘  … AC-188 one dock, no legacy surface, …
    Error: mobile: no live reading may show the dock leave the turn while the sidebar or the send button still says busy
    expect(received).toEqual(expected) // deep equality
    - Expected  -  1
    + Received  + 22
    - Array []
    + Array [
    +   Object { "dock": "absent", "send": "send", "sidebar": true },   ← ×4
    + ]
      > 1565 |       ).toEqual([]);
  1 failed
exit=1 invocation_ms=32931
```

移动页在坞转 `absent` 之后**仍连报 `sidebar:true` 4 个样本（≈220ms）**，正是判据抓的 `-St` 段；断言 red，
`exit 1`。桌面页本次在窗口内全程 `sidebar:false`（同前序任务记录的 §2(a)-a1 方向边界），红落在 mobile。

### §8 稳定性（AC8）：改后（final tree，含 `25_000` 守卫）连续 8 次 pass

| 运行 | load1 | walk-done | turn-closed | 尾段(Δ) | dock.wall | 整次调用 wall | 结果 |
|---|---|---|---|---|---|---|---|
| final-load (`/tmp/ac188-final-load.log`) | 161→164 | 16427 | 17840 | 1413 | 19503 | 49219 | pass |
| final-1 (`/tmp/ac188-final-1.log`) | 26.75 | 15044 | 16353 | 1309 | 17463 | 28896 | pass |
| final-2 | 24.28 | 15024 | 16347 | 1323 | 17534 | 42300 | pass |
| final-3 | 24.75 | 15030 | 16365 | 1335 | 17705 | 29721 | pass |
| final-4 | 33.35 | 15214 | 16529 | 1315 | 17808 | 36543 | pass |
| final-5 | 60.22 | 15041 | 16352 | 1311 | 17447 | 39162 | pass |
| final-6 | 39.85 | 15056 | 16363 | 1307 | 17453 | 28965 | pass |
| final-7 | 29.79 | 15024 | 16331 | 1307 | 17444 | 29085 | pass |

8/8 pass，跨 load1 24.28–164；其中 final-load 在**与立案同量级（甚至更高）的负载**（load1 161⇒164）下绿。
每次 `dock.count.{desktop,mobile}=1`、`legacy.tab=0 legacy.inline=0`、`resident.activityMarkers=[]`、
`resident.panel.controls={start,close,copy,address,pid}=1`、`consistency.turn.*` / `consistency.afterTurn.*` /
`consistency.afterTurnLive.*` 均与 AC-188 的 `expect:` 相符。尾段所有 8 次都 ≈1.3s（仅收尾/活窗口），任一
负载下 `turn-closed`−`live-window` ≤ 13ms。（改前 11 次绿：fix2–fix9 安静 8 次 + fixon13–15 负载 3 次，此处
不重列。）

### §9 静态闸（AC9）

- `npm run typecheck` → **exit 0**。
- `npm run lint`（`oxlint src/ server/ scripts/ shared/`）→ **exit 0**（仅 warning）。本仓 lint 路径**不含
  `e2e/`**，故按 Plan step 6 单独跑 spec：
- `npx oxlint e2e/activity-dock-truthful.spec.ts` → exit 1，**唯一**一条既存错误
  `:948:7 error eslint(no-unused-vars): Variable 'CONSOLIDATION_SCENARIO' is declared but never used.`——
  对 `HEAD^` 的同文件同命令得**逐字相同**一条（baseline 该行也是「声明未用」），本次改动零新增。
- 独立 `tsc --noEmit … e2e/activity-dock-truthful.spec.ts` → 1 条既存 `afterTurnIdle` 缺失（`:1394`
  `readings.push({…})` 处），对 `HEAD^` 同命令**逐字相同**（`e2e/` 不在任一 `tsconfig.json` 内，不在任何
  门路上），本次改动零新增。

（既存错误即 Plan step 6 括号里预告并允许「说明」的那类；两处均以 `HEAD^` 对照证明**本次零新增**。）

## Touches

- `e2e/activity-dock-truthful.spec.ts`（回合后 settled 读数/重新导航的固定成本与 body 守卫）
- `tasks/gap-ac188-case-budget-red-is-postturn-renavigation-tail.md`（自触）
