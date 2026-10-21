---
id: voice-speaker-tracking-settings-file
title: 声纹跟踪改由 voice-realtime 设置文件驱动（env 仅 escape hatch）
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

Phase 1 的 shadow 声纹跟踪（`voice-speaker-tracker-shadow`，已 done）只从环境变量读 `VOICE_SPEAKER_TRACKING` / `VOICE_SPEAKER_MODEL_PATH`。这违背了本仓库已经把“有限设置/参数”收进 `voice-realtime.settings.json` 的方向：

- `voice-realtime-settings.ts` 的注释明确记录 `announcePhrases` **故意没有环境变量**，文件是唯一旋钮；
- `runEndAck` / `summaryModel` 是第二批迁移：**文件是主机制，环境变量是 escape hatch**，precedence 为 `env > file > default`（用户 2026-10-21 明确选择 A，和现有代码一致）；
- 设置文件**每个连接读一次**，改动只影响下一个连接。

本任务把声纹跟踪的 mode / 模型路径 / 阈值 / 质量门搬进设置文件的 `speakerTracking` 段，env 变量保留为测试/运维 escape hatch。非目标：不做模型下载（另签 `voice-speaker-model-provisioning`）、不写 profile DB、不做 gate/TSE、不改 Phase 1 的只读行为。

建议的文件形状（默认值与 `experiments/voice-tse-eval/thresholds.v1.json` 一致）：

```json
{
  "speakerTracking": {
    "mode": "shadow",
    "modelDir": "models/speaker",
    "modelFile": "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "modelPath": "",
    "thresholds": {
      "track": 0.30,
      "matchFast": 0.35,
      "promote": 0.40,
      "consistencyMin": 0.60,
      "margin": 0.08,
      "maxStepSessionDeg": 15,
      "maxStepBankDeg": 8,
      "bankSize": 4
    },
    "quality": {
      "windowSeconds": 2.0,
      "sampleSeconds": 3.5,
      "speechRatioMin": 0.60,
      "minCoreSeconds": 2.0
    }
  }
}
```

解析顺序：`modelPath` 非空则用它；否则 `join(modelDir, modelFile)`。`modelDir` 默认 `models/speaker`，相对于仓库根。

## AC

- [x] AC1：`loadVoiceRealtimeSettings` 新增 `speakerTracking` 读取：缺省为 `null`；未知子键忽略；非对象、非法 `mode`、`mode=shadow` 但解析不出模型路径、阈值/质量门越界或非有限数，拒绝整个 block，把原因写进 `problems`，连接回退到 off/默认值，不半应用。测试加进既有 `server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts`。
- [x] AC2：precedence 为 `env > file > default`，与现有 `summaryModel`/`runEndAck` 一致：`VOICE_SPEAKER_TRACKING`/`VOICE_SPEAKER_MODEL_PATH` 非空时覆盖文件；否则用文件；否则 off/默认。每个生效值写一行 source 日志（environment / settings file / default）。
- [x] AC3：`server/index.ts` 改为按连接读取设置：`loadVoiceRealtimeSettings` 在构造 seam 前调用一次，`speakerTracking` 决定 mode/路径/阈值；模型按解析后的 `modelPath` 缓存（每个路径只加载一次，失败 memoize 成一行日志 + null embedder）；`mode=off`、模型缺失、加载失败都不建 seam、不阻塞连接。
- [x] AC4：Phase 1 的只读行为不变：无 `speakerTracker` seam 时 relay 逐字节不变；shadow 只写 `speaker_shadow`，不丢帧/不改帧/不发客户端帧/不写 DB。
- [x] AC5：`config/voice-realtime.settings.example.json` 增加带注释的 `speakerTracking` 示例；`.env.example` 把 `VOICE_SPEAKER_*` 标注为 escape hatch，把 `VOICE_REALTIME_SETTINGS_PATH` 写成正常入口；`voice-realtime-settings.ts` 顶部“八个 key”的说明更新为九个。
- [x] AC6：测试只用既有 server 测试文件（`voice-realtime-context-and-settings.test.ts`、`voice-realtime-speaker-tracker.test.ts`），不新增 server 测试文件；`quay-test-script` 的收集数 pin 不因本任务改变（当前 389 / `unknown=386`/388；若其他任务已改变，以实际重测为准，本任务不新增测试文件即可）。`npm run typecheck` 与相关测试退出 0。
- [x] AC7：真机 shadow 只设 `VOICE_REALTIME_SETTINGS_PATH`（不设 `VOICE_SPEAKER_*`），完成一次 Live Voice 会话，日志出现 `speaker_shadow` 逐窗口行与连接汇总；音频行为与 Phase 1 一致。
- [x] AC8：env-only 兼容：只设 `VOICE_SPEAKER_TRACKING=shadow` + `VOICE_SPEAKER_MODEL_PATH` 仍可启用，且日志写明 `environment` 覆盖了文件/default。

## DoD

- `voice-realtime-context-and-settings.test.ts` 与 `voice-realtime-speaker-tracker.test.ts` 全绿；`npm run typecheck` 退出 0。
- 真机 shadow 用设置文件完成一次会话（AC7），日志含 source；env-only 回退也验证一次（AC8）。
- 不新增 server 测试文件；`quay-test-script` 的收集数 pin 不因本任务改变（以实际重测为准）。
- `.env.example` 与示例 settings 文件可直接照着配置；文档明确“文件是正常入口，env 是 escape hatch”。

## Touches

- server/modules/voice-realtime/voice-realtime-settings.ts
- server/modules/voice-realtime/voice-speaker-tracking-arm.ts
- server/modules/voice-realtime/voice-realtime-speaker-seam.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts
- server/modules/voice-realtime/tests/voice-realtime-speaker-tracker.test.ts
- server/index.ts
- config/voice-realtime.settings.example.json
- .env.example
- experiments/voice-tse-eval/PLAN.md
- experiments/voice-tse-eval/thresholds.v1.json
- tasks/voice-speaker-tracking-settings-file.md

## 参考

- `experiments/voice-tse-eval/thresholds.v1.json` — `speaker-profile-v1` 默认阈值与模型 sha256。
- `experiments/voice-tse-eval/CONFIRMED-LABELS.md` §10/§11 — 39 目标 / 21 非目标、0.35 工作点、Phase 1 落地核对。
- `server/modules/voice-realtime/voice-realtime-settings.ts` — env→file 迁移的既有约定与 per-connection 读取契约。
