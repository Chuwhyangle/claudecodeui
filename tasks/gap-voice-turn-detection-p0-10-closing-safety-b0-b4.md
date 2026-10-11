---
id: gap-voice-turn-detection-p0-10-closing-safety-b0-b4
title: Live Voice 分割安全性 P0.10（B0-B4）：T_safe 真实事件测量、P0.8 重新评分、离线缩短回放、版本化作废与
  Action Commit Gate
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-turn-detection-p0-9-staged-cheap-feasibility
---
## Proposal

### 现状（第四次重新定义研究目标）

`...-p0`→`...-p0-5`→`...-p0-6`→`...-p0-7`→`...-p0-8`（均 done）与正在执行的 `...-p0-9-staged-cheap-feasibility`（⛔ 本任务依赖其完成，不得触碰其 worktree/任务体）构成同一条 Live Voice 轮次检测/全链路研究线。人 yale 本轮再次明确重新定义目标：**不追求 500ms 级 EOT、不做模型榜单；用户可接受 ≥1 秒额外等待，真正关心的是分割错误造成的真实语义损失与是否可恢复**。本任务承接用户给出的 B0-B4 五阶段设计（原样保留阶段划分，不得合并/重新解释）：

- **B0**（小额真实付费，有门禁，可能受阻）：固定同一段音频 A+B，仅改变内部静音时长 T，取 500/1000/1500/2000/3000ms（在翻转区间加密取点，允许少量重复跑），从一个真实 Qwen Realtime 会话里观测三个**不同**的真实事件：turn-closing（轮次关闭）、function-call generation（函数调用生成）、actual tool commit（工具实际提交）——这三者不是同一时刻，每次运行必须分别记录三个独立时间戳。据此推导一个保守的 `T_safe`：低于该等待时长，Realtime 会**可靠地（不是偶尔地）**把一句话切成两个轮次。**绝不能**用 `silence_duration_ms` 这个配置旋钮替代一个真实测量到的事件——这正是要避免的典型错误。必须考虑（不得忽视）P0.7 已查明的网络超时污染（11/24 会话，约 9/11 是真实网络异常，含一条长尾 outlier）——引用复用 P0.7 数据时必须带着这个污染说明；且 P0.7 只测过 T=400/800ms，覆盖不到本阶段要求的区间，因此 B0 需要**自己的新一轮**小额真实测量，不能靠引用 P0.7 数据交差。若执行环境网络不稳定，任务必须明确说明这个阻塞，**只能**复用已采集到的事件/离线资料，**不得**为了硬凑结论花钱做昂贵的真实重测——如实记录这个缺口。
- **B1**（基本零成本，先重新评分）：复用 `gap-voice-turn-detection-p0-8-paired-realtime-vs-nonrealtime-pilot` 的 `experiments/voice-turn-detection-compare/paired-pilot/RESULT.json` 里已有的 7 条配对结果，用**修正后**的判分规则重新评分，评分修正优先于任何新调用：
  - 中继**逐字**转发用户的自我纠正（原文与纠正后的词都保留，例如样本 `s4-self-correction` 的 chainA 输出「改一下 voiceService.ts，嗯不对，应该是 voiceRoutes.ts。」）**不能**因为输出仍包含纠正前的词就判错——这正是 `docs/proposals/voice-realtime-segmented-relay-SPEC.md`（D4：中继不解析不决策，只转发；解析发生在下游）已经确立的设计哲学。P0.8 原判分用的「禁用词」规则与这个设计冲突，必须被修正，不能照旧沿用。
  - 样本 `s1-single-command` 的 chainA 结果有一个截断/畸形的 `rawArguments` JSON（`{"message": "把 server 里的 voice service`——没有闭合引号/花括号），导致 `message: null`。这需要根因定位：是 harness 侧的事件累积 bug（adapter 代码只取了最后一个 `response.function_call_arguments.delta` 或 `.done` 事件自带的参数字段，没有正确拼接那次运行 `eventTypeCounts` 里观测到的全部 5 个 delta 分片），还是上游真实截断？要读实际的 `qwen-realtime-streaming-adapter.mts`/配对 pilot runner 代码来确定，记录结论，不得凭 JSON 形状重新猜测。
  - 样本 `s6-consecutive-commands` 的 chainA 结果（`rawArguments: '{"message": "内存不要超过1024兆。"}'`）是一个**真实发现**，不是评分假象：模型在一句连续/链式指令里只转发了其中一个动作。重新评分时这一条应继续记为真实缺失，不得被粉饰掉。
  - 重新评分修正规则之后，只有在重新评分仍留下现有 7 条无法回答的实质缺口时，才发起新的补测真实调用——且该补测必须保持小批量、预算写死上限。
  - 用修正后的分数比较链路 A/B 之间的「完整语义等价」与「安全工具载荷等价」，不得用原始有缺陷的分数。
- **B2**（零成本，纯离线回放——本阶段不得发起新付费调用）：对 P0.6/P0.7/P0.8 已经采集过的同一批录音做离线回放，把等待时长缩短到 1500/1000/700/500ms，逐例比较缩短后产生的分割偏差与真实语义损失（不只是通过/失败率），对比真值与更长等待基线。
- **B3**（零成本，代码+测试，不发起上游调用）：设计并测试 (a) 一个音频窗口合并机制，在需要把分段重新拼接时保留原始时序；(b) 版本化的 stale tool call 作废——一个来自已被取代轮次的迟到工具调用必须能按版本被丢弃，而不是被盲目执行；(c) 一个 Action Commit Gate，在版本化结果最终确定之前阻止副作用；测量当一个 stale/被取代的调用被正确丢弃、修正后的调用正确提交时的恢复成功率。这一阶段必须避免对每个阈值重跑昂贵的上游调用——只能基于已采集的数据/时间轴，或合成的状态机级测试夹具，不得发起新的真实会话。
- **B4**（本任务明确不做）：扩大到更大样本。只有在 B0-B3 产出小样本「go」结论之后才会被考虑。本任务不得尝试 B4。

用户另外提出的交叉要求：验证真实的工具中继**只转发语义**（不自行解析/决策）——明确区分「模型是否理解/转写正确」与「下游 agent（Claude Code 会话）最终执行了什么」两个不同的问题，不得混为一谈。本任务的所有动作必须是 mock/dry-run——没有真实副作用，不投递到任何真实 Claude Code 会话，沿用与 P0.6/P0.7/P0.8 相同的纪律（机械证据，不是口头声明）。

### 边界 / 不做

- ⛔ 不得触碰 `...-p0-9-staged-cheap-feasibility` 的 worktree 或任务体；本任务只能等它 done 后才被派发（`depends_on`）。
- ⛔ 不得做 B4（扩大样本），只做 B0-B3；B4 要等 B0-B3 出小样本 go 结论后才由人另行决定是否立项。
- ⛔ B1/B2/B3 不得发起任何新的真实付费上游调用（除非 B1 重新评分后确实有必要的少量补测，且必须先写死预算上限才能发）；B0 需要新的真实小额调用，但必须先写死预算上限（沿用既有惯例 ≤¥0.05），若执行环境网络不稳定则停止并记录阻塞，不得为了凑结论硬跑昂贵重测。
- ⛔ 不得把 `silence_duration_ms` 配置值当测量结果使用；B0 的 turn-closing/function-call/tool-commit 三个事件必须各自有真实时间戳证据。
- ⛔ 不得忽视或稀释 P0.7 已查明的网络异常污染（11/24 中约 9 条真实异常、2 条测量假阴性，含长尾 outlier）——引用 P0.7 数据时必须带着这个污染说明，不能当干净基线用。
- ⛔ 不得篡改 P0.8 的已有证据（`experiments/voice-turn-detection-compare/paired-pilot/RESULT.json` 保持只读引用，重新评分的结果写入本任务自己的新 artifact，不覆盖/删除 P0.8 原文件）。
- ⛔ 所有动作必须 mock/dry-run，没有真实副作用；必须区分“模型理解/转写是否正确”与“下游 agent 最终执行了什么”两个不同问题，不得混为一谈。
- ⛔ 不改默认 Live Voice 生产链路；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。

## Plan

1. B1 重新评分（优先，零成本）：读 P0.8 的 `paired-pilot/RESULT.json`，用修正后的判分规则（允许中继逐字转发纠正前后用词；核实 s1 的 JSON 截断根因；保留 s6 的多动作缺失为真实 miss）重新打分全部 7 条样本，产出修正后的 summary，与原始 P0.8 判分并列对照（不覆盖原文件）。
2. B2 离线缩短回放（零成本）：对已有录音在 1500/1000/700/500ms 四档离线重放，逐例记录分割偏差与语义损失（不只是通过率）。
3. B3 状态机与安全机制（零成本，代码+测试）：实现并测试音频窗口合并（保留原始时序）、版本化 stale tool call 作废、Action Commit Gate；测量在人工构造的“后到纠正”场景下的恢复成功率。
4. B0 真实事件测量（小额真实付费，先写预算再执行）：若执行环境网络稳定，对固定的音频 A+B 在 T=500/1000/1500/2000/3000ms（翻转区间加密+少量重复）跑真实 Qwen Realtime 会话，记录三个独立事件时间戳，求 `T_safe`；若网络不稳定，明确记录阻塞原因，复用已有事件/离线资料，不强行重测。
5. 汇总：把 B0（若跑了）与 B1-B3 的结果汇成一页结论，明确哪些阶段真跑了、哪些因阻塞没跑，不得含糊其辞。

## AC

- [ ] AC1 B1 重新评分：7 条样本的修正后判分结果（新 artifact，不覆盖 P0.8 原文件），每条样本写明判分理由变化；s1 的 JSON 截断根因（harness 累积 bug vs 上游截断）有代码级证据的结论。
- [ ] AC2 B2 离线缩短回放：1500/1000/700/500ms 四档在已有录音上的逐例分割偏差与语义损失记录（不只是汇总通过率）。
- [ ] AC3 B3 安全机制：音频窗口合并、版本化作废、Action Commit Gate 均有真实运行的测试通过记录；“后到纠正被正确作废、修正后的调用正确提交”场景的恢复成功率有具体数字。
- [ ] AC4 B0（条件性）：若网络稳定，真实测量产出 `T_safe` 及三个事件的独立时间戳证据，预算≤¥0.05 且执行前写死；若网络不稳定，明确记录阻塞原因与复用了哪些已有资料，不得编造或强行重测。
- [ ] AC5 口径纪律：引用 P0.7 数据时明确标注污染会话与干净会话的区分；不把 `silence_duration_ms` 配置值当测量结果。
- [ ] AC6 B4 边界：任务体与 artifact 明确声明 B4（扩样本）未在本任务范围内，留给未来任务。
- [ ] AC7 无真实副作用：机械证据证明 B0 的真实调用（若执行）工具结果未投递到任何真实 Claude Code 会话；B1-B3 全程无新上游调用（除非 B1 触发了写死预算的少量补测）。
- [ ] AC8 生产面零改动：`git diff develop` 对三个生产路径文件/目录为空；P0.8/P0.9 的既有 artifact 未被覆盖/删除。
- [ ] AC9 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

B1 的重新评分必须基于对 P0.8 原始数据与判分代码的真实重读，不是假设；B2/B3 必须是真实运行产出的数字（离线重放是真实重放，不是插值猜测；状态机测试是真实执行通过）；B0 若跑，必须是真实会话的真实时间戳，三个事件独立记录，不得用配置值顶替测量；B0 若未跑，阻塞原因必须具体、可核查；所有“未投递/无副作用”声明必须有机械证据；预算真实记账不超限。本任务零改动生产默认 Live Voice 链路，不覆盖 P0.8/P0.9 既有 artifact，不做 B4。

## Touches

- experiments/voice-turn-detection-compare/closing-safety-b0-b4/ (new)
- experiments/voice-turn-detection-compare/closing-safety-b0-b4/rescore-p0.8.mts (new)
- experiments/voice-turn-detection-compare/closing-safety-b0-b4/offline-shortened-replay.mts (new)
- experiments/voice-turn-detection-compare/closing-safety-b0-b4/action-commit-gate.mts (new)
- experiments/voice-turn-detection-compare/closing-safety-b0-b4/action-commit-gate.test.mts (new)
- experiments/voice-turn-detection-compare/closing-safety-b0-b4/t-safe-probe.mts (new)
- experiments/voice-turn-detection-compare/closing-safety-b0-b4/RESULT.json (new)
- experiments/voice-turn-detection-compare/closing-safety-b0-b4/CONCLUSION.md (new)
- tasks/gap-voice-turn-detection-p0-10-closing-safety-b0-b4.md
