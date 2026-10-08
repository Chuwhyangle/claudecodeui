---
id: gap-voice-realtime-ambiguity-paired-record
title: ASR→文本 vs Qwen Realtime bridge 的同运行对比读数与 GO/NO-GO 记录（AC-307）
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-voice-realtime-bridge-offline-provable
  - gap-voice-realtime-ambiguity-prereg
goal_ac: AC-307
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "voice-realtime" tasks/*.md goals/*.md` 只命中本任务同批次立案的 GOAL-029 与两个姊妹任务，无同机制重复。本任务是 GOAL-029 的第三块，`depends_on` 前两个任务：没有 `gap-voice-realtime-bridge-offline-provable` 的 bridge 模块就没有"新路径"可跑，没有 `gap-voice-realtime-ambiguity-prereg` 的冻结语料/口径就没有可信的判定标准。

### 背景

`docs/proposals/voice-native-control-plane.md` §10.1/§10.6 要求：同一次运行跑两条臂（出货的 `dashscope-omni` 书面化路径 vs `gap-voice-realtime-bridge-offline-provable` 落地的 bridge），用 `gap-voice-realtime-ambiguity-prereg` 冻结的四类场景语料，产出一份 GO/NO-GO 性质的对比记录——**不预设哪条路径赢**，任务按"实验跑得严谨、记录写得完整"判定（ADR-004 决策 8）。

### 方案

1. `experiments/voice-realtime-ambiguity/run.mjs`：读 `fixtures/`（前序任务已冻结，本任务**不改**其内容，只读），对每条语料跑两条臂：
   - 臂 A（基线）：出货模块 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe`，离线替身上游（本任务不对真实 DashScope 发请求，用 `--live`/`--freeze` 的既有约定：默认离线重算冻结的夹具响应，`--live` 才打真实上游，产生成本，手动触发，不进 CI）。
   - 臂 B（新路径）：`gap-voice-realtime-bridge-offline-provable` 落地的 bridge，工具 executor 注入 `gap-voice-realtime-ambiguity-prereg` 对应场景的夹具状态（选区/run 状态/approvals/background 等），对假 WS 服务端跑，产出 bridge 最终决定调用的工具与参数（即它"理解后的意图"）。
   - 两条臂同一次运行、同一批语料、同一个 run id（不跨运行拼接）。
2. 打分：按 `gap-voice-realtime-ambiguity-prereg` 冻结的口径逐条判定两条臂的输出；至少一条负对照验证打分口径本身没问题。
3. 记录 `docs/experiments/<date>-voice-realtime-ambiguity.md`：报 n、run id、四类场景各自的结论（含"世界模型类，若基线路径完全没有能力回答，如实记录，不是预设的失败"）、负对照是否按预测方向移动、已知局限（TTS 合成语料、单次运行只界定方向）。`docs/experiments/README.md` 加一行索引。
4. GO/NO-GO：记录末尾给出"是否值得继续投入产品化（接 `ChatControlService` 的 stretch 任务）"的建议，但**这不是**本任务的判据——判据只看"记录是否严谨完整"。

### 边界（不做）

不改 `gap-voice-realtime-ambiguity-prereg` 冻结的语料/口径（如发现缺陷，按偏离记录处理，不静默改）；不改 `gap-voice-realtime-bridge-offline-provable` 的 bridge 本体行为（只调用，不改实现）；不接真实 `ChatControlService`；不立案 stretch 任务（那是另一次、视本任务读数决定的独立立案）；质量数字不进判据集。

## AC

- [ ] AC1 runner 报 n，空读数不是绿：`node experiments/voice-realtime-ambiguity/run.mjs` 默认离线重算退出 0，并打印 `n=<四类场景总条数> × 2 arm(s)`；`--corpus=empty` 退出非 0，判词指名空读数。
- [ ] AC2 负对照能红：至少一条负对照按预测方向反转退出非 0，判词指名该对照与预测方向。
- [ ] AC3 不跨运行：两条臂的读数来自同一个 run id；`--runs=straddle`（或等价的跨运行拼接变体）退出非 0。
- [ ] AC4 被测出货模块：runner 里 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe` 与 `gap-voice-realtime-bridge-offline-provable` 的 bridge 本体是被导入调用，而不是在 runner 内重写第二份请求/路由逻辑。
- [ ] AC5 记录存在且四类场景各有结论：`docs/experiments/<date>-voice-realtime-ambiguity.md` 存在，四类场景（同音实体歧义、自我更正、指代消解、world-model/状态查询）各有一节明确结论；`docs/experiments/README.md` 索引表列出该文件。
- [ ] AC6 不进判据：记录与 runner 末行自陈"quality numbers are a reading and are NOT a criterion"；`grep -rl voice-realtime-ambiguity scripts/` 为空（不进 CI 判据脚本目录）。
- [ ] AC7 凭据不入库：`git diff --name-only <base>...HEAD` 不含 `.env*`；`out/`/缓存目录不入库。
- [ ] AC8 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。
- [ ] AC9 如实登记：完成记录写明本任务只回答"理解质量是否有优势"，不回答"接入生产是否顺畅"；GO/NO-GO 建议是记录里的一句人读结论，不是任何机械判据的输入。

## DoD

真实落地判据：不是"多了一份记录"，是**两条臂真的在同一批冻结语料、同一次运行上被公平比较过，且空读数/负对照/跨运行三类常见的实验造假方式都被机械堵住**——对照 `gap-asr-omni-paired-quality-record` 的九条判据结构：(a) 空读数不是绿、负对照能红、不跨运行；(b) 被测的是两条出货/落地模块而不是 runner 自造的逻辑；(c) 记录对四类场景给出明确结论，而不是只有汇总数字；(d) 质量数字不进判据，GO/NO-GO 是人读结论。

## Touches

- experiments/voice-realtime-ambiguity/run.mjs (new)
- docs/experiments/2026-10-09-voice-realtime-ambiguity.md (new，文件名按实际取数日命名，偏差如实登记)
- docs/experiments/README.md
- tasks/gap-voice-realtime-ambiguity-paired-record.md (self)