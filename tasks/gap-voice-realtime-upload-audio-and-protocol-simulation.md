---
id: gap-voice-realtime-upload-audio-and-protocol-simulation
title: 语音前端音频文件上传 + /voice-realtime 代理协议模拟测试（AC-315）
status: done
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-315
---
## Proposal

去重检查（2026-10-09 立案时）：grep `tasks/*.md goals/*.md` 未命中任何已有的"上传/protocol-simulation"任务；唯一相关命中是
`gap-voice-realtime-real-audio-paired-evidence`（GOAL-030/AC-309），那是用录音语料跑模型对比评测，不是本任务要做的"前端上传 UI + CI 协议模拟"，不是重复。

背景：`gap-voice-realtime-browser-e2e-current-session`（AC-312）落地了浏览器语音闭环，但 park 在 `needs-human`——它唯一未勾的 AC5
（真实麦克风+真实网络的人工走查）结构性地只能人工验收，这是 AC-312 自己的记录明确登记过的，执行者不得代勾。2026-10-09 人 yale 在此基础上
补充明确需求：Web 前端同时提供麦克风与文件上传两条音频输入，上传路径用于固定语料自动化 e2e；另需协议/接口层自动测试模拟 chunk/打断/重连/
并发 response/工具调用回填。要求 CI 能在**零物理麦克风**条件下全自动验收这条新增范围，不得继承 AC-312/AC5 的人工门。

方案（已落地，见 Touches）：

1. **复用而非另起管线**：AC-312 的前端模块已经写好但停留在未合并的 worktree/branch
   `task/gap-voice-realtime-browser-e2e-current-session`（commit `657e9ca7`）。本任务从该 commit 分支出
   `task/gap-voice-realtime-upload-and-protocol-simulation`，继承其 `useVoiceRealtimeSession`/`VoiceRealtimeControl`/
   `voice-realtime-ws-proxy.service.ts`，不重新实现麦克风闭环的任何一部分。
2. 新增 `src/modules/chat/voice-realtime/audioSource.ts`：抽出 `VoiceRealtimeAudioSource` 接口
   （`start(onFrame)`/`stop()`），把原来内联在 `useVoiceRealtimeSession.start()` 里的 `getUserMedia`+`AudioWorklet` 逻辑搬进
   `microphoneAudioSource()`，新增 `fileAudioSource(file)`（真实 `AudioContext.decodeAudioData` 解码 + 按 20ms 分帧 + 逐帧 yield）。
   这个接口形状和 `src/modules/chat/hooks/useVoiceInput.ts` 既有的 `VoiceCaptureEngine` 是同一种模式，不是第二套设计。
3. 重构 `useVoiceRealtimeSession.ts`：把 socket 生命周期 + 编码发帧抽成共享的 `connect(source)`/`beginCapture(source)`，
   `start()`＝`connect(microphoneAudioSource())`，新增 `startWithFile(file)`＝`connect(fileAudioSource(file))`——两条路径到
   `/voice-realtime` 代理之后完全是同一段代码，一行都不分叉。
4. `VoiceRealtimeControl.tsx` 新增上传按钮 + 隐藏 `<input type="file">`（`data-testid="voice-realtime-upload"` /
   `voice-realtime-upload-input`），选中文件即走 `startWithFile`。
5. 新增 e2e：`e2e/voice-realtime-upload-fixture.spec.ts`——用 Node 现场合成的 16kHz 单声道 WAV（固定语料，非空录音）
   通过真实 `setInputFiles` 上传，全程不调用 `getUserMedia`，不存在任何麦克风替身代码路径；复用 AC-312 同款 fake 上游
   + debug-agent 会话武装套路，断言编辑后的文本真的落进 transcript（reload 后仍可见），且上游真的收到 >1 个
   `input_audio_buffer.append` 帧（证明真的分帧了，不是一帧糊弄）。`playwright.config.ts` 的 `DEBUG_AGENT_SPEC_FILES`
   和 `voiceRealtimeSelection` 两处登记加了这个新文件名。
6. 新增协议模拟：`server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`——offline
   `node:test`，用既有 `realtime-bridge-harness.ts` 的 `createFakeTransport`（AC-310/AC-311 同款）和一个极简
   `EventEmitter` 假浏览器 socket 直接驱动 `handleVoiceRealtimeConnection`，五个场景见下方 AC。
7. **顺带修了一个真 bug**：写并发竞态场景时发现 `voice-realtime-ws-proxy.service.ts` 的 `pending` 是单槛位，
   第二个 `session_send` function_call 在第一个被裁决前到达会静默覆盖 `pending`，导致第一个调用的 `await` 永远不
   settle（死锁）。修法：第二个调用直接拒绝（`throw`），和既有"用户拒绝"分支同款语义，不引入排队。现场验证：
   去掉这段保护重跑测试，该场景真的在 2000ms `waitFor` 超时后失败，证明断言不是摆设；恢复保护后重新跑绿。

## 边界/不做

- 不碰 AC-312 自己的 AC5（真实麦克风+真实网络人工走查）；那条的 `needs-human` 是它自己的正确终态，本任务不解除它，
  也不替代它——两条判据独立验收。
- 不实现跨会话/跨项目的上传路由；上传路径绑定的仍是语音连接当时打开的那一个会话，和麦克风路径完全同构。
- 不新增审批/确认层；沿用 GOAL-031 既有的"参数白名单 + 可编辑意图"机制，上传路径的意图确认流程与麦克风路径字节级相同。

## AC

- [x] AC1 文件上传复用麦克风同一条管线：`useVoiceRealtimeSession` 的 `connect`/`beginCapture` 对两种音频源只有一行
  `source` 参数的差别；`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` → `1 passed`，全程未调用
  `getUserMedia`。
- [x] AC2 固定语料自动化 e2e：上传的 WAV 是测试现场合成的确定性语料（220Hz 正弦音，0.6s，16kHz 单声道），上游真的
  收到 >1 个音频帧（`audioFrameCount() > 1`），证明真的分帧重放而不是一次性糊弄。
- [x] AC3 协议/接口层模拟交互测试覆盖用户要求的六个维度中可在代理层独立验证的五个（chunk 时序、打断、
  断线/重连清理、并发 response 竞态、工具调用回填）：
  `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`
  → `tests 5, pass 5, fail 0`。
- [x] AC4 并发竞态是真断言，不是摆设：去掉 `voice-realtime-ws-proxy.service.ts` 里新加的单槛位保护后，重跑同一个
  测试文件，"concurrent response race" 用例在 2000ms `waitFor` 超时后真的失败（`✖ ... (2002.759952ms)`），恢复保护后
  重新跑绿（`5/5 pass`）。
- [x] AC5 不继承 AC-312/AC5 的人工门：本任务的两条判据命令全程不要求物理麦克风、不要求人工操作，可在任意 CI
  runner 上重复执行。
- [x] AC6 静态门：`npm run typecheck`（client+server+scripts 三个 tsconfig）exit 0；`npm run lint` exit 0
  （oxlint 仅有与本次改动无关的既有 warning，零新增 warning，触碰到的 7 个文件均未出现在 warning 列表里）。

## DoD

两条判据命令都已在本次改动的 worktree 里现场跑绿（见上方 AC 的具体输出），`npm run typecheck`/`npm run lint` 均
exit 0。代码目前在新分支 `task/gap-voice-realtime-upload-and-protocol-simulation`（从 AC-312 的 `657e9ca7` 分支出，
commit `19ed0cb2`）——故意不落在 AC-312 自己的 `task/gap-voice-realtime-browser-e2e-current-session` 分支上，这样
AC-315 的合并不会被 AC-312 悬而未决的 `needs-human` 卡住。

## Touches

- `src/modules/chat/voice-realtime/audioSource.ts`（new）
- `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts`
- `src/modules/chat/voice-realtime/VoiceRealtimeControl.tsx`
- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`
- `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`（new）
- `e2e/voice-realtime-upload-fixture.spec.ts`（new）
- `playwright.config.ts`

## Notes

- **与 AC-312 的协调**：AC-312 的 `needs-human` 不因本任务而改变——两者是 GOAL-031 下两条独立判据，AC-312 卡在人工
  麦克风走查，AC-315 刻意绕开那条路径。本任务的分支从 AC-312 的 commit 分支出是为了**继承代码**，不是为了共享
  判据或共享 `needs-human` 状态；两个分支各自独立推进到 fan-in。
- **已知限制（现场发现，诚实登记）**：如果有一次 Playwright 调用同时选中
  `voice-realtime-live-session-send.spec.ts` 和 `voice-realtime-upload-fixture.spec.ts` 两个文件（例如不加过滤的
  全量 e2e 跑），两者会在同一个共享 server 进程里各自尝试注册自己的硬编码用户名，而这个仓库的认证是
  single-user 系统——第二个文件的注册/登录都会 403。这不是本任务引入的新问题：仓库里任何两个各自硬编码用户名
  的 e2e 文件被同一次 Playwright 调用同时选中都会撞到同样的限制（这是现有 single-user 认证设计和"每个判据只跑
  自己那一个 spec 文件"这个既有调用惯例的交叉产物）。AC-315 自己的判据命令只跑自己这一个文件，不受影响；这里
  诚实登记是为了不让下一个人以为这是本任务留下的 bug。
