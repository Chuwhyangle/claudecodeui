---
id: gap-live-voice-mic-audiocontext-suspend-resume
title: Live Voice 麦克风 AudioContext 挂起后静默断流：加 statechange 自动 resume，UI
  只转灰不报红，详情仅进 console
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现象（2026-10-11 操作者手机实测，服务端+隧道日志逐行复核）

connectionId `08138645-d258-4610-947d-ddef805cd4ff`（`~/.cloudcli/voice-realtime-log/08138645-d258-4610-947d-ddef805cd4ff.jsonl`，对应 `server.log` 同名行）：操作者口述第四句后，`16:33:35.248Z` 是最后一次 `from-browser audio frames=2000`（每 250 帧/5s 打一行）；`teardown` 时累计 `frames=2191`，换算真正最后一帧落在约 `16:33:39`——也就是第四句那轮答完仅 4 秒后，麦克风就再没有产出过一个音频帧。页面没有任何可见异常，操作者确认"页面一直打开、没有切换应用"。直到 `16:34:18.330Z`（又过了约 39 秒的彻底静默）服务端才收到 `socket.on('close')`，日志记成 `teardown: the browser socket closed`。

排除过的两个嫌疑：
- 服务端侧：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 这条路径没有 ping/pong 心跳、没有 `terminate()`——不是服务端判超时踢的。
- 隧道侧：`docker logs modest_wright`（cloudflared）在整段连接存续期间（`16:32:55`–`16:34:18`）没有任何错误行，不是隧道边缘主动切断的。

客户端侧排查（`src/modules/chat/voice-realtime/`）：
- `useVoiceRealtimeSession.ts` 的 `mutedRef`（:1039/:1045/:1050）只在显式点击 Mute 按钮（`VoiceRealtimeBar.tsx:336` 的 `onClick`）时置 true，没有自动静音路径。
- `socketOpenRef` 只在 `connect()` 重置、`end()`、`socket.onclose` 三处改写，服务端消息不会中途悄悄清掉它——帧停发不是这层逻辑的问题。
- 真正能让帧「无声停发、不报任何错」的，是底层 `AudioContext` 被系统挂起（`state → 'suspended'`）：`src/modules/chat/voice-realtime/audioSource.ts:41-94` 的 `microphoneAudioSource()` 创建 `AudioContext`、接好 `AudioWorkletNode` 的音频图之后完全不管它——没有监听 `context.onstatechange`，挂起后也没有 `context.resume()`。移动端浏览器会在很多场景下把 `AudioContext` 挂起（通知音效、蓝牙音频路由切换、系统音频会话被打断、厂商省电策略），**不需要用户切换 App 或锁屏**，挂起后 `worklet.port.onmessage` 直接停止触发，`beginCapture`（`useVoiceRealtimeSession.ts:626-663`）的帧回调因此再也不会被调用——这和证据链完全吻合：帧停发在前，WS 本身的断开是 39 秒后才发生的后果，不是原因。
- `src/shared/utils.ts:176` 确实有一处 `context.state === 'suspended'` → `context.resume()`，但那是通知提示音 (`playNotificationSound`) 专用的 `AudioContext`，和语音采集完全是两个不相关的实例，帮不上这里的忙。

### 修法（已与操作者当面确认 UX 约束，2026-10-11）

1. `microphoneAudioSource()`（`audioSource.ts`）里给 `context` 加 `addEventListener('statechange', …)`：一旦 `context.state === 'suspended'`，立即 `await context.resume()`（失败也捕获，不让异常冒泡炸掉调用方）。把这个状态（`'active' | 'suspended'`，以及 resume 成功/失败的细节）通过 `VoiceRealtimeAudioSource.start` 的一个新可选回调（或等价机制）暴露给调用方——`fileAudioSource`/`pacedFileAudioSource` 不触发它，不需要新逻辑。
2. `useVoiceRealtimeSession.ts` 接住这个信号，暴露一个新的只读布尔（例如 `micSuspended`），**不得**调用现有的 `setError(...)`——那条路径会把文案渲染进 `VoiceRealtimeBar.tsx:302` 的 `text-destructive` 红色提示，操作者明确要求这种情况不走这条红色/显眼提示路径；也不得把 `phase` 改写成 `'muted'`——`'muted'` 是用户主动点 Mute 的语义，混进去会让 Mute 按钮的 `aria-pressed`/文案（`unmute`/`mute`）在用户没点过的情况下错误翻转。
3. 挂起/恢复/失败的具体细节（例如 "AudioContext suspended, attempting resume" / "resume failed: <reason>"）只通过 `console.warn`/现有的 `voiceLog`（`useVoiceRealtimeSession.ts:278`，已经是 `console.info` 前缀 `[voice-realtime]`）落地到浏览器自己的 console，不进入任何会渲染到页面上的字符串。
4. `VoiceRealtimeBar.tsx` 的 `Waveform`（:86-124）在 `micSuspended` 为 true 期间，把柱子的颜色从 `bg-primary/70`（:119）切换成一个灰态（例如复用现有 `bg-muted-foreground/40` 这类已在别处出现过的灰色调性,不要引入新的强调色），且这个灰态与 Mute 的灰态（`voice-realtime-state-icon` 的 `bg-muted text-muted-foreground`，约 :258）在视觉上可以相同但在状态机上必须分开——不得共用 `muted` 这个 phase 分支。

### 关联 / 粒度

`task-granularity-advice.js --touches src/modules/chat/voice-realtime/audioSource.ts --touches src/modules/chat/voice-realtime/tests/audioSource.test.ts --json`：`peers: []`、`mentions: []`，没有同文件在跑的 open 任务，独立成任务。按 MECHANISM 搜过 `tasks/*.md` 里 `audiocontext|suspend|audioWorklet` 的命中（均为已 `done`、且都不是挂起/恢复机制），以及 open 任务里提到 `live.voice|mobile|voice.realtime` 的命中（`gap-live-voice-continuous-duplicate-session-send-without-new-audio.md` 是连续模式下上游自起 `session_send` 重复投递的机制，和本任务的"麦克风采集管道静默停止"是两个独立机制，不合并），确认不是重复立案。

## Touches

- `src/modules/chat/voice-realtime/audioSource.ts`（`microphoneAudioSource()` 加 statechange/resume）
- `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts`（接住挂起信号，暴露 `micSuspended`，不经 `setError`/`muted` phase）
- `src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx`（`Waveform` 挂起态转灰，与 Mute 的灰态状态机分开）
- `src/modules/chat/voice-realtime/tests/audioSource.microphoneSuspend.test.ts`（新建，AC1）
- `src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx`（扩展，AC2）
- `src/modules/chat/voice-realtime/tests/voiceMicSuspendedWaveform.test.tsx`（新建，AC3）
- `e2e/voice-realtime-scripted-scenarios.spec.ts`（扩展 `installFakeAudioGraph()`，AC4）
- `tasks/gap-live-voice-mic-audiocontext-suspend-resume.md`（自touch）

## AC

- [x] AC1（麦克风源，单测）：新建 `src/modules/chat/voice-realtime/tests/audioSource.microphoneSuspend.test.ts`，仿照 `src/modules/chat/voice-realtime/tests/pacedAudioSource.test.tsx:56` 的 `FakeAudioContext` 模式扩展出一个支持 `state`、`addEventListener('statechange', cb)`、`resume()`（调用后把 `state` 置回 `'running'` 并触发一次 `statechange`）的假 `AudioContext`，配合最小的假 `AudioWorkletNode`/`navigator.mediaDevices.getUserMedia` 桩，`vi.stubGlobal('AudioContext', …)` 后调用 `microphoneAudioSource().start(onFrame)`；测试把假 context 的 `state` 置成 `'suspended'` 并派发 `statechange`，断言 `resume` 被调用过至少一次。判据：`npx vitest run src/modules/chat/voice-realtime/tests/audioSource.microphoneSuspend.test.ts` 退出 0。
- [x] AC2（hook 层，不报红）：扩展 `src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx`：注入一个受控的假 `VoiceRealtimeAudioSource`，在 `start()` 之后模拟它报告一次 suspended→resume 的状态变化；断言 `result.current.error` 全程保持 `null`（证明没有走 `setError`）、`result.current.phase` 不被改写成 `'muted'`、hook 新暴露的挂起信号在挂起期间为 true、resume 之后回到 false；再断言这期间 `console.warn`（或 `console.info`）被调用过且参数字符串里含 "suspend" 字样（证明细节确实走了 console，不是被吞掉）。判据：`npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出 0。
- [x] AC3（UI 视觉，灰非红）：新建 `src/modules/chat/voice-realtime/tests/voiceMicSuspendedWaveform.test.tsx`，仿照 `src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` 直接构造 `voice` prop 渲染 `VoiceRealtimeBar`；分别渲染"正常监听"与"挂起中"两态，断言：挂起态下 `data-testid="voice-realtime-wave"` 内的柱子不再带 `bg-primary/70` 而是带灰态 class；`data-testid="voice-realtime-error"` 节点在挂起态下不存在（即没有红色文案）；`data-testid="voice-realtime-mute"` 的 `aria-pressed` 在挂起态下仍是 `false`（没有被误判成 Mute）。判据：`npx vitest run src/modules/chat/voice-realtime/tests/voiceMicSuspendedWaveform.test.tsx` 退出 0。
- [x] AC4（真实浏览器 DOM，而不是 jsdom 模拟）：在 `e2e/voice-realtime-scripted-scenarios.spec.ts` 里扩展现有 `installFakeAudioGraph()`（:246-277）的 `FakeAudioContext`，加上 `state`/`addEventListener('statechange')`/`resume()`，新增一个用例：页面真实加载、真实走到 Live Voice 监听态后，在页面内把假 context 的 `state` 设成 `'suspended'` 并派发 `statechange`；用 `page.on('console', …)` 采集浏览器真实 console 输出，断言其中出现本任务新增的挂起告警文案；用 Playwright 的 `expect(page.getByTestId('voice-realtime-error'))` 断言该节点不可见；断言波形节点的 class 在挂起期间切到灰态、随后（模拟 `resume()` 触发 `statechange` 回 `'running'`）切回正常。判据：`npx playwright test e2e/voice-realtime-scripted-scenarios.spec.ts -g "<本用例标题>"` 退出 0。
- [x] AC5（静态门）：`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

AC1-3 的 jsdom 单测只证明函数被正确调用，不构成 real-landing（DIR-026 Reading A：fixture 必要不充分）。AC4 的 Playwright 用例是本任务的实落地证据——它驱动的是生产里真正跑在浏览器 DOM 里的 `microphoneAudioSource()`/`useVoiceRealtimeSession`/`VoiceRealtimeBar` 这条完整链路（只是把 `AudioContext`/`getUserMedia` 换成假的，因为 CI 机器没有麦克风，这与仓库里其余 voice-realtime e2e 用例的既有约定一致），在真实渲染的页面上验证：挂起时波形真的变灰、`voice-realtime-error` 节点真的没有出现、细节文案真的只出现在浏览器 console 而不是页面任何可见文本节点里，并且 resume 之后状态真的能自己恢复。

此外：若在本任务落地后操作者下一次真实手机 Live Voice 会话里再次自然发生这种挂起（不强求复现，复现条件本身不可控），请把那次 `~/.cloudcli/voice-realtime-log/<connectionId>.jsonl` 里是否仍出现「帧停发远早于 socket 关闭」的模式，以及操作者手机浏览器那次 console 里是否出现本任务新增的告警文案，补一笔进本任务的 `## 验证记录`；如未自然复现，如实记录「未复现」，不得以此替代 AC4 本身。

## 验证记录

### 自证读数（在合并 develop 之后的树上重跑，2026-10-12）

- AC1：`npx vitest run src/modules/chat/voice-realtime/tests/audioSource.microphoneSuspend.test.ts` → 1 file / 3 tests passed，exit 0。
- AC2：`npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` → 1 file / 40 tests passed，exit 0。
- AC3：`npx vitest run src/modules/chat/voice-realtime/tests/voiceMicSuspendedWaveform.test.tsx` → 1 file / 3 tests passed，exit 0。
- AC4：`npx playwright test e2e/voice-realtime-scripted-scenarios.spec.ts -g "a suspended microphone greys the waveform and logs the detail without a red error"` → 1 passed (1.8s)，exit 0。用例标题：`a suspended microphone greys the waveform and logs the detail without a red error`（`e2e/voice-realtime-scripted-scenarios.spec.ts:792`）。
- AC5：`npm run typecheck` exit 0；`npm run lint` exit 0（仅 warning，无 error 级）。

本轮 `git merge --no-edit develop` 零冲突合入，合并进来的改动仅落在 `docs/`、`scripts/`、`tasks/` 三处，未触碰 `src/modules/chat/voice-realtime/` 或 `server/modules/voice-realtime/`——即本任务 AC 所依赖的客户端链路完全未变；尽管如此仍按自证判据的约定在合并树上把上面五条全部重跑，读数与合并前一致。

### 操作者真实手机复现（DoD 约定）

未复现——本任务落地后尚无一次真实手机 Live Voice 会话再次自然发生挂起，故没有对应的 `~/.cloudcli/voice-realtime-log/<connectionId>.jsonl` 读数可补。此项按 DoD 如实记为「未复现」，不替代 AC4。
