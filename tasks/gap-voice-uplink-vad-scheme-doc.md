---
id: gap-voice-uplink-vad-scheme-doc
title: 落地上行 VAD 方案文档：非语音段保留开头 a 的真实音频（段首段丢弃）、退出由用户动作触发
  commit+response.create、禁止边界事件触发提交、不用合成零音频
status: done
labels:
  - gap
parent: null
children: []
extra:
  acceptance: test -f docs/operations/voice-realtime-uplink-vad-scheme.md && grep
    -q "不合成任何样本" docs/operations/voice-realtime-uplink-vad-scheme.md && grep -q
    "段首段" docs/operations/voice-realtime-uplink-vad-scheme.md && grep -q
    "response.create" docs/operations/voice-realtime-uplink-vad-scheme.md &&
    grep -q "边界事件" docs/operations/voice-realtime-uplink-vad-scheme.md && grep
    -q "silence_duration_ms" docs/operations/voice-realtime-uplink-vad-scheme.md
    && grep -q "已被取代" docs/operations/voice-vad-filtered-pcm-upstream-replay.md
---
## Proposal

把**服务端上行 VAD 方案**落成仓库内的正式设计文档，并在既有回放报告上加取代说明。方案内容为 2026-10-13 定稿版：

- **服务端 VAD 的唯一职责**是对上行 PCM 做 speech / non-speech 分类并丢弃非语音帧，减少发往 Realtime upstream 的字节；不引入 turn detection / endpointing / 语义提交，不改上游 `turn_detection` 参数或检测时机。
- **非语音段保留开头 a 的真实音频**：后置滤波后，每个非语音段的开头 `a` 毫秒**原样转发真实样本**，其余丢弃。`a` 由**解析后的** `turn_detection.silence_duration_ms` + 1 帧导出（出货 400 ⇒ 420 ms），**不得写死**。⛔ **不用合成零音频**。
- **段首静音整段丢弃**：流开头、任何语音帧之前的那一段非语音整段丢弃 —— 上游此时没有任何待闭合的东西。
- **退出路径**由**用户点击退出这一显式动作**触发 `input_audio_buffer.commit` + `response.create`，随后有界等待提交/转写/转发再关闭。这是「不发 response.create」的**唯一有界例外**，作用域仅限用户退出。
- ⛔ **VAD 的边界事件不得触发任何提交**：`speech_started` / `speech_stopped` / `committed` 只可被读作可观测读数，发送决策完全由「掩码 + 保留窗」决定。

**当前来源**：方案全文已存在于主检出工作区（未提交）`docs/operations/voice-realtime-uplink-vad-scheme.md`，sha256 `376699d304c1fd9ee60bd74f5f8cfa9d952cdbcc133a6014027abfa5b8628163`；另有一份任务外备份在 `/tmp/vad5/docbackup/`（含 SHA256SUMS）。同时主检出工作区对 `docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 有一处未提交修改（顶部取代说明），sha256 `ca057d09e6d2b6576c1aab2ae1aa9735a4f9d6696444ee774256019067b4837c`。**落地时必须采用这两份内容，任何改写都不得丢失上述要点。**

**查重（实测）**：`gap-voice-five-vad-offline-comparison-on-real-corpus`（done）只做离线指标；`gap-voice-three-vad-filtered-pcm-real-upstream-replay`（done）是实现前的回放实测、其补发补的是合成零样本、且不含退出路径；非 done 的 VAD 相关任务只有 `gap-voice-delivered-merged-message-invisible-in-transcript`（另一处界面面）。**没有任何任务承载本方案文档。**

## Plan

1. 在任务 worktree 内落 `docs/operations/voice-realtime-uplink-vad-scheme.md`，内容取自上述来源（先读 `/tmp/vad5/docbackup/` 或主检出工作区文件），并核对 sha256。
2. 在 `docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 顶部加取代说明：指出该报告的补发是合成零样本、已被本方案取代，但其读数仍然有效。
3. 交叉引用：方案文档引用回放报告与离线对比文档；回放报告指向方案文档。
4. 只改文档，不动任何代码、不动任何生产默认值。
5. 经 Provider ABI `task_write` 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [x] AC1 `docs/operations/voice-realtime-uplink-vad-scheme.md` 已在 worktree 内存在，且 `sha256sum` 与 `376699d304c1fd9ee60bd74f5f8cfa9d952cdbcc133a6014027abfa5b8628163` **逐字相同**（若因必要的格式修订而不同，必须在 `## Evidence` 写出逐条差异与理由，且差异不得涉及下述判据要点）。
- [x] AC2 假形态：文档**不得**把「补发合成零音频」写成现行设计。读数：`grep -n "补一段.*真静音\|零样本" <文档>` 的每一处命中都必须处在明确的"已被取代 / 旧形态"语境内；若存在任何一处把零样本当作现行规则 ⇒ 红。
- [x] AC3 文档必须含「非语音段保留开头 a 的真实样本」这一现行规则，且含「**不使用合成零音频**」的明文。
- [x] AC4 文档必须含「段首段（任何语音帧之前的非语音段）整段丢弃」这一规则，并写明它是相对已验证变体的刻意偏离、须一并复验。
- [x] AC5 文档必须含退出路径一节，且同时写明三件事：触发源是**用户动作**、动作为 `commit` + `response.create`、以及它是「不发 response.create」的**唯一有界例外**。
- [x] AC6 文档必须明文禁止 VAD 边界事件触发提交：`speech_started` / `speech_stopped` / `committed` 只作读数。
- [x] AC7 `docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 顶部含取代说明，指向方案文档，并声明其读数仍然有效。读数：`sed -n '1,12p'` 可见该说明。
- [x] AC8 文档含 `a` 必须由**解析后的** `silence_duration_ms` 导出的要求，以及假形态（写死 400 而配置为其他值 ⇒ 红）。
- [x] AC9 文档含两条已推翻结论的记录（「Silero/TEN 可复现地丢末句」是收尾伪影；「基线 5 句摆到 3 句」是过早快照），使同一错误不致复现。
- [x] AC10 本任务**零代码改动**：`git diff --name-only <fan-in 基线>..HEAD` 只含上述两个文档与本任务文件；若出现任何代码文件 ⇒ 红。

## DoD

方案文档在 develop 上可读、完整承载定稿方案（真实开头 a、段首段丢弃、退出 commit+response.create 且触发源为用户动作、禁止边界事件触发提交、禁止合成零音频），回放报告带取代说明且读数效力声明清楚；无任何代码或生产默认值被改动。

## Touches

- docs/operations/voice-realtime-uplink-vad-scheme.md (new)
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md
- tasks/gap-voice-uplink-vad-scheme-doc.md

## Notes

**来源保全**：主检出工作区里的两份未提交文件**不要删除、不要覆盖**；备份在 `/tmp/vad5/docbackup/`（`voice-realtime-uplink-vad-scheme.md`、`replay-report.modified.md`、`SHA256SUMS`）。

**不做**：不实现任何代码；不改生产默认值；不重跑离线对比或回放实验。
