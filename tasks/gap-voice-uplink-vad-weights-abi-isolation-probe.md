---
id: gap-voice-uplink-vad-weights-abi-isolation-probe
title: 上行 VAD 三后端在本机权重/ABI 可用性的隔离实测，归档为探针+文档（不碰生产进程）——先于任何生产接线跑
status: todo
labels:
  - gap
  - P0
parent: null
children: []
extra:
  acceptance: test -f experiments/voice-uplink-vad-isolation-probe/probe.mts &&
    npx tsx --tsconfig server/tsconfig.json
    experiments/voice-uplink-vad-isolation-probe/probe.mts --report-only
    /tmp/uplinkvad-iso
---
## Proposal

**人 yale 2026-10-14 裁定（本会话只读审计之后）**：STS 已证实无效，取消生产调用；同步推进新上行 VAD 显式启用入口，但**优先**把三个后端（Silero/TEN/WebRTC）在本机的权重/ABI 可用性跑一次隔离实测，作为后续「启用入口」任务的前提证据，而不是边改生产代码边猜运行时状态。

**本轮只读审计已有的临时读数（需要被这个任务转成可复核、可归档的产物，而不是停在一次性 shell 输出里）**：

- `node -e "require('onnxruntime-node')"` / `require('sherpa-onnx-node')` / `require('webrtcvad')` 三者在**独立子进程**（未碰 `:3001`）里都能正常加载；`node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node`、`node_modules/webrtcvad/build/Release/vad.node` 均是匹配本机 ABI 的已编译产物。
- `server/modules/voice-realtime/voice-realtime-uplink-vad.ts:267` 的 `weightsPath` 对 Silero/TEN 是必填项；生产代码里**没有任何地方**给它赋值。本机唯一能找到的 `.onnx` 权重文件在 `/data/home/yale/silero-vad-probe/*.onnx`——这是用户自己在 `$HOME` 下的实验目录，**不受本仓库管理**，没有任何代码指向它，不能被当作"权重已就位"的证据。
- WebRTC 后端不需要权重文件，是三者里唯一此刻具备「包+ABI+无权重依赖」三项齐备的。

**本任务要把上面这些读数变成可重跑、可归档、不依赖某次人工 shell 会话记忆的东西**；且不下载任何新模型权重——若 Silero/TEN 缺权重，如实记录为"不可用"，不得临时下载凑读数。

## Plan

1. 新增 `experiments/voice-uplink-vad-isolation-probe/probe.mts`：对三个后端各跑一次 `voice-realtime-uplink-vad.ts` 导出的 `createUplinkVadClassifier`（或等价构造函数）的真实加载路径（**不 mock** `loadDependency`/`weightsExist`，走它们的默认实现），记录每个后端的 `status`（`available`/`unavailable`）与 `reason`。
2. Silero/TEN 若在本机确有可读权重文件（探针自行按只读方式 `statSync` 检测，不要求存在），用其 `weightsPath` 跑一次真实 5 帧 PCM16 静音分类，确认 `classify()` 不抛异常且返回合理 verdict 形状；若权重不存在，只记录 `unavailable` + 原因，不得伪造权重路径。
3. WebRTC 后端跑一次真实 5 帧分类（不需要权重），确认返回形状正确。
4. 输出 `docs/operations/voice-uplink-vad-isolation-probe.md`（由探针生成，不手改），内容含：三后端状态表、node/npm 包版本、ABI 匹配结论、权重路径现状（含"本机用户目录下的 `.onnx` 文件不受仓库管理"这条如实记录）、探针运行时的 pid/未重启 `:3001` 的证据。
5. 不新增任何生产调用点；不修改 `server/index.ts`、`voice-realtime-ws-proxy.service.ts`。

## AC

- [ ] AC1 探针 `npx tsx --tsconfig server/tsconfig.json experiments/voice-uplink-vad-isolation-probe/probe.mts` 退出 0，产出报告文档。
- [ ] AC2 三后端的 `status`/`reason` 读数真实（不 mock 默认加载路径），WebRTC 必须报告 `available`（本机 ABI 已验证可加载）；Silero/TEN 的状态如实反映本机权重现状，不得假造权重存在或假造 `available`。
- [ ] AC3 报告文档显式写出："权重路径不受本仓库管理，没有生产代码指向它" 这句话（或等价表述）；取假形态：删掉这句 ⇒ 对应断言红。
- [ ] AC4 探针运行期间 `:3001` 的 pid 前后相同（写出读数），未改任何生产 env、未新建/写入任何 `.env*` 文件。
- [ ] AC5 零外联：探针不发起任何网络请求（本地推理/加载，无上游连接）。
- [ ] AC6 `git diff --name-only develop... -- server src` 为空——本任务不touch任何生产代码路径，只新增 `experiments/` 与 `docs/`。

## DoD

三个上行 VAD 后端在本机的真实可用性（ABI 加载 + 权重现状）被一次可重跑的探针记录在案，产物归档在 `experiments/`/`docs/`，不依赖本轮审计对话里的一次性 shell 输出；未触碰生产代码或线上进程。

## Touches

- experiments/voice-uplink-vad-isolation-probe/probe.mts (new)
- docs/operations/voice-uplink-vad-isolation-probe.md (new)
- tasks/gap-voice-uplink-vad-weights-abi-isolation-probe.md

## Notes

**查重（2026-10-14）**：`gap-voice-uplink-vad-node-backends`（done）是三后端模块本身的落地与单测；`gap-voice-uplink-vad-real-ab-and-e2e-verification`（done）用 scripted/dry-run 验证端到端行为，均未在**本机真实** `require()` 路径上验证 ABI/权重现状，也没有把这类读数归档为可重跑产物——本任务是增量，不重复。

**用途**：本任务的读数是 `gap-live-voice-uplink-vad-production-arm-point` 的前提证据（该任务 depends_on 本任务），但不是其代码依赖——两者可并行落地，人要求"优先跑"体现为依赖边而非代码耦合。