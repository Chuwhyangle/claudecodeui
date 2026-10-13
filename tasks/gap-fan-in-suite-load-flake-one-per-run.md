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

- [ ] AC1 ≥5 轮受控并发复跑的逐轮读数（失败文件、判词、`# fail`、墙钟、并发度）写入 `## Evidence`，并据此判定 (i)/(ii)/(iii)，说明排除了另两类的依据。
- [ ] AC2 假形态：给出未修复前**可稳定复现**红的命令与读数（固定并发度 + 固定轮数，红 ≥N 次）；`## Evidence` 写出该读数。
- [ ] AC3 修复后在与 fan-in 同量级并发下连续 **≥5 轮** suite `# fail 0`，逐轮给出计数与墙钟。⛔ 只给单文件单跑读数不算满足。
- [ ] AC4 断言语义零删弱：`## Evidence` 列出所有被改文件的断言前后对照；若含 skip/注释掉用例/放宽比较 ⇒ 红。
- [ ] AC5 若判定为产品侧竞态且修复需要改 Touches 之外的**产品**文件：停在 `needs-human`，写明根因、建议改动的文件与理由，⛔ 不越界改文件。
- [ ] AC6 若改动落在套件并发度：必须给出吞吐代价读数（修复前后各一轮 suite 墙钟）并说明为何这是必要代价。
- [ ] AC7 只改本任务声明的文件：`git diff --name-only <fan-in 基线>..HEAD` 只含 Touches 所列文件与本任务文件。
- [ ] AC8 不改任何生产默认值（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（前后 pid 相同，写出读数）。

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