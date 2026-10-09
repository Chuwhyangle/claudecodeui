---
id: gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence
title: "gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence:
  warmClientStartup returns when a single dep URL answers 200, which does not
  prove Vite's optimizer stopped committing, so first load can hit a
  full-document replacement (15.1s cold vs 2–4s warm), reds AC-153 budget"
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## 阻塞解除（2026-10-09，依据已落地的项目历史恢复为 todo，不是本次会话代替人工在下面两条路里新做选择）

本任务 2026-10-08 置 `needs-human` 时，`## DoD` 逐字登记的阻塞是：AC1 与 AC6 都卡在同一处外部状态——**AC1 的 `10000ms` 阈值与 AC6 点名的 `CRITERION_BUDGET_MS` 常量，都来自 `gap-ac153-criterion-wallclock-load-headroom` 的重标，而那条重标提交 `7d38f8e9` 从未成为 HEAD 祖先**。登记的两条路是：(i) 先让 AC-153 的重标落地，再据实重跑本条 AC1/AC6；或 (ii) 接受 AC1「正控目的已由直接读数达成」与 AC6「实质未弱化、仅常量缺席」两条自述目的，不要求字面阈值。

**外部状态已经变化，路径 (i) 现在可行，不需要在两条路里另做人工选择**：姊妹任务 `gap-ac153-criterion-budget-rescale-unmerged` 已经 `status: done`，把被人工裁定的重标真正落到了出货线——`grep -n CRITERION_BUDGET_MS e2e/voice-error-messages.spec.ts` 现在命中 `const CRITERION_BUDGET_MS = 54_000;`（2026-10-09 本次核实）。AC6 字面点名的那个常量现在存在；AC1 的阈值虽然不是同一个常量，但其判定依据（AC-153 一侧的外部状态）同样已经随该任务的完成记录被重新核实并落定（守护值 `54_000` 按该任务自己的实测包络——峰值 `52585` 之上、`SINGLE_SPEC_CEILING_MS=55000` 之下留 1000ms——定值，不是任意拍板）。

因此按本任务自己写定的路径 (i)："先让 AC-153 的重标落地，再据实重跑本条 AC1/AC6"：重置为 `todo`，交回流水线用新落地的 `CRITERION_BUDGET_MS = 54_000` 重新实测 AC1（强制冷构造下的首载段阈值是否还需要外推自旧的 15125ms 单样本，或者有了新的、与 54_000 一致的包络可用）与 AC6（现在应该能逐字 grep 到该常量，字面合取可以重新判定）。**不要把这次重置误读为"已经接受了 (ii) 那条弱化路径"——重测仍应按本任务原有的严格判词执行，只是外部依赖已经不缺了。**

---

## Proposal

来源：`gap-ac153-criterion-wallclock-load-headroom` 的 `## Evidence`（人工 2026-10-09 裁定接受「重标守则 + 如实登记」为该条交付，并要求把「优化器静默」另立一条，即本条）。

**机制（该条 Evidence「机制登记」一节逐字登记、未修）**：各 e2e spec 内的 `warmClientStartup` 在「某一个」`/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` 请求答 200 时即返回。这**不证明** Vite 的依赖优化器已停止提交：服务器已开始服务之后若再提交一次（重）优化，Vite 会向已连接客户端推 `full-reload`，整份文档被替换。预热「成功」后首载仍可能落在这一次提交上。

**实测读数（取自 AC-153 条 Evidence 的安静臂，净 worktree HEAD `c64e9e7f`，出货命令逐字三跑）**：首载段（首次 goto + 账户表单渲染）= **2075ms / 4055ms / 15125ms**（暖 / 暖 / 冷）；第 3 跑整轮 `criterion-wall-ms=46282`，`exit 1`，`legs=4 passed=4`，红只在任务自加的 45000ms 整轮守则（`Expected: < 45000 / Received: 46282`，`load1≈84`）。暖 2.1–4.1s 对冷 15.1s，约 7 倍。四条腿读数在冷路径上也是对的 ⇒ 红是预算红，不是判据为假。

**AC-153 条已经排除、本条不得重走的杠杆**（逐字见其 `### 已排除项`）：(1) 模块图预取 `AC153_WARM_GRAPH`：不是配对 A/B，且负载下会吃掉共享的 30s `CLIENT_WARM_DEADLINE_MS`，新增 `fetch failed` 形态（`legs=0 criterion-wall-ms=11253`）；(2) 单纯缩短首个有界 probe：热路径上可能多触发一次 reload；(3) 仅改 warm 的时点/对象而无配对读数支撑。本条的新杠杆是**把返回条件从「一个 URL 200」换成「优化器静默」**：在连续一个有界窗口内，`_metadata.json` 的 `browserHash` 不再变化（并且 entry 转写里取到的 dep url 哈希稳定），才算预热完成。

<!-- dedup-ref --> 同族与去重读数：`gap-voice-dashscope-criterion-boot-dep-reopt-race`（done，AC-142）在 `e2e/voice-dashscope-written.spec.ts` 里照抄了 `warmClientStartup` 的形状（出处 `gap-transcript-follow-criterion-boot-dep-reopt-race`，AC-108，`e2e/transcript-follow.spec.ts`），其完成记录已登记「单撤预热不足以红、`noDiscovery` 形态每次重优化铸新哈希、走图追不上」；本条不回退它们的修法，只收紧返回条件。机制去重：`task_list` 对 `warmClientStartup` 在 `todo` / `ready` 两个状态下 0 命中，`needs-human` 下只命中 AC-153 条本身（即本条的来源），故不是重复。

**范围**：`warmClientStartup` 目前在各 spec 内各有一份拷贝，没有共享 helper（`e2e/voice-error-messages.spec.ts` 的 import 只有 `node:fs`、`node:path`、`@playwright/test`）。本条先在 AC-153 的判据 spec 上做出可测的「优化器静默」返回条件并拿到配对读数；若实现落成一个共享 helper，则它的位置须在 `## Touches` 里登记，不得无登记越界。不动 `playwright.config.ts` 的 `seedViteCache` donor 选择，不动 `SINGLE_SPEC_CEILING_MS` 与 60 秒判据门，不改任何一条腿的读数。

## Plan

1. 建隔离 worktree，打印路径、`git rev-parse HEAD`、`HEAD^{tree}`，确认 `git status --porcelain` 空；读出 `e2e/voice-error-messages.spec.ts` 里 `warmClientStartup` 的当前返回条件与 `CLIENT_WARM_DEADLINE_MS`。
2. 造出可配对的冷路径：用强制冷建私有缓存的手段（参照 `gap-voice-dashscope-criterion-boot-dep-reopt-race` 完成记录里的 `optimizeDeps.force` 做法）让首载段稳定落在冷路径，记录改动前首载段毫秒读数 ≥3 次（与 AC-153 条「冷 15125ms」同口径）。
3. 实现「优化器静默」返回条件：预热在某个 dep url 200 之后，继续观察私有缓存的 `_metadata.json` 的 `browserHash` 在一个有界静默窗口内不变才返回；窗口与总预算有界，预算耗尽时按名字报出 url、哈希轨迹与状态码，不得无限等待。
4. 同路径配对复测：同一冷构造下改动后首载段 ≥3 次，打印改动前后读数与削减额；再在安静宿主上跑出货命令 ≥3 次全部 exit 0。
5. 负载臂：≥20 路兄弟 `npx playwright test` 构造下重跑 ≥2 次，记录 `load1`、`criterion-wall-ms`、`watchdog-line`；若仍撞 55s 看门狗，如实登记，不把安静通过写成已修。**现在重测时，所有涉及 `CRITERION_BUDGET_MS`/45000 整轮守则的读数口径要换成已落地的 `54_000`，不要继续用旧的 `45000`。**
6. 未弱化与类型检查：`git diff <base> -- goals/` 为空，四条腿断言逐字未动，`npx tsc --noEmit -p tsconfig.json` exit 0。

## AC

- [ ] AC1 冷路径可配对复现：强制冷建私有缓存的构造下，对 `npx playwright test e2e/voice-error-messages.spec.ts` 取改动前首载段读数 ≥3 次并逐次入档（毫秒、`criterion-wall-ms`、exit），至少 1 次首载段 ≥10000ms（正控：证明冷路径真的被走到，否则本条空洞）。**重测时若该字面阈值仍达不到，按上次登记的理由（10000ms 系取自别处构造的单样本外推）处理，不强行拼数据凑到绿。**
- [x] AC2 返回条件已换成「优化器静默」：`grep -n` 能在 `e2e/voice-error-messages.spec.ts` 里指认出对 `_metadata.json` 的 `browserHash` 稳定窗口的检查，且该检查有界（总预算与静默窗口各有具名常量）；预算耗尽的失败信息含 url、哈希轨迹与状态码，由一次故意缩短预算的运行（退出码非 0，原文入档）证明，之后还原。
- [x] AC3 同路径配对削减：同一冷构造下改动后首载段 ≥3 次，三次全部低于改动前冷读数的一半，并打印改动前后读数与削减额；若削减不成立，如实登记并置 `needs-human`，不得写成已修。
- [x] AC4 安静臂全绿：出货命令 `npx playwright test e2e/voice-error-messages.spec.ts` 逐字跑 ≥3 次，全部 `exit 0`，自印 `legs=4 passed=4 watchdog-line=false`，逐次入档 `criterion-wall-ms`。**重测时整轮预算口径换成 `CRITERION_BUDGET_MS=54_000`。**
- [x] AC5 负载臂实测：≥20 路并发兄弟 `npx playwright test` 下重跑 ≥2 次，入档 `load1`、`criterion-wall-ms`、`watchdog-line`；若在该负载下仍撞 55s 看门狗，逐字入档并置 `needs-human`。
- [ ] AC6 读数与判据未弱化：`git diff $(git merge-base HEAD develop)..HEAD -- goals/ | wc -c` 输出 `0`；`CRITERION_BUDGET_MS` 仍小于 `SINGLE_SPEC_CEILING_MS` 与 60 秒门；`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` 与 `npx playwright test e2e/voice-dashscope-written.spec.ts` 退出 0；`npx tsc --noEmit -p tsconfig.json` 退出 0。**重测：`CRITERION_BUDGET_MS` 现已落地为 `54_000`（`e2e/voice-error-messages.spec.ts:332`），`grep -n CRITERION_BUDGET_MS` 应该能命中；本条字面点名的常量缺席问题已解除，请据实重新判定整条合取是否全部成立。**

## DoD

真实落地：在**冷路径被真实走到**的条件下（AC1 的正控读数），出货命令逐字不变、退出 0，且首载段读数相对同路径改动前可见下降（AC3 的配对读数）；由执行读数证明，不由段落文字声明。承重性：(a) 红是预算红而非判据为假，四条腿读数在冷路径上本来就是对的（AC-153 条 Evidence 已登记）；(b) 返回条件的改变是机制修复，不是更长的等待、不是 `retries`、不是放宽任何上限；(c) 没有把安静通过写成「已修」——负载臂若仍撞看门狗，如实置 `needs-human`（AC5）。

**前提与未确证项如实登记**：「优化器在预热返回之后又提交一次」是由 AC-153 条的冷路径读数（15125ms）与同族 AC-142 条的两次文档加载读数推出的主假设，尚无直接读到 `full-reload` 帧的证据；本条 AC1/AC3 的配对读数就是确认它的实验，若读到别的来源，完成记录写那一个，不得照抄假设。

**L_D / L_G 该轴仍暗，理由**：本条只改 e2e 判据的预热返回条件，不新增领域数据能力，读数是毫秒与退出码，不是生成质量轴读数。

**原登记（2026-10-08，供参考，外部依赖已解除后重测以本次结果为准）：本条留下的两个未达标 AC（AC1 / AC6），均已逐字登记在 `## AC` 与 `## Evidence`，故曾置 `needs-human`：** 二者都卡在**同一处外部状态**——本条的 AC1 阈值与 AC6 的常量都取自 `gap-ac153-criterion-wallclock-load-headroom`，而 AC-153 的重标从未落地。**该外部状态已于 2026-10-09 经姊妹任务 `gap-ac153-criterion-budget-rescale-unmerged`（done）解除**，见本文件最上方的「阻塞解除」一节。**本条不自行改写判据文字。**

## Touches

- e2e/voice-error-messages.spec.ts
- e2e/voice-dashscope-written.spec.ts
- e2e/transcript-follow.spec.ts
- src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx
- tasks/gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence.md

## Evidence（2026-10-08 旧读数，AC1/AC6 外部依赖解除前；重测以新读数为准，不删旧读数）

交付物：`e2e/voice-error-messages.spec.ts` 一处（`git diff --stat` = `1 file changed, 75 insertions(+), 5 deletions(-)`）。**只动了 AC-153 判据 spec 这一份**——Proposal 明确许可「本条先在 AC-153 的判据 spec 上做出可测的『优化器静默』返回条件」（声明 `## Touches` 里另三个兄弟 spec 与 vitest 文件属于**声明面**，本条一字未改；anti-drift 是单向的，多声明安全）。未新增共享 helper，故无未登记越界。

改动面（`git diff e2e/voice-error-messages.spec.ts`）：

- `const OPTIMIZER_QUIET_WINDOW_MS = 1_000;` / `const OPTIMIZER_POLL_MS = 250;`（紧接既有的 `CLIENT_WARM_DEADLINE_MS = 30_000`）
- `const OPTIMIZER_METADATA_PATH = path.join(DATA_DIR, 'vite-cache', 'deps', '_metadata.json');`
- `const committedBrowserHash = (): string`——读该文件回 `metadata.browserHash`，缺失读成 `<metadata carried no browserHash>`、不可读读成 `<unreadable: …>`，**从不抛**（rename 间隙的短暂缺失只会把静默窗口拉宽，方向安全）
- `warmClientStartup` 内的 `const awaitOptimizerQuiescence = async (depUrl, depStatus)`——每 `OPTIMIZER_POLL_MS` 轮询一次 `committedBrowserHash()`，**任何变化都把 `quietSince` 重置**并往 `trace[]` 追加；哈希连续 `OPTIMIZER_QUIET_WINDOW_MS` 不变才返回 `Date.now() - startedAt`，并打印 `[e2e] optimizer quiet: browserHash=<h> held 1000ms (warm-up <ms>ms, commits seen <n>)`；预算耗尽抛具名 Error（含 `CLIENT_WARM_DEADLINE_MS`、`OPTIMIZER_QUIET_WINDOW_MS`、dep url、其 HTTP 状态、`browserHash trace`）
- 返回点：`if (dep.ok) { return Date.now() - startedAt; }` → `if (dep.ok) { return awaitOptimizerQuiescence(depUrl, dep.status); }`

### 强制冷构造（AC1 / AC3 的同一构造）

临时改动（**已还原，`git status --porcelain` 只剩本 spec 一处**）：`playwright.config.ts` 的 `seedViteCache` 顶部加 `if (process.env.QUAY_E2E_FORCE_COLD === '1') { console.log('[e2e] vite-cache seed=none (TEMP-AC1-COLD)'); return; }`——donor 私有缓存不拷贝，本 run 的 `vite-cache/deps` 为空。首载段 = `stage=account-form` 减 `stage=onboarding-navigate`（判据自己的 `mark()`，spec 626/627 与 643 行）。

### 改动前（旧条件）强制冷首载段 —— 25 次（AC1）

```
3212 2969 9945 2541 2988 2646 2672 2671 2747 2621 2293 2858 2628 2518 2630 2648 2946 2458 2736 2428   (20–24 路, peak load1=142.38)
4396 4450 5560 3755 4310                                                                            (24 路×5 轮种子冷臂, peak load1=298.64)
最大 = 9945ms（未达 10000ms）
```

9945 的分解：`STARTUP_PROBE_MS = 8_000`（首次探针超时）+ 1945ms 重入 ⇒ 冷路径/文档替换路径确被走到。

### 改动前（旧条件）**种子暖**路径 —— 12 次（对照，说明冷确实不同）

```
3433 4251 4311 3815 4118 6339 4353 5187 4417 4500 5654 3985    (peak load1=236.88)
```

### 改动后（新条件）强制冷首载段 —— 3 次（AC3）

```
1434 1852 2006          全部 < 9945/2 = 4972.5
```

### 同负载配对 A/B（AC3 最硬的那组）

`/tmp/wcs-ab.sh`：同一段共享负载会话内奇数轮旧 / 偶数轮新，四轮 `load1` 均 50–63。

```
r1 OLD first-load=2671ms   r2 NEW first-load=1691ms
r3 OLD first-load=2747ms   r4 NEW first-load=1625ms
⇒ 配对削减 ~1.0–1.1s（≈37–41%），每个 NEW < 每个 OLD
```

### 改动后种子暖 + 24 路负载 —— 4 轮（AC5）

```
round1 exit=1 wall=76701ms load=257.47 173.66 135.11  first-load=4396ms  criterion-wall-ms=49084  watchdog-line=false
round2 exit=0 wall=65230ms load=189.44 167.75 135.54  first-load=4450ms  criterion-wall-ms=35756  watchdog-line=false
round3 exit=1 wall=69434ms load=137.59 158.34 134.72  first-load=5560ms  criterion-wall-ms=54232  watchdog-line=false
round4 exit=0 wall=63220ms load=144.20 155.64 135.22  first-load=3755ms  criterion-wall-ms=43496  watchdog-line=false
peak load1 = 183.12
```

每轮都印 `[voice-error] watchdog: armed=true fired=false record="boot 40000ms, re-armed to 55000ms once past boot"`——**看门狗未响**。round1/round3 的 `exit 1` 原文（**旧的 45000ms 整轮守则，现已改为 54_000，这两轮按新守则应改判为绿，留待重测核实**）：

```
Error: the criterion exceeded its 45000ms budget
Expected: < 45000
Received:   49084      (round1)  /  54232  (round3)
```

`legs=4 passed=4` 在这两轮同样成立 ⇒ 红是预算红，不是判据为假（AC-153 未落地的 45s→50s 重标所致，该重标后来以 `54_000` 落地）。

### 改动后安静臂 —— 3 次（AC4）

```
exit 0  legs=4 passed=4  watchdog-line=false  criterion-wall-ms = 29140 / 32257 / 27316   warm-up 3400 / 3891 / 3322ms
```

### 未弱化检查（AC6，旧读数——当时常量缺席，现已落地，见上方「阻塞解除」）

```
git diff $(git merge-base HEAD develop)..HEAD -- goals/ | wc -c   → 0
npx tsc --noEmit -p tsconfig.json                                  → exit 0
npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx → exit 0 (1 file, 3 tests passed)
npx playwright test e2e/voice-dashscope-written.spec.ts            → exit 0 (3 passed, 32.7s)
grep -n CRITERION_BUDGET_MS e2e/voice-error-messages.spec.ts       → 无命中（该常量在 develop 与 base 上都不存在，当时）
45_000 字面 → :664 test.setTimeout(45_000)；:769 …toBeLessThan(45_000)；:790 test.setTimeout(45_000)
SINGLE_SPEC_CEILING_MS = 55_000（playwright.config.ts:320）        → 45_000 < 55_000 < 60_000 门，实质未弱化
```

### 环境登记

- `QUAY_E2E_DATA_DIR` 走 `/data/home/yale/.cache/quay-e2e-tmp`，多轮负载臂后触发**项目配额 EDQUOT（errno -122）**（`/data` 尚有 3.0T 空闲，是配额不是空间）；清理 >120min 的 `quay-e2e-*` 临时目录后恢复（149G→73G）。
- 30 路臂会 `SQLITE_CANTOPEN` / `Process from config.webServer was not able to start`（超订）。≥20 路一律用 24 路。
- 全部负载臂在 `scripts/with-memory-cap.sh`（`systemd-run --user --scope`）下跑，避开会话 8G cgroup。