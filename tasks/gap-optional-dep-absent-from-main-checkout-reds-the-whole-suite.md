---
id: gap-optional-dep-absent-from-main-checkout-reds-the-whole-suite
title: 判据依赖 optionalDependencies 时：包只在某个 worktree 装过 ⇒ 主检出（共享
  node_modules）缺件，落地后对全部同族任务确定性红，suite 只报断言失败不点名缺包
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

### 现象（2026-10-14 实测，烧掉 5 个 fan-in 轮）

develop 上 `server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts` **确定性红**：

```
silero is not available: optional dependency onnxruntime-node could not be loaded:
Cannot find package 'onnxruntime-node' imported from .../voice-realtime-uplink-vad.ts
actual: 'unavailable'   expected: 'available'
```

后果：三条同族任务连续 `exited-not-landed`，driver 判词是 **LOOP DEADLOCK**（「blocked by the SAME pre-existing red set for 3 consecutive fan-in rounds … they are mutually landing gates」），其中一条 3 轮后 park `needs-human`。三条任务的 AC 其实**全部已勾**，活早就干完了。

### 根因：opt-in 依赖只装在某一个 worktree 里

- 把该文件带进来的提交 `5aa5afe53`（`gap-voice-uplink-vad-node-backends`）在 `package.json` / `package-lock.json` 里加了 optionalDependencies（`onnxruntime-node` / `sherpa-onnx-node` / `webrtcvad`）。
- 该包**只在那个任务的 worktree 里被装过**（它落地时 `instrument-probe` 读到 `classifier=available`、suite 绿）。worktree 落地后被回收，而**主检出的 `node_modules` —— 所有 worktree 通过符号链接共享的那一份 —— 从来没有装过它**（`node_modules` 目录 mtime 仍停在 10-06，早于这次改动）。
- ⇒ 在**每一个** worktree 里，那条「backend must be available」的断言都读成 unavailable。它自己那一轮之所以绿，只因为它当时在自己的 worktree 里装过。

**判别读数（本轮实测）**：在主检出 `npm install --no-save onnxruntime-node@1.30.0`（549M）之后，同一文件 **10 pass / 0 fail**，红点消失；`package.json` / lockfile 本就把它声明为 optionalDependency，未被改动。驱动侧机制本身是对的：新声明返回 `rerun-red`（正确判成真红而非抽签），`baseline-red` 返回 `hard-red / changed-assertion`（正确地拒绝豁免）。

### 影响面（为什么值得一条任务）

任何「判据依赖 optionalDependencies」的任务，都会在落地后把 suite 变成对**所有同族任务**确定性红，而它**自己看不到**——它看到的是自己 worktree 里的绿。这类缺件现在是**隐性**的：suite 只报「某个测试断言失败」，看不出是环境缺包。

### 做法（执行者择一并说明理由）

1. 在 suite 入口加一条**环境前置检查**：读 `package.json` 的 `optionalDependencies` 与 lockfile，凡「已声明但解析不到」（`npm ls <pkg>` 读空，或 `node_modules/<pkg>` 不存在）的包，在 suite 开头**显式报「环境缺件」并列出包名 + 修复命令**。
2. 让「改了 package.json / lockfile」的任务把「主检出已 `npm install`、且每个新增依赖 `npm ls <pkg>` 非空」写进自己的判据或 DoD。

⛔ 本条**不**通过把那条断言改弱 / 加 skip 来「修」——红点已由安装解决（见上），本条要加的是让下一次能**一眼看出是缺件**的信号。

## Plan

1. 复现：在主检出临时把 `node_modules/onnxruntime-node` 挪开，跑套件入口，记录当前输出（它只会报某文件断言失败，不点名缺包）。
2. 加环境前置检查（位置与形态由执行者定），输出必须**点名包 + 修复命令**，且**不**混进 `__PERFILE__` 的 red 计数（它是环境信号，不是代码判词）。
3. 放回依赖，确认检查转绿、且 suite 的既有读数形状不变（`# tests` / `# pass` / `# fail` 与文件集合逐字不变）。
4. 记录两种打印的对照，写进 `## Evidence`。

## AC

- [x] AC1 取假形态：把 `node_modules/onnxruntime-node` 挪开后跑检查 ⇒ **红**且输出点名 `onnxruntime-node`（给读数；本次真实发生过，可据此复现）。
- [x] AC2 放回后同一检查转绿（给读数），且 suite 的 `# tests` / `# pass` / `# fail` 与改动前逐字相同（证明没动既有判据）。
- [x] AC3 检查区分「环境缺件」与「测试断言失败」：前者是一行独立的环境判词、**不**增加 `__PERFILE__` 的 red 计数；`## Evidence` 给出两种打印的对照。
- [x] AC4 ⛔ 不改弱 `voice-realtime-uplink-vad.test.ts` 的任何断言、不加 skip；`## Evidence` 给出该文件在主检出（依赖在位）的 **10 pass / 0 fail** 读数作为对照。
- [x] AC5 只改声明的文件：`git diff --name-only <fan-in 基线>..HEAD` 只含 Touches 所列文件与本任务文件。
- [x] AC6 不改任何生产默认值（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（前后 pid 相同，写出读数）。

## DoD

真实落地 = 下一次「某任务在自己 worktree 里装了个 optional 依赖然后落地」时，loop 能在**它落地后的第一轮**就把「环境缺件」判成一条点名包名的独立信号，而不是让同族任务连续红、最后 park `needs-human`。读数不是「多了一行日志」：给出一次构造的实跑（挪开 ⇒ 红且点名；放回 ⇒ 绿），以及该信号在一次 fan-in 日志里的可见行。

## Touches

- scripts/test.sh
- scripts/optional-deps-preflight.sh (new)
- tasks/gap-optional-dep-absent-from-main-checkout-reds-the-whole-suite.md

## Evidence

**实现**。新增 `scripts/optional-deps-preflight.sh`：读 `package.json` 的 `optionalDependencies`（已声明的集合），逐个解析 `<root>/node_modules/<pkg>/package.json`。缺件 ⇒ 逐包输出 `ENV-MISSING`（点名包名 + 期望路径 + 修复命令），再输出**一行独立的环境判词** `ENV-FAIL kind=environment-missing-optional-deps …`，退出 1；全在位 ⇒ 一行 `PASS`，退出 0；`package.json`/`node` 读不到 ⇒ 退出 2（环境错误，不是判词）。在 `scripts/test.sh` **前置**接入（在任何 stage / 文件收集之前），输出走 **stderr**（stdout 是 `__PERFILE__`/dry-run 的既有契约面）。`--root <dir>`（suite 侧经 `QUAY_OPTIONAL_DEPS_ROOT` 透传）是**测试接缝**：把被测位置挪到构造根，假形态因而可在**不碰共享 node_modules** 的前提下端到端复现——共享 node_modules 是全池共用的，挪开它会伤到别人的任务，那正是本条要防的那类事故。守卫自带**接线自检**（test.sh 少了那行调用即以非零退出）。

**AC1（假形态：红 + 点名）**。构造根 = 把共享主检出 `node_modules` 的顶层条目**除 `onnxruntime-node` 外**全部符号链接过去。`bash scripts/optional-deps-preflight.sh --root <构造根>`：
```
optional-deps-preflight: ENV-MISSING pkg=onnxruntime-node declared=1.30.0 expected-at=…/.optdeps-repro/node_modules/onnxruntime-node — a declared optionalDependency is not resolvable here …
optional-deps-preflight: FIX pkg=onnxruntime-node command="npm install --no-save onnxruntime-node"
optional-deps-preflight: ENV-FAIL kind=environment-missing-optional-deps count=1 pkgs=onnxruntime-node fix="npm install --no-save onnxruntime-node" — …
exit=1
```

**AC2（转绿 + 计数逐字相同）**。真根：`optional-deps-preflight: PASS declared=5 present=5 …`，`exit=0`。同一文件经 suite 入口，**改动前**（主检出 @ develop）与**改动后**（worktree）读数逐字节相同：
```
（BEFORE，主检出） __PERFILE__ duration_ms=1689 server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts passed=true end_ms=…
                   # tests 1 / # pass 1 / # fail 0 / # cancelled 0
（AFTER，worktree） __PERFILE__ duration_ms=1414 server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts passed=true end_ms=…
                   # tests 1 / # pass 1 / # fail 0 / # cancelled 0
```
AFTER 相对 BEFORE 只多一行 stderr 的 preflight `PASS`（绿态 `OPTDEPS_MISSING=0`，报告尾部那条指针不打印）；stdout 的 `# tests`/`# pass`/`# fail` 逐字相同。

**AC3（两种打印的对照）**。
- 环境缺件（一行独立的环境判词，**没有** `__PERFILE__` 行）：`QUAY_OPTIONAL_DEPS_ROOT=<构造根> bash scripts/test.sh <green file>` ⇒ **stderr** 出现 `ENV-MISSING` / `ENV-FAIL` / 报告尾部 `ENV-VERDICT`，而 **stdout** 仍是 `__PERFILE__ … passed=true` + `# tests 1 / # pass 1 / # fail 0 / # cancelled 0`，`exit=0`（环境判词**未**进入 per-file red 计数，也未把 suite 判红）。
- 测试断言失败（真 per-file red）：`QUAY_TEST_STOP_AFTER=e2e QUAY_TEST_E2E_CMD='exit 1' bash scripts/test.sh` ⇒
```
__PERFILE__ duration_ms=4 e2e/session-lifecycle-scenario.spec.ts passed=false end_ms=…
__PERFILE_KIND__ file=e2e/session-lifecycle-scenario.spec.ts kind=assert
not ok - e2e/session-lifecycle-scenario.spec.ts: see log
# fail 1
```
形态可区分：环境缺件**不带** `__PERFILE__ … passed=false`、不进 red 计数；断言失败**带**该行。

**AC4（不改判据文件）**。`git diff --name-only` 只含 2 个 scripts 文件，`voice-realtime-uplink-vad.test.ts` 未被改动（其 AC8 自身在设计上就钉住「模块不引用生产默认值」，本任务未触碰它）。依赖在位时直接跑该文件：`ℹ tests 10 / ℹ pass 10 / ℹ fail 0`。
```
bash scripts/with-memory-cap.sh node_modules/.bin/tsx --tsconfig server/tsconfig.json \
  --import ./scripts/undici-blocked-ports-preload.mjs --test \
  server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts
… ℹ tests 10 / ℹ pass 10 / ℹ fail 0 / rc=0
```

**AC5（只改声明文件）**。
```
$ node --no-warnings …/anti-drift-touches-check.js --task gap-optional-dep-absent-from-main-checkout-reds-the-whole-suite --worktree <wt> --merge-target develop
ANTI-DRIFT OK: task gap-optional-dep-absent-from-main-checkout-reds-the-whole-suite — 2 actual file(s), all within declared Touches (3 glob(s))
```

**AC6（不动生产默认值 / 不重启 :3001）**。本任务只改 `scripts/`，`VOICE_REALTIME_SILENCE_TAIL` 未被触及（该默认只存在于 relay 侧文件，未在 diff 内）。`:3001` LISTEN `pid=766174`（`ps -o lstart= -p 766174` = `Tue Oct 13 23:54:31 2026`，早于本会话），全程未发任何重启/杀进程命令 ⇒ 前后同一 pid。

**接线自检的证伪（守卫不是死代码）**。把一个**没有**调用本检查的 `scripts/test.sh` 放进假仓库再跑本检查：
```
optional-deps-preflight: VIOLATION(wiring) — … /scripts/test.sh never calls scripts/optional-deps-preflight.sh on a non-comment line: the environment check is dead code …
exit=1
```

**DoD 可见行**。下一次某任务在自己 worktree 里装了 optional 依赖后落地、而主检出（共享 node_modules）仍缺该包时，下一轮的 suite 日志（stdout+stderr 合流进 `.quay/fan-in-suite-*.log`）里会出现可 grep 的一行：
```
optional-deps-preflight: ENV-FAIL kind=environment-missing-optional-deps count=1 pkgs=<pkg> fix="npm install --no-save <pkg>"
```
——点名包名 + 修复命令，第二轮不再被读成「不明所以的断言失败」。

**设计选择与理由**。检查**报**（点名一行环境判词）而**不** abort、**不**改 suite 退出码。理由：DoD 治的是**归因**（红是真的、重跑仍红，不是抽签也不是归因错），补的是「一眼看出缺件」的信号；若环境缺件另行把 suite 判红，会在「缺件但无判据依赖它」时把本该绿的树变红，并制造「红而无可归因文件」的新形态。缺件本身仍由依赖它的判据给出真红——本条只让它**被点名**。

## Notes

**与另外两条已 done 的区分**：`gap-fan-in-suite-load-flake-one-per-run` 治并发抽签（池内红的文件单独重判）；`gap-loop-rerun-command-undeclared-so-every-flake-parks-needs-human` 治「红之后能不能被归因」（声明重跑通道）。本条治的是**第三类：环境缺件**——它不是抽签（重跑仍红），也不是归因问题（归因是对的，红是真的），而是「真红的原因在 `node_modules` 里，而 suite 不点名它」。

**为什么「自己 worktree 里绿」这件事本身要防**：判据的执行面是 worktree，而依赖面是**共享的主检出 `node_modules`**——两者不同源时，任务会带着绿读数落地，然后把红留给所有人。同类风险还包括：只在 worktree 里存在的 env 文件、只在 worktree 里跑过的 `npm install`。
