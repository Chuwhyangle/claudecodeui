# 降噪算法实验报告

日期：2026-10-21

问题：在 Live Voice 的 5.6–6.2 dB SNR 条件下，降噪能否减少“每句话丢几个字”？

## 数据

干净语音来自现有目标说话人样本：

- `/tmp/speaker-gate-audition-2026-10-20/01-enroll/` 5 条
- `/tmp/speaker-gate-audition-2026-10-21/01-extra-target/` 5 条

噪声来自真实 Live Voice capture
`b8360029-b6da-479b-8ea9-806e1bfbb632.wav` 的非语音区间：8 段、共 54.79 秒。
每条干净语音按 **5.6 dB** 和 **10 dB** 两个目标 SNR 与不同噪声片段混合，共 20 条测试音频。

## 对齐的模型

| arm | 模型 | 采样率 | 体积 | 许可 |
|---|---|---|---:|---|
| `raw` | 不降噪 | 16k | — | — |
| `gtcrn` | `gtcrn_simple.onnx`，sherpa-onnx | 16k | 524 KB | MIT |
| `dpdfnet` | `dpdfnet_baseline.onnx`，sherpa-onnx | 16k | 8.4 MB | 见 sherpa 模型发布页 |
| `dpdfnet12` | 同上 + 12 dB attenuation limit | 16k | 8.4 MB | 同上 |
| `rnnoise` | FFmpeg `arnndn` + `std.rnnn` | 48k→16k | 296 KB | RNNoise/模型仓库许可 |
| `rnnoise085` | 同上，`mix=0.85` | 48k→16k | 296 KB | 同上 |

GTCRN 和 DPDFNet 使用 `OfflineSpeechDenoiser`，另用 `OnlineSpeechDenoiser`
验证了 DPDFNet 流式输出。RNNoise 通过 FFmpeg 升采样到 48k、降噪、再回 16k。

## 实验一：本地 SenseVoice ASR

参考文本是干净语音自己的 SenseVoice 转写；CER 为字符级编辑距离 / 参考字符数。
这条实验比较的是“同一识别器在 noisy / enhanced 上的相对变化”。

| SNR | arm | macro CER | micro CER | mean SI-SDR |
|---:|---|---:|---:|---:|
| 5.6 | raw | **0.0680** | **0.0619** | 5.6 dB |
| 5.6 | gtcrn | 0.1034 | 0.0929 | 7.7 dB |
| 5.6 | dpdfnet | 0.1296 | 0.1176 | **11.5 dB** |
| 5.6 | rnnoise | 0.0857 | 0.0743 | -19.7 dB* |
| 5.6 | rnnoise085 | 0.0667 | 0.0588 | -19.7 dB* |
| 10 | raw | 0.0577 | 0.0495 | 10.0 dB |
| 10 | gtcrn | 0.0690 | 0.0619 | 11.5 dB |
| 10 | dpdfnet | 0.0867 | 0.0774 | **15.6 dB** |
| 10 | rnnoise | 0.0469 | 0.0433 | -19.2 dB* |
| 10 | rnnoise085 | **0.0389** | **0.0372** | -19.2 dB* |

\* RNNoise 的 SI-SDR 为负主要是输出未做延迟对齐、以及 48k↔16k 链路造成的；
不应单独把这一列读成“音质更差”。CER 才是本实验的主指标。

结论：**在 SenseVoice 上，没有一种降噪稳定降低 CER；raw 在 5.6 dB 最好。**
GTCRN/DPDFNet 明显提高了 SI-SDR，但 CER 变差，说明增强引入了识别器敏感的失真。

完整逐条结果：`sensevoice-results.csv`。

## 实验二：真实上游 Qwen realtime ASR

生产使用的是 `qwen3.8-omni-flash-realtime`，不是 SenseVoice。为贴近生产，
取 6 条 5.6 dB 混合音频，通过真实 `/api/voice-realtime/diagnose` 路径，
`dryRun: true`、`speed: 1`（c01/c02/c05/c06/c08/c09）重放。

参考文本采用人工校正后的干净转写。CER 如下：

| clip | raw | GTCRN | DPDFNet |
|---|---:|---:|---:|
| c01 | 0.040 | 1.000（未识别） | **0.000** |
| c02 | 0.261 | 0.174 | **0.130** |
| c05 | 0.100 | 0.100 | **0.000** |
| c06 | 0.081 | 0.081 | **0.065** |
| c08 | **0.095** | 0.333 | 0.238 |
| c09 | 1.000（未识别） | 0.059 | **0.059** |
| **macro** | **0.2628** | 0.2911 | **0.0820** |
| 有转写 | 5/6 | 5/6 | **6/6** |

GTCRN 的两次主要失败：

- c01：完全 `heard:false`；
- c05：被切成两段，且丢掉“用户最后打开的会话”中的部分字；
- c08：切段并把 `MCP` 听成 `C P`。

DPDFNet 没有出现 `heard:false`，并且在 c01/c05/c09 完全正确；
c02/c08 仍有少量错误，但整体最稳。

### DPDFNet 12 dB attenuation limit

对 c01/c05/c06/c08/c09 五条：

| arm | macro CER | 说明 |
|---|---:|---|
| DPDFNet 全强度 | 0.0723 | c05 正确识别 `MCP` |
| DPDFNet 12 dB | **0.0592** | c08 明显改善；c05 退回 `HTTP` |

12 dB 限幅不是全面更好，但它在 c08 这种过度抑制场景下有保护作用。
建议把 12 dB 作为默认起点，并保留全强度作为对照。

### DPDFNet 流式输出

用 `OnlineSpeechDenoiser`（`frameShiftInSamples=160`，10ms）重放 c01/c05/c08：

- c01 完全正确；
- c05 完全正确（`MCP`）；
- c08 仍停留在“相中……事件”的错误上，略差于离线。

流式输出没有引入新的系统性失败，可以作为生产形态的候选。

## 对实际“丢字”会话的回放

上面的合成样本之后，又把用户实际抱怨的那段 68.34s 会话
`b8360029-b6da-479b-8ea9-806e1bfbb632.wav` 原样送入 7 个 arm。
逐条 captions / session_send 在 `COMPLAINT-CAPTURE.md`。

结果与合成子集相反：

| arm | caption 数 | 观察 |
|---|---:|---|
| raw | 6 | 最接近原始 Live Voice 转写；最后一句丢失 |
| GTCRN | 8 | 明显加戏（英国、威尔士、command、operation） |
| DPDFNet 全强度 | 8 | 加戏（被撞到、晕船、同样的方法） |
| DPDFNet 12 dB | 6 | 段落数接近 raw，但仍幻觉“如果为空” |
| DPDFNet 流式 | 8 | 幻觉最重（没电、给我充、晕死） |
| RNNoise 1.0 | 7 | 部分恢复“为什么总是会丢很多次”，但幻觉“碰撞/隐藏/赚过” |
| RNNoise 0.85 | 6 | 类似 1.0，仍幻觉“看错/隐藏字段/被撞过” |

**逐字 caption 上，没有任何降噪 arm 比 raw 更忠实；它们都增加了替换/加戏。**
但这不等于产品上不可用：用户试听后的判断是 **DPDFNet 12 dB 限幅 / RNNoise 0.85
的改写质量最高**。这段音频本身质量较差，用户声音与背景人声接近，部分字在原始音频中
已经很难辨认；在这种情况下，“改写后是否保留用户意图”比逐字 caption 更有意义。

### 人类试听结论

- 源音频：用户声音与背景人声音量接近，一些字本身不可辨；
- DPDFNet 12 dB 与 RNNoise 0.85 的改写质量最好；
- DPDFNet 全强度、DPDFNet 流式、GTCRN 的加戏/幻觉更多。

### 流式 API 的限制

`attenuationLimitDb` 只在 **OfflineSpeechDenoiser** 生效。
`OnlineSpeechDenoiser` 接受该字段，但输出与全强度字节相同：

```text
dpdfnet_stream.wav == dpdfnet_stream12.wav
```

因此“DPDFNet 12 dB”不能直接通过当前流式 API 上线。现实选项：

1. **RNNoise 0.85**：流式可用，`mix` 参数真实生效；
2. DPDFNet 流式 + 与原始音频后混（如 0.85 × enhanced + 0.15 × raw）近似限幅；
3. DPDFNet 12 dB 只用于离线/批处理路径。

## 结论

1. **改写质量的人类裁决：DPDFNet 12 dB ≈ RNNoise 0.85 > 其他。**  
   这两个是下一轮候选；DPDFNet 全强度和流式加戏更多。

2. **逐字 caption 的忠实度：raw 最保守。**  
   降噪 arm 会增加替换/幻觉；因此必须同时看 caption 和 rewrite，不能只看 CER。

3. **GTCRN 不建议上线。**  
   极轻（524 KB，RTF ≈ 0.030），但真实上游和实际会话上都出现完全未识别、
   切段和加戏。

4. **RNNoise 只推荐 0.85，不推荐 1.0。**  
   0.85 的用户改写质量最好之一且流式可用；1.0 在实际会话上出现“碰撞/隐藏/赚过”等替换。

5. **模型相关，不能跨 ASR 直接外推。**  
   SenseVoice 对增强伪影更敏感，Qwen realtime 在合成子集上受益于 DPDFNet；
   真实会话又显示全强度 DPDFNet 增加幻觉。必须用真实会话、真实上游和人工试听判定。

6. **主要干扰是背景人声，不是稳态噪声。**  
   单通道通用降噪对“另一个说话人”帮助有限；下一类算法应考虑
   target-speaker extraction / voice isolation（Krisp BVC、ai-coustics Quail Voice Focus，
   或基于 CAM++ 的会话内 TSE）。

## 建议的落地形态

- 先以 **shadow 模式**同时接入 **RNNoise 0.85** 和 **DPDFNet 流式 + 后混（0.85）**；
- 设置 `off | shadow | on` 三态，默认 `off`；
- **原始音频**继续供 CAM++ 声纹跟踪和 VAD；增强音频只送上游 ASR；
- 每个连接一个 denoiser 实例，连接结束 `flush()` + `close()`；
- 失败/超时/模型缺失时 **fail-open**，发送原始音频；
- 关闭浏览器 `noiseSuppression`，避免双重抑制；
- 用 20+ 条真实会话，同时评估：
  - 人工试听改写质量；
  - caption / rewrite 的 WER、deletion、hallucination；
  - 端到端延迟和 CPU；
- 如果 RNNoise 0.85 与 DPDFNet 后混都无法稳定改善，转向 voice isolation / TSE，
  而不是继续加大单通道降噪强度。

## 局限

- 真实上游只有 6 条、全部为 5.6 dB 合成混合；样本量不足以定最终阈值。
- 噪声来自一次 capture 的非语音段，不代表所有噪声类型（键盘、多人说话、风噪）。
- 干净参考中有一部分本身来自 ASR，可能有错；本报告已尽量人工校正。
- 没有测 DNSMOS P.835；SI-SDR 与 CER 都不是人耳主观质量。
- 本地 SenseVoice 与生产 Qwen realtime 的排序不同，报告把两者分开呈现。

## 复现

```bash
# 1. 准备 20 条混合音频（需要 soundfile/numpy）
/data/home/yale/work/sv-probe/v/bin/python3 experiments/voice-denoise-eval/prepare_dataset.py

# 2. GTCRN / DPDFNet
node experiments/voice-denoise-eval/denoise_sherpa.mjs

# 3. RNNoise
/data/home/yale/work/sv-probe/v/bin/python3 experiments/voice-denoise-eval/run_rnnoise.py

# 4. SenseVoice 评测
/data/home/yale/work/sv-probe/v/bin/python3 experiments/voice-denoise-eval/evaluate.py
```

模型文件在 `/tmp/voice-denoise-eval/models/`：

- `gtcrn_simple.onnx`（524 KB）
- `dpdfnet_baseline.onnx`（8.4 MB）
- `std.rnnn`（296 KB）

## 来源

- [GTCRN official repository](https://github.com/Xiaobin-Rong/gtcrn)
- [sherpa-onnx Speech Denoiser API](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_speech_denoiser.html)
- [DeepFilterNet vs RNNoise WER benchmark](https://www.creativeainews.com/articles/deepfilternet-vs-rnnoise-vs-ffmpeg-noise-removal-2026/)
- [Real-time noise suppression comparison](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/real-time-noise-suppression-krisp-rnnoise-deepfilternet)
- [ASR WER after speech enhancement report](https://www.cjvt.si/wp-content/uploads/2025/09/ASR_WER_Report_with_Detailed_Error_Analysis.pdf)
- [When Cleanup Hurts ASR](https://lillytechsystems.com/ai-voice/audio-preprocessing/when-cleanup-hurts-asr.html)
