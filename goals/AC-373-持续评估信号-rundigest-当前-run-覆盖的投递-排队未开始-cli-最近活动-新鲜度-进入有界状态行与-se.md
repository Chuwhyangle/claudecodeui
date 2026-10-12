---
id: AC-373
title: 持续评估信号：RunDigest（当前 run 覆盖的投递、排队未开始、CLI 最近活动、新鲜度）进入有界状态行与
  session_status；决策词汇（继续/补充/改方向/取消）写入指令；无需动作不报错；空条目不投递；翻转 B 腿
status: achieved
kind: criterion
goal: GOAL-044
criterion: 'for b in B1 B2 B3 B4 B5 B6 B7 B8 B9; do grep -q "test(.$b "
  server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
  || { echo "缺用例 $b（AC-371 未落地前本判据不得为绿）" >&2; exit 1; }; done; if grep -n
  "fixTask: .gap-live-voice-run-digest-evaluation-signal."
  server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts;
  then echo "仍有未翻转的已知缺陷腿" >&2; exit 1; fi; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
  server/modules/voice-realtime/tests/voice-realtime-status-tool.test.ts
  server/modules/voice-realtime/tests/voice-realtime-status-injection.test.ts'
expect: 读数——(a) RunDigest 字段：当前 run 覆盖的投递条数与末条摘要、排队未开始条数与末条摘要、CLI
  最近活动（工具名或末条助手文字摘要）、at/ageMs；状态行仍受字节上限、限频、去重约束，session_status 返回全量且与状态行同源；(b)
  指令写明四种决策与「不调用工具即继续」，模型的 "OK"/"No response requested." 类文字回复不再作为错误帧下发；(c)
  按条目自身空转写判定，空条目上的 session_send 不投递并如实显示；(d) AC-371 中指向本任务的已知缺陷腿全部翻为直接断言；(e)
  不增加主动唤起模型的触发。
origin: 人 yale 2026-10-13 裁定：Live Voice 体验优先，禁用浏览器 VAD 分段与中继静音门控，改 continuous
  传输并保留上游 server_vad 作评估触发；模型随意图完整反复评估在执行的 CLI 工作（继续/修改/取消/无需动作）。决策文档
  docs/proposals/live-voice-experience-first-decision-2026-10.md §11–§12（提交
  31d1b8b2）。
activatedAt: 2026-10-12T17:10:45.302Z
statusLog:
  - at: 2026-10-12T17:10:45.302Z
    from: draft
    to: active
    actor: goal-cli
    reason: continuous 基线：任务同批建立
  - at: 2026-10-12T19:26:41.204Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T17:10:45.302Z
---
