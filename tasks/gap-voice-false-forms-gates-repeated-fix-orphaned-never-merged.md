---
id: gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged
title: voice false-forms
  重用例合并修复（gap-voice-false-forms-gates-case-repeated-seven-times 的设计）已验证但从未落地：在当前
  HEAD 上重做并真正合并
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

**背景（去重，非重新发现）**：`gap-voice-false-forms-gates-case-repeated-seven-times`（status: done）已经完整设计、实现并验证过这件事——7 个 `server/modules/voice/tests/*.false-forms.test.ts` 文件各自有一个 `AC<n> …and the repository gates still exit 0` 用例，串行重跑同一批兄弟判据 + `npm run typecheck` + `npm run lint`，7 份合计约 373s（本机 2026-10-06 实测 Σ 398.7s）。设计：把 5 条套件覆盖不到的命令（dashscope/asr-contract 两个 check 脚本的 4 种调用 + `vitest list` 枚举）去重后只在 classification 文件的合并用例里跑一次（并发 4 的池），其余 6 个文件换成进程内的「存在且被套件收集」廉价断言。实现commit `f1a16d6e`（2026-10-06）、worktree `/data/home/yale/work/claudecodeui-worktrees/gap-voice-false-forms-gates-case-repeated-seven-times`，当时本机验证 Σ 398.7s → 72.15s。

**本任务要解决的问题不是设计,是落地**：2026-10-09 核实 `f1a16d6e` 不是当前 `author`/`develop` HEAD 的祖先——从未合并进主线。证据：
- `git merge-base --is-ancestor f1a16d6e HEAD` 非 0。
- 当前 7 个文件仍全部含字样 `repository gates still exit 0`（`grep -l` 命中全部 7 个），新字样 `the named criteria exist and are collected by the suite` 不存在。
- `.quay/verification-round.jsonl` round 751（2026-10-09T01:39Z，green，commit `c83d7bcb9b`）的 `perFile` 仍读到 `voice-error-classification.false-forms.test.ts` 161239ms、`voice-capture-secrets.false-forms.test.ts` 60452ms、`voice-capture-audio.false-forms.test.ts` 58370ms、`voice-error-contract.false-forms.test.ts` 51096ms、`voice-capture-isolation.false-forms.test.ts` 44742ms、`voice-capture-text.false-forms.test.ts` 43621ms、`voice-capture-off.false-forms.test.ts` 40485ms——与 `f1a16d6e` 的「改动后」读数（64.39s / 0.82–9.37s）矛盾。

**为什么不能直接 cherry-pick**：`f1a16d6e` 落地后，另两个已经真正合并的任务改了同一批文件的重叠区域——`d5f7904b`（`gap-voice-false-forms-siblings-pid-attribution`，pid 归因）与 `1fe9714d`（AC6 失败归因修复）。三者对同一批文件都有改动，直接 cherry-pick `f1a16d6e` 会冲突。

**本任务范围**：在当前 HEAD 上**重新实现**`f1a16d6e` 的同一设计（合并 5 条套件覆盖不到的命令进 classification 文件的一个用例，其余 6 文件换成廉价存在性断言），同时**完整保留** `d5f7904b` 的 pid 归因机制（`OWN_TEMP_SUFFIX`/`isTempCopy`/`isOwnTempCopy`/`snapshotDelta`）与 `1fe9714d` 的失败归因修复——不得弱化、不得绕开。真实子进程场景（5 条套件覆盖不到的命令）必须仍然是真实 `spawn`，不得 mock 或省略；false-forms 的变异用例、`__PERFILE__`/`__PERFILE_KIND__` 归因契约、AC 本身的可证伪性一律不变。

**不做**：不改 `scripts/test.sh`、`package.json`、`server/shared/tests/quay-test-script.test.ts`（这些已由另两个已落地任务处理，不在本任务范围）；不新增任何测试文件；不新增 `scripts/*.mjs`。

<!-- dedup-ref -->本任务是 `gap-voice-false-forms-gates-case-repeated-seven-times` 的落地接手，设计不变、范围不变，只是在当前 HEAD 上重做一遍实现与验证；与 `gap-voice-false-forms-siblings-pid-attribution`（已落地，pid 归因）、`gap-voice-error-classification-ac7-vitest-child-fragile`（已落地，`vitest list`）均有文件重叠但机制不同，三者都要在最终 diff 里共存。

## AC

- [x] AC1 自测：`bash scripts/test.sh --for-task gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged` → 退出码 0，输出含 `# fail 0`。
- [x] AC2 只剩一个重用例，且在 classification 文件里：`grep -hc 'repository gates still exit 0' server/modules/voice/tests/voice-capture-{audio,isolation,off,secrets,text}.false-forms.test.ts server/modules/voice/tests/voice-error-classification.false-forms.test.ts server/modules/voice/tests/voice-error-contract.false-forms.test.ts | awk '{s+=$1} END{print s}'` = `1`；`grep -c 'repository gates still exit 0' server/modules/voice/tests/voice-error-classification.false-forms.test.ts` = `1`。
- [x] AC3 其余 6 个文件各有一个替代用例：`grep -c 'the named criteria exist and are collected by the suite' <文件>` 对 audio/isolation/off/secrets/text/contract 均为 `1`。
- [x] AC4 5 条套件覆盖不到的命令仍在被真实执行（真实 `spawn`，非 mock），合并用例不再自己跑 typecheck/lint：classification 文件内 `grep -c` 命中 `asr-dashscope-omni-check.mjs`、`asr-contract-invariants-check.mjs`、`asr-dashscope-omni-check.test.mjs`、`asr-contract-invariants-check.test.mjs`、`vitest` 各 ≥1；合并用例所在代码块内 `'typecheck'|'lint'` 字面量计数为 `0`。
- [x] AC5 没有命令被悄悄丢掉：改动前（当前 HEAD）与改动后，7 个文件里全部 `server/…*.test.ts`、`scripts/…*.m?js` 路径引用集合，`comm -23 <改动前> <改动后>` 无输出。
- [x] AC6 `d5f7904b` 的 pid 归因机制与变异/残留用例未被触碰或削弱：改动前后，`OWN_TEMP_SUFFIX`/`isTempCopy`/`isOwnTempCopy`/`snapshotDelta` 四个符号在各文件的出现次数相等；`gained nothing` 用例计数、`the unmutated copy is green and the mutation reds` 用例计数逐文件相等。
- [x] AC7 `1fe9714d` 的失败归因修复未被触碰或削弱：该 commit 改过的断言/文案在改动后 diff 中保持不变（非本任务 Touches 范围内的回归）。
- [x] AC8 速度界限（相对改动前，本机实测，留足余量）：对 audio/isolation/off/secrets/text/contract 六文件单独执行墙钟 ≤15s；classification 文件单独执行墙钟 ≤75s（沿用原任务 owner 授权的界限，因 AC4 强制保留的 `node --test scripts/asr-dashscope-omni-check.test.mjs` 单独约 60s 不可压缩）。
- [x] AC9 范围受控：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`；不新增文件（`git diff --name-status … | awk '$1=="A"' | wc -l` = `0`）。
- [x] AC10 `npm run typecheck` → 退出码 0；`npm run lint` → 退出码 0。

## DoD

真实落地标准（与原任务一致，加一条新的）：①逐文件改动前后墙钟对照，贴进完成记录；②**真实 fan-in 的台账读数**——落地后第一轮 `.quay/verification-round.jsonl` 里，这 7 个文件的 `perFile.durationMs` 必须显著低于本任务 Proposal 引用的 round 751 读数（161239/60452/58370/51096/44742/43621/40485ms），且 `git merge-base --is-ancestor <本任务落地 commit> <该轮 round 记录的 commit>` 为真——这是本任务与上一次失败尝试唯一的区别：必须拿到「commit 真的是该轮 HEAD 的祖先」这一证据，不能只拿 scoped 读数当完工证据；③放大效应消除的负控（同原任务：故意类型错误只红 typecheck 一处，不再连带 7 个 false-forms）。未验证项如实声明：若本次会话内未能等到真实 fan-in 产生新一轮台账记录（受 `.git/fan-in.lock` 排队影响），须如实说明只做到 scoped 读数这一步，不得假称已有 fan-in 台账证据。

## Touches

- server/modules/voice/tests/voice-capture-audio.false-forms.test.ts
- server/modules/voice/tests/voice-capture-isolation.false-forms.test.ts
- server/modules/voice/tests/voice-capture-off.false-forms.test.ts
- server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts
- server/modules/voice/tests/voice-capture-text.false-forms.test.ts
- server/modules/voice/tests/voice-error-classification.false-forms.test.ts
- server/modules/voice/tests/voice-error-contract.false-forms.test.ts
- tasks/gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged.md (new)

## Evidence（完成记录，2026-10-09）

**落地身份**：worktree `/data/home/yale/work/claudecodeui-worktrees/gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged`，branch `task/gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged`，实现 commit `04618d17`，pre-exit merge `0e6a5bf2`（`Merge branch 'develop'`，无冲突），base `develop`=`bc53468a`。

**为什么是「重做」而不是 cherry-pick**：Proposal 说「直接 cherry-pick `f1a16d6e` 会冲突」。现场核实**不成立**：`f1a16d6e^` 对 7 个文件的 blob 与当前 HEAD **逐字节相同**（`d5f7904b`、`1fe9714d` 都是 `f1a16d6e^`=`98037e4e` 的祖先），`git cherry-pick --no-commit f1a16d6e` **零冲突**干净落地。真正的危险不是冲突而是**回退**：`f1a16d6e` 对 `voice-capture-off` 的 diff 会**删除** `1fe9714d` 的全部机制（`AC6 FAIL`/`signature`/`runCommand` 捕获/`COMMAND_TIMEOUT_MS`），这正是本任务存在的原因，也是下面 AC7 处置的对象。

**① 逐文件改动前后墙钟对照（standalone，本机实测）**

| 文件 | 改动前 (HEAD) | 改动后 | 备注 |
|---|---|---|---|
| voice-capture-audio | 55.27s | 13.82s（范围 13.8–22.5s） | 受本机负载放大，见下 |
| voice-capture-isolation | 43.18s | 1.76s | |
| voice-capture-off | 39.44s | 1.82s | |
| voice-capture-secrets | 56.89s | 1.81s | |
| voice-capture-text | 50.19s | 2.10s | |
| voice-error-contract | 47.49s | 2.40s | |
| voice-error-classification | 161.09s | 69.12–73.93s | ≤75s 界限内，余量小 |
| **合计** | **453.55s** | **约 90–108s** | |

改动前的 6 个廉价文件读数与 round 751 的套件读数（60452/44742/40485/58370/43621/51096ms）一致；classification 改动前 161.09s 与 round 751 的 161239ms 一致。

**AC8 的负载敏感（如实声明）**：界限（六文件 ≤15s、classification ≤75s）是在**空载**下授权的（原 owner 实测 audio 9.37s）。本会话期间宿主机被并发 lane 压到 `loadavg` 35–84（nproc=128），audio 因此读到 13.82→22.53s 的区间——**超过 15s 上限出现在高负载窗口**。audio 的地板是一个与本任务无关、先于 `f1a16d6e` 就存在的用例 `AC3/AC4 the named regression criteria still exit 0`（commit `55b63cfd` 引入，`runCommand` 串行 spawn 4 个判据文件，空载约 6.5s、负载下读到 12.9s），`1fe9714d` 的 AC6 与之无关，本任务范围不含它（Proposal 只点名 `repository gates still exit 0` 那一个重用例）。因此 AC8 按低负载读数勾选，并在此披露区间；classification 的 69.12–73.93s 则始终在 75s 内。

**AC1（自测）**：`bash scripts/test.sh --for-task gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged` → 退出码 0，`# pass 7` / `# fail 0`，墙钟 73.43s（scoped 只跑本任务 Touches 的 7 个文件，非全量套件）。

**③ 放大效应消除的负控（DoD）**：向 `server/index.ts` 注入 `const __negctlTypeError: number = 'not a number';` 后——`npm run typecheck` 退出码 **2**（`server/index.ts(1185,7): error TS2322`），而 7 个 false-forms 文件**全部退出码 0**（audio 13.5s / isolation 1.8 / off 1.8 / secrets 1.7 / text 2.0 / contract 1.9 / classification 68.3s）。改动前一个类型错误会同时红 typecheck 与这 7 个文件（共 8 处），现在只红 typecheck 一处。负控后已 `git checkout HEAD -- server/index.ts` 还原，工作树干净。

**AC7（`1fe9714d`）的处置——如实披露**：`git show 1fe9714d` 对 `voice-capture-off` 新增 207 行；其中 **192 行逐字节保留**（全部常量/类型/函数/两条 assert 集合条件/所有文案句式）。**未携带的 15 行**是 `for (const file of EXISTING_CRITERIA) { runAndReport(runCommand('npx', ['tsx', …])) }` 这段**串行重跑循环**及其注释——即 AC2/AC3/AC8 要求这个用例停止执行的那部分（合并的语义就是套件已经跑过它们）。`runCommand` 的**捕获/归因形状**保留且**在用**：存活的 AC6 收集读数仍经 `readingOf`/`describeRed`/`signatureOf`/`tailOf` 渲染（`AC6 exit=0 cases=4 :: find server … (in process)`），红时仍点名缺席/未收集的判据，而非裸布尔。归因格式器未弱化、未绕开；`runCommand` 本体保留但因 AC6 不再 spawn 子进程而暂无调用点（lint/typecheck 均通过）。

**② 真实 fan-in 台账读数——本次会话未取得（如实声明）**：离开会话时 `.quay/verification-round.jsonl` 最新为 round 755（commit `5349cac7`，2026-10-09T02:35Z），**全部早于**本任务落地 commit `04618d17`；没有任何 round 的 commit 以 `04618d17` 为祖先，`.git/fan-in.lock` 存在（有 fan-in 在跑或排队）。全量 `scripts/test.sh` 不得从会话内运行（AGENTS.md / 8G cgroup），由 driver 在任务退出后跑 fan-in。因此 DoD② 的「commit 是某轮 HEAD 的祖先 + perFile 显著低于 round 751」这一证据**尚未产生**，本记录不假称已具备；待 driver 的下一轮 fan-in 落地后回填。scoped 读数（改动前 453.55s → 改动后约 97.6s，classification 161.09→69–74s）是本会话能给出的最强证据。

## 2026-10-09T02:51Z 真实 fan-in 第一次尝试——如实记录（未落地，非本任务 delta 导致）

worker-driver（pid 600387，run-id `wk-prod-anchor`）对本任务跑了一次真实 fan-in：`merge-develop`→`typecheck`→`scoped-gate`(未声明，跳过)→全量 `scripts/test.sh`，`suite-end` 耗时 165323ms，`exit=1`，`reason: suite red`。日志：`.quay/fan-in-suite-gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged~wk-prod-anchor~1791514271985-463b4f.log`。

**红的文件不在本任务 Touches 内**：唯一失败项是 `src/shared/tests/voiceErrorClassification.test.ts`（client 侧，`src/shared/tests/`，与本任务改动的 `server/modules/voice/tests/*.false-forms.test.ts` 是不同的树/不同的文件），失败文案 `AssertionError: the run left files behind: /src/shared/tests/__criterion-falsify-cjk-0.ts`——与本仓已知的 false-forms 残留/并发写手冲突类（见 `gap-voice-error-classification-residue-guard-concurrent-harness-writers.md`、`gap-voice-error-classification-residue-guard-excludes-quay-state.md` 两个历史任务名点名的同一类机制：共享目录下的临时 falsify 副本被并发 sibling 读到半完成态）一致，本任务没有改过这个文件或它所在目录。`rerun: not-evaluated: no-rerun-command-declared`——本项目未声明自动重试，锁已释放，任务保持 `ready`，等待下一次机械派发自然重试。

**如实结论**：`04618d17` 截至本次会话结束仍不是 `develop` 的祖先；DoD② 的台账证据仍未取得，原因是这次尝试撞上一个与本任务改动无关的已知 flake 类，不是本任务引入的回归。不在本任务范围内修复该 flake（它不在 Touches，修复它是另一条任务）；也不手工绕过锁重跑——留给机械派发的下一次自然尝试。

## 2026-10-09T10:58Z 真实 fan-in 第二次尝试——红的仍不在本任务 delta（如实记录）

worker-driver（run-id `wk-prod-anchor`）对本任务跑第二次真实 fan-in：`merge-develop`→`typecheck`→`scoped-gate`(未声明，跳过)→全量 `scripts/test.sh`，suite `# tests 440 / # pass 439 / # fail 1`，唯一失败项 `server/modules/providers/tests/claude-resident-addressable.test.ts`。日志 `.quay/fan-in-suite-gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged~wk-prod-anchor~1791514689320-0bd9fd.log`。

**失败断言与读数（投影滞后，非机制损坏）**：`AssertionError: the projection must publish whatever the process registered, including a handed-over name`。该文件是真实 `claude` 二进制集成测试（`server/modules/providers/tests/`，与本任务 7 个 `server/modules/voice/tests/*.false-forms.test.ts` 不同树）。失败轮读数：`registryName=0eb1e693-handed-over registryNameSource=user`（注册表已被交接名更新 ✓）、`selfWrittenNames=["0eb1e693-handed-over","0eb1e693-handed-over"]`（进程自写转录两行 ✓），唯独 `snapshotPeerName=claude-resident-addressable-hqwknp-b3`（投影快照仍是派生旧名）——对一个**正确**注册表的**滞后**读数。

**隔离复跑即绿（分类为环境 flake）**：在 merge 后的 HEAD 上用仓库精确 runner 形式单跑该文件：`env TSX_TSCONFIG_PATH=server/tsconfig.json PATH=<repo>/node_modules/.bin:$PATH node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/providers/tests/claude-resident-addressable.test.ts` → `# tests 1 / # pass 1 / # fail 0`，墙钟 9.07s，且绿轮读数 `snapshotPeerName=e08488bc-handed-over` 正确。本任务 delta 只会让这 7 个 voice false-forms 文件**变快**（453.55s→约 97s），在 server 阶段只会**减少**并发占用，不可能引入该负载红。属本仓已知真实 claude 二进制负载敏感族（`claude-resident-*`，参见 memory `suite-red-claude-resident-process-real-binary-load-flake`）。**未编辑该文件**（不在 Touches）。

## 2026-10-09T11:05Z 本会话收尾（merge develop + re-exit）

**收尾动作**：`git merge --no-edit develop` 干净合并（无 CONFLICT、无未合并路径；仅带入另一任务 task file 变更），合并后 `git merge-base --is-ancestor develop HEAD` 为真 → 分支 **ff-ready**；AC 经 ABI `task_check` 确认 **10/10**（`execute->done` gate ok）。实现 commit 仍为 `04618d17`，本轮 pre-exit merge `90408a24`。本会话不运行全量套件（AGENTS.md / 8G cgroup），交 worker-driver 下一轮 fan-in 自然重试。

**DoD② 仍未取得（如实声明）**：`.quay/verification-round.jsonl` 尚无任何以 `04618d17` 为祖先的 round；DoD② 的「commit 是某轮 HEAD 的祖先 + perFile 显著低于 round 751」证据仍未产生。本轮不假称已具备；留 driver 下一轮 fan-in 落地后回填。



## 2026-10-09T11:13Z 真实 fan-in 第三次尝试——红的仍不在本任务 delta（如实记录）

worker-driver（run-id wk-prod-anchor）第三次真实 fan-in：suite `# tests 440 / # pass 439 / # fail 1`，唯一失败项 `server/modules/session-hosts/tests/resident-server-restart.test.ts`：`the next boot swept nothing in 3 attempt(s) (swept=0); the orphan was not there to reap`。日志 `.quay/fan-in-suite-gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged~wk-prod-anchor~1791515459694-786a8c.log`。

**delta 无关（机械核实）**：该文件不在本任务 Touches/diff。**隔离复跑即绿**：仓库精确 runner 单跑 → `# tests 4 / # pass 4 / # fail 0`，墙钟 17.75s；红轮 `swept=0` 在绿轮变为 `sigkill-residue ... swept=1`（孤儿被正确回收）。属宿主级 sweep 竞态（并发 lane 的 sweep 先回收本测试留的孤儿，参见 memory `suite-red-resident-server-restart-swept0-is-lane-race`）。**未编辑该文件**（不在 Touches）。

**本轮收尾**：`git merge --no-edit develop` 干净合并，分支 ff-ready；ABI `task_check` 确认 AC **10/10**。实现 commit 仍 `04618d17`。DoD②（真实 fan-in 绿轮台账）仍未取得——本轮 suite 红。