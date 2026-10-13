---
id: gap-ac376-spec-relay-mode-expectation-drift
title: AC-376 的 CMD3（两条 e2e spec）在求值 root
  上红：`voice-realtime-live-session-send.spec.ts` 的 `segmentedRelayExpected()` 按原始
  env 重推中继档、把「未设 ⇒ segmented」的旧默认写死，而产品自身解析（`resolveVoiceRealtimeMode`）的默认已翻为
  continuous ⇒ 期望与行为相反（:649 的 `commitCount() >= 1` 读到
  0）。把该期望改为读产品自身的解析结果（或运行自己发布的档）⇒ 两 spec 在 continuous 与 segmented 两种默认下都绿；复验 +
  取假形态
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-376
---
## Proposal

<!-- dedup-ref --> 现网**无任何任务以 `goal_ac: AC-376` 认领**（`grep -l '^goal_ac: AC-376' tasks/*.md` 为空集）。`AC-376` 本身由已 done 的拆段任务 `gap-ac319-criterion-serial-over-driver-spawn-cap-split`（`goal_ac: AC-319`）在本日按闸切链时创建；其 `## Notes` 明写「把 `segmentedRelayExpected()` 从读 env 改成读应用实际解析出的 mode」是「该缺陷真正归属的任务」，却**从未立案**。`task-granularity-advice --touches e2e/voice-realtime-live-session-send.spec.ts --touches server/modules/voice-realtime/voice-realtime-mode.ts` 报 `peers: []`、`mentions: []`，无合并候选。相关但**不同机制 / 不同 AC**：`gap-live-voice-continuous-transport-opt-in`（done，`goal_ac: AC-374`）把 continuous 做成**可选**并明写「默认不变」；本任务的缺陷是**默认已翻之后 e2e 层没跟上**。

### 现状（2026-10-13 复核）

**一句话**：`AC-376` 的判据是 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-live-session-send.spec.ts --workers=1`。它在 **develop 的干净树上全绿**（拆段任务实测 11 passed），但在**驱动实际求值的 root**（`/data/home/yale/work/claudecodeui`；`GOAL-034` 无 `branch: true` ⇒ 判据 cwd = 主检出）上**红且可复现**：该检出带**未提交在途 WIP**（GOAL-044 体验优先裁定）把 `server/modules/voice-realtime/voice-realtime-mode.ts` 的部署默认从 `segmented` 翻成 `continuous`，而 `e2e/voice-realtime-live-session-send.spec.ts` 的**未被改动**的期望助手仍按原始 env 重推**旧默认**。

（读数源 `e2e/voice-realtime-live-session-send.spec.ts:112-113`，逐字）
```ts
function segmentedRelayExpected(): boolean {
  return (process.env.VOICE_REALTIME_MODE ?? '').trim() !== 'continuous';
}
```
（断言 `:648-654`，逐字）
```ts
if (segmentedRelayExpected()) {
  await expect.poll(() => upstream.commitCount(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  expect(upstream.audioFrameCount()).toBeGreaterThan(0);
} else {
  expect(upstream.commitCount()).toBe(0);
  expect(upstream.audioFrameCount()).toBeGreaterThan(0);
}
```
驱动进程 env **无** `VOICE_REALTIME_MODE` ⇒ 助手判 `true`（期待 segmented），而应用按新默认跑 continuous ⇒ 上游从不 `commit` ⇒ `commitCount()==0` ⇒ `:649` 红（拆段任务 Evidence 原文：`Expected: >= 1` / `Received: 0`；`mainRoot` exit 1、干净 worktree exit 0 ⇒ 非抽签、非 flake）。

分裂是**双重的**：助手把旧默认写死（`!== 'continuous'`），而 `playwright.config.ts:2814-2816` 的注释同样仍写「an unset, empty or unknown value resolves to `segmented`」——两处都在默认翻转后变 stale。spec 自己的头部注释却宣称它「resolves the mode exactly as the product does」⇒ 修好助手是**恢复其声明意图**，不是新增约束。

### 做法

1. **让期望读产品自己的解析**（推荐、最小改动）：把 `segmentedRelayExpected()` 改成调用产品自身的纯函数，使期望随产品的默认走——
   ```ts
   import { resolveVoiceRealtimeMode } from '../server/modules/voice-realtime/voice-realtime-mode';
   function segmentedRelayExpected(): boolean {
     return resolveVoiceRealtimeMode(process.env).mode === 'segmented';
   }
   ```
   `e2e/voiceRealtimeScriptedUpstream.ts:69` 已有 e2e → `server/modules/...` 的相对 import 先例，路径可解析。本判据选择下 `playwright.config.ts` **不覆写** `VOICE_REALTIME_MODE`（只有连续型单文件选择才覆写），故 spec 进程的 `process.env` 与 server 进程解析到的默认**同源**。
   - 备选（若 worker 证得 env 同源不成立）：由 `playwright.config.ts` 按它**组装给 server 的那个 env**发布解析结果（如 `QUAY_E2E_VOICE_REALTIME_MODE`），spec 读它——与两条兄弟 spec 的既有惯例同形；此时须把 `playwright.config.ts` 补进本任务 `## Touches`。
2. **两种默认各覆盖一次**：(a) **continuous 默认**状态（求值 root 现状，或在本任务 worktree 内**临时**应用同一行默认翻转作探针）与 (b) **segmented 默认**树（干净 develop worktree）上各跑一次判据命令，**两次都 exit 0**。探针改动须还原。
3. **判据逐字不动**：跑的就是 `AC-376.criterion` 那条命令（无 env 前缀、无 `-g`、无 argv 变化）。期望助手是**读数来源**，不是判据；`:648-654` 两个分支及其读数**一字不改**。
4. **取假形态**：在**解析出的档**上注入一个使上游帧法翻转的被测回归（continuous 档下让 proxy 也发 `commit`，或 segmented 档下去掉/改坏段提交）⇒ 判据 exit≠0、红在 `:648` 的模式分支；`git checkout --` 还原 ⇒ exit 0。贴文件名/行号/失败断言原文。
5. ⛔ **不改** `AC-376` 的 `criterion`／`expect`；⛔ 不给判据加 `VOICE_REALTIME_MODE=segmented` 之类 env 钉（那既改判据、又盖掉 GOAL-044 的真实读数）；⛔ **不改** `resolveVoiceRealtimeMode` 的默认（那是 GOAL-044 的裁定）；⛔ **不动**主检出任何在途 WIP（`voice-realtime-mode.ts`、`voice-realtime-ws-proxy.service.ts`、`useVoiceRealtimeSession.ts`、`VoiceRealtimeBar.tsx`、`src/shared/*`、i18n、那批 server 测试、untracked 文件）。凡**持久**改动到本任务 Touches 之外的文件，必须同步登记进 `## Touches`。

## AC

- [ ] **AC1 continuous 默认下绿**：在**产品解析为 continuous**（求值 root 现状的在途默认翻转在位、env 未设）的状态下跑判据命令 ⇒ **exit 0**，贴 `N passed` 行与墙钟。允许在 worktree 内**临时**复现该默认翻转作探针（须还原，`git status --porcelain` 净）；⛔ 不得改求值 root 除本任务改动外的其它在途 WIP。机械判据：exit code 0。
- [ ] **AC2 segmented 默认下绿**：在干净 develop worktree（默认 segmented、env 未设）跑**同一条命令** ⇒ **exit 0**；贴读数。⇒ 期望已与默认无关。机械判据：exit code 0。
- [ ] **AC3 判据逐字未改**：实际跑的命令逐字等于 `quay goal get AC-376 --json` 的 `criterion`（无 env 钉、无 `-g`、无 argv 增删）。机械判据：把两者贴出并逐字比对。
- [ ] **AC4 断言未弱化**：`git diff` 显示改动只在「期望档如何得到」，`:648-654` 两分支及其读数（`>= 1` / `== 0` / `audioFrameCount() > 0`）未删未改。机械判据：diff 可核。
- [ ] **AC5 假形态**：按做法 4 注入 ⇒ 判据 **exit≠0**、红在 `:648` 模式分支（贴文件名/行号/失败断言原文）；`git checkout --` 还原 ⇒ **exit 0**（AC1/AC2 原文）。
- [ ] **AC6 隔离与登记**：`git diff --stat develop HEAD` 只含 `e2e/voice-realtime-live-session-send.spec.ts`（+ 本任务文件；若走备选再加 `playwright.config.ts`）；求值 root 的在途 WIP 逐文件 diff 为空；`## Touches` 无 glob。

## DoD

判据命令在**产品解析为 continuous 的求值状态**（求值 root `/data/home/yale/work/claudecodeui` 的现状，GOAL-034 无 `branch: true`）与**干净 develop 树**上**都真实跑出 exit 0** 并留原文；两处读数（`passed` 行、墙钟、exit code）与模式来源一并记明：spec 的期望来自产品自身的解析，**两种默认下都对**。假形态现场红/还原绿，原始输出留档。Evidence 逐条记明：(a) 期望助手改前/改后原文与失败读数（`voice-realtime-live-session-send.spec.ts:649`）；(b) 两处 exit code 与模式；(c) 为何 e2e 的期望与产品默认同源（`playwright.config.ts` 对该选择不覆写 `VOICE_REALTIME_MODE`）；(d) 未动判据/未动求值 root 在途 WIP 的证据（`git diff --stat`、`git status --porcelain`）。

**诚实出口**：若判据在 continuous 默认下仍红、或红因落在**别人未提交的在途 WIP**上且无法在不动它的前提下消除、或 worker 证得修 spec 不足以跨两种默认都绿（例：spec 与 server 的 env 不同源且 config 发布需改被钉子覆盖的配置面），**不要**靠改判据/加 env 钉/删断言换绿：按 `task-gated-by-unpublished-upstream-artifact-parks-needs-human` park `needs-human`，逐字写明卡在哪一步、哪条读数、哪个前提（例：需人裁定 GOAL-034 是否声明 `branch: true` 使闸在干净树求值）。

## Touches

- e2e/voice-realtime-live-session-send.spec.ts
- tasks/gap-ac376-spec-relay-mode-expectation-drift.md
