---
id: gap-use-voice-realtime-session-concern-split
title: useVoiceRealtimeSession 按关注点拆分（第一刀）：把 3110 行 hook 里混装的纯逻辑（narrator WAV /
  PCM 编码 / caption 排序）迁到命名兄弟模块，hook 只留状态机
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22，HEAD d6c4d45c77ab）**：机制词 grep `grep -rlE 'useVoiceRealtimeSession.*(拆|split|重构|extract)|god hook|hook.*(god|拆分)' tasks/*.md` → 命中 2（`gap-ui-visible-context-extended-focus-scope`、`gap-live-voice-recoverable-error-console-only`），逐条读均为**行为**任务（焦点范围 / 可恢复错误日志），无一认领「把 useVoiceRealtimeSession 按关注点拆到兄弟模块」这一结构机制。合并候选（granularity-advice `--touches src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts`）报 `peers: []` ⇒ **separate**。

### 现状（立案时实测，2026-10-22）

- `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` = **3110 行**，1 个导出 hook，内部 **23 useState / 8 useEffect / 27 useCallback / 41 useRef / 0 useMemo**，并混装约 40 个顶层纯函数：narrator WAV 头解析（`narratorBase64Bytes/narratorAscii/narratorUint16LE/narratorUint32LE/concatNarratorBytes/parseNarratorWavHeader/releaseNarratorStream`）、PCM 编码（`frameLevel/encodePcm16Base64/continuousAudioFrame`）、caption 排序与认领（`captionOrderKey/sortCaptionsInSpokenOrder/unclaimedSegment/claimThrough`）等。
- archguard（src scope）outDegree：`useVoiceInput` 56 / `ChatInterface` 48 / `useChatComposerState` 42 / `useVoiceRealtimeSession` 38——本 hook 是前端 god 之一。
- perFile：**36 个已落地任务**碰过这个文件，中位每任务改 **51 行**、中位 2 轮。
- 同目录已有按关注点拆的兄弟文件（`audioSource.ts / placeCaptions.ts / soundCue.ts / useFollowSentRun.ts / voiceRealtimeProtocol.ts`），说明「纯逻辑放命名兄弟文件」是本模块既有约定。

### 改法

第一刀只迁**纯逻辑**（narrator WAV 解析、PCM 编码、caption 排序/认领）到三个命名兄弟模块 `narratorWav.ts` / `audioFrameEncoding.ts` / `captionOrdering.ts`，hook `import` 回来、行为一行不改。状态机（23 useState / 41 useRef）是**第二刀**（按子钩子拆状态/副作用/派生），不在本条。

⛔ 前端护栏：新文件落在 `src/modules/chat/voice-realtime/` 同目录；沿用前端规范——纯逻辑迁到**描述性命名的兄弟文件**（不是 `utils.ts` 收容袋），`@/` 别名 import，类型用 `type` 不用 `interface`。

## Plan

1. **盘点**：把 ~40 个顶层纯函数按域归类（narrator / 音频编码 / caption），确认每个的调用方只在 hook 内或可随迁。
2. **迁纯逻辑**：逐字迁到三个命名兄弟模块，hook `import` 回来；纯位移、语义一行不改。
3. **判据**：瘦身读数（hook 行数下降）+ 既有 voice-realtime 判据单跑仍绿（行为保持）。
4. **收口**：typecheck / build:client / lint，范围受控。

## AC

- [ ] (a) **兄弟模块存在且 hook 引用**：`test -f src/modules/chat/voice-realtime/narratorWav.ts -a -f src/modules/chat/voice-realtime/audioFrameEncoding.ts -a -f src/modules/chat/voice-realtime/captionOrdering.ts` 退出 0；`grep -qE "narratorWav|audioFrameEncoding|captionOrdering" src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` 退出 0。
- [ ] (b) **中心文件瘦身**：`test "$(wc -l < src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts)" -lt 3110` 退出 0（基线=立案实测 3110）。
- [ ] (c) **既有行为判据不改一字仍绿**：窄跑 `npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.segmented.test.tsx src/modules/chat/voice-realtime/tests/voiceRealtimeNarratorStream.test.tsx` 退出 0（纯位移后这些用例必须原样全绿）。
- [ ] (d) **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npm run build:client` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列。

## DoD

真实落地的标准是「纯逻辑真的**住进了命名兄弟模块**、hook 只留下状态机与组合」，不是「多了三个文件」。必须贴出：①(a) 三个新模块各自导出的符号清单与 hook 的 import 行原文；②(b) `wc -l` 前后读数；③(c) 三条既有判据单跑的退出码与用例数；④(d) typecheck / lint / build:client 退出码；⑤纯位移核对（`git diff` 对迁出函数是纯移动——若发现某段无法原样迁，逐条列出，不得悄悄改写语义）；⑥`git diff` 只含 `## Touches` 所列文件。

## Touches

- `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts`（纯逻辑迁出，行为不变）
- `src/modules/chat/voice-realtime/narratorWav.ts` (new)（narrator WAV 头解析）
- `src/modules/chat/voice-realtime/audioFrameEncoding.ts` (new)（PCM 编码）
- `src/modules/chat/voice-realtime/captionOrdering.ts` (new)（caption 排序/认领）
- `src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx`（既有判据，不改一字，作行为覆盖）
- `src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.segmented.test.tsx`（既有判据，不改一字，作行为覆盖）
- `src/modules/chat/voice-realtime/tests/voiceRealtimeNarratorStream.test.tsx`（既有判据，不改一字，作行为覆盖）
- `tasks/gap-use-voice-realtime-session-concern-split.md`（自触）
