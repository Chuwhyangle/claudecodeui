---
id: AC-363
title: Silence Tail Suppression 真实探针 V-1..V-8：上游 VAD 时间基（音频轴/墙钟）、停传空闲与
  keepalive、尾音截断与前滚、恢复前上游状态、误判、模式关系、STS 与基线的输出时机/usage 等价、上传节省；给出 T/P 推荐值与依据
status: draft
kind: criterion
goal: GOAL-044
criterion: f=docs/operations/voice-realtime-silence-tail-suppression-probe.md; [
  -f "$f" ] || { echo "缺报告：$f" >&2; exit 1; }; for k in "V-1 时间基：" "V-2 停传空闲："
  "V-3 尾音与前滚：" "V-4 恢复前状态：" "V-5 误判：" "V-6 模式关系：" "V-7 等价性：" "V-8 上传节省：" "T 推荐："
  "P 推荐：" "运行次数：" "花费："; do grep -q "^$k" "$f" || { echo "缺读数行：$k" >&2; exit 1;
  }; done
expect: 读数——实验脚本内的 STS 原型（不改产品代码）对真实 qwen3.8-omni-flash-realtime 跑一次：V-1
  用「silence_duration_ms ± 100 ms 后停传 5 s」对照给出时间基结论；V-2 停传 1/5/15/30 min
  后恢复讲话的连接存活与首句延迟；V-7 同一语料 STS 与基线两臂的条目数、speech_stopped 时刻差、response
  数、工具调用、usage（text/audio 分列）；T ∈ {1,2,3} s 与 P 的取值实验；每项附 journal 连接 id
  与事件摘录；T/P 推荐值必须引用读数，读数不足时写「不足以推荐」；每连接 VOICE_REALTIME_MAX_CNY_PER_CONNECTION
  上限，备用端口实例，dry-run 执行面，:3001 pid 前后相同。不设通过门槛。
origin: 人 yale 2026-10-12 提出 Silence Tail Suppression（体验优先候选）；决策文档
  docs/proposals/live-voice-experience-first-decision-2026-10.md §10（提交
  18616927）。
---
