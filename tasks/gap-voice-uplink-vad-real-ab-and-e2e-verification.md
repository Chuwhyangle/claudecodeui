---
id: gap-voice-uplink-vad-real-ab-and-e2e-verification
title: 上行 VAD 的生产验证：同源 PCM A/B、重连跨 idleRotateMs、长静音存活、主动退出四条真实场景 + Playwright（显式
  arm）+ fast module tests 证明默认关时逐字节不变
status: ready
labels:
  - gap
parent: null
children: []
extra:
  acceptance: npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
depends_on:
  - gap-voice-uplink-vad-production-seam
---
## Proposal

对已接线（默认关）的上行 VAD 做**同源 A/B 回归与端到端验证**，并把「默认行为逐字节不变」证成可复跑的读数而不是声明。

**要覆盖的四类场景**（用户验收 4、5 两条）：

1. **同源 PCM A/B**：同一段真实语料、同一窗口、同一会话体，A=完整 PCM、B=过滤后的 PCM，逐项对比。
2. **重连**：过滤期间的**连接存活**与上游池的活动时钟（`noteLocalActivity` / `idleRotateMs`）—— 这是删帧最容易踩断的一根线。
3. **长静音**：静音段不发送时连接是否存活；已知实验读数 TEN 曾有 11.48 s 零发送而连接未断，需在**生产路径**上复现一次。
4. **主动退出**：用户动作触发的 `commit` + `response.create` + 有界等待。

**默认不变的回归**（用户验收 5）：默认关时老链路逐字节不变，用 fast module tests 断言送出的帧序列与今天逐帧逐字节相同。

**已有的可复用设施（不要另造）**：

- 真实上游 A/B：`experiments/voice-realtime-vad-three-arm/probe.mts` 的 `--vad-filtered` 路径（已实测过三轮，含退出顺序与费用上限）。
- Playwright 假上游：`e2e/voice-realtime-continuous-experience.spec.ts` 的 `upstream.armVad({...})`（脚本化上游 + 声学检测器）。
- fan-in suite **不含** Playwright e2e（本仓既有实测结论）⇒ e2e 腿必须**自带命令**并单独跑出读数。

## Plan

1. 真实上游同源 A/B：复用探针，窗口沿用 0–45000 ms 以便与既有三轮读数直接对照；给出上行帧/字节与占比、transcribed、forwarded（含文本）、遗漏、首 `function_call` 延时、上游错误、连接存活、最长无发送间隔、花费。
2. **重连腿**：在过滤开启下跨越一次 `idleRotateMs`；断言上游池**没有**因删帧而轮换（读数：轮换次数、`touch()`/`noteLocalActivity` 计数）。
3. **长静音腿**：构造 ≥30 s 连续非语音，断言连接存活且无被对方关闭（对照既知 ~304 s 上游无接收被关闭的界）。
4. **退出腿**：用户动作触发，断言顺序与"退出前后不丢"；若本窗口 5 条转写全在退出前到达（既有实测如此），**必须另挑一个"语音结束后立即退出"的窗口**才能真正验证救回 —— 否则如实写明"顺序不变式成立、救回未观测"。
5. 浏览器腿：跑既有 spec（自带命令）并**如实记录它 arm 的是哪一层**——2026-10-14 人裁定后，本条的读数口径见 AC5（arm 点缺席须被机械读数支撑，⛔ 不得把「未 arm」写成「已 arm」）。
6. fast module tests：默认关时帧序列逐字节不变；开时首段丢弃/开头 a 保留/短停顿保留。
7. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [x] AC1 同源 A/B 四类读数齐备（帧/字节/占比、transcribed、forwarded 含文本、遗漏、首 call 延时、上游错误、连接存活、最长无发送间隔、花费），并与既有三轮读数可对照。
- [x] AC2 **重连腿**：过滤开启下跨越 `idleRotateMs`，给出轮换次数与 `noteLocalActivity` 计数；⛔ 出现因删帧导致的轮换 ⇒ 红。
- [x] AC3 **长静音腿**：≥30 s 连续非语音下连接存活，给出读数；若被关闭，给出关闭方与时刻。
- [x] AC4 **退出腿**：顺序 `commit → response.create → 有界等待 → 关闭` 被断言；**若未能构造出"语音结束后立即退出"的窗口，必须写明"救回未观测、只有顺序不变式"**，⛔ 不得把它写成已验证。
- [x] AC5（**2026-10-14 人裁定后改写：判据必须落在本任务执行面内**）浏览器腿的 **arm 点缺席被机械读数支撑**：`grep -rn 'uplinkVad' server/index.ts src/ e2e/` 的读数（列出全部命中，当前为空）写进 `## Evidence` 与 `docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 末节，并写明其推论——新上行 VAD 门控**没有生产 / 浏览器 arm 点**（`seams.uplinkVad` 是可选 seam，`uplinkVad === undefined` 即出货态），因此本任务范围内**无法** arm 出一条真的 Playwright 腿；同一节同时给出 e2e 腿实跑的确切命令与读数（`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` → 11 passed），并**明确标注它验的是脚本化上游的检测器、不是新门控**。⛔ 不得把「未 arm 的腿」当作已覆盖；⛔ 不得为此打开生产默认值、不得改动 `server/index.ts`。
- [x] AC6 **默认逐字节不变**：默认关时同一串帧的送出序列与改动前逐帧逐字节相同（给出前后对照）。
- [x] AC7 费用上限：单次连接 ≤ ¥0.05、本任务总计 ≤ ¥0.20；写出实际花费与时长。
- [x] AC8 不改生产配置（`VOICE_REALTIME_SILENCE_TAIL` 仍关、新开关仍默认关）、不重启 :3001（前后 pid 相同，写出读数）。
- [x] AC9 数据不外传：除上游 realtime 端点外零外联；给出读数。

## Evidence

**AC1–AC4、AC6–AC9 有可复算读数（全写入 `docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 末节「生产验证…」，2026-10-14）。AC5 于 2026-10-14 按人裁定改写为执行面可判形态；本轮已补齐该形态的落文档动作（`grep` 读数 + 推论 + e2e 腿实跑读数与层级标注，见下），并写入该文档末节「AC5 — arm 点缺席（机械读数）+ e2e 腿实跑」。**

**Branch `task/gap-voice-uplink-vad-real-ab-and-e2e-verification`；criterion `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts` → tests 25 / pass 25 / fail 0, exit 0（本轮复跑复核一致）。**

- **AC1**：真实上游窗口 0–45000 ms（2250 帧 / 1440000 B），四臂齐备读数（帧 / 字节 / 占窗口 / transcribed / forwarded(有文本) / 遗漏 / 首 call / err / 存活 / 最长不发送 / ¥）—— A 2250/1440000/100.0%/5/5/0/7835/1/alive/22/0.0066；silero 846/541440/37.6%/5/5/0/7279/1/alive/7380/0.0066；ten 802/513280/35.6%/5/5/0/7838/1/alive/10860/0.0066；webrtc 2021/1293440/89.8%/5/5/0/7393/1/alive/2220/0.0066。帧/字节计数与既有三轮**逐值相同**，可对照；旧形态同窗 silero 554880 B / forwarded(有文本) 4 / 遗漏 1 ⇒ 新形态上行字节略省且丢句消失（ten、webrtc 同向）。`err 1` 是退出路径的空提交副产物，A 臂亦然。
- **AC2**：module test `VERIFY AC2`（`idleRotateMs=300`，门控开，喂 120 个全非语音浏览器帧、跨度 >2×`idleRotateMs`）：线上 `appends=0`、`wired.rotations.length=0`（**未轮换**），`noteLocalActivity` 覆盖全部 120 个浏览器帧（= 浏览器帧数，**不是**转发帧数）；停喂后对照轮换发生（`rotations ≥ 1`）⇒ 删帧未把「其实从未空闲」的连接判成空闲。
- **AC3**：真实上游窗口 245000–301000 ms，窗口内 **50.12 s** 连续非语音，silero `longestAppendGapMs=50121`、`err=0`、`alive=true` ⇒ **连接存活、未被关闭**（掩码账目 `keptFrames=21`/`keptSegments=1`/`leadingDroppedFrames=0`）。另有 module test `VERIFY AC3` 的 relay 侧不变式：30.0 s 非语音 → `appends=0`、socket OPEN、无合成 `error` 帧。（窗口挑选理由与 postfilter 复刻对齐见文档。）
- **AC4**：45 s 窗四臂退出顺序均 `input_audio_buffer.commit → response.create → bounded-wait → socket-close`（`uplinkVadExitIsWellFormed` / `uplinkVadExitHasCommitAndResponse` 皆 ✓），`退出前/后 transcription = 5/0` ⇒ 该窗**救回未观测、只有顺序不变式**；另挑**救回窗口**（`--window-start-ms 320000 --window-ms 8620`，结束点落在末句语音段结束 328480 ms 后约 140 ms、上游自身 400 ms 静音闭合之前）得 `退出前/后 transcription = 0/1`、`committed 0/1` ⇒ **救回被观测到**。两种读数都给全，未把未观测写成已验证。
- **AC6**：module test `VERIFY AC6`：`after = wire({})`（当前 proxy，默认关）与 `before = wireWith(await loadPreSeamProxy(), {})`（缝引入**前**一个 revision 的真实 proxy）喂同一串帧后，送出的 `appends` **deep-equal**（同字节、同顺序）⇒ 默认关逐字节不变。`preSeamRevision()` 由 `git log --reverse -S uplinkVad` 推导，两侧都是真实代码路径而非手写桩。
- **AC7**：单次连接上限 ¥0.05 → 实测最大单连接 **¥0.0066**；本任务总计 AB ¥0.0264 + quiet ¥0.0015 + quiet2 ¥0.0018 + rescue ¥0.0009 = **¥0.0306** ≤ ¥0.20。时长：探针每条连接按窗口实时拨流（0–45 s 窗 ≈ 45 s；245–301 s 窗 ≈ 56 s；救回窗 ≈ 8.6 s）+ 每臂掩码预算；e2e 32.9 s。
- **AC8**：`:3001` pid **766174**（`node dist-server/server/index.js`，启动于 2026-10-13 23:54:31）；每条腿部运行前后均 766174，**相同**。`VOICE_REALTIME_SILENCE_TAIL` 未被打开；新的上行 VAD 开关在 `server/index.ts` 仍**默认关**（连生产 arm 点都未接，见 AC5）。
- **AC9**：探针唯一外呼 = 上游 realtime 端点（`probe.mts` 唯一的 `new WebSocket(...)`）；e2e egress guard 读数 `dials=1`、`blocked=false`、`authorizationSeen=false`，被拒的非上游主机是 `fonts.googleapis.com` 与 `api.github.com`（页面自身的字体/版本检查，被 guard 拦下），**没有一个**到达上游以外的服务器。
- **AC5（2026-10-14 人裁定后改写为执行面可判形态；本轮补齐落文档动作）**：机械读数 **`grep -rn 'uplinkVad' server/index.ts src/ e2e/` → 0 命中**（无输出，exit 1）—— `server/index.ts` / `src/` / `e2e/` 三处**全部为空**。**推论**：新上行 VAD 门控**没有生产 / 浏览器 arm 点**（`seams.uplinkVad` 是可选 seam，`uplinkVad === undefined` 即出货态），三路核验：(1) `seams.uplinkVad` 仅在 `server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts` 里被构造（仓库内其余命中只在缝的定义方 `voice-realtime-ws-proxy.service.ts`、探针 `experiments/voice-realtime-vad-three-arm/` 与纯门控模块/测试，无一处是装配里的 arm 点）；(2) `server/index.ts` 唯一的缝构造器 `buildVoiceRealtimeSeams`（:538，:933 / :1259 调用）**不构造** `uplinkVad`，且 `gap-voice-uplink-vad-production-seam` 的 AC10 明写 `server/index.ts` 相对 develop **未修改**；(3) 无任何 env 命名它，分类器 `createUplinkVadClassifier` 是 **async 且需要 `weightsPath`**（仓库内无权重），而缝构造器是 **sync**。⇒ 本任务范围内**无法** arm 一条真的 Playwright 腿（要 arm 只能改 `server/index.ts`，Touches 之外且与 AC8「不改生产配置」冲突）。e2e 腿实跑（命令自带）本轮两次：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` → **11 passed (32.0 s)** / **11 passed (32.3 s，另带 `QUAY_CONTINUOUS_EXPERIENCE_DUMP` 产出 artifact)**；artifact `continuous-dump.json`（本轮）显示 `upstream.armVad({...})`（spec:664）armed 的是**脚本化上游（endpoint）的 `server_vad` 检测器**（`turnDetection=server_vad`、`speechStarted/Stopped=5/5`、`opportunities=11`、`micFrames=121`、`commits=0`），**不是**新上行 VAD 门控 —— 已明确标注，⛔ 未把「未 arm 的腿」当作已覆盖。⛔ 未为此打开生产默认值；⛔ 未改动 `server/index.ts`。该形态的落文档动作已写入 `docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 末节。

**未做（刻意）**：不打开任何生产配置；不重启 :3001；不重跑离线五方案对比。

## DoD

上行 VAD 的四类真实场景（同源 A/B、重连、长静音、主动退出）各有可复算读数；默认关时老链路逐字节不变被实测证明；**浏览器腿能验到哪一层被如实记录**——该门控在生产装配里没有 arm 点（由 `grep` 读数支撑），e2e 腿验的是脚本化上游检测器，且这一区别写在文档与 Evidence 里而不是含糊带过；退出路径若无法构造救回场景则如实标记未观测；生产配置未被打开、服务未被重启。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- e2e/voice-realtime-continuous-experience.spec.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md
- tasks/gap-voice-uplink-vad-real-ab-and-e2e-verification.md

## Notes

**依赖**：被验证的实现是 `gap-voice-uplink-vad-production-seam` 接好的缝（`depends_on` 已设该边）。

### 2026-10-14 人裁定：AC5 按执行面改写

原 AC5 要求「Playwright 腿**真的 arm 了新门控**」。该读数在**执行面内不存在**：门控在生产装配里没有 arm 点（`uplinkVad === undefined` 就是出货态，见 Evidence 的三路核验），要造出它必须改 `server/index.ts` —— 那在本任务 Touches 之外，且与 AC8 冲突。人裁定：**判据必须落在本任务的执行面内**，故 AC5 改写为「arm 点缺席被机械读数支撑 + e2e 腿实跑读数 + 明确标注它验的是哪一层」。裁定同时确认：**不**为此推翻「出货态默认未接线」这一设计决定（不为一条判据去加生产 arm 点）。

**已知陷阱（本仓实测记录）**：未 arm VAD 的 Playwright 腿不能抄既有的 `vad()` 等待；`e2e/voice-realtime-continuous-experience.spec.ts` 用的是脚本化上游，arm 是可观测行为的前提。

**不做**：不打开生产配置；不重启服务；不重跑离线五方案对比。
