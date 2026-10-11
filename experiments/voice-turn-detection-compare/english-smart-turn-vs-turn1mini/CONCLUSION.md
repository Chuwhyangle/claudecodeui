# P0.13 — 纯英语样本上 Smart Turn v3.2 与 p99lab/turn-1-mini 原版统一 benchmark

任务：`gap-voice-turn-detection-p0-13-english-smart-turn-vs-turn1mini`
数据：`english-smart-turn-vs-turn1mini/RESULT.json`（本任务产出；**未改动** P0.6–P0.12 的任何 `RESULT.json`）
协议：复用 P0.7/P0.11 的 eot-bench 统一回放（`eot-bench-adapters/protocol.mts` 语义），**两个模型走同一个 sweep 核心**，所以两个前沿的差是**模型的差，不是打分器的差**。

本文件每个数字都来自本任务一次**真实的本地推理**（Smart Turn v3.2 ONNX int8 CPU + turn-1-mini 官方 ONNX 流式图，经官方 `p99turn` 入口，含 4 kHz 低通）。**没有一个是插值、对方自报数字或照抄**；两模型均 `status: loaded`（AC2）。

---

## 0. 结论先行（TL;DR）

对问题——"turn-1-mini 在英语上能否同时满足 false cutoff≤10% 与 missed END≤10%"——回答：

> **能。两个模型在纯英语上都存在同时满足两条 10% 预算（点估计）的操作点；但 turn-1-mini 的可行域明显更宽、余量更大。**
>
> - **turn-1-mini**：达标点可以一直取到 `threshold ≈ 0.22`（`actionDelay 0.9 s`）仍是 cutoff 3.40%、missed 6.00%；threshold 再高才破预算。
> - **Smart Turn v3.2**：达标域很窄，只在 `threshold ≲ 0.2` 且 `actionDelay = 1 s` 的角上成立；`threshold ≥ 0.3` 时 missed END 立刻升到 11%+（0.3/1s/3s → missed 11.0%）。
>
> ⚠️ **一个必须说清的口径**：本任务的选点规则是"达标点里平均延迟最低"（`gateRow`），它落在 `threshold = 0.01, actionDelay = 1 s, timeout = 1 s` —— 该点 cutoff 9.65% **正好贴着 10% 的边**，行为接近"固定 1 秒静音定时器"，模型的判别力几乎没被用到。**这不是唯一达标点，也不该被读成"模型有多强"。** 本文另列余量更大的代表点（§2）。

| 模型 | 存在同时满足两条 10% 预算的点？ | 达标策略数 / 决策策略数（0.1s 粗网格） | 最"贴边"的原因 |
|---|---|---|---|
| Smart Turn v3.2 | **是** | 488 / 5400 | 仅低阈值角达标，高阈值漏端率陡升 |
| turn-1-mini | **是** | 1036 / 5400 | 达标域宽得多，threshold 到 ~0.22 |

一句话给用户：**英语上 turn-1-mini 原版（无 fine-tune）本身就能达标，且余量优于 Smart Turn —— 因此"英语过门槛"成立，可以另立中文 fine-tune 任务（§10）。**

---

## 1. 方法与口径

- **语料**（AC4，详见 §3）：LibriSpeech 英语真实样本（P0.6，21 spans）与 `livekit/eot-bench-data` 英语 validation（锁定 revision `ca9d98a9…`，1250 spans）**分别报告**，最后给合并。
- **span 语义**：每个 ≥100 ms 静音 span；一个 turn 的**最后一个**静音 span = 真 END（`eot`）、其余 = 停顿（`hold`）。`hold` 分母过滤到 [0.2, 5.0] s，`eot` 从不过滤。因果读：偏移 `d` 读到 `audio[0 : floor((start+d)·sr)]`。
- **统一策略轴**：`threshold × actionDelay × timeout`；`hold_model_fire = max(actionDelay, holdFire)`，`cutoff = fired & holdDur > max(actionDelay, fire) | holdDur > timeout`，`detect = eotFired & eotFire <= timeout`。触发判据 `p_eot >= threshold`（沿用共享 P0.7/P0.11 scorer 的 `>=`，与 eot-bench 的 `>` 有一处**有意、统一**的偏差，已记在 `protocol.fireTest`）。
- **退化行过滤（AC5）**：`threshold = 0` 会在每个 cell 触发，不能当选点。**前沿与选点都过滤它**（`gateRow` 第 504 行 `DEGENERATE_THRESHOLDS.has(...) → continue`）；swept 集仍含 0，所以可见为 `policiesSwept − policiesDecision = 5454 − 5400`。
- **两分辨率**：0.1 s（主）与 0.02 s（加密）因果网格，两模型同网格。粗策略网格 5454 组，密策略网格 420,291 组（threshold 步长 0.005、actionDelay 0.02、timeout 0.05）。
- **预处理正确性（AC3）**：turn-1-mini 只经官方 `p99turn` 入口（含 4 kHz 低通、160 ms 流式缓存），自检见 §7。Smart Turn 复用 P0.6 已三方校验的编译 mel 前端（16 kHz、8 s 窗口、前补零）。

---

## 2. AC7 门槛判定（预注册门槛：false cutoff ≤ 10% 且 missed END ≤ 10%，点估计；区间另列）

**主表**——右列为**本任务选点规则选出的达标点**（"达标点里平均延迟最低"），数字取自 `RESULT.json`，k/n 与 Wilson 95%：

| 模型 | 语料 | 选点 (thr / aD / to) | false cutoff k/n (Wilson 95%) | missed END k/n (Wilson 95%) | EOT 等待 p50/p90/max (s) |
|---|---|---|---|---|---|
| Smart Turn v3.2 | eot-bench-en | 0.01 / 1 / 1 | 68/705 = 9.65% [7.68, 12.05] | 2/400 = 0.50% [0.14, 1.80] | 0 / 0 / 1 |
| turn-1-mini | eot-bench-en | 0.01 / 1 / 1 | 68/705 = 9.65% [7.68, 12.05] | 1/400 = 0.25% [0.04, 1.40] | 0 / 0 / 1 |
| Smart Turn v3.2 | merged | 0.01 / 1 / 1 | 68/710 = 9.58% [7.63, 11.96] | 2/416 = 0.48% [0.13, 1.74] | 0 / 0 / 1 |
| turn-1-mini | merged | 0.01 / 1 / 1 | 68/710 = 9.58% [7.63, 11.96] | 1/416 = 0.24% [0.04, 1.35] | 0 / 0 / 1 |

> 两个模型在这一角上的 cut/miss 几乎相同，因为 `threshold=0.01` 时两者都"一有静音就很快触发"，此点由 **`actionDelay=1 s` 的定时器**主导，模型差异被压平。看模型差异要看 §2b。

**2b. 余量点对照**——同一条 eot-bench-en 前沿上、仍在预算内的代表点（rate 取自 `RESULT.json` 前沿表，k = round(rate·n)，Wilson 由 k/n 重算）：

| 模型 | 点 (thr / aD / to) | false cutoff | missed END | 读法 |
|---|---|---|---|---|
| Smart Turn v3.2 | 0.03 / 1 / 3.5 | 37/705 = 5.25% [3.8, 7.2] | 12/400 = 3.00% [1.7, 5.2] | 余量点，模型开始起作用 |
| Smart Turn v3.2 | 0.13 / 1 / 3.5 | 33/705 = 4.68% [3.4, 6.5] | 27/400 = 6.75% [4.7, 9.6] | 可行域**上界附近**（missed CI 上沿已到 9.6%） |
| Smart Turn v3.2 | 0.30 / 1 / 3.0 | 32/705 = 4.54% | 44/400 = 11.00% | **破预算**（missed > 10%）——可行域到此为止 |
| turn-1-mini | 0.13 / 1 / 3.5 | 32/705 = 4.54% [3.2, 6.3] | 14/400 = 3.50% [2.1, 5.8] | 余量点 |
| turn-1-mini | 0.22 / 0.9 / 3.5 | 24/705 = 3.40% [2.3, 5.0] | 24/400 = 6.00% [4.1, 8.8] | 可行域**上界附近**，仍在预算内 |

**读法**：Smart Turn 的可行域在 `threshold ≈ 0.13–0.2` 处收口（0.3 即破 10% 漏端）；turn-1-mini 的可行域多出一整段（到 `threshold ≈ 0.22`），且同阈值下漏端率更低。**这是两模型在英语上的真实差距**，也解释了 P0.11 在**混合中英语料**上 Smart Turn 找不到达标点的原因（§4）。

**AC7 判定**：预注册门槛写死为"两条 ≤10%（点估计），CI 另列"。**两模型均存在达标的操作点 → 门槛通过**。CI 说明：`threshold=0.01` 角上 Smart Turn 的 cutoff CI 上沿 12.05% 已越过 10%，即**点估计达标但在 n=705 上不显著**；余量点（thr 0.03）的 CI 上沿 7.2% 才真正在预算内——所以稳健的达标陈述应落在余量点上。

---

## 3. AC4 语料与分组

| 语料 | id | spans（≥100ms 静音） | hold 分母 | eot 分母 | 丢弃的 hold（时长出界） | 来源 revision | license | 分组键 |
|---|---|---|---|---|---|---|---|---|
| LibriSpeech 英语真实 | `librispeech-en-real` | 21 | 5 | 16 | 0 | P0.6 已钉 sha256 | CC-BY-4.0 | `speakerId` |
| eot-bench 英语 validation | `eot-bench-en` | 1250 | 705 | 400 | 145 | `ca9d98a9686b920a2d8c9eb984224ba9be74e4dd` | CC-BY-4.0 | `speaker_session` |
| 合并 | `merged` | 1126（分母内） | 710 | 416 | 145 | — | — | 两者并集（97 组） |

- eot-bench 的 1250 个 span 里 145 个是时长出 [0.2, 5.0] 的 hold，**不计入分母**，所以分母是 1105。
- ⚠️ **合并行的前提**（`corpora.caveat`，AC4 要求未合并前先分别报告）：turn-1-mini 的训练数据**部分来自 LibriSpeech**（见其 `NOTICE`），因此 **corpus A 对它不是 held-out，eot-bench 才是**。分语料行就是为这个原因分开的；**合并行最后读**。LibriSpeech 只有 5 个 hold，CI 极宽（0/5 → CI [0, 0.43]），单独看几乎不含信息，只作 sanity。

---

## 4. AC5 统一策略轴 + P0.11 对照

- 两模型在**同一**候选 cell、**同一** `threshold×actionDelay×timeout` 网格上扫描；前沿并列在 `RESULT.json.analysis[*].interval0_1.views[*].frontier`。
- 前沿点数（已过滤 `threshold=0`）：eot-bench-en 上 **Smart Turn 51 / turn-1-mini 63**（0.02s 网格：52 / 61）；merged 上 51 / 63（0.02s：52 / 61）。密网格前沿：Smart Turn 66 / turn-1-mini 71。
- **可行域形状**（从 eot-bench-en 前沿读）：Smart Turn 在 `actionDelay=1`、`threshold≈0.01–0.2` 的角上同时满足两预算；`actionDelay≤0.9` 时 cutoff 立刻破 10%（0.9/1s → 10.92%）。turn-1-mini 的可行带更宽（见 §2b）。

**P0.11 对照（AC5 要求）**：P0.11（`finegrained-sweep/RESULT.json`）在**中英混合**语料（29 hold / 44 eot）上、把策略网格加密到 420,291 组后，Smart Turn 的 `bothBudgetSearch.found = false`，**0 组达标**；最接近的点是 `threshold 0.75 / aD 1 / to 1.5`，cutoff 3/29 = 10.34%（超出预算 **×1.034**）、missed 1/44 = 2.27%。

> **对齐**：同一模型、同一条策略轴、更密的网格，**混合语料上 0 达标、纯英语语料上有 488 组达标**。差异来自**语料与分母**（混合语料的 29 个 hold 里有中文/TTS 样本），不是网格粗细，也不是打分器。这正是本任务把语料限定为纯英语、并分语料报告的理由。

---

## 5. AC6 指标（每模型 × 每语料 × 合并；等待与 CPU 单列）

主指标见 §2。**推理 CPU 时间单列**（不与"等待"合并）——口径为**一次推理的 CPU ms，含特征提取**：

| 模型 | 单位 | 特征提取 p50/p90 (ms) | 推理 p50/p90 (ms) | 合计 p50 (ms) | 实时倍率 |
|---|---|---|---|---|---|
| Smart Turn v3.2 | 一个 cell（一次 8 s 窗口） | 24.69 / 24.83 | 44.08 / 45.35 | ≈ 68.8 | — |
| turn-1-mini | 一个 20 ms 帧 | 含在 ONNX 图内（低通+log-mel 在图中） | 0.171 / 0.195（160 ms 步 ÷ 8 帧） | 0.171 | **≈ 117× 实时**（160 ms / 1.367 ms） |

- Smart Turn 的**特征与推理分开报**：两者的优化手段不同（编译 mel 前端 vs ONNX int8），合并成一个数会掩盖该改哪一半。0.1s 与 0.02s 网格下每次 cell 成本相同（成本按 cell 计，与网格无关）。
- turn-1-mini 是**流式**：官方 ONNX 图内含低通与 log-mel，`stepMs` 即端到端每步成本。实测 185,304 步 / 29,648.6 音频秒，`stepMs` p50 1.367 / p90 1.559 / max 4.80，整体 **117× 实时**（单线程）。
- **EOT 等待**（从静音起点到判定 END）：达标点上两模型的 p50/p90 都为 0（因为 `threshold=0.01` 立即触发、`timeout=1`）；均值见 §2 表（Smart Turn 选点 mean 0.017 s / turn-1-mini 0.017 s）。余量点上等待抬到 0.1–0.6 s（见前沿表 `meanLatencySeconds`）——这是拿延迟换余量的正常权衡。

**组级分布**（AC4/AC6，eot-bench-en 选点）：96 个 speaker/session 组，`worstGroupCutoffShare = 0.147`（误截断最多的单组占全部误截断的 14.7%）→ **没有被单一说话人主导**；`topDecileCutoffShare = 0.691`（前 10% 的组占 69% 的误截断）→ 误截断集中在少数会话，但非暴雷单点。`topDecileMissedShare = 1` 是**退化读数**：该点总共只有 1–2 个漏端，落在前 10% 组里理所当然，无统计含义，仅记录。

---

## 6. AC3 预处理自检（turn-1-mini，官方流式 vs 离线）

`run-turn1mini.py --selfcheck`，4 项门全绿（`passed=true`），音频为 LibriSpeech 真实英语片段：

| 检查 | 结果 |
|---|---|
| 携带态流 = 同前缀 fresh 前向（因果性） | maxAbsDiff **0.0** |
| 分块不变性（1 次 push vs 1000 样本分块） | maxAbsDiff **0.0** |
| **ONNX 流式图 vs torch 因果流（`Turn1Mini.stream`，模型同一性）** | maxAbsDiff **7.00e-06** ≤ 1e-4 ✅ |
| 低通确实施加、未被绕过（`d_lp ≤ 1e-4` 且 `d_raw ≥ 10·d_lp`） | 通过（d_raw = 8.27e-02） |

**同一性判据是"ONNX 图 vs torch 因果流"**（实测 7.0e-6），**不是**"流式 vs 离线前向"。模型卡"流式与离线一致到 1e-4"的说法，若按离线 `frame_probs`（**非因果** `resample_poly` 低通，右边缘补零）去读会**测不成立**：实测单次 push 末帧差 ~1e-3…7e-3、分块内部 ~1e-2（`streamVsOfflineOnSamePrefix`）。这个差是**低通右边缘的非因果伪影**，不是模型差异——因此它被降级为**特征描述（characterisation）、不作为门**，以免用一个可测为假的断言去顶替真正的同一性检查。（早先草稿曾把它当门，`passed=false`，已改正。）

---

## 7. AC1 版本锁定 / AC2 真实加载

**AC1**（全在 `RESULT.json.provenance`，license 原文抓取时间 `2026-10-11T09:14:38Z`）：

| 项 | 值 |
|---|---|
| turn-1-mini repo commit | `076c86d1744a231d3a4cce31f3bbbd1211b4c281` |
| turn-1-mini ONNX sha256 | `e747b182d685c7db489a3ea2e12bdcd65bac506fcddec00ed3cd0bf9f209fd11` |
| turn-1-mini safetensors sha256 | `d03ccff872eb0ae2ed0366b1ea94d860328daa0122bf9003fb32b7a34b14acb9` |
| `p99turn` 版本 / wheel sha256 | `1.2.3` / `4cb4802e04ae8b013f14499d858024a59ec40cc9d36db8b8c49155d623b7e273` |
| Smart Turn checkpoint 来源 / commit | `pipecat-ai/smart-turn-v3` / `f766f81d3cfdf7737ac64aad813d91bbfd56bf93` |
| Smart Turn ONNX sha256 / bytes | `2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f` / 8,679,182 |
| 环境 | Linux 6.8.0-124 x64 · Python 3.12.3 · onnxruntime 1.31.0 · node v24.21.0 |

Smart Turn 的 onnx sha256 在运行时**重新哈希并断言**（`matchesPinnedSource = true`）。两模型 license 原文均当场抓取（BSD-2-Clause / Apache-2.0），带 URL + sha256。**无一项"未锁定"。**

**AC2**：两模型 `status: loaded`，均为真实本地推理；无插值、无照抄自报数字。（模型自报的"英语 eot-bench 9.6% / 849 ms"**未被采用**——本任务的 9.65% 是自测值，恰好接近但来源独立。）`--no-python` 路径已加固：不会用上一轮的旧 `turn1mini-scores.json` 顶替（span-key 失配即抛错）。

---

## 8. AC8 隔离 / 零付费 / 生产 diff

- **隔离**：Python 依赖只在本目录 `requirements.txt`（自带 venv）；`isolationEvidence` 扫描 6 个真实构建/测试配置（`package.json`、`tsconfig.json`、`server/tsconfig.json`、`scripts/tsconfig.json`、`vite.config.js`、`scripts/test.sh`），P0.13 标记 `hits = []`，`clean = true`。
  - `onnxruntime` **有意不作标记**：`package.json` 里的 `onnxruntime-web` 是既有的 JS 依赖（与 develop 逐字相同），与本任务的 Python venv 无关，收了会假阳性。
- **零付费**：`paidCallEvidence` 显示唯一 egress 是钉死 sha256 的公开 HF 拉取（`huggingface.co` / `raw.githubusercontent.com`），**无 DashScope / 外部推理 API**；`thisTaskNewSpendCny = 0`（P0.7 的既有账 `p07NonRealtimeCumulativeSpendCny = 0.025232` CNY 与本任务无关，未被写动）。
- **生产 diff**（AC8 要求的 `git diff develop -- server/modules/voice-realtime/ src/modules/chat/voice-realtime/`）：
  - **本分支自身 delta（vs `merge-base HEAD develop`）为空**，`changedPaths = []` → **AC8 证据成立**。
  - `vsDevelopTip` 非空（3 个文件），**只因为本分支落后 develop 73 个提交**：这 3 个文件是 develop 自己的推进（如 `f17bf1de feat(voice-realtime): resolve the spend window cap…`），**不是本任务的改动**；pre-merge（merge develop）后该 diff 也会变空。此字段的语义已从"vs develop 尖端"更正为"本分支自身 delta"，并把尖端 diff 降级为带注释的诊断项（改由 `--evidence-only` 就地重算，未重跑 78 分钟推理）。

---

## 9. 复现

```bash
cd experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini
python3 -m venv --without-pip .venv && python3 -m pip --python .venv/bin/python install -r requirements.txt
node ../../../node_modules/.bin/tsx run-benchmark.mts            # 全量：约 78 分钟
node ../../../node_modules/.bin/tsx run-benchmark.mts --evidence-only   # 只重算 §8 的证据字段
```
`RESULT.json` 已入库（不在 `.gitignore`）；`data/`、`.venv/`、`_cache/` 忽略（`data/turn1mini-scores.json` 14.8 MB 为中间产物）。

---

## 10. 建议

**建议另立中文 fine-tune 任务。** 理由：英语门槛已过（§2），"英语过门槛后才评估中文 fine-tune"的前置条件成立；而 P0.11 已证明原版 Smart Turn 在**混合中英语料**上 0 达标（§4），说明英语可用不等于中文可用，中文值得单独立项。turn-1-mini 官方**仅声称英语**（未测其它语言），中文 fine-tune 应针对**两模型分别**评估，并以本任务同一套协议/指标为基线。
