---
id: gap-voice-realtime-dashscope-transport-harness
title: 真实 DashScope qwen3-omni-flash-realtime 传输层 + eval harness（AC-308）
status: ready
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
4. 离线测试：`tests/voice-realtime-dashscope-transport.test.ts`（对假 WS 服务端的往返：connect/`session.update`/音频帧/function-call/function_call_output）+ `tests/voice-realtime-dashscope-transport.false-forms.test.ts`（AC-308 的四条取假形态，含"轨迹可被假服务端夹具逐字节重放即判 `SUSPECTED_STAND_IN`"）。
5. 真实半区的证据（不进 CI，手动 `--live` 触发一次）：`experiments/voice-realtime-ambiguity/real-trace/`，保留脱敏后的真实调用轨迹——至少包含：真实端点发出的会话/连接 id、真实网络往返延迟的原始时间戳、至少一次模型自己决定发起的 function_call 原始事件（脱敏掉任何凭据/密钥字段，保留事件结构）。

### 边界（不做）

不改 bridge 本体行为；不接真实 `ChatControlService`；不为本任务合成全量四类语料的音频（那是 Task B 的事，本任务只需够验证传输层的最小音频集）；不做前端任何改动；真实网络调用不进 CI（按 ADR-004 决策 8，手动 `--live` 触发）。

## AC

- [ ] AC1 离线往返：假 WS 服务端上，`voice-realtime-dashscope-transport.ts` 通过 bridge 的 `connect()` 驱动 `session.update`/音频帧发送/function-call 接收/`function_call_output` 回填全流程，退出 0，零真实网络。
- [ ] AC2 不重写 bridge：`git diff` 证明 `server/modules/voice-realtime/voice-realtime-bridge.service.ts`/`voice-realtime-tools.ts` 的公开接口字节未变（只允许新增文件，不允许改这两个既有文件的导出签名）。
- [ ] AC3 真实半区的轨迹存在且可审查：`experiments/voice-realtime-ambiguity/real-trace/` 下至少一份脱敏后的真实调用记录，含真实会话/连接 id、真实网络延迟原始数据、至少一条模型自主发起的 function_call 事件。
- [ ] AC4 非确定性替身证明：该轨迹不能被同一份假 WS 服务端夹具逐字节重放；取假形态——用假服务端重放该轨迹的输入，输出必须在至少一个"只有真实端点才有"的字段上不同（如会话 id、延迟），否则判 `SUSPECTED_STAND_IN` 并视为本 AC 未满足。
- [ ] AC5 凭据不入库：`git diff --name-only <base>...HEAD` 不含 `.env*`；`real-trace/` 下的记录经脱敏检查（不含真实 API key/token 字面量）。
- [ ] AC6 false-forms 自成一类：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.false-forms.test.ts` 退出 0，四条取假形态各一条独立用例。
- [ ] AC7 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。
- [ ] AC8 模块规范：新文件落在 `server/modules/voice-realtime/`，按 `$backend-module-standards` 执行。

## DoD

真实落地判据：不是"又加了一个 transport 文件"，是**这个 transport 真的连过真实端点、且这件事留下了假服务端生成不出来的证据**——AC3/AC4 合起来证明"这不是又一层确定性替身"。本任务不要求对全部四类语料跑过真实音频（那是 Task B 的范围），只要求"真实连接本身被证明过至少一次"。

## Touches

- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.false-forms.test.ts (new)
- experiments/voice-realtime-ambiguity/real-trace/ (new)（脱敏后的真实调用轨迹）
- tasks/gap-voice-realtime-dashscope-transport-harness.md (self)