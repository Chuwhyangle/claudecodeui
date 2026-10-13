---
id: gap-voice-uplink-vad-node-backends
title: 服务端上行 VAD 的 Node 侧三后端层（Silero/TEN/WebRTC）：运行时选型实测、16k/PCM16/320
  样本网格契约、缺权重或缺依赖时明确 bypass 读数、零合成零外传
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

在**服务端 Node/TS** 侧提供上行 VAD 的**分类器后端层**：三后端（Silero / TEN / WebRTC）可配置，缺权重或缺依赖时**明确失败或安全 bypass**，绝不静默降级成"装了过滤器但其实没过滤"。

**本轮只交付后端层**，不接生产链路（接线是 `gap-voice-uplink-vad-production-seam`）。⛔ 本轮禁止重启服务、禁止打开任何生产配置。

**关键可行性事实（本轮勘察实测）**：

- 现有四个实验引擎**全是 Python**（`experiments/voice-vad/engines/{silero,ten,webrtc,fsmn}.py`，走 onnxruntime 与 `webrtcvad-wheels`），而服务端是 Node/TS ⇒ **不能直接复用**，后端层必须先在 Node 侧落地。
- 仓库现有唯一推理依赖是 **`onnxruntime-web` 1.30.0**（`package.json:200`），**没有** `onnxruntime-node`、没有任何 Node VAD 包。
- 权重**不在仓库内**：实测存在于 `/data/home/yale/work/voice-vad-engines/{silero,ten}/*.onnx`（另有 `/tmp/vad5/models/ten-vad.onnx`）⇒ "缺权重"是**常态**而非异常路径，必须有明确行为。
- 统一网格契约（实验适配器文档所载）：**16 kHz 单声道 PCM16 输入、20 ms 一帧 = 320 样本 = 640 字节**。

**已有的同形先例**（本任务应照它的形状写，不要另造结构）：`voice-realtime-silence-tail.ts` 是一个纯函数门控模块 + 一份确定性单测，且它把"何时判静音"与"发不发"分开。

## Plan

1. **运行时选型以读数定案**（不预设）：候选 = `onnxruntime-node`（原生依赖，需评估安装/CI 代价）vs 复用已在依赖里的 `onnxruntime-web` 的 wasm 后端在 Node 内跑。给出两者的实测：能否加载同一份 ONNX、单帧推理耗时、进程 RSS 增量、是否需要 postinstall 原生编译。选型结论与读数写进 `## Evidence`。
2. 定义后端接口（每 20 ms 帧 → speech 概率或判定），并实现三后端适配。**WebRTC 后端**若在 Node 侧无可用包，如实记录并给出该后端的明确不可用行为（见 AC3），不得伪装成可用。
3. **缺权重/缺依赖的行为**：加载失败 ⇒ 明确的错误读数 + 安全 bypass（按"全部放行"处理，即不过滤），并在读数里标明 `bypassed` 与原因；⛔ 绝不出现"声明已启用但实际不过滤"的静默态。
4. 确定性测试：网格契约（非 16 kHz/非 PCM16/非 320 样本 ⇒ 明确拒绝）、三后端各自的判定、缺权重 ⇒ bypass 且读数含原因、无任何合成零样本、门控输出与输入共享同一 PCM（保留下来的样本逐字节等于输入）。
5. 资源读数：单帧推理 CPU、RTF、RSS 增量（对照实验侧已测 Silero RTF 0.0027 / 峰值 RSS 134.5 MB）。
6. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [ ] AC1 运行时选型的**实测**对照写入 `## Evidence`：至少含"能否加载同一份 ONNX、单帧推理耗时、RSS 增量、是否需原生编译"四项读数，并据此定案。
- [ ] AC2 后端接口与三后端（Silero / TEN / WebRTC）在 Node 侧可调用；逐后端给出对已知输入帧的判定读数。
- [ ] AC3 **缺权重/缺依赖 ⇒ 明确失败或安全 bypass**：给出实测（把权重路径指向不存在的位置）—— 读数必须含 `bypassed` 与原因字符串；假形态：静默"已启用但全放行且读数无 bypass 标记" ⇒ 红。
- [ ] AC4 网格契约：非 16 kHz / 非 PCM16 / 帧长非 320 样本 ⇒ 明确拒绝（给出实测错误读数），不得静默按错格处理。
- [ ] AC5 **零合成**：模块 `grep -cE 'Buffer\.alloc\('` 的**调用点** = 0；被保留的样本逐字节等于输入 PCM（测试断言 `frame.equals(input.subarray(...))`）。
- [ ] AC6 资源读数：单帧推理 CPU、RTF、RSS 增量，并写出与实验侧（Silero RTF 0.0027、峰值 RSS 134.5 MB）的对照。
- [ ] AC7 **数据不外传**：模型本地加载；`## Evidence` 给出该模块的网络引用点审计（应为 0）；单测在无网环境下通过。
- [ ] AC8 不改生产默认值与链路：`git diff --name-only` 不含 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`；`VOICE_REALTIME_SILENCE_TAIL` 仍为关；不重启 :3001（前后 pid 相同，写出读数）。

## DoD

Node 侧有三后端可调用的上行 VAD 分类器层，带确定性测试；缺权重/缺依赖时有明确的 `bypassed` 读数而非静默放行；网格契约被强制；资源与零外传有读数；生产链路与默认值未被触碰。

## Touches

- server/modules/voice-realtime/voice-realtime-uplink-vad.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts (new)
- server/modules/voice-realtime/voice-realtime-turn-detection.ts
- server/modules/voice-realtime/voice-realtime-silence-tail.ts
- package.json
- tasks/gap-voice-uplink-vad-node-backends.md

## Notes

**为什么 Touches 含 `voice-realtime-silence-tail.ts`**：它是同形的纯函数门控 + 单测先例，本任务照它的形状写；若无需改动则不改。

**不做**：不接生产链路；不改任何默认值；不重启服务；不替换或修改既有 STS 与 localSpeechGate。