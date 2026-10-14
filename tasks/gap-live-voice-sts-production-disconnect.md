---
id: gap-live-voice-sts-production-disconnect
title: 取消 createSilenceTailGate/VOICE_REALTIME_SILENCE_TAIL 的生产调用——默认原样透传，旧 env
  显式 deprecated/ignored，STS 模块与测试原样归档不删
status: todo
labels:
  - gap
  - P0
parent: null
children: []
extra:
  acceptance: test -f
    server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts
---
## Proposal

**人 yale 2026-10-14 裁定**：「STS 已证实无效，取消生产调用」——依据是本会话此前的只读架构审计：STS（`voice-realtime-silence-tail.ts`）是一套独立实现的自适应 RMS/dBFS 静音检测+上行抑制状态机，默认关，由 `VOICE_REALTIME_SILENCE_TAIL` 开启；人已看过其实测读数并裁定它不再值得在生产路径上保留。

**本任务只断开生产调用路径，不删除模块/测试/历史读数**。代码现状（本轮核实）：

- `server/index.ts:591-596` 在 `buildVoiceRealtimeSeams` 里调用 `resolveSilenceTail(process.env)` + `describeSilenceTail(...)` 并把说明行写日志。
- `server/index.ts:820-836`：**唯一**把 `silenceTail` 对象塞进 `seams.silenceTail` 的地方——条件是 `silenceTail.enabled && transportChoice !== 'continuous'`（这里 `transportChoice` 是单条连接的覆盖选择，不是部署级默认值；部署级默认现在已是 continuous，见 `voice-realtime-mode.ts`）。
- `voice-realtime-ws-proxy.service.ts:1769-1810`：`silenceTailOptions = seams.silenceTail === undefined || segmentedRelay ? null : seams.silenceTail`，非 null 时 `createSilenceTailGate(silenceTailOptions)` 真正构造门控；同一段还有"STS 与 uplinkVad 同时在场时 STS 赢、uplinkVad 被拒"的互斥分支（`uplinkVadRequested && silenceTail !== null` ⇒ 拒绝并记日志）。

**断开方式**：`server/index.ts` 的组装函数**永远不再**把 `silenceTail` 填进返回的 seams 对象，不论 `VOICE_REALTIME_SILENCE_TAIL` 取何值；`voice-realtime-ws-proxy.service.ts` 本身**不改**（它仍然"认识"`seams.silenceTail` 这个字段——这是 `uplinkVad` seam 已经验证过的同一个模式：字段存在、测试可以直接构造它，但生产组装根不再喂）。这样：

1. **默认行为**：未来任何连接，无论 env 怎么设，都只会走 `silenceTail === null && uplinkVad === null` 的快路径（`frame.audio` 原样 `bridge.sendAudioFrame`），与"STS 存在之前"逐字节相同。
2. **不形成双门控**：既然生产永远不填 `seams.silenceTail`，`voice-realtime-ws-proxy.service.ts` 里"STS 赢过 uplinkVad"的互斥分支在生产里永远不会被触发——等 `gap-live-voice-uplink-vad-production-arm-point` 落地后，uplinkVad 的 `uplinkVadRequested` 判断不会再撞见一个非 null 的 `silenceTail`。
3. **旧 env 显式降级**：设置 `VOICE_REALTIME_SILENCE_TAIL` 时，生产日志必须打一行清楚的"deprecated / ignored"说明（不是沉默吞掉，也不是继续打印"已启用"式的旧文案），且实际转发字节不受这个 env 值影响。
4. **保留证据**：`voice-realtime-silence-tail.ts`、其既有测试（`voice-realtime-silence-tail-suppression.test.ts` 等）、`experiments/voice-realtime-silence-tail-suppression/`、`docs/operations/voice-realtime-silence-tail-suppression-probe.md` 等**原样保留，不删除、不改**——它们仍然证明 STS 模块本身在隔离测试下行为正确，只是生产不再调用它。

## Plan

1. 在 `server/index.ts` 的 `buildVoiceRealtimeSeams` 里：保留 `resolveSilenceTail`/`describeSilenceTail` 的调用（如实读出 env 值），但把原有的"启用时打印说明"替换/追加为一条明确的 deprecation 日志（当 `silenceTail.enabled` 为真时）；删除第 820-836 行那段把 `silenceTail` 塞进返回对象的条件分支，改成**永远不**包含该字段（等价于把条件结果固定为 `{}`）。
2. 不触碰 `voice-realtime-ws-proxy.service.ts`、`voice-realtime-silence-tail.ts` 本身——二者的互斥分支与门控逻辑继续存在，只是生产不再喂给它们非 null 的 seam。
3. 新测试 `voice-realtime-silence-tail-deprecated.test.ts`：直接调用 `buildVoiceRealtimeSeams`（或其等价可测导出）在 `VOICE_REALTIME_SILENCE_TAIL` 设为真值时的返回对象，断言 **返回对象里没有 `silenceTail` 键**，且 `log` 回调收到一行包含"deprecated"/"ignored"字样的说明。
4. 既有 STS 测试（`voice-realtime-silence-tail-suppression.test.ts` 及同名 criterion）单文件运行必须保持退出 0——它们直接构造 `voice-realtime-ws-proxy.service.ts` 的 seam（不经过 `server/index.ts`），不受本次改动影响；本任务需要实际跑一次确认，不能只靠推理。
5. 若 `describeSilenceTail` 的既有导出被其他模块/测试原样依赖其旧文案，不改它本身，deprecation 文案在 `server/index.ts` 里新增，不改 `voice-realtime-silence-tail.ts` 的导出契约。

## AC

- [ ] AC1 任意 `VOICE_REALTIME_SILENCE_TAIL` 取值（包括合法启用值）下，`buildVoiceRealtimeSeams(...)` 返回对象**不含** `silenceTail` 键；取假形态：恢复第 820-836 行的旧分支 ⇒ 本断言红。
- [ ] AC2 `VOICE_REALTIME_SILENCE_TAIL` 设为真值时，`log` 回调收到的行里包含"deprecated"或"ignored"（中英文皆可，但必须清楚表达"不再生效"），且**不再**出现旧的"已启用 tailMs=... prerollMs=..."式文案；未设该 env 时不打印任何相关行（沉默=未配置，与今天行为一致）。
- [ ] AC3 **逐字节不变**：用同一串浏览器帧跑 `voice-realtime-ws-proxy.service.ts` 的生产路径（经由新的 `buildVoiceRealtimeSeams` 返回值构造 proxy），`VOICE_REALTIME_SILENCE_TAIL` 设为真值 vs 不设，两次喂进 `bridge.sendAudioFrame` 的帧序列**逐帧逐字节相同**；取假形态：若断开不完整（仍偶尔构造门控）⇒ 两次序列不同，本断言红。
- [ ] AC4 **不形成双门控**：构造一个同时满足"uplinkVad 已请求"与"STS env 设为真值"的生产场景（走 `buildVoiceRealtimeSeams` 的真实返回值），断言 `voice-realtime-ws-proxy.service.ts` 里旧的"STS 赢"日志行**不出现**——因为 `seams.silenceTail` 从未非 null，`uplinkVadRequested` 分支里该 if 分支天然不触发；该 AC 暂时只能断言"日志不出现"，等 `gap-live-voice-uplink-vad-production-arm-point` 落地后由那边的回归测试接着验证 uplinkVad 本身正常工作。
- [ ] AC5 `localSpeechGate.observe` 的调用点、`bridge.noteLocalActivity?.()` 的调用条件、`turn_detection` 的解析（`resolveTurnDetection`）**逐字节未改**——给出 diff 读数（这三者所在的代码段不在本次 diff 里）。
- [ ] AC6 既有 STS 测试文件（列出具体文件名）单文件运行退出 0，证明历史证据未被破坏。
- [ ] AC7 未重启 `:3001`（pid 前后相同，写出读数）、未改线上 `.env`。

## DoD

生产组装根不再有任何路径能让 `createSilenceTailGate` 被调用；旧 env 变量被显式标注为 deprecated/ignored 而非静默失效；默认转发行为逐字节不变；STS 模块代码、测试、实验文档原样保留；`localSpeechGate`/`noteLocalActivity`/`turn_detection` 未受影响。

## Touches

- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts (new)
- tasks/gap-live-voice-sts-production-disconnect.md

## Notes

**查重（2026-10-14）**：`gap-live-voice-silence-tail-suppression`、`gap-live-voice-silence-tail-suppression-probe`、`gap-voice-server-vad-three-arm-replay-on-third-test-corpus` 均 `done`，是 STS **落地与实测**本身，不是"取消生产调用"——无重复。

**显式不做**：不删除 `voice-realtime-silence-tail.ts`、不删除其测试、不删除 `experiments/voice-realtime-silence-tail-suppression/` 或相关 `docs/operations/*silence-tail*`；不改 `voice-realtime-ws-proxy.service.ts` 内部对 `seams.silenceTail` 的处理逻辑本身（保留给未来可能的测试/实验直接构造）。

**依赖关系**：`gap-live-voice-uplink-vad-production-arm-point` depends_on 本任务——该任务要在一个"STS 已经断开"的 `server/index.ts` 上接新的 env 分支，避免两个任务同时改同一个函数的冲突。