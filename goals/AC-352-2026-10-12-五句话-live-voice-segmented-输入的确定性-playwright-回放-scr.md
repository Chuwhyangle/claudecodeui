---
id: AC-352
title: 2026-10-12 五句话 Live Voice segmented 输入的确定性 Playwright 回放：scripted fake 上游
  + debug-agent + 假麦克风覆盖 seq0~seq5，当前缺陷腿以 test.fail 标注并逐腿指向修复任务
status: active
kind: criterion
goal: GOAL-043
criterion: f=e2e/voice-realtime-segmented-replay-20261012.spec.ts; [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test
  "$f" --workers=1
expect: 单文件 playwright 退出 0，零云调用。回放按 journal 逐帧：seq0 转写+session_send 送达；seq1 提交报
  buffer too small + 模型自答 OK；seq2 提交后上一条目（B）的转写晚到；seq3 条目 C 分支 A 永无转写 / 分支 B 在
  seq4 提交后晚到；~8s turn_unanswered；seq4 转写但模型不转发；seq5 模型只转发 S5；用户点退出。正向腿（当前即绿）：只有
  S1、S5 到 Claude（debug-agent 用户行 + sent 帧）；可恢复错误不出红色 UI；退出回填 composer。缺陷腿（当前红，用
  test.fail 标注并在注释写出修复任务 id 与当前代码上的逐字失败行）：(a) segments 开始后上游收到的 session.update 的
  turn_detection 非 null；(b) 晚到转写按到达时的 activeSegmentSeq 归属而非 itemId；(c)
  未被转发的转写未保持诚实 heard 状态 / 未按说话顺序；(d)
  无转写段（第三句话）无逐段可见标记、用户退出时无关闭痕迹。连续运行两次红绿集合相同（确定性）。取假形态：去掉某条 test.fail 标注 ⇒
  该腿在当前代码上红。
origin: 人 yale 2026-10-12 授权（Opus 常驻会话，live voice 五句话测试复盘）。证据：journal
  ~/.cloudcli/voice-realtime-log/ef9daacd-9950-414a-acfc-aace142bf273.jsonl
  07:47:30–07:49:25Z +
  voice-realtime-capture/ef9daacd….timeline.jsonl；用户裁定：Realtime
  模型可以不转发部分输入，绝不实现「有转写就自动补发 Claude」，转写晚到本身不是缺陷。
activatedAt: 2026-10-12T08:26:35.038Z
statusLog:
  - at: 2026-10-12T08:26:35.038Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T08:26:35.037Z
timeoutMs: 115000
---
