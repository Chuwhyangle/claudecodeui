---
id: gap-voice-five-vad-offline-comparison-on-real-corpus
title: 五方案 VAD 离线对比：TEN / Silero / WebRTC / FSMN / 出货 STS，在第三次实测真实 372.66 s
  连续音频上统一测台与真值指标
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

人 yale 要求：在本工作环境用**第三次实测的真实 372.66 s 连续 WAV**，对五个方案做**真正的离线**对比——TEN VAD、Silero VAD（重点）、WebRTC VAD、FunASR FSMN-VAD、以及现有 STS（基线）；统一 16k mono、帧级概率/判定、同一 postfilter；算过滤时长/比例、语音遗漏/边界损失、CPU 耗时/RTF、RSS；至少检查多阈值 tradeoff；**禁止模拟冒充**、禁止把 turn/endpointing 用于模型触发、禁止改生产配置/重启/外发音频。

### 本轮已完成的真实测量（下轮接手即可复现）

测台：`/tmp/vad5/{run.py,decomp.py,sts_dump.mts}`，产物在 `/tmp/vad5/out/`。网格 **20 ms（320 样本 @16k）**，与出货 STS 同网格；**统一 postfilter**：preroll 500 ms + hangover 320 ms（出货常量），对所有方案一致。

输入（已验证可读）：`~/.cloudcli/voice-realtime-capture/af5559c0-d347-41f3-a6f0-f02a597af1e9.wav`，5,962,560 样本 = **372.66 s**，PCM16/16000 Hz/单声道，真峰值 30901。

| 方案 | 权重/实现（真实，非模拟） | 语音% | **过滤（非语音）%** | 参考-语音遗漏 | RTF | cpu |
| --- | --- | --- | --- | --- | --- | --- |
| **出货 STS**（基线） | `createSilenceTailGate`，经 tsx **跑出货模块本身** | 100% | **0.00%**（18633/18633 帧全 `streaming`） | — | — | — |
| Silero@0.5 | 官方 v5 ONNX，2,327,524 B，sha `1a153a22f4509e29` | 18.63% | **81.37%** | 12800 ms（20.87%） | 0.0027 | 5.25 s |
| TEN VAD@0.5 | 官方 ONNX，332,211 B，sha `718cb7eef47e3cf5`（sherpa-onnx 封装，自带特征提取） | 18.76% | **81.24%** | 13260 ms（21.62%） | 0.0031 | 1.17 s |
| WebRTC agg1 | 真实 C 扩展（`webrtcvad-wheels` 预编译） | 56.09% | **43.91%** | 2900 ms（4.73%） | 0.0002 | 0.15 s |
| WebRTC agg2 / agg3 | 同上 | 51.03% / 40.61% | 48.97% / 59.39% | 5.90% / 11.19% | 0.0002 | 0.06 s |
| **FSMN-VAD** | **未装成** | — | — | — | — | — |

进程 RSS 峰值 **137,688 KB**（全部方案同进程）。

**边界 vs 内部切断分解**（EDGE 300 ms 带内算边界裁剪）：Silero **内部切断 8900 ms = 参考语音的 14.56%**、最低覆盖段 49.5%；TEN **9360 ms = 15.31%**、最低 44.3%；WebRTC agg1 **2280 ms = 3.73%**、最低 67.2%。

**参考是何物（局限必须写明）**：上述"参考-语音遗漏"的分母是 **capture timeline 的 18 段 upstream `speech_started/stopped`**——那是**上游模型的边界，不是真值**，且它包含尾部衰减/低电平尾音。因此 14–15% 的"内部切断"是**上界**，不等于真丢话。

### 本轮未能装成 / 未做的

- **FSMN-VAD 未安装**：`sherpa_onnx 1.13.8` 的 VAD 只有 `SileroVadModelConfig` / `TenVadModelConfig`（**无 FSMN VAD 配置**）；FunASR 路线需 `funasr` + torch（重）或 `funasr-onnx`（未试）。**原因已记，下轮先试 `funasr-onnx` 的 16k FSMN-VAD ONNX，装不上就写明并给出替代**。
- `webrtcvad` 源码包**编译失败**（无 wheel、无编译器），改用 **`webrtcvad-wheels`** 预编译版成功——这是真实 C 扩展，非模拟。
- **TEN VAD 只跑了 0.5 一档**（多阈值未做）；Silero 0.3/0.5/0.7 与 WebRTC agg1/2/3 已构成 tradeoff 对照。
- **未用真值 harness**：本轮指标以 Qwen 18 段 proxy 为参考。**仓库已有 `experiments/voice-vad/`（`gap-voice-vad-truth-harness`，done）——真人单句合成时间线 + 精确真值 + 边界/漏检/过切/中途切指标**。下轮必须复用它，把上面四个引擎接进去重算真值指标。

## Plan

1. 复用 `experiments/voice-vad/{timeline,metrics,run}.mjs`：把 Silero / TEN / WebRTC / STS 四个引擎做成 adapter 接进去，用**精确真值**重算边界/漏检/过切/中途切。
2. 在**真实 372.66 s 语料**上保留一次 proxy 参考跑（并明确标注 proxy），便于与真值指标对照。
3. 装 FSMN-VAD：先 `funasr-onnx` 的 16k FSMN ONNX；不行再议，**必须给出失败原因与替代**。
4. 补齐阈值 tradeoff：Silero（含 0.2–0.8）、TEN（0.2–0.8）、WebRTC（agg0–3）在同一张「过滤% × 真值漏检/过切%」表上。
5. 统一 postfilter 保持 preroll/hangover 可参数化，报告至少两档（保守/宽松）。
6. 产物落盘：引擎适配器、逐帧概率/判定、结果 JSON、RTF/RSS 表。

## AC

- [x] AC1 五个方案（TEN / Silero / WebRTC / FSMN / 出货 STS）**全部有真实读数**，或对未成者给出**具体失败输出与原因**及替代方案；⛔ 任何"模拟/占位"模型一律不算（取假形态：用一个随机/常数判决器冒充某方案 ⇒ 红）。
- [x] AC2 真值指标：四个以上引擎接入 `experiments/voice-vad/` 的**精确真值**指标，报告给出边界/漏检/过切/中途切四类读数（与 proxy 参考的那一版并列，且显式标注哪一版是 proxy）。
- [x] AC3 阈值 tradeoff：Silero/TEN 各 ≥4 档、WebRTC agg0–3，同一张「过滤% × 漏检%/过切%」表；STS 基线在同一网格与同一 postfilter 下的读数（本轮实测 **0 帧裁**；本任务复核后修正为 **1.31%**，见 `docs/operations/voice-five-vad-offline-comparison.md` §10）在表内。
- [x] AC4 成本读数：每方案 CPU 时间、RTF、进程 RSS 峰值；统一 16k mono 输入与**同一 postfilter**（preroll/hangover 可参数化，≥2 档）。
- [x] AC5 权重可溯源：报告写出每个模型的来源 URL 与 sha256 前 16 位；⛔ 不得使用来源不明的权重。
- [x] AC6 不改生产配置（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（pid 前后相同）、**不把模型音频外发**（只有权重下载是入站）。
- [x] AC7 服务端 VAD 的职责边界不变：只用本实验判定"过滤哪些帧"，**不得**由这些 VAD 驱动 turn detection / commit / `response.create`。

## DoD

五个方案在**同一份真实 372.66 s 连续音频**、同一 16k mono 输入、同一帧网格与同一 postfilter 下都有可复现的真实读数（或明确的未装成原因）；tradeoff 表与真值指标齐备；每个方案的过滤比例、真值漏检/过切、CPU/RTF/RSS 都能被下一个人从产物重算；生产配置与线上服务未被触碰。

## Touches

- experiments/voice-vad/engines/silero.py (new)
- experiments/voice-vad/engines/ten.py (new)
- experiments/voice-vad/engines/webrtc.py (new)
- experiments/voice-vad/engines/fsmn.py (new)
- experiments/voice-vad/run-real-corpus.mjs (new)
- docs/operations/voice-five-vad-offline-comparison.md (new)
- tasks/gap-voice-five-vad-offline-comparison-on-real-corpus.md

## Notes

**查重**：`gap-voice-vad-truth-harness`（done）提供**度量工具与精确真值**——本任务**复用它**，不另造指标；`gap-voice-live-vad-readings`（done）是连续输入的前后对照读数；`gap-voice-streaming-vad-endpointing`（done）是**浏览器侧**流式 VAD；`gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt` 是**出货 STS 的钳位缺陷复议**。本任务**不与任何一条重叠**：它做的是**多引擎横向对比 + 真值指标**。

**与本轮实测的关系**：`/tmp/vad5/` 的测台与 `/tmp/vad5/out/` 的产物是**临时**的（`/tmp` 会被回收）。下轮应把引擎适配器落进 `experiments/voice-vad/engines/` 并提交，使读数可复算。本轮嵌入 Proposal 的那张表即为起点基线。

### 本任务实测结果（2026-10-13 落地）

五个方案**全部有真实读数**（无失败、无模拟）：Silero v5 ONNX `1a153a22f4509e29`、TEN ONNX `718cb7eef47e3cf5`、WebRTC 真实 C 扩展、FunASR FSMN-VAD ONNX（ModelScope，3 文件）、出货 `createSilenceTailGate` 本体在进程内逐帧驱动。真实 372.66 s / 18633 帧，出货 postfilter 500/320，全档位与真值指标见 `docs/operations/voice-five-vad-offline-comparison.md`。

- **AC1** 五方案全成，`failures=[]`；每引擎在真实语料上跨档位给出**互不相同**的语音占比（常数/随机判决器只会给出 1 个值）⇒ 非模拟。
- **AC2** 4 个模型引擎（silero/ten/webrtc/fsmn）接入 `metrics.mjs` 的精确真值，synthetic + 4 段 long 语料，四类读数齐备；proxy 版（real 18 段）并列且显式标注。
- **AC3** Silero 5 档 / TEN 5 档 / WebRTC agg0–3 / FSMN 5 档在同一张表；STS 基线与它们**同一网格同一 postfilter** 下为 **1.09%**（gate 原样 1.31%）。
- **AC4** 每引擎 CPU/RTF/RSS 齐备（三次运行的区间）；postfilter 两档（500/320、200/100）外加 STS 的 0/0 对照。
- **AC5** 每个权重写出 URL + sha256 前 16 位，且**逐字节下载比对过**（文档 §7）。WebRTC 与 STS 无权重文件，据实记 `null` 并写明原因。
- **AC6** `VOICE_REALTIME_SILENCE_TAIL=null`（解析为禁用）、:3001 pid 前后同为 366403、无出站音频（只有权重入站）。
- **AC7** 无任何 turn detection / `commit` / `response.create` 调用（grep 无命中，只有注释）；STS 是被测对象，未接线到代理链路。

**与 Proposal 表的两处修正**（原因都写在文档里）：出货 STS 的 0.00% 是**测台缺陷**（`Float32Array` 喂给了要 base64 PCM16 的 `observe()`），真实读数是 1.31%；FSMN 由「未装成」变为**已成**（走 `funasr-onnx` 路线）。
