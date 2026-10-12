---
id: AC-367
title: 逐段 uncertain/lost 诚实状态：浏览器按服务端 ACK 分级渲染「正在重试 / 未送达请重说 / 连接已断开未发送」，与
  AC-355 的 heard/未识别同一处置模型，丢失不显示为未识别或已发送
status: draft
kind: criterion
goal: GOAL-043
criterion: f=src/modules/chat/voice-realtime/tests/voiceSegmentLostState.test.tsx;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f"
expect: 读数——(a) written 后在 committed 前断线 ⇒ 该段显示「连接中断，正在重试」；lost(upstream-drop)
  ⇒「这段话没有送达模型，请重说」；lost(connection-closed) ⇒「语音连接已断开，这段话没有发送」且状态栏显示断开；(b) lost
  段不显示为未识别、已发送或投递中，也不在退出时被当作未转发回填到 composer（避免把没送达模型的话误称为模型不转发）；⚖️ 若人裁定 lost
  段退出时也回填，则改为回填并标注；(c) 与 AC-355 的处置模型共用同一状态源；(d) 取假形态：把 lost 帧当 dropped 处理 ⇒ (a)
  红。
origin: 人 yale 2026-10-13 授权按双断线分析方案推进（Opus 常驻会话；证据 journal
  ~/.cloudcli/voice-realtime-log/e22ac831-30c6-4600-8bcf-b5c3cc7e3a8c.jsonl：seq2
  断线重放后再断丢失、pendingCommitSeqs 跨 epoch 错配、openAttempts 不复位致第三次断线永久关闭、关闭后 seq7–12
  仍回 committed）。
---
