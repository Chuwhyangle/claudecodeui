---
id: AC-334
title: MCP 调用遥测可聚合且不含正文：审计行带错误码、返回字节数与关联标签，只读统计工具按工具、错误码、调用方给出 p50 与 p95
status: draft
kind: criterion
goal: GOAL-040
criterion: for f in server/modules/mcp-gateway/tests/mcp-usage-stats.test.ts
  server/modules/mcp-gateway/tests/mcp-audit.test.ts; do [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json
  --test server/modules/mcp-gateway/tests/mcp-usage-stats.test.ts
  server/modules/mcp-gateway/tests/mcp-audit.test.ts
expect: 读数——(a) 每次调用的审计行新增 error_code（成功为 null，失败为信封里的
  code）、response_bytes（结果序列化后的字节数）与 correlation_id（未提供为 null），迁移只加列、旧行保持可读；(b)
  新只读工具 mcp_usage_stats 输入 since、until、groupBy（tool、error_code、client 之一），输出每组的
  n、ok、error、denied、p50、p95、max 与 bytes 的 p50、p95，分位数用最近秩法并在描述里写明；(c)
  只聚合调用令牌所属用户的行，其他用户的行不计入（夹具造两个用户）；(d) 输出与审计行都不含任何参数正文或返回正文，夹具里带一条标记串的
  session_send，统计结果与审计行中都搜不到该标记串；(e) 需要 cloudcli:read，缺 scope 时报
  INSUFFICIENT_SCOPE。取假形态——让统计跨用户聚合 ⇒ (c) 必须红；把参数原文写进审计 ⇒ (d) 必须红。
origin: docs/proposals/cloudcli-mcp-control-observability-2026-10.md §4 第 1
  阶段；外部 Agent 2026-10-11 暂定裁定 D4、D5、D6。草稿：待契约确认后再激活，不派发
---
