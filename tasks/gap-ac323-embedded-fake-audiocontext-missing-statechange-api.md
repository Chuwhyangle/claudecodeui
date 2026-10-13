---
id: gap-ac323-embedded-fake-audiocontext-missing-statechange-api
title: AC-323 判据红：composer-embedded 内联 FakeAudioContext 缺
  state/addEventListener('statechange')/resume ⇒ 麦克风 start() 抛 TypeError 进
  caption 单元，串行跳过其余 6 例
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-323
---
## Proposal

### 现状（2026-10-13 复核，main checkout，develop tip `20143850`）

AC-323 判据第一条命令

```
npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts
```

在 develop 上 exit 1：`1 failed · 6 did not run · 11 passed (2.2m)`。唯一的红灯是

```
e2e/voice-realtime-composer-embedded.spec.ts:778
await expect(page.getByTestId('voice-realtime-caption')).toHaveText(LONG_CAPTION, { timeout: 15_000 });
  Expected: "the model keeps hearing a much longer utterance than this cell can ever show …"
  Received: "activeContext.addEventListener is not a function"
```

判据第二条（`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime`）与第三条（`npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "`）本轮均 exit 0（181 passed / 6 passed）。故整条判据只因此一处红。

### 机制（兄弟 fake 已补齐，此内联副本被漏）

`99790d1f`（任务 `gap-live-voice-mic-audiocontext-suspend-resume`，done）让 `microphoneAudioSource().start()` 订阅 `activeContext.addEventListener('statechange', …)` 并在挂起时 `resume()`（`src/modules/chat/voice-realtime/audioSource.ts:102`）。真实浏览器的 `AudioContext` 是 `EventTarget`，带这两个成员；e2e 的假 `AudioContext` 是手写替身，缺了就在 async 体里抛 `TypeError`。

同一个 commit 把共享假麦克风 `e2e/voiceRealtimeFakeMic.ts:240` 与 `e2e/voice-realtime-live-session-send.spec.ts:537` 的同名内联 fake 都补齐了（两处都留了注释点名这个失败），**唯独漏了 `e2e/voice-realtime-composer-embedded.spec.ts` 的内联 `FakeAudioContext`**（无 `state` / 无 `addEventListener` / 无 `resume`）。

该 spec 的 `start()` 抛错 → 会话 hook 把它落进 `error` → `VoiceRealtimeBar.tsx:356` 的 caption 单元 `{error ? <span data-testid="voice-realtime-error">{error}</span> : lastCaption}` 于是渲染 TypeError 文本而非 `lastCaption` → `:778` 的 `toHaveText(LONG_CAPTION)` 红。又因该 `describe` 是串行模式，首例失败后其余 6 例「did not run」，判据读不到它们的真实状态。

本机已验证（临时补齐内联 fake 后）：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` → exit 0，`7 passed (49.2s)`，无 `did not run`；随后 `git checkout -- <spec>` 还原，`git status --short` 为空。

### 提案

把内联 `FakeAudioContext` 补齐与本文件兄弟一致的最小面：`state = 'running'`；`addEventListener(type, listener)`（仅记录，不驱动 statechange）；`resume()`（resolved promise）。形状对齐 `e2e/voiceRealtimeFakeMic.ts:240-262` 与 `e2e/voice-realtime-live-session-send.spec.ts:532-565`。

### 边界

- 只改 `e2e/voice-realtime-composer-embedded.spec.ts` 的假 `AudioContext`；不改产品代码、不改判据命令、不改共享 fake。
- 不改 `:778` 的断言本身（它是对的；错的是喂给它的假环境）。

## AC

- [ ] 内联 `FakeAudioContext` 具备 `state`（值 `'running'`）、`addEventListener('statechange', …)`、`resume()`；形状对齐 `e2e/voiceRealtimeFakeMic.ts` 的同名 fake（`grep` 出三条成员）。
- [ ] `npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` 退出码 0 且 `7 passed`，无 `did not run`（修复前 `1 failed · 6 did not run`）。
- [ ] AC-323 判据第一条命令（三 spec 联跑）退出码 0。
- [ ] 整条 AC-323 判据三命令串行退出码 0：①三 spec playwright；②`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime`；③`npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "`。
- [ ] 取假形态必须变红：去掉内联 fake 的 `addEventListener` ⇒ `:778` 的 caption 单元读回 TypeError、该 spec 红；还原 ⇒ 复绿。
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0。

## DoD

在合并后的 develop 树上，用真实 Chromium 驱动真实服务（上游为 spec 自带的假 Realtime 上游，不触真实 DashScope、不产生费用），跑完 AC-323 判据的三条命令并贴出 pass/fail 计数、耗时与退出码原文；贴出 `e2e/voice-realtime-composer-embedded.spec.ts` 的红→绿对照（修复前 `:778` 读到的 `Received:` 文本，修复后 `7 passed`）。未验证项如实写明。

## Touches

- e2e/voice-realtime-composer-embedded.spec.ts
- tasks/gap-ac323-embedded-fake-audiocontext-missing-statechange-api.md