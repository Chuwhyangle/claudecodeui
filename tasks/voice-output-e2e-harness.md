---
id: voice-output-e2e-harness
title: E0 端到端验证/开发平台：浏览器 + HTTP + DashScope 服务，无人值守回放现有语料
status: done
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-405
---
## Proposal

横切底座：端到端验证/开发平台。用 MCP 浏览器（Playwright）+ HTTP 接口 + DashScope 各服务，无人值守把现有 wav 语料（`~/.cloudcli/voice-realtime-closing-turn-corpus/capture/` 的 5 个冻结 wav）驱动过三层——离体能力探针（realtime 服务直接连，run.mts 那种）、服务器回归 gate、浏览器端到端。分别服务「开发（先探能不能做到）/ 测试（回归 gate）/ 验证（真链对不对）」三个用途。

本 task 不实现任何语音机制，是 AC-405（TTS 真机可听）、AC-406（播报打断）、AC-407（backchannel）这三条 AC 真机验证的前置底座（挂 AC-405 下作为第一用例；同时服务 AC-406/AC-407）。

现有 run.mts 是离体 replay（绕过浏览器和服务器），验证不了「浏览器采集 → 服务器 → relay → TTS 播放 → UI」这条真链；E0 补上这条。

关键技术点：wav 喂进浏览器采集 = Chrome `--use-file-for-fake-audio-capture`（标准、干净，依赖启动参数）或 Playwright `addInitScript` 注入假 `getUserMedia`（可控，不依赖启动参数）。复用现有 e2e harness（topic-e2e-ui-lessons 那套），别重造。

## AC

- [x] 给定一个 wav 样本，无人值守跑完「浏览器进 Live Voice → 播放样本 → 断言 relay 转交正确 message → 断言语音输出到达浏览器」，产出可判 pass/fail（不靠人肉看）。

## DoD

一个可重复的端到端回放脚本 + 至少一个样本跑通并产出 pass/fail；复用现有 e2e harness，不新造测试底座。

## Touches

- experiments/voice-e2e-harness/ (new)
- e2e/voice-output-e2e-harness.spec.ts (new)
- playwright.config.ts
- tasks/voice-output-e2e-harness.md

## Notes

### 落地（2026-10-19，worker）

| 产物 | 内容 |
|---|---|
| `experiments/voice-e2e-harness/run.mjs` | 回放脚本：从冻结语料派生窗口（timeline 的 `committed` 与 log 的 `transcription.completed` 按序配对），在**实际上线的那份 PCM16** 上模拟 scripted endpoint 的声学检测器，自动标定 `(threshold, silence)` 使检测器恰好切出与冻结转写同数目的 utterance；写 plan → 启动 spec → 输出单行 PASS/FAIL。`--list` / `--plan-only` / `--sample` / `--dump`。 |
| `experiments/voice-e2e-harness/wavMic.ts` | 把真实录音的样本按 100 ms 帧推入产品自己的 worklet 端口（与 `e2e/voiceRealtimeFakeMic.ts` 同一假 Web Audio 图），`atSample` 账本随帧推进。 |
| `e2e/voice-output-e2e-harness.spec.ts` | 真浏览器 + 真服务器 + 真 `/voice-realtime` proxy/relay + 真 debug-agent 常驻控制面；四条串行断言（见下）。 |
| `playwright.config.ts` | 把该 spec 登记进 `DEBUG_AGENT_SPEC_FILES`、`voiceRealtimeSelection`、`voiceContinuousOnlySelection`，并给 240 s 单文件预算。 |

运行命令（无人值守，一条）：

```
node experiments/voice-e2e-harness/run.mjs --sample 402fad85
```

默认为 `402fad85`；`--list` 列出 5 个样本的派生窗口与 turn 数。全部 5 个样本均能标定出恰好命中冻结转写数目的检测器参数（`--plan-only` 已验证）。

### 四条断言分别证明什么

1. **录音到达 endpoint 且被听成冻结的 utterance**：麦克风帧数 > 0（非真空）、上游拨号恰好 1 次、`input_audio_buffer.append` > 0、检测器 `speechStarted === speechStopped === 冻结转写数`。
2. **relay 转交正确 message**：读 `<dataDir>/voice-realtime-log/` 中按 connection header 选出的 journal，`kind:'session_send'` 的 message 按序拼接后（归一化）逐字等于冻结转写拼接；outcome 不含 error/refused。合并窗把第 3、4 句并成一条是产品行为，断言按「拼接后相等」而非「一句一条」。
3. **语音输出到达浏览器**：点击 assistant 行的 Read aloud → 真实 `/api/voice/tts` 请求（body.text 即该行文案）→ 浏览器收到可解码音频（`loadedmetadata` duration > 0.5 s）→ `voicePlayer` 的 `new Audio().play()` resolved。`voicePlayer` 的 `<audio>` 不在 DOM，故用 init script 包 `HTMLMediaElement.play` 记录 blob src / duration / 结算结果。
4. **零云外联**：`egress.jsonl` 存在且无 `EGRESS BLOCKED`、dials=1（唯一一次是 spec 自己的 loopback scripted endpoint）、upgrade 头无 `authorization`。

### 两次连续运行读数（同一样本，同一种子）

| 读数 | run 1 | run 2 |
|---|---|---|
| 结果 | 4 passed / exit 0 | 4 passed / exit 0 |
| spec 用时 | 32.2 s | 32.8 s |
| 麦克风帧 / 样本 | 195 / 311680 | 195 / 311680 |
| 检测器 | 4 starts / 4 stops | 4 starts / 4 stops |
| relayed messages | `["终止现在的操作。","找到。","Quay，Q U A Y这个项目。最活跃的绘画。"]` | 同左（逐字） |
| TTS | 1 request / 80044 bytes / played / 2.5 s | 同左 |
| egress | blocked=false dials=1 authorization=false | 同左 |

### 明确的边界（不要读成比实际更多）

- **TTS 服务是本地 stand-in**：spec 用 `page.route('**/api/voice/tts')` 返回一段可解码 WAV，验证的是「浏览器侧下行与播放」这一半真链（UI 触发 → 请求携带正确文本 → 字节 → 浏览器解码播放）。真实 cosyvoice 合成属于 `voice-output-tts-cosyvoice`（AC-405）自己的单测；当 AC-405 的浏览器下行音频帧落地后，在本 spec 的第 3 条腿上加音频帧断言即可，无需另起底座。
- **endpoint 是 scripted 上游**：它按收到的真实音频做声学切句，但每个 utterance 的 transcript 取自该录音的冻结识别结果（不是实时 ASR）。因此本 harness 证明的是「采集 → 编码 → 服务器 → relay → 会话」的真链，以及浏览器 TTS 下行/播放；不证明实时识别质量。
- 浏览器对非 loopback 请求的 route 拒绝会产生若干 `Failed to load resource` 控制台行（版本检查等），属既有 noise；断言只看 `pageerror` 为空。

## Blocker

**2026-10-19T00:30:35.126Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=ff: fan-in-ff-merge: suite 证书 — suite_head..tip 恰为本任务的单个 flip-done 提交（身份判定：仅 M tasks/voice-output-e2e-harness.md）⇒ 判惰性，⛔ 未调分类器
fan-in-ff-merge: FF FAILED — To .; not a fast-forward. Retry record written (attempt 1). Return to 无锁段 step 1 (merge develop again — 必须 merge 不得 rebase, AC75), re-judge the delta (step 2) and re-run.
fan-in-ff-merge: measure ff_only_locked=false
- run_id：wk-prod-anchor
- session_id：314f2717-aec0-4dd7-be36-962e6f7cf1fb
