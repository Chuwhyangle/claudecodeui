---
id: gap-voice-uplink-vad-production-seam
title: 上行 VAD 接入生产缝（ws-proxy:3369–3395）且 DEFAULT OFF：关着时逐字节不变、localSpeechGate 与
  noteLocalActivity 不受影响、只改 append 帧型、exit 由用户动作触发 commit+response.create
status: todo
labels:
  - gap
parent: null
children: []
extra:
  acceptance: test -f
    server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
depends_on:
  - gap-voice-uplink-vad-node-backends
---
## Proposal

把已实测的上行 VAD **接进生产链路**，但 **DEFAULT OFF**：关着的时候老链路的行为**逐字节不变**。本轮**不重启服务、不打开任何生产配置**。

**接线位置（本轮勘察实测，已定位）**：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:3369–3395` —— STS 门控就装在这里，且它已经解决了本任务最危险的耦合。

**既有先例给出的三条纪律（必须原样遵守）**：

1. **`reportLocalSpeechBoundary(localSpeechGate.observe(frame.audio))` 必须先喂、无条件喂**（`:3381`）。理由是代码注释明写的：continuous 模式下**上游自己的 `server_vad` 才是 endpointing**，若这段音频变哑，relay 就再也无法知道发生过一句。
2. **`bridge.noteLocalActivity?.()` 必须对每一个浏览器帧调用，转发与否都一样**（`:3393` 前）。理由（`voice-realtime-bridge.service.ts:668–684` 逐字）：上游池把 `sendAudioFrame` 当**连接活动时钟**，删帧会让它按 `idleRotateMs` 轮换到一个"其实从未空闲"的会话上，实测上游 ~304 s 无接收会被对方关闭。**这正是"过滤上行 PCM"最容易踩断的一根线。**
3. **关着的时候必须是同一条快路径**：现有代码 `if (silenceTail === null) { bridge.sendAudioFrame(frame.audio); return; }` —— 新门控也要有等价的 `=== null` 快路径，让默认行为在**代码路径上**而不是只在结果上等于今天。

**exit 路径**：由**用户点击退出这一显式动作**触发 `input_audio_buffer.commit` + `response.create`，随后有界等待再关闭。它是「不发 response.create」的**唯一有界例外**，作用域仅限退出；⛔ 正常流的发送决策**不得**由上游 VAD 边界事件驱动。

## Plan

1. 在 `:3369–3395` 的缝上加一层新门控，形状照 STS：读入帧 → 决定哪些 append 出线。`=== null` 快路径与今天逐字节相同。
2. 保持纪律 1、2 不动：`localSpeechGate` 与 `noteLocalActivity` 的喂法原样保留在门控之前、无条件执行。
3. **与 STS 的关系必须显式定案**（两者都开会怎样）：给出明确规则（互斥并报错读数，或定义组合顺序）与实测读数。⛔ 不允许"两个都开着时行为未定义"。
4. `a` 由**解析后的** `turn_detection.silence_duration_ms` 导出（`voice-realtime-turn-detection.ts` 是唯一来源），不写死；首段静音整段丢弃；短于 a 的停顿与轻声**整段保留**；零合成。
5. exit 路径接线：用户动作触发的 commit + response.create + 有界等待，假形态（直接关闭）可红。
6. 确定性测试：默认关时喂入一串帧，断言送出的帧序列与今天**逐帧逐字节相同**；开启时断言首段丢弃/开头 a 保留/短停顿保留/localSpeechGate 与 noteLocalActivity 的调用次数不变。
7. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [ ] AC1 **默认 OFF 且逐字节不变**：默认配置下把同一串浏览器帧喂进 proxy，断言 `sendAudioFrame` 收到的帧序列与改动前**逐帧逐字节相同**（给出前后对照读数）；假形态：默认值被打开 ⇒ 红。
- [ ] AC2 `=== null` 快路径存在：默认路径**不构造任何门控对象**、不加载任何模型（`## Evidence` 给出该分支的调用读数或代码路径证据）。
- [ ] AC3 **`localSpeechGate` 无条件先喂**：开启门控后，被过滤掉的那些帧**仍然**产生相同的 `observe` 调用（给出计数前后对照）。
- [ ] AC4 **`noteLocalActivity` 对每一帧调用**：开启门控后其调用次数 = 浏览器帧数（不是转发帧数）；假形态：只在转发帧上调用 ⇒ 红。
- [ ] AC5 **只改 append**：正常流里代码发送的帧型集合与今天相同 —— ⛔ 无 `response.create`、无 `input_audio_buffer.commit`、无 `session.update`、无 `conversation.item.create`；`turn_detection` 未被改（给出帧型审计读数）。
- [ ] AC6 **与 STS 的关系已定案**：给出两者都开时的明确规则与实测读数；⛔ 未定义行为 ⇒ 红。
- [ ] AC7 exit 路径：用户动作触发 `commit` → `response.create` → 有界等待 → 关闭，顺序被断言；假形态（直接关闭）⇒ 该断言红。
- [ ] AC8 `a` 由解析值导出：把 `VOICE_REALTIME_TURN_DETECTION_SILENCE_MS` 配成非默认值，断言保留窗跟随；写死 400 ⇒ 红。
- [ ] AC9 确定性测试 `npx tsx --tsconfig server/tsconfig.json --test <本任务测试文件>` 退出 0；含首段丢弃、开头 a 保留、短停顿整段保留、零合成四类。
- [ ] AC10 不改其它默认值、不重启 :3001（前后 pid 相同，写出读数）；`VOICE_REALTIME_SILENCE_TAIL` 仍为关。

## DoD

上行 VAD 已在生产缝上可用且默认关闭；关着时老链路逐字节不变（有前后对照读数）；开着时不破坏 `localSpeechGate` 的上游边界读数、不破坏上游池的活动时钟、只改 append 帧型；exit 路径由用户动作触发且顺序被断言；与 STS 的组合关系已定案；生产配置未被打开、服务未被重启。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-uplink-vad.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts (new)
- tasks/gap-voice-uplink-vad-production-seam.md

## Notes

**依赖**：实现依据是 `gap-voice-uplink-vad-node-backends` 交付的 Node 侧后端层（`depends_on` 已设该边）。

**为什么强调 `noteLocalActivity`**：`voice-realtime-bridge.service.ts:668–684` 逐字记载了这条耦合的实测代价（`idleRotateMs` 轮换 + 上游 ~304 s 无接收被关闭）。删帧而不喂活动时钟，会把"过滤省字节"变成"会话被轮换掉"。

**不做**：不打开任何生产配置；不重启服务；不改 STS 与 localSpeechGate 自身的行为。