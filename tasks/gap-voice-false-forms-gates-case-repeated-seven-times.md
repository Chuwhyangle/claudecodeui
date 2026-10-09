---
id: gap-voice-false-forms-gates-case-repeated-seven-times
title: 7 个 voice false-forms 文件各有一个「…and the repository gates still exit
  0」用例，各自串行重跑同一批兄弟判据、typecheck、lint，合计约 373s（server 阶段 139s
  的长杆）：合并为一次，套件已覆盖的改成「存在且被套件收集」的廉价断言
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象（台账 + 保留日志的逐用例耗时）**：2026-10-06 11:32Z 那轮全量绿里，server 阶段跨度 139s，**恰好等于最长的单个文件** `voice-error-classification.false-forms.test.ts`（139s）——LPT 排序已把它放到最前，下界不再是排队而是它自己。9 个 voice `false-forms` 文件的逐用例读数（来自保留日志，16 路并发下）显示，时间几乎全落在每个文件里**唯一的一个**用例上：

| 文件 | 那个用例 | 耗时 |
|---|---|---|
| `voice-error-classification.false-forms` | AC7 the criteria, the check scripts and the repository gates still exit 0 | **140.1s** |
| `voice-capture-secrets.false-forms` | AC10 the eight criteria and the repository gates still exit 0 | 48.6s |
| `voice-error-contract.false-forms` | AC6 the existing criteria and the repository gates still exit 0 | 41.6s |
| `voice-capture-audio.false-forms` | AC8 the seven criteria and the repository gates still exit 0 | 37.2s |
| `voice-capture-isolation.false-forms` | AC8 the seven criteria and the repository gates still exit 0 | 37.2s |
| `voice-capture-text.false-forms` | AC10 the six criteria and the repository gates still exit 0 | 35.5s |
| `voice-capture-off.false-forms` | AC6 the existing criteria and the repository gates still exit 0 | 32.5s |

合计 **372.7s，占 9 个文件用例耗时总和 388s 的 96%**；真正的变异用例都不超过 0.2s。这约占台账该轮 server 阶段 Σ 约 1445s 的四分之一。

**机制**：每个这样的用例用 `spawnSync` **串行**跑一份命令清单——兄弟判据（逐个 `npx tsx --tsconfig server/tsconfig.json --test <文件>`，这些文件本身都被套件收集、本来就会跑）、`npm run typecheck`（约 15s）、`npm run lint`（约 9s）（二者本来就是套件的两个静态阶段），以及**套件覆盖不到的 5 条**（在 `voice-error-classification.false-forms` 的 `AC7_COMMANDS` 里）：`node scripts/asr-dashscope-omni-check.mjs`、`node scripts/asr-contract-invariants-check.mjs`、`node --test scripts/asr-dashscope-omni-check.test.mjs`、`node --test scripts/asr-contract-invariants-check.test.mjs`、`npx vitest list src/shared/asr/tests/asrContractInvariants.test.ts`——`scripts/` 这条线（`npm run test:scripts`）不在 fan-in 套件里，所以这 5 条只有这里在跑，**不能直接删**。同一份清单在 7 个文件里各重复一遍。副作用：一个类型错误会同时让 `typecheck` 阶段和这 7 个文件都红（22:36Z 那轮 1 个 typecheck 红连带 7 个 false-forms 红，共 8 个）。

**改动（只改这 7 个文件）**：
1. **盘点**：逐个列出 7 个用例各自清单里的每条命令，并给处置——(S) 套件静态阶段已覆盖（`typecheck`、`lint`）：删除；(C) 套件已收集的测试文件：改成廉价断言；(K) 套件覆盖不到：保留。
2. **一次合并**：把 (K) 命令去重后，只在 `voice-error-classification.false-forms.test.ts` 里保留的那个用例（沿用其用例名）里运行**一次**，用异步 spawn、并发不超过 4，保留现有的非空判据（tally / markers / 退出码）与 `optional` 处理。子进程读数放在 false-forms 文件里是既有约定（判据文件自身零子进程）。
3. **其余 6 个文件**：把重用例换成纯进程内的廉价用例，名字固定为 `AC<n> the named criteria exist and are collected by the suite`：对原清单里每个 (C) 路径，断言 `fs.existsSync` 且出现在套件的收集集合里（与 `scripts/test.sh` 同一个 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules` 表达式）。
4. **不新增测试文件**：`server/shared/tests/quay-test-script.test.ts` 固定了服务端测试文件总数，新增一个文件会让它整片变红。
5. **保持不变**：全部变异用例；各文件的残留检查用例（按 pid 归属）；临时副本前缀约定 `__criterion-falsify-<tag>-…`。

**不做**：不新增任何文件；不改非 false-forms 的判据文件、`voice-capture.ts`；不改 `package.json`、`scripts/test.sh`、`quay-test-script.test.ts`；不新增 `scripts/*.mjs`；不去做跨进程共享 typecheck 缓存。

**已知约束（来自本仓记忆）**：这批 false-forms 共用 `server/modules/voice/tests/` 一个目录，变异副本写在同目录，各文件的残留检查靠 pid 归属避免互相误报——合并用例只 spawn 命令、不创建副本，不要碰这套约定。

<!-- dedup-ref -->相关但机制不同：`gap-voice-error-classification-ac7-vitest-child-fragile`（已完成并已落地：把 AC7 里会拉起独立 vitest 的那一条改成 `vitest list`）；`gap-suite-server-dispatch-longest-first-and-parallel-static-stages`（已完成并已落地：LPT 派发 + typecheck/lint 并行）；`gap-suite-server-phase-bypass-npx-and-tsx-cli-wrapper`（todo：改 `scripts/test.sh` 的进程链，与本任务无文件重叠）。**本任务自身的实现分支 `task/gap-voice-false-forms-gates-case-repeated-seven-times`（commit `f1a16d6e`）已验证全部 AC/DoD，但 2026-10-09 核实 `f1a16d6e` 不是当前 `develop`/`author` HEAD 的祖先——从未真正合并，是一次 fan-in 落地失败（task 被标 done，代码未到分支）。接手任务见 `gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged`，复用本任务已验证过的设计，在当前 HEAD 上重做并真正落地。本任务保留原状不动（status/AC 不改），仅在此补记发现。**

## AC

- [x] AC1 自测（Touches 含 `*.test.*`，`suite-scope-check.sh` 要求带 `--for-task`）：`bash scripts/test.sh --for-task gap-voice-false-forms-gates-case-repeated-seven-times` → 退出码 0，输出含 `# fail 0`。
- [x] AC2 只剩一个重用例，且在 classification 文件里。
- [x] AC3 其余 6 个文件各有一个替代用例。
- [x] AC4 套件覆盖不到的 5 条仍在被执行，且合并用例不再自己跑 typecheck/lint。
- [x] AC5 没有命令被悄悄丢掉。
- [x] AC6 变异用例与残留用例未被误删。
- [x] AC7 速度界限。
- [x] AC8 范围受控且不新增文件。
- [x] AC9 `npm run typecheck` → 退出码 0，`npm run lint` → 退出码 0。

## DoD

（原文保留，见历史记录；本任务的三项 DoD 读数均在 worktree `/data/home/yale/work/claudecodeui-worktrees/gap-voice-false-forms-gates-case-repeated-seven-times` 的 scoped 读数里完成，但从未经过真实 fan-in 合并进 develop——见上方 2026-10-09 补记。）

## Touches

- server/modules/voice/tests/voice-capture-audio.false-forms.test.ts
- server/modules/voice/tests/voice-capture-isolation.false-forms.test.ts
- server/modules/voice/tests/voice-capture-off.false-forms.test.ts
- server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts
- server/modules/voice/tests/voice-capture-text.false-forms.test.ts
- server/modules/voice/tests/voice-error-classification.false-forms.test.ts
- server/modules/voice/tests/voice-error-contract.false-forms.test.ts
- tasks/gap-voice-false-forms-gates-case-repeated-seven-times.md

## Evidence（完成记录，2026-10-06；worktree `/data/home/yale/work/claudecodeui-worktrees/gap-voice-false-forms-gates-case-repeated-seven-times`，branch `task/gap-voice-false-forms-gates-case-repeated-seven-times`，commit `f1a16d6e`，base `develop`=`98037e4e`）

（原 Evidence 全文保留——盘点表、逐用例前后对照、fan-in 台账占位、放大效应消除、负控、AC7 如实读数——详见 git 历史本文件旧版本或 `git show f1a16d6e:tasks/gap-voice-false-forms-gates-case-repeated-seven-times.md`。）

## 2026-10-09 补记（yale 指令「执行用户授权的性能改进」去重检索时发现）

**发现**：`git merge-base --is-ancestor f1a16d6e HEAD` 在当前 `author` 分支（HEAD 时为 `e204f0631b`）上返回非 0——`f1a16d6e` 不是 HEAD 的祖先。现场核对：`.quay/verification-round.jsonl` round 751（2026-10-09T01:39Z，green）的 `perFile` 里 `voice-error-classification.false-forms.test.ts` 仍读到 161239ms、`voice-capture-secrets.false-forms.test.ts` 仍读到 60452ms 等——与本任务 Evidence 里「改动后 64.39s / 0.82–9.37s」的读数矛盾，证明改动从未到达跑在 develop/author 上的代码。当前 `server/modules/voice/tests/*.false-forms.test.ts` 七个文件仍全部含 `repository gates still exit 0` 字样（`grep -l` 命中全部 7 个），新读数字样 `the named criteria exist and are collected by the suite` 不存在于任何文件——确认是落地失败，不是之后被回滚。

**后续已落地的两个邻接任务**（`d5f7904b` pid 归因、`1fe9714d` AC6 归因修复）都已进入 HEAD 历史，且都改了同一批文件的重叠区域——所以 `f1a16d6e` 不能直接 cherry-pick（会冲突），需要在当前 HEAD 上重新实现同一设计。接手任务：`gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged`（status: ready）。

**未做的事**：本任务的 status/AC 未改动，不去追溯 fan-in 为何没有落地这条 commit（无法在本仓内部断言 fan-in 当时的失败原因，只能确认结果）。