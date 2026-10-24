---
id: gap-reply-suggestions-draw-cache-no-repeat-llm-calls
title: 回复建议：同一条助手消息只调用一次 LLM；重复打开会话命中缓存，用量日志区分「命中缓存」与「真的调用」
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-24 yale 指出：重复打开同一个会话会多次请求 LLM，是浪费。已读代码确认，且服务端的实际行为比「多花一次调用」更糟。

**现状。**

- 客户端 `src/modules/chat/hooks/useReplySuggestions.ts`：每个「会话加最后助手消息 id」只抽一次，但去重只记在一个 `extractedRef` 里，且会话切换时被清空（约 205 行）。所以刷新页面、或切到别的会话再切回，都会再发一次 `POST /api/reply-suggestions`。
- 服务端 `server/modules/reply-suggestions/reply-suggestions.service.ts`：对同一条消息的第二次非重抽请求，会**再调一次上游模型**（没有任何缓存），再拿新结果与 `state.shown`（已展示的全部 chip）做近似去重，**只返回新增的**，并让抽取序号 `draw` 加一。后果：多花一次钱；用户看到的不是上次那批，过滤后甚至可能是空数组；用量日志里记成又一次展示。

**目标。** 一条助手消息只触发一次首抽；之后的非重抽请求都不调用上游，直接返回当前这一批。只有用户点「建议」（`redraw: true`）才调用模型并换批。

**决定（yale 2026-10-24）。** 缓存**不设过期时间**，只用数量上限；用量日志要区分「命中缓存」与「真的调用」。

**服务端缓存。**

- 键：`会话 id + 最后助手消息 id + 设置的 version`。设置文件改过（`version` 变了，例如换模型、换提示词）时旧缓存自然不再命中。
- 值：最近一次**返回给客户端的那一批** `{chips, draw}`，同时它也是 `state.shown` 里「当前批」的来源，原有的「已展示」记账不变。
- 非重抽、非展开的请求命中缓存：直接返回缓存的 `{chips, draw}`，**不调用上游、不让 `draw` 加一、不占用每分钟与每天的调用额度、不影响熔断计数**。
- `redraw: true`：照旧调用上游，成功后用新一批**替换**缓存。展开请求（带 `seed` 或 `focus` 的 `expand: true`）不读也不写缓存。
- 失败（上游报错、解析不出 chip）与空结果不入缓存，下一次请求重新尝试。
- 上限：最近 200 个键，超出时淘汰最久未使用的；不加时间过期。服务重启后缓存丢失，第一次访问重新抽一次，可以接受。
- 相同键的并发请求仍合并为一次上游调用（沿用现有 `inflight`）。

**用量日志。** 每条 `shown` 记录新增字段 `served`，取值 `"upstream"`（真的调用了模型）或 `"cache"`（命中缓存）。缓存命中时同样写一条 `shown` 记录，`chips` 与 `draw` 取缓存的值；这样既能数出「展示了多少次」，也能数出「真的花了多少次调用」。文档里写明：没有 `served` 字段的旧记录一律视为 `"upstream"`。

**客户端。** 把单个 `extractedRef` 换成按「会话 id + 助手消息 id」记的小表（最近 20 个键，只存浏览器内存），保存每个键最近一批 chip。切走再切回、同页内重新挂载时，直接恢复该批 chip，**不发请求**；刷新页面后才走服务端缓存，仍不调用模型。用户点「建议」得到的新一批要同步更新这张表。

**同步调整离线基准。** `experiments/reply-suggestions-bench/bench.py` 的使用记录回放按 `shown` 行统计批次与点选率；命中缓存的行会让同一批被重复计数。回放要只按 `served` 不是 `"cache"` 的行统计批次（没有该字段的旧记录算作真实调用），并在报告里另外给出「缓存命中次数」与「真实调用次数」。

**范围外**：回合结束后的后台预抽（不做：只会为从不回看的会话花钱）；展开实验的行为；每分钟与每天的上限数值。

## AC

- [ ] 服务端缓存逐腿通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts` 退出码 0（沿用既有文件新增独立用例）：(a) 同一条消息连续两次首抽，上游只被调用一次，两次返回的 `chips` 与 `draw` 完全相同；(b) 第二次命中缓存时 `draw` 不增加、每分钟与每天的计数不增加、熔断的连续失败计数不受影响；(c) `redraw: true` 调用上游并换批，之后的首抽读到的是新批；(d) 助手消息 id 变化时重新调用上游；(e) 设置的 `version` 变化后不再命中旧缓存；(f) 上游失败与空结果不入缓存，下一次请求重新调用；(g) 带 `expand: true` 的请求既不读也不写缓存；(h) 缓存超过 200 个键时淘汰最久未使用的键，被淘汰的键下次重新调用上游，没有任何基于时间的过期；(i) 并发的相同请求仍只调用一次上游。
- [ ] 用量日志区分来源：同一测试文件内新增独立用例：(a) 真的调用时 `shown` 记录带 `served: "upstream"`；(b) 命中缓存时写一条 `shown` 记录，`served: "cache"`，`chips` 与 `draw` 与缓存一致；(c) `usageLog` 为假时两种情形都不写。
- [ ] 路由层不变形：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts` 退出码 0（响应形状 `{chips, draw}` 不变，缓存命中对调用方不可见）。
- [ ] 客户端不再重复请求：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/useReplySuggestions.test.tsx` 退出码 0（沿用既有文件新增独立用例）：(a) 切到另一个会话再切回，不发新的抽取请求，并恢复上次那批 chip；(b) 点「建议」得到新一批后切走再切回，恢复的是新一批；(c) 助手消息 id 变化时再抽一次；(d) 同一会话重新挂载（卸载再挂载）不发请求；(e) 表容量超过 20 个键时最早的键被淘汰，淘汰后再访问重新请求。
- [ ] 离线基准回放：`python3 -I experiments/reply-suggestions-bench/bench.py selftest --only replay` 退出码 0；合成记录里含 `served: "cache"` 的行，断言批次数、点选率只按真实调用的行计算，报告里有「缓存命中次数」与「真实调用次数」；没有 `served` 字段的行按真实调用计。
- [ ] 文档：`grep -c "served" docs/operations/reply-suggestions.md` ≥ 1，说明缓存键、不设过期只设数量上限、`redraw` 与展开不读缓存、旧记录缺 `served` 的读法；`grep -c "served" experiments/reply-suggestions-bench/README.md` ≥ 1。
- [ ] 行为反证：把服务端的缓存命中分支临时去掉，则服务端 (a) 变红；把客户端恢复逻辑临时去掉，则客户端 (a) 变红；恢复后 `git diff` 为空（过程贴在 DoD）。
- [ ] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面读数；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；真页上**不要按 Escape**；测试会话的提示词里写明「不要写代码、不要调用任何工具」，结束后核对没有留下测试产物。

- [ ] 同页来回切换：造两个以提问结尾的会话，在它们之间来回切换 5 次，贴网络请求列表：`POST /api/reply-suggestions` 只有每个会话首次进入时的各 1 次，共 2 次；每次切回时 chip 与上次完全相同（贴截图）。
- [ ] 刷新页面：在其中一个会话里刷新页面，贴网络请求（会有 1 次请求，因为浏览器内存丢失），并贴服务端用量日志的对应行：`served: "cache"`，chip 与刷新前相同。
- [ ] 点「建议」：得到新一批后，切走再切回，贴截图证明恢复的是新一批；用量日志里该次是 `served: "upstream"`。
- [ ] 贴出这次验证产生的用量日志全部 `shown` 行，数出 `served: "upstream"` 与 `served: "cache"` 各多少行，并核对真实网关的调用次数（上游调用数）等于 `upstream` 行数。
- [ ] 在 `docs` 或任务里给出换算：一条助手消息最多 1 次首抽加用户主动重抽的次数，与此前「每次访问 1 次」的对比。
- [ ] 回放一次这次验证产生的真实使用记录，贴出「缓存命中次数」与「真实调用次数」两个读数。

## Touches

- `server/modules/reply-suggestions/reply-suggestions.service.ts`
- `server/modules/reply-suggestions/reply-suggestions-usage-log.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts`
- `docs/operations/reply-suggestions.md`
- `src/modules/chat/hooks/useReplySuggestions.ts`
- `src/modules/chat/tests/useReplySuggestions.test.tsx`
- `experiments/reply-suggestions-bench/bench.py`
- `experiments/reply-suggestions-bench/README.md`
- `tasks/gap-reply-suggestions-draw-cache-no-repeat-llm-calls.md`
