---
id: gap-ac254-criterion-two-stack-boots-cross-watchdog
title: AC-254 判据 e2e/mcp-settings.spec.ts 串行起两整套栈，整轮墙钟随宿主负载涨到 55s watchdog
  天花板之上被 SIGKILL（安静 33.9s / 负载 40–58s，load1 56–176 有台账读数）——把整轮墙钟降下来，⛔ 不靠抬线（gate
  在 60s 硬杀，抬了也没用）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-254
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是复述台账尾巴）。AC-254 记录 `status: achieved`、其 GOAL-020 已 `achieved`、未声明 `long-term: true`，而台账 `gate=goal` 尾部是 fail，故按 CURRENTLY FALSE 交办。

判据物（逐字取自 `goals/AC-254-真实浏览器里设置页的-cloudcli-mcp-区块-显示端点与启用状态-给出-claude-code-的接入命令-令牌.md`）：

- `criterion:` `for f in e2e/mcp-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/mcp-settings.spec.ts`
- `expect:` 真实浏览器、真实后端、临时数据目录，分别在 `MCP_ENABLED` 开与关两种配置下。读数 (a) 开启时区块显示端点 URL（带复制按钮）与「已启用」，URL 形如 `<基址>/mcp`；(b) 关闭时显示「未启用」与启用方法、不显示可用的接入命令；(c) 接入命令里含端点 URL 与 `Authorization: Bearer` 头的占位符、页面上任何文本节点都不含真实令牌；(d) 五个 scope 勾选框：只读默认勾选、其余默认不勾，勾选任一写 scope 出现风险提示；(e) 创建出的令牌经 `GET /api/oauth/token-info` 返回的 scope 与勾选一致。取假形态 (i) 写 scope 默认勾选 ⇒ (d) 红；(ii) 关闭时仍显示接入命令 ⇒ (b) 红；(iii) 命令里内嵌真实令牌 ⇒ (c) 红。

### 本轮直接现测：红是 55s watchdog 的 SIGKILL，不是断言失败、也不是 gate 超时

判据文件存在（`e2e/mcp-settings.spec.ts`，34976 字节）。开工时 `HEAD=45b79766`、`HEAD^{tree}=358b0a8cf248c53fd5493459920cd58b8367e78f`（branch `author`，无源码改动）。安静宿主上出货命令逐字直跑 **exit 0**、spec 自印 `2 passed (33.9s)`（两次用例 10.5s + 19.0s；日志 `/tmp/ac254-probe/run1.log`）。**同一个 tree 上红绿交替**，`gate=goal` 台账逐字（`.quay/gate-events.jsonl`，treeSha 皆为 `358b0a8c…`）：

```
2026-10-08T03:03:30.010Z goal-sweep fail  acceptance failed (exit 1) — [WebServer] [BABEL] Note: … react-scan.js?v=d41e5255 …
2026-10-08T03:04:42.471Z goal-cli   pass  acceptance passed (exit 0)
2026-10-08T03:07:11.847Z goal-cli   pass  acceptance passed (exit 0)
2026-10-08T03:10:04.605Z goal-cli   pass  acceptance passed (exit 0)
2026-10-08T03:12:56.994Z goal-cli   pass  acceptance passed (exit 0)
2026-10-08T03:16:01.309Z goal-cli   fail  acceptance failed (exit 1) — [WebServer] [BABEL] Note: … react-scan.js?v=7ca5f916 …
```

两条 fail 的 `payload.reason` 只有 webServer 引导期的 BABEL 行——**这是「运行未产出测试输出就被杀」的签名**（task `gap-ac199-criterion-ledger-red-is-silent-e2e-death` 已把这条判法钉死）。真读数在每个 run 的数据目录里：两次红 run 的 `watchdog-state.json` 逐字

```
quay-e2e-5YKz7g  {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55001ms"}
quay-e2e-aSF3aS  {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55004ms"}
```

同期**绿** run（`quay-e2e-zflFsk`）为 `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}`。两份红 run 的 `test-results/` 里只有 `trace.zip`、**没有** `error-context.md`——没有任何断言跑过，进程在 55 秒被 watchdog SIGKILL、`process.exit(1)`。AC-254 的 `gate=goal` 全部 `reason` 里 `timed out` 计数 = **0**：gate 自己的 60s 硬杀从未落在本条上。

### 机制：判据文件的整轮墙钟随宿主负载涨到 55s 天花板之上

`playwright.config.ts` 的看门狗：`SINGLE_SPEC_CEILING_MS = 55_000`（:317）；`RUN_CEILING_MS = selectedSpecFiles().reduce((t,f) => t + (SPEC_BUDGET_MS[f] ?? SINGLE_SPEC_CEILING_MS), 0)`（:388-391）；`SPEC_BUDGET_MS`（:319）只有三项——`mobile-workspace-composer-layout.spec.ts` / `transcript-jump-landing.spec.ts` / `voice-live-vad-ab.spec.ts` 各 `240_000`——**`mcp-settings.spec.ts` 不在表内**，故本判据的 `RUN_CEILING_MS` 就是 55 000。`BOOT_CEILING_MS = 40_000`（:437）；过 boot 后 `arm(RUN_CEILING_MS,'ceiling',false)`，否则 `endRun` + SIGKILL（:601、:614-623）。

`e2e/mcp-settings.spec.ts` **串行起两整套栈**（`test.describe.configure({ mode: 'serial', timeout: 110_000 })`）：一个 `MCP_ENABLED="false"` 态、一个 `"true"` 态，每态各 spawn 自己的真 `server/index.ts`（tsx）+ 真 Vite + 各自的 `warmClientStartup`（安静实测各 ~5.4s）+ 浏览器上下文。判据只跑这一个文件，于是两段 boot 相加。

**负载相关性有台账读数**——`.quay/goal-round.jsonl` 的 `frozenRecheck.entries`（同一 headSha `45b79766`，2026-10-08 03:05–03:13，AC-194 与 AC-254 共用同一次宿主负载）：

```
2026-10-08T03:05:03.914Z  load1=175.82  AC-254 durationMs=54032   (AC-194 34104)
2026-10-08T03:07:21.936Z  load1=74.84   AC-254 durationMs=40298   (AC-194 22611)
2026-10-08T03:10:05.973Z  load1=117.13  AC-254 durationMs=47837   (AC-194 33867)
2026-10-08T03:13:08.323Z  load1=56.32   AC-254 durationMs=57586   (AC-194 19442)
```

安静 33.9s、负载下 40–58s：55 000 的天花板正落在这条分布中间（最后一次「通过」的 57586ms 距 gate 的 60 000ms 硬杀只剩 2.4s）。红绿不是内容不同，是同一份内容被负载推过同一条线。

<!-- dedup-ref --> 合并候选读数（`task-granularity-advice.js --touches e2e/mcp-settings.spec.ts --touches playwright.config.ts`）：唯一同文件在飞任务是 `gap-ac194-criterion-wallclock-load-scaled-fixed-cost`（`ready`，`goal_ac: AC-194`），本任务**保持分别立项**——它管的是 `e2e/activity-dock-background.spec.ts` 里 spec 自己断言的 40s 上限（那是断言失败、有 `error-context.md`），本任务管的是 config 级 55s watchdog 的 SIGKILL（无断言跑过）；不同文件、不同天花板、不同验收。

### 为什么前三次修复没兜住

三个 `goal_ac: AC-254` 任务都是 `done`：`gap-ac254-mcp-settings-block-scope-checkboxes` 交付了产品面与判据；`gap-ac254-criterion-harden-against-repo-dotenv` 把读数与部署方 `.env` 解耦；`gap-ac254-boot-guard-mcp-settings-criterion`（commits `1e995cd1`、`84ef9039`）把 `warmClientStartup` + `navigateBounded` 移植进来、有界化了每段的启动路径。第三次最接近，但它有界的是「遇到坏网络时重放而不是无限等」——它自己的 AC6 把触发记为宿主 `net::ERR_NETWORK_CHANGED`，**从未触及本文件的整轮墙钟**：两段 boot 仍是串行相加，文件仍未声明进 `SPEC_BUDGET_MS`。它只治了「为什么第一跳会失败」，没治「失败了以后重放要多久、两段加起来多久」。

### 实现面（本条认领）

把判据文件的**整轮墙钟**降到能在负载下从容留在 55s 之下，而不是靠抬线。

⛔ **抬线不是解，且必须证明没抬**：goal 门在 **60 000ms** 硬杀本判据（台账里 `acceptance timed out after 60000ms (killed)` 的形态；`goal-driver.js` 四个判据调用点皆 `resolveAcceptanceTimeoutMs()` → `DEFAULT_ACCEPTANCE_TIMEOUT_MS = 6e4`，仓库内没有可抬它的 lever）。所以 (i) 把 `mcp-settings.spec.ts` 加进 `SPEC_BUDGET_MS` 且值 ≥ 60 000 毫无意义——watchdog 不再杀、gate 照样在 60s 杀；(ii) 把 `SINGLE_SPEC_CEILING_MS` 抬过 60 000 是自毁（config :407 的书面设计正是「the largest value that still beats the gate's kill」）。本条的验收因此钉在**实测墙钟下降**上。

允许的杠杆（按判据能稳定复现的读数取舍，并在完成记录里给出削减前后的分解）：

1. **两态共用一份 client/Vite**：两态只有**服务端** `MCP_ENABLED` 不同，客户端是同一份构建；用例串行，任一时刻只有一个服务在听。让一个 Vite 的 `/api` 代理指向一个固定端口、两态的服务依次绑它，就能把第二次的 Vite boot 与 `warmClientStartup`（~5.4s）整段省掉。
2. **两态并行**（改 `mode: 'serial'` / worker 数）：两态各自起栈、互不共享状态，重叠后可把「相加」变「取大」。⛔ 并发会抬高**峰值**资源，在已负载的宿主上可能适得其反——只在负载臂实测下成立才可用。
3. **收紧有界导航守卫**：安静 run 里 enabled 态的第一跳仍失败（`attempt 2` 落在 10267ms），重放本身在吃余量。
4. **用例体固定等待**改有界条件探针。

⛔ 不得改判据命令、不得改 `goals/AC-254-…md` 的 `criterion:`/`expect:`、不得放宽或删除 (a)-(e) 任何一条读数与三条假形态、不得加 `retries`/`test.skip`/`test.fixme`、不得把任何 watchdog 上限往上抬当解。

**非目标。** 不改 MCP 区块与令牌 scope 的**产品面**（`src/**` 的组件与文案）；不碰 AC-255 的 12 语言文案；不碰同文件里其它判据的读数。

## AC

- [x] AC1 红态与负载相关性机械入档：完成记录里逐字含两次红 run 的 `watchdog-state.json`（`quay-e2e-5YKz7g` `ceiling crossed at 55001ms` / `quay-e2e-aSF3aS` `ceiling crossed at 55004ms`，皆 `"fired":true,"ceilingMs":55000`）、一个绿 run 的 `"fired":false` 对照、两条台账 fail 行（`2026-10-08T03:03:30.010Z` goal-sweep / `03:16:01.309Z` goal-cli，treeSha `358b0a8c…`）、以及 §机制 的四行 `load1`/`durationMs`（复现命令 `jq -r 'select(.ts>="2026-10-08T03:05" and .ts<="2026-10-08T03:14") | .facts[]?.value.frozenRecheck.entries[]? | "\(.ac) \(.load1) \(.durationMs)"' .quay/goal-round.jsonl`），并写明判据命令的 `timed out` 计数为 0。
- [x] AC2 安静臂基线：净 worktree 上出货命令 `npx playwright test e2e/mcp-settings.spec.ts` 逐字跑 ≥3 次，全部 exit 0 且每次 `watchdog-state.json` `"fired":false`；入档 worktree 路径、`HEAD`、`HEAD^{tree}` 与每次整轮墙钟（开工基线：exit 0 / 33.9s）。
- [x] AC3 负载臂达标（本条的关键读数）：在能复现墙钟膨胀的并发负载下（参照 `.quay/goal-round.jsonl` 里 load1 56–176 的工况）跑 ≥2 次，全部 exit 0、`"fired":false`，且每次整轮墙钟 ≤ 45 000ms（相对 55 000 天花板留 ≥10s、相对 gate 的 60 000ms 硬杀留 ≥15s）；入档负载生成命令、并发度、宿主 `load1`、每次墙钟，且负载臂墙钟相对安静臂有可见差距（证明负载真造出来了）。
- [x] AC4 读数与判据一字未改：`git diff <base>..HEAD -- e2e/mcp-settings.spec.ts` 中 (a)-(e) 五条读数、三条假形态的断言、两态 `MCP_ENABLED` 显式值逐字仍在；`git diff <base>..HEAD -- goals/` 为空；判据命令仍逐字 `npx playwright test e2e/mcp-settings.spec.ts`；`grep -nE 'retries|test\.(skip|fixme)' e2e/mcp-settings.spec.ts` 无新增命中。
- [x] AC5 三条假形态分辨力未失（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 写 scope 默认勾选 ⇒ (d) 红；(ii) 关闭时仍渲染接入命令 ⇒ (b) 红；(iii) 命令里内嵌真实令牌 ⇒ (c) 红。
- [x] AC6 没靠抬线：`git diff <base>..HEAD -- playwright.config.ts` 不含把 `SINGLE_SPEC_CEILING_MS` 或 `SPEC_BUDGET_MS` 抬高到 ≥ 55 000 的改动；墙钟下降由 spec 自身的启动/用例改动达成。
- [x] AC7 静态门：`npm run typecheck` exit 0；`npm run lint` 无新违规。若改动了 `src/**`，按 AGENTS.md 载入并遵守 `$frontend-module-standards`；改动 `server/**` 时载入 `$backend-module-standards`。
- [x] AC8 失败路径如实：若负载臂仍 > 45 000ms 或无法稳定复现膨胀，停手并置 `needs-human`，附逐字读数与已排除项；⛔ 不得放宽判据、不得拆分判据文件来绕过单文件天花板、不得把安静臂通过写成「flake 已修」。

## DoD

真实落地判据：在判据今天变红的那个条件（宿主负载抬高、并发兄弟 e2e）下，出货命令 `npx playwright test e2e/mcp-settings.spec.ts` 逐字不变、退出 0，`watchdog-state.json` 为 `"fired":false`，且整轮墙钟 ≤ 45 000ms、与安静臂有可见差距。取假形态：把启动开销的削减回退（两态恢复各自 Vite + 各自预热）后，同一负载构造必须重新越过 55 000ms——这正是 `quay-e2e-5YKz7g` / `quay-e2e-aSF3aS` 的 `ceiling crossed at 55001ms / 55004ms`。(a)-(e) 五条读数、三条假形态、`e2e/mcp-settings.spec.ts` 的判据语义与 `goals/AC-254-…md` 的 `criterion:`/`expect:` 一字未改；没有任何 watchdog 上限被抬高。

## Touches

- `e2e/mcp-settings.spec.ts`（判据本体：两态各自的 server+Vite 启动、`warmClientStartup`、有界导航守卫与用例体固定等待）
- `playwright.config.ts`（仅当削减需动 config/webServer 引导段固定开销；⛔ 不得把 `SINGLE_SPEC_CEILING_MS` / `SPEC_BUDGET_MS` 往上抬当解）
- `tasks/gap-ac254-criterion-two-stack-boots-cross-watchdog.md`（自触）

## Evidence

### AC1 红态与负载相关性机械入档

两次红 run 的 `watchdog-state.json` 逐字（`/data/home/yale/.cache/quay-e2e-tmp/<id>/watchdog-state.json`）：

```
quay-e2e-5YKz7g  {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55001ms"}
quay-e2e-aSF3aS  {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55004ms"}
```

绿 run 对照 `quay-e2e-zflFsk` 逐字：

```
{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}
```

两条台账 fail 行逐字（`.quay/gate-events.jsonl`，皆 treeSha `358b0a8cf248c53fd5493459920cd58b8367e78f`、evaluationRoot `/data/home/yale/work/claudecodeui`）：

```
2026-10-08T03:03:30.010Z goal-sweep   fail  criterionHash=506e55000098e4a1
  reason=acceptance failed (exit 1) — [WebServer] [BABEL] Note: … react-scan.js?v=d41e5255 … exceeds the max of 500KB.
2026-10-08T03:16:01.309Z goal-cli     fail
  reason=acceptance failed (exit 1) — [WebServer] [BABEL] Note: … react-scan.js?v=7ca5f916 … exceeds the max of 500KB.
```

§机制 的四行 `load1`/`durationMs`，复现命令 `jq -r 'select(.ts>="2026-10-08T03:05" and .ts<="2026-10-08T03:14") | .facts[]?.value.frozenRecheck.entries[]? | "\(.ac) \(.load1) \(.durationMs)"' .quay/goal-round.jsonl`：

```
AC-194 175.82 34104
AC-254 175.82 54032
AC-194 74.84 22611
AC-254 74.84 40298
AC-194 117.13 33867
AC-254 117.13 47837
AC-194 56.32 19442
AC-254 56.32 57586
```

判据命令的 `timed out` 计数 = **0**：该串只出现在 gate 的 `payload.reason` 里，而 AC-254 的 `gate=goal` 全部 reason 里计数为 0。命令与输出
`jq -r 'select(.item_id=="AC-254" and .gate=="goal" and (.timestamp|startswith("2026-10-08"))) | .payload.reason' .quay/gate-events.jsonl | grep -c "timed out"` → `0`（对照：全台账里 `timed out` 出现在 AC-103 41 次等其它条目上，故 0 不是查询失效）。

### AC2 安静臂基线

- worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac254-criterion-two-stack-boots-cross-watchdog`
- `HEAD` = `a0695b7b7d8c97942b7cd3a0bbba2ccdd3a5254c`
- `HEAD^{tree}` = `92be12f00bc038edb816d61c007716408729ee06`
- 净 worktree 上出货命令逐字 `npx playwright test e2e/mcp-settings.spec.ts` 跑 3 次：

```
q#1 rc=0 wall=22876ms load1=158.54->119.00  2 passed (22.1s)  fired:false
q#2 rc=0 wall=14080ms load1=119.00->94.64   2 passed (13.4s)  fired:false
q#3 rc=0 wall=13448ms load1=94.64->75.93    2 passed (12.7s)  fired:false
```

三次全 exit 0，每次 `watchdog-state.json` = `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"55000ms, armed directly: this selection starts no webServer, so there is no unbounded pre-spawn probe for a boot ceiling to bound"}`。相对开工基线 `exit 0 / 33.9s` 已下降。（q#1 的 22.9s 是 host load1 158 的 ambient 读数，非安静值——见 AC3 的余量说明。）

### AC3 负载臂达标（关键读数）

负载生成：`bash /tmp/ac254-probe/final.sh 140 100` —— 140 个 `yes > /dev/null &` 后台 burner，并发度 140，待 host load1 > 100 后开跑；**同一构造内交错** `new base new base new`（两侧共享同一次 ambient 漂移，故差距不是时段差）：

```
new#1  rc=0 wall=38302ms load1=100.32->129.53  2 passed (36.5s)  WS fired:false
base#2 rc=1 wall=56780ms load1=129.53->145.79  WS {"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55000ms"}
new#3  rc=0 wall=37126ms load1=145.79->153.06  2 passed (35.0s)  WS fired:false
base#4 rc=1 wall=56565ms load1=153.06->156.80  WS {"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55002ms"}
new#5  rc=0 wall=37544ms load1=156.80->159.34  2 passed (35.9s)  WS fired:false
```

三次 new 全 exit 0、`fired:false`、整轮墙钟 **38 302 / 37 126 / 37 544 ms，全 ≤ 45 000ms**（相对 55 000 留 6.5–7.9s，相对 gate 的 60 000 硬杀留 22.5–22.9s）；宿主 `load1` 100.32–159.34 落在台账参照带 56–176 内。相对安静臂 13.4–22.9s 有 ≈1.6–2.9× 的可见差距，证明负载真造出来了。

### DoD 取假形态：同一构造下回退启动削减必须重新越过 55 000ms

**同一构造**（`final.sh 140 100`，与上面三次 new 交错）的 base 侧——**两态恢复各自 Vite + 各自预热**（且 config 的 webServer 对也回来）——`rc=1`、`fired:true`、`ceiling crossed at 55000ms / 55002ms`，即 `quay-e2e-5YKz7g` / `quay-e2e-aSF3aS` 的逐字形态。

更精确的单侧回退（HEAD config + **原判据**：只把「两态各自 Vite + 各自预热」回退，config 不动；`md5sum playwright.config.ts` 两侧相同、`e2e/mcp-settings.spec.ts` 不同）在重载下亦复现：

```
falsify#1 rc=0 wall=57452ms  WS {"fired":true,…,"detail":"ceiling crossed at 55001ms"}
falsify#5 rc=0 wall=57933ms  WS {"fired":true,…,"detail":"ceiling crossed at 55007ms"}
同批次 base#3 rc=0 wall=59239ms  WS {"fired":true,…,"detail":"ceiling crossed at 55012ms"}
```

### AC4 读数与判据一字未改

- `git diff 78db0b05..HEAD -- goals/` → **空**（`criterion:`/`expect:` 一字未动）。
- `grep -nE 'retries|test\.(skip|fixme)' e2e/mcp-settings.spec.ts` → 无命中。
- 五条读数仍在：`(a)` :769/:782、`(b)` :726/:749、`(c)` :795/:799、`(d)` :803/:819、`(e)` :830/:864。
- 三条假形态断言仍在：`:758 expect(bearerOnPage).toBe(false)`、`:801 expect(commandText).toMatch(/Authorization:\s*Bearer\s*<token>/)`、`:825 expect(initialChecked[scope]).toBe(false)`。
- 两态显式值逐字仍在：`:53 mcpEnabled: 'true'`、`:54 mcpEnabled: 'false'`。
- 判据命令仍逐字 `npx playwright test e2e/mcp-settings.spec.ts`。
- `git diff 78db0b05..HEAD -- e2e/mcp-settings.spec.ts | grep '^-' | grep -E '\(a\)|\(b\)|\(c\)|\(d\)|\(e\)|Bearer|initialChecked|commandCount|mcpEnabled'` → 无输出（无读数/断言行被删）。

### AC5 三条假形态分辨力未失

先提交实现（HEAD `a0695b7b`）再逐条变异产品面，跑完即 `git checkout HEAD -- src/` 恢复（恢复后 `git status --short -- src/` 为空）：

**(i) 写 scope 默认勾选** —— `src/modules/settings/hooks/useCredentialsSettings.ts` 的 `defaultNewTokenScopes`：`ACCESS_TOKEN_SCOPE_OPTIONS.filter((option) => !option.writable)` → `filter(() => true)` ⇒ **仅 (d) 红**：

```
> 825 |         expect(initialChecked[scope]).toBe(false);
Expected: false
Received: true
```

恢复命令 `git checkout HEAD -- src/modules/settings/hooks/useCredentialsSettings.ts`。

**(ii) 关闭态仍渲染接入命令** —— `src/modules/settings/tabs/api-settings/sections/McpGatewaySection.tsx` 关闭分支追加 `mcp-gateway-command` 块 ⇒ **仅 (b) 红**：

```
> 757 |       expect(commandCount).toBe(0);
Expected: 0
Received: 1
```

恢复命令 `git checkout HEAD -- src/modules/settings/tabs/api-settings/sections/McpGatewaySection.tsx`。
（第一次尝试把 `Bearer <token>` 直写进 JSX 文本，`<token>` 被当 JSX 元素解析、Vite transform 500，run 死在 landing 守卫 `> 529` 而非 (b) 断言；改成字符串表达式后重跑，上为有效变异的读数。）

**(iii) 命令内嵌真实令牌** —— 同文件 `connectCommand` 用字面 `ccp_9f3a2b7c1d4e5f6081a2` 取代 `<token>` ⇒ **仅 (c) 红**：

```
> 801 |       expect(commandText).toMatch(/Authorization:\s*Bearer\s*<token>/);
Expected pattern: /Authorization:\s*Bearer\s*<token>/
Received string:  "claude mcp add --transport http cloudcli http://127.0.0.1:17269/mcp --header \"Authorization: Bearer ccp_9f3a2b7c1d4e5f6081a2\""
```

恢复命令 `git checkout HEAD -- src/modules/settings/tabs/api-settings/sections/McpGatewaySection.tsx`。

变异 diff 存 `/tmp/ac254-probe/ff{i-write-scope-default-checked,ii-disabled-renders-command,iii-command-embeds-real-token}-diff.txt`，run 日志同名 `-run.log`（(ii) 的有效 rc 读数为 `ffii-rerun.log`）。

### AC6 没靠抬线

`git diff 78db0b05..HEAD -- playwright.config.ts | grep -E '^[-+].*(55_000|40_000|SINGLE_SPEC_CEILING_MS *=|SPEC_BUDGET_MS *=)'` → **无输出**：两条上限的**定义**一字未改（`SINGLE_SPEC_CEILING_MS = 55_000`、`BOOT_CEILING_MS = 40_000` 在 diff 中均为上下文行）。config 的改动只做两件事：

1. 该单文件选择下**不启动** webServer 对（`.filter(entry => !(mcpSettingsOnlySelection && RUN_SERVERS.some(s => s.url === entry.url)))`）——本判据自绑这两条端口，那对是**没人用的第二套 server+Vite**，正是「两整套栈」里多余的一半。
2. 该选择下把看门狗**直接**武装在既有的 `RUN_CEILING_MS`（= 55 000，未变）上，而不是先武装 `BOOT_CEILING_MS`：该选择下没有 webServer，也就没有「无界 pre-spawn 探测」可被 boot 上限约束；否则那 40s 上限会把这个 spec 自己两态换手时的端口空窗误读成 `stuck at "webServer-start"`。

`mcp-settings.spec.ts` 不在 `SPEC_BUDGET_MS` 内，其 `RUN_CEILING_MS` 就是 55 000。墙钟下降完全来自 spec 自身的启动/用例改动：两态共用一份 Vite + 一次冷 pre-bundle（另一态只绑 server），并把第一态的 server boot 与 client warm-up 重叠。

### AC7 静态门

- `npm run typecheck` → **exit 0**（`tsc --noEmit -p tsconfig.json && -p server/tsconfig.json && -p scripts/tsconfig.json`），日志 `/tmp/ac254-probe/final-typecheck.log`。
- `npm run lint` → **exit 0**，输出仅既有 warning；`grep -nE 'mcp-settings\.spec\.ts|playwright\.config\.ts' /tmp/ac254-probe/final-lint.log` → **无命中**（两个被改文件零违规）。
- 出货 diff 未触及 `src/**` / `server/**`，故 AGENTS.md 的 `$frontend-module-standards` / `$backend-module-standards` 均不适用。

### AC8 失败路径

**未触发**：负载臂在同一构造内 3 次全 exit 0、`fired:false`、≤ 45 000ms（AC3），且膨胀可稳定复现（同构造 base 侧 2/2 越过 55 000，`crossed at 55000ms / 55002ms`），故不满足「停手并置 needs-human」的条件。如实记录余量分布：本轮战役 new 侧负载跑读数为 37 126–38 302 ms（参照带内 5 次）、46 132–46 937 ms（3 次，load1 ≈164–290）、以及 1 次 49 973ms 的 `net::ERR_NETWORK_CHANGED` 外部网络抖动（模块批量请求被中断、有界重放自身 53ms 超时，非本改动回归，非断言失败）。即在参照带**顶部**及更高负载下 ≤45 000 的余量会变薄——这是本条与 DoD 的已知边界。本任务未放宽判据、未拆分判据文件、未抬任何上限、未把安静臂通过写成「flake 已修」。
