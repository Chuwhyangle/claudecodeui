---
id: AC-354
title: 转写与分段按上游 itemId 归属：晚到的转写记到它自己的
  segmentSeq，不污染到达时正在进行的段；提交被拒/上游自建条目诚实标注；向浏览器下发 seq↔itemId
status: active
kind: criterion
goal: GOAL-043
criterion: f=server/modules/voice-realtime/tests/voice-realtime-caption-item-attribution.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --test "$f"
expect: 读数——真 proxy + 真 bridge + scripted fake 上游：(a) 每次提交得到的
  committed/item.created 的 item_id 与该提交的 seq 建立映射；(b) seq N 的条目转写在 seq N+1
  已提交后才到达时，segmentTranscriptEmpty/markSegmentEmpty/held delivery 释放都作用于 seq
  N，seq N+1 不受影响（含空转写晚到的变体：不得把 seq N+1 的真实转发判为空而拒收）；(c) 提交被上游拒（buffer too
  small）的 seq 记为 rejected，不与随后上游 VAD 自建的条目混淆；无法归属的条目记 seq=null，不默认归给 active
  段；(d) 浏览器收到的 caption（或新 segment 帧）带 seq 与 itemId；(e) ⛔ 不新增任何把转写自动投递给 Claude
  的路径：模型未调用 session_send 的转写投递次数恒为 0。取假形态——改回按 activeSegmentSeq 归属 ⇒ (b) 红。既有
  voice-realtime-empty-transcript-guard / segmented-protocol 测试保持绿。
origin: 人 yale 2026-10-12 授权（Opus 常驻会话，live voice 五句话测试复盘）。证据：journal
  ~/.cloudcli/voice-realtime-log/ef9daacd-9950-414a-acfc-aace142bf273.jsonl
  07:47:30–07:49:25Z +
  voice-realtime-capture/ef9daacd….timeline.jsonl；用户裁定：Realtime
activatedAt: 2026-10-12T08:26:36.147Z
statusLog:
  - at: 2026-10-12T08:26:36.147Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T08:26:36.146Z
---
