---
id: AC-348
title: changes 的 Quay 来源改为全覆盖紧凑状态索引（task list --json
  --no-body）、非阻塞去重限频的异步加载、bootstrap 只建基线不发事件、cold/warming/stale/ready 明示；修订
  AC-335 (e)
status: achieved
kind: criterion
goal: GOAL-042
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts
  server/modules/mcp-gateway/tests/mcp-changes.test.ts
  server/modules/quay/tests/quay.service.test.ts; do [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json
  --test server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts
  server/modules/mcp-gateway/tests/mcp-changes.test.ts
  server/modules/quay/tests/quay.service.test.ts
expect: 本 AC 修订 AC-335 读数 (e)：原文「不在冷缓存时启动 Quay CLI」改为「changes 绝不同步等待任何 Quay
  CLI、绝不运行完整快照 CLI；可以触发一次非阻塞、去重、每项目最小间隔 60 秒的 task list --json --no-body
  状态索引加载」（外部 Agent 2026-10-12 裁定 E2）。读数（新判据文件
  mcp-changes-quay-index.test.ts）——(a) 全覆盖：30 个任务的夹具里排名第 15 的任务状态迁移，恰好产生 1 个
  quay_task 事件；响应的 sources 条目 coverage 为 full、taskCount 为 30；不再读取
  snapshot.tasks.recent；(b) bootstrap：一个 cursor 第一次见到某项目时 quay_task 事件数为
  0，sources 里该项目 state 为 bootstrap，建立基线；基线之后才出现的新任务产生一条 appeared 事件；(c)
  事件把四种时间分开：transition.from/to、at 取记录的 updatedAt 且 atSource 为
  record.updatedAt、source.observedAt 为索引加载时刻、ageMs 为二者之差；同一次迁移在重复读取时 at
  不变，(kind,ref,at) 去重有效；(d) 非阻塞：索引 cold 时，注入一个永不 resolve 的加载器，changes 仍在 50ms
  内返回，state 为 warming 或 cold，complete 为 false，gaps 带机器可读的 state；用假时钟在 60
  秒内并发与重复调用 20 次，每个项目加载器只被调用 1 次；完整快照 refresh 计数与 synchronizeSessions 计数仍为 0；(e)
  stale：索引超过新鲜度阈值时保留上一份数据继续 diff，state 为 stale，带 observedAt 与 ageMs，complete 为
  false；不再把过期当作「不存在」；(f) 重启或索引清空：cursor 带有某项目基线但服务端索引为空时，不编造任何事件，报告 gap，索引加载完成后按
  cursor 基线 diff，不产生「全部是新任务」的误报；(g) 白名单：isReadOnlyQuayCommand 接受且仅接受新增的
  [task,list,--json,--no-body] 这一条精确参数序列，对追加任何其他 flag
  的变体与写动词一律拒绝（quay.service.test.ts）；(h) mcp-changes.test.ts 的 (e)
  腿按上述修订文本移植：refreshQuay 与 synchronizeSessions 仍为 0，另加「从不 await
  加载器」断言，断言强度不降低；旧字段（cursor、generatedAt、bootId、complete、events、gaps）语义保持兼容，只增字段。取假形态——(i)
  bootstrap 也发事件 ⇒ (b) 必须红；(ii) await 加载器 ⇒ (d) 必须红；(iii) 去掉 60 秒最小间隔 ⇒ (d)
  必须红；(iv) 改回读 recent 前 10 ⇒ (a) 必须红；(v) 过期时返回 null ⇒ (e) 必须红。红先行同 AC-347。
origin: docs/proposals/cloudcli-mcp-control-observability-2026-10.md §11（第五轮）；外部
  Agent 2026-10-12 裁定 E1–E4，同意推进
activatedAt: 2026-10-12T06:52:13.709Z
statusLog:
  - at: 2026-10-12T06:52:13.709Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-12T10:12:51.595Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T06:52:13.709Z
---
