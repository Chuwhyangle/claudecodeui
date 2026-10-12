---
id: gap-live-voice-continuous-transport-opt-in
title: Continuous 传输按用户可选（默认不变、可回滚、无需重启、turn_detection 始终显式有效）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-continuous-behavior-acceptance
  - gap-live-voice-continuous-keepalive-long-speech-calibration
  - gap-live-voice-silence-tail-suppression
goal_ac: AC-374
---
## Proposal

### 背景（本组任务共用）

人 yale 2026-10-13 裁定（决策文档 `docs/proposals/live-voice-experience-first-decision-2026-10.md` §11–§12，提交 `31d1b8b2`）：
- Live Voice 体验优先：**禁用浏览器 VAD 分段与中继静音门控（含 STS）**，改为 continuous 传输；
- **保留上游 `server_vad`**（或经校准的 `semantic_vad`）作为评估触发，绝不出现关了 VAD 又无触发；
- 模型随用户意图逐渐完整，**反复评估**在执行的 CLI 工作：继续、修改、取消或无需动作。

两条边界分开：
- 音频采集与传输：持续 20 ms PCM，含静音，不分段、不门控；
- 语义输出：由模型决定投递、中断或无需动作；CLI 在回合边界聚合。

已有读数：
- C-4：静音零计费；
- V-2：停传约 300 s 被上游 1007 关闭；
- C-1：`semantic_vad` 有效；
- C-5：模型不会自己等句子完整。

**缺失的 L4 持续评估信号**（§12.5）：
- 模型只看得到计数状态行和连接时一次性的上下文包，不知道当前 run 覆盖了哪些意图、还有哪些排队未开始、CLI 最近在做什么；
- 「无需动作」会被记为 `MODEL_TEXT_REPLY` 错误；
- 空条目上的编造投递会漏过。


### 本任务（实现，默认不变、可回滚、无需重启）

今天传输模式只能由进程级环境变量 `VOICE_REALTIME_MODE` 决定（`voice-realtime-mode.ts`，默认 segmented），切换需要重启服务。本任务增加**按用户（或按连接）的传输选择**：

- 未选择：与现状逐帧一致（沿用环境变量）。
- 选 continuous：
  - 服务端对该连接不回应 segmented 握手，浏览器持续上传 20 ms PCM（含静音）；
  - 中继不门控，STS 关闭；
  - 每个出站 `session.update` 的 `turn_detection` 显式为配置的 `server_vad`（`silence_duration_ms` 取 AC-372 R-2 推荐值）或 `semantic_vad`。**绝不**省略，也不置 null（文档 P-1：省略即默认 VAD；null 即无触发）。
- 关闭选择：下一条连接回到 segmented，**无需重启**。
- 选择存于用户语音设置（复用 `voice-realtime-settings.ts` 的存储），UI 给出一个开关（文案进入全部 11 个 locale）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


- ⛔ 不改默认值；生产默认切换由人另行裁定。

## Plan

1. 读 AC-372 读数确定 `turn_detection` 默认；2. 设置存储与握手分支；3. 浏览器开关；4. 判据（服务端：逐帧一致性、turn_detection 显式、无门控；客户端：开关与握手）；5. typecheck / lint。

## AC

- [x] AC1：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-transport-opt-in.test.ts` 退出 0；取假形态「continuous 下省略或置 null `turn_detection`」⇒ 红。
- [x] AC2：`npx vitest run src/modules/chat/voice-realtime/tests/voiceTransportOptIn.test.tsx` 退出 0（开关、握手、关闭回退）。
- [x] AC3：未选择时既有 segmented 判据全部退出 0（`voice-realtime-segmented-protocol.test.ts`、`voice-realtime-segmented-default.test.ts`）。
- [x] AC4：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

用户可在不重启服务的前提下逐连接选用 continuous 并随时回退；默认行为与生产配置不变；`turn_detection` 在 continuous 下始终显式有效。

## Touches

- server/modules/voice-realtime/voice-realtime-mode.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts（握手分支）
- server/modules/voice-realtime/index.ts（导出按连接选择）
- server/index.ts（按连接解析模式）
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx（开关入口）
- src/shared/api.ts（socket URL 增加 transport 参数）
- src/shared/voiceConfig.ts（浏览器本地传输选择）
- src/modules/i18n/locales/*/chat.json（开关文案，全部 12 个 locale 均存在）
- server/modules/voice-realtime/tests/voice-realtime-transport-opt-in.test.ts (new)
- src/modules/chat/voice-realtime/tests/voiceTransportOptIn.test.tsx (new)
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子：unknown 313→314、315→316）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-continuous-transport-opt-in.md

## Notes

立项：Opus 常驻会话，2026-10-13（GOAL-044 / AC-374）。depends_on 含 STS 实现任务（共改 ws-proxy 与钉子文件）。

实现偏差（落地记录）：选择存于**浏览器本地**（`localStorage`，key `voice-realtime-transport`，见 `src/shared/voiceConfig.ts`），未改 `voice-realtime-settings.ts`。理由：该设置文档是按列整存的服务端单例，库里多处读取器按「恰好十个字符串字段」比较它（见 `voiceSettingsDb` / `VOICE_SETTINGS_FIELDS` 注释），加字段需新列 + 迁移；而 `writeVoiceFallbackPreference` 自身的注释已确立「属于本浏览器这条连接的事实不进服务端」的先例。本任务 Proposal 的「按用户（或按连接）」明确允许按连接，选择随连接 URL（`?transport=continuous`）逐条生效，未选择者逐帧等同现状。
