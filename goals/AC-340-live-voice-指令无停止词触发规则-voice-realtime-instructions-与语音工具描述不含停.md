---
id: AC-340
title: Live Voice 指令无停止词触发规则：VOICE_REALTIME_INSTRUCTIONS 与语音工具描述不含停止词字面清单或「用户说 X
  就调用」的条件映射，中断以语义描述
status: achieved
kind: criterion
goal: GOAL-041
criterion: f=server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --test "$f"
expect: 读数——(a) 指令与三个语音工具描述中不出现 "stop"/"停"/"停下"/"别做了"/"cancel"/"取消"
  等带引号的触发字面量，也不出现 if the user says/tells you to … call 的条件式；(b)
  指令仍要求：由模型语义判断何时调用 session_interrupt，其余一律 session_send、从不文本作答；(c) 既有
  A-3b（只说「停」而模型未调工具 ⇒ 无 abort）仍绿。阶段 0 不扩中断语义是任务范围约束而非本判据（AC-342
  扩到「修正方向」后本判据须保持绿）。取假形态——把词表放回 ⇒ (a) 红。
origin: 人 yale 2026-10-12 授权按 A+ 推荐落地（Opus 常驻架构会话）。证据：journal
  ~/.cloudcli/voice-realtime-log/99df08d8-….jsonl × Claude transcript
  c6493eb6（2026-10-12 01:24–01:31 UTC）；契约见
  docs/proposals/voice-realtime-persistent-control-SPEC.md §0.3 / §18。
activatedAt: 2026-10-12T06:07:27.259Z
statusLog:
  - at: 2026-10-12T06:07:27.259Z
    from: draft
    to: active
    actor: goal-cli
    reason: GOAL-041 立项：任务同批建立
  - at: 2026-10-12T08:05:18.903Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T06:07:27.259Z
---
