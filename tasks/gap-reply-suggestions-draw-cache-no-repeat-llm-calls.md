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

- [x] 服务端缓存逐腿通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts` 退出码 0（沿用既有文件新增独立用例）：(a) 同一条消息连续两次首抽，上游只被调用一次，两次返回的 `chips` 与 `draw` 完全相同；(b) 第二次命中缓存时 `draw` 不增加、每分钟与每天的计数不增加、熔断的连续失败计数不受影响；(c) `redraw: true` 调用上游并换批，之后的首抽读到的是新批；(d) 助手消息 id 变化时重新调用上游；(e) 设置的 `version` 变化后不再命中旧缓存；(f) 上游失败与空结果不入缓存，下一次请求重新调用；(g) 带 `expand: true` 的请求既不读也不写缓存；(h) 缓存超过 200 个键时淘汰最久未使用的键，被淘汰的键下次重新调用上游，没有任何基于时间的过期；(i) 并发的相同请求仍只调用一次上游。
- [x] 用量日志区分来源：同一测试文件内新增独立用例：(a) 真的调用时 `shown` 记录带 `served: "upstream"`；(b) 命中缓存时写一条 `shown` 记录，`served: "cache"`，`chips` 与 `draw` 与缓存一致；(c) `usageLog` 为假时两种情形都不写。
- [x] 路由层不变形：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts` 退出码 0（响应形状 `{chips, draw}` 不变，缓存命中对调用方不可见）。
- [x] 客户端不再重复请求：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/useReplySuggestions.test.tsx` 退出码 0（沿用既有文件新增独立用例）：(a) 切到另一个会话再切回，不发新的抽取请求，并恢复上次那批 chip；(b) 点「建议」得到新一批后切走再切回，恢复的是新一批；(c) 助手消息 id 变化时再抽一次；(d) 同一会话重新挂载（卸载再挂载）不发请求；(e) 表容量超过 20 个键时最早的键被淘汰，淘汰后再访问重新请求。
- [x] 离线基准回放：`python3 -I experiments/reply-suggestions-bench/bench.py selftest --only replay` 退出码 0；合成记录里含 `served: "cache"` 的行，断言批次数、点选率只按真实调用的行计算，报告里有「缓存命中次数」与「真实调用次数」；没有 `served` 字段的行按真实调用计。
- [x] 文档：`grep -c "served" docs/operations/reply-suggestions.md` ≥ 1，说明缓存键、不设过期只设数量上限、`redraw` 与展开不读缓存、旧记录缺 `served` 的读法；`grep -c "served" experiments/reply-suggestions-bench/README.md` ≥ 1。
- [x] 行为反证：把服务端的缓存命中分支临时去掉，则服务端 (a) 变红；把客户端恢复逻辑临时去掉，则客户端 (a) 变红；恢复后 `git diff` 为空（过程贴在 DoD）。
- [x] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面读数；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；真页上**不要按 Escape**；测试会话的提示词里写明「不要写代码、不要调用任何工具」，结束后核对没有留下测试产物。

- [x] 同页来回切换：造两个以提问结尾的会话，在它们之间来回切换 5 次，贴网络请求列表：`POST /api/reply-suggestions` 只有每个会话首次进入时的各 1 次，共 2 次；每次切回时 chip 与上次完全相同（贴截图）。
- [x] 刷新页面：在其中一个会话里刷新页面，贴网络请求（会有 1 次请求，因为浏览器内存丢失），并贴服务端用量日志的对应行：`served: "cache"`，chip 与刷新前相同。
- [x] 点「建议」：得到新一批后，切走再切回，贴截图证明恢复的是新一批；用量日志里该次是 `served: "upstream"`。
- [x] 贴出这次验证产生的用量日志全部 `shown` 行，数出 `served: "upstream"` 与 `served: "cache"` 各多少行，并核对真实网关的调用次数（上游调用数）等于 `upstream` 行数。
- [x] 在 `docs` 或任务里给出换算：一条助手消息最多 1 次首抽加用户主动重抽的次数，与此前「每次访问 1 次」的对比。
- [x] 回放一次这次验证产生的真实使用记录，贴出「缓存命中次数」与「真实调用次数」两个读数。

### 验证证据（2026-10-24，worker 会话）

**隔离实例。** 端口 `3109`，`DATABASE_PATH=<worktree>/tmp/e2e-reply-cache/auth.db`（常驻库的 sqlite backup 副本），`SERVER_SETTINGS_PATH`=`{"residentRestore":{"enabled":false}}`，`REPLY_SUGGESTIONS_SETTINGS_PATH` 是 `~/.config/claudecodeui/reply-suggestions.settings.json` 的副本（真实网关 `http://127.0.0.1:26510/`、`v4.1flash`；`apiKeyFile` 改成绝对路径），`HOME` 指向隔离目录（用量日志因此落在 `tmp/e2e-reply-cache/home/.cloudcli/reply-suggestions-usage.jsonl`，不写常驻日志）。常驻 `:3001`（pid 2465137）全程在听，未重启；`~/.cloudcli/reply-suggestions-usage.jsonl` 的 mtime 仍是 19:36、大小不变。真页用一次性 Playwright（无 MCP 浏览器），从未按 Escape。

**两个会话**（复用既有、以提问结尾的会话，**没有发送任何消息**，因此不需要「不要写代码/不要调用工具」的测试提示词，也没有新增转写或产物）：
- A `6e7c03cd-4a1d-4ffe-acbf-282a93ff3f0c`
- B `c5a57036-de6c-482e-9078-d5572e528ef5`

**1）同页来回切换 5 次。** `POST /api/reply-suggestions` 总数为 2：第一次进 A 1 次、第一次进 B 1 次；A→B→A→B→A→B 的 5 次切换后计数仍为 2，且每次切回 A/B 的 chip 与上一次逐字相同（A 三条、B 三条）。截图：`tmp/e2e-reply-cache/step1-session-a.png`、`step2-switch-1-session-b.png`、`step2-switch-2-session-a.png`、`step2-switch-3-session-b.png`、`step2-switch-4-session-a.png`、`step2-switch-5-session-b.png`。
说明：首次用 Playwright 复现时发现页面在切换会话时会先把**新会话的 message id** 交给 composer、下一帧才更新 session id，这个中间帧被当成「助手又回答了一次」，导致每次切走都给**旧会话**发一次请求。已在 `useReplySuggestions` 里加 `REPLY_SUGGESTIONS_SESSION_SETTLE_MS=120` 的 settle 守卫（message-id 触发的抽取延后一拍，session id 修正后的重跑会取消它），并补了客户端用例 `(f) a conversation switch whose message id arrives one render early draws nothing`。

**2）刷新页面。** 停在 B 刷新：新增 1 次 `POST`（浏览器内存表丢失），响应 `{"chips":[B 的三条],"draw":1}`，与服务端缓存一致；截图为 `step3-after-refresh.png`。用量日志对应行：

`{"at":"2026-10-24T12:18:32.803Z","type":"shown","sessionId":"c5a57036-de6c-482e-9078-d5572e528ef5","draw":1,...,"served":"cache","chips":["不用退回，让它们保持 ready；去核对键盘任务的 Touches 和 fullscreen 任务的 depends_on 是否存进去了","退回那两个 ready 的任务","先核对 Touches 和 depends_on，别动状态"]}`

**3）点「建议」。** B 上新一批两条：`["保持现状态，只查 fullscreen 任务的依赖字段","都不动，先把这轮结果发出去"]`（`draw:2`，`served:"upstream"`）；截图为 `step4-after-suggest.png`。随后切到 A（`step5-suggest-then-away-to-a.png`），再切回 B：POST 计数不再增加，恢复的正是这两条新 chip（`step6-suggest-then-back-to-b.png`）。

**4）本次验证的全部 `shown` 行（共 5 行，3 upstream + 2 cache）：**

1. `{"at":"2026-10-24T12:18:15.291Z","type":"shown","sessionId":"6e7c03cd-...","draw":1,...,"served":"upstream","chips":["先提交这批改动；任务 1、2 保持 ready 不动","先提交改动，再把任务 1、2 退回 todo 过目","都先别动，我再看看"]}`
2. `{"at":"2026-10-24T12:18:18.345Z","type":"shown","sessionId":"c5a57036-...","draw":1,...,"served":"upstream","chips":[B 的三条]}`
3. `{"at":"2026-10-24T12:18:32.803Z","type":"shown","sessionId":"c5a57036-...","draw":1,...,"served":"cache","chips":[同第 2 行]}`（刷新）
4. `{"at":"2026-10-24T12:18:35.717Z","type":"shown","sessionId":"c5a57036-...","draw":2,...,"served":"upstream","chips":[新一批两条]}`
5. `{"at":"2026-10-24T12:18:38.671Z","type":"shown","sessionId":"6e7c03cd-...","draw":1,...,"served":"cache","chips":[同第 1 行]}`（切离 B 后进 A）

计数：`served:"upstream"` = 3，`served:"cache"` = 2。服务端真实上游调用日志（`outcome=ok`）恰好 3 行（12:18:15.290、12:18:18.345、12:18:35.717），即**上游调用数 3 = upstream 行数 3**；两次 cache 命中没有任何上游日志行，也不是补充调用（每次 3/3/2 个 chip 一次成批）。

**5）换算。** 一条助手消息最多 **1 次首抽 + 用户按「建议」的次数** 次上游调用。本次 2 条消息 + 1 次主动重抽 = 3 次调用；同一段操作里页面一共进入会话 9 次（首进 A、5 次切换、刷新、切走再切回），改动前每次进入都会请求并调用一次上游 → 9 次调用；现在 3 次，其中 2 次展示完全免费。服务端逐条消息的记账仍是原有 `state.shown`，没有变化。

**6）回放这次真实使用记录：**

```
$ python3 -I experiments/reply-suggestions-bench/bench.py replay --ledger <隔离 HOME>/.cloudcli/reply-suggestions-usage.jsonl
draws=3 sessions=2 draws_with_chips=3
picked_rate=0.000 (0) redraw_rate=0.333 (1) cleared_rate=0.000 (0)
changed_after_pick=n/a (0/0 comparable, sent_after_pick=0, unresolved=0)
缓存命中次数(cache_hits)=2 真实调用次数(upstream_calls)=3
```

即 3 个真实批次（A draw1、B draw1、B draw2）被计为 draws；2 条 cache 行不进入批次/点选率分母。

**行为反证过程。**
- 服务端：把命中分支临时改成 `if (false && !redraw && !expand)`，`--test-name-pattern "(cache-a)"` 退出码 1，实际读数 `{chips:[], draw:2}` ≠ 期望 `{chips:["a","b","c"], draw:1}`；恢复后文件与提交一致。
- 客户端：临时删掉 extraction effect 里的 `readCachedBatch` 恢复分支，vitest 退出码 1，`(a) switching ... and back restores the batch without a request`、`(b) ... restores the new batch`、`(d) unmounting and remounting ... makes no request` 三条变红；从备份恢复后 `git status`/`git diff` 为空。
- 两次都先 `cp` 备份再恢复，未使用 checkout/stash。

**测试产物核对。** 所有验证物（Playwright 脚本、截图、隔离 DB/home、日志副本）都在 gitignored `tmp/e2e-reply-cache/`；`git status` 无未跟踪/未提交文件（`dist/`、`tmp/` 均被忽略）；没有新增会话、转写或任务之外的文件。

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
