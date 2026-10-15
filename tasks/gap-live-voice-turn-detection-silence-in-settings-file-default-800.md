---
id: gap-live-voice-turn-detection-silence-in-settings-file-default-800
title: Live Voice 断句窗口进设置文件（silence_duration_ms，缺省 800）；派生尾窗保持派生并钉住
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**来源（本会话实测，`experiments/voice-realtime-fragment-hold-probe/RESULTS.md` 第二轮）**：整句窗口、3 段真实音频 × 4 次重复、`s400` vs `s800`（唯一变量 = 上游 `server_vad.silence_duration_ms`）：

| 读数 | 7c01be7e | a175e6cd | 86559798 |
|---|---|---|---|
| 上游 turn 15→7 / 8→5 / 6→3 | −53% | −38% | −50% |
| **responses（人抱怨的那个症状：每个半句一次 response）** | **9→3（−67%）** | 9→7（−22%） | 5→4（−20%） |
| 被取消的响应（"cut off because you started speaking again"） | 4→1 | 1→1 | 1→0 |
| 内容覆盖率 relay字/ASR字（不丢内容） | 1.02→0.96 | 1.01→0.87 | 0.89→1.01 |
| 末 stop → 末投递（代价） | +513 ms | +240 ms | 0 ms |
| 单次花费 | −55% | −29% | −3% |

⇒ **800 该出货**（理由＝症状与成本，不是"投递条数减半"——投递条数只在过切分最重的那段从 4 降到 1）。

**现状（已核对）**：
- 出货值写死在 `voice-realtime-turn-detection.ts:70`：`DEFAULT_TURN_DETECTION = { type:'server_vad', threshold:0.5, silence_duration_ms:400 }`，并带 `SILENCE_DURATION_MS_RANGE = {min:200,max:6000}`。
- **env 覆盖已经存在**：`VOICE_REALTIME_TURN_DETECTION` / `_SILENCE_MS` / `_THRESHOLD`，经 `resolveTurnDetection(process.env, override?)`（`server/index.ts:621` 带 override、`voice-realtime-ws-proxy.service.ts:2150` 只带 env）。
- **设置文件面（`VOICE_REALTIME_SETTINGS_PATH` → JSON）目前只认 `version`/`instructions`/`contextTemplate`**，没有任何 turn-detection 键；而代理在 `:1938` 已经 `loadVoiceRealtimeSettings(...)` ⇒ **接线点已就绪**，只差把文件里的值传进 `:2150` 那次 `resolveTurnDetection`。

**改法（两件）**：

1. **设置文件提供 `turnDetection`**（与线上形状同名：`{ type, threshold, silence_duration_ms }`）：缺对象、或缺 `silence_duration_ms` 时取 **800**。
   - **优先级：env > 文件 > 800**（env 仍是部署逃生口），并把**解析结果与来源**记进日志（`describeTurnDetection` 已有，把它接上）。
   - 文件里的值走**既有范围校验**；越界/类型错按既有拒绝路径：回落默认 + 进 `problems`，**绝不抛**。
   - 设置文件里出现**未知键**时沿用文件加载器现有的处理方式（不要新造一套）。
2. **派生尾窗：不提供独立配置，保持派生——这是"检查"的结论**，三条理由：
   - ① 门控的 `a = round((silence + 200) / 20) + 1` 里那个 **`+1` 边界帧是承重的**：出货 400 正好压在上游 `server_vad` 的 `>=` 收口语义上（`voice-realtime-uplink-vad-gate.ts:47-52` 记着这条推理）。默认改 800 后这个关系要**重新核对**，而不是随手加个独立旋钮。
   - ② 独立配置允许出现**不一致的组合**（门控尾窗 ≠ 上游收口语义）⇒ 会落回 gate 注释里记的那个失效形态（"尾窗正好等于 silence 时，回合会一直开到下一句的 pre-roll"）。
   - ③ **800 下派生值自洽**，不需要另调：`uplinkHeadKeepFrames(800) = round(1000/20)+1 = 51`（400 时是 31）；`holdOpenFrames = round(2000/20) = 100`，`holdOpenEnabled = 100 > 51` 仍为真。
   ⇒ 交付形式是**核对 + 钉住**：把这条判断写进 gate 的注释，并用单测钉住派生关系（见 AC5/AC6），这样将来谁要加独立旋钮，必须先有意识地删掉那条钉住。

<!-- dedup-ref --> **相关任务与粒度决定**：granularity 工具对三个主子文件报 `peers: []`（无 Touches 重叠的开放任务）。与本会话已立的两条（`gap-live-voice-dispatch-hook-production-wiring`、`gap-live-voice-busy-release-quiet-window-next-priority`）**改的是不同机制**：那两条分别动 hook 注入与忙时投递释放点，本条只动"断句窗口的配置面 + 默认值"，验收独立 ⇒ 分开立。`voice-realtime-ws-proxy.service.ts` 历史落地 46 个任务、中位改动 830 行——**本条在该文件里只改一行（把文件值传进 `resolveTurnDetection`）**，实现要小步。

## AC

- [ ] AC1（文件键生效）：临时写一份设置 JSON（含 `turnDetection.silence_duration_ms = 600`），用 `loadVoiceRealtimeSettings` 读到它、并经 `resolveTurnDetection` 解析 ⇒ 得到 **600**；断言用脚本（`npx tsx --tsconfig=server/tsconfig.json --test <新增/既有 settings 测试文件>`）退出 0，读数记入 `## Notes`。
- [ ] AC2（缺省 800）：同一测试里断言 —— 文件**没有** `turnDetection` 对象时、以及对象在但**没有** `silence_duration_ms` 时，解析结果都是 **800**；`grep -n "silence_duration_ms: 800" server/modules/voice-realtime/voice-realtime-turn-detection.ts` 有输出（默认值已改）。
- [ ] AC3（优先级 env > 文件 > 默认）：env 设 `VOICE_REALTIME_TURN_DETECTION_SILENCE_MS=500` + 文件设 600 ⇒ 得 **500**；env 无 + 文件 600 ⇒ 600；两者都无 ⇒ 800。三条断言写进同一测试文件，并把这条优先级写成代码注释（`voice-realtime-turn-detection.ts` 的 `resolveTurnDetection` 头部）。
- [ ] AC4（越界仍走既有拒绝路径）：文件里写 `silence_duration_ms: 100`（低于 min 200）⇒ 解析回落 **800**、`problems` 非空且含该键名；测试退出 0，`problems` 原文记入 `## Notes`。
- [ ] AC5（派生尾窗：核对并钉住）：单测断言 `uplinkHeadKeepFrames(800) === 51` **且** `uplinkHeadKeepFrames(400) === 31`（frameMs=20、margin=200、boundary=1）；并在 `voice-realtime-uplink-vad-gate.ts` 的 `uplinkHeadKeepFrames` 注释里写明**为什么它仍保持派生、不提供独立配置**（把上面 ①②③ 写进去，引用 400→800 的改动）。
- [ ] AC6（hold-open 关系不变）：单测断言 `UPLINK_VAD_HOLD_OPEN_MAX_MS` 派生出的 `holdOpenFrames = 100` 与 800 下的 `aFrames = 51` 满足 `holdOpenEnabled === true`（即 `100 > 51`）；若实现里该关系是内部量，则以 gate 暴露的读数断言。
- [ ] AC7（不削弱既有判据 + 钉住点全部更新）：`npm run typecheck` 与 `npm run lint` 各自退出 0；单跑这五个文件各自退出 0：`voice-realtime-turn-detection.test.ts`、`voice-realtime-context-and-settings.test.ts`、`voice-realtime-uplink-vad.test.ts`、`voice-realtime-uplink-vad-seam.test.ts`、`voice-realtime-uplink-vad-hold-open.test.ts`。⚠️ `voice-realtime-turn-detection.test.ts` 里有 **4 处 400 的字面量**（含 `DEFAULT_WIRE` 与 `ANCHOR = 'silence_duration_ms: 400,'` 这类**源码钉住**）⇒ 逐处按新默认更新，并把**改动前后逐字**记入 `## Notes`。
- [ ] AC8（端到端）：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 单跑退出 0；若该 spec 依赖具体 silence 值而转红，**不得**改判据迁就——把红读数与原因记入 `## Notes` 并停手 needs-human。
- [ ] AC9（文档）：若 `docs/operations/voice-realtime-continuous-calibration.md`（或其它文档）描述了设置文件的键集，则把 `turnDetection` 与"缺省 800"补进去；若没有文档描述该键集，则在 `voice-realtime-settings.ts` 的 `loadVoiceRealtimeSettings` 头部注释里写明。两种情形都要在 `## Notes` 里指明走的是哪一支。

## DoD

真实会话里解析出的 `silence_duration_ms` 是 **800**（journal/日志里可见 `describeTurnDetection` 的那行，含来源），且行为按实验预期改变（同一段音频的上游 turn 数明显下降）；**在设置文件里改这个值能生效**（改成 600 后日志显示 600），**删掉该键回落 800**；派生尾窗随之变为 51 帧且**没有**独立的配置项——将来有人要加独立旋钮，必须先删掉 AC5/AC6 那两条钉住。

## Touches

- server/modules/voice-realtime/voice-realtime-turn-detection.ts
- server/modules/voice-realtime/voice-realtime-settings.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-uplink-vad-gate.ts
- server/modules/voice-realtime/tests/voice-realtime-turn-detection.test.ts
- server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts
- tasks/gap-live-voice-turn-detection-silence-in-settings-file-default-800.md
