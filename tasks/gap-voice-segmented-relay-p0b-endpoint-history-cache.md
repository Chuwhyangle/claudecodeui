---
id: gap-voice-segmented-relay-p0b-endpoint-history-cache
title: P0b 真实上游验证（第二梯队）：语义端点、助手 OK 条目插入与 conversation.item.delete、用量里的缓存字段——总花费
  ≤ ¥0.01，并汇总 P0 结论
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-segmented-relay-p0a-commit-rotation-context
goal_ac: AC-318
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-10）：与 `gap-voice-segmented-relay-p0a-commit-rotation-context` 同属 AC-318，但机制不同（那条验证手动提交 / 会话切换 / 上下文注入；本条验证语义端点、历史条目操作、缓存），且按人 yale 的优先级「先三项，再考虑语义端点/历史控制」排在它之后；复用它的 `probe-lib.mts`，不另写探针框架。

来源：SPEC「分期 / P0」S4–S6 与「开放问题」2、3、4、5。**只在 P0a 出结论后做**，因为 P0a 的结果会改变这里值得验证什么（例如 S1 若不支持手动提交，语义端点只剩提示词层面的等待一条路）。

### 三项

- **S4 语义端点**：`turn_detection.type` 取语义类取值（如 `semantic_vad`）是否被该模型接受（`session.updated` 返回的 session 里原样回显，或返回错误原文）；若不被接受，再试**提示词层面的等待**：允许模型对「明显不完整」的片段不调用工具，后续段到达后一次转发，并记录 `holdTimeoutMs` 兜底触发（服务端发一次 `response.create` 要求转发已说过的话）是否能让它转发。
- **S5 历史控制**：（a）往会话里插入一条 `role: assistant` 的文本条目 `OK`（`conversation.item.create`）是否被接受，随后下一段语音是否仍被正确转发（目的：取代真的让模型生成一次收尾响应，每句少 1 次响应）；（b）`conversation.item.delete` 对已存在条目是否被接受、删除后下一次响应的 `input_tokens` 是否下降。
- **S6 缓存**：连续两次响应携带相同的长前缀（2,000 字符上下文），看 `usage` 里是否出现缓存相关字段（如 `cached_tokens`）以及按文档是否有折扣；没有字段则记录「无」。

### 成本

总预算 ≤ ¥0.01（S4 ≤ ¥0.004、S5 ≤ ¥0.004、S6 ≤ ¥0.002），守卫沿用 `probe-lib.mts`；全部使用文本回合，音频只在 S4 的提示词等待里用一条 `zh-d01` 的前半段。

### 汇总

完成后 `RESULT.json` 含 S1–S6 全部六项；SPEC「P0 结论」一节补齐 S4–S6，并把 P1–P4 受影响的条目（回退方案、是否降为每句 1 次响应、是否启用语义等待）逐条更新到 SPEC 对应章节与 GOAL-034 的描述里（只改文字，不改 AC 的可测内容；改动处在提交说明里列出）。

## AC

- [x] `node scripts/voice-realtime-p0-record-check.mjs experiments/voice-realtime-segmented/p0/RESULT.json` 退出码 0（不带 `--stage`，要求 S1–S6 全部齐全）
- [x] `node --test scripts/voice-realtime-p0-record-check.test.mjs` 退出码 0，且新增用例：S4–S6 任一项缺失 → 红；S4 的 `ranAt` 早于 S3 → 红（优先级顺序）
- [x] S4 追踪含 `session.update` 带语义类 `turn_detection` 的请求，及上游的接受回显或错误原文；若走提示词等待，含「未转发 → 后续段 → 一次转发」或「未转发 → 超时兜底 → 转发」的完整序列
- [x] S5 追踪含插入助手条目的请求与响应、其后下一段的转发结果；含 `conversation.item.delete` 的请求与响应（接受或错误原文）及删除前后的 `input_tokens`
- [x] S6 追踪含两次响应的完整 `usage` 对象原文，记录里有 `cacheFieldPresent` 与 `discountObserved`
- [x] Σ（P0a + P0b）`spendCny` ≤ 0.05，P0b 单独 ≤ 0.01
- [x] `node scripts/voice-realtime-p0-record-check.mjs … --spec` 退出码 0；SPEC 的「P0 结论」覆盖 S1–S6，并且「分期」「成本模型」「失败模式」中依赖 S1/S4/S5 的句子与结论一致（用 `git diff` 列出本任务改动的 SPEC 段落）
- [x] 与 P0a 一致：`git grep -nE "sk-[A-Za-z0-9]{16,}"` 对 `experiments/voice-realtime-segmented` 与 SPEC 无匹配

## DoD

真实落地判据：六项都有**真实上游**的原始追踪与带时间戳的记录，P0 总花费在预算内；SPEC 被据此更新，使 P1–P4 的任务不再依赖未验证的假设（每个未验证项要么已有 verdict，要么在对应章节里明确标注「按降级路径实现」）。允许任何 verdict，但不允许没有证据的 verdict。

## Touches

- experiments/voice-realtime-segmented/p0/s4-semantic-endpoint.mts (new)
- experiments/voice-realtime-segmented/p0/s5-history-control.mts (new)
- experiments/voice-realtime-segmented/p0/s6-cache-fields.mts (new)
- experiments/voice-realtime-segmented/p0/traces/s4-semantic-endpoint.json (new)
- experiments/voice-realtime-segmented/p0/traces/s5-history-control.json (new)
- experiments/voice-realtime-segmented/p0/traces/s6-cache-fields.json (new)
- experiments/voice-realtime-segmented/p0/RESULT.json
- experiments/voice-realtime-segmented/p0/README.md
- scripts/voice-realtime-p0-record-check.mjs
- scripts/voice-realtime-p0-record-check.test.mjs
- docs/proposals/voice-realtime-segmented-relay-SPEC.md
- goals/GOAL-034-live-voice-分段中继-cloudcli-端切分语音-带可读会话上下文-空闲换会话-每句成本与连接时长无关.md
- tasks/gap-voice-segmented-relay-p0b-endpoint-history-cache.md

## 完成记录

P0b（2026-10-10，真实 DashScope 上游）三项 verdict，均由 `scripts/voice-realtime-p0-record-check.mjs` 从追踪原始帧重新推导：

- **S4 unsupported**（`s4-semantic-endpoint.json`，¥0.002214）：控制面回声直通（`semantic_vad` 与 `bogus_vad_type` 回显同一组字段，`echoDiscriminates=false`），提示词层面等待 2 次运行 0 次生效（`held=0/2`，两次都立即转发）。→ 语义等待按「关闭」执行，改由 C1 在 CloudCLI 侧实现。
- **S5 supported**（`s5-history-control.json`，¥0.001929）：助手 `OK` 条目插入被接受，下一段恰 1 次转发；`conversation.item.delete` 被接受且 `input_tokens` 643 → 481。→ 不换会话即可控历史，`r=1` 前提成立。
- **S6 unsupported**（`s6-cache-fields.json`，¥0.004771）：两次响应的 `usage`（input_tokens 1451 → 1529）在任何深度都无 cache 类字段。→ 无缓存折扣，成本模型按全量计费。

花费：P0a ¥0.025480 + P0b ¥0.008914 = **¥0.034395** ≤ ¥0.05（P0b 单列 ≤ ¥0.01）。

本任务改动的 SPEC 段落（`git diff docs/proposals/voice-realtime-segmented-relay-SPEC.md`）：

- 「分期」→「语义端点（D7，可用才用）」：新增 P0-S4 实测 blockquote（按「关闭」执行）。
- 「指标」表 `等待使用次数与结果` 行：语义端点改为 C1 静默等待。
- 「成本模型」变量表 `r` 行、`r = 1` 句、新增「无缓存折扣（P0-S6）」段。
- 「失败模式与降级」`语义等待后没有后续语音` 行：改为 C1 侧本地计时器。
- 「P0 结论」：intro 改为六阶段口径，新增 `- S4` / `- S5` / `- S6` 三行。
- 「开放问题」2/3/4/5：逐条写入 P0-S4/S5/S6 的实测结论。

GOAL-034 的描述同步更新（只改文字）：目标 6 标注 P0-S4 关闭语义端点，成本与证据补 P0-S5 / P0-S6 两条实测。
