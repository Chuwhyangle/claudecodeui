---
id: AC-375
title: Live Voice 入口不再暴露 continuous/turn 传输切换按钮；服务端默认传输翻为 continuous（segmented
  变为部署级回滚开关）
status: achieved
kind: criterion
goal: GOAL-044
criterion: test -f
  src/modules/chat/voice-realtime/tests/voiceTransportOptIn.test.tsx && { echo
  "removed opt-in test file reappeared" >&2; exit 1; }; grep -rl
  "voice-realtime-transport\""
  src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx && { echo "button residue
  found" >&2; exit 1; }; grep -rl
  "readVoiceTransportPreference\|writeVoiceTransportPreference\|VOICE_REALTIME_TRANSPORT_STORAGE_KEY"
  src/ --include=*.ts --include=*.tsx && { echo "preference-storage residue
  found" >&2; exit 1; }; npx tsx --tsconfig server/tsconfig.json --import
  ./scripts/undici-blocked-ports-preload.mjs --test
  server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts
  server/modules/voice-realtime/tests/voice-realtime-transport-opt-in.test.ts
  server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
  server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts
expect: "读数——(a) 页面不再渲染 continuous/turn 传输切换按钮，客户端 localStorage 偏好与其读写函数一并删除（用户在
  Live Voice 下只需要说话）；(b) `resolveVoiceRealtimeMode` 未设置 `VOICE_REALTIME_MODE`
  时解析为 continuous（取假形态：残留任一按钮/偏好代码或该解析仍为 segmented ⇒ 红）；(c)
  `VOICE_REALTIME_MODE=segmented` 仍是部署级回滚开关，行为与 P4 时期的 segmented 通路逐帧一致；(d)
  服务端每连接 opt-in（`?transport=`、AC-374 的机制本身）未被删除，只是前端不再有 UI
  入口触达它——仍可用于诊断路由/未来场景；(e)
  `voice-realtime-scripted-scenarios.test.ts`、`voice-realtime-streaming-stages.\
  test.ts` 里依赖「未显式声明 segmentedRelay ⇒ 隐式走旧默认」的用例已改为显式 `segmentedRelay:
  true`，不再随部署默认值漂移。"
origin: 人 yale 2026-10-13 live voice 第三次语音测试裁定：页面上多出的 continuous/turn
  模式切换按钮完全没必要，用户在 Live Voice 下除了说话不应关心别的；确认后进一步裁定服务端默认传输同时翻为 continuous。推翻
  2026-10-10 P4 rollout 决策（segmented 为默认）与 AC-374（per-connection opt-in
  面向用户可见）的「默认不变」边界。决策文档
  `docs/proposals/live-voice-experience-first-decision-2026-10.md` §11-§12 的
  continuous-first 方向在此落地为唯一默认，不再需要用户选择。
supersedes:
  - AC-374
---
