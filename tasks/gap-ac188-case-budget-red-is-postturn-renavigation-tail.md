---
id: gap-ac188-case-budget-red-is-postturn-renavigation-tail
title: AC-188 用例体预算负载下再红：尾部 14.3s 几乎全是回合后重新导航（goto 等 load 撞 5s
  探针→reload），修掉这段负载敏感固定成本而非再抬预算
status: todo
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
`gap-ac188-criterion-agreement-loses-poll-source-falsifiability` **全部 `done`**（门账本口径：done
恰恰是「早先修法没兜住」的证据，故本条为新立，不是重复）。granularity instrument（`--touches
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

- [ ] 复现并记录：在 HEAD 树上重复跑判据 ≥4 次，逐次记下 `dock.wall=`、整次调用 wall、`load1`，把序列写进 `## Evidence`（立案读数：一次 exit 1，整次调用 54237ms，`dock.wall=30607ms`）
- [ ] 尾部分解实测：一次运行逐字记 `walk-done`/`turn-closed`/`sampled` 与回合后重新导航的逐 hop 日志（含任何 `page.goto … Timeout … waiting until "load"` 与随后的 `page.reload`），按段算出各自的耗时
- [ ] 主修法落地：走 (a) 或 (b)（二选一，给出以 step 2 实测为依据的理由），削掉尾部里负载敏感的重新导航固定成本，且未改 `SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸
- [ ] 实质读数保留：`dock.count.{desktop,mobile}`、`legacy.tab`、`legacy.inline`、`resident.activityMarkers`、`resident.panel.controls`、`consistency.turn.*`、`consistency.afterTurn.*`、`consistency.afterTurnLive.*` 一条未删（`git diff` 逐条核对），AC5/AC6 断言未放松
- [ ] 预算重标：body 守卫按改后实测重新校准，整次调用实测距 60s 闸 ≥8s，并记下该次整次调用 wall
- [ ] 假形态 (i)：恢复旧标记挂载后重跑，数量读数**必须红**，逐字记下红的输出
- [ ] 假形态 (ii)：`RunningView.tsx` 改读 1 秒轮询后重跑，`consistency.afterTurnLive` 在回合刚结束的窗口内**必须红**，逐字记下红的输出
- [ ] 稳定性：改后判据连续 ≥8 次 pass，其中至少一次在与立案同量级的负载下运行（记录该次 `load1`），每次 `dock.count`/`legacy.*`/`resident.*`/`consistency.*` 读数与 AC-188 的 `expect:` 相符
- [ ] 静态闸：改动文件过 `npm run typecheck` 与 oxlint（或本仓对该 spec 的等价静态检查），exit 0
- [ ] 任务自身 `tasks/gap-ac188-case-budget-red-is-postturn-renavigation-tail.md` 已落账（自触）

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

## Touches

- `e2e/activity-dock-truthful.spec.ts`（回合后 settled 读数/重新导航的固定成本与 body 守卫）
- `tasks/gap-ac188-case-budget-red-is-postturn-renavigation-tail.md`（自触）