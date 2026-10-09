---
id: gap-voice-realtime-dashscope-transport-harness
title: 真实 DashScope qwen3.8-omni-flash-realtime 传输层 + eval harness（AC-308）
status: done
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-308
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "qwen3-omni-flash-realtime|dashscope.*realtime.*transport" tasks/*.md goals/*.md` 零命中；GOAL-029 的 bridge（`gap-voice-realtime-bridge-offline-provable`，done）只实现了离线假 `transport`，没有任何任务声明过真实 WebSocket 传输层。本任务是 GOAL-030 的第一块，`gap-voice-realtime-real-audio-paired-evidence` 依赖它。

### 背景

`docs/experiments/2026-10-09-voice-realtime-ambiguity.md` 的完成记录已经自陈：GOAL-029 的 Arm B 是"离线替身是完美读者……没有认知误差率"，"TTS 音频未合成……一个 `.wav` 都没合成"。本任务补的是传输层与音频输入这两块真实性：连真实 `qwen3.8-omni-flash-realtime`，喂真实合成/录制的语音。

### 方案

1. **不重写 bridge**。`server/modules/voice-realtime/voice-realtime-bridge.service.ts` 的 `connect(transport, tools, executor, options?)` 原样复用；`tools`（六个工具 schema）与 `executor`（回填 GOAL-029 fixture 数据的函数）原样复用。
2. 新增 `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts`：实现 bridge 要求的 `transport` 接口，内部讲真实 WebSocket，连到 DashScope 的真实 Realtime 端点；凭据从环境变量读（复用本仓库既有的 `.env.test` 一类本地机制，不新增配置面）；目标模型按 model override 机制可配置，本 GOAL 正式采用的目标模型是 `qwen3.8-omni-flash-realtime`，`session.update` 必须带显式 `voice: "Tina"`（该模型的已知接入约束）。
3. 新增最小的真实音频供给：复用或新合成 1-3 条真实语音片段，验证传输层能真的把真实 PCM 帧送进真实端点并收到真实 function-call 事件。
4. 离线测试：`tests/voice-realtime-dashscope-transport.test.ts`（对假 WS 服务端的往返）+ `tests/voice-realtime-dashscope-transport.false-forms.test.ts`（取假形态，含新增的"幻觉工具名/违反参数 schema 必须被拒绝而不是静默路由"）。
5. 真实半区的证据（不进 CI，手动 `--live` 触发一次）：`experiments/voice-realtime-ambiguity/real-trace/`，针对 **`qwen3.8-omni-flash-realtime`** 保留脱敏后的真实调用轨迹。

### 边界（不做）

不改 bridge 本体行为；不接真实 `ChatControlService`；不为本任务合成全量四类语料的音频（那是 Task B 的事）；不做前端任何改动；真实网络调用不进 CI（按 ADR-004 决策 8，手动 `--live` 触发）。

### 规格修正（2026-10-09）

1. **目标模型纠正**：立案时把目标模型写成 `qwen3-omni-flash-realtime`。真实连接实测（见下方历史完成记录）显示该别名（3.0）的 `session.updated` **不回显 `tools`**、0 条 function-call；`qwen3.8-omni-flash-realtime` 与 `qwen3.5-omni-flash-realtime` 均能回显 tools、产生结构化 function_call、接收 `function_call_output` 并继续该轮。人 yale 2026-10-09 裁定按 `qwen3.8-omni-flash-realtime` 方向推进。此前已采集的 `function-call-trace.json`（`qwen3.5-omni-flash-realtime`）与 `named-model-connect.json`（`qwen3-omni-flash-realtime`，0 工具调用）**保留**作为对照性历史证据，**不删除**；但 AC-308 现在要求的正式证据是**专门针对 `qwen3.8-omni-flash-realtime`** 的一份新轨迹（见 AC9）。
2. **`voice: "Tina"` 约束**：`qwen3.8-omni-flash-realtime` 的 `session.update` 需要显式 `voice: "Tina"`，必须在代码注释与真实轨迹的记录里登记；若缺失该字段或用其它 voice 值导致连接失败/行为异常，必须在完成记录里写明现象，不得静默改用别的模型回避。
3. **此前的 needs-human 与本次纠正无关，如实澄清**：上一次 `needs-human` 停派（见下方保留的 `## 历史：needs-human 停派记录`）的原因是 fan-in 时 `server/modules/providers/tests/model-gateway-end-to-end.test.ts` 的全量套件红、且无法归因到本任务自己的改动——**不是**本次模型规格纠正要解决的问题。重置为 `todo` 让流水线按新范围（含 AC9–AC11）重新实现并重新尝试 fan-in；若那条无关的套件红再次出现，仍应按"基建疑似、非本任务缺陷"处理，不应为了让它消失而改动本任务范围之外的测试。
4. **新增三条 AC（AC9–AC11），不得靠弱化判词让旧 AC1–AC8 继续显示为绿来回避**：AC1–AC8 描述的能力（bridge 不重写、离线往返、既有取假形态）在规格纠正后仍然成立，不需要重做；AC9–AC11 是净新增的要求。

## AC

- [x] AC1 离线往返：假 WS 服务端上，`voice-realtime-dashscope-transport.ts` 通过 bridge 的 `connect()` 驱动 `session.update`/音频帧发送/function-call 接收/`function_call_output` 回填全流程，退出 0，零真实网络。
- [x] AC2 不重写 bridge：`git diff` 证明 `server/modules/voice-realtime/voice-realtime-bridge.service.ts`/`voice-realtime-tools.ts` 的公开接口字节未变。
- [x] AC3 真实半区的轨迹存在且可审查：`experiments/voice-realtime-ambiguity/real-trace/` 下至少一份脱敏后的真实调用记录，含真实会话/连接 id、真实网络延迟原始数据、至少一条模型自主发起的 function_call 事件。
- [x] AC4 非确定性替身证明：该轨迹不能被同一份假 WS 服务端夹具逐字节重放；取假形态——用假服务端重放该轨迹的输入，输出必须在至少一个"只有真实端点才有"的字段上不同。
- [x] AC5 凭据不入库：`git diff --name-only <base>...HEAD` 不含 `.env*`；`real-trace/` 下的记录经脱敏检查。
- [x] AC6 false-forms 自成一类：四条取假形态各一条独立用例。
- [x] AC7 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。
- [x] AC8 模块规范：新文件落在 `server/modules/voice-realtime/`，按 `$backend-module-standards` 执行。
- [x] AC9（新）**正式目标模型的真实轨迹**：`experiments/voice-realtime-ambiguity/real-trace/` 下新增一份专门针对 `qwen3.8-omni-flash-realtime` 的真实调用记录（区别于已保留的 3.5/3.0 历史记录），证明：真实合成/录制的音频输入、真实会话/连接 id、非零且有变化的真实延迟、至少一次模型自主发起的 function_call、`function_call_output` 回填后模型继续同一轮；记录里明确登记该连接使用了 `voice: "Tina"`（若曾用其它值失败，同样登记现象）。
- [x] AC10（新）**工具白名单/参数 schema 校验**：对一个幻觉工具名、一个违反已声明参数 schema 的调用各构造一条取假探针；transport/bridge 必须拒绝或以 `onError`/明确错误上报，不能静默把它路由给 fixture executor。若现有实现未做这层校验，必须补上，不得靠削弱判词让 AC 显示为绿。
- [x] AC11（新）**风险登记**：模块注释或完成记录里明确写明"`tool_choice: required`（或 DashScope 等价设置）不保证模型每轮一定调用工具"是已知限制而非待修 bug，且不得通过只挑选"总会触发"的输入来回避这条登记。

## DoD

真实落地判据：不是"又加了一个 transport 文件"，是**这个 transport 真的连过真实的、正式采用的目标模型（`qwen3.8-omni-flash-realtime`），且这件事留下了假服务端生成不出来的证据，同时两条已知风险被如实登记而不是被回避**。AC9 证明"连对了模型"；AC10 证明"校验不是摆设"；AC11 证明"风险没有被假装不存在"。本任务不要求对全部四类语料跑过真实音频（那是 Task B 的范围）。

## Touches

- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts (new)
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.false-forms.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-dashscope-harness.ts (new)
- experiments/voice-realtime-ambiguity/real-trace/ (new)（含新增的 qwen3.8-omni-flash-realtime 专用轨迹文件）
- scripts/suite-duration-baseline.tsv
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-voice-realtime-dashscope-transport-harness.md (self)

## 历史：needs-human 停派记录（保留，供追溯；与本次规格修正无关）

**执行 2026-10-09T00:06:18.656Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 4 failing lines and attributed none to a file); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=17502 server/modules/providers/tests/model-gateway-end-to-end.test.ts passed=false end_ms=1791504185248
- run_id：wk-prod-anchor
- session_id：d345137a-a5a2-489e-89b1-1e7aa3e52fb9

## 历史完成记录（规格纠正前的实现，AC1–AC8 范围；model override 机制与 3.5/3.0 两份历史轨迹仍然有效）

**落地面。** `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts` 是唯一把 bridge 的注入式 `transport` 接成真实 socket 的地方：dial `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=<model>`（凭据走 `Authorization` header，绝不进 URL），把 bridge 的三条客户端消息翻成 DashScope 的 OpenAPI 方言，把端点的两种 function-call 投递归一成一条 bridge `function_call` 并按 `call_id` 去重。bridge 与六个工具描述字节未改。

**真实半区（AC3/AC4 的历史证据）：** `experiments/voice-realtime-ambiguity/real-trace/` 下两份真实轨迹：

- `function-call-trace.json`（`qwen3.5-omni-flash-realtime`）：真实 `sess_O7qABKHDdg2EmYyc9xNle` / `conv_LRgrIvehzVyxqmpmDeGUg`，10 条真实往返延迟（2.852–1311.523 ms），模型自己发起的 `ui_visible_context` 调用，`function_call_output` 已回填。
- `named-model-connect.json`（`qwen3-omni-flash-realtime`）：真实连接 + 真实语音转写，但 `session.updated` 不含 `tools`、0 条 function-call——**这正是促成本次规格纠正的读数**。

**AC2/AC5 核对、AC7/AC8 静态门与取假形态细节**：均已满足，细节见本仓库 2026-10-09 发生的原始完成记录（git 历史中可查）；规格纠正不改变这些既有判定。

## 本次完成记录（AC9–AC11，规格纠正后；2026-10-09）

**落地面。** 本分支 `task/gap-voice-realtime-dashscope-transport-harness` 在既有 6 个提交之上新增提交 `d5903af9`（未重做这 6 个）。改动只落在 `## Touches` 已声明的文件内：`server/modules/voice-realtime/voice-realtime-dashscope-transport.ts`、`.../index.ts`、两个 `.../tests/voice-realtime-dashscope-transport*.test.ts`、`.../tests/voice-realtime-dashscope-harness.ts`，以及 `experiments/voice-realtime-ambiguity/real-trace/`（README、`capture-live.ts`、新增轨迹）。bridge 本体与工具描述字节未改。

**AC9（正式目标模型的真实轨迹）。** 新增 `experiments/voice-realtime-ambiguity/real-trace/qwen38-omni-realtime-trace.json`：由 `capture-live.ts --model qwen3.8-omni-flash-realtime --voice Tina` 驱动 SHIPPING transport + 真实 bridge 对真实端点采集，退出 0。

- 真实会话/连接 id：`sess_OO96O8HdLCmqyxUOdKJ6V` / `conv_P3KL43m5sda3eshbIKmIS`（端点分配，不出现在任何客户端帧）。
- 真实音频输入：一条 316653 字节的 `input_audio_buffer.append`（16 kHz 单声道 PCM16，源 `audio/d05-o65.wav`，9.895 s；base64 载荷按该文件省略，字节数保留）。
- 非零且有变化的真实延迟：8 条，`[2.189, 149.739, 779.11, 8.06, 1247.671, 589.89, 87.827, 273.858]` ms。
- 模型自主 function_call：`ui_visible_context`（`call_19aca891741a4956b688401c`，arguments `{}`），`call_id` 端点分配，客户端帧里从无此值。
- `function_call_output` 回填后模型继续同一轮：轨迹中回填之后的 `response.created`。
- `voice: "Tina"` 登记：轨迹顶层 `voice` 字段与 `session.update` 帧的 `session.voice` 两处均记录为 `Tina`；该 `session.update` 同时回显全部 6 个工具。transport 以一级选项 `voice`（`DEFAULT_DASHSCOPE_REALTIME_VOICE`）承载该约束，`capture-live.ts` 有 `--voice`。
- 本次连接使用 `voice: "Tina"`，未出现因缺失该字段导致的失败/异常现象，故没有“失败现象”需要登记。
- 采集期收到一条真实端点 `error` 帧 `{"type":"invalid_request_error","message":"Conversation already has an active response"}`（harness 自发的 `response.create` 撞上服务端 VAD 已开启的响应）。非传输缺陷，且模型仍继续同一轮；原样保留在轨迹里。

同时把 `DEFAULT_DASHSCOPE_REALTIME_MODEL` 由 `qwen3-omni-flash-realtime` 改为正式采用的 `qwen3.8-omni-flash-realtime`；3.5/3.0 两份历史轨迹保留不变作为对照。

**AC10（工具白名单/参数 schema 校验）。** 原实现没有这层校验，已补：transport 在 `send()` 时记住自己 `session.update` 声明的工具集（`recordDeclaredTools`），在 `handleInbound` 里对 `function_call` 事件先于去重做 `validateDeclaredCall` —— 幻觉工具名报 `UNDECLARED_TOOL`、违反已声明参数 schema 报 `TOOL_ARGUMENT_SCHEMA_VIOLATION`（经 `z.object(shape).safeParse`，导出为 `argumentSchemaViolation`），两者都走 `onError` 且**不**转发给 executor（只有非 JSON/非对象参数才下放给 bridge 处理）。`declaredTools` 为空时为 no-op，不影响 AC1 既有往返。取假形态新增第 5、6 条：在 SHIPPING 代码上为绿、在删掉该校验的 mutant 副本上变红——承重性由 mutant 证明，而非削弱判词。

**AC11（风险登记）。** 在 `voice-realtime-dashscope-transport.ts` 头部的 "KNOWN LIMITATION" 块与 `real-trace/README.md` 均写明：`tool_choice: required`（或 DashScope 等价设置）**不保证**模型每轮一定调用工具，这是端点已知限制而非待修 bug；并且不得靠只挑“总会触发”的输入回避这条登记 —— 采集器记录模型的真实选择，未触发时 `capture-live.ts` 以非零退出而非重试到触发。

**静态门与判据。** `npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npx oxlint server/modules/voice-realtime/ experiments/voice-realtime-ambiguity/real-trace/capture-live.ts` 退出 0；两个 transport 判据文件 `npx tsx --tsconfig server/tsconfig.json --test ...` 共 18 用例全绿（含 AC9 两条、AC10 一条、取假形态 6 条）。

**既有判定复核（未重做）。** AC2：`git diff --name-only <base>...HEAD` 不含 bridge/tools 文件，`index.ts` 仅新增 DashScope transport 导出块（纯增），bridge/tools 公开接口字节未变。AC5：该 diff 不含任何 `.env*`；`qwen38-omni-realtime-trace.json` 经脱敏检查不含凭据（无 `Authorization`）。AC1–AC8 原有判定不变，本轮仅净增 AC9–AC11。
