---
id: gap-quay-session-mentions-and-lanes-only-readings
title: Quay 服务端：会话正文提及读数（task/goal 完整 id 及状态）与仅 lanes 的轻读数，供标题栏脉冲条与 popover 取数
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 相关但机制不同：`session-task-chain` 读的是本会话「创建/编辑」过的任务（扫 transcript 里的 `task_write` 工具调用，已有 `GET /api/quay/:projectId/session-task-chain`）；已完成的 Quay tab / cockpit 脉搏条任务读的是项目级时间图。本任务读的是 user/assistant 消息正文里「提到」的 task/goal 完整 id，扫描对象与机制都不同。结论：独立立案；复用 chain 服务已注入的 transcript 读取依赖与按字节偏移增量扫描的思路，不改 chain 服务的行为。

背景与已定决策（用户 2026-10-25 逐项确认）：工作区标题栏（tab 条左侧；窄屏为脉冲条）常驻一个迷你甘特图，点击展开 popover，列出「本会话提到过的 task / goal 及其状态」。本任务只做服务端数据层，界面在后续的客户端任务里做。

语义：
- 「提到」= user / assistant 消息正文里出现 task id 或 goal id 的完整字符串。不含 tool_use / tool_result / thinking，不含非消息行（attachment、queue-operation 等）。
- 扫描全量 transcript，不取「最近 N 条」窗口。依据是 2026-10-24 对本项目最近 250 个会话的实测：96.8% 的会话正文至少提到一个 id；把 tool 块也算进来会多出约 10 倍噪音（18795 对 1812）；只扫最近 20 条会让 12% 的会话列表为空；goal id 在正文里极少出现（32 次，task 为 1190 次），所以 goal 主要经「任务 → AC → goal」反查得到。
- 匹配是闭集精确匹配（大小写不敏感，输出用词表里的规范写法），不做模糊或前缀匹配。词表 = 项目任务全量索引里的 task id ∪ `quay goal list --json` 里 kind=goal 的 id；AC-NNN 不算。本项目 task id 全是小写 kebab、都含 `-`、没有 `.` 与 `_`、最长 85 字符；goal id 形如 `GOAL-049`。

读数一：`GET /api/quay/:projectId/session-mentions?sessionId=<id>`
- 新增 `server/modules/quay/session-mentions.service.ts`（与 `session-task-chain.service.ts` 并列）：纯函数（行 → 正文文本 → 候选 token → 命中）加服务工厂。所有读取依赖注入，与 chain 服务共用 `resolveTranscriptPath / transcriptSize / readTranscriptRange` 这组读取器；不得新增对其它 feature 模块的导入（AC-394 导入环预算不得增长）。
- 增量扫描：每会话记住已消费的字节偏移（落在行边界），transcript 追加时只读新增部分；文件被替换或变小则从 0 重扫；缓存条数有上限。缓存内容不得绑定某一时刻的词表（任务会在对话中途新建，词表随之增长）：缓存「候选 token 的计数与最近出现时间」，每次请求用当前词表查表。候选 token 限定为含 `-` 的 `[A-Za-z0-9][A-Za-z0-9-]*`，避免把全文每个英文单词都缓存下来。
- 切词边界：紧邻反引号、括号、中文标点、句末标点的 id 要命中；`quay://<project>/task/<id>` 里的 id 要命中；词表里只有 `gap-foo` 时，文本里的 `gap-foo-bar` 不得命中它。
- 返回 `{ ok: true, sessionId, projectId, tasks: [{ taskId, title, status, phase, goalId, mentionCount, lastMentionAt }], goals: [{ goalId, title, status, viaTaskCount, mentionedDirectly }], generatedAt }`。`status` 取任务索引；`phase` 取 lanes 读数里该任务在飞区间的相位（无则 null）；`goalId` 经任务的 `goal_ac` → `quay goal list --json` 里该 AC 行的 `goal` 字段；goals = 正文直接提到的 goal ∪ 所列任务所属的 goal。`lastMentionAt` 取命中行 transcript 的 `timestamp`（缺失为 null）。排序确定：tasks 按 lastMentionAt 降序再按 id，goals 按 id。
- 错误约定与 chain 路由一致：缺 sessionId → 400 `session-id-required`；未组装该服务 → 503 `session-mentions-unavailable`；未知项目或会话 → 404 `project-or-session-not-found`。路由只解析入参并转发，逻辑放在服务里。
- 不得为取 `goal_ac` 而加宽 `readTaskIndex` 交给 MCP 网关的行类型：该读数的消费者是 `server/modules/mcp-gateway/mcp-changes.ts` 及其 5 个测试，形状一变就波及 MCP 输出与它们的钉子。`task list --json --no-body` 的行本身带 `goal_ac`，可另取一份，或在不改变对外形状的前提下内部携带。

读数二：`GET /api/quay/:projectId/lanes?hours=<1|3|6|12>`
- 标题栏迷你图要在每个 tab 上常驻，不能为它读整份 snapshot（snapshot 会拉起 driver、任务、goal、ADR、配置检查等多条 CLI）。在 `quay.service.ts` 暴露一个只跑 `quay lanes` 的读取方法，复用它现有的 gantt 读取与按（项目, 窗口）的 TTL 缓存；窗口用现有的 `normalizeGanttWindowHours` 收敛到封闭集 1/3/6/12，缺省 3，非法值回落到缺省；不得另写一份打包算法。
- 返回 `{ ok: true, gantt, ganttUnavailable, generatedAt }`。`gantt` 与 `ganttUnavailable` 的形状及失败语义（`plugin-lacks-lanes-verb`、`lanes-read-failed`）与 `QuaySnapshot` 里的同名字段完全一致。

不做：界面；改 session-task-chain 的行为；改 Quay tab 的窗口持久化（URL 参数 `quayWindow`）；改 MCP 网关。

## AC

- [x] 提取只读正文：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/quay/tests/session-mentions.test.ts` exit 0；其中一组用例用同一份词表，在六种承载里各放一个 id：assistant 的 text 块、user 的字符串内容、assistant 的 tool_use input、user 的 tool_result content、thinking 块、attachment 行；断言只有前两种命中。取假：把 tool 块纳入扫描，这组用例必须红。
- [x] 闭集精确匹配：同一测试文件含用例：词表同时有 `gap-foo` 与 `gap-foo-bar` 而文本只写 `gap-foo-bar`，只命中后者；词表只有 `gap-foo` 而文本写 `gap-foo-bar`，零命中；`GOAL-049` 与 `goal-049` 都命中且输出规范写法；紧邻反引号、中文标点、句末句号的 id 与 `quay://p/task/<id>` 里的 id 命中；`AC-417` 与词表外的 kebab 词不命中。
- [x] 全量与增量：同一测试文件含用例：一份不少于 3000 行的 transcript，唯一一次提及在第 1 行，仍被报出；追加若干行后再次请求，`readTranscriptRange` 收到的 start 大于 0 且等于上次消费到的偏移，计数随之增加；文件被换成更短内容时从 0 重扫；两次请求之间词表新增一个 id，而该 id 早已出现在先前扫描过的文本里，第二次请求报出它。
- [x] 联表：同一测试文件含用例（注入任务索引、goal 列表行与 lanes 读数的桩）：任务 status 取自索引；在飞任务带 phase，非在飞为 null；任务 → `goal_ac` → AC 行 → goal 的反查正确；goals 同时覆盖「只被正文直接提到」「只经任务带出」「两者皆有」，viaTaskCount 与 mentionedDirectly 正确；`goal_ac` 指向不存在的 AC 时 goalId 为 null 而不抛错；排序确定。
- [x] 路由：同一测试文件含用例，经 `createQuayRouter` 挂载：缺 sessionId → 400 `session-id-required`；未注入服务 → 503 `session-mentions-unavailable`；服务返回 null → 404 `project-or-session-not-found`；成功 → 200 且 body 形状符合上文。
- [x] 仅 lanes 的读数：`server/modules/quay/tests/quay.service.test.ts` 新增用例，用记录调用的命令桩：请求该读数只触发一次 `lanes` 命令，不触发 task list、goal list、adr list、driver 状态等命令；同窗口 TTL 内第二次不再 spawn；`hours=7` 与 `hours=abc` 回落到 3；返回的 gantt 与 ganttUnavailable 和同一桩下 `getQuaySnapshot` 对同窗口给出的深度相等；桩返回无 lanes verb 或文档不可读时分别得到 `plugin-lacks-lanes-verb` 与 `lanes-read-failed`。对应的 `GET /:projectId/lanes` 路由用例（200 形状、非法窗口回落）放在 `session-mentions.test.ts` 里。
- [x] MCP 网关不受影响：`git diff --stat -- server/modules/mcp-gateway` 无输出；`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/mcp-gateway/tests/mcp-changes.test.ts server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts server/modules/mcp-gateway/tests/mcp-english-only.test.ts` exit 0。
- [x] 既有读数不被改变：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/quay/tests/quay.service.test.ts server/modules/quay/tests/session-task-chain.test.ts` exit 0，且 `git diff --stat -- server/modules/quay/session-task-chain.service.ts` 无输出。
- [x] 钉子不红：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts server/shared/tests/server-import-cycle-budget.test.ts` exit 0。新增 1 个 server 测试文件会移动覆盖率地板与 unknown 计数钉子：在 `scripts/suite-duration-baseline.tsv` 追加该文件的一行并同步 `quay-test-script.test.ts` 的计数；导入环预算不得增长。
- [x] 类型与静态检查：`npx tsc --noEmit -p server/tsconfig.json` exit 0，且 `npx oxlint server/modules/quay` exit 0。

## DoD

真实读数（后端任务，不需要浏览器）：在隔离实例（`scripts/isolated-instance.sh`；起之前按记忆关掉 residentRestore）里对本项目请求两条路由并贴出 JSON。第一条，`session-mentions` 取三个真实会话：一个人类会话、一个 worker 分发会话（首条 user 消息含 `Task: <id>`）、一个不少于 1000 条消息的长会话。对每个会话另写一个不超过 30 行的独立脚本（放 `tmp/`，不入库）：逐行解析 JSON，只取 user/assistant 的 text，按 `[A-Za-z0-9][A-Za-z0-9-]*` 切词，对同一时刻的 `quay task list --json --no-body` 与 `quay goal list --json` 词表查表，算出 id 集合；贴出两侧集合并确认相等，worker 会话的集合应含它被分发的任务 id。第二条，`lanes?hours=6` 返回的 gantt 与 `snapshot?hours=6` 里的 gantt 深度相等，并贴出一次 lanes 请求期间 `quay` 子进程的证据：只出现一次 `quay lanes`。

## DoD 实测（2026-10-25，隔离实例）

隔离实例：`scripts/isolated-instance.sh start`（worktree 构建的 `dist-server`，port 21707），日志 `resident-restore started=0`（randomRestore 关闭）。

读数一 — `GET /api/quay/b0a96771-c926-468a-bf18-09a5b3708039/session-mentions?sessionId=<id>`：

| 会话 | 类型 | tasks | goals |
| --- | --- | --- | --- |
| `1a7f3e6a-1f86-42df-a778-ea20ff662b1a` | 人类会话（300 行） | 13 | 0 |
| `a21eecb7-c084-43dd-be23-187eabb9f2dd` | worker 分发会话（920 行，首条 user 消息含 `Task: gap-chat-suggestion-chips-share-the-empty-textarea-line`） | 1 | 0 |
| `98c54580-0b24-4b59-819b-286efba8400d` | 长会话（5042 行 / 1643 条 user+assistant 消息） | 15 | 2 |

独立脚本 `tmp/mention-ids.cjs`（30 行，不入库）：逐行解析同一 transcript，只取 user/assistant 的 text，按 `[A-Za-z0-9][A-Za-z0-9-]*` 切词，对同一时刻的 `quay task list --json --no-body`（1096 行）与 `quay goal list --json`（49 条 kind=goal）查表，再补「任务 → `goal_ac` → AC 行 → goal」得到的 goal。两侧集合：

- `1a7f3e6a`：tasks 13 = 13；goals `[]` = `[]` → 相等
- `a21eecb7`：tasks 1 = 1（`gap-chat-suggestion-chips-share-the-empty-textarea-line`，即它被分发的任务 id）；goals `[]` = `[]` → 相等
- `98c54580`：tasks 15 = 15；goals `["goal-045","goal-047"]` = `["goal-045","goal-047"]` → 相等

`98c54580` 的 goal 读数正好覆盖两条来源：`GOAL-045 {viaTaskCount:1, mentionedDirectly:false}`（只经任务带出）、`GOAL-047 {viaTaskCount:0, mentionedDirectly:true}`（只被正文直接提到）。

读数二 — lanes：

- `GET /:projectId/lanes?hours=6` → `{"ok":true,"gantt":{"windowHours":6,"lanes":5,"intervals":11,…},"ganttUnavailable":null,"generatedAt":"…"}`。
- 先取默认窗口 `snapshot` 暖缓存，再取 `lanes?hours=6` 与 `snapshot?hours=6`：两侧 `gantt` 深度相等（`nowMs=1792932396024`，11 intervals，`JSON.stringify` 逐字相同），`ganttUnavailable` 两侧同为 `null`。
- 子进程证据：请求 `lanes?hours=12` 期间以 5ms 间隔采样 `/proc`，唯一命中 `node .../quay/dist/quay.js lanes --json --window-hours 12`（pid 3291966）；同窗口第二次请求命中 TTL，1.6ms 返回且无新子进程。

（`tmp/` 下的脚本与采样日志均不入库。）

## Touches

- server/modules/quay/session-mentions.service.ts (new)
- server/modules/quay/quay.service.ts
- server/modules/quay/quay.routes.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/index.ts
- server/modules/quay/tests/session-mentions.test.ts (new)
- server/modules/quay/tests/quay.service.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-quay-session-mentions-and-lanes-only-readings.md
