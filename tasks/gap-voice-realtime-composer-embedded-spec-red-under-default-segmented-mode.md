---
id: gap-voice-realtime-composer-embedded-spec-red-under-default-segmented-mode
title: 默认 segmented 后 e2e/voice-realtime-composer-embedded 红：假麦克风
  samples.fill(0.3) 平直块被 StreamingVad 判静音、上游 callCount()=0；该 spec 不在已落地上游任务范围内
status: done
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-331
---
## Proposal

### 现状（2026-10-11 复核，worktree gap-ac331-gate-deadline-and-ac323-regression-reverify，HEAD = develop c54381e1）

AC-331（以及 AC-323）判据第一条命令 CMD1

```
npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts
```

在 develop 上 **exit 1**：

```
✘ 1 e2e/voice-realtime-composer-embedded.spec.ts:600:3 › … 1280px: the bar holds one geometry through listening, mute and an executing call …
  Error: expect(received).toBeGreaterThanOrEqual(expected)
  Expected: >= 1    Received: 0
  > 644 | await expect.poll(() => upstream.callCount(), { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
  1 failed · 4 did not run · 9 passed (1.7m)
```

只跑该 spec：默认模式 **1 failed / 4 did not run**；`VOICE_REALTIME_MODE=continuous` **5 passed (18.8s), exit 0** ⇒ 红由「默认 segmented」触发，与 deadline / 负载无关。

### 机制（与已落地任务同因，但该任务未覆盖此 spec）

`gap-voice-realtime-e2e-specs-red-under-default-segmented-mode`（done, goal_ac: AC-319）只改了 `e2e/voice-realtime-live-session-send.spec.ts` 与 `e2e/voice-realtime-upload-fixture.spec.ts`（其 AC1 只点名这两份），**未碰 `e2e/voice-realtime-composer-embedded.spec.ts`**。后者假麦克风仍是平直常数块：

```
e2e/voice-realtime-composer-embedded.spec.ts:526   samples.fill(0.3);
```

P4（`15a30dcf`）让服务端对 `hello` 默认回 `ready{protocol:'segmented-v1'}` ⇒ 浏览器默认走分段上行；`StreamingVad` 对平直信号判静音（memory `streaming-vad-flat-tone-is-silence`）⇒ 不开段、不上行 ⇒ 假上游 `callCount()` 恒 0 ⇒ `:644` 断言红。

### 提案

复用 live-session-send 的修法：把该 spec 的 `speak()` 改成发**句子形非平直突发**（低幅前导定标 + 3 Hz 包络 × 180 Hz 载波 + 尾部停顿 > relay 的 2.0 s commit 间隔），使 listen 期即提交上行；保留默认与 `continuous` 双模式覆盖。

### 边界

- 只改 `e2e/voice-realtime-composer-embedded.spec.ts`（含其假上游计数，如需要）。
- 不改产品代码、不改判据命令。

## AC

- [x] 默认配置（不设 `VOICE_REALTIME_MODE`）：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` 退出码 0，无 `did not run`
- [x] 回退配置：`VOICE_REALTIME_MODE=continuous npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` 退出码 0
- [x] 默认路径断言非空转：`:644` 的 `upstream.callCount() >= 1` 通过；`continuous` 下同样 `callCount() >= 1`
- [x] 取假形态必须变红：夹具改回 `samples.fill(0.3)` ⇒ 默认下 `:644` 红；还原 ⇒ 复绿
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0
- [ ] `quay goal gate AC-331` 在合并后的树上退出码 0（该行在合入 develop 之后才能读到）（待外部）

## DoD

在合并后的 develop 树上，用真实 Chromium 驱动真实服务（上游为 spec 自带的假 Realtime 上游，不调用真实 DashScope、不产生费用），分别在默认与 `continuous` 两种配置下跑完该 spec，贴出 pass/fail 计数与耗时原文；贴出默认配置下假上游的 `callCount()` 读数。未验证项如实写明。

## Touches

- e2e/voice-realtime-composer-embedded.spec.ts
- tasks/gap-voice-realtime-composer-embedded-spec-red-under-default-segmented-mode.md

## 验证记录（worker 2026-10-11）

采样树：worktree `gap-voice-realtime-composer-embedded-spec-red-under-default-segmented-mode`，已 `git -C <wt> merge --no-edit develop`（合入 develop 的 `tasks/*.md` 一批提交，无源码变更）。实现 commit `ec6b0145`（只动 `e2e/voice-realtime-composer-embedded.spec.ts`）。

丢因（与已落地兄弟任务同因，但该任务未覆盖本 spec）：本 spec 的假麦克风把一段平直常量块（`samples.fill(0.3)`）交给 `StreamingVad`，而该检测器以最近帧的滑动 15 分位数为噪声底 —— 常量块自己就成了底，永远压不过语音因子，于是被读成静音；默认（segmented）路径下客户端不肯提交任何分段，假上游 `callCount()` 恒为 0，点名的 `upstream.callCount() >= 1` 轮询等到超时。

夹具改为与已落地兄弟 spec（`voice-realtime-live-session-send.spec.ts`）同形的「一句话」突发：0.6s 静音前导（给检测器半秒 bootstrap 定标）+ 3 Hz 包络 / 180 Hz 载波的音节段 + 2.2s 尾静音（比 relay 自己的 `RELAY_COMMIT_GAP_SEC = 2.0` 长），整段作为一条消息下发，因此 continuous 下是 1 帧 `audio`、默认下是恰好一句提交好的话。

读数（均在合并后的树上，真实 Chromium 驱动真实服务，上游为 spec 自带的假 Realtime 上游，不触真实 DashScope、不产生费用）：

- 默认配置（不设 `VOICE_REALTIME_MODE`）：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` → 退出码 0，`5 passed (18.1s)`（real 19.0s），无 `did not run`。合入 develop 之前同一命令：`5 passed (29.0s)`。
- 回退配置：`VOICE_REALTIME_MODE=continuous npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` → 退出码 0，`5 passed (19.3s)`（real 20.1s）。合入前：`5 passed (17.2s)`。
- 非空转探针（临时插桩读假上游计数，读后已 revert，`git status --short` 为空）：
  - 默认：`[probe] default-mode upstream.callCount()=1 audioFrameCount()=1 connectionCount()=1`
  - `continuous`：同上三条均为 1。
  即两种分帧下都恰好一句话到达上游、且各只多一帧 `input_audio_buffer.append`，故两处 `audioFrameCount() + 1` 的精确断言在两种分帧下都成立（一段提交好的话在 segmented 下也只对应一帧 append）。
- 取假形态（AC4）：夹具改回 `samples.fill(0.3)`。实现已先 commit `ec6b0145`，故 `git checkout -- <spec>` 可干净还原。按本 AC 自己的三 spec CMD1 选择跑（单文件跑会先撞 55s 运行上限的 watchdog、读不到断言）：`1 failed`、`4 did not run`、`9 passed (1.4m)`，红灯正是点名的断言 —— `e2e/voice-realtime-composer-embedded.spec.ts:679`（本轮编辑前的 `:644`）`expect(received).toBeGreaterThanOrEqual(expected)` / `Expected: >= 1` / `Received: 0` / `Timeout 25000ms exceeded while waiting on the predicate`，即 AC3 点名的 `upstream.callCount() >= 1` 轮询。还原后 `git checkout -- <spec>` ⇒ 复绿（见上面默认配置读数），`git status --short` 为空、`buildSpeechBurst(seconds)` 在 `:559`。
- `npm run lint` 退出码 0；`npm run typecheck` 退出码 0（均在合并后的树上）。

未勾项（AC6）：`quay goal gate AC-331` 仍不可判 —— AC-331 无 `timeoutMs`，其证据为 `not-evaluated (timeout): acceptance timed out after 60000ms (killed)`；负责补该超时的兄弟任务 `gap-ac331-gate-deadline-and-ac323-regression-reverify` 本轮在 develop 上 `ready→needs-human（重试上限机械翻转）`，超时未修，判据本身异因红、值不可定。按 `（待外部）` 约定，此项不由 worker 勾选，留待外部复判。
