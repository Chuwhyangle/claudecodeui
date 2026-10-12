---
id: AC-371
title: Continuous 行为验收 B-1..B-9 本地确定性：持续补充、细化、改方向、主动中断、保留仍必要
  run、不重复交付、真实进度、无需动作、长句；模型决策脚本给定，当前缺口以已知缺陷签名精确记录（只改测试）
status: draft
kind: criterion
goal: GOAL-044
criterion: '[ -f
  server/modules/voice-realtime/tests/voice-realtime-scripted-cli-host.ts ] || {
  echo "缺 CLI
  宿主模型：server/modules/voice-realtime/tests/voice-realtime-scripted-cli-host.ts"
  >&2; exit 1; }; for b in B1 B2 B3 B4 B5 B6 B7 B8 B9; do grep -q "test(.$b "
  server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
  || { echo "缺用例 $b" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts'
expect: 读数——(a) 用真实 bridge + ws-proxy、continuous 路径、scripted 上游的 server_vad
  声学仿真（按收到的 PCM 判静音）与按 E9/E10 建模的 CLI 宿主（回合边界聚合、中断保留队列、stale-first ≥50 ms 窗口、按
  uuid 撤回），逐条断言 B-1..B-9；(b) 模型决策由脚本给定，判据只验证「给定决策下管线行为正确」，不声称模型判断质量；(c) 当前不达标项用
  voice-realtime-known-defect.ts 的 expectKnownDefect 包裹，签名包含当前实际值，fixTask
  指向修复任务，并各有一个取假用例证明签名不吞他种失败；(d) 只改测试文件、不新增 *.test.ts、零外联。
origin: 人 yale 2026-10-13 裁定：Live Voice 体验优先，禁用浏览器 VAD 分段与中继静音门控，改 continuous
  传输并保留上游 server_vad 作评估触发；模型随意图完整反复评估在执行的 CLI 工作（继续/修改/取消/无需动作）。决策文档
  docs/proposals/live-voice-experience-first-decision-2026-10.md §11–§12（提交
  31d1b8b2）。
---
