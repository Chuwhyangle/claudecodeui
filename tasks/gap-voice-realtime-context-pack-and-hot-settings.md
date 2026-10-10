---
id: gap-voice-realtime-context-pack-and-hot-settings
title: P2 上下文包与热更新设置：浏览器按「用户可见的已说内容」组装字符预算内的 Claude Code 上下文，随段协议注入上游，提示词/模板每次新连接热读取
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-segmented-relay-p0a-commit-rotation-context
  - gap-voice-segmented-relay-client-wiring
goal_ac: AC-320
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-10）：已有 `isWorkSegmentMember` 与 `shouldHideToolResult`（前端折叠显示规则）；本条复用它们判定「用户可见的可读正文」，不另写一套过滤。服务端目前只有固定提示词，没有上下文注入。SPEC 用户决策：按字符数计，不用「最近 N 轮」，把上下文放进去并告知模型这是上下文，不对用法加太多约束，具体怎么用要靠实测调整。

来源：SPEC「C2 上下文包」「热更新设置」。

### 方案

1. 浏览器纯函数 `buildVoiceContextPack(messages, {budgetChars: 2000, rowCapChars: 600})`：从后往前取「已说」行（排除思考、工具调用与结果、子代理容器、任务通知、生命周期行；附件用占位符；长代码只留前 3 行），超预算即停，硬上限不超 `budgetChars`。
2. 通过段协议的 `context` 帧（P0a-S3 验证过的注入方式）在新连接建立与上游轮换后送达；服务端把它作为一条上下文项放进上游会话，并在提示词里说明这是 Claude Code 会话的上下文。
3. 提示词与上下文模板放进设置文件，每次**新连接**读取一次（无需重启服务）；模板变量只有 `{{context}}`。
4. 记录：每次注入打印字符数与行数，不打印正文。

## AC

- [x] `npx vitest run src/modules/chat/utils/tests/voiceContextPack.test.ts` 退出码 0
- [x] 过滤：思考、工具调用/结果、子代理容器、任务通知、生命周期行均不进包；与 `isWorkSegmentMember`、`shouldHideToolResult` 的判定一致（用同一批 fixture 比对）
- [x] 预算：任意输入下包长 ≤ `budgetChars`；没有「最近 N 轮」的常量出现在实现里（grep 判据）
- [x] 服务端：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-context-injection.test.ts` 退出码 0，且改设置文件后新连接读到新模板、已有连接不受影响
- [x] 取假形态必须变红：超预算时不截断 → 预算用例红；把工具结果放进包 → 过滤用例红
- [x] 新增服务端测试文件后 `quay-test-script.test.ts` 退出码 0（同步钉子与基线）
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：用 P0a 的 S3 脚本在真实上游上跑一次（预算 ≤ ¥0.02）：包里放一条能区分「看过上下文」的事实，问一句依赖它的话，报告里模型的转述体现了该事实；结果落到 `experiments/voice-realtime-segmented/p2/RESULT.json`。如何使用上下文不做约束，若表现不佳只记录观察，不在本任务里追加规则。

## Touches

- src/modules/chat/utils/voiceContextPack.ts (new)
- src/modules/chat/utils/tests/voiceContextPack.test.ts (new)
- src/modules/chat/voice-realtime/tests/contextPack.test.ts (new)
- src/modules/chat/voice-realtime/voiceRealtimeProtocol.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/utils/workSegments.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-settings.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-context-injection.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts (new)
- experiments/voice-realtime-segmented/p2/RESULT.json (new)
- experiments/voice-realtime-segmented/p2/s3-context-recall.mts (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-realtime-context-pack-and-hot-settings.md

## Notes

DoD 实测（`experiments/voice-realtime-segmented/p2/RESULT.json`，三腿各一次响应，上游花费 ¥0.002478 ≤ ¥0.02 预算）：

- 带包一腿与无包一腿都把问话原样转发了，转出的内容里没有包里的事实 → 判据 `unsupported`。
- 但包确实读进去了：带包一腿 `input_tokens=507`，无包 407，差 100。
- 再加的一条诊断腿（同一份包，只把「只转发、不许回答」那条中继规则换成允许回答）转出了「当前静音超时是五十秒。」 → 包是可读可用的，压住事实的是中继规则本身。

按 DoD「若表现不佳只记录观察，不在本任务里追加规则」，这里只记录，没有改动任何提示词。
