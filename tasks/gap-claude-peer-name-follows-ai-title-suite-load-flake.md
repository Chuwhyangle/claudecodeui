---
id: gap-claude-peer-name-follows-ai-title-suite-load-flake
title: claude-peer-name-follows-ai-title 在 fan-in suite 并发负载下红（单跑 4/4
  全过，registered=undefined）：定位测试侧等待 vs 产品侧注册竞态并修到负载下可复现地绿
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

`server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` 在 fan-in 全量 suite 的并发负载下会红一次，而在**单文件单跑时连续 4 次全过**。它已经**两次**因为这类竞态被改过（`853ff24b test(claude): assert the freeze where it is, not where the design assumed`、`3121b5b0 test(claude): read the control's registry while the launch is still held`），但竞态仍在。

**实测证据（2026-10-13）**：

- fan-in suite（worktree `gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop`，run `wk-prod-anchor`）：`# tests 534 / # pass 533 / # fail 1`，唯一失败即本文件，判词
  `AssertionError [ERR_ASSERTION]: a process handed a title registers it — the registry is not what freezes (registered=undefined handedOver="AC171 Later 65f5c8cb")`。
- 同一文件在**主检出单跑**：`npx tsx --tsconfig server/tsconfig.json --test <file>` 连续 4 次 `ℹ pass 1 ℹ fail 0`（约 11.7 s 一次）。
- suite 日志里该腿与大量 lane 并发（`__PERFILE__ ... end_ms=` 交错），符合负载相关竞态而非确定性缺陷。

**为什么必须有人认领**：它已经**实际阻断了一条无关任务的落地** —— `gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop` 因连续 3 次 fan-in 被这一条红挡住，被标 `needs-human`，而该任务自身 6/6 AC 早已达成、其 delta 只涉及一个 Playwright spec（fan-in suite 本就不含 Playwright 腿）。该文件原先的所有者任务 `gap-claude-peer-name-follows-ai-title` 与 `gap-claude-peer-name-title-guard` **均已 done**，故当前**无任何在飞任务承载这个 flake**。

**断言读的是 `registered=undefined`**：即读注册表时那一项还没落进去。这既可能是**测试侧的等待/采样点**问题，也可能是**产品侧注册时序**问题 —— 本任务的第一步就是把这两者分开，不预设。

## Plan

1. 先复现并**定位侧别**：在受控并发下重跑（同一命令、并发数可调），把 `registered=undefined` 出现的条件缩小到「测试读得太早」还是「产品真的没注册」。禁用「加长 sleep」这类掩盖手段作为结论。
2. 若为**测试侧**：把采样点改成对**可观测事实**的等待（等到注册表出现该项、或有界超时后明确报出未出现），而不是固定延时；保留现有断言的语义强度，不得为了让 suite 变绿而删弱断言。
3. 若为**产品侧竞态**：停在本任务、写明根因与需要改的产品文件，把 Touches 扩到该文件后再继续 —— ⛔ 不得在未声明 Touches 的情况下改产品文件（anti-drift 会红，且属越界）。
4. 复验：单跑 ≥5 次全过；**在 suite 并发负载下**重跑本文件并给出读数（这是本任务真正的判据，单跑全过不能作为结论）。
5. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [ ] AC1 给出定位侧别的证据：同一命令在受控并发下重跑 ≥5 次，逐次记录 `registered` 读数与并发度；据此判定是测试侧等待还是产品侧时序，并把判据写进 `## Evidence`。
- [ ] AC2 假形态：若结论是「测试侧读得太早」，必须给出**未修复前**能稳定读出红的命令与读数（不是靠运气碰到的一次）。
- [ ] AC3 修复后单跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` ≥5 次，逐次 `pass 1 / fail 0`。
- [ ] AC4 **负载下复验**：在与 fan-in 同量级的并发下重跑该文件，连续 ≥3 次全过；给出命令、并发度与逐次读数。⛔ 只给单跑读数不算满足本条。
- [ ] AC5 断言语义未被删弱：`## Evidence` 列出改动前后的断言文本逐条对照，说明保住了哪条保证（不得以减少断言数量或放宽比较来换绿）。
- [ ] AC6 若判定为产品侧竞态：本任务停在 `needs-human` 并写明根因与建议改动的产品文件；⛔ 不得在 Touches 之外改产品文件。
- [ ] AC7 只改本任务声明的文件：`git diff --name-only <fan-in 基线>..HEAD` 只含 Touches 所列文件与本任务文件。

## DoD

该腿在 suite 并发负载下可复现地变绿（不是靠单跑全过），且绿的原因是采样/时序被修正到可观测事实上，而不是断言被删弱；若根因在产品侧，则根因与所需改动被写清并停在该处等裁定。

## Touches

- server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts
- tasks/gap-claude-peer-name-follows-ai-title-suite-load-flake.md

## Notes

**为什么只列测试文件**：目前证据只指向这一条断言；若第一步定位到产品侧，按 AC6 停下并扩 Touches，不越界改文件。

**不做**：不动 suite 的并发度配置（那是全局取舍，不属本任务）；不改任何生产默认值；不重启服务。