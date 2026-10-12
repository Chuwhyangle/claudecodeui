---
id: AC-370
title: 双断线已知缺陷签名精确到实际值：D1/D2/D4/D5/D6 的签名包含当前代码产生的具体读数（如 D2 的实际 seq
  归属数组），夹具自身出错不得被判为已知缺陷复现
status: draft
kind: criterion
goal: GOAL-043
criterion: for d in D1 D2 D4 D5 D6; do grep -q "test(.$d "
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts
  || { echo "缺用例 $d" >&2; exit 1; }; done; grep -q "D2_SIGNATURE"
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts
  && grep -qE "actual"
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts
  || { echo "签名未带实际值" >&2; exit 1; }; npx tsx --tsconfig server/tsconfig.json
  --test
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts
expect: 读数——(a) D1/D2/D4/D5/D6 的断言失败首行同时包含「期望」与当前代码的「实际值」（例如 D2：实际 captionSeqs
  数组；D4：第几次断线后连接终止；D5：关闭后收到 committed 的 seq 列表；D6：committed 早于上游 committed 的 seq
  与时序），签名精确匹配当前实际值（变化部分用正则）；(b) 取假形态：在场景里人为丢掉一条转写（夹具出错），D2 必须红为 unexpected
  failure signature 而不是按签名通过；对 D4/D5/D6 各有一个同类取假；(c) D3 保持直接断言为绿；(d) 只改测试文件。
origin: Opus 常驻会话 2026-10-13 复核 AC-365 落地代码（提交 5e483a8a）：D2/D4/D5/D6
  的签名是测试作者写的固定断言消息，覆盖了 node assert 的实际值差异输出，任何偏差都得到同一首行 ⇒ 夹具自身出错也会被判为已知缺陷复现，不满足
  AC-357 的签名纪律。
---
