---
id: gap-loop-rerun-command-undeclared-so-every-flake-parks-needs-human
title: fan-in 的失败文件重跑通道未声明（loop.rerun_command 缺失）⇒ driver 无法把并发抽签判为既存红，每次抽签都停派
  needs-human 并归因到 headline 里那句无关日志
status: done
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

### 现象（2026-10-13 实测）

`gap-voice-uplink-vad-real-prefix-a-and-exit-commit` 的 fan-in suite 在 534 个文件里红 **1** 条（`e2e/session-lifecycle-scenario.spec.ts`），driver 的判词是：

> `suite red was attributed to 1 failing file(s) … but could not be cleared as pre-existing red in 2 consecutive rounds (bounded to at most one retry) — baseline comparison not evaluated: no baseline rerun command: no-rerun-command-declared — stopping instead of spending another worker session`

即：driver **有**「重跑失败文件、绿了就当既存红」的机制，但本项目**没有声明那条命令**，于是它只能停派。

### 归因复核（本轮实测，不是照抄 headline）

- 该文件**不在**那条任务的 Touches 里（它只碰 `experiments/` 与一个 docs 文件）。
- 主检出单跑同一 spec：`npx playwright test e2e/session-lifecycle-scenario.spec.ts` → **3 passed / 10.8s**。⇒ 不是确定性红。
- 真实失败行：`page.evaluate: TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:8735/src/shared/scenarios/sessionLifecycle.timeline.ts` —— 浏览器臂在**并发负载下动态 import 抽签**。
- 而 headline 打印的 `[WebServer] … No .env file found or error reading it: ENOENT` 只是 webServer 的**第一行日志**，被折进了 `not ok -` 那行 ⇒ 归因被这句话带偏（本条要消掉的正是这种「抽签无法归因」）。

### 缺口与做法

driver 的重跑通道契约（读 `worker-driver.js` 的 `resolveRerunCommand` / `applyFileTemplate`）：

- 命令来自 `.quay/config.yml` 的 `loop.rerun_command`，**argv 数组**（非空字符串），两个模板：`{worktree}` 与 `{files}`；`{files}` **逐个**拼进 argv；超时 `RERUN_TIMEOUT_MS = 300000`。
- 未声明 ⇒ `not-evaluated: no-rerun-command-declared`；声明了但类型不对 ⇒ `declaration-unreadable`（不静默）。绿 ⇒ `rerun-green`（判既存红，继续走）；红 ⇒ `rerun-red`（判真红）。

本项目现在没有这个键（全店任务里也没有人提过）。**难点**：`scripts/test.sh` 的 e2e 车道**只在全量收集路径上启动**（`E2E_LANE` 要求 `FILES` 为空），所以把 `e2e/*.spec.ts` 当位置参数喂给 test.sh **不会**走 e2e 车道，会落到 server 车道用错 runner，把抽签误判成「真红」（保守但归因错误）。故声明不能是朴素的 `bash scripts/test.sh {files}`。

**做法**：新增一个只做分派的包装脚本（argv = 失败文件列表）：`e2e/*.spec.ts` → 该 spec 的 playwright 命令；其余 → `bash scripts/test.sh --root <worktree> <file>`；退出码沿用（全绿 = 0，任一红 = 非 0）。然后把 `loop.rerun_command` 声明为指向该脚本的 argv。⛔ 包装脚本只分派，不做任何「重试到绿」；⛔ 不改 `scripts/test.sh` 的语义。

## Plan

1. 读 driver 的三条读数口径（`no-rerun-command-declared` / `declaration-unreadable` / `rerun-green|rerun-red`），确定可机械读出它们的方式并记录下来。
2. 写分派脚本：按文件前缀选 runner，透传 exit code，打印每个文件用了哪个 runner。
3. 在 `.quay/config.yml` 的 `loop` 段声明 `rerun_command`（argv 数组，用 `{worktree}` 与 `{files}`）。
4. 三组读数：e2e spec 单跑（得 3 passed）、server 文件单跑（得 pass）、混合列表两者都跑；再取假形态（删键 / 写错类型）与「确定性红不得被洗绿」的对照。
5. 不改 `scripts/test.sh`、不改生产默认值、不重启 :3001。

## AC

- [x] AC1 `.quay/config.yml` 的 `loop.rerun_command` 是非空字符串 argv 数组，且用第 1 步确定的方式读出 `{kind:'run'}`（不再是 `no-rerun-command-declared`）；`## Evidence` 给出该读数与读取命令。
- [x] AC2 取假形态：把 `loop.rerun_command` 删掉（以及写成**字符串**的第二种假形态）⇒ 同一读取分别变成 `not-evaluated: no-rerun-command-declared` 与 `declaration-unreadable`；两次读数都写进 `## Evidence`。
- [x] AC3 分派正确：包装脚本对 `e2e/session-lifecycle-scenario.spec.ts` 用 playwright 跑（`## Evidence` 给读数，应为 3 passed），对 `server/**/*.test.ts` 用 `scripts/test.sh` 跑（给 pass 读数），混合列表两者都跑到；⛔ 不得把 `e2e/*.spec.ts` 交给 test.sh 的位置参数路径（给出反例读数：若那样喂，会以 wrong-runner 红）。
- [x] AC4 ⛔ 不把真红洗绿：用一个**确定性**失败输入跑包装脚本 ⇒ 退出码非 0（给读数）；`## Evidence` 说明脚本内不存在任何重试/吞错分支（贴脚本全文或关键段）。
- [x] AC5 超时与并发纪律：单次重跑墙钟 ≤ 300000ms（driver 的 `RERUN_TIMEOUT_MS`），且重跑不与其它 suite 并发（给出一次实际重跑的墙钟读数）。
- [x] AC6 只改声明的文件：`git diff --name-only <fan-in 基线>..HEAD` 只含 Touches 所列文件与本任务文件。
- [x] AC7 不改 `scripts/test.sh` 的语义、不改任何生产默认值（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（前后 pid 相同，写出读数）。

## Evidence

### AC1 — 声明可被 driver 自己的解析器读出 `{kind:'run'}`

读取命令（**调用 driver 自己导出的** `readLoopFanInContract`，取自装机 dist 包
`/data/home/yale/work/quay-scratch/official-dist-020-dev/scripts/dist/worker-driver.js`，再套用
`resolveRerunCommand` 相同的三分支；不是复刻解析）：

```
node /tmp/gap-rerun-probe/readout.mjs <worktree> e2e/session-lifecycle-scenario.spec.ts
```

读数：

```json
{"decl":{"state":"declared","value":["bash","{worktree}/scripts/quay-rerun-failed.sh","--worktree","{worktree}","{files}"]},
 "resolved":{"kind":"run","argv":["bash","<wt>/scripts/quay-rerun-failed.sh","--worktree","<wt>","e2e/session-lifecycle-scenario.spec.ts"]}}
```

即 `state:"declared"`、`{kind:"run"}`，`{files}` 已逐元素拼入、`{worktree}` 已替换为绝对路径。

### AC2 — 两种假形态都不静默

- 删掉键 ⇒ `decl.state="absent"`，`{kind:"not-evaluated", reason:"no-rerun-command-declared"}`。
- 写成标量字符串 `"bash scripts/test.sh"` ⇒ `decl.state="invalid"`，
  `{kind:"not-evaluated", reason:"rerun-command-declaration-unreadable: loop.rerun_command = \"bash scripts/test.sh\""}`。

### AC3 — 分派正确 + 反例（诚实读数）

- `e2e/session-lifecycle-scenario.spec.ts` 经包装脚本 → playwright：`3 passed (10.8s)`，exit 0，WALL_MS=11519。
- `server/shared/tests/strip-ansi-sequences.test.ts` 经包装脚本 → `scripts/test.sh` 的 server 车道：
  `passed=true`，exit 0，WALL_MS=2333。
- 混合列表（两文件）→ 两者都跑到，exit 0，WALL_MS=13420。
- **反例读数（对 AC3 预测的实测更正）**：朴素 `bash scripts/test.sh e2e/session-lifecycle-scenario.spec.ts`
  → exit **0**，`__PERFILE__` 行数 **0**，`# tests 0 / # pass 0 / # fail 0`。实测是**真空绿（vacuous green）**，
  不是任务正文预测的「wrong-runner 红」。原因：test.sh 的 e2e 车道只在 `FILES` 为空时启动（`E2E_LANE=1 iff RUN_E2E=1 && FILES 空`）；
  位置参数 `e2e/*.spec.ts` 落到 client vitest 桶，而 vitest include 只有 `src/**` ⇒ 该 spec 从不被执行，
  vitest 自身 exit 1（No test files found）但被 test.sh 吞掉（test.sh 只按自己的 per-file 计数 exit，不看 vitest 的 VRC），
  于是空集合上返回 0。无论「红」还是「真空绿」，都是错误归因（浏览器抽签根本不可见）——这正是需要分派脚本、
  而不是用那条捷径的理由。

### AC4 — 确定性红不被洗绿

临时确定性失败的 server 测试 → 包装脚本 exit 1（`# fail 1`）；临时确定性失败的 e2e spec → exit 1（`1 failed`）；
两个临时文件均已删除，工作树干净。脚本内**不存在**任何重试/吞错分支：每个 runner 的 `$?` 被原样取出，
任一非 0 即置 `rc_all=1`，唯一的 `exit 0` 是全绿路径（脚本全文在分支 `scripts/quay-rerun-failed.sh`，83 行）。
这一点另由 DoD 的 `rerun-red` 对照端到端证实。

### AC5 — 超时与并发纪律

单次重跑墙钟：e2e spec 11519ms、server 文件 2333ms、混合 13420ms —— 均 ≪ RERUN_TIMEOUT_MS=300000ms。
包装脚本在一个 `for` 循环里**顺序**跑每个文件（无并发原语），因此不与其它 suite 重叠。

### AC6 — 只改声明的文件

`git diff --name-only e6c95e335..HEAD`（`e6c95e335` = 派发时 develop tip）→
`.quay/config.yml`、`scripts/quay-rerun-failed.sh`，两者均在 `## Touches` 内。

### AC7 — 未动 test.sh / 未改生产默认值 / 未重启 :3001

- `git diff develop -- scripts/test.sh` 为空。
- `git diff develop -- server/modules/voice-realtime/voice-realtime-silence-tail.ts` 为空；env `VOICE_REALTIME_SILENCE_TAIL` 未设（`unset`）。
- `:3001` pid = 366403（前后一致）。

### DoD — 真实重跑事件（driver 自己的 `runMechanicalFanIn`）

在一个一次性 git 仓库里驱动装机 dist 包**导出的** `runMechanicalFanIn`，`loop.rerun_command` 指向本任务
真实的 `scripts/quay-rerun-failed.sh`；suite 桩只红一条并点名一个文件（`server/rerun-target.test.ts`）。
harness：`/tmp/gap-rerun-probe/mech.mjs`。

- 绿拨盘 ⇒ 真实事件 `state="rerun-green"`、`files=["server/rerun-target.test.ts"]`、`exitCode=0`、
  `outcome="landed"` —— 抽签被自己判为既存红，任务继续走完落地（**没有停派 needs-human**）。
- 红对照 ⇒ 真实事件 `state="rerun-red"`、`exitCode=1`、`outcome="red"`、`step="suite"`；
  重跑日志显示分派器原样透传 runner 状态（`quay-rerun-failed: server/rerun-target.test.ts exit=1`），
  证明确定性失败不被洗绿。

## DoD

真实落地 = 遇到并发抽签时 driver 能自己判出「`rerun-green` ⇒ 既存红」并把任务继续走完，而不是停派 `needs-human`。读数不是「配置里多了一个键」：给出一次**真实**重跑事件（`.quay/` 下的重跑日志 + trace/journal 里的 `rerun` 事件，`state=rerun-green`，以及一次 `rerun-red` 的对照），并说明 `rerun-green` 这一次之后任务确实没有停派。

## Touches

- .quay/config.yml
- scripts/quay-rerun-failed.sh (new)
- tasks/gap-loop-rerun-command-undeclared-so-every-flake-parks-needs-human.md

## Notes

**与 `gap-fan-in-suite-load-flake-one-per-run` 的分工**：那条治「为什么并发下每轮恰好红 1 条」（根因在并发调度/产品竞态，改 `scripts/test.sh` 等）；本条治「红之后能不能被正确归因」（只加一条声明与一个分派脚本，不改 test.sh 语义）。⛔ 不要在本条里顺手改 test.sh 的并发行为。

**为什么不直接写 `bash scripts/test.sh {files}`**：见 Proposal 的 e2e 车道段 —— 那条捷径会把 e2e 抽签误判成真红，属于「错误归因换错误归因」。包装脚本的存在理由就是这一个分派。

**风险与边界**：`rerun_command` 一旦声明，driver 会在每次 suite 红时自动跑它，并把 `rerun-green` 当作既存红继续走。因此 AC4（真红不得洗绿）是这条声明的安全边界：脚本必须透传非 0。
