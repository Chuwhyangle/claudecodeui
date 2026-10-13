# 五方案 VAD 离线对比：TEN / Silero / WebRTC / FSMN / 出货 STS

在**第三次实测的真实 372.66 s 连续上行**上，把五个真实方案放到**同一帧网格、同一输入管线、同一 postfilter** 下逐帧判定，算过滤比例、真值指标、CPU/RTF/RSS 与多阈值 tradeoff。

- 测台：`experiments/voice-vad/run-real-corpus.mjs`（编排）+ `experiments/voice-vad/engines/{silero,ten,webrtc,fsmn}.py`（四个模型引擎适配器）。
- 指标：复用已落地的 `experiments/voice-vad/metrics.mjs`（精确真值四类读数），**不另造指标**。
- 本实验只做**逐帧分类**：不驱动 turn detection / `commit` / `response.create`，不改生产配置，不重启服务，不外发音频。

复现（在仓库根）：

```bash
node experiments/voice-vad/run-real-corpus.mjs --out /tmp/report.json
```

`--quick` 只跑真实语料，`--datasets real,exact` 可选数据集。

**环境**（本报告用的那一套，python 3.12.3）：`onnxruntime==1.31.0`、`sherpa-onnx==1.13.8`（TEN 的封装）、`webrtcvad-wheels==2.0.14.post1`、`funasr-onnx==0.4.3`（FSMN）、`numpy==1.26.4`。注意 `webrtcvad` 源码包在本机**编译失败**（无 wheel、无编译器），必须用 `webrtcvad-wheels` 的预编译版——它**就是**真实的 C 扩展，不是替代实现。

解释器用 `VAD_PY` 覆盖（默认 `/data/home/yale/work/voice-vad-engines/venv/bin/python`，仓库外的一个 venv）；模型路径用各适配器的 `SILERO_ONNX` / `TEN_ONNX` / `FSMN_MODEL_DIR` 覆盖。模型文件不在仓库里，按 §7 的 URL 自行下载并用 `sha256` 校验。

---

## 1. 结论速览（先读这段）

1. **出货 STS 在真实语料上几乎不裁**，但**不是 0**：修正后的读数是 **1.31% 未保留（4.9 s 一段尾部抑制）**，`suppressed`@17057 → `resumed`@17302。上一轮记的「0 帧裁 / 全部 streaming」是**测台缺陷**（把 `Float32Array` 喂给需要 base64 PCM16 字符串的 `observe()`），见 §7。真实形态是「一段连续语音 + 末尾静音尾」，STS 的静音尾逻辑只在**整段语音结束之后**才触发一次，所以它在一个没有中途长静音的语料上天然接近 no-op——这**不等于**它在有中途静音的语料上也不裁。
2. **Silero 的真实语料后验是饱和的**：`p10≈3.5e-6, p50≈4.0e-5, p90≈0.997, max≈1.0`。阈值 0.2→0.8 全扫，过滤比例只从 **80.88% 动到 81.67%（+0.79 点）**。想用阈值调 Silero 的行为，在真实语料上**基本调不动**；这是双峰分布，不是「阈值不敏感」。
3. **TEN 的曲线才是真的曲线**：0.2 时只过滤 27.96%，0.35 跳到 76.38%，0.5 到 80.51%，0.8 到 90.18%。拐点在 0.2–0.35 之间。
4. **WebRTC 是唯一「过滤比例」和「误报」同步走的**：agg0 只过滤 32.77% 却把语音保留到 67.23%；agg3 过滤 59.39% 但开始切内部（midcut 50%）。它便宜到可以忽略（RTF 1.2e-4）但**分不出**真实语料里那 30% 的尾部衰减。
5. **FSMN 阈值几乎无效**：0.3→0.9 只从 72.56% 动到 81.06%，因为它的分数被压在一个很窄的带里（真实语料上各档语音占比 16.4%→14.3%，差 2.1 点）。
6. **成本差两个数量级**：WebRTC 0.04 s / RTF 1.2e-4；Silero 0.98 s / 2.6e-3；TEN 1.13 s / 3.0e-3；FSMN 9.20 s / 2.5e-2（RSS 750 MB，最重）；STS 0.03 s / 9e-5。
7. **精确真值集上，四个模型引擎都在把真值语音段切碎**（primary 档 overseg/midcut 大量 100%），出货 STS 是五个里最保守的（保留 87–100%）。但见 §4 的读法警告：真值集只有 6–12 段，这些率是 **1/6 粒度**的。

---

## 2. 测台为什么可比

| 维度 | 统一做法 |
| --- | --- |
| 采样率 / 声道 | 16 kHz mono（适配器拒绝任何其它输入，不猜） |
| 帧网格 | 320 样本 = **20 ms**，与出货 STS 同网格 |
| 输入管线 | 同一个 WAV 字节 → 每个引擎自己的前处理（不重实现特征提取） |
| 引擎读数 | **原始逐帧判定**，不是引擎的 segment list |
| postfilter | 只有一层，`postfilterBits()`：把每段语音左扩 preroll、右扩 hangover；**参数化**，报告两档（出货 500/320、宽松 200/100） |
| 指标 | `framesToSegments()` → `metrics.mjs` |

**为什么必须读「引擎自己但只有逐帧判定」这一层。** sherpa-onnx 与 funasr-onnx 都同时提供逐帧判定和 segment list，后者额外带 `min_silence_duration`/`min_speech_duration` 之类的 **endpointing 迟滞**。若拿 segment list 去比，那两个引擎就白拿了一层别人没有的后处理，表就不是引擎之间的对比了。所以：

- **TEN**：用 `detector.is_speech_detected()`（每 256 样本窗口一次调用的**方法**，注意不是属性），不读 segment list。
- **FSMN**：`funasr_onnx` 的 `E2EVadModel` 本来就算每 10 ms 帧的语音后验 `score`，适配器录制这些分数并用**引擎自己的判据** `2*score - 1 >= speech_noise_thres` 重新套用在每个请求档位上（一次推理，多档阈值）。引擎自己的 segment list 只作为交叉核对输出（`ruleVsEngine`，真实语料上 **与纯分数规则一致率 0.9757**）。
- **Silero**：512 样本窗 + 64 样本上下文，窗概率归属到它覆盖到的 20 ms 帧。
- **WebRTC**：真实 C 扩展，`is_speech()` 每 20 ms 一帧；它的唯一旋钮是 `aggressiveness` 0–3，所以它的「档位」是四个激进度而不是四个阈值。
- **STS**：`server/modules/voice-realtime/voice-realtime-silence-tail.ts` 的 `createSilenceTailGate()` **在本进程里 import 后逐帧喂**（base64 PCM16，和 ws 代理喂它的一模一样）。一帧「被保留」当且仅当 `decision.frames.includes(audio)`（keepalive 帧是数字静音，不是这一帧，所以判据是**同一性**而不是非空）。

---

## 3. A 表：真实 372.66 s 语料上的 tradeoff（proxy 参考，出货 postfilter）

输入：`~/.cloudcli/voice-realtime-capture/af5559c0-d347-41f3-a6f0-f02a597af1e9.wav`，5,962,560 样本 = **372.66 s**，PCM16 / 16000 Hz / 单声道，**18633 帧**。
postfilter：preroll **500 ms** / hangover **320 ms**（出货常量）。
参考：capture timeline 的 **18 段 upstream `speech_started/stopped`** —— **这是 proxy，是上游模型的边界，不是真值**（见 §6）。

| engine | level | filtered% | speech% | miss% | overseg% | midcut% | startP50(s) | endP50(s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **silero** | 0.2 | 80.88 | 19.12 | 0.00 | 0.00 | 72.22 | 0.990 | 1.484 |
| silero | 0.35 | 81.22 | 18.78 | 0.00 | 0.00 | 72.22 | 0.990 | 1.464 |
| silero | **0.5** | **81.37** | 18.63 | 0.00 | 0.00 | 72.22 | 1.009 | 1.464 |
| silero | 0.65 | 81.48 | 18.52 | 0.00 | 0.00 | 72.22 | 1.013 | 1.453 |
| silero | 0.8 | 81.67 | 18.33 | 0.00 | 5.56 | 77.78 | 1.009 | 1.440 |
| **ten** | 0.2 | 27.96 | 72.04 | 0.00 | 0.00 | 16.67 | 14.470 | 21.308 |
| ten | 0.35 | 76.38 | 23.62 | 0.00 | 0.00 | 66.67 | 1.185 | 2.984 |
| ten | **0.5** | **80.51** | 19.49 | 0.00 | 5.56 | 72.22 | 1.255 | 2.093 |
| ten | 0.65 | 82.25 | 17.75 | 11.11 | 11.11 | 66.67 | 1.345 | 2.002 |
| ten | 0.8 | 90.18 | 9.82 | 38.89 | 0.00 | 50.00 | 2.387 | 1.940 |
| **webrtc** | 0 | 32.77 | 67.23 | 0.00 | 11.11 | 22.22 | 1.523 | 1.706 |
| webrtc | **1** | **43.91** | 56.09 | 0.00 | 11.11 | 22.22 | 1.523 | 1.706 |
| webrtc | 2 | 48.97 | 51.03 | 0.00 | 16.67 | 27.78 | 1.523 | 1.639 |
| webrtc | 3 | 59.39 | 40.61 | 0.00 | 22.22 | 50.00 | 0.965 | 1.493 |
| **fsmn** | 0.3 | 72.56 | 27.44 | 0.00 | 11.11 | 72.22 | 0.896 | 1.691 |
| fsmn | 0.45 | 74.97 | 25.03 | 0.00 | 11.11 | 72.22 | 0.896 | 1.604 |
| fsmn | **0.6** | **76.85** | 23.15 | 0.00 | 11.11 | 72.22 | 0.909 | 1.564 |
| fsmn | 0.75 | 79.47 | 20.53 | 0.00 | 0.00 | 72.22 | 0.910 | 1.553 |
| fsmn | 0.9 | 81.06 | 18.94 | 0.00 | 5.56 | 77.78 | 0.916 | 1.444 |
| **sts** | native | **1.09** | 98.91 | 0.00 | 0.00 | 0.00 | 111.358 | 174.464 |

**读法。**

- **`miss%` 在这张表上恒为 0**（除了 TEN 0.65/0.8 把整段语音丢掉）。定义是「没有任何检测段与之重叠的真值句」。加一层 500/320 的 postfilter 之后，只要引擎在每段语音里漏下**一帧**，这一段就不算 miss。所以 miss% 不是分辨力所在，**分辨力在 `midcut%` 和 filtered% 上**。
- **`midcut%` 是这张表最挑人的列**：它数「真值语音段内部出现了检测边界」。Silero/TEN/FSMN 在 0.5 附近都是 72.22%（13/18 段内部被切），而 STS 是 0.00%。也就是说：**省下的 81% 带宽，主要是靠切碎语音段换来的，不是靠识别出静音段**——因为这段语料的「静音」大量是**尾部衰减和低电平尾音**，模型把它当静音切掉，proxy 参考（上游模型边界）却把它算作语音。
- **`sts` 行的 startP50 111.4 s / endP50 174.5 s 是伪影**：它几乎把所有帧都判成一段（98.91% 语音），只有一段巨大的 blob，于是每个真值句的「最佳重叠段」都是同一段，偏差就是这个 blob 到各句的距离。**这一列对 giant-blob 检测器无意义**，不要拿它和前面几行比。
- 三个模型的阈值在真实语料上的**实际杠杆**：Silero 0.79 点、TEN 62.2 点、FSMN 8.5 点。TEN 的 0.2 → 0.35 是悬崖（27.96% → 76.38%），说明它的分数在 0.2–0.35 之间有一条分界线正好落在这段语料的「尾音 vs 静音」上。

---

## 4. B 表：精确真值指标（每引擎 primary 档，出货 postfilter）

参考是**真值**：`timeline.mjs` 合成的真人单句时间线（synthetic）与冻结的 `corpus/long` manifest（真值 = 构建语料时放进去的样本）。与 §3 的 proxy 参考**并列且明确区分**。

「primary 档」= 各引擎自己的常用工作点：silero 0.5 / ten 0.5 / webrtc 1 / fsmn 0.6 / sts native。

| dataset | engine | level | miss% | overseg% | midcut% | falseAlarm/h | maxSegViol |
| --- | --- | --- | --- | --- | --- | --- | --- |
| synthetic (85.62 s, 6 段) | silero | 0.5 | 0.00 | 0.00 | 50.00 | 135.6 | 0 |
| synthetic | ten | 0.5 | 0.00 | 0.00 | 100.00 | 548.9 | 0 |
| synthetic | webrtc | 1 | 0.00 | 0.00 | 16.67 | 515.7 | 0 |
| synthetic | fsmn | 0.6 | 0.00 | 0.00 | 33.33 | 176.3 | 0 |
| synthetic | sts | native | 0.00 | 0.00 | 0.00 | 1385.3 | 0 |
| long:L1-dense (78.28 s, 6 段) | silero | 0.5 | 0.00 | 100.00 | 100.00 | 1157.4 | 0 |
| long:L1-dense | ten | 0.5 | 0.00 | 100.00 | 100.00 | 624.6 | 0 |
| long:L1-dense | webrtc | 1 | 0.00 | 100.00 | 100.00 | 1304.2 | 0 |
| long:L1-dense | fsmn | 0.6 | 0.00 | 100.00 | 100.00 | 1471.2 | 0 |
| long:L1-dense | sts | native | 0.00 | 66.67 | 66.67 | 3257.4 | 0 |
| long:L2-mixed (153.52 s, 10 段) | silero | 0.5 | 0.00 | 100.00 | 100.00 | 435.6 | 0 |
| long:L2-mixed | ten | 0.5 | 0.00 | 100.00 | 100.00 | 411.9 | 0 |
| long:L2-mixed | webrtc | 1 | 0.00 | 100.00 | 100.00 | 542.2 | 0 |
| long:L2-mixed | fsmn | 0.6 | 0.00 | 100.00 | 100.00 | 518.2 | 0 |
| long:L2-mixed | sts | native | 0.00 | 100.00 | 100.00 | 1237.8 | 0 |
| long:L3-sparse (274.10 s, 8 段) | silero | 0.5 | 0.00 | 100.00 | 100.00 | 52.9 | 0 |
| long:L3-sparse | ten | 0.5 | 0.00 | 100.00 | 100.00 | 106.0 | 0 |
| long:L3-sparse | webrtc | 1 | 0.00 | 100.00 | 100.00 | 96.5 | 0 |
| long:L3-sparse | fsmn | 0.6 | 0.00 | 100.00 | 100.00 | 82.8 | 0 |
| long:L3-sparse | sts | native | 0.00 | 0.00 | 0.00 | 3600.0 | **1** |
| long:L4-nonstop (140.82 s, 12 段) | silero | 0.5 | 0.00 | 100.00 | 100.00 | 2819.8 | 0 |
| long:L4-nonstop | ten | 0.5 | 0.00 | 100.00 | 100.00 | 1388.0 | 0 |
| long:L4-nonstop | webrtc | 1 | 0.00 | 100.00 | 100.00 | 2819.8 | 0 |
| long:L4-nonstop | fsmn | 0.6 | 0.00 | 100.00 | 100.00 | 2819.8 | 0 |
| long:L4-nonstop | sts | native | 0.00 | 75.00 | 75.00 | 3600.0 | 0 |

**⛔ 这张表怎么读，以及它不能怎么读。**

- 真值集**只有 6–12 段**，所以每个率都是 **1/6 ≈ 16.7 或 1/8 = 12.5、1/10 = 10、1/12 ≈ 8.3 的整数倍**。一个段被切开就让数字跳 8–17 点。这里的 `100.00` 不是「全部失败」，是「6 段里 6 段都被切了」。
- 与 §3 一致，**`miss%` 恒为 0**：加了 500/320 之后，整段漏掉几乎不可能。真正有信息的是 **`falseAlarm/h`**（每小时非真值语音被误判成语音的**秒数**，按语料的静音时长归一）和 **overseg/midcut**。
- `falseAlarm/h` 在这张表上主要由**postfilter 的回扩**造成：500 ms preroll + 320 ms hangover 会在每段真值语音两侧各加最多 0.82 s，而 synthetic 的静音总时长只有几十秒，所以分母一小，秒/小时的数字就很大。**跨数据集比较这一列要小心**，同数据集内比较才有意义。
- **`maxSegmentViolations`**：只有 `long:L3-sparse` 的 STS 出现 1，即出货 gate 在这个稀疏语料上吐出了一个超过上限长度的段（它的 `native` 段长上限由 `metrics.mjs` 的 `DEFAULT_MAX_SEGMENT_SEC` 定义）。这正是 §1 第 1 条的另一面：STS 的中途不裁，代价是段可以很长。
- `sts` 的 `falseAlarm/h = 3600.0` 是**饱和值**（它把整个 timeline 都判成一段语音，非真值语音的秒数≈全时长，归一后顶到 3600）——不是「它误报特别多」，是「它什么都不裁」。

方向性结论：**这批语料上，四个模型引擎在 primary 档都会把真值语音段切碎，出货 STS 保留得最完整**；与此同时 STS 的误报（等价于「不裁」）最大。两者是同一枚硬币。

---

## 5. B2 表：postfilter 的影响（AC4 的两档参数化）

同一引擎、同一档位，只动 postfilter。只有真实语料（proxy 参考）有足够细的语音/静音分级比例来读这一列。

| engine | level | preroll/hangover | filtered% | speech% | midcut% |
| --- | --- | --- | --- | --- | --- |
| silero | 0.5 | 500/320（出货） | 81.37 | 18.63 | 72.22 |
| silero | 0.5 | 200/100（宽松） | 83.75 | 16.25 | 100.00 |
| ten | 0.5 | 500/320 | 80.51 | 19.49 | 72.22 |
| ten | 0.5 | 200/100 | 82.37 | 17.63 | 77.78 |
| webrtc | 1 | 500/320 | 43.91 | 56.09 | 22.22 |
| webrtc | 1 | 200/100 | 56.39 | 43.61 | 77.78 |
| fsmn | 0.6 | 500/320 | 76.85 | 23.15 | 72.22 |
| fsmn | 0.6 | 200/100 | 81.19 | 18.81 | 100.00 |
| sts | native | 500/320 | 1.09 | 98.91 | 0.00 |
| sts | native | 200/100 | 1.23 | 98.77 | 0.00 |
| sts | native | 0/0（gate 原样） | **1.31** | 98.69 | 0.00 |

收窄 postfilter 一律**多省一点带宽、多切一点语音内部**（midcut 上升）。WebRTC 对 postfilter 最敏感（43.91% → 56.39%，因为它的原始判定本来就碎，全靠回扩把段粘起来）；STS 最不敏感（它就是自带 preroll/hangover 的 gate，加不加外面这层只差 0.22 点）。**postfilter 是一个会把「漏检」转成「误报」的自由度**，报告两档是为了让这个自由度可见，而不是挑一个好看的数。

---

## 6. C 表：成本（真实 372.66 s 语料，每引擎一个独立进程）

| engine | wall(s) | cpu(s) | RTF | RSS 峰值 (MB) |
| --- | --- | --- | --- | --- |
| silero | 0.98 | 5.00 | 2.62e-3 | 229.9 |
| ten | 1.13 | 1.13 | 3.02e-3 | 229.9 |
| webrtc | **0.04** | 0.27 | **1.2e-4** | 229.9 |
| fsmn | 9.20 | 18.25 | 2.47e-2 | **750.3** |
| sts | 0.03 | — | 9e-5 | 242.2 |

读法：

- **RTF 是墙钟 / 音频时长**，都远低于实时（最重的 FSMN 也只有 2.5% 实时），所以**没有一个方案是「算不动」的**；成本差异影响的是**并发路数与内存**，不是可行性。
- **Silero 的 cpu(5.00 s) 远大于 wall(0.98 s)**：onnxruntime 的线程池在跑（多核并行）。TEN 的 cpu≈wall，是单线程。**这两个数的口径不同**，不要直接比「谁更省 CPU」——要比 wall 或比 RTF。
- **`rssPeakKb` 有个未解释的巧合，别过度解读。** 每个引擎由 `spawnSync` 起**独立** python 进程，各进程自己报 `ru_maxrss`；但 silero / ten / webrtc 三行**完全相同**（229.9 MB，引擎自报也同为 235436 KB）。三个不同进程、不同 ONNX 会话量到同一个值，说明这个基线被 python 解释器 + `numpy` + 扩展模块的常驻量**主导**，各引擎的增量被淹没了。本报告**不解释**这个巧合，只据实记录：**可信的 RSS 结论只有两条**——FSMN 750 MB 明显是另一个量级（`funasr-onnx` + 前端 + 模型），STS 242 MB 是**含测台的上界**。想比 per-engine 内存，得换一个能把解释器基线扣掉的测法。
- **`sts` 的 cpu 是 `—`**：STS 跑在**本 Node 进程内**，没有独立进程可测，`process_time` 会把它和整个测台混在一起。它的 RSS(242.2 MB) 因此是**上界**（含测台自身），不是干净的 per-engine 数。wall 0.03 s / RTF 9e-5 是可信的（同一个计时环内逐帧调用 18633 次）。

---

## 7. D 表：权重溯源（AC5）

每个模型都写了**来源 URL** 与本地文件的 **sha256 前 16 位**；模型的下载与比对是**实测**做的（下载上游 → 比 sha），不是照抄 README。

| engine | sha256[0:16] | 来源 URL | 本地路径 |
| --- | --- | --- | --- |
| silero | `1a153a22f4509e29` | `https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx` | `/data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx` |
| ten | `718cb7eef47e3cf5` | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/ten-vad.onnx` | `/data/home/yale/work/voice-vad-engines/ten-vad/ten-vad.onnx` |
| webrtc | `null`（无权重文件） | `https://pypi.org/project/webrtcvad-wheels/` | `webrtcvad._webrtcvad`（编译好的 C 扩展） |
| fsmn | `2ef334f2d7776edd` (`config.yaml`) | `https://www.modelscope.cn/models/damo/speech_fsmn_vad_zh-cn-16k-common-onnx` | `/data/home/yale/work/voice-vad-engines/fsmn-vad-ms/config.yaml` |
| fsmn | `6820fef9687708c4` (`am.mvn`) | 同上 | `/data/home/yale/work/voice-vad-engines/fsmn-vad-ms/am.mvn` |
| fsmn | `5289eb2aa3c9af2d` (`model_quant.onnx`) | 同上 | `/data/home/yale/work/voice-vad-engines/fsmn-vad-ms/model_quant.onnx` |
| sts | `null`（不是训练模型） | 仓库内（出货模块） | `server/modules/voice-realtime/voice-realtime-silence-tail.ts` |

**TEN 的权重来源要说清楚**（否则会踩坑）：模型**网络**是 TEN-framework 的（`github.com/TEN-framework/ten-vad`，其 `src/onnx_model/ten-vad.onnx` 是 315449 B / sha `e10b98a0cab1c98e`），但**sherpa-onnx 的加载器不认那个文件**——它需要 k2-fsa 重新打包、加了元数据的副本。上面这行 URL 就是那份副本（332211 B / sha `718cb7eef47e3cf5`），已与本地文件逐字节比对一致。`engines/ten.py` 的 `UPSTREAM_URL` 同时记了上游出处。

**WebRTC 与 STS 没有权重文件，这是事实而不是缺口**：WebRTC VAD 是编译进 `webrtcvad-wheels` 的 C 代码（GMM 检测器，无外部参数文件）；STS 是仓库内的规则型检测器。两者的 `sha256_16` 记 `null`，并在 `notes` 里写明原因。

---

## 8. 未触碰生产（AC6 / AC7）

测台在跑之前和跑之后都记录了 :3001 的监听 pid，并断言环境开关仍是「关」：

```json
{
  "stsEnv": null,
  "stsEnvReadsAsDisabled": true,
  "serverPidBefore": 366403,
  "egress": "no audio leaves the process; only model weights were fetched inbound",
  "serverPidAfter": 366403,
  "serverNotRestarted": true
}
```

- **不改生产配置**：`VOICE_REALTIME_SILENCE_TAIL` 未设置（`null`），按 `stsEnvReadsAsDisabled` 解析为禁用。测台不写任何环境变量、不改任何配置文件。
- **不重启**：pid 前后相同（`366403 == 366403`）。
- **不外发音频**：整条链路只读本地 WAV、只跑本地模型；唯一的入站网络活动是**下载权重**（溯源用）。没有任何代码路径把音频发给外部服务。
- **职责边界不变**：本实验只产出「哪一帧算语音」，不调用、也不接线到 turn detection / `commit` / `response.create`。STS 那一行是**把出货模块当被测对象**喂帧，不是把它接到代理链路上。

---

## 9. 局限（必须连结论一起读）

1. **参考分两种，永远不要混**。§3 的 18 段是 capture timeline 的上游模型边界 = **proxy**，它把尾部衰减/低电平尾音算作语音；§4 才是**真值**（构建语料时放进去的样本）。所以 §3 的「midcut 72%」是**上界**，不等于真丢话；§4 支持的是「模型引擎会把真值语音切碎」这个方向，不是精确幅度。
2. **真值集样本量小**（6–12 段）→ §4 的率以 1/n 量化，粒度 8–17 点。
3. **`miss%` 几乎无分辨力**（两层 postfilter 之后恒为 0），不要用它排序引擎。
4. **Silero 的阈值在真实语料上几乎无效**（后验饱和，0.2→0.8 只动 0.79 点）。这不代表 Silero 差——它代表**这段语料的信噪结构**让它处在双峰两端；换个有真实中途静音的语料，曲线会张开。
5. **FSMN 的阈值杠杆也小**（各档语音占比 16.4%→14.3%），因为它把「尾部衰减」整体压在判据线附近；`2*score-1 >= thres` 这个判据是自己从 `utils/e2e_vad.py` 复刻的，适配器另外输出了与引擎 segment list 的一致率（真实语料 0.9757）作为交叉核对，**残余 2.4% 的差是引擎自己的迟滞，不是适配器写错**。
6. **TEN 由 sherpa-onnx 封装驱动**（特征前端是 sherpa 的，不是 TEN 官方 demo 的），且用逐窗口 `is_speech_detected()` 而非 segment list（§2 说明）。权重本身已逐字节溯源。
7. **WebRTC 没有概率，只有二值判定**，所以它没有「阈值曲线」，只有四个激进度。
8. **尺寸/口径**：`sts` 的 cpu 缺失、RSS 含测台；`silero` 的 cpu 含 onnxruntime 多线程。见 §6 的读法。
9. **单一 capture**：核心 tradeoff 只基于**这一次 372.66 s 上行**。它值得信的地方是「同一份字节、同一套后处理」的横向比较；不值得信的地方是把它当成这五个引擎的普遍排序。

---

## 10. 与上一轮读数的关系（修正记录）

上一轮的 Proposal 表里出货 STS 记的是「语音 100% / **过滤 0.00%** / 全部 `streaming`」。**那个读数是错的**，本轮的修正是：

| | 上一轮 | 本轮（修正后） |
| --- | --- | --- |
| STS 过滤比例 | 0.00% | **1.31%**（gate 原样，无额外 postfilter） |
| 未保留帧数 | 0/18633 | **244/18633** |
| 阶段迁移 | 无 | `suppressed`@17057 → `resumed`@17302（**4.9 s 一段尾部抑制**） |

**原因**：上一轮的 `sts_dump.mts` 把一个 `Float32Array` 传给了 `observe()`，而它要的是 **base64 PCM16 字符串**——于是每一帧都落在「不是语音」的判定上/或者根本没进静音尾逻辑，整段读成了「全部 streaming」。本轮的 `runShippedSts()` 直接复刻 ws 代理的喂法（`Buffer.from(pcm16).toString('base64')`），并且用 `decision.frames.includes(audio)`（同一性）而不是「非空」来判「这一帧有没有被保留」。

**这次修正本身也是个结论**：出货 STS 在这次 capture 上只有**一次**4.9 s 的抑制，是因为这段录音是「一段连续语音 + 末尾静音」。它的设计（`createSilenceTailGate`）是**流式→尾段→抑制**，只在整段语音**结束之后**才裁尾。所以在这类语料上它接近 no-op 是**预期的**，不能读成「STS 永不裁」——要看它在有**中途长静音**的语料上的行为，得换语料，而那是另一个任务。
