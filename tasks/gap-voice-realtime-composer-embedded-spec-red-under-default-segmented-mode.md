---
id: gap-voice-realtime-composer-embedded-spec-red-under-default-segmented-mode
title: 默认 segmented 后 e2e/voice-realtime-composer-embedded 红：假麦克风
  samples.fill(0.3) 平直块被 StreamingVad 判静音、上游 callCount()=0；该 spec 不在已落地上游任务范围内
status: ready
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

- [ ] 默认配置（不设 `VOICE_REALTIME_MODE`）：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` 退出码 0，无 `did not run`
- [ ] 回退配置：`VOICE_REALTIME_MODE=continuous npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` 退出码 0
- [ ] 默认路径断言非空转：`:644` 的 `upstream.callCount() >= 1` 通过；`continuous` 下同样 `callCount() >= 1`
- [ ] 取假形态必须变红：夹具改回 `samples.fill(0.3)` ⇒ 默认下 `:644` 红；还原 ⇒ 复绿
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0
- [ ] `quay goal gate AC-331` 在合并后的树上退出码 0（该行在合入 develop 之后才能读到）（待外部）

## DoD

在合并后的 develop 树上，用真实 Chromium 驱动真实服务（上游为 spec 自带的假 Realtime 上游，不调用真实 DashScope、不产生费用），分别在默认与 `continuous` 两种配置下跑完该 spec，贴出 pass/fail 计数与耗时原文；贴出默认配置下假上游的 `callCount()` 读数。未验证项如实写明。

## Touches

- e2e/voice-realtime-composer-embedded.spec.ts
- tasks/gap-voice-realtime-composer-embedded-spec-red-under-default-segmented-mode.md
