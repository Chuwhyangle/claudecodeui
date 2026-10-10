---
id: gap-voice-realtime-followup-credit-blind-consumption
title: 收尾轮额度计数器是无条件「盲额度」：被下一次任意 response.created 消费——抑制收尾轮后真实用户回复被误判为
  follow-up、文本被静默容忍而非抛 MODEL_TEXT_REPLY；把额度条件化到真正发出的合成 create 上（ON 配置逐帧不变）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-10，本 agent 经 `task_list` 逐词检索）：`followUpResponsesExpected` / `收尾轮` / `MODEL_TEXT_REPLY` / `respondToToolOutputs` / `misclassif` 全部零命中；`voice-realtime` 在 `todo`/`ready` 下 0 条（即当前没有任何开放任务会碰这几个文件）。同区域只有已 done 的相关任务，机制各不相同：`gap-voice-realtime-dashscope-transport-harness`（AC-308，建立了传输与 `respondToToolOutputs` 选项本身）、`gap-voice-realtime-connection-resilience`（AC-311，response 并发韧性）、`gap-voice-segmented-relay-protocol-server-commit`（AC-319，段协议，明确「传输的 `respondToToolOutputs` 与收尾一句保持现状」）、`gap-voice-realtime-upstream-pool-rotation`（AC-321，上游会话池）——**没有一条**覆盖「盲额度被下一次任意 `response.created` 消费」这个机制。merge-candidate：无开放 peer 共享 Touches，判 **separate**（none found）。

### 现状（本 agent 今日逐行重读，行号按当前树核对）

1. `server/modules/voice-realtime/voice-realtime-bridge.service.ts` 的 `sendFunctionCallOutput`（今日 :755-764）先发 `function_call_output`，随后**无条件** `followUpResponsesExpected += 1`（:760），注释写着「The model will now speak once more about the result (a text confirmation); that follow-up is expected」。这个自增**不知道传输到底会不会发出合成的那次 `response.create`**——传输在 `options.respondToToolOutputs === false` 时把合成的 `response.create` 整帧跳过（`server/modules/voice-realtime/voice-realtime-dashscope-transport.ts:660`，选项声明在 :290）。
2. 消费点：`voice-realtime-bridge.service.ts:612-618`，`if (message.type === 'response.created' && followUpResponsesExpected > 0) { followUpResponsesExpected -= 1; followUpResponseIds.add(id) }`。它**不校验**这个 `response.created` 是不是那次合成收尾轮——**谁先到谁把额度吃掉**。
3. 后果：`voice-realtime-bridge.service.ts:658-668`，`response.text.done` 时 `isFollowUp = followUpResponseIds.delete(responseId)`，只有 `text !== '' && !isFollowUp` 才抛 `MODEL_TEXT_REPLY`。被误判的那次响应，其文本被**容忍**而不是触发故障。
4. `voice-realtime-bridge.service.ts:441`（计数器）/ `:443`（id 集合）是**连接作用域**状态，从不按轮重置，只在 `response.created` 上被抽干。
5. 出货配置今天**不传**该 flag（`server/index.ts:443` 逐字注释 "NOT `respondToToolOutputs: false`"），所以缺陷在出货配置下**休眠**，而被「省掉约一半上游响应」的那个改动**恰好武装**。

### 实测（2026-10-10，受控 A/B，diagnose 路径，4 句脚本，三棵树）

抑制收尾轮时，**4 次响应里有 3 次被误判为 follow-up**。如实登记：该 harness 里三棵树共 12/12 条 utterance 仍全部转达到会话，即「误判」是被实测到的，而「文本被吞」还需要模型真的选走 text 路径才会发生——本任务不声称观察到一次真实的吞没，只声称误判窗口被实测到，且它正是吞没发生的必要条件。

### 方案

把额度**条件化到真正发出的那次 create 上**：要么只在传输确实会合成收尾 `response.create` 时才自增，要么记录该 create/对应 response 的身份、让消费点能校验它抽干的 `response.created` 正属于那次合成轮。**ON 配置（出货默认、`respondToToolOutputs` 未传或为 true）的线上行为逐帧不变**。这不是今天出货行为的改动，而是让「抑制收尾轮」这件事在将来可做：本条把盲额度收成有凭据的额度，抑制一旦开启，真实用户回复不再被当 follow-up 吞掉。

## Plan

1. **找到传输决策对桥可见的缝**。`respondToToolOutputs` 是**传输独有**的选项，桥读不到它；所以要么给桥/传输边界加一个小而显式的信号，要么把自增挪到桥能确认 create 已发出的那一刻。**推荐**：传输在**真正外发**一次合成 `response.create` 的那一点（即 `sendClientFrames` 里跳过/延迟判定之后、`sendFrame` 之前的实际外发点，含被 `deferredResponseCreates` 延迟后 flush 的那次）回调一个新增的可选钩子（如 `onSynthesizedToolResume`）；桥在该钩子里自增额度，替换 `sendFunctionCallOutput` 里那条无条件 `+= 1`。⚠️ 钩子必须钉在**实际外发**点而非「打算发」点：`activeResponseId !== null` 时 create 会被延迟（`voice-realtime-dashscope-transport.ts:663-666`），在延迟处自增会让额度早于外发出现。
2. **保留消费点语义**：`voice-realtime-bridge.service.ts:612-618` 仍按 `response.created` 抽干额度，但此时不变量「额度 > 0 ⇒ 有一次合成 create 在飞」成立；抑制配置下从不自增 ⇒ 下一条真实用户 `response.created` 不被消费。若传输的线协议能携带一个客户端标记并被端点在 `response.created` 上回显，可用「记录 create 身份」的更强形态；若不能（当前 `response.created` 的 `response.id` 由端点分配、不可预测），就用条件自增这一形态，不要为了「身份」而改线协议。
3. **改动留在桥/传输边界内**：不碰 `server/index.ts`（出货仍走 ON 路径，不新增/不改配置面）；不改工具 schema、不改会话发送、不改段协议。
4. **回归测试**（新增 `server/modules/voice-realtime/tests/voice-realtime-follow-up-credit.test.ts`）：用假 transport 按两种配置（`respondToToolOutputs: false` 与默认）驱动桥的多轮往返，覆盖下面 AC 的每一条。
5. **同步钉子**：新增服务端测试文件会移动 `server/shared/tests/quay-test-script.test.ts` 钉的文件数基线，一并更新；`scripts/suite-duration-baseline.tsv` 视需要补行。

## AC

- [x] AC1 判据入口：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-follow-up-credit.test.ts` 退出码 0。
- [x] AC2 抑制配置（`respondToToolOutputs: false`）：工具结果回填后桥不产出收尾轮 create，额度恒为 0；随后构造的下一条**真实用户**回复的 `response.created` **不消耗额度**，其 `response.text.done` 携带非空文本时**必须**抛 `MODEL_TEXT_REPLY`（而非被当作 follow-up 静默容忍）。同一命令内逐点断言。
- [x] AC3 负对照（ON 配置，默认路径）：收尾轮自己的非空文本（"OK"）仍被**容忍**（不抛 `MODEL_TEXT_REPLY`）——证明修复没有把正常的收尾轮误判成用户回复。
- [x] AC4 不变量：额度 > 0 当且仅当有一次已外发的合成 `response.create` 尚未被它自己的 `response.created` 收走；在工具回填与 create/`response.created` 之间逐点采样，断言不存在「无合成 create 在飞而额度 > 0」的窗口。
- [x] AC5 线中立（ON 配置逐帧不变）：用记录帧的假 transport 对同一段 ON 回放，修复前后桥收/发的帧序列（含 `function_call_output` 之后紧跟的合成 `response.create`）与响应计数逐帧相同。
- [x] AC6 取假形态必须变红 + 静态门：把自增改回无条件（抑制配置下也加额度）⇒ AC2 必红且红灯出自本条断言；`git status --porcelain` 收尾与开始时逐字相同；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts`、`npm run typecheck`、`npm run lint` 均退出码 0。

## DoD

真实落地判据：不是「加了一个钩子/单测变绿」，而是**在抑制收尾轮的配置下，真的驱动一条多轮连接，让模型对一次真实用户 utterance 走文本路径，并观察到洪亮的 `MODEL_TEXT_REPLY` 故障，而不是一次静默吞没**；同时确认 ON 配置仍产生今天的帧序列（AC5 的逐帧相等落到真实回放上）。单元测试通过是**必要不充分**。

取数方式（今天可行、不依赖新的付费运行）：复用 diagnose 路径的受控 A/B 装置（假上游 + 4 句脚本、三棵对照树），先复现 2026-10-10 实测的「抑制下 3/4 被误判」，再证明修复后这些误判全部变成**显式** `MODEL_TEXT_REPLY`；如实登记该 harness 里 utterance 仍 12/12 转达、真实吞没需模型选走文本路径才会发生。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/tests/voice-realtime-follow-up-credit.test.ts (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-realtime-followup-credit-blind-consumption.md
