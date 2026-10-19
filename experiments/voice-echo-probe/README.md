# 回声探针：外放时浏览器 `echoCancellation` 遮不遮得住系统播报（2026-10-19）

**问题**（GOAL-047 配套 C1）：TTS 出声后，系统播报从扬声器绕回自己的麦克风，会被当成用户的话
（误转交 / 回声自打断 / 用户听到自己刚说的话被重复）。本探针测「麦克风采回播报的程度」，回答
**`echoCancellation` 够 / 需真 AEC**。

## 结论

**`echoCancellation` 够，结案；不立真 AEC task。**

依据不是本机的声学读数（这台机器没有音频硬件，见「本机记录」），而是 Chromium 的实现语义与
Chrome 153/Linux 的能力读数：

1. Chromium 的 Chrome-wide AEC（`kChromeWideEchoCancellation`）在 Linux 上是
   `FEATURE_ENABLED_BY_DEFAULT`，源码注释写得很直白：
   *"If echo cancellation for a mic signal is requested, mix and cancel **all audio playback going
   to a specific output device** in the audio service."*
   —— 参考信号不是只有 WebRTC 远端流；**同一 Chrome、同一输出设备的页面播放**（我们 TTS 的形态）
   也在参考里。
   - https://chromium.googlesource.com/chromium/src/+/main/media/base/media_switches.cc
   - 平台支持：`chrome_wide_echo_cancellation_supported = is_win || is_mac || is_linux`
     （https://chromium.googlesource.com/chromium/src/+/main/media/media_options.gni）
2. 本机实测能力：Chrome 153/Linux `getCapabilities().echoCancellation = [true, false, "remote-only"]`。
   没有 `"all"`（Linux 不支持，Chrome 141 起才有该值），也不需要：`true` 已覆盖 Chrome 自身播放；
   `"remote-only"` 反而**不覆盖**页面播放，不要用。
3. 播放侧约束（必须满足，否则 AEC 的参考可能为零）：TTS 必须由**同一个 Chrome 实例**播放，且
   输出到**同一个输出设备**。Chromium 572892467 记录过：`<audio>` 用 `setSinkId` 指到非默认设备时，
   AEC 参考会被置零，回声不被消除（https://issues.chromium.org/issues/572892467）。

因此：沿用 `src/modules/chat/hooks/useVoiceInput.ts` 现在的 `echoCancellation: true` 即可；
TTS 走浏览器内播放（WebAudio / `<audio>`）时不要再做 `remote-only` 或 `setSinkId` 到别的设备。

> 旧资料说「Chromium 只把 PeerConnection 远端流当参考」是 Chrome 97 时代的行为
> （https://issues.chromium.org/issues/40213260），早于 Linux 上 Chrome-wide AEC 默认开启。
> 本 task 以现行 Chromium 源码 + 本机能力读数为准。

## 协议（预注册，先写死再看数）

| 项 | 内容 |
|---|---|
| 播报 | 6 s、确定性的语音形状信号（低通噪声 + 3.1 Hz 音节包络），循环；也可 `--announcement <wav>` |
| 采集 | `getUserMedia`，`noiseSuppression:false`、`autoGainControl:false`，只切换 `echoCancellation` |
| 臂 | `baseline`（不播）/ `plain-off`（直接 WebAudio 播，AEC 关）/ `plain-on`（直接播，AEC 开）/ `plain-all`（能力支持 `"all"` 才跑）/ `loopback-on`（播报绕经本地 `RTCPeerConnection` 再播，AEC 开） |
| 稳态窗 | 跳过前 `--warmup` 秒（AEC 收敛），取接下来 `--tail` 秒；0.5 s 窗功率平均 |
| `pickupDb` | `20log10(采回 RMS / 播报 RMS)` —— 麦克风采回播报的程度 |
| `erleDb` | `20log10(off RMS / arm RMS)` —— AEC 的抑制量（ERLE） |
| 判定 | `plain-on ≥ --min-erle`（默认 12 dB）→ **够**；只有 `loopback-on ≥ 12` → **够，但播放要绕 PeerConnection**；都不到 → **需真 AEC** |
| 无效读数 | 无输入设备 / 没测到回声（回声未高出底噪 6 dB）→ `exit 2`，拒绝给产品结论 |
| 合成模式 | `--capture simulated` 用假设备 + 合成回声 wav，只验证测量管线；AEC 未参与时输出 `inconclusive-harness` |

退出码：`0` 够；`1` 需真 AEC；`2` 环境无效/无法判定。

## 本机记录（2026-10-19，headless Linux，无 /dev/snd 声卡）

```
$ npx tsx experiments/voice-echo-probe/run.mts --self-test
SELF-TEST PASS  pickup=-9.14 dB  ERLE(注入 18 dB)=18.00 dB

$ npx tsx experiments/voice-echo-probe/run.mts --capture simulated --seconds 8 --warmup 4 --tail 3
底噪 -38.5 dBFS | 回声 -38.4 dBFS | pickup -8.5 dB | 回声/底噪 0.0 dB
ERLE: plain 0.7 dB | loopback 0.6 dB
结论: inconclusive-harness

$ npx tsx experiments/voice-echo-probe/run.mts --capture device
arm plain-off: 失败 NotFoundError: Requested device not found
结论: no-audio-device
```

- `--self-test` 绿：已知 −9 dB 回声路径读回 −9.14 dB，注入 18 dB 抑制读回 18.00 dB，测量数学成立。
- 合成模式里 plain/loopback 的 ERLE 都 ≈ 0.6–0.7 dB：**假采集路径下 Chrome 的 AEC 根本不参与**。
  这不是产品读数。三种虚拟采集路径都试过（`--use-file-for-fake-audio-capture`、ALSA `type file`
  的 `infile` 采集、WebRTC 本地回环），`echoReturnLossEnhancement` 恒为 ~0.18 dB，故合成模式只做
  管线自检，不给 verdict。
- 本机 `/dev/snd` 只有 `seq`/`timer`，`getUserMedia` 无输入设备 → 真机模式无法在这里跑。

## 真机复测（在本机之外，唯一能推翻上面结论的读数）

在一台有扬声器 + 麦克风的机器上（外放、中等音量、不要耳机）：

```
npx tsx experiments/voice-echo-probe/run.mts --capture device --seconds 12
```

- 若 `echoCancellation-suffices`：结案。
- 若 `suffices-with-loopback`：把 TTS 播放绕经本地 `RTCPeerConnection`（`createMediaStreamDestination`
  + `addTrack`，远端流再交给 `<audio>`）即可，不需要真 AEC。
- 若 `need-real-aec`（或 `invalid-no-echo` 且确认音量/设备无误）：另立 AEC task，把远端参考信号接进
  服务端/客户端消除链路；不要塞进本 task。

## 局限

- 没有物理声学测量：混响、扬声器非线性、音量、设备差异都没进读数；上面的结论是**语义级**的
  （谁在 AEC 参考里），真机读数留作验证门。
- 合成路径只证明测量管线与「AEC 未参与」这一 harness 事实，不证明产品行为。
- 单一播报信号、单一采集时长；没有双讲（用户同时说话）场景。

## 用法速查

```
npx tsx experiments/voice-echo-probe/run.mts --self-test
npx tsx experiments/voice-echo-probe/run.mts --capture device [--announcement x.wav] [--seconds 12]
npx tsx experiments/voice-echo-probe/run.mts --capture simulated
```

trace 写到 `--out`（默认 `/tmp/voice-echo-probe-<时间戳>/run-*.json`），含每臂 0.5 s 窗 RMS、
生效约束、ERLE 和最终判定。依赖仓库已有的 Playwright（`node_modules/.bin/playwright`）。
