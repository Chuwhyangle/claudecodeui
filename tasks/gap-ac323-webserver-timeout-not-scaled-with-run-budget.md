---
id: gap-ac323-webserver-timeout-not-scaled-with-run-budget
title: AC-323 判据命令 1 连续两次死在 webServer 固定 35s 墙：WEB_SERVER_TIMEOUT_MS 不随已声明 run
  budget 放大（boot ceiling 已放大到 120s）⇒ 改为同预算派生、默认仍 35s；AC 记录 timeoutMs 抬到 run
  ceiling 535s 之上
status: done
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

**来源**：本轮 gap-filing 的直接测量（不是台账尾巴）。AC-323（`status: achieved`；其 GOAL-035 已 achieved、不再活跃、未声明 `long-term: true`）在 `HEAD^{tree} = 9595c8d5f839ff94821c8bb21f23859d5c45d5e5` 上被两次 gate 评估判红，两次都死在判据第一条命令的**引导段**、任何 spec 用例之前：

- `2026-11-12T10:13:54.356Z`（`goal-sweep`）与 `2026-11-12T10:17:52.010Z`（`goal-cli`），`payload.treeSha` 均为 `9595c8d5f839ff94821c8bb21f23859d5c45d5e5`，reason 都以逐字行结尾：
  `Error: Timed out waiting 35000ms from config.webServer.`
- 两次运行自己的数据目录（`~/.cache/quay-e2e-tmp/quay-e2e-VV780H`、`~/.cache/quay-e2e-tmp/quay-e2e-wBZlJl`）读数：
  - `watchdog-state.json` 逐字分别为 `"detail": "boot 120000ms from config-eval end (config-eval-ms=23358), re-armed to 535000ms once past boot"` 与 `config-eval-ms=149627`，两次 `"fired": false`；
  - `server.stderr.log` 只有一行 `No .env file found or error reading it: ENOENT: … ·.env`，没有崩溃栈、没有编译错误；
  - `test-results/` 只有 `.last-run.json` ⇒ 没有一条 spec 断言执行过。

判据（逐字，不改）：

```
npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts && npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime && npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "
```

**为什么不是产品回归**：同一判据的上一棵绿树 `7c8fa9888aaf2cb7b9049a64b0ed87255ac622ae` 在 2026-11-09T19:57:59Z–21:25:52Z 连续 14 次 pass；两树之间 `git diff --stat 7c8fa988 9595c8d5` 只有 shared/asr 包拆分与 voice importer（无 e2e config、无 server bootstrap 变更），且失败 run 的 server stderr 无崩溃行。

**机制**：`WEB_SERVER_TIMEOUT_MS = 35_000`（`playwright.config.ts:1119`）是两条 `webServer` entry 共用的**固定** internal deadline，Playwright 在 spawn 之后按它等待 URL 应答。2026-10-29 的 done 任务 `gap-ac323-boot-ceiling-counts-config-evaluation` 把 watchdog 的 boot window 改到 config 求值末尾起算，之后 `bootCeilingFor(RUN_CEILING_MS)` 会随已声明 budget 从 40s 放大到 120s；但 Playwright 自己那条 35s 没有跟着放大，于是链上**最早**的墙仍是 35s。AC-323 命令 1 的选择集 `RUN_CEILING_MS = 535_000`（240s + 240s + 55s），`BOOT_CEILING_MS = 120_000`，webServer wait 仍是 `35_000`。done 任务 `gap-ac174-criterion-run-budget-and-boot-ceiling-below-load-slowdown` 的 Evidence 已逐字记录过同一行（2026-11-06 load1 212.57），并按当时的「明确不动」保留常量、归因为宿主负载；它不是判据语义问题，但每一轮都会把「量具在 boot 处先开火」记成判据红。本轮 `config-eval-ms=149627` 说明宿主/并发负载足以让 config 求值付出约 2.5 分钟，boot 之后仍然 >35s。

**修法方向**（执行者可据实测调整，但须满足 AC）：

1. `scripts/e2e-run-ceilings.mjs` 新增 `webServerTimeoutFor(runCeilingMs)`，定义为 `bootCeilingFor(runCeilingMs) - BOOT_CEILING_RUN_MARGIN_MS`：默认 55s 选择仍逐字 `35_000`；240s / 535s / 1_200_000 选择为 `115_000`；始终严格低于 boot ceiling 并保持既有 5s 间隔，使「boot 仍不应答」的失败仍由 Playwright 自己的行命名。
2. `playwright.config.ts` 两条 entry 的 `timeout: WEB_SERVER_TIMEOUT_MS` 改用 `webServerTimeoutFor(RUN_CEILING_MS)` 派生的常量（`const WEB_SERVER_TIMEOUT_MS = webServerTimeoutFor(RUN_CEILING_MS)`），并更新 `:1095-1119` 的注释算术链（默认 35s 不变，放大选择 115s）。
3. 控制臂（确定性，不靠宿主负载）：临时给 server 的 `webServer` command 前加 `sleep 40 &&`，在 `e2e/mobile-workspace-composer-layout.spec.ts -g "@320 idle"`（240s budget ⇒ 新值 115s）上两拍对照——旧 35s 常量 ⇒ exit 1、逐字 `Error: Timed out waiting 35000ms from config.webServer.`；新派生值 ⇒ exit 0、`[e2e] boot: both webServers answered at …` 且读数 >40000ms。两拍都还原，`git status --porcelain` 为空。
4. 同一算术链上的第二个倒挂：命令 1 的 `RUN_CEILING_MS = 535_000` > AC 记录的 `timeoutMs: 480000`，即闸的 SIGKILL 会早于 run watchdog 写出 crossing 行（两份注释都明说不允许）。把 AC-323 记录的 `timeoutMs` 抬到 600_000（> 535_000 + driver 15s grace；`goal_write` 不暴露该字段，按 AC-109/AC-323 先例手改 `goals/AC-323-…md` 的这一行）。

<!-- dedup-ref --> 去重与粒度：`grep -l '^goal_ac: *AC-323' tasks/*.md` 命中 19 份，全部 `status: done`（含 `gap-ac323-boot-ceiling-counts-config-evaluation`、`gap-ac323-warmup-fetch-retry-and-voice-port-collision-stabilize` 等）；在飞扫描（todo/ready/needs-human 且 `goal_ac: AC-323`）0 命中；对 `WEB_SERVER_TIMEOUT_MS` / `config.webServer` 的非 done 任务 grep 也 0 命中。`task-granularity-advice --root <主检出> --touches playwright.config.ts --touches scripts/e2e-run-ceilings.mjs …` 报 `peers: []`、`mentions: []` ⇒ 无合并候选，separate。19 份 done 正是「上一轮修复没挺住」的证据：它们分别修了 boot ceiling 的计时原点、暖机连接级重试、假上游端口分配、启动守卫等，没有一条让 Playwright 自己的 webServer wait 随已声明 budget 放大。

## AC

- [x] AC1（修复前，红先按确定性控制臂复现）临时给 server 的 `webServer` command 前加 `sleep 40 &&`（仅这一处临时改动），在 shipped `WEB_SERVER_TIMEOUT_MS = 35_000` 未改的前提下跑 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g "@320 idle"` ⇒ exit 1，输出逐字含 `Error: Timed out waiting 35000ms from config.webServer.`；贴 `<dataDir>`、wall clock 与两次重复的原文。该临时注入必须还原。
- [x] AC2（修复后，同一诱导失败转绿）保留同一个 `sleep 40 &&` 注入、换成修复后的派生值（该 selection 的 `WEB_SERVER_TIMEOUT_MS = 115_000`）⇒ 同一命令 exit 0，贴 `1 passed`、wall clock（应 ≳70s）与 `[e2e] boot: both webServers answered at <n>ms`（n>40000）。还原注入后 `git status --porcelain` 为空。
- [x] AC3（缩放函数与配置接线，单元可读）`node --test scripts/e2e-run-ceilings.test.mjs` exit 0；测试钉住 `webServerTimeoutFor(SINGLE_SPEC_CEILING_MS) === 35_000`、`webServerTimeoutFor(240_000) === 115_000`、`webServerTimeoutFor(1_200_000) === 115_000`，且对 `55_000 / 240_000 / 535_000 / 1_200_000` 每个值都有 `webServerTimeoutFor(x) === bootCeilingFor(x) - BOOT_CEILING_RUN_MARGIN_MS` 与 `webServerTimeoutFor(x) < bootCeilingFor(x)`、`>= 35_000`。读回 `playwright.config.ts`：`const WEB_SERVER_TIMEOUT_MS = webServerTimeoutFor(RUN_CEILING_MS);` 命中 1 行，且两条 entry 都是 `timeout: WEB_SERVER_TIMEOUT_MS`；贴 grep 原文。
- [x] AC4（判据整链，含并发负载）判据三条命令逐字不改，在一个最终树上连续 ≥3 次整链 exit 0。每轮登记 `git rev-parse HEAD^{tree}`、exit code、三条命令各自的 pass 计数与 wall clock；至少一轮与一条 sibling e2e（例如 `e2e/voice-realtime-turn-unanswered.spec.ts`）在时间窗口上重叠，贴 sibling 的 pass 计数。三轮回读的 `config-eval-ms` 与 boot 完成时刻一并入档。若净检出上仍稳定红（即判据在产品面为假），停手上报 `needs-human`，不得把环境红写成产品绿。
- [x] AC5（闸 deadline 不早于 run ceiling）`goals/AC-323-composer-…md` 的 `timeoutMs` 从 `480000` 改为 `600000`（或 ≥550000 的等价实测值 > 命令 1 的 `RUN_CEILING_MS = 535_000` + 15s driver grace）；`git diff develop -- 'goals/*.md'` 的增删行只有 `-timeoutMs: 480000` / `+timeoutMs: 600000`，`criterion` / `expect` / 其它字段逐字节不变；`quay goal get AC-323 --json` 的 `timeoutMs` 等于声明值。贴两处原文。
- [x] AC6（判定面未弱化 + 隔离）`git diff develop --name-only` 全部落在 `## Touches`；`git diff develop -- 'e2e/*.spec.ts' | grep -c '^-.*expect('` = 0；diff 内无新增 `retries` / `test.skip` / `page.route(` / `reuseExistingServer: true`；`npm run typecheck` exit 0。

## DoD

- 真实落地：在宿主有并发 e2e 的条件下（正是两次红的条件），判据三条命令连续 ≥3 次整链 exit 0；AC1/AC2 的两拍控制（旧 35s 红 / 新派生值绿）在同一宿主负载窗口内成对取得，`config-eval-ms`、boot 完成时刻、每轮 wall 逐字入档。
- 完成记录须逐字保留本轮两次红的 gate event id/timestamp、treeSha `9595c8d5f839ff94821c8bb21f23859d5c45d5e5`、两处 `watchdog-state.json` 与 `server.stderr.log`，并写明为什么早前的修复没挺住：它们分别修了 boot ceiling 的计时原点、暖机连接级重试、假上游端口分配等，没有一条让 Playwright 自己的 webServer wait 随已声明 budget 放大；`gap-ac174-criterion-run-budget-and-boot-ceiling-below-load-slowdown` 明确把该常量留在原位并把同签名红归因为宿主负载。
- 合并到 develop 之后，在 develop 树上真实跑 `quay goal gate AC-323`（非 dry-run）并贴 `verdict: "pass"` 的 GateEvent 原文，AC-323 台账尾随之翻 pass。（待外部）
- 未验证项如实写明（例如宿主 load 的真实上界、config 求值 149.6s 是否为观测到的最大值），不得把未观察到的红写成已观察。

## Touches

- playwright.config.ts（`WEB_SERVER_TIMEOUT_MS` 改成随 `RUN_CEILING_MS` 派生；两条 entry 接线；更新算术链注释）
- scripts/e2e-run-ceilings.mjs（新增 `webServerTimeoutFor`，保持默认 35s 与 5s 间隔不变式）
- scripts/e2e-run-ceilings.test.mjs（默认/240s/535s/1_200_000 的派生值与不变式）
- goals/AC-323-composer-内双语音入口-容器内-live-voice-紧凑栏-波形-时长-字幕-模型-mute-end-桌面与.md（只改 `timeoutMs` 一行）
- tasks/gap-ac323-webserver-timeout-not-scaled-with-run-budget.md（自触）

## Evidence

### 环境与并发（DoD 的「宿主有并发 e2e」条件）

- 宿主 128 cores。每轮开始时的 `load1` 已入档（r3 68.13 / r4 69.55 / r5 51.26）；整段时间内另一会话的 `e2e/voice-output-e2e-harness.spec.ts` 也在跑。
- 真闸并发：`quay goal gate AC-323 --store --root /data/home/yale/work/claudecodeui`（develop 树，仍是旧 35s 常量）在本任务 r1/r2 窗口内真实执行（进程 3432471，10:53:27Z→11:01:27Z）。它在本轮留下两条 GateEvent：
  - `2026-11-12T10:50:21.258Z` `b25f938e-dde0-4fff-995d-eb0bfdb23673` `not-evaluated (timeout): acceptance timed out after 480000ms (killed) — raise this record's timeoutMs` —— 正是 AC5 修的 deadline 倒挂（命令 1 的 `RUN_CEILING_MS=535000` > `timeoutMs=480000`），treeSha `bd300895cbdc83f2ad8597a9aac30cb12dab2288`。
  - `2026-11-12T11:01:18.232Z` `91b1bca3-86f8-4be4-abb9-1f88d5941f33` `pass` —— 同一次运行 10:53:27Z→11:01:18Z 实测 471s，距 480s 墙只剩 9s；这是「刚好赶上」，不是常量正确。

### AC1（修复前红，两次重复）

用 `git show develop:playwright.config.ts` 生成 pre-fix 配置副本（shipped `WEB_SERVER_TIMEOUT_MS = 35_000` 未改），只在该副本 server 的 `webServer` command 前加一次 `sleep 40 &&`，跑 `npx playwright test --config <副本> e2e/mobile-workspace-composer-layout.spec.ts -g "@320 idle"`：

| 重复 | dataDir | wall | config-eval-ms | exit | 原文 |
|---|---|---|---|---|---|
| 1 | `~/.cache/quay-e2e-tmp/quay-e2e-Gvf6ed` | 41s | 3978 | 1 | `Error: Timed out waiting 35000ms from config.webServer.` |
| 2 | `~/.cache/quay-e2e-tmp/quay-e2e-Y54IUN` | 41s | 5407 | 1 | `Error: Timed out waiting 35000ms from config.webServer.` |

两次日志原文都在 `[e2e] watchdog-armed: config-eval-ms=…, boot ceiling 120000ms from config-eval end …, then re-armed to 240000ms from the run start` 之后紧跟上面那行 `Error:`。注入副本另存 `tmp/playwright.ac323-ac1.config.ts`，根目录副本已删除；`git status --porcelain` 为空。

### AC2（修复后，同一诱导失败转绿）

同一 `sleep 40 &&` 注入加在修复后的 `playwright.config.ts` server command 上（该 selection `RUN_CEILING_MS=240000` ⇒ `WEB_SERVER_TIMEOUT_MS=115000`）：

```
[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-gcDOP0 ...
[e2e] watchdog-armed: config-eval-ms=8809, boot ceiling 120000ms from config-eval end ...
[e2e] boot: both webServers answered at 74895ms (config-eval-ms=8809), re-armed to 240000ms from the run start
  1 passed (1.7m)
```

exit 0、wall 110s（≳70s）、boot 完成 74895ms（>40000）。还原注入后 `playwright.config.ts` 的 sha256 回到 `443284b68842d762e5371190b4434e8d78ebf0fd8172e0410edb915a445ea705`，`git status --porcelain` 为空。

### AC3（缩放函数与接线）

`node --test scripts/e2e-run-ceilings.test.mjs` → `tests 12 / pass 12 / fail 0`。新增三条：默认选择 35s；240s/535s/1_200_000 → 115_000；四臂 `webServerTimeoutFor(x) === bootCeilingFor(x) - BOOT_CEILING_RUN_MARGIN_MS` 且 `< bootCeilingFor(x)`、`>= 35_000`。

读回 `playwright.config.ts`：

```
$ grep -n "WEB_SERVER_TIMEOUT_MS" playwright.config.ts
1128:const WEB_SERVER_TIMEOUT_MS = webServerTimeoutFor(RUN_CEILING_MS);
$ grep -c "timeout: WEB_SERVER_TIMEOUT_MS" playwright.config.ts
2
```

（两条 entry：`:4086` 与 `:4231`。）

### AC4（判据整链，三连绿 + 并发）

最终树 `git rev-parse HEAD^{tree} = 306c1cffde924f00309ae9240d314f8999e94940`（含 develop `b5a71ec7b`，`git merge-base --is-ancestor develop HEAD` 为真）。每轮跑的就是判据三条命令逐字原文。

| 轮 | 开始 (UTC) | load1 | cmd1 | cmd2 | cmd3 | chain exit |
|---|---|---|---|---|---|---|
| r1 | 10:39:17 | — | 19 passed / 242s | 219 passed / 45s | 6 passed / 84s | 0 |
| r2 | 10:45:34 | ~85 | **exit 1 / 564s**（见下） | 219 passed / 12s | **exit 1 / 70s**（见下） | **1** |
| r3 | 11:01:56 | 68.13 | 19 passed / 241s | 219 passed / 8s | 6 passed / 43s | 0 |
| r4 | 11:06:59 | 69.55 | 19 passed / 181s | 219 passed / 6s | 6 passed / 31s | 0 |
| r5 | 11:10:48 | 51.26 | 19 passed / 184s | 219 passed / 25s | 6 passed / 64s | 0 |

r3/r4/r5 连续三次整链 exit 0。

每轮 `config-eval-ms` 与 boot 完成时刻：

| 轮 | cmd1 config-eval / boot | cmd3 config-eval / boot |
|---|---|---|
| r1 | 1657 / 3753ms | 18885 / 33877ms |
| r3 | 13899 / 16927ms | 5246 / 11383ms |
| r4 | 394 / 5004ms | 275 / 3808ms |
| r5 | 323 / 2329ms | 15336 / 24525ms |

sibling 重叠：

- r1：`npx playwright test e2e/voice-realtime-turn-unanswered.spec.ts` 窗口 `10:39:14Z–10:39:52Z`，`2 passed (33.3s)`，与 r1 起点 `10:39:17Z` 重叠。
- r5：同一 sibling 窗口 `11:10:43Z–11:11:13Z`，`2 passed (27.8s)`，与 r5 起点 `11:10:48Z` 重叠。

**r2 如实记录（未写成绿）**：同一窗口内 `config-eval-ms=109651`、boot 完成 `189836ms`，cmd1 在 535001ms 越过自己的 run ceiling：

```
[e2e] watchdog: this run crossed its own 535000ms ceiling at 535001ms (config-eval-ms=109651) and is ending here with exit 1 at 537003ms — stuck at stage "browser-launch-or-cases": observed past boot at 189836ms, so this run was inside browser launch or a case; the 2000ms probe at the crossing got no answer from port 4801 (server) — a loaded server missing the probe's own deadline, not a run stuck in boot.
```

cmd3 失败在 spec 自己的 client startup 预算，不是 webServer 墙：

```
Error: the client did not answer http://127.0.0.1:28235/@fs/.../vite-cache/deps/react_jsx-dev-runtime.js?... inside the 30000ms startup budget (This operation was aborted)
```

两条都是宿主负载红（同树同命令在 r3–r5 转绿），不是本任务判定面的产品红；本任务只把 webServer wait 接到已声明 budget 上，没有（也不应）抬 spec 的 client startup 预算或 535s run ceiling。

### AC5（闸 deadline）

`git diff develop -- 'goals/*.md'` 的增删行只有：

```
-timeoutMs: 480000
+timeoutMs: 600000
```

`criterion` / `expect` / 其它字段逐字节不变（整个 diff 只有这一段 hunk）。通过 Provider ABI 读回（把 `.quay/config.yml` 的 `QUAY_NATIVE_GOAL_DIR/TASKS_DIR` 临时指向本 worktree 的载体，读后逐字节还原，sha256 回到 `16a0f9f58b4b12470ba79fc437fd253677e0ba80698839774bb85549858ae321`）：

```
$ quay goal get AC-323 --json
{
  "id": "AC-323",
  "status": "achieved",
  "timeoutMs": 600000,
  "criterion": "npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts && npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime && npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g \" idle \""
}
```

说明：Provider 的 goal 载体被 `.quay/config.yml` 钉在主检出 `/data/home/yale/work/claudecodeui`，所以不重定向时它读的是 develop 的 `480000`；上面是读本 worktree 载体得到的声明值，合并后 develop 侧同一读取即为 `600000`。

### AC6（判定面未弱化 + 隔离）

```
$ git diff develop --name-only
goals/AC-323-composer-…md
playwright.config.ts
scripts/e2e-run-ceilings.mjs
scripts/e2e-run-ceilings.test.mjs
$ git diff develop -- 'e2e/*.spec.ts' | grep -c '^-.*expect('
0
$ git diff develop -- playwright.config.ts | grep -E '^\+.*(retries|test\.skip|page\.route\(|reuseExistingServer: true)'
(无输出)
$ npm run typecheck
(exit 0)
```

### DoD 记录：为什么早前的修复没挺住

它们在修别的指针：`gap-ac323-boot-ceiling-counts-config-evaluation` 修 boot ceiling 的计时原点（从 config 求值末尾起算），`gap-ac323-warmup-fetch-retry-and-voice-port-collision-stabilize` 修暖机连接级重试与假上游端口分配，另有启动守卫等；没有一条让 Playwright 自己的 `webServer[].timeout` 随已声明 budget 放大。`gap-ac174-criterion-run-budget-and-boot-ceiling-below-load-slowdown` 当时明确把 `WEB_SERVER_TIMEOUT_MS` 留在 35s、把同签名红归因为宿主负载，于是链上最早的那面墙每轮先开火。

本轮两次红（Proposal 已逐字保留）：`2026-11-12T10:13:54.356Z`（goal-sweep）与 `10:17:52.010Z`（goal-cli），treeSha `9595c8d5f839ff94821c8bb21f23859d5c45d5e5`；`~/.cache/quay-e2e-tmp/quay-e2e-VV780H` / `quay-e2e-wBZlJl` 的 `watchdog-state.json` 分别记 `config-eval-ms=23358` / `149627`，两次 `"fired": false`；`server.stderr.log` 只有 `No .env file found or error reading it: ENOENT: … ·.env`；`test-results/` 只有 `.last-run.json`。

### 未验证项（如实）

- 宿主 `load1` 的真实上界未知；本任务观测到的最高相关读数：r2 窗口的 `config-eval-ms=109651` 与 boot `189836ms`。Proposal 引用的 `149627` 是那两次红留下的记录值，本任务未复现到更大值。
- r2 的两条红是负载红，但「负载低到多少才保证整链绿」没有量化；三连绿是在 `load1` 51–70 的窗口取得的。
- 合并后 develop 树上的 `quay goal gate AC-323` 非 dry-run 复跑留给 fan-in 之后（DoD 已标 `（待外部）`）。

该轴仍暗,理由:本任务只改 e2e 计时常量、playwright webServer 接线与 AC 记录的 timeoutMs，不改模块或依赖结构，L_D/L_G 没有结构读数