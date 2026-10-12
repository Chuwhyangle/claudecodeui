---
id: AC-340
title: Live Voice 指令无停止词触发规则：VOICE_REALTIME_INSTRUCTIONS 与语音工具描述不含停止词字面清单或「用户说 X
  就调用」的条件映射，中断以语义描述
status: draft
kind: criterion
goal: GOAL-041
criterion: f=server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --test "$f"
expect: 读数——(a) 指令与三个语音工具描述中不出现 "stop"/"停"/"停下"/"别做了" 等带引号的触发字面量，也不出现 if the
  user says/tells you to … call 的条件式；(b) 指令仍要求：判断用户想停止当前执行时调用 session_interrupt
  并说明理由（intent），其余一律 session_send；(c) 阶段 0 不扩语义（不出现「修正方向即中断」的措辞，那属 AC-342）；(d)
  既有 A-3b（只说「停」而模型未调工具 ⇒ 无 abort）仍绿。取假形态——把词表放回 ⇒ (a) 红。
origin: 人 yale 2026-10-12 授权按 A+ 推荐落地（Opus 常驻架构会话）。证据：journal
  ~/.cloudcli/voice-realtime-log/99df08d8-….jsonl × Claude transcript
  c6493eb6（2026-10-12 01:24–01:31 UTC）；契约见
  docs/proposals/voice-realtime-persistent-control-SPEC.md §0.3 / §18。
---
