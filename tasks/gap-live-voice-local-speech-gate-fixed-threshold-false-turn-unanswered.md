---
id: gap-live-voice-local-speech-gate-fixed-threshold-false-turn-unanswered
title: Live Voice 本地语音门控阈值是固定绝对值 250：噪声较高的麦克风底噪（~116）上的短促噪声放行，会被当成「你说了话」，8
  秒后弹「语音服务听到了但没回应」误报横幅——阈值需跟随底噪并要求最短有声时长
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现象（2026-10-16 01:07:49–01:08:47 live 实测，journal `a094612f-e63f-4a36-ac8a-e4a15b808196.jsonl`）

一条 56.4 s 的连接，**没有任何语音**，页面却两次弹出「The voice service heard you but has not answered for 8 s; it may be slow or stuck.」（17:08:06.485、17:08:27.786，journal 行 `to-browser turn_unanswered`）。上游全程零 `speech_started`、零转写；上行 VAD 汇总 `browserFrames=2820 sent=62 headKept=51 dropped=2758`。

### 证据：捕获音频里没有语音，只有较高的底噪（已读 `~/.cloudcli/voice-realtime-capture/a094612f-….wav`）

| 连接 | 0.5 s 窗数 | RMS>1000 的窗 | 峰值 RMS | 中位 RMS | p90 RMS |
|---|---|---|---|---|---|
| cae49fed（有说话） | 335 | 64（19%） | 5716 | 24 | 2081 |
| a094612f（本缺陷） | 113 | 0（0%） | **863** | **116** | 204 |

即该连接的底噪中位数 116、偶发短促尖峰到 863，没有一个 0.5 s 窗超过 1000。

### 机制

- `server/modules/voice-realtime/voice-realtime-local-speech.ts:34` 的 `LOCAL_SPEECH_RMS_THRESHOLD = 250` 是**固定绝对值**，其注释（`:29`）的标定来自一台安静麦克风：「silence reads an RMS of 1–26 and speech 400–640」。本连接的底噪（中位 116、p90 204）已经紧贴这个阈值，一次 863 的尖峰就足以过线。
- `createLocalSpeechGate`（`:79`）一过线就开出本地话语边界；`voice-realtime-ws-proxy.service.ts:1902/1906` 把边界转给 `bridge.noteLocalUtteranceStart/End`。
- `voice-realtime-bridge.service.ts:1766-1774` 的 `noteLocalUtteranceEnd`：本地边界关闭时若上游期间零事件，即进入 awaiting 并 `armStallTimer()`，8 s 后抛 `UPSTREAM_STALLED`，proxy 把它映成 `turn_unanswered`（`:4388-4389`）。这条路径本是为「人确实说话了、上游沉默」而设（`gap-live-voice-upstream-stall-no-answer`，已 done）；误报来自它的**输入**——本地门控把噪声当成了说话。
- 同一份噪声被上行 VAD（silero）正确判为非语音，只放行 62 帧（1.24 s，多数是预滚 headKept），所以上游什么也没看到。**两套判据不一致**：本地能量门控说「有人说话」，silero 说「没有」。

### 方案（执行者按下列约束选形，须在 Notes 里写明选了哪一种及依据）

1. 阈值跟随底噪：由本连接已观测帧的滚动底噪估计（如低分位 RMS）推出有效阈值，形如 `max(250, k × floor)`；常量 250 作为下限保留，使安静麦克风的既有标定与 `voice-realtime-local-speech.test.ts` 原用例保持不变。
2. 最短有声时长：门控需连续（或累计）若干帧过线才开出边界，使 1–2 帧的尖峰不开话语。
3. 可选：本地边界关闭时，若上行 VAD 在同一窗口内放行帧数低于预滚量（即 silero 也判为非语音），则不 arm 停滞计时器。若采用，须说明不会使「人确实说了话、上游沉默」的真停滞漏报。

不在本任务：横幅文案与 `UPSTREAM_STALLED` 的 8 s 阈值；上游真停滞的检测与重拨。

<!-- dedup-ref -->相关但不同机制：`gap-live-voice-upstream-stall-no-answer`（已 done，该横幅的出处——停滞的**检测**）、`gap-live-voice-silence-tail-suppression`（已 done，静音尾抑制）。本任务只改**本地话语边界的触发条件**，不碰停滞检测本身。

## Touches

- server/modules/voice-realtime/voice-realtime-local-speech.ts
- server/modules/voice-realtime/tests/voice-realtime-local-speech.test.ts
- tasks/gap-live-voice-local-speech-gate-fixed-threshold-false-turn-unanswered.md

## AC

- [ ] 新增用例（`voice-realtime-local-speech.test.ts`，夹具在测试里合成，不依赖家目录）：底噪 RMS 约 100–130、偶发 1–2 帧（20 ms/帧）尖峰到约 860，持续 56 s 的 PCM16 帧流，`createLocalSpeechGate` 开出的话语边界数为 0。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-local-speech.test.ts` exit 0。
- [ ] 保形用例（同文件）：同一底噪上叠加 RMS 约 2000–5000 的连续 0.5 s 以上有声段，每一段恰开出一次话语边界、且起止时刻与有声段对齐（容差 ≤ 200 ms）。同一命令 exit 0。
- [ ] 回归：安静底噪（RMS 1–26）上 RMS 400–640 的有声段仍被开出，原有 `voice-realtime-local-speech.test.ts` 用例在不改断言的情况下全绿（同一命令 exit 0）。
- [ ] 假形态：把阈值/最短时长改回固定 250 且无最短时长，第一条用例变红（执行者在 Notes 里贴出这一次红的输出）。
- [ ] `npm run typecheck` 与 `npm run lint` 均 exit 0。

## DoD

用**真实捕获**离线重放：先把 `~/.cloudcli/voice-realtime-capture/a094612f-….wav` 与 `cae49fed-….wav` 拷到仓库外的冻结目录（捕获目录 64MB 最旧优先淘汰，回放前必须冻结），再逐帧喂给修复前后的 `createLocalSpeechGate`，在 Notes 里贴一张表：两个文件各自在「修复前 / 修复后」开出的话语边界数。a094612f 必须从 ≥2 降到 0；cae49fed 必须保持其 6 句说话对应的边界数不变。仅有合成夹具的断言、没有这张真实回放表不算落地。