---
id: gap-voice-input-draft-context-and-provisional-range
title: Voice input P0：one-shot relay 注入编辑框草稿上下文 + composer 语音区间临时视觉标记
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-22）：现有 context-pack 任务 `gap-voice-realtime-context-pack-and-hot-settings` 与 `gap-voice-context-pack-refresh-and-stale-summary-gate` 只覆盖 Live Voice 的 transcript pack；没有任务覆盖编辑框草稿上下文或 composer 的 voice range 视觉标记。`task-granularity-advice.js` 对下列 Touches 返回 `peers=[]`、`mentions=[]`，故保持独立立案。

### 现状与缺口

- `buildVoiceContextPack(messages)` 只读当前会话 transcript；`useVoiceInput` 在每次 segment 上传时把它作为 `hints.context` 传给 `dashscope-omni-relay`。编辑框里用户此前键入的文本（可能包含术语、指代、待改写段落）完全不进上下文。
- `handleVoiceTranscript` 已经用“整段替换”写入 `voiceInsertionRef` 的 range；`voiceInsertion.ts` 也会随用户编辑 remap。也就是说 UI 已经支持“更新前面的文本”，但没有任何视觉标记区分“当前语音输入的文字”和“用户此前键入的文字”。
- composer 已有一层透明 overlay（`inputHighlightRef` + `renderInputWithMentions`），textarea 的文字可见、overlay 只画背景/高亮；因此给 voice range 加背景是现成机制，不需要 contenteditable。

### 落地时核实（2026-10-22，实现前重读 develop）

上面「现状」描述的是作者工作区（未提交）的状态，**不是 develop**：develop 上 `useVoiceInput` 还没有把 context 传给转写、`dashscope-omni-relay` 不在 `shared/asr/list/`、服务端 `/api/voice/transcribe` 不解析 `context`、`transcribeVoice` 只有 4 个参数。本任务因此先以独立提交 `feat(voice): dashscope-omni-relay recogniser + proxy context passthrough` 补齐这条前置（provider 行 + 注册 + 服务端 context 透传 + 客户端第 5 参 + 它的 pause-cues 记录与三条脚本 pin），再在其上做本案的草稿上下文与视觉标记。前置的 15 个文件已写进 Touches。

### 方案

1. **编辑框上下文**：在 `src/modules/chat/utils/voice/voiceContextPack.ts` 新增 `buildVoiceInputContextPack({ messages, draftBefore, draftAfter, voiceSoFar, budgetChars })`（或等价的显式选项），按优先级放入三段：
   - `【光标前，用户此前输入】`
   - `【光标后，用户此前输入】`
   - `【本次语音已经生成的文字（继续整理，不要重复）】`
   剩余预算再交给现有 `buildVoiceContextPack` 填会话内容；总长仍 ≤ 2000。空段不输出标题。现有 `buildVoiceContextPack` 的签名/行为保持不变，Live Voice 不受影响。
2. **开始听写时捕获草稿**：`useVoiceInput` 增加 `draftText` 选项（`ChatComposer` 把当前 `input` 传进来）。session 创建时快照 `draftText` 与光标位置；每次 segment 上传用 `draftBefore`/`draftAfter`/`session.committed` 构建上述 context，作为 `transcribeVoice` 的第 5 参。草稿在听写过程中继续变化不回溯本次快照；`voiceSoFar` 用已提交的 `session.committed`。
3. **暴露 voice range**：`useChatComposerState` 在 `handleVoiceListeningStart`/`handleVoiceTranscript`/`handleInputChange` 里维护一个 `voiceRange: { start, end } | null` state（与现有 `voiceInsertionRef` 同步），`ChatInterface` 把它和 `voiceState !== 'idle'` 传给 `ChatComposer`。
4. **视觉标记**：`ChatComposer` 在 overlay 中把 `input` 切成 `[0,start)`、`[start,end)`、`[end,len)`；中间段用 `data-voice-provisional="true"` 的 `<span>` 包住，背景用低对比度的 `bg-primary/10` + `box-decoration-clone`（与 mention 高亮同一套换行方式）。textarea 文字保持正常颜色。`voiceActive=false` 时不渲染该 span，文本自然恢复成普通可编辑文本；不改变 `handleVoiceTranscript` 的整段替换语义。

### 边界/不做

- 不接 realtime dictation，不改 Live Voice/session_send，不改服务端 adapter/route（服务端 context 透传属于上面前置提交，不是本案的机制）。
- 不实现跨 segment 的模型修订、不做 user-owned span 锁定；这些留给后续 P1/P2。
- 不新增 contenteditable；视觉标记只在现有 overlay 上画背景。
- 不新增 server 测试文件，避免 `server/shared/tests/quay-test-script.test.ts` 的收集数 pin 移动。

## AC

- [x] `npx vitest run src/modules/chat/utils/tests/voiceContextPack.test.ts` 退出码 0；新增用例断言 (a) draft before/after 与 voice-so-far 三段按顺序进入包；(b) 空 draft/空 voice 不产生空标题；(c) 任意输入下包长 ≤ 2000，且会话内容只填剩余预算。
- [x] `npx vitest run src/modules/chat/tests/voiceTranscriptRepair.test.tsx` 退出码 0；用 stateful harness 让 composer 保留 `input`，断言 `transcribeVoice` 第 5 参包含当前草稿文本和 `session.committed`，且不含未提交的草稿变更。
- [x] `npx playwright test e2e/voice-continuous.spec.ts -g "P0 voice input"` 退出码 0；用例把 e2e fixture 的 providerId 指向 `dashscope-omni-relay`（honors.context=true），预填一段草稿，说话后断言：
  - `[data-slot="prompt-input-textarea"]` 的值 = 草稿 + 语音文本；
  - overlay 中 `[data-voice-provisional="true"]` 的文本恰为语音文本，不含草稿前缀；
  - 被拦截的 `/api/voice/transcribe` 请求 body 的 `context` 字段包含草稿文本；
  - 停止录音后 `[data-voice-provisional="true"]` 不再存在（文本恢复普通形态）。
- [x] 取假形态现场红再还原：移除 draft 注入 ⇒ 第 1/2 条红；移除 overlay span ⇒ 第 3 条红；恢复后全绿，把两次输出记入 Notes。
- [x] `npm run typecheck` 退出码 0；`npm run lint:client` 退出码 0。
- [x] 不新增 server 测试文件；`server/shared/tests/quay-test-script.test.ts` 的收集数 pin 保持不变。

## DoD

真实浏览器落地（`e2e/voice-continuous.spec.ts` 的 fake mic + 拦截 `/api/voice/transcribe`，真实 composer/hook/segmenter/overlay）：预填草稿后开始一次 voice input，屏幕上草稿保持普通样式、语音文本带临时背景；被拦截的 POST context 含草稿；停止后背景消失、整段文本可正常编辑。截图与 context 摘录（不含密钥）落到 `artifacts/voice-input-p0/` 并贴进本任务 Notes。不是“测试存在”，是这条手势真的被跑过并留下读数。

## Notes

### 落地时核实（2026-10-22，实现前重读 develop）

Proposal 的「现状」是作者工作区（未提交）的状态，不是 develop：`useVoiceInput` 当时还没有把 context 传给转写、`dashscope-omni-relay` 不在 `shared/asr/list/`、服务端 `/api/voice/transcribe` 不解析 `context`、`transcribeVoice` 只有 4 个参数。因此先以独立提交 `feat(voice): dashscope-omni-relay recogniser + proxy context passthrough` 补齐这条前置（provider 行 + 注册 + 服务端 context 透传 + 客户端第 5 参 + 它的 pause-cues 记录与三条脚本 pin），再在其上做本案的草稿上下文与视觉标记。前置的 15 个文件已写进 Touches；本案 8 个文件在第二个提交 `feat(chat): dictation carries the draft it started in and paints its own range`。

### 假形态现场红（AC-4）

1. 移除 draft 注入（`buildVoiceInputContextPack` 里两个 draft 分支改成传空串）：

```
npx vitest run src/modules/chat/utils/tests/voiceContextPack.test.ts
  × ④ the draft blocks go in before the conversation, in the order the caret splits them
  × ④ each draft side is elided AWAY from the caret, so the words it points at survive
  × ④ the conversation is built with exactly the room the draft blocks left, and never more
  Tests  3 failed | 12 passed (15)

npx vitest run src/modules/chat/tests/voiceTranscriptRepair.test.tsx
  × a listen carries the box it started in and what it has already said, not the edits since
  Tests  1 failed | 3 passed (4)
```

2. 移除 overlay span（`{provisionalVoiceRange ? (` → `{false ? (`）：

```
npx playwright test e2e/voice-continuous.spec.ts -g "P0 voice input"
  Error: expect(locator).toHaveCount(expected) failed
  Locator:  locator('[data-voice-provisional="true"]')
  Expected: 1
  Received: 0
  - 14 × locator resolved to 0 elements
  1 failed
```

还原后：`Tests 15 passed (15)` / `Tests 4 passed (4)` / `1 passed (13.1s)`。

### DoD 实测（真实浏览器）

`P0_ARTIFACT_DIR=… npx playwright test e2e/voice-continuous.spec.ts -g "P0 voice input"` → `1 passed (45.1s)`。

- 截图：`artifacts/voice-input-p0/voice-input-p0-provisional.png` —— composer 里 `请把架构页的说明改短一点：` 保持普通样式，`alpha bravo` 带临时背景；停止后该 span 计数为 0 而文本保留。
- 被拦截的 POST `/api/voice/transcribe` 的 `context` 字段摘录（`artifacts/voice-input-p0/voice-input-p0-provisional.context.txt`，无密钥、无 header）：

```
name="context"

【光标前，用户此前输入】
请把架构页的说明改短一点：

用户（刚刚）：open the composer for the continuous capture check
```

## Touches

- src/modules/chat/utils/voice/voiceContextPack.ts
- src/modules/chat/utils/tests/voiceContextPack.test.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/hooks/useChatComposerState.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/voiceTranscriptRepair.test.tsx
- e2e/voice-continuous.spec.ts
- playwright.config.ts（仅当整文件超过 SPEC_BUDGET_MS 时调整预算）
- tasks/gap-voice-input-draft-context-and-provisional-range.md（self）

前置（`feat(voice): dashscope-omni-relay recogniser + proxy context passthrough`）：

- shared/asr/list/dashscope-omni-relay/dashscope-omni-relay.asr-provider.ts
- shared/asr/asrRegistry.ts
- shared/asr/asrInvariants.ts
- server/modules/voice/voice.routes.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-provider-dispatch.test.ts
- server/modules/voice/tests/voice-dashscope-default-model.test.ts
- server/shared/types.ts
- src/shared/api.ts
- src/modules/chat/tests/voiceClientAsrRouting.test.ts
- scripts/asr-dashscope-omni-check.test.mjs
- scripts/asr-second-adapter-check.test.mjs
- scripts/asr-health-provider-check.mjs
- docs/experiments/2026-10-22-omni-relay-pause-cues.md
- docs/experiments/README.md