---
id: gap-optional-dep-absent-from-main-checkout-reds-the-whole-suite
title: 判据依赖 optionalDependencies 时：包只在某个 worktree 装过 ⇒ 主检出（共享
  node_modules）缺件，落地后对全部同族任务确定性红，suite 只报断言失败不点名缺包
status: todo
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

- [ ] AC1 取假形态：把 `node_modules/onnxruntime-node` 挪开后跑检查 ⇒ **红**且输出点名 `onnxruntime-node`（给读数；本次真实发生过，可据此复现）。
- [ ] AC2 放回后同一检查转绿（给读数），且 suite 的 `# tests` / `# pass` / `# fail` 与改动前逐字相同（证明没动既有判据）。
- [ ] AC3 检查区分「环境缺件」与「测试断言失败」：前者是一行独立的环境判词、**不**增加 `__PERFILE__` 的 red 计数；`## Evidence` 给出两种打印的对照。
- [ ] AC4 ⛔ 不改弱 `voice-realtime-uplink-vad.test.ts` 的任何断言、不加 skip；`## Evidence` 给出该文件在主检出（依赖在位）的**10 pass / 0 fail** 读数作为对照。
- [ ] AC5 只改声明的文件：`git diff --name-only <fan-in 基线>..HEAD` 只含 Touches 所列文件与本任务文件。
- [ ] AC6 不改任何生产默认值（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（前后 pid 相同，写出读数）。

## DoD

真实落地 = 下一次「某任务在自己 worktree 里装了个 optional 依赖然后落地」时，loop 能在**它落地后的第一轮**就把「环境缺件」判成一条点名包名的独立信号，而不是让同族任务连续红、最后 park `needs-human`。读数不是「多了一行日志」：给出一次构造的实跑（挪开 ⇒ 红且点名；放回 ⇒ 绿），以及该信号在一次 fan-in 日志里的可见行。

## Touches

- scripts/test.sh
- scripts/optional-deps-preflight.sh (new)
- tasks/gap-optional-dep-absent-from-main-checkout-reds-the-whole-suite.md

## Notes

**与另外两条已 done 的区分**：`gap-fan-in-suite-load-flake-one-per-run` 治并发抽签（池内红的文件单独重判）；`gap-loop-rerun-command-undeclared-so-every-flake-parks-needs-human` 治「红之后能不能被归因」（声明重跑通道）。本条治的是**第三类：环境缺件**——它不是抽签（重跑仍红），也不是归因问题（归因是对的，红是真的），而是「真红的原因在 `node_modules` 里，而 suite 不点名它」。

**为什么「自己 worktree 里绿」这件事本身要防**：判据的执行面是 worktree，而依赖面是**共享的主检出 `node_modules`**——两者不同源时，任务会带着绿读数落地，然后把红留给所有人。同类风险还包括：只在 worktree 里存在的 env 文件、只在 worktree 里跑过的 `npm install`。
