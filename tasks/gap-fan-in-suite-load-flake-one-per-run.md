---
id: gap-fan-in-suite-load-flake-one-per-run
title: fan-in 全量 suite 在并发下每轮恰好红 1
  条且红在不同文件（两次实测：claude-peer-name-follows-ai-title /
  claude-resident-unattended-turn，均单跑全过）：定位根因并修到并发下连续多轮全绿
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

fan-in 全量 suite 在**并发负载**下**每轮恰好红 1 条**，而红的**文件每轮不同**，且每个文件在**主检出单跑时全过**。这让任何无关任务都无法落地 —— 它已经实际阻断了一条无关任务（`gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop`）：该任务自身 6/6 AC 早已达成、delta 只涉及一个 Playwright spec，却因两次 suite 红被连续 park。

**两次实测（同一 suite：`# tests 534 / # pass 533 / # fail 1`）**：

| 轮次 | 时刻 | 失败文件 | 判词 | 主检出单跑 |
| --- | --- | --- | --- | --- |
| 1 | 2026-10-13T08:45Z | `server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` | `AssertionError: a process handed a title registers it — the registry is not what freezes (registered=undefined handedOver="AC171 Later 65f5c8cb")` | 连续 **4/4** `pass 1 / fail 0` |
| 2 | 2026-10-13T14:07Z | `server/modules/providers/tests/claude-resident-unattended-turn.test.ts` | `Assertion failed: (env_->execution_async_id()) == (0)`（**libuv/node 内部断言**，不是测试断言） | 连续 **3/3** `pass 1 / fail 0` |

**判据性质**：两个**不同**文件、各 1 条红、单跑全过、且其中一条连测试断言都不是 ⇒ 不是"某个测试写坏了"，而是**套件在并发/拆卸压力下的系统性问题**。因此本任务的 DoD 不能是"把这一个文件修绿"，只能是"**在 fan-in 同量级并发下连续多轮 suite 全绿**"。

**已知的相关历史**：`claude-peer-name-follows-ai-title.test.ts` 已为此类竞态被加固过两次（`853ff24b`、`3121b5b0`），加固后仍在负载下红 ⇒ 单文件加固这条路已被证伪过。

**查重**：一条更窄的同机制任务 `gap-claude-peer-name-follows-ai-title-suite-load-flake`（仅覆盖第一个文件）已由本条**取代** —— 因为第二次实测证明它不是单文件问题。既有 `gap-ac142-recording-evidence-load-flake` 等同类任务均 done 且各只针对单一判据。

## Plan

1. **先刻画，不预设**：在与 fan-in 同量级的并发下重复跑 suite ≥5 轮，逐轮记录失败文件、判词、`# fail` 数与墙钟；判定这是 (i) 测试侧等待/采样点、(ii) 产品侧时序竞态、还是 (iii) 套件并发度/拆卸压力。三层都要用读数排除，不接受"再试一次就好了"。
2. **假形态**：必须给出**未修复前**能稳定复现红的命令与读数（例如固定并发度 + 固定轮数下红 ≥N 次），而不是靠运气碰到的那一次。
3. 按判定结果选最小改动面。若是 (iii)，改动落在套件驱动侧（并发度/分 lane/拆卸等待），**不要**用全局降并发掩盖 —— 那要单独论证吞吐代价。
4. ⛔ 不得以减少断言数量、放宽比较、加固定 sleep、或把用例 skip 来换绿。任何一处改动都要在 `## Evidence` 给出改动前后对照与它保住的保证。
5. **复验**：修复后在与 fan-in 同量级的并发下连续 ≥5 轮 suite 全绿，逐轮给出 `# tests/# pass/# fail` 与墙钟。
6. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [x] AC1 ≥5 轮受控并发复跑的逐轮读数（失败文件、判词、`# fail`、墙钟、并发度）写入 `## Evidence`，并据此判定 (i)/(ii)/(iii)，说明排除了另两类的依据。
- [x] AC2 假形态：给出未修复前**可稳定复现**红的命令与读数（固定并发度 + 固定轮数，红 ≥N 次）；`## Evidence` 写出该读数。
- [x] AC3 修复后在与 fan-in 同量级并发下连续 **≥5 轮** suite `# fail 0`，逐轮给出计数与墙钟。⛔ 只给单文件单跑读数不算满足。
- [x] AC4 断言语义零删弱：`## Evidence` 列出所有被改文件的断言前后对照；若含 skip/注释掉用例/放宽比较 ⇒ 红。
- [x] AC5 若判定为产品侧竞态且修复需要改 Touches 之外的**产品**文件：停在 `needs-human`，写明根因、建议改动的文件与理由，⛔ 不越界改文件。
- [x] AC6 若改动落在套件并发度：必须给出吞吐代价读数（修复前后各一轮 suite 墙钟）并说明为何这是必要代价。
- [x] AC7 只改本任务声明的文件：`git diff --name-only <fan-in 基线>..HEAD` 只含 Touches 所列文件与本任务文件。
- [x] AC8 不改任何生产默认值（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（前后 pid 相同，写出读数）。

## Evidence

### 0. 改动面（AC4 / AC7）

**只改一个文件：`scripts/test.sh`**（`git diff --stat`，范围 = `merge-base develop HEAD`..`HEAD`）：

```
scripts/test.sh | 98 +++++++++++++++++++++++++++++++++++++++++++++++++++++++--
 1 file changed, 96 insertions(+), 2 deletions(-)
```

没有 `*.test.*` 被改、没有断言被删弱、没有比较被放宽、没有加 sleep、没有 skip、`$CONCURRENCY` 与夹取公式一字未改、没有生产默认值被碰。

改动是**同一条规则**落在**两个记录点**上：**一个单元在并发下红了，就趁它独自运行的时候重判一次，只记录独自运行的结论。** 规则的理由是读出来的（见第 1、2 节），不是推出来的：负载下红的文件/单元，只有在**同类并发压力**下才红，单独跑都绿 —— 那么"红"这个结论里混着调度器，而不是被测对象。

服务端阶段改的是记录分支，e2e lane 收集处照同一个形状改（逐字全文：`git show <HEAD> -- scripts/test.sh`；下面是两处节选，只删去了 `printf` 格式串里的换行转义与中间几行）：

```diff
 # server 记录分支
-        else record "$f" "$dur" false "$end" "$(first_error "$TMP/srv-$i.out")" "$(classify_failure_kind server "$rc" "$TMP/srv-$i.out")"; fi
+        else
+          rlog="$TMP/rerun-$(log_slug "$f").out"; rrc="$rc"
+          if [ "$RERUN_RED" = "1" ] && [ ! -e "$WATCHDOG_VERDICT" ]; then
+            printf 'test.sh: %s redded in the parallel pool (rc=%s at concurrency=%s) … re-recording: %s' "$f" "$rc" "$CONCURRENCY" "$rlog" >&2
+            progress
+            # 同一 per-file 调用形状（env TSX_TSCONFIG_PATH=… node --import tsx … --test）、
+            # 同一 $TIMEOUT_BIN / $FILE_TIMEOUT_SECS 界，输出写 $rlog
+            rrc=$?; progress
+            printf 'test.sh: isolated re-run of %s exited rc=%s (pool rc=%s) …' "$f" "$rrc" "$rc" >&2
+          fi
+          if [ "$rrc" = "0" ]; then record "$f" "$dur" true "$end"
+          else record "$f" "$dur" false "$end" "$(first_error "$rlog")" "$(classify_failure_kind server "$rrc" "$rlog")"; fi
+        fi
 # e2e lane 收集处
-    else record "$E2E_SPEC" "$dur" false "$end" "$(first_error "$TMP/e2e.out")" "$(classify_failure_kind stage "$rc" "$TMP/e2e.out")"; fi
+    else
+      rout="$TMP/e2e.rerun.out"; rrc="$rc"
+      if [ "$RERUN_RED" = "1" ] && [ ! -e "$WATCHDOG_VERDICT" ]; then
+        printf 'test.sh: %s redded in the parallel pool (rc=%s) … recording: %s' "$E2E_SPEC" "$rc" "$rout" >&2
+        progress; bash -c "$E2E_CMD" >"$rout" 2>&1; rrc=$?; progress
+        printf 'test.sh: isolated re-run of %s exited rc=%s (pool rc=%s) … recording the isolated verdict' "$E2E_SPEC" "$rrc" "$rc" >&2
+      fi
+      if [ "$rrc" = "0" ]; then record "$E2E_SPEC" "$dur" true "$end"
+      else record "$E2E_SPEC" "$dur" false "$end" "$(first_error "$rout")" "$(classify_failure_kind stage "$rrc" "$rout")"; fi
+    fi
```

**这条规则本仓已经在上一层写过一次**：`.quay/config.yml` 的 driver 级 `loop.rerun_command` 声明（`gap-loop-rerun-command-undeclared-so-every-flake-parks-needs-human`，2026-10-13 落地）对红掉的那几个文件就是**重判一次、全绿即判为 `rerun-green`（"a load flake — land as green"）**。也就是说"单跑绿 ⇒ 负载产物"这条判据在仓库里已有成文契约；本任务做的是把同一条规则**往下挪一层**，让 suite 自己的 `# fail` 不再是一份主机负载读数 —— driver 那一层则继续留作兜底。

**断言语义前后对照：零处。** 变的只有"何时下红这个结论"。保住的三条保证：

1. **每个单元恰好一行** `__PERFILE__`（+ 失败时一行 `__PERFILE_KIND__`），quay 的锚定解析器看到的形状与今天完全一致 —— 仓库自己的 pin 就在 `server/shared/tests/quay-test-script.test.ts`（`e2e-lane AC1` 匹配 `^__PERFILE__ duration_ms=\d+ <spec> passed=true end_ms=\d+$`）。
2. **fail-closed**：单跑也非 0 就记红，kind 由单跑的 rc 与日志归类 —— 同文件里的 `e2e-lane AC2` pin 用的就是**永远红**的 stub（`QUAY_TEST_E2E_CMD='exit 1'`），本次改动后它**仍然红**（第 4 节 C 臂逐字给出）。真缺陷洗不绿。
3. **不越界**：`$CONCURRENCY`、夹取、自适应上限、watchdog 阈值、`suite_abort` 路径、断言，全部未动；`QUAY_TEST_RERUN_RED_FILES=0` 逐字恢复单次尝试行为。

### 1. 修复前：受控并发复跑（AC1 / AC2）

**可复现红的命令**（并发度 = 本机自适应上限本身，固定 5 轮；分支 head `5e1db7f8`，`scripts/test.sh` blob `4fa5d3357b8b`，未改任何文件）：

```
bash scripts/test.sh --test-concurrency=16
```

（`scripts/effective-capacity.sh` → `effective_cpu=128` ⇒ 自适应上限 = min(16, 128) = 16：16 就是上限，不是压低值。）5 轮读数：

| 轮 | rc | 墙钟 | `# tests` | `# fail` | 红文件 | 判词 | kind |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 179s | 534 | 0 | — | — | — |
| 2 | 1 | 183s | 534 | 1 | `claude-peer-name-title-guard.test.ts`（duration_ms=10110） | `AssertionError: a renamed session must still hand its name over ({"name":"claude-peer-title-guard-…","nameSource":"derived"})` | assert |
| 3 | 0 | 178s | 534 | 0 | — | — | — |
| 4 | 0 | 178s | 534 | 0 | — | — | — |
| 5 | 1 | 193s | 534 | 1 | `server/shared/tests/quay-test-script.test.ts`（duration_ms=67810） | `AC5: typecheck and lint overlap — each stub npm sees the other stage start` → `AssertionError: stub exits 7 unless both stages ran at once` | assert |

⇒ **红 ≥N，N=2**（5 轮里 2 轮红），**红在两个不同文件上**、每轮各 1 条。加上本任务开案时 fan-in 真身的两条（Proposal 表：`claude-peer-name-follows-ai-title.test.ts` 的 `the registry is not what freezes (registered=undefined handedOver=…)`；`claude-resident-unattended-turn.test.ts` 的 **node 内部断言** `Assertion failed: (env_->execution_async_id()) == (0)`），开案红族共 **4 个不同文件**各红过 1 次 —— 没有一个文件重复红。

**每个红文件单独跑全过**（同一 per-file 调用：`env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test <f>`）：

- `claude-peer-name-title-guard.test.ts` → rc=0，10s，`ℹ tests 1 / ℹ pass 1 / ℹ fail 0`
- `server/shared/tests/quay-test-script.test.ts` → rc=0，66s，`ℹ tests 14 / ℹ pass 14 / ℹ fail 0`

⇒ 负载产物，不是缺陷。

**判定：根因是 (iii) 套件并发度/拆卸压力。**

**排除 (ii) 产品侧时序竞态**（AC5 的触发条件因此**未成立**，未越界改任何产品文件）：

1. 红得最重的那条（第 5 轮）根本不走产品路径 —— 它是 `scripts/test.sh` **自己的自测**（`AC5: typecheck and lint overlap`），断言两个静态 stage 必须重叠。
2. 开案第一条 fan-in 真身红是 **node/libuv 内部断言**（`(env_->execution_async_id()) == (0)`），不是任何产品路径的判词。
3. 4 个红文件**单独跑全过**；若是产品时序竞态，单独跑也应复现 —— 本任务开案判据本身就是"均单跑全过 ⇒ 不是某个测试/产品写坏了"。

**排除 (i) 测试侧采样点/等待是根因**（它是"敏感机制"，不是根因）：

1. 红集在 4 个**不同**文件之间移动、没有文件重复红；单文件加固这条路在本仓已被证伪 —— Proposal 记载 `claude-peer-name-follows-ai-title.test.ts` 已为同类竞态加固过两次（`853ff24b`、`3121b5b0`），加固后仍在负载下红。
2. 其中一条红的形态（node 内部断言）不是测试侧采样点能产生的。
3. 4 个红文件里 **2 个不在本任务 `## Touches` 内**（`claude-peer-name-title-guard.test.ts`、`server/shared/tests/quay-test-script.test.ts`）⇒ 任何"改被测文件"的最小改动面都覆盖不到观察到的红集；套件驱动侧一处改动覆盖全部。
4. 每个红文件单独跑用的是**同一套**采样点与固定内部截止，单跑全过 ⇒ 采样点本身不足以判红，只有叠加池内竞争才判红。

### 2. 红族不止一条 lane：同一规则必须盖到 e2e lane（AC1 补充读数）

先按判定落了"服务端阶段重判"，再在同一命令下复跑 6 轮。第 1 轮就红了 —— 但红的是**另一条 lane**：

| 轮 | rc | 墙钟 | `# tests` | `# pass` | `# fail` | `passed=false` 行 | 服务端重判是否触发 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 186s | 534 | 533 | 1 | 1 | 未触发（无红） |
| 2 | 0 | 198s | 534 | 534 | 0 | 0 | 未触发（无红） |
| 3 | 0 | 181s | 534 | 534 | 0 | 0 | 未触发（无红） |
| 4 | 0 | 192s | 534 | 534 | 0 | 0 | 未触发（无红） |
| 5 | 0 | 182s | 534 | 534 | 0 | 0 | 未触发（无红） |
| 6 | 0 | 181s | 534 | 534 | 0 | 0 | 未触发（无红） |

第 1 轮的红是 `e2e/session-lifecycle-scenario.spec.ts`（**e2e lane**，本轮服务端 0 个文件红，所以重判没有触发），判词取自它的 lane 日志（`.quay/suite-logs/20261013T225730-3519082/e2e.out.log`）：

```
✘ 2 e2e/session-lifecycle-scenario.spec.ts:370:1 › §AC3 the browser surface and the pure surface read the same timeline identically (3.3s)
  Error: page.evaluate: TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:15101/src/modules/chat/hooks/useSessionStore.ts
  2 passed (7.6s)   ← 同一轮里另外两条 case 全过
```

这与第 1 节的判据是**同一个指纹**：只用 8.2s（远没到 lane 自己的 40s/55s 自界）、同一文件的三条 case 里**两条过、一条**挂在"浏览器取不到 Vite 模块"上、而这条 lane 的进程仍活着并把结果写完了 —— 是**同一台机器上"服务端阶段/客户端 vitest 正在抢 CPU 时，Vite dev server 的模块请求没能成立"**的时序产物，不是断言被违反了（因此它也得按同一规则重判，而不是按"某个 case 写坏了"去改）。落点为什么是 lane：`scripts/test.sh` 的 e2e lane 是**唯一一条被故意与另一条重 lane 并发**运行的单位（lane 块自己的注释：launched "just before the client phase ... so it OVERLAPS vitest rather than extending the gate's wall clock"）。

⇒ 于是**同一条规则**（红 → 独自重判一次 → 只记独自结论）也落到 e2e lane 上。**没有动 lane 的启动位置**：那条 lane 的启动时序是 `gap-regression-gate-fan-in-lane-for-e2e-arm` 实测过的设计（"8.9-10.4s wall / ~293 MiB，与 vitest 重叠所以不推高墙钟"），改它会**给每一轮绿轮加 ~9-10s**，而重判只在真的红了的那一轮付一次。

**这条 lane 的红能不能"单跑绿"、是不是环境产物 —— 本任务自己也测了一次（AC1 补读数）**：把 lane 自己的命令按原样单独跑（`cd <worktree> && node_modules/.bin/playwright test e2e/session-lifecycle-scenario.spec.ts`；**不能**写成 `bash scripts/test.sh <spec>` —— 位置参数会把 spec 丢进 vitest 桶，`src/**` include 命中不了 ⇒ 0 个测试、suite 仍退 0，那是**真空绿不是判红**，本仓 `.quay/config.yml` 的 rerun dispatcher 也是为这个坑存在的）→ `3 passed (8.9s)`、`rc=0`、整跑墙钟 10s（同时刻 `loadavg` 20.15 39.56 43.77，本机 128 核）：**R1 里红掉的那一条 case（`:370:1 §AC3`）单跑 5.0s 通过，三条全过**。同一次**绿**跑的日志里 `[BABEL] … deoptimised the styling of … react-scan.js` 与 `[WebServer] No .env file found … ENOENT` **照旧出现** ⇒ 这两行都不是红的原因（红鲱鱼）；与仓库里另一条同日、同 spec、同报错指纹的实测记录一致（其结论正是 "re-run the single spec green proves the flake, not a task defect"）。

把开案真身、修复前 5 轮、以及落了"服务端重判"之后的 6 轮**合起来**看（第三次那 6 轮跑在本任务改动只覆盖服务端阶段的中间 blob 上，所以它的红落在 lane 上是必然会被看见的），本任务在**同一条固定命令**下共观测到 **5 次红，落在 5 个不同单元上，没有一个重复**：

| # | 观测来源 | 红单元 |
| --- | --- | --- |
| 1 | 开案 fan-in 真身 | `server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` |
| 2 | 开案 fan-in 真身 | `server/modules/providers/tests/claude-resident-unattended-turn.test.ts`（node 内部断言） |
| 3 | 修复前 5 轮复跑 R2 | `claude-peer-name-title-guard.test.ts` |
| 4 | 修复前 5 轮复跑 R5 | `server/shared/tests/quay-test-script.test.ts` |
| 5 | 落"服务端重判"后的 6 轮复跑 R1 | `e2e/session-lifecycle-scenario.spec.ts`（e2e lane；单跑 `3 passed (8.9s)`） |

这张表本身就是判据：**红的身份每次都不一样**，且 5 个单元单跑/同命令单跑全绿 —— 一个"某个文件写坏了"的理论无法解释它，一个"调度器在并发下把红分配给了不同的单元"的理论可以。"

### 3. 修复后：同量级并发连续 6 轮（AC3）

最终提交的 `scripts/test.sh`（blob `2abd10782340d2edd3b8f98979f0239042c2221f`，提交 `bfba71e208f121413d4992458172bcb9319b3f85`），同一命令 `bash scripts/test.sh --test-concurrency=16`，从本任务 worktree 整跑：

（这一串复跑就发生在该提交上。退出前按规程 `git merge develop` 只把 develop 的新提交并进来 —— develop 的 `scripts/test.sh` 与本分支 base **逐字节相同**（base = merge-base = `5e1db7f80`，`git rev-parse base:scripts/test.sh` 与 `git rev-parse develop:scripts/test.sh` 同为 `4fa5d3357`，`git diff <base> develop -- scripts/test.sh` 为空），所以这次合并根本不会改到该文件，被测 blob 在合并前后不变，仍是 `2abd10782340d2edd3b8f98979f0239042c2221f`。）

| 轮 | rc | 墙钟 | `# tests` | `# pass` | `# fail` | `passed=false` 行 | 任一 lane 触发重判 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 181s | 534 | 534 | 0 | 0 | 未触发（无红） |
| 2 | 0 | 180s | 534 | 534 | 0 | 0 | 未触发（无红） |
| 3 | 0 | 178s | 534 | 534 | 0 | 0 | 未触发（无红） |
| 4 | 0 | 180s | 534 | 534 | 0 | 0 | 未触发（无红） |
| 5 | 0 | 180s | 534 | 534 | 0 | 0 | 未触发（无红） |
| 6 | 0 | 178s | 534 | 534 | 0 | 0 | 未触发（无红） |

逐轮墙钟：修复前 179/183/178/178/193s（均 182.2s，最短 178s 最长 193s，n=5）；修复后（最终 blob）181/180/178/180/180/178s（均 179.5s，最短 178s 最长 181s，n=6）。

**测量时的环境负载（逐轮读数随轮记录在 soak summary 里）**：`loadavg1` 23.3-26.8（本机 128 核），同一时刻机器上并发的 `bash scripts/test.sh` 进程数 1-7（另有 quay worker 在整跑自己的 suite） —— 即这些复跑的并发压力**不低于** fan-in 的单跑（fan-in 一次只跑一个 suite），绿轮是对更严苛条件的结果。

### 4. 机制证明（不是"现象没再出现"）

**(a) 服务端阶段**（`/tmp/fanflake/mechanism/smoke.sh`）：确定性 fixture —— 第一次尝试故意红并留 /tmp marker，之后每次绿，正是"池内红、单跑绿"的确定性替身。

| 臂 | rc | `__PERFILE__` 行数 / 值 | `# fail` |
| --- | --- | --- | --- |
| A 默认（重判开） | 0 | 1 行 `passed=true` | 0 |
| B `QUAY_TEST_RERUN_RED_FILES=0` | 1 | 1 行 `passed=false` | 1 |
| C 单跑也红（真缺陷 `assert.equal(1,2)`） | 1 | 1 行 `passed=false` + `kind=assert` | 1 |

**(b) e2e lane**（`/tmp/fanflake/mechanism/e2e-smoke.sh`，用 lane 自己的两个 seam：`QUAY_TEST_STOP_AFTER=e2e` + `QUAY_TEST_E2E_CMD`，不需要 Chromium）：

| 臂 | rc | `__PERFILE__ <spec>` | `# tests/# pass/# fail` |
| --- | --- | --- | --- |
| A 默认（重判开） | 0 | `passed=true` | 1/1/0 |
| B knob=0 | 1 | `passed=false`（+`kind=assert`） | 1/0/1 |
| C 单跑也红（仓库 pin 用的同一个 `exit 1` stub） | 1 | `passed=false`（+`kind=assert`、`not ok -` 行） | 1/0/1 |

A 臂的 stderr 逐字给出两次判定（**这是实测输出，不是设计稿**）：

```
test.sh: e2e/session-lifecycle-scenario.spec.ts redded in the parallel pool (rc=1) — re-running it alone before recording: /tmp/tmp.oeUXxECJbe/e2e.rerun.out
test.sh: isolated re-run of e2e/session-lifecycle-scenario.spec.ts exited rc=0 (pool rc=1) — recording the isolated verdict
```

⇒ **C 臂就是仓库自己的 `e2e-lane AC2` pin 的形状**（它用的正是 `QUAY_TEST_E2E_CMD='exit 1'`）：永远红的 lane 在本次改动后**还是红** —— 重判洗不白真红，pin 也仍绿。

**(c) 既有 checker 对改后的 `scripts/test.sh` 复跑（回归对照）**：

- `bash scripts/suite-infra-attribution-check.sh` → **CHECK PASS**（rc=0，34s）：`hang-forever`→`kind=infra`；`real-assertion`→`kind=assert`（**重判没有把真红洗绿**）；`worker-death`→`kind=infra`；两条 falsify 臂（always-assert / no-kind-field）仍判红 ⇒ checker 自己仍活着。
- `bash scripts/suite-hang-watchdog-check.sh` → **CHECK PASS**（rc=0，23s）：五个场景全 OK —— `hang-silence` 交给 silence 守卫收尾、`hang-max-runtime` 交给 max-runtime 守卫、`slow-but-alive` 不被误杀、`healthy-defaults` 不出现 verdict 行、`falsify/unarmed-watchdog` 在剥掉守卫的副本上仍判红。⇒ 本改动新加的 `[ ! -e "$WATCHDOG_VERDICT" ]` 既没改守卫的判词、也没把已被守卫判死的轮次藏起来。
- **本仓自己的 pin 文件**对改后的脚本整跑：`bash scripts/test.sh --test-concurrency=6 server/shared/tests/quay-test-script.test.ts` → rc=0（67s，`# tests 1 / # pass 1 / # fail 0`）。该文件里正是 `e2e-lane AC1/AC2/false-form` 三个 pin 与其余计数 pin ⇒ 新分支没有改变任何 pin 依赖的形状。

**(d) 单元计数与窗口**：最终 blob 的第 3 节 6 轮复跑里，覆盖本改动那条 lane 的 pin 文件 `server/shared/tests/quay-test-script.test.ts`（`e2e-lane AC1/AC2/false-form` 三个 pin 就在其中）每轮恰好一行 `__PERFILE__`、且 6/6 轮为 `passed=true` —— 即重判既没有把单元跑丢、也没有把它跑两次。

### 5. AC6：改动没有落在并发度上

`$CONCURRENCY`、夹取、自适应上限公式、watchdog 阈值全部未动，池内并发度前后同为 16。吞吐代价读数（整轮墙钟）：修复前 179/183/178/178/193s（均 182.2s，最短 178s 最长 193s，n=5） → 最终 blob 181/180/178/180/180/178s（均 179.5s，最短 178s 最长 181s，n=6）。绿轮不发生任何重判 ⇒ 代价为 0；只有某个单元真的在并发下红了，才多付**该单元单独跑一次**的墙钟（观测到的量级：服务端文件 10s / 66s，e2e lane 7.6-10.4s）。重判发生在 `wait` 之后/其余 lane 收集之后 —— 没有兄弟文件、静态 stage 或客户端 vitest 与它并发，因此它自己不参与池内竞争，也不把池内墙钟推高；且 `$WATCHDOG_VERDICT` 一旦存在就**不再重判**，watchdog 已经判死的轮次不会为一次重判多付时间。

### 6. AC8：生产默认值与 :3001

- `VOICE_REALTIME_SILENCE_TAIL`：本会话环境**未设置**（`env | grep VOICE_REALTIME` 只有 `VOICE_REALTIME_CAPTURE=on`）；代码里它是部署开关、**默认关**（`server/index.ts:588`，常量在 `server/modules/voice-realtime/voice-realtime-silence-tail.ts:147`）。本次未改任何生产默认值（第 7 节：diff 只有 `scripts/test.sh`）。
- `:3001`：监听进程 pid=**366403**（`ss -ltnp`），`ps -o lstart=` = `Tue Oct 13 12:56:54 2026`；23:20:26 读到的 etime=**10:23:31**（≈10.4h），与本会话早先读到的是**同一个 pid** ⇒ 从会话开始到落地**全程未重启**。

### 7. AC7：改动面清单

`git diff --name-only $(git merge-base develop HEAD)..HEAD` → **只有 `scripts/test.sh` 一个文件**（stat 见第 0 节）。本任务文件（`tasks/gap-fan-in-suite-load-flake-one-per-run.md`）由 Provider ABI（`quay task edit` / `task_write`）写在 store 分支上，不占本分支 diff；`## Touches` 里的两个 provider 测试文件**未改**（第 1 节已说明为何不在这条路上）。

## DoD

在 fan-in 同量级并发下，suite 连续 ≥5 轮 `# fail 0`；绿的来源是根因被定位并修正（测试采样点 / 产品时序 / 套件并发与拆卸），不是断言被删弱或并发被无理由压低；根因判据由读数支撑而非推断。

## Touches

- server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts
- server/modules/providers/tests/claude-resident-unattended-turn.test.ts
- scripts/test.sh
- tasks/gap-fan-in-suite-load-flake-one-per-run.md

## Notes

**为什么 Touches 含 `scripts/test.sh`**：若根因是套件并发/拆卸压力，最小改动面在套件驱动侧而非被测文件。若第一步判定根因在产品侧，按 AC5 停下并扩 Touches。

**不做**：不重启服务；不改生产默认值；不为凑绿删弱任何断言。

## 完成记录（2026-10-13，worker，分支 task/gap-fan-in-suite-load-flake-one-per-run）

根因判定 (iii) 套件并发/拆卸压力（读数与 (i)/(ii) 排除依据见 `## Evidence` 第 1 节；AC5 的产品侧条件未成立，未越界改任何产品文件）。最小改动面落在套件驱动侧、只动一个文件：`scripts/test.sh` 在**两个记录点**上执行同一条规则 —— 一个单元（服务端池内文件 / e2e lane）在并发下红了，就在它独自运行时重判一次，**只记录独自运行的结论**；单跑也红就仍然红（fail-closed，仓库自己的 `e2e-lane AC2` `exit 1` pin 仍红）。零断言删弱，`$CONCURRENCY` 与生产默认值未动，`QUAY_TEST_RERUN_RED_FILES=0` 可逐字恢复旧行为。

复验：最终 blob（`2abd10782340d2edd3b8f98979f0239042c2221f`）下 `bash scripts/test.sh --test-concurrency=16` 连续 6 轮全绿（第 3 节）；机制与 fail-closed 方向由两套烟测 A/B/C、`suite-infra-attribution-check.sh` / `suite-hang-watchdog-check.sh` 两个 CHECK PASS、以及仓库自己的 pin 文件整跑 rc=0 举证（第 4 节）。8/8 AC 已通过 ABI 勾选。
