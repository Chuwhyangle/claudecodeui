---
id: AC-350
title: 能力位 cancelQueuedInput 与实测一致：claude resident 置 true 并引用 E9/E10-U4
  读数，过时推理注释更正，矩阵值有判据钉住
status: draft
kind: criterion
goal: GOAL-041
criterion: f=server/modules/providers/tests/provider-capabilities-cancel-queued.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --test "$f"
expect: 读数——(a) PROVIDER_CAPABILITIES.claude.residentFeatures.cancelQueuedInput
  === true，其余 provider 无该位或为 false；(b) 该行注释引用 E9 与 E10/U4；(c)
  voice-realtime-ws-proxy.service.ts 中基于「该位为 false」的推理注释已更正（判据扫描该文件不含 "slot is
  `false`" 一类表述）；(d) session-hosts/tests/lifecycle-mode.test.ts
  等既有钉子同步更新且绿。取假形态——把位改回 false ⇒ (a) 红。
origin: 人 yale 2026-10-12「按建议推进」续裁 D-10/D-11（SPEC §0.3，提交 d09c4bc9）；证据 E9 +
  E10/U4（docs/proposals/claude-resident-sessions-experiments.md）。
---
