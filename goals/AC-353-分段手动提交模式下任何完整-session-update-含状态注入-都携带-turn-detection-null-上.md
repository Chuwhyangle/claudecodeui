---
id: AC-353
title: 分段手动提交模式下任何完整 session.update（含状态注入）都携带 turn_detection:null，上游 server_vad
  不会被重新打开；journal 记录 turn_detection
status: active
kind: criterion
goal: GOAL-043
criterion: f=server/modules/voice-realtime/tests/voice-realtime-manual-vad-session-update.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --test "$f"
expect: 读数——真 bridge + scripted fake 上游：(a) segments 开始后，状态注入/重新声明工具触发的每一条完整
  session.update 的 session.turn_detection === null；(b)
  连续模式（VOICE_REALTIME_MODE=continuous）下仍携带解析出的 server_vad 配置（行为不变）；(c) 重连后仍先发
  VAD-off；(d) journal 的 session.update 行包含 turn_detection
  取值。取假形态——恢复「{...sessionDefaults} 整份展开」⇒ (a) 红。回放 spec 中对应缺陷腿去掉 test.fail 后绿。
origin: 人 yale 2026-10-12 授权（Opus 常驻会话，live voice 五句话测试复盘）。证据：journal
  ~/.cloudcli/voice-realtime-log/ef9daacd-9950-414a-acfc-aace142bf273.jsonl
  07:47:30–07:49:25Z +
  voice-realtime-capture/ef9daacd….timeline.jsonl；用户裁定：Realtime
  模型可以不转发部分输入，绝不实现「有转写就自动补发 Claude」，转写晚到本身不是缺陷。
activatedAt: 2026-10-12T08:26:35.586Z
statusLog:
  - at: 2026-10-12T08:26:35.586Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T08:26:35.586Z
---
