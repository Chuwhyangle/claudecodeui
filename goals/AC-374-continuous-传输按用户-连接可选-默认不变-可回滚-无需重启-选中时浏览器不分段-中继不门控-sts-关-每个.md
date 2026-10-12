---
id: AC-374
title: Continuous 传输按用户/连接可选（默认不变、可回滚、无需重启）：选中时浏览器不分段、中继不门控（STS 关）、每个
  session.update 显式携带 server_vad/semantic_vad，绝不出现 VAD 关闭却无触发
status: draft
kind: criterion
goal: GOAL-044
criterion: for f in
  server/modules/voice-realtime/tests/voice-realtime-transport-opt-in.test.ts
  src/modules/chat/voice-realtime/tests/voiceTransportOptIn.test.tsx; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-transport-opt-in.test.ts &&
  npx vitest run
  src/modules/chat/voice-realtime/tests/voiceTransportOptIn.test.tsx
expect: 读数——(a) 未选择时行为与现状逐帧一致（默认沿用 VOICE_REALTIME_MODE）；(b) 选择 continuous：服务端不回应
  segmented 握手、浏览器持续上传 20 ms PCM（含静音）、中继不门控、STS 关闭、每个出站 session.update 的
  turn_detection 为配置的 server_vad 或 semantic_vad（取假形态：省略或置 null ⇒ 红）；(c) 关闭选择即回到
  segmented，无需重启服务；(d) 选择不影响其他用户与已建立的连接；(e) 取值来自 AC-372 读数（silence_duration 或
  semantic_vad 的默认推荐写在注释中并引用报告）。
origin: 人 yale 2026-10-13 裁定：Live Voice 体验优先，禁用浏览器 VAD 分段与中继静音门控，改 continuous
  传输并保留上游 server_vad 作评估触发；模型随意图完整反复评估在执行的 CLI 工作（继续/修改/取消/无需动作）。决策文档
  docs/proposals/live-voice-experience-first-decision-2026-10.md §11–§12（提交
  31d1b8b2）。
---
