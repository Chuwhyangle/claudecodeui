---
id: gap-ac345-gate-deadline-below-criterion-wallclock
title: AC-345 判据内容已为真、却被自己的闸预算杀掉：记录未声明 timeoutMs（同族先例 AC-317 逐字复现）—— 本轮实测 7
  passed / exit 0 / wall 89767ms > 60000ms 默认；不声明预算，台账尾永远读出
  not-evaluated(timeout) 而不是 pass
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

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。GOAL-041 的 AC-345（`goals/AC-345-live-voice-意图控制浏览器验收-scripted-fake-paced-audio-playwright-覆盖.md`，`status: active`，`kind: criterion`）被判 CURRENTLY FALSE 交办；认领它的唯一任务 `gap-live-voice-intent-control-browser-e2e` 已是 `done`（fan-in `1a08ec0d`）。故本轮先做**直接现测**：判据内容已是绿，红的是**闸的预算**。

### 判据物（逐字取自该 goal 文件的 `criterion:`）

```
f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test "$f"
```

### 本轮直接现测：判据在净检出上退出 0

在 `/data/home/yale/work/claudecodeui`（branch `author`）直跑（`bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-intent-control.spec.ts`，`DASHSCOPE_API_KEY` 置空），两次读数逐字：

```
run2:   7 passed (1.4m)   EXIT=0   WALLCLOCK_MS=89767     （warm）
run1:   7 passed (1.5m)   EXIT=0                            （含冷启动，墙钟更长）
```

七条用例逐字通过（`743 sentences spoken during a run stay visible one by one…`、`904 a typed message and a spoken sentence reach the CLI queue in the order they happened…`、`1008 a second interrupt for the same correction aborts once…`、`1093 an upstream disconnect during the interrupt loses no backlog…`、`1199 an interrupt whose correction cannot be confirmed…`、`1285 a malformed function call during a correction is recoverable…`、`1357 the same utterance relayed twice reaches the session once`）。⇒ **判据内容为真。**

### 机制：闸预算 < 判据墙钟 ⇒ 内容为真也永远读不出 pass

`quay goal gate <id>` 的杀闸时长由 `resolveAcceptanceTimeout(rec.timeoutMs)`（`vendor/quay/dist/quay.js:12015`）解析，优先级从高到低：

1. **记录 frontmatter 的 `timeoutMs`**（`resolveAcceptanceTimeout` 先查它，命中即 `source:"record"`；这比 `--timeout`/env 还高）；
2. `--timeout <ms>` / `QUAY_ACCEPTANCE_TIMEOUT_MS`；
3. `DEFAULT_ACCEPTANCE_TIMEOUT_MS = 60000`。

AC-345 的记录 frontmatter（id/title/status/kind/goal/criterion/expect/origin/activatedAt/statusLog/fidelity）**没有 `timeoutMs`** ⇒ 闸取 60000 ms。判据实测 89767 ms > 60000 ms ⇒ `runAcceptance` 在 60 s 处 SIGKILL，`verdictFromAcceptance` 记成 `not-evaluated (timeout): acceptance timed out after 60000ms (killed)`，`goal gate` 的 help 亦明说「A criterion that legitimately needs longer is KILLED at the deadline and recorded as a fail, so raise the deadline here rather than accepting the verdict」⇒ **AC-345 永远翻不过去。这就是「内容为真 ≠ 判据可读为真」。**

（`quay goal gate --help` 那一行只列了 `--timeout > ENV > 60000`，**漏了记录级 `timeoutMs`**；以源码为准——记录级最高优先，且是 AC-315/316/317/323/331/332 采用的同一根旋钮。）

### 为什么上一个任务的修复没有让它成立

`gap-live-voice-intent-control-browser-e2e`（`done`，`goal_ac: AC-345`）落了判据 spec、`malformedFunctionCall` 注入点与 `playwright.config.ts` 的三处登记（含该 spec 的 `SPEC_BUDGET_MS = 240_000`）。但 240 s 是 **playwright 自己的 watchdog**，抬不动 **goal 闸的 acceptance deadline**——不同进程、不同旋钮。记录级 `timeoutMs`（最高优先那根）从未声明，因为该任务的 `## Touches` 里没有 `goals/AC-345-*.md`。判据绿了，闸仍红。

### 为什么历史 gate 事件写的是「缺判据文件」

`.quay/gate-events.jsonl` 里 AC-345 的末次 fail 在 `2026-10-12T15:50:17Z`，`evaluationRoot=/data/home/yale/work/claudecodeui`，`treeSha=267862c3…`；`git ls-tree 267862c3 -- e2e/voice-realtime-intent-control.spec.ts` **为空**，而落该 spec 的 fan-in 提交 `1a08ec0d` 在 `15:51:59Z` 才进 develop/主检出。⇒ 那条 reason 是**相对路径守卫（`[ -f "$f" ]`）读到了落地前的树**，不是文件不存在。今天 `[ -f "$f" ]` 通过。这条要记明，避免下一位读历史事件时误判为 spec 丢失。

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rn "^goal_ac: *AC-345" tasks/*.md` 命中**仅 1 条** —— `tasks/gap-live-voice-intent-control-browser-e2e.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-345`）**0 命中** ⇒ 无在飞认领者，本条不是重复。同族先例 `gap-ac317-criterion-killed-by-its-own-budget`（`goal_ac: AC-317`，done）、`gap-ac323-gate-deadline-below-criterion-serial-time` 各为**另一条 AC**，仅归因机制相同（闸预算 < 判据墙钟）。

### 要做的事

1. **量 floor**：`DASHSCOPE_API_KEY= bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-intent-control.spec.ts` 的整段墙钟（含 npx 启动 + WebServer 引导），跑 **≥3 次**取**最大值**作 floor。本会话已给两次：89767 ms（warm，`EXIT=0`）、更长的一次（冷）。⛔ 本会话 cgroup 上限 8G，全量 `--test` fan-out 会 OOM（exit 137），只跑这一个文件。
2. **声明 `timeoutMs`**：在 `goals/AC-345-*.md` frontmatter 写 `timeoutMs: <值>`，取值落在可行区间 `floor < 值 < 120000`。驱动侧 `scripts/dist/goal-driver.js` 的 `CRITERION_TIMEOUT_MS = 12e4` 是**不可配置的字面量硬闸**，声明 ≥120000 只是把「闸在 60 s 自杀」换成「driver SIGKILL 掉 gate spawn」（拿到 `not-evaluated(spawn)` 而非闸自己的 verdict）⇒ 必须 < 120000。按 **≥30% 余量（相对 floor）**：`值 ≥ floor × 1.3`；floor=89767 ms ⇒ ≥116697 ms ⇒ 取 **118000**（余量 31.4%；与姊妹 AC-316 同值，亦在 AC-331 的 118000 惯例内）。把「声明值 / floor / 余量% / 残余风险」四个数写进 Evidence。
3. **取假形态（单变量受控）**：同树、同判据、只差预算：旧默认（60000）跑一次得 `not-evaluated(timeout)`，声明预算跑一次得 `pass`，两次读数 `treeSha` 相同。判据墙钟须落在 `(60000, 声明值)` 区间内。
4. **复核**：`quay goal gate AC-345 --store --root <工作树>` 读出 **`verdict: "pass"`（exit 0）**，且该轮写入的 `.quay/gate-events.jsonl` 尾条为 pass。
5. **red-first（先证红）**：在声明**之前**先跑一次，读出非 pass 的逐字 reason（预期 `not-evaluated (timeout): acceptance timed out after 60000ms (killed)`），记进 Notes。

### 边界 / 不做

- ⛔ 不改 AC-345 的 `criterion` / `expect` 文本（只加 frontmatter 一行 `timeoutMs`）。
- ⛔ 不改 `playwright.config.ts`、不加 retries / skip、不放松任何断言。
- ⛔ 不改 `src/` 与 `server/` 的产品代码；不改任何其它 goal 记录。
- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（SPEC §0.3 D-5）；不改能力位 `cancelQueuedInput`；不触碰任何 Quay worker / driver 进程或工作树（D-9）；不重启 :3001。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18。
- 若 3 次实测 floor ≥ 118000：**不得硬凑 deadline**，改为缩短判据（裁固定等待 / 把长用例拆开），或停在 needs-human 上报；**不得把「预算已声明」写成「判据已绿」**。

## AC

- [ ] AC1（预算声明，承重）：`goals/AC-345-*.md` frontmatter 出现 `timeoutMs`，取值 `floor < 值 < 120000`；回读证明该字段存在（`quay goal get AC-345 --json --store --root <工作树>` → `"timeoutMs": <值>`），并写明依据：本轮实测 floor + ≥30% 余量 + `< driver 的 CRITERION_TIMEOUT_MS`。
- [ ] AC2（端到端翻绿，承重）：AC-345 的 criterion 命令 exit 0（登记逐字读数与 wall），且 `quay goal gate AC-345 --store --root <工作树>` 的闸裁决为 **`pass`（exit 0）** —— 不是 `not-evaluated`。
- [ ] AC3（取假形态）：同一命令留红/绿两组读数：以旧默认（60000）跑一次得 `not-evaluated (timeout): acceptance timed out after 60000ms (killed)`，以声明预算跑一次得 `pass`；两次 `treeSha` 相同；判定墙钟落在 `wall ∈ (60000, 声明值)` 区间内。
- [ ] AC4（判据未改）：`git diff --numstat develop HEAD -- goals/AC-345-*.md` 的增行只有 1（`+timeoutMs: <值>`）、删行 0；`criterion` 与 `expect` 文本逐字节相同。
- [ ] AC5（承重面未被触碰）：`git diff --name-only develop...HEAD` 只含 `goals/AC-345-*.md` 与 `tasks/<本条 id>.md`（若因 floor ≥ 118000 需缩短判据，则另含 `e2e/voice-realtime-intent-control.spec.ts` 的等待调整，须在 Notes 记明）；`git diff --name-only develop...HEAD -- src server scripts` 为空。

## DoD

真实落地：AC-345 的台账尾由 `not-evaluated(timeout)` 翻成 **pass**，留下那一轮的 wall 读数与闸裁决（`gate_log AC-345` 的 `verdict: pass`），而不是「我加了配置」的自述；声明本身落在 store 的提交里。⛔ 不得以「预算已声明」替代「判据已绿」：若判据在本树也为红，如实登记并停手上报。

## Touches

- goals/AC-345-live-voice-意图控制浏览器验收-scripted-fake-paced-audio-playwright-覆盖.md（仅 frontmatter 的 `timeoutMs` 一行；criterion/expect 文本不动）
- e2e/voice-realtime-intent-control.spec.ts（仅当 floor ≥ 118000、必须缩短等待时才改；否则只读只跑）
- tasks/gap-ac345-gate-deadline-below-criterion-wallclock.md（self）

## Notes

- 判据本体（`goals/AC-345-*.md`）**不是**本任务的「测试文件」：本任务不写代码，验收读数就是 AC-345 自己那条 criterion 命令的闸裁决（`gate_log AC-345` / `quay goal gate` 的 `verdict`）与 wall。`e2e/voice-realtime-intent-control.spec.ts` 只被**读取/执行**取证。
- 落地前 ABI 默认根读的是**主检出**的旧记录（`.quay/config.yml` 的 `providers.native.env.QUAY_NATIVE_GOAL_DIR` 钉成主检出绝对值）⇒ 分支上的声明要经 fan-in 合入 develop、主检出再取到之后，goal driver 才会按新预算跑；本条的读数先取本工作树自己那本闸（`evaluationRoot` = 工作树，与 driver 相同的 `--store --root` 方言）。
