---
id: gap-voice-realtime-paced-audio-source
title: 独立 paced/realtime audio source：按真实时间轴回放
  fixture，可脚本化暂停/静音/中途停止（微任务版做不到），且不改 fileAudioSource 的微任务 yield——AC-315
  握手竞态守卫保持可证伪
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 逐文件复核，带 file:line）

**唯一能喂真管线的文件源不是实时的，而且不可打断。** `src/modules/chat/voice-realtime/audioSource.ts:119-153` 的 `fileAudioSource`：解码后按 20 ms 切块，循环体是 `onFrame(...)` 后 `await Promise.resolve()`（`:133-137`）——**微任务，不让出事件循环**。整段 fixture 在一次宏任务内推完，因此：

- 播放途中**没有**任何插入点：点击 Mute、按 End、或任何 WebSocket 消息处理都无法在 fixture 中途运行；想造"句子说到一半静音"只能把静音烘进 WAV。
- 同理"播放中途断流/打断"在客户端层无法构造。

**而且这个微任务 yield 必须保持原样。** AC-315 的握手竞态守卫之所以可证伪，正是因为整段 fixture 在 `state:open` 之前落进 `pendingFramesRef`；把它换成宏任务会让该假形态变绿、废掉守卫（`macrotask-yield-in-fixture-source-masks-the-handshake-race`，2026-10-09 实测）。**故本任务不修改 `fileAudioSource`，只新增一个并列的源。**

**已有的两个替代都不够。** `window.__voiceFake`（`e2e/voice-continuous.spec.ts:180-248` 等）替换掉 `AudioContext`/`AudioWorkletNode`/`getUserMedia`——**绕过真实 worklet**，且是 spec 注入的页面钩子；Chromium `--use-file-for-fake-audio-capture` 是真实时，但只在听写路径的 spec 里用（`voice-trim.spec.ts:112-121` 等），且 WAV 在 config 求值期就固定，无法在播放中途改脚本。

**结论**：应用内没有任何"按真实时间轴回放、且可脚本化暂停/静音/断流"的音源。AC-319 的 Mute 判据（"上游帧数停止增长"）今天只能靠 `__voiceFake.speak()/pause()` 演，而那条路不经过真实采集链。

### SCOPE BOUNDARY（有意划下）

- ⛔ **不改** `fileAudioSource` 的帧间 yield（微任务），不删不弱化 AC-315 的握手竞态守卫。
- ⛔ 不做 Playwright/UI 编排（那是 `gap-live-voice-e2e-scripted-upstream`）。
- ⛔ 不改任何服务端代码。

<!-- dedup-ref --> 机制去重（立案时实测，2026-10-11）：于 `tasks/*.md` 对 `paced` / `audio source` / `音源` / `回放节拍` 逐个 grep，open 任务中仅 `gap-voice-realtime-scripted-fake-upstream` 命中——那是**上游**侧（假 DashScope 端点）的脚本化，本任务是**客户端音源**侧的节拍，机制不同、互不覆盖；该任务正由 worker 落地中。`task-granularity-advice.js` 对本任务 Touches 报 `peers: []`。

## Plan

1. **新源**：在 `src/modules/chat/voice-realtime/audioSource.ts` 增加一个并列导出（名字以实现为准，建议 `pacedFileAudioSource(file, options)`；同文件便于与既有源对照）。它按 fixture 自身的采样率**以真实时间**吐出 20 ms 帧（`setTimeout` 调度），而不是微任务连发。
2. **可注入的调度器**：`options.schedule?: (delayMs: number, run: () => void) => unknown`（默认 `setTimeout`）。单测据此用受控时钟推进，跑得快且确定；生产用真实时间。
3. **脚本化控制**：`pause()` / `resume()`（在时间轴上留出真实静音间隙，样本连续不跳——`atSample` 必须连续，否则 `LiveSegmenter.push` 会因 gap 抛错）、`stop()`（播放中途立即停止，**这是微任务版做不到的**）。静音/暂停期间是否吐静音帧须在实现里写清并与 hook 的 Mute 语义区分：**页面的 Mute 由 hook 自己丢帧**（`useVoiceRealtimeSession.ts:564-567`），源的 `pause` 是"根本没有声音"，两者不可互相替代，实现注释须写明。
4. **默认不变**：`startWithFile` 仍走 `fileAudioSource`。新源由显式的测试通道选中（沿用既有隐藏 input / `window.__voiceRealtime*` 钩子的先例，取最小暴露面），**不得**改成默认。
5. **判据文件**：新增 `src/modules/chat/voice-realtime/tests/pacedAudioSource.test.tsx`——**新文件**，不动 `useVoiceRealtimeSession.test.tsx`（它在 `gap-live-voice-voice-terminated-interrupt` 的 Touches 里，避免无谓串行）。该文件用**真实的 `useVoiceRealtimeSession`** + 假 WebSocket 驱动，使断言落在真 hook 上而不是孤立函数。

## AC

- [ ] AC1 取假形态（**排在判据文件最前**）：注入受控调度器后，帧的到达时刻等于脚本时刻（给出时刻序列读数），而**微任务版的 `fileAudioSource` 在同一断言下必然不满足**（它在 0 ms 内吐完）——该对比即本 AC 的假形态。
- [ ] AC2 暂停/恢复：`pause()` 期间的采样不产生语音帧（按实现声明的语义），`resume()` 之后样本**连续**（给出 `atSample` 轨迹，证明无 gap——segmenter 会因 gap 抛错，故这是硬不变量）。
- [ ] AC3 中途停止：fixture 播到约一半时 `stop()` ⇒ 不再有新帧，且已发出帧数 < 总帧数（给出两个读数）。**微任务版做不到**（它的 loop 无法被外部打断）——实现须在注释里点名这一差异。
- [ ] AC4 负控（原源逐位不变）：`fileAudioSource` 的帧序列、帧数与改动前相同，且仍在**一个宏任务内**完成（给出读数）；点名 AC-315 的握手竞态守卫仍可证伪（复跑该假形态仍红）。
- [ ] AC5 真 hook 上的 Mute：用新源驱动**真实** `useVoiceRealtimeSession`，在 fixture 中途 `mute()` ⇒ 该连接发出的 `audio` 帧计数停止增长（AC-319 的判据形态），`unmute()` 后恢复（给出三个读数）。
- [ ] AC6 静态门：`npm run test:client -- src/modules/chat/voice-realtime/tests/pacedAudioSource.test.tsx` 退出 0；`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npm run build:client` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：新音源驱动**真实的 `useVoiceRealtimeSession`**（不是孤立函数、不是替身 hook）走完整条浏览器侧链路，并在 fixture **播放途中**完成一次 Mute 与一次 `stop()`，各自产生可读的帧计数读数；同时 `fileAudioSource` 逐位未变、其微任务时序未变、AC-315 的握手竞态假形态仍可红。证据落在本任务 `## 验证记录`：时刻序列、`atSample` 轨迹、帧计数、原源负控读数、假形态复跑结论。⛔ 浏览器/Playwright 层是后续任务，此处不声称。

## Touches

- src/modules/chat/voice-realtime/audioSource.ts
- src/modules/chat/voice-realtime/tests/pacedAudioSource.test.tsx (new)（本任务判据文件；**新文件**，不动既有 hook 测试）
- src/modules/chat/voice-realtime/index.ts (only if the module's export surface must change)
- tasks/gap-voice-realtime-paced-audio-source.md (self)
