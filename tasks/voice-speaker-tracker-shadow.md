---
id: voice-speaker-tracker-shadow
title: Live Voice 声纹跟踪 shadow：CAM++ 会话吸引子 + core 授权（只读）
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

Live Voice 需要“只由目标用户触发”的能力。离线实验（`experiments/voice-tse-eval/CONFIRMED-LABELS.md`）已经确认：

- CAM++ `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced` 在用户确认的 20 条目标 / 16 条非目标上，跨天 EER 2.6%，AUC 0.997；原来的 CAM++ zh-cn 是 7.8%。
- 以 5 条注册片段为 core，阈值 `match_fast=0.35` 在 462 条本地英文/TTS 负样本上 0 误接受、15 条目标 0 误拒；`track=0.30` 时 FAR 1.5%。
- 旁人先说话时，VoxLock `live()` 在 3/4 个序列锁到旁人（SI-SDRi(target) 中位 −2.26）；用 core 选 3 秒窗口则 4/4 锁到目标（中位 +15.56）。
- 单靠会话吸引子会拒绝 15/15 条目标 turn；同时接受 core 则 15/15 全部接受。因此必须 **dual-key**：会话吸引子用于跟踪，core 用于授权。

本任务只做 **Phase 1 shadow**：把纯逻辑模块和 CAM++ 观测缝接进服务端，开关 `VOICE_SPEAKER_TRACKING=shadow` 时只写读数，**不改变任何音频行为、不向客户端发新帧、不做 TSE、不写数据库**。这是后续 gate/TSE 的地基。

非目标：不做硬门控、不做软标记、不接 VoxLock sidecar、不做 UI、不建 profile 表、不改现有 uplink VAD 行为。

## AC

- [x] AC1：新增纯逻辑模块 `voice-speaker-attractor.ts`：单位向量、cosine、EMA 更新与单 turn 角度上限、会话状态（first/core score、accepted、drift、provisional）。确定性单测覆盖：归一化、cosine、角度上限、EMA 方向、空/短输入拒绝。
- [x] AC2：新增纯逻辑模块 `voice-speaker-bank.ts`：core + satellites、`match/new/promote/merge/evict`、K 上限、candidate 需 ≥2 会话才转正、core 不被单会话淘汰。单测覆盖每个状态转移与容量上限。
- [x] AC3：新增纯逻辑模块 `voice-speaker-selector.ts`：2 秒窗口扫描、语音占比/最短时长质量门、选 3–3.5 秒样本、`accept_tracking = max(session, core)`、`authorize_tse` 只在 cluster 被 core 确认时为真。单测覆盖：旁人先说话不被授权、目标窗口被选中、灰区不动作。
- [x] AC4：新增 `voice-speaker-tracking-arm.ts`：`resolveSpeakerTracking(env)` 返回 `off|shadow`、模型路径、阈值；未设置/空/`off` 为 off，未知值返回 `invalid` 并打印一行，不启用。`VOICE_SPEAKER_MODEL_PATH` 缺失时 shadow 也降级为 off 并打印一行。
- [x] AC5：`server/index.ts` 只在 `shadow` 且模型路径存在时加载一次 CAM++；加载失败只写一行日志并让 seam 为 `undefined`，**不得让连接失败**。`sherpa-onnx-node` 已在依赖内，不新增包。
- [x] AC6：`voice-realtime-ws-proxy.service.ts` 增加可选 seam `speakerTracker?:`；`undefined` 时路径与现在逐字节一致。shadow 时从浏览器 16k PCM 帧累积 2 秒窗口，调用注入的 `observe(window) -> {score, track, authorizeTse}`，只写 `speaker_shadow` 行（score、decision、accepted count、first_vs_core、provisional）；**不丢帧、不改帧、不提交、不发客户端帧**。
- [x] AC7：shadow 读数包含每连接汇总：windows、accepted、coverage、first_vs_core、reanchor/provisional；不含原始音频、不含逐样本 PCM。连接结束时写一行汇总。
- [x] AC8：新增唯一一个测试文件 `server/modules/voice-realtime/tests/voice-realtime-speaker-tracker.test.ts`，覆盖 AC1–AC4 与 seam 的“undefined 路径不变/shadow 只观测”。不新增其他 server 测试文件；新增后重测并更新 `server/shared/tests/quay-test-script.test.ts` 的两处收集数 pin（当前全树 388 个 server test 文件、`unknown=385`/`unknown=387`；新增一个测试文件后重测，按该测试自身口径改为 `unknown=386`/`unknown=388`，注释里的全树文件数 388→389）。
- [x] AC9：不新建 `server/modules/<new>/` 目录；新文件全部是 `server/modules/voice-realtime/` 下的叶子文件，只经既有 `index.ts` barrel 暴露必要符号；不 deep-import 其他模块。

## DoD

- `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-speaker-tracker.test.ts` 退出 0。
- `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts` 退出 0（pin 已按 AC8 更新）。
- `npm run typecheck` 退出 0；`npm run lint` 对新增/修改文件无新增错误。
- 真机 shadow 读数：以 `VOICE_SPEAKER_TRACKING=shadow` 和 `VOICE_SPEAKER_MODEL_PATH=<campplus zh_en adv onnx>` 启服务，完成一次 Live Voice 会话，日志出现 `speaker_shadow` 逐窗口行与一行连接汇总；音频行为与未开启时一致（无新客户端帧、无丢帧/改帧、无 TSE）。
- 未设置 flag、未知 flag、模型路径缺失、模型加载失败四种情况各有一行可归因日志，连接仍可用。
- 不写数据库、不上传音频、不新增 UI。

## Touches

- server/modules/voice-realtime/voice-speaker-attractor.ts
- server/modules/voice-realtime/voice-speaker-bank.ts
- server/modules/voice-realtime/voice-speaker-selector.ts
- server/modules/voice-realtime/voice-speaker-tracking-arm.ts
- server/modules/voice-realtime/voice-realtime-speaker-seam.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/tests/voice-realtime-speaker-tracker.test.ts
- server/shared/tests/quay-test-script.test.ts
- server/index.ts
- .env.example
- tasks/voice-speaker-tracker-shadow.md
- scripts/suite-duration-baseline.tsv

## 参考

- `experiments/voice-tse-eval/CONFIRMED-LABELS.md` — 确认标签、模型 EER、阈值、旁人先说话、选择器矩阵。
- `experiments/voice-tse-eval/thresholds.v1.json` — `speaker-profile-v1` 的 provisional 阈值与模型 sha256。
- `experiments/voice-tse-eval/labels.csv` / `labels.pending.csv` — 已确认 / 待确认标签。
- `server/modules/voice-realtime/voice-realtime-uplink-vad*.ts` — 纯逻辑 / 流式门 / arm point 的既有三分法。