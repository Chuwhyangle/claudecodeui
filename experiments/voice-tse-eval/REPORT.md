# TSE 离线验证报告 — 2026-10-20

> 2026-10-21 更新：用户已逐一听过并确认目标/非目标标签。新的确认标签实验（声纹模型选择、阈值标定、旁人先说话、core 选择器）见 [`CONFIRMED-LABELS.md`](./CONFIRMED-LABELS.md)。

任务：基于上一轮挑选的音频样本，验证各目标说话人提取（TSE）实现是否能在持续噪声/旁人说话中保留目标用户的声音。

**结论先行：**

1. **只有 VoxLock 在这一批样本上表现出可用增益**，但前提是**用同一会话内的 3–4 秒目标语音做注册**。文件模式中位数 **+5.3 / +6.0 / +5.2 dB SI-SDRi**（单干扰 0/5/10 dB），babble **+9.8 dB**；流式模式中位数 **+10.1 dB**。
2. **跨天/跨会话的预注册声纹全部失败**：同一天不同录音中位数 **−10.3 dB**，跨天 **−3.1 ~ −14.7 dB**，最坏 **−68 dB**（模型把干扰者当成目标）。这是本报告最重要的设计约束。
3. **原始混合音频的目标人 CAM++ 余弦已经很高**（0 dB 时中位数 0.918），所以“只由特定用户触发/识别”用**声纹门控**就够了；TSE 的价值只是改善送给 ASR 的音频，不是身份判断。
4. **GTCRN 是降噪器，不是 TSE**：纯噪声 0 dB 中位数 **+8.5 dB**，语音混合约 **0 dB**。风扇/空调/街道用它，旁人说话不要指望它。
5. **OpenSpeakerBeam-SS、open-voicefilter-lite 与 Vanta 在这批数据上不具备中文生产可用性**：OSB 单干扰时中位数 −9.5 dB（babble +4.8），VFL 语音上基本是 passthrough（≈0 dB）；Vanta 在英文对照上可到 +10.4 dB，但在中文目标上三种注册方式全部为负（−6.1 ~ −10.1 dB），且仓库未找到 LICENSE。
6. **`live()` 自动锁定可用但弱于显式样本**（中位数 +5.9 vs +10.1 dB），且需要目标先单独说约 4 秒；3 秒会把干扰者混进注册样本。

---

## 1. 跑过 / 没跑的实现

| 实现 | 版本/来源 | 许可 | 状态 | 备注 |
|---|---|---|---|---|
| **VoxLock** | `voxlock==1.1.1`，HF `arbazsiddiqui/voxlock` | Apache-2.0 | **已跑** | ONNX，16 kHz，CPU；文件 `isolate()` + 流式 `stream()`/`live()` |
| **Vanta** | GitHub `Komalpreet2809/Vanta`，`fully_ours/best.pt` + `spk_encoder/best.pt`（110 MB） | **未找到 LICENSE 文件** | **抽查** | PyTorch/CPU，16 kHz，9.5M 参数；英文 in-domain 可用，中文目标失败（见 3.4） |
| **OpenSpeakerBeam-SS** | GitHub `helloooideeeeea/OpenSpeakerBeam-SS`，checkpoint `best_model.pth`（33 MB） | MIT | **已跑** | PyTorch/CPU；Resemblyzer d-vector；自带测试 SI-SNR −5.89 |
| **open-voicefilter-lite** | PyPI `open-voicefilter-lite==0.2.0` | Apache-2.0（包元数据） | **已跑** | ONNX，PCM-in/PCM-out，10 ms hop；源码仓库 URL 不可达 |
| **GTCRN** | `gtcrn_simple.onnx`（524 KB），sherpa-onnx | MIT | **已跑** | 仅降噪，非目标说话人；作为对照 |
| USEF-TSE | `ZBang/USEF-TSE` | **CC BY-NC 4.0** | **未跑** | 8 kHz、CUDA-oriented、无官方 ONNX；与本仓库 16 kHz 实时链路不匹配，且非商用 |
| TargetVoice | Interspeech 2025 | 未公开 | **未跑** | 无公开代码/权重 |
| Fast-TSE | `ns2250225/Fast-TSE` | 未明确 | **未跑** | 本质是 SepFormer 盲分离 + ECAPA 选人，不是目标条件 TSE；另一套重依赖 |
| VoxLock fp32 vs int8 | 同包 | Apache-2.0 | 抽查 | 在 test-04 上逐个样本检查，差异 ≤0.5 dB；全量用 int8 |

---

## 2. 实验设置

- **目标语音**：上一轮试听集的 6 条（4.06–39.26 s），16 kHz mono：
  `test-03_clean_36ec3cc9`、`test-04_4e06e56c`、`test-05_long_6576828c`、`test-06_long_9f7298ad`、`edge-01_quiet_a21eccb6`、`edge-03_quiet_long_ef31fecb`。
- **干扰**：EOT-Bench 的 6 条英文真实语音（不同 speaker 前缀），单干扰与 3 人 babble。
- **噪声**：粉红噪声（平稳噪声的代理）。
- **SNR 定义**：在**目标语音活动帧**上把干扰/噪声调到 0/5/10 dB（不是整段 RMS，避免干扰者静音段让“0 dB”名不副实）。
- **混合峰值**：统一压到 0.7，避免削波。
- **注册条件**：
  - `oracle`：从测试片段本身取 3 s（**上界/有泄漏**，代表“同会话样本”）；
  - `same_day`：同一天的另一条录音（4 个目标有）；
  - `cross_day`：固定用 2026-10-07 的 `enroll-04`（跨天）；
  - `auto`：VoxLock `isolate()` 不传 sample，内部用 `loud_sample()`。
- **指标**：
  - `SI-SDRi` = SI-SDR(输出, 干净目标) − SI-SDR(混合, 干净目标)，±2 s 互相关对齐；
  - `cos_target` = CAM++（3D-Speaker CAM++ 192-D）输出与干净目标的余弦；
  - `cos_margin` = `cos_target − max cos(输出, 各干扰)`；
  - `RTF` = 处理耗时 / 音频时长。
- **环境**：Python 3.12，onnxruntime 1.31.0，torch 2.14.1+cpu，**无 GPU**，CPU-only。

> `oracle` 不是可部署的“预注册”，它是“同会话样本”的上界。可部署的版本见第 4 节 `live()`/`stream()`。

---

## 3. 主结果（6 个目标 × 6 条件，中位数）

### 3.1 SI-SDRi（dB，越高越好）

| 方法 | speech_0 | speech_5 | speech_10 | babble_0 | noise_0 | noise_10 |
|---|---:|---:|---:|---:|---:|---:|
| none | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| **gtcrn** | −0.18 | −0.17 | −0.52 | −0.56 | **+8.48** | **+5.44** |
| **vox_oracle** | **+5.32** | **+6.03** | **+5.17** | **+9.79** | −3.36 | +1.94 |
| vox_same_day（n=4） | −10.27 | −10.04 | −10.54 | −1.20 | −8.48 | −11.89 |
| **vox_cross_day** | −3.11 | −5.94 | −10.15 | −9.32 | −10.68 | −14.75 |
| vox_auto | +1.12 | +3.56 | +4.10 | −1.33 | −19.51 | −6.35 |
| osb_oracle | −9.53 | −8.52 | −11.70 | +4.80 | −3.47 | −11.96 |
| osb_cross_day | −4.12 | −3.76 | −5.50 | +6.80 | +2.93 | −5.15 |
| vfl_oracle | −0.04 | −0.05 | −0.09 | −0.05 | +1.65 | +1.60 |

要点：
- VoxLock 的 `oracle` 在单干扰/babble 全部为正，方差也很大（speech_0 范围 **−1.80 ~ +16.69**），取决于注册样本质量。
- 跨天注册会**反向**：最坏 −68.08 dB（test-05 speech_10），`cos_target` 只有 0.136，`cos_interferer` 0.661 —— 它把干扰者提取出来了。
- OSB 在单干扰时中位数为负，在 babble 时为正；VFL 在语音上几乎完全不动（−0.04 dB），只在噪声上有 +1.6 dB 的弱降噪。

### 3.2 目标人余弦（`cos_target`，中位数）

| 方法 | speech_0 | speech_5 | speech_10 | babble_0 | noise_0 | noise_10 |
|---|---:|---:|---:|---:|---:|---:|
| none（原始混合） | 0.918 | 0.949 | 0.972 | 0.772 | 0.696 | 0.873 |
| gtcrn | 0.882 | 0.912 | 0.938 | 0.751 | **0.401** | 0.716 |
| vox_oracle | **0.953** | **0.965** | 0.973 | **0.918** | 0.409 | 0.732 |
| vox_cross_day | 0.892 | 0.925 | 0.934 | 0.595 | 0.138 | 0.457 |
| osb_oracle | 0.467 | 0.555 | 0.555 | 0.624 | 0.294 | 0.376 |
| vfl_oracle | 0.909 | 0.944 | 0.968 | 0.778 | 0.701 | 0.867 |

**原始混合的目标余弦已经很高**；VoxLock 在语音上只把它从 0.918 提到 0.953（babble 从 0.772 提到 0.918），而 OSB 和 GTCRN（噪声）会把它拉低。因此：
- **身份/触发判定应该用原始音频 + CAM++ 门控**；
- 增强后的音频只用于 ASR，不要用它做身份判断。

### 3.3 RTF（中位数，越低越好）

| 方法 | RTF |
|---|---:|
| gtcrn | 0.044 |
| voxlock（文件 `isolate`） | 0.222 |
| voxlock（流式 40 ms chunk） | ~1.0 |
| open-voicefilter-lite | 0.057 |
| OpenSpeakerBeam-SS | 0.011–0.014 |

VoxLock 流式在这台无 GPU 机器上约 **1.0× 实时**（40 ms chunk，单连接），文件模式 0.22×；生产上要留 CPU 余量，或只在检测到重叠时启用。

### 3.4 Vanta 抽查（中文失败，英文可用）

Vanta 是 16 kHz、9.5M 参数、从零训练的 TSE，README 宣称英文 unseen speakers 中位数 +9.28 dB。在本项目样本上抽查（0 dB 单干扰）：

| 用例 | 注册方式 | SI-SDRi |
|---|---|---:|
| 中文 test-03 | oracle（同片段） | −8.74 |
| 中文 test-03 | same_day | −9.54 |
| 中文 test-03 | cross_day | −10.12 |
| 中文 test-04 | oracle | −6.13 |
| 中文 test-04 | same_day | −7.04 |
| 中文 test-04 | cross_day | −8.85 |
| 英文 librispeech-004 | other English clip | **+10.36** |
| 英文 librispeech-004 | Chinese cross_day | −23.26 |

结论：Vanta 的英文能力真实存在（+10.4 dB），但对中文目标/中文注册样本**不具备零样本迁移能力**；同时它对注册样本同样高度敏感（英文目标用自身前 5 秒反而 −9.27 dB）。仓库没有 LICENSE 文件，默认不可商用。未做全量矩阵。

---

## 4. 会话内 / 实时结果（真正可部署的条件）

目标先单独说 4 秒，然后干扰者在 0 dB 加入；比较加入后的重叠段。6 个目标的中位数：

| 方式 | SI-SDRi 中位数 | 范围 | RTF | 说明 |
|---|---:|---:|---:|---|
| `vox_stream`（显式 3 s 样本） | **+10.11** | +0.17 ~ +16.46 | 1.016 | 流式，等价于文件 `isolate` |
| `vox_isolate`（显式 3 s 样本） | **+10.29** | +0.14 ~ +16.46 | 0.218 | 文件模式，质量参照 |
| `vox_live()`（自动锁定） | **+5.92** | +0.60 ~ +13.07 | 0.727 | 不需要显式样本，但更弱 |

逐目标（`vox_stream` / `vox_live`，dB）：

| 目标 | stream | live |
|---|---:|---:|
| test-03 | +15.44 | +8.73 |
| test-04 | +0.17 | +0.60 |
| test-05 | +4.21 | +1.59 |
| test-06 | +10.61 | +13.07 |
| edge-01 | +9.61 | +3.12 |
| edge-03 | +16.46 | +8.97 |

结论：
- **显式样本 + 流式**是质量最好的部署形态，中位数 +10 dB；流式与文件模式几乎无差（+10.11 vs +10.29），说明实时路径没有质量损失。
- `live()` 自动锁定可用，但中位数只有 +5.9 dB，且在 test-04/test-05 上只有 +0.6/+1.6 dB；需要目标先单独说 ≥4 秒，并用声纹门控确认锁的是目标而不是旁人。
- 3 秒 lead 会被干扰者污染（我们在早期试验中观察到了），**建议至少 4 秒**。

---

## 5. 关键发现

1. **VoxLock 是“同通话/同会话”模型，不是持久声纹模型。** 它的注册样本必须来自当前录音条件；跨天、甚至同一天不同录音（test-06 与同一天 32 分钟前的样本）都会显著退化或反向。包文档的 `live()` 也是从当前通话收集 3 秒，印证了这一点。
2. **最危险的不是“不增强”，而是“增强错人”。** 跨天注册在 test-05 上 SI-SDRi −60 ~ −68 dB，输出与干扰者的余弦 0.66–0.71，与目标只有 0.07–0.14。生产上如果无条件信任 TSE 输出，会把模型听到的内容换成旁人。
3. **原始混合的 CAM++ 余弦已经足够做门控。** 0 dB 单干扰时中位数 0.918；babble 0.772；噪声 0 dB 0.696。TSE 对身份的边际收益很小，甚至可能为负（OSB 0.467）。
4. **GTCRN 与 TSE 是互补的，不是替代关系。** GTCRN 只处理平稳噪声（+8.5/+5.4 dB），对旁人说话约 0；VoxLock 处理旁人说话（+5~+10 dB），对纯噪声会退化（−3.4 dB）。正确顺序是：AEC → GTCRN（噪声）→ CAM++ 门控 → VoxLock（仅在重叠时）。
5. **OSB 与 VFL 不适合本场景。** OSB 在单干扰时中位数负值，babble 才正；VFL 是 passthrough。它们的 RTF 很低，但质量不够。
6. **注册样本选择本身是风险点。** `loud_sample()` 只按能量选 3 秒，可能选到瞬态/噪声段；test-04 的 oracle 样本只有 −1.8 dB，而跨天的 enroll-04 反而 +4.2 dB。生产上需要 VAD + 声纹置信度 + SNR 的样本选择规则，不能只看响度。
7. **VoxLock 的 int8 与 fp32 在抽查中差异很小（≤0.4 dB）**，int8 可以用于 CPU 部署；但全量 fp32 对照未做。

---

## 6. 局限

- **模拟混合**：目标 + EOT-Bench 英文干扰者；没有真实中文非目标说话人、电视、餐厅/会议室录音。
- **没有 ASR WER**：本机未安装 SenseVoice 模型；SI-SDR 与 CAM++ 余弦是代理指标，不能替代下游识别率。下一步应补 WER。
- **`oracle` 有泄漏**：样本来自测试片段本身，不是可部署条件；可部署条件是第 4 节的 `stream/live`。
- **`same_day` 只有 4 个目标**；`cross_day` 固定用同一条 10 月 7 日样本，不能代表所有跨天条件。
- **单机、无 GPU**：RTF 是这台机器的读数；并发连接、Node 事件循环、Python sidecar 开销未测。
- **OSB 的 Resemblyzer 嵌入**与 VoxLock 的注册编码器不同；它的负结果不能直接推广到所有 SpeakerBeam 系实现。
- **VFL 源码不可达**，只能按 PyPI 包行为评估；无法核实其训练数据/导出细节。
- **Vanta 只做了抽查**（2 个中文目标 + 1 个英文对照），不是全量矩阵；其英文能力与中文失败的方向性结论可信，具体数值不要外推。
- **USEF-TSE / TargetVoice / Fast-TSE 未跑**，原因见第 1 节；因此本报告不是“所有 TSE 实现”的完整排名。

---

## 7. 建议

### 7.1 推荐架构

```
麦克风 16k PCM
  → AEC（浏览器已有）
  → [可选] GTCRN 流式降噪（只处理平稳噪声）
  → CAM++ 声纹门控（用原始音频判定“是不是目标”）
  → 首个确认的目标语音片段：取 3–4 s 干净样本
  → VoxLock stream(sample)（仅会话内；仅在检测到重叠/低 SNR 时启用）
  → 上游 realtime 模型
```

- **不要**把跨天预注册样本直接喂给 VoxLock；如果要做持久声纹，先用 CAM++ 门控确认，再在会话内重新采样。
- **门控与增强分离**：门控读原始音频（cos_target 0.918），增强音频只送 ASR。
- **只在重叠时启用 VoxLock**：用 personal VAD/能量/双讲检测触发；纯噪声用 GTCRN，不要用 VoxLock。
- **注册样本选择**：VAD 选出连续 3–4 秒 speech，优先高 SNR、无削波、无音乐/瞬态的片段；用 CAM++ 与已确认目标的一致性作为质量门。
- **状态提示**：UI 明确显示“已锁定你的声音 / 未锁定 / 已过滤旁人”，失败时回退到不增强，而不是静音。

### 7.2 下一步实验

1. **ASR WER**：用同一批混合/增强音频跑 SenseVoice 或上游模型，比较 raw / GTCRN / VoxLock 的 CER/WER；这是判断 TSE 是否真的有价值的最终指标。
2. **真实中文负样本**：录 2–3 位同事，或引入 THCHS-30/Common Voice；当前英文干扰可能让任务偏容易。
3. **真实重叠场景**：两个人同时说话、电视、会议室；用真实录音而不是模拟混合。
4. **工程集成**：VoxLock 是 Python/ONNX，服务端是 Node。先做 Python sidecar（类似 `sensevoice-worker.ts` 的 JSON-line 协议），测并发下的 CPU/延迟；再决定是否把 ONNX 图移植到 `onnxruntime-node`。
5. **会话内样本策略**：比较“前 4 秒固定窗口” vs “CAM++ 置信度最高的 3 秒” vs “多段拼接”，目标是让 `vox_stream` 的中位数从 +10 提升并降低方差（test-04 只有 +0.17）。

---

## 8. 复现

脚本：
- `experiments/voice-tse-eval/run_eval.py` — 主矩阵（文件模式、跨会话/同会话注册、GTCRN/OSB/VFL）
- `experiments/voice-tse-eval/run_live.py` — 会话内实时（`stream`/`live`/`isolate`）
- `experiments/voice-tse-eval/out/results_all.csv` — 372 行逐条读数
- `experiments/voice-tse-eval/out/summary_all.json` — 中位数/范围
- `experiments/voice-tse-eval/out/live_results.csv` — 实时结果
- `experiments/voice-tse-eval/out/vanta_pilot.csv` — Vanta 抽查结果（中文失败/英文可用）

运行示例：

```bash
VENV=experiments/voice-turn-detection-compare/worst-cases-replay/.venv
$VENV/bin/python experiments/voice-tse-eval/run_eval.py \
  --targets test-03_clean_36ec3cc9,test-04_4e06e56c \
  --out experiments/voice-tse-eval/out/part1
$VENV/bin/python experiments/voice-tse-eval/run_live.py
```

依赖（实测版本）：`onnxruntime 1.31.0`、`sherpa-onnx 1.13.8`、`voxlock 1.1.1`、`open-voicefilter-lite 0.2.0`、`torch 2.14.1+cpu`、`torchaudio 2.11.0`、`resemblyzer`、`asteroid 0.7.0`、`asteroid-filterbanks 0.4.0`、`soundfile 0.14.0`、`scipy 1.18.1`。

音频路径：`/tmp/speaker-gate-audition-2026-10-20/`（不在仓库内；用户私有音频不提交）。
模型路径：`/tmp/tse-eval-models/`（GTCRN、CAM++），`/tmp/OpenSpeakerBeam-SS/checkpoints/`（OSB），VoxLock 由包自动下载。
