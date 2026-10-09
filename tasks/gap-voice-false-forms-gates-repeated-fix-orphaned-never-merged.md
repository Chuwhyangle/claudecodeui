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

- [ ] AC1 自测：`bash scripts/test.sh --for-task gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged` → 退出码 0，输出含 `# fail 0`。
- [ ] AC2 只剩一个重用例，且在 classification 文件里：`grep -hc 'repository gates still exit 0' server/modules/voice/tests/voice-capture-{audio,isolation,off,secrets,text}.false-forms.test.ts server/modules/voice/tests/voice-error-classification.false-forms.test.ts server/modules/voice/tests/voice-error-contract.false-forms.test.ts | awk '{s+=$1} END{print s}'` = `1`；`grep -c 'repository gates still exit 0' server/modules/voice/tests/voice-error-classification.false-forms.test.ts` = `1`。
- [ ] AC3 其余 6 个文件各有一个替代用例：`grep -c 'the named criteria exist and are collected by the suite' <文件>` 对 audio/isolation/off/secrets/text/contract 均为 `1`。
- [ ] AC4 5 条套件覆盖不到的命令仍在被真实执行（真实 `spawn`，非 mock），合并用例不再自己跑 typecheck/lint：classification 文件内 `grep -c` 命中 `asr-dashscope-omni-check.mjs`、`asr-contract-invariants-check.mjs`、`asr-dashscope-omni-check.test.mjs`、`asr-contract-invariants-check.test.mjs`、`vitest` 各 ≥1；合并用例所在代码块内 `'typecheck'|'lint'` 字面量计数为 `0`。
- [ ] AC5 没有命令被悄悄丢掉：改动前（当前 HEAD）与改动后，7 个文件里全部 `server/…*.test.ts`、`scripts/…*.m?js` 路径引用集合，`comm -23 <改动前> <改动后>` 无输出。
- [ ] AC6 `d5f7904b` 的 pid 归因机制与变异/残留用例未被触碰或削弱：改动前后，`OWN_TEMP_SUFFIX`/`isTempCopy`/`isOwnTempCopy`/`snapshotDelta` 四个符号在各文件的出现次数相等；`gained nothing` 用例计数、`the unmutated copy is green and the mutation reds` 用例计数逐文件相等。
- [ ] AC7 `1fe9714d` 的失败归因修复未被触碰或削弱：该 commit 改过的断言/文案在改动后 diff 中保持不变（非本任务 Touches 范围内的回归）。
- [ ] AC8 速度界限（相对改动前，本机实测，留足余量）：对 audio/isolation/off/secrets/text/contract 六文件单独执行墙钟 ≤15s；classification 文件单独执行墙钟 ≤75s（沿用原任务 owner 授权的界限，因 AC4 强制保留的 `node --test scripts/asr-dashscope-omni-check.test.mjs` 单独约 60s 不可压缩）。
- [ ] AC9 范围受控：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`；不新增文件（`git diff --name-status … | awk '$1=="A"' | wc -l` = `0`）。
- [ ] AC10 `npm run typecheck` → 退出码 0；`npm run lint` → 退出码 0。

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