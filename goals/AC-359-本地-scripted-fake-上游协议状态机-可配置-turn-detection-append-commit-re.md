---
id: AC-359
title: 本地 scripted fake 上游协议状态机：可配置 turn_detection，append/commit/response 按状态产生
  committed、空缓冲错误、speech_started、按 itemId 的晚到/乱序/缺失/失败转写、断连与 response.cancel
status: draft
kind: criterion
goal: GOAL-043
criterion: f=server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs
  --test "$f"
expect: '读数（状态机自测，真 ws 客户端打本地假上游）——(a) turn_detection=null：append 后 commit ⇒
  committed + item.created（item_id 单调）；(b) 收到带 server_vad 的 session.update 后：与
  append 同刻的 commit ⇒
  `{type:"error",error:{type:"invalid_request_error",message:"Error committing
  input audio buffer: buffer too small, or have no audio."}}`（与真实上游同形，带 type），随后
  speech_started 并由假上游自建条目；(c) 转写按 itemId 可配置：准时 / 延迟到第 N 次提交之后 / 乱序 / 永不 /
  transcription.failed；(d) response.create 可配置为应答、扣住、在 VAD 进行中被吞；(e)
  response.cancel ⇒ response.cancelled；上游在段中途断开（close/terminate）；(f)
  不带配置时保持既有逐帧脚本 API 与构造函数不变（兄弟 spec 不受影响）。取假形态——忽略 session.update 的
  turn_detection ⇒ (b) 红。回放 spec 新增变体 R：由状态机在 seq0 后的状态注入自然产生空缓冲与
  speech_started（不脚本化错误帧），读出与 2026-10-12 journal 同形的帧序。'
origin: 人 yale 2026-10-12 授权按建议推进「可控、完全本地、不依赖外部 Realtime/Claude 服务的 Live Voice
  验证能力」（Opus 常驻会话只读审查 gap-live-voice-segmented-replay-20261012 落地产物后的建议
  (3)(4)(5)(6)）。
---
