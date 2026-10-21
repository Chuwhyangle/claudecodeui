# 落地计划 — 会话吸引子 + 长期库 + core 授权 TSE

状态：Phase 0 冻结件已产出；Phase 1 shadow 已按计划签成 quay 任务。

## 阶段

| Phase | 目标 | 状态 | 退出条件 |
|---|---|---|---|
| 0 | 数据/模型/阈值冻结 | **接近完成**：`thresholds.v1.json`（provisional）；labels 已扩到 39 目标 / 21 非目标；467 负样本；0.35 在 ≥2s 目标上 0 FAR/0 FRR；仍缺专职中文同事负样本 | ≥100 真实中文负样本；EER ≤5%；阈值在 FAR≤1% 时 FRR≤5% |
| 1 | Shadow tracker（只读） | **已落地**：`voice-speaker-tracker-shadow` status `done`（driver 机械 fan-in）；单文件 32 tests pass、pin 14 pass、typecheck 0 | coverage ≥70%；已知负样本 0 误接受；新增延迟 <20ms；音频行为不变 |
| 2 | 软跟踪 + UI 状态 | 未开始 | 20 会话状态与日志一致；restart/re-anchor 正常 |
| 3 | Gate（先软后硬） | 未开始 | 目标 turn 不丢；bystander-first 不误锁；上游 turn detection 不受影响 |
| 4 | VoxLock TSE | 未开始 | session-local SI-SDRi ≥+6dB；ASR WER 相对改善 ≥10%；延迟 <100ms；单会话 CPU <25% |
| 5 | 长期库 + 隐私/安全 | 未开始 | K 有界；candidate 不污染 core；删除可用 |

## 关键不变量

- **dual-key**：`accept_tracking = max(session, core)`；`authorize_tse = cluster 已由 core 确认`。
- **VoxLock 只做会话内**：样本来自当前会话 3–4 秒；会话结束丢弃；跨会话注册失败（实测最坏 −68 dB）。
- **门控用原始音频，增强音频只送 ASR**：TSE/GTCRN 会降低 CAM++ 目标余弦。
- **失败 fail-open**：模型/sidecar 不可用 → 转发 + UI 未验证，绝不静默静音。
- **软门控默认**，硬门控是显式选项。
- **VoxLock `threads=4`**：默认 `threads=0` 在 64 核机器实测 ~58 核。

## Phase 0 冻结件

- `thresholds.v1.json`：模型 `campplus_sv_zh_en_16k-common_advanced`（sha256 固定）、`track=0.30`、`matchFast=0.35`、`promote=0.40`、bank K=4；状态 `provisional`。
- `labels.csv`：20 目标 / 16 非目标（用户已确认）。
- `labels.pending.csv`：22 条追加样本已全部确认并合并；记录保留用户的逐条时间标注。
- `labels.csv`：60 行（39 目标 / 21 非目标），含 12 条追加目标、1 条低分目标、3 条低分非目标、6 条会话目标切片、2 条会话非目标切片。
- 标定：目标 15 条 min 0.446 / median 0.613；462 条负样本 max 0.332；0.35 时 0 FAR / 0 FRR。

## Phase 1 任务边界（已落地）

任务 `voice-speaker-tracker-shadow`：

- 只读 shadow：`VOICE_SPEAKER_TRACKING=shadow`，不丢帧、不改帧、不发客户端帧、不写 DB、不接 TSE。
- 纯逻辑：`voice-speaker-attractor.ts`、`voice-speaker-bank.ts`、`voice-speaker-selector.ts`。
- 观测缝：`voice-speaker-tracking-arm.ts`、`voice-realtime-speaker-seam.ts`、proxy 可选 seam。
- 测试：唯一新增 `server/modules/voice-realtime/tests/voice-realtime-speaker-tracker.test.ts`；同步更新 `server/shared/tests/quay-test-script.test.ts` 的收集数 pin。
- 不新建 `server/modules/<new>/` 目录（AC-394 棘轮）。

落地后的核对（2026-10-21）：`voice-speaker-attractor.ts`、`voice-speaker-bank.ts`、`voice-speaker-selector.ts`、`voice-speaker-tracking-arm.ts`、`voice-realtime-speaker-seam.ts` 与唯一新增测试文件均在；`voice-realtime-speaker-tracker.test.ts` 32/32 绿，`quay-test-script.test.ts` 14/14 绿（389 文件 / `unknown=386`/388），`npm run typecheck` exit 0。任务 Proposal 写于第一轮 20/16 标签；当前行为以 `thresholds.v1.json` 与 `labels.csv` 为准，第二轮 39/21 读数见 `CONFIRMED-LABELS.md` §10。

## 需要人类完成

1. 试听 `/tmp/speaker-gate-audition-2026-10-21/` 的 22 条，确认/修正 `labels.pending.csv`。
2. 录 2–3 位中文同事，每人 2–3 条、共约 2 分钟（需同意），补真实中文负样本。
3. 决定 Phase 3 的默认门控模式（软/硬）与 Phase 4 是否以 ASR WER 为 go/no-go。


## Phase 1.1 / 1.2（2026-10-21 签入）

用户裁定：设置文件是正常入口，环境变量只是 escape hatch；precedence 跟现有代码一致，为 **`env > file > default`**（选项 A）。

| 任务 | 状态 | 依赖 | 内容 |
|---|---|---|---|
| `voice-speaker-tracking-settings-file` | **已落地**（2026-10-21） | — | `speakerTracking`（mode/modelDir/modelFile/modelPath/thresholds/quality）进 `voice-realtime.settings.json`；按连接读取；模型按路径缓存；env 仅 escape hatch |
| `voice-speaker-model-provisioning` | **已落地**（2026-10-21） | `voice-speaker-tracking-settings-file` | 模型默认 `models/speaker/`，`.gitignore` 不入库；npm/Electron/Docker 不带（`npm pack --dry-run` 908 文件、0 条 `models/`）；`GET/POST /api/voice-realtime/speaker-model` 由设置页触发服务端下载，固定 URL + sha256 校验 + `.part` 原子 rename；同一路径单飞 |

落地形状（`voice-speaker-tracking-settings-file`）：

```json
{
  "speakerTracking": {
    "mode": "shadow",
    "modelDir": "models/speaker",
    "modelFile": "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "modelPath": "",
    "thresholds": { "track": 0.3, "matchFast": 0.35, "promote": 0.4,
                    "consistencyMin": 0.6, "margin": 0.08,
                    "maxStepSessionDeg": 15, "maxStepBankDeg": 8, "bankSize": 4 },
    "quality": { "windowSeconds": 2, "sampleSeconds": 3.5,
                 "speechRatioMin": 0.6, "minCoreSeconds": 2 }
  }
}
```

解析顺序：`modelPath` 非空则用它，否则 `join(modelDir, modelFile)`；缺省值等于
`thresholds.v1.json`。`VOICE_SPEAKER_TRACKING` / `VOICE_SPEAKER_MODEL_PATH` 只在非空时覆盖
文件（`environment > settings file > default`），每个生效值在连接日志里带一行 `source=`。
未知子键忽略；非法 mode、shadow 却解析不出路径、阈值/质量门越界或非有限数 ⇒ 整块拒绝
（原因进 `problems`），连接回退到 off/默认值。模型按解析后的路径缓存，加载失败只写一行日志
并保持 seam 缺席，不阻塞连接。

模型：`3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`，28,281,164 bytes，sha256 `aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2`，来源 k2-fsa/sherpa-onnx `speaker-recongition-models` release；3D-Speaker / Apache-2.0。

正常启动形态（Phase 1.1 落地后）：

```bash
VOICE_REALTIME_SETTINGS_PATH=/path/to/voice-realtime.settings.json npm run server
```

`VOICE_SPEAKER_TRACKING` / `VOICE_SPEAKER_MODEL_PATH` 只作为测试/运维 escape hatch，不再是对外文档的入口。
