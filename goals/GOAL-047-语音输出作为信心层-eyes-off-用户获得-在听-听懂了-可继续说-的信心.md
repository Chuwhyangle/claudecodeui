---
id: GOAL-047
title: 语音输出作为信心层：eyes-off 用户耳闻「在听、听懂了、可继续说」的信心
status: achieved
kind: goal
origin: 本会话 2026-10-19 yale 与 Claude 讨论产出；退出条件标题改回逐字 `##
  退出条件`（gap-goal-047-exit-condition-heading-suffix-unreadable 选型 b），第 7 条分离为非 AC
  人工验收门 H1
activatedAt: 2026-10-19T08:54:24.497Z
statusLog:
  - at: 2026-10-19T08:54:24.498Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-19T10:10:42.921Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

2026-10-19 讨论语音输出机制，结论：语音输出是「信心层」不是「信息层」。信息传递靠屏幕；语音输出的唯一职责是让用户——尤其不看着 PC/手机时——持续获得「系统在听、听懂了一些、可以继续说」的信心。北极星 KPI = 给出确认后用户是否继续往下说。

贯穿性质：异步（触发/生成/播报三条独立时间线，relay 保持「笔」，播报走旁路 narrator）；双工可打断（打断 = 对话推进不是异常，被打断的播报丢弃不补）；短信号换等待；前重后轻。

已落地（本会话 + quay driver）：announce 模式（`closingTurn=announce`）、run-end 总结触发、narrator 队列（可清空、打断）、echoCancellation 结案、Live Voice 独立凭证字段 `liveVoiceDashscopeApiKey`（区别于 voice-input 的 `dashscopeApiKey`）、掩码/无效 key 的错误提示。

## 范围

语音输出四个时机 + 横切底座：
1. 占位确认（announce）—— AC-403。
2. 结束总结（run-end）—— AC-404。
3. TTS 接入（cosyvoice，复用 `liveVoiceDashscopeApiKey`）—— AC-405 + AC-408。
4. 双工打断 + 可清空队列—— AC-406。
5. backchannel（semantic_vad 不可观测，已回退「暂停检测 + 主动 response.create」）—— AC-407。

横切底座 E0：端到端验证/开发平台（scripted endpoint，suite 内可判）。
Live Voice 设置独立：Settings - Voice 分「Voice Input / Live Voice」两个子 tab，`liveVoiceDashscopeApiKey` 只在 Live Voice tab（首轮只放 key，endpoint/model/voice 用后端默认）—— AC-409。

## 非目标

- 不做「进展 update」（执行中断续进展）。
- 不让 relay 模型兼职「总结员」：总结由旁路文本模型生成，relay 保持「笔」。
- 不朗读 Claude 完整回答——narrator 只说短确认/摘要；朗读完整回答是另一个 producer，需单独设计。
- 不引入新 UI 之外的改动；不发布、不重启 :3001（上线需人工 build/restart）。

## 退出条件

北极星：跑通完整典型场景。一次完整的 Live Voice 交互端到端跑通：用户说一句话 → realtime 转写并转交 → announce 语音「好的，我来做 X」经 TTS 出声 → run 结束 → 总结语音经 TTS 出声。用户耳闻「开始确认」与「结束总结」，而非只看到文本。判定链：

1. AC-403：announce 转交后说 ≤15 字开始确认，非 OK、非复述。
2. AC-404：run 结束触发 narrator 产出 ≤40 字、无 Markdown、verbatimTail≈0 的小结。
3. AC-405：cosyvoice 合成非空音频，`tts_audio` 帧 seq 连续、`tts_done` bytes 正确；假模型名必失败。
4. AC-406：播报中注入用户语音 → 当前播报终止、队列清空。
5. AC-407：停顿「不确定态」给「嗯」级回执（semantic_vad 不可观测已回退）。
6. AC-408：端到端典型场景（scripted endpoint，suite 内可判）——announce/总结文本经 TTS 合成、`tts_audio` 帧按 seq 到达浏览器、播放后回 `narrator_done` 推进下一句。
7. AC-409：Live Voice 配置最小面——Live Voice 子 tab 只暴露 `liveVoiceDashscopeApiKey`（endpoint/model/voice 用后端默认），仅配 key 即具备跑通典型场景的配置前提。

## 人工验收门（不计入充分性判定）

- H1 人工确认（非 AC）：MCP 浏览器真实连 DashScope，跑一次完整交互，耳闻 announce + 总结出声。