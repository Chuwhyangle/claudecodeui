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

- [x] AC1 runner 报 n，空读数不是绿：`node experiments/voice-realtime-ambiguity/run.mjs` 默认离线重算退出 0，并打印 `n=<四类场景总条数> × 2 arm(s)`；`--corpus=empty` 退出非 0，判词指名空读数。
- [x] AC2 负对照能红：至少一条负对照按预测方向反转退出非 0，判词指名该对照与预测方向。
- [x] AC3 不跨运行：两条臂的读数来自同一个 run id；`--runs=straddle`（或等价的跨运行拼接变体）退出非 0。
- [x] AC4 被测出货模块：runner 里 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe` 与 `gap-voice-realtime-bridge-offline-provable` 的 bridge 本体是被导入调用，而不是在 runner 内重写第二份请求/路由逻辑。
- [x] AC5 记录存在且四类场景各有结论：`docs/experiments/<date>-voice-realtime-ambiguity.md` 存在，四类场景（同音实体歧义、自我更正、指代消解、world-model/状态查询）各有一节明确结论；`docs/experiments/README.md` 索引表列出该文件。
- [x] AC6 不进判据：记录与 runner 末行自陈"quality numbers are a reading and are NOT a criterion"；`grep -rl voice-realtime-ambiguity scripts/` 为空（不进 CI 判据脚本目录）。
- [x] AC7 凭据不入库：`git diff --name-only <base>...HEAD` 不含 `.env*`；`out/`/缓存目录不入库。
- [x] AC8 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。
- [x] AC9 如实登记：完成记录写明本任务只回答"理解质量是否有优势"，不回答"接入生产是否顺畅"；GO/NO-GO 建议是记录里的一句人读结论，不是任何机械判据的输入。

## DoD

真实落地判据：不是"多了一份记录"，是**两条臂真的在同一批冻结语料、同一次运行上被公平比较过，且空读数/负对照/跨运行三类常见的实验造假方式都被机械堵住**——对照 `gap-asr-omni-paired-quality-record` 的九条判据结构：(a) 空读数不是绿、负对照能红、不跨运行；(b) 被测的是两条出货/落地模块而不是 runner 自造的逻辑；(c) 记录对四类场景给出明确结论，而不是只有汇总数字；(d) 质量数字不进判据，GO/NO-GO 是人读结论。

## Touches

- experiments/voice-realtime-ambiguity/run.mjs (new)
- docs/experiments/2026-10-09-voice-realtime-ambiguity.md (new，文件名按实际取数日命名，偏差如实登记)
- docs/experiments/README.md
- tasks/gap-voice-realtime-ambiguity-paired-record.md (self)

## 完成记录

**读数（同一次运行、同一批冻结语料）**：run id `run-voice-realtime-ambiguity-offline-1`，n=24（同音 6 · 自我更正 5 · 指代 5 · world-model 8）× 2 臂 = 48 条读数。

| 类别 | Arm A（ASR→文本） | Arm B（Realtime bridge） |
|---|---|---|
| 同音实体歧义 | 3/6 | 6/6 |
| 自我更正 | 5/5 | 5/5 |
| 指代消解 | 0/5 | 3/5 |
| world-model | 2/8 | 8/8 |
| 合计 | **10/24** | **22/24** |

7 条负对照**全部**按取数前写下的方向移动（都是 `down`）；自我更正 5/5 打平是**内部对照**（那一类不需要工具通道），证明位移不是共模的。四条自检变异在默认运行里也各重算一遍并必须非零退出。

**逐条 AC 的验证证据**：

- **AC1**：`node experiments/voice-realtime-ambiguity/run.mjs` → exit 0，打印 `readings: n=24 × 2 arm(s) = 48 row(s)`、`corpus: 24 entr(ies) across 4 class(es)`。`--corpus=empty` → exit 1：`[n] the corpus is EMPTY — n=0 × 2 arm(s) = 0 readings, and an empty reading is not a green one`。
- **AC2**：`--control=inverted` → exit 1，7 条判词各自逐字**指名**对照 id、class、kind 与预测方向：`[hom-neg-01 class=homophone-entity-ambiguity kind=repo-entity-prior-bias 预测方向=down] hom-neg-01 unbiased=fail(0) biased=pass(1) (Δ=-1 vs down) … 朝预测的**反方向**移动`。
- **AC3**：48 条读数全部带同一个 run id（默认运行打印 `run: run-voice-realtime-ambiguity-offline-1 — single run`，并在同一次运行里断言两个 run id 数 ≤ 1）。`--runs=straddle` → exit 1：`the readings come from 2 different runs (1970-01-01T00:00:00.000Z (1 reading(s)); run-voice-realtime-ambiguity-offline-1 (47 reading(s)))`。
- **AC4**：静态活 —— `--probe` 打印所驱动模块的**绝对路径 + 符号名**并断言它们在出货树内、不在工装内，且工装自扫里没有第二份 ASR 请求构造（禁字串**拼接**而成，避免自扫自己命中自己）。运行时活 —— 每次运行打印 `arm A: 24 row(s) stamped by the shipping adapter (providerId=dashscope-omni, style=written)`（文本由适配器自己的答案解析路径产出，不是 runner 抓 `choices[0]`）与 `arm B: 15/15 planned read(s) came back as function_call_output routed by the bridge itself`（工具查表路由是 bridge 的）。**两条断言都验过是活的**：把 `providerId` 改成自造值 → exit 1 `24 Arm A row(s) were not produced by the shipping adapter`；把 `toolCalls` 归零 → exit 1 `15 planned read(s) but 0 routed output(s)`（改后已 revert）。
- **AC5**：`docs/experiments/2026-10-09-voice-realtime-ambiguity.md` 存在，四节 `### 1..4` 各有一条 `**结论**`；`docs/experiments/README.md` 索引表末行列出该文件。
- **AC6**：runner 文件**末行**逐字是 `// quality numbers are a reading and are NOT a criterion`，每次退出（含 `--probe` 与全部红路径）打印的末行也是同一句；记录开头与末尾各一处自陈。`grep -rl voice-realtime-ambiguity scripts/` 无输出（exit 1）。
- **AC7**：`git diff --name-only $(git merge-base HEAD develop)...HEAD` 恰好 3 个文件（`experiments/voice-realtime-ambiguity/run.mjs`、`docs/experiments/2026-10-09-voice-realtime-ambiguity.md`、`docs/experiments/README.md`），无 `.env*`、无 `out/`、无缓存目录。
- **AC8**：worktree 里 `npm run lint` exit 0、`npm run typecheck` exit 0。
- **AC9**：见下。

**AC9 的如实登记（逐字）**：本任务只回答一个问题——**"在四类难场景上，带工具通道的通路理解质量是不是更好"**，答案是**是**（22/24 vs 10/24，差异集中在结构性的三类上）。本任务**不**回答**"Realtime 的生产接入顺不顺"**：没有真实 WS 客户端、没有 DashScope Realtime 的凭据与计费、没有音频合成、没有延迟/成本/断线重连的量、没有真实模型的误差率。

**GO/NO-GO（人读的一句话，不是任何机械判据的输入）**：**方向 Go（结构上）**——工具通道带来的理解能力增量大且分类清晰（world-model +6、指代 +3、同音 +3，而唯一不需要工具的自我更正是打平而不是倒退），值得继续产品化；**带一个前置条件**：出货 bridge 的广告工具集必须先补上 `ui_selected_text`，否则"把这一段改成 async 的"这类最自然的语音指令在真实会话里会静默地落不了地。这句话不被任何闸引用，也不会让任何机械判据变红或变绿。

**登记为发现（不是本任务的判据）**：`server/modules/voice-realtime/voice-realtime-tools.ts` 的 `REALTIME_TOOLS` 没有 `ui_selected_text`（6 个工具是 `ui_visible_context / session_send / session_get / run_get / approvals_list / session_background`），而 MCP 网关自己**是**注册了选区读的（`mcp-gateway.read-tools.ts` 的读工具表 + `mcp-ui-visible-context.ts`）。语料里 `co-01`/`co-04` 声明的先决读正是它，所以 Arm B 的指代类 3/5 里有两条是**结构上不可解**，不是解析错——判词逐字写着 `(not advertised by the shipped bridge: ui_selected_text)`。`--probe` 每次运行都重算并打印这个覆盖差。**未改** bridge 本体（边界声明），只登记。

**偏离登记（不静默改冻结物）**：
1. **TTS 音频未合成**。PREREG 的 `audioPlan.note` 写明音频要由本任务合成到 `fixtures/audio/<id>.wav`；本次读数是离线确定性的，读的是**脚本文本 + 夹具状态**，一个 `.wav` 都没合成、没提交。后果：本读数对"识别错的字怎么影响歧义解析"**零信息**。
2. **离线替身是完美读者**。它按固定规则解析、没有认知误差率，所以 Arm B 的 22/24 是**能力上限的形状**，不是真实模型分数。
3. **PREREG 的 `forbidden` 逐字串不可用**（`三千` 是正确答案 `三千零二` 的子串）。机械形态改取 `forbidden` 的**构造来源**：按反悔标记切开的"被撤回的那一段"不得出现在最终意图里，且收敛段必须携带内容锚点（更严——连空答案也一起拒）。记录里逐条写明。
4. 语料的四个类、7 条负对照、冻结最小值与方向**一个字节都没改**（只读）。

**已知局限**：单次运行只给**方向**不给区间（n=24 无重复采样、无 Wilson 区间）；`sc-01` 的机检形态只查子串锚点，语义等价那一半是**人读**（paired outputs 一节）；两条 `must-not-invent` 对照在补上 `ui_selected_text` 之前**不能**宣称桥能区分"选区为 null"与"选区被 withheld"。完整清单见记录的"未解释 / 未验证"八条。
