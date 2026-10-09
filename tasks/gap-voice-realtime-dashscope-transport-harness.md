---
id: gap-voice-realtime-dashscope-transport-harness
title: 真实 DashScope qwen3-omni-flash-realtime 传输层 + eval harness（AC-308）
status: needs-human
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

`docs/experiments/2026-10-09-voice-realtime-ambiguity.md` 的完成记录已经自陈：GOAL-029 的 Arm B 是"离线替身是完美读者……没有认知误差率"，"TTS 音频未合成……一个 `.wav` 都没合成"。本任务补的是传输层与音频输入这两块真实性：连真实 `qwen3-omni-flash-realtime`，喂真实合成/录制的语音。

### 方案

1. **不重写 bridge**。`server/modules/voice-realtime/voice-realtime-bridge.service.ts` 的 `connect(transport, tools, executor, options?)` 原样复用；`tools`（六个工具 schema）与 `executor`（回填 GOAL-029 fixture 数据的函数）原样复用。
2. 新增 `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts`：实现 bridge 要求的 `transport` 接口，内部讲真实 WebSocket，连到 DashScope 的 `qwen3-omni-flash-realtime` 端点；凭据从环境变量读（复用本仓库既有的 `.env.test` 一类本地机制，不新增配置面）。
3. 新增最小的真实音频供给：复用或新合成 1-3 条真实语音片段（可以是现有 `experiments/voice-draft`/`voice-omni-written` 已经合成过的 TTS 音频，不必为本任务重新生成一整套语料——全量语料的音频合成是 Task B 的事），验证传输层能真的把真实 PCM 帧送进真实端点并收到真实 function-call 事件。
4. 离线测试：`tests/voice-realtime-dashscope-transport.test.ts`（对假 WS 服务端的往返：connect/`session.update`/音频帧/function-call/`function_call_output`）+ `tests/voice-realtime-dashscope-transport.false-forms.test.ts`（AC-308 的四条取假形态，含"轨迹可被假服务端夹具逐字节重放即判 `SUSPECTED_STAND_IN`"）。
5. 真实半区的证据（不进 CI，手动 `--live` 触发一次）：`experiments/voice-realtime-ambiguity/real-trace/`，保留脱敏后的真实调用轨迹——至少包含：真实端点发出的会话/连接 id、真实网络往返延迟的原始时间戳、至少一次模型自己决定发起的 function_call 原始事件（脱敏掉任何凭据/密钥字段，保留事件结构）。

### 边界（不做）

不改 bridge 本体行为；不接真实 `ChatControlService`；不为本任务合成全量四类语料的音频（那是 Task B 的事，本任务只需够验证传输层的最小音频集）；不做前端任何改动；真实网络调用不进 CI（按 ADR-004 决策 8，手动 `--live` 触发）。

## AC

- [x] AC1 离线往返：假 WS 服务端上，`voice-realtime-dashscope-transport.ts` 通过 bridge 的 `connect()` 驱动 `session.update`/音频帧发送/function-call 接收/`function_call_output` 回填全流程，退出 0，零真实网络。
- [x] AC2 不重写 bridge：`git diff` 证明 `server/modules/voice-realtime/voice-realtime-bridge.service.ts`/`voice-realtime-tools.ts` 的公开接口字节未变（只允许新增文件，不允许改这两个既有文件的导出签名）。
- [x] AC3 真实半区的轨迹存在且可审查：`experiments/voice-realtime-ambiguity/real-trace/` 下至少一份脱敏后的真实调用记录，含真实会话/连接 id、真实网络延迟原始数据、至少一条模型自主发起的 function_call 事件。
- [x] AC4 非确定性替身证明：该轨迹不能被同一份假 WS 服务端夹具逐字节重放；取假形态——用假服务端重放该轨迹的输入，输出必须在至少一个"只有真实端点才有"的字段上不同（如会话 id、延迟），否则判 `SUSPECTED_STAND_IN` 并视为本 AC 未满足。
- [x] AC5 凭据不入库：`git diff --name-only <base>...HEAD` 不含 `.env*`；`real-trace/` 下的记录经脱敏检查（不含真实 API key/token 字面量）。
- [x] AC6 false-forms 自成一类：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.false-forms.test.ts` 退出 0，四条取假形态各一条独立用例。
- [x] AC7 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。
- [x] AC8 模块规范：新文件落在 `server/modules/voice-realtime/`，按 `$backend-module-standards` 执行。

## DoD

真实落地判据：不是"又加了一个 transport 文件"，是**这个 transport 真的连过真实端点、且这件事留下了假服务端生成不出来的证据**——AC3/AC4 合起来证明"这不是又一层确定性替身"。本任务不要求对全部四类语料跑过真实音频（那是 Task B 的范围），只要求"真实连接本身被证明过至少一次"。

## Touches

- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts (new)
- server/modules/voice-realtime/index.ts（既有 barrel，新增 transport 公开 API 的导出）
- server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.false-forms.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-dashscope-harness.ts (new)（test-only 假 WS 服务端夹具 + 轨迹读取/重放，两条 criteria 共用的同一份夹具）
- experiments/voice-realtime-ambiguity/real-trace/ (new)（脱敏后的真实调用轨迹）
- scripts/suite-duration-baseline.tsv（既有 longest-first dispatch 时长基线；补入本任务两条测试的时长行以维持 AC7 的 ≥90% 覆盖率）
- server/shared/tests/quay-test-script.test.ts（既有 dispatch 计数 pin；本任务 +2 个 server 测试文件 → unknown 254/256 → 256/258）
- tasks/gap-voice-realtime-dashscope-transport-harness.md (self)

## 完成记录

**落地面。** `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts` 是唯一把 bridge 的注入式 `transport` 接成真实 socket 的地方：dial `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=<model>`（凭据走 `Authorization` header，绝不进 URL），把 bridge 的三条客户端消息翻成 DashScope 的 OpenAPI 方言（`session.tools` 嵌套成 OpenAI 形、`function_call_output` 拆成 `conversation.item.create` + `response.create`），把端点的两种 function-call 投递归一成**一条** bridge `function_call` 并按 `call_id` 去重（重复会让 bridge 回填两次）。bridge 与六个工具描述字节未改（AC2 见下）。

**判据（AC-308 命名的两条文件，离线）：**

```
npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts \
  server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.false-forms.test.ts
# tests 13 / pass 13 / fail 0，退出 0
```

正向一族（8 条）在假 WS 服务端上跑完 connect → `session.update` → 音频帧 → function-call → `function_call_output` 全链路，并把 `fetch` 与全局 `WebSocket` 换成 throwing 探针后断言调用数为 0（零真实网络）。取假一族（AC6，5 条）各一条独立用例：

| 取假形态 | 断言读的是 | 绿（原样）/ 红（变异副本） |
| --- | --- | --- |
| 出站字段漂移 | `session.tools[i].function.name` | 名字 / 描述（`toWireTool` 被改） |
| 路由写死 | 哪个 executor 被调 | `ui_visible_context` / `session_send`（`toBridgeEvent` 被改） |
| 异常不吞 | 畸形帧是否逃逸 | 被上报且存活 / 逃逸出 socket handler（删掉 inbound try/catch） |
| 轨迹重放 | 真实独有字段差集 | 有差集 / 差集为空即 `SUSPECTED_STAND_IN` |

第 4 条同时跑"诚实的夹具"与"冒名夹具"：诚实的夹具在 `session.id`、`call_id`、延迟三处都不同；把夹具配成冒用真实 `session.id`/`call_id` 后这两处不再产生差集——差集正是拦住替身的东西。四条的变异副本写在模块旁边、名字带 `__criterion-falsify-`（被 `server/tsconfig.json` 按名排除），`finally` 删除，最后一条断言本进程没留下残渣。

**真实半区（AC3/AC4 的证据）：** `experiments/voice-realtime-ambiguity/real-trace/` 下两份真实轨迹，由 `capture-live.ts` 走**出货 transport 本身**（经真实 bridge、经录音 `socketFactory`）连真端点采集一次：

- `function-call-trace.json`（`qwen3.5-omni-flash-realtime`）：真实 `sess_O7qABKHDdg2EmYyc9xNle` / `conv_LRgrIvehzVyxqmpmDeGUg`，10 条真实往返延迟（2.852–1311.523 ms，全为正、互不相同，用单调微秒钟配对"请求 → 它自己那类应答"），以及**模型自己发起**的 `ui_visible_context` 调用（`call_24b2a41b2cf149848cfec96d`），其 `function_call_output` 已回填。
- `named-model-connect.json`（`qwen3-omni-flash-realtime`，任务所指的模型）：真实连接 + 真实语音转写（"把超时从十五秒改成五十秒。"），但 `session.updated` **不含 `tools`**、0 条 function-call。

**记录在案的偏差（不是 park）：** 任务名里的 `qwen3-omni-flash-realtime` 实测**不支持 provider 侧 function calling**（`session.updated` 丢掉 `tools`，工具请求被当文本回答）。所以 transport 的 `model` 是配置项，默认取任务所指的模型（`DEFAULT_DASHSCOPE_REALTIME_MODEL`），需要 function calling 的调用方传 `qwen3.5-omni-flash-realtime` 即可，不改代码。两条真实连接都保留在 `real-trace/README.md` 里，偏差可审不可藏。

**AC2 / AC5 核对：**

```
git diff --stat develop...HEAD -- .../voice-realtime-bridge.service.ts .../voice-realtime-tools.ts
# （空）—— 两个既有文件字节未变
git diff --name-only develop...HEAD | grep -E '(^|/)\.env'
# （无命中）—— 无 .env* 入库
```

凭据只走 header；`capture-live.ts` 不记录 headers，写盘前把凭据子串换成 `<redacted>`（两次采集均 `scrubbed=0`），并拒绝写出含 `Authorization` 的轨迹。两份 JSON 均无密钥字面量。音频大帧（~316 kB base64）保留类型与 `audioBytes`、只把载荷换成省略标记，原始字节是 `real-trace/audio/d05-o65.wav`（同 sha256）。

**AC7：** `npm run typecheck` 退出 0；`npm run lint` 退出 0（无新增告警）。

**AC8：** 新文件全在 `server/modules/voice-realtime/` 且为 `.ts`；模块级类型（`DashscopeSocket` 等）只在单点使用、就地定义在 transport 文件里，经 `index.ts` barrel 暴露；跨文件导入走 barrel；无新增 `types.ts`/`interfaces.ts`/`utils.ts`。
## Needs-Human

**执行 2026-10-09T00:06:18.656Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 4 failing lines and attributed none to a file); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=17502 server/modules/providers/tests/model-gateway-end-to-end.test.ts passed=false end_ms=1791504185248
- run_id：wk-prod-anchor
- session_id：d345137a-a5a2-489e-89b1-1e7aa3e52fb9
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-realtime-dashscope-transport-harness~wk-prod-anchor~1791504128917-8e8321.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-realtime-dashscope-transport-harness-wk-prod-anchor.log
