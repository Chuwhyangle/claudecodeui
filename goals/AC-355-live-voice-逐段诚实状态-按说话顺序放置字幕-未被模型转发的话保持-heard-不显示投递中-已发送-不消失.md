---
id: AC-355
title: Live Voice 逐段诚实状态：按说话顺序放置字幕；未被模型转发的话保持
  heard（不显示投递中/已发送、不消失）；无转写段原位显示未识别；用户退出按说话顺序回填未转发的话并留关闭痕迹
status: active
kind: criterion
goal: GOAL-043
criterion: f=src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f"
expect: 读数（vitest + 真 hook/组件，帧序列取自 2026-10-12 journal）：(a) 字幕行顺序 = seq
  顺序，与转写到达顺序无关；(b) 只有被 sent 认领的话变为已发送，其余保持 heard，不出现 delivering、不被移除；(c)
  已提交但超过时限既无转写也无失败事件、或提交被拒的段，在原位渲染一行「未识别」（全部 locale 有译文），转写随后到达则原位替换为字幕（分支
  B）；(d) 用户点退出：composer 追加且仅追加未转发的最终转写，按 seq 顺序（分支 A：第二句+第四句；分支
  B：第二+第三+第四），未识别段不回填但关闭痕迹计数包含它；(e) UPSTREAM_ERROR/MODEL_TEXT_REPLY 仍只进控制台；(f) ⛔
  无任何自动补发 Claude 的 UI/请求。取假形态——按到达顺序排序 ⇒ (a) 红；退出回填按到达顺序 ⇒ (d) 红。
origin: 人 yale 2026-10-12 授权（Opus 常驻会话，live voice 五句话测试复盘）。证据：journal
  ~/.cloudcli/voice-realtime-log/ef9daacd-9950-414a-acfc-aace142bf273.jsonl
  07:47:30–07:49:25Z +
  voice-realtime-capture/ef9daacd….timeline.jsonl；用户裁定：Realtime
  模型可以不转发部分输入，绝不实现「有转写就自动补发 Claude」，转写晚到本身不是缺陷。
activatedAt: 2026-10-12T08:26:36.701Z
statusLog:
  - at: 2026-10-12T08:26:36.701Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T08:26:36.701Z
---
