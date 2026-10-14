---
id: gap-live-voice-uplink-vad-production-arm-point
title: 上行 VAD（Silero/TEN/WebRTC）生产显式启用入口：env 接线 + 连接级状态机
  disabled/loading/ready/bypassed/failed + 帧/字节计量 + 模型生命周期 + 生产故障安全旁路（默认仍 OFF）
status: ready
labels:
  - gap
  - P0
parent: null
children: []
extra:
  acceptance: test -f
    server/modules/voice-realtime/tests/voice-realtime-uplink-vad-arm-point.test.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-uplink-vad-arm-point.test.ts
depends_on:
  - gap-voice-uplink-vad-weights-abi-isolation-probe
  - gap-live-voice-sts-production-disconnect
---
## Proposal

**人 yale 2026-10-14 裁定**：在取消 STS 生产调用（`gap-live-voice-sts-production-disconnect`）的同时，同步推进上行 VAD 的生产显式启用入口——**要求执行落地，不只是方案**。本会话此前的只读架构审计已经确认两件事，本任务要逐一解决：

1. **生产组装根从不构造 `seams.uplinkVad`**：`server/index.ts` 的 `buildVoiceRealtimeSeams`（第 538-700+838 行）解析了 `segmentedRelay`/`silenceTail`/`turnDetection`/`spendWindowLimit`，但没有任何 `VOICE_REALTIME_UPLINK_VAD*` 环境变量解析，没有任何代码路径把 `uplinkVad` 字段填进返回对象。`voice-realtime-ws-proxy.service.ts:1786` 的 `seams.uplinkVad !== undefined` 因此在生产里永远是 `undefined`。**这是已知且此前被刻意搁置的缺口**（`gap-voice-uplink-vad-production-seam` 任务 AC10 的 Evidence 原话："新门控在生产中为关"，且未留下任何能从环境变量点燃它的开关）。
2. **`enqueueUplinkVad` 的失败路径会静默丢帧，不是故障安全旁路**：`voice-realtime-ws-proxy.service.ts` 的 `enqueueUplinkVad`（约第 1826-1838 行）里，`gate.observe(audio)` 抛出的任何**非** `UplinkVadGridError` 异常只会落进 `.catch` 写一行日志，**该帧本身永远不会被转发**（`sendAudioFrame` 从未被调用），后续帧仍继续喂进同一个已经出过异常的 classifier。对一个"保存上行字节"的性能优化功能来说，一次分类器内部错误导致用户的语音帧被悄悄吞掉，是和"把人的话听没了"同一类缺陷——必须修成**失败 = 整条连接此后全透传**，不是"这一帧没了"。

本任务范围**明确不包括**：给 Silero/TEN 下载权重、做跨连接的模型会话池化（留痴 Notes 作未来工作）。默认行为**仍然是 OFF**——不设新 env 时，生产连接的字节流与今天逐字节相同。

## Plan

1. **env 接线**（`server/index.ts`，在 `gap-live-voice-sts-production-disconnect` 落地后的版本上做）：新增 `VOICE_REALTIME_UPLINK_VAD`（取值 `off`（默认）/`silero`/`ten`/`webrtc`，未知值回退 `off` 并记一行日志，参照 `resolveVoiceRealtimeMode` 的"typo 不得静默通过"模式）；新增对应权重路径 env（如 `VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH`，WebRTC 不需要）。解析函数放在 `voice-realtime-uplink-vad.ts` 或新文件，命名与既有 `resolveSilenceTail`/`resolveTurnDetection` 同构。
2. **连接级状态机**：定义 `UplinkVadConnectionState = 'disabled' | 'loading' | 'ready' | 'bypassed' | 'failed'`，语义：
   - `disabled`：env 未设或设为 `off` —— 与今天行为相同，走 `uplinkVad === null` 快路径。
   - `loading`：已请求某后端，分类器正在异步构造（`InferenceSession.create`/权重检查尚未返回）——**此状态下到达的帧必须直接透传，不得缓冲等待**（现有 `createUplinkVadGate` 假设分类器已就位；构造中的帧要走和 `disabled` 一样的快路径,直到状态翻 `ready`/`bypassed`/`failed`）。
   - `ready`：分类器 `status === 'available'`，正常门控。
   - `bypassed`：分类器报告 `status === 'unavailable'`（缺包/缺权重）——连接级状态要**可观测**（日志/`session_status` 读数），不能只在逐帧 verdict 里体现（现状：`bypassed` 只是 `UplinkVadFrameVerdict` 的字段，没有连接级汇总）。
   - `failed`：运行期分类器抛出非 `UplinkVadGridError` 异常——**此后该连接的所有帧改为直接透传**，不再调用 `classify()`，并记一行 `failed` 日志；不得再次尝试重建分类器（一次失败即整条连接退化，简单明确）。
3. **修复静默丢帧**：改 `enqueueUplinkVad`，让抛异常的那一帧本身被转发（fail-open），并把连接状态翻到 `failed`，此后短路掉 `gate.observe` 直接 `sendAudioFrame`。
4. **帧/字节计量**：连接关闭（`exitUplinkVad`/`teardown`）时，把 `UplinkVadGateStats`（`sent`/`headKept`/`dropped`/`bypassed`）连同浏览器总帧数、转发字节数、丢弃字节数写一行汇总日志（当前 `gate.flush()` 的返回值被丢弃，改成记录）。
5. **模型生命周期**：确认 `classifier.close()` 在**每一条**退出路径（正常 exit、异常、`failed` 状态翻转后）都被调用恰好一次，不泄漏 ONNX session；新增测试覆盖"连接中途失败"与"连接正常退出"两条路径各自的 `close()` 调用次数。
6. **生产故障安全旁路**：新增端到端测试——用一个会在第 N 帧抛异常的假分类器，断言该帧及其后全部帧都被转发（不丢任何一帧的音频），且日志出现 `failed` 状态行。

## AC

- [x] AC1 **默认不变**：不设 `VOICE_REALTIME_UPLINK_VAD`（或设为 `off`）时，生产路径与今天逐字节相同；取假形态：解析函数默认值改成非 `off` ⇒ 红。
- [x] AC2 **状态机覆盖五态**：构造测试逐一驱动 `disabled→(请求)→loading→ready`、`...→bypassed`（分类器报 unavailable）、`ready→failed`（运行期异常）四条真实路径，每条都有可观测证据（日志行或可读的连接状态读数），且 `loading` 态下到达的帧被透传而不是缓冲等待。
- [x] AC3 **故障安全旁路（修复 #2 的缺陷）**：假分类器在第 N 帧抛非 grid 错误 ⇒ 该帧**仍被转发**（不是现状的静默丢弃），且此后所有帧均透传、不再调用 `classify()`；取假形态：还原旧的 `enqueueUplinkVad` ⇒ 该帧缺失，断言红。
- [x] AC4 **帧/字节计量**：连接关闭时日志含一行汇总，字段至少覆盖 `sent`/`headKept`/`dropped`/`bypassed` 四个累计数与浏览器总帧数；取假形态：删掉该日志行 ⇒ 红。
- [x] AC5 **模型生命周期无泄漏**：正常退出与 `failed` 退化两条路径下，`classifier.close()` 各被调用恰好 1 次（不多不少）；断言用假分类器的调用计数器。
- [x] AC6 **env 解析的假形态**：`VOICE_REALTIME_UPLINK_VAD` 设成拼写错误的值 ⇒ 回退 `off` 且记一行可见的报告（不得静默通过），与 `resolveVoiceRealtimeMode` 的 `invalid` 字段同构。
- [x] AC7 **不与 STS 复合**：显式开启 uplinkVad 时，构造一个同时设了（已 deprecated 的）`VOICE_REALTIME_SILENCE_TAIL` 的场景，断言 uplinkVad 正常工作、无"STS 赢"相关日志（因为 `gap-live-voice-sts-production-disconnect` 已确保 `seams.silenceTail` 永不非 null）。
- [x] AC8 **`localSpeechGate`/`noteLocalActivity`/`turn_detection` 回归**：uplinkVad 为 `ready`/`loading`/`bypassed`/`failed` 任一态时，`localSpeechGate.observe` 仍对每个浏览器帧无条件调用、`noteLocalActivity` 仍按浏览器帧数调用、`turn_detection` 解析未变——给出调用计数对照（这段逻辑本身不改，只需回归测试钉住，防止本任务的改动意外波及）。
- [x] AC9 用 `gap-voice-uplink-vad-weights-abi-isolation-probe` 的读数（WebRTC `available`）跑一次**真实**（非 mock）WebRTC 后端的 `ready` 态连接测试，证明该状态机在真实后端上可用，不只是对假分类器成立。
- [x] AC10 未重启 `:3001`、未改线上 `.env`（默认仍 off，不要求人现在就打开）；pid 前后相同的读数写入 Evidence。

## DoD

生产组装根存在一条真实可从环境变量驱动的上行 VAD 启用路径（默认 off），其连接级状态机的五个状态都有测试与可观测证据；此前审计发现的"分类器异常导致静默丢帧"被修复为连接级故障安全旁路；每条连接关闭时有完整的帧/字节汇总日志；模型会话的创建与释放在所有退出路径上不泄漏；STS 断开后两者不会复合；既有观测链路（localSpeechGate/noteLocalActivity/turn_detection）未受影响。

## Touches

- server/index.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/voice-realtime-uplink-vad-arm-point.ts (new)
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad-arm-point.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-live-voice-uplink-vad-production-arm-point.md

## Evidence

**AC10 — 未重启 `:3001`、未改线上 `.env`。** `:3001` 的监听进程在实现前后都是 **pid 2908057**（`node dist-server/server/index.js`，起于 Wed Oct 14 07:48:31 2026），实现期间未重启、未重建、未部署；`.env` 中 `VOICE_REALTIME_UPLINK_VAD` 出现次数为 0（`grep -c` 返回 0），即线上默认仍是 off，本任务没有把它打开。本轮（resume）复量同一读数：监听仍是 pid 2908057、`.env` 仍 0 命中。

**criterion 运行**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-uplink-vad-arm-point.test.ts` → 28 tests / 28 pass / 0 fail。相邻的 `voice-realtime-uplink-vad.test.ts`（纯分类器契约：零拷贝、零生产 seam 名）与 `voice-realtime-uplink-vad-seam.test.ts`（seam 消费侧）同跑通过：35 tests / 35 pass。

**关键实现读数**：
- AC1：`resolveUplinkVad({})` 与 `resolveUplinkVad({VOICE_REALTIME_UPLINK_VAD:'off'})` 同为 `{enabled:false, backend:null, weightsPath:'', invalid:null}`，`describeUplinkVad` 返回 `null`（无日志）；组装根仅在 `enabled && backend !== null` 时构造 arm point 并 spread `uplinkVad` seam。
- AC3：假分类器在第 4 帧（index 3）抛非 grid 异常——该帧经代理 `.catch` 内的 `gate.flush()` 被释放并**转发**（gate 在 `classify` 前已 push 该帧，异常时留其 pending，flush 按序释放为 bypassed），此后 4 帧全部短路转发，`inner.fed.length === 4` 证明失败后不再调用 `classify()`。假形态（去掉 catch 内的 flush）令该帧缺失而红。
- AC4：关连接日志 `uplink_vad summary: browserFrames=39 sent=25 headKept=21 dropped=14 bypassed=0 forwardedBytes=… droppedBytes=…`（`a = 400/20 + 1 = 21`），恰好一行。
- AC5：`close()` 幂等；加载中关闭时由 load continuation 释放迟到到位的分类器，恰好一次；代理正常退出与 failed 两条路径各 `close()` 一次。
- AC9：真实 `webrtcvad`（非 mock）到达 `state=ready`、`status=available`，对 ±8000 方波帧 verdict `bypassed=false`；整条连接的汇总 `bypassed=0`，即每一帧都真的过了模型。

**本轮（exited-not-landed 重试）补齐的落地读数**：上轮 fan-in suite 红两条，均已核对为**本任务 delta 造成**（delta-relatedness 提示把 `quay-test-script.test.ts` 报成 UNRELATED，是误报——它 pin 的是**文件总数**，新测试文件移动了这个数）：
- `voice-realtime-silence-tail-deprecated.test.ts` AC4 原断言 `assert.equal(source.includes('uplinkVad'), false, 'server/index.ts must not arm the uplink-VAD seam')` —— 该句 pin 的正是本任务要建的生产 arm 点（`gap-live-voice-sts-production-disconnect` 当时的"两门控都无生产 arm 点"读数）。已按新事实改写：AC4 的**主张不变**（代理的 STS-赢-up VAD 互斥分支在生产不可达），但理由改为**只由 STS 半边承载**（`silenceTail` 在生产恒 null），并新增两条读数——`region.includes('uplinkVad')`（arm point 确在组装点内）与 `resolveUplinkVad({}).enabled === false`（未设开关时仍不交 seam 给代理）。单跑：4 tests / 4 pass。
- `quay-test-script.test.ts`：本任务新测试文件把 `find server` 收集数 328→329 ⇒ AC2 pin `unknown=325→326`、AC3 pin `unknown=327→328`；同时 AC7 的覆盖率地板 296/328=90.2% → 296/329=89.97% ⇒ 红。已把 `voice-realtime-uplink-vad-arm-point.test.ts`（单文件实测 `duration_ms=2428.7`，取整 2429）追加进 `scripts/suite-duration-baseline.tsv`，数据行 296→297，头部记账句同步为 `covers 297/329`。单跑：14 tests / 14 pass。
- 该两文件与 baseline 均**不在**原 Touches，已随本次 `task_write` 声明（anti-drift 前置门要求）。

## Notes

**查重（2026-10-14）**：`gap-voice-uplink-vad-production-seam`（done）造了 `seams.uplinkVad` 字段本身与 ws-proxy 侧的消费逻辑，但 Evidence 明写"未做（刻意）：不打开任何生产配置"——即它**没有**做 env 接线，本任务是那个被刻意搁置的后续，不是重复。`gap-voice-uplink-vad-real-ab-and-e2e-verification`（done）是 dry-run/scripted 验证，不是生产 env 接线。

**明确不做**：不做跨连接模型会话池化/预热（Silero/TEN 每连接一次 `InferenceSession.create()` 的冷启动成本未测量，留作后续若要真正打开此功能前的前置读数任务）；不下载任何新模型权重；不在本任务里把默认值改成"开"——人要求的是"能被显式打开"，不是"现在就打开"。

**依赖顺序**：depends_on `gap-voice-uplink-vad-weights-abi-isolation-probe`（AC9 需要它的真实 WebRTC 可用性读数）与 `gap-live-voice-sts-production-disconnect`（避免两个任务同时改 `server/index.ts` 的同一函数产生冲突；AC7 需要在 STS 已断开的前提上验证）。

**Touches 说明**：arm point 按 `voice-realtime-uplink-vad.ts` 的字面 grep 契约（零分配原语、不提 ws-proxy）另起同级文件；`voice-realtime-uplink-vad.ts` 与 `voice-realtime-uplink-vad-gate.ts` 本次**未改动**，故从 Touches 移出。`server/modules/voice-realtime/index.ts` 因 `server/index.ts` 只从 barrel 导入（模块边界）而新增该模块的导出块。本轮再补三个由交付物**必然**牵动的文件：`voice-realtime-silence-tail-deprecated.test.ts`（其 AC4 曾以 `source.includes('uplinkVad') === false` 钉住"生产装配不 arm uplinkVad"，与本任务交付物直接矛盾，按新事实改写）、`server/shared/tests/quay-test-script.test.ts`（AC2/AC3 的 `unknown=` 是**收集文件数的绝对 pin**、AC7 是 90% 覆盖率地板，二者都随新增测试文件移动）与 `scripts/suite-duration-baseline.tsv`（按该文件既有记账惯例为新测试文件追加一行）。
