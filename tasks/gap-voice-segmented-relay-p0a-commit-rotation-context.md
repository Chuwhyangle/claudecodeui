---
id: gap-voice-segmented-relay-p0a-commit-rotation-context
title: P0a 真实上游验证（优先三项）：音频手动 commit、空闲上游会话切换、可读上下文注入——探针 + 原始追踪 + 校验器，总花费 ≤ ¥0.04
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-realtime-test-files-restore-quay-test-script-pins
goal_ac: AC-318
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-10）：`experiments/voice-realtime-ambiguity/real-trace/capture-live.ts`（AC-308 的一次性真实捕获）与 `experiments/voice-realtime-prompt/prompt-probe.mts`（文本回合的提示词对比）已存在，二者都不涉及**音频手动提交、会话切换、上下文注入**，机制不同，不合并；复用它们的传输构造（`createDashscopeTransport` + `observer`）而不是另写一套。前置修复任务只是让 develop 上的 quay-test-script 变绿，与本任务无共同文件。

来源：`docs/proposals/voice-realtime-segmented-relay-SPEC.md` 的「分期 / P0」。本任务只做**优先三项**；语义端点、历史控制、缓存归 P0b，且在本任务出结论之后才做。

### 为什么先验证这三项（每一项都决定后面的形态）

- **S1 手动音频 commit**：CloudCLI 一侧切分后，上游要关闭自己的 VAD（`turn_detection: null`），由我们在段尾发 `input_audio_buffer.commit` + `response.create`。此前只在**文本**回合里验证过 `turn_detection: null`，音频手动提交从未验证。不可用则 P1 回退到「服务端 VAD + 段间只送短静音」。
- **S2 空闲上游会话切换**：新会话建立到 `session.updated` 的耗时分布（此前观测 0.2–9 秒）、预热待命会话在活动会话 `response.done` 之后接手下一段是否正常。决定 P3 的预热与切换规则。
- **S3 可读上下文注入**：把一份 2,000 字符、按前端折叠规则取出的「用户可读的说出来的话」放进 `instructions`，前面如实说明这是当前会话的上下文，**不附加使用细则**；看 6 句 × 2 次的转发率、与原话的偏离度、标识符是否被用上、每次响应读入 token。决定 P2 的上下文模板起点与成本。

### 探针设计（`experiments/voice-realtime-segmented/p0/`）

- `probe-lib.mts`：连接（用出货传输 `createDashscopeTransport` 与 `observer`）、事件收集、**花费估算与预算守卫**（用 `estimateRealtimeCostCny` 对每个 `response.done` 的 usage 累计，超预算立即关闭连接并在记录里写 `guardTriggered: true`）、追踪写文件（只写 wire 事件，写前对 `sk-` 形态与 `DASHSCOPE_API_KEY` 的值做擦除并断言擦除后不含）。
- `s1-manual-commit.mts`：用 `experiments/voice-trim/fixtures/zh-d01-o85.wav`（约 12 秒）：`session.update{turn_detection:null}` → 以 100 ms 块 `append` → `commit` → `response.create`；再做两段的变体（两次 commit 同一会话）。预算 ≤ ¥0.01。
- `s2-session-rotation.mts`：连续建立 n≥5 个会话，记 `open→session.created→session.updated` 毫秒；再做「A 活动、B 预热、A 回完后第一段发往 B」的交接。仅文本回合，预算 ≤ ¥0.005。
- `s3-context-injection.mts`：`fixtures/context-sample.json`（从本仓库近期 Claude Code 会话里按规则取出的约 2,000 字符，**人工审核后**入库）+ 6 句文本回合 × 2 次（同 `prompt-probe.mts` 的语句，另加两句口述标识符的），记转发率、归一化编辑距离、标识符命中、usage。预算 ≤ ¥0.025。
- 真实上游运行需要密钥：`set -a; . ./.env.test; set +a` 后运行；**密钥不得进入任何产物**。
- `scripts/voice-realtime-p0-record-check.mjs`：校验 `RESULT.json`（见 AC），`--stage a` 只校验 S1–S3；`--spec` 校验 SPEC 的「P0 结论」与 RESULT 一致。verdict 由脚本从追踪**推导**，不是手写。

### 成本与证据

总预算 ≤ ¥0.04（S1 ≤ ¥0.01 + S2 ≤ ¥0.005 + S3 ≤ ¥0.025）。估算花费由守卫逐响应累计；单价取账单（文本输入 0.0015、音频输入 0.006、文本输出 0.0045 元/千 token）。证据 = 原始追踪 JSON（可回放）+ `RESULT.json`（带时间戳与花费）。

## AC

- [x] `node --test scripts/voice-realtime-p0-record-check.test.mjs` 退出码 0；用例含取假形态：证据文件不存在 → 红；Σ spendCny > 预算 → 红；追踪里含形如 `sk-…` 的字符串 → 红；S3 的 `ranAt` 早于 S1 → 红
- [x] `node scripts/voice-realtime-p0-record-check.mjs experiments/voice-realtime-segmented/p0/RESULT.json --stage a` 退出码 0（含 S1、S2、S3，各有 verdict、evidence、spendCny、budgetCny、guardTriggered、ranAt、notes）
- [x] S1 追踪 `traces/s1-manual-commit.json`：含 `session.update`（`turn_detection` 为 null）、≥ 1 个已发送的 `input_audio_buffer.commit`；要么出现 `response.function_call_arguments.done`（`session_send`），要么出现被记录的 `error` 事件及其原文
- [x] S2 追踪：≥ 5 次计时建立，记录 p50、p90；有一次交接记录（B 在 A `response.done` 后接手第一段并得到结果或明确错误）
- [x] S3 追踪：12 条响应记录（6 句 × 2 次），每条含 `forwarded`（是否调用 `session_send`）、`editDistance`（相对原话，0–1）、`identifierHit`、`usage.input_tokens`
- [x] Σ `spendCny` ≤ 0.04，且 `probe-lib.mts` 的预算守卫有一个对假上游的单元用例（构造超预算响应序列 → 守卫关闭连接并在记录里写 `guardTriggered: true`）
- [x] `docs/proposals/voice-realtime-segmented-relay-SPEC.md` 新增「P0 结论」一节，S1–S3 各一行，含 verdict、证据文件名、关键数字，`node scripts/voice-realtime-p0-record-check.mjs … --spec` 退出码 0
- [x] `git grep -nE "sk-[A-Za-z0-9]{16,}" -- experiments/voice-realtime-segmented docs/proposals/voice-realtime-segmented-relay-SPEC.md` 无匹配

## DoD

真实落地判据：**真实 DashScope 上游**被探针实际操作（追踪里有真实的 `session.created` 事件 id 与 `response.done` 用量，`RESULT.json` 的 `ranAt` 为运行时间），而不是回放夹具；每个 verdict 由脚本从追踪推导；总花费有估算并且守卫机制被测试过。结论不要求「都 supported」：任一项 `unsupported` / `inconclusive` 都是合法产出，但必须在 SPEC 的「P0 结论」里写明对应的降级路径，使 P1–P3 能据此取舍。

## Touches

- experiments/voice-realtime-segmented/p0/probe-lib.mts (new)
- experiments/voice-realtime-segmented/p0/s1-manual-commit.mts (new)
- experiments/voice-realtime-segmented/p0/s2-session-rotation.mts (new)
- experiments/voice-realtime-segmented/p0/s3-context-injection.mts (new)
- experiments/voice-realtime-segmented/p0/guard-case.mts (new)
- experiments/voice-realtime-segmented/p0/fixtures/context-sample.json (new)
- experiments/voice-realtime-segmented/p0/traces/s1-manual-commit.json (new)
- experiments/voice-realtime-segmented/p0/traces/s2-session-rotation.json (new)
- experiments/voice-realtime-segmented/p0/traces/s3-context-injection.json (new)
- experiments/voice-realtime-segmented/p0/RESULT.json (new)
- experiments/voice-realtime-segmented/p0/README.md (new)
- scripts/voice-realtime-p0-record-check.mjs (new)
- scripts/voice-realtime-p0-record-check.test.mjs (new)
- docs/proposals/voice-realtime-segmented-relay-SPEC.md
- tasks/gap-voice-segmented-relay-p0a-commit-rotation-context.md