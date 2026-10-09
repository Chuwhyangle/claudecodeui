---
id: gap-voice-realtime-connection-resilience
title: Realtime WS 重连与 response 并发韧性，复用真实竞态证据回归（AC-311）
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-voice-realtime-dashscope-transport-harness
goal_ac: AC-311
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "connection-resilience\|response.*concurrency" tasks/*.md goals/*.md` 零命中。GOAL-030 Task A 的真实轨迹（`experiments/voice-realtime-ambiguity/real-trace/qwen38-omni-realtime-trace.json`）里已经真实读到一次 `"Conversation already has an active response"` 错误帧——当时 harness 只是把它原样记录下来，没有处理。本任务是 GOAL-031 的第二块，和 `gap-voice-realtime-live-session-send-wiring` 并行、互不依赖；两者都完成后 `gap-voice-realtime-browser-e2e-current-session` 才能开始。

### 背景

一条持续打开的语音连接必然会遇到：(a) 网络抖动导致的断连，(b) 服务端自己的 VAD 先触发了一次 response、同时 harness/客户端也发了一次 `response.create`——这正是 GOAL-030 真实撞到的竞态。本任务把这两类韧性问题补进 bridge/transport。

### 方案

1. bridge/transport 新增显式的"当前是否有未完成 response"状态；本地发起新的 response 请求前先检查，若已有未完成的就排队或跳过（不盲目再发一次）。
2. 断连重连：重连后恢复到同一逻辑会话继续，不重复、不丢已经发出但未回填的 `function_call_output`。
3. 回归验证优先复用已有真实证据：写一个重放器，把 `qwen38-omni-realtime-trace.json` 里那条错误帧喂给新代码路径，断言连接不因此失败；**不要求为本任务重新花钱连真实端点**（那是可选的加分项，不是必须）。

### 边界（不做）

不改 `voice-realtime-live-executor.ts`（那是另一个任务的事）；不做跨会话；不新增前端 UI（韧性是连接层的事，用户侧最多看到"重新连接中"这类状态文字，具体 UI 落在 e2e 任务里）。

## AC

- [x] AC1 response 并发状态跟踪：代码里有一个具名的"在飞 response"状态，发起新请求前检查它。
- [x] AC2 真实错误帧重放不崩溃：把 `qwen38-omni-realtime-trace.json` 里那条 `"Conversation already has an active response"` 错误帧喂给新代码路径，连接保持存活、不抛出未捕获异常。
- [x] AC3 取假变体：去掉 AC1 的状态跟踪，重放同一条真实错误帧必须红（连接失败/异常）。
- [x] AC4 重连不丢消息：模拟断连重连，已发出但未回填的 `function_call_output` 不丢、不重复处理。
- [x] AC5 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。

## DoD

真实落地判据：不是"写了一个状态变量"，是**用已经真实读到的那条错误帧重放证明新代码路径真的吸收了它，且删掉这段代码就会重新红**（AC2+AC3 的对照）。本任务不要求新的真实网络花费，优先复用 GOAL-030 已经付过的那笔真实证据。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-realtime-connection-resilience.md (self)