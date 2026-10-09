# 语音发起的轮次遇到 `AskUserQuestion` / 权限请求：`approvals_list` 的可观测性读数

**一句话**：在一个**真服务实例**上，一条 **`source:"mcp"`** 的轮次真的停在了一个 `AskUserQuestion` 上，
挂起期间读 `approvals_list`，拿到的原始返回**逐字**给出了「哪个会话在等」「等的是什么问题」「有哪些
选项」——语音层要读它，**现状够用**；唯一缺口不在「读得到」，而在语音桥的 executor 尚未接线（该模块
自己的注释里已登记）。

- 日期：2026-10-09
- 对应任务：`gap-voice-realtime-popup-observability-investigation`（GOAL-031 / AC-313，**只读不阻塞**）
- 性质：**现状调查**。本记录不实现任何语音应答 `AskUserQuestion` 的能力，也不改任何实现代码。

> **这份记录判的是「调查有没有真的做」**：一条 mcp 来源的轮次**真的**触发过一次 `AskUserQuestion`，
> 且读到了 `approvals_list` 在那个状态下的**真实返回**。读数如下，逐字取自运行输出。

## 场景：这条读数是怎么构造出来的

不是推测，也不是对着 stub 断言——链路里除「模型」一环是 mock 端点外，其余**全是出货件**：

1. **起一个真服务实例**：`npx tsx --tsconfig server/tsconfig.json server/index.ts`，临时 `DATABASE_PATH`、
   `HOST=127.0.0.1`、端口 `listen(0)` 探得 `10821`（≠ 3001）、`MCP_ENABLED=1`（`/mcp` 挂载的唯一开关）。
   `HOME`/`CLAUDE_CONFIG_DIR` 都指向临时根。
2. **播种一个带全五 scope 的 PAT**（`cloudcli:read` / `session:send` / `session:create` / `session:control`
   / `approve`），用**独立 node 进程**经仓储函数写进临时库——不经 HTTP 登录。
3. **建会话**：`POST /api/providers/sessions`（provider `claude`）。
4. **打开一条轮次**：经 **MCP 工具 `session_send`**（`Authorization: Bearer <PAT>`）发消息。这一步
   `via:'mcp'`，所以这条轮次的来源被**记录为 `mcp`**——原始返回里 `source` 逐字可核。
5. **让这一轮真的撞上 `AskUserQuestion`**：该轮次的真实 `claude` CLI 被指向一个 mock Anthropic 兼容
   端点。端点只对**体量 > 10 KB 的真 agent 轮**回一个 `AskUserQuestion` 的 `tool_use`（一轮开始时
   CLI 会先发一条 ~4 KB 的预检，按体量挑真轮，见 `scripts/resident-experiment.mjs` 的 E1 注释；同一
   做法见其 E8：mock 端点 + 真 CLI，`AskUserQuestion` 真的到达 `canUseTool`）。交互工具在 provider 里
   `timeoutMs: 0`（无限期挂起），于是这一轮**真的停在审批面上**。
6. **挂起期间读 `approvals_list`**（同一个 MCP 客户端，`session` 参数用上面那个会话 id）。

> 真实链路，不是 mock 自证：被观测的是**出货**的 MCP 网关 + 共享控制面 + claude provider 的审批面；
> mock 只替换了「模型要不要问」这一环，工具调用、挂起、`approvals_list` 的投影全是真的。

探针脚本（一次性，收尾已删除，不入库）：`scripts/zz-voice-popup-probe.mjs`。

## 原始读数（逐字）

### 1. `session_send` 的返回——轮次来源逐字 `mcp`

```json
{"runId":"ae26a818-4998-4203-91a5-fe8926241bed","queued":false,"queuedMessageUuid":null,"source":"mcp"}
```

### 2. `approvals_list` 在那个挂起状态下的**原始返回**

```json
{"approvals":[{"requestId":"982d8392-ef2a-441a-b5d0-1db3b2a69cb6","session":"847e6d1b-3036-46f7-8a33-b29786df7deb","toolName":"AskUserQuestion","inputSummary":"{\"questions\":[{\"question\":\"语音发起的这一轮要执行哪个操作？\",\"header\":\"选择操作\",\"options\":[{\"label\":\"部署\",\"description\":\"把当前分支部署到预发环境\"},{\"label\":\"回滚\",\"description\":\"回滚上一次部署\"}],\"multiSelect\":false}]}","waitedMs":157,"questions":[{"question":"语音发起的这一轮要执行哪个操作？","options":[{"label":"部署","description":"把当前分支部署到预发环境"},{"label":"回滚","description":"回滚上一次部署"}],"header":"选择操作"}]}]}
```

展开（同一个返回，便于阅读）：

```
approvals[0]
  requestId    = 982d8392-ef2a-441a-b5d0-1db3b2a69cb6
  session      = 847e6d1b-3036-46f7-8a33-b29786df7deb
  toolName     = AskUserQuestion
  waitedMs     = 157
  inputSummary = {"questions":[...]}            ← 该工具没有 command/file_path 等标量键，回退成 JSON 串
  questions[0]
    question = 语音发起的这一轮要执行哪个操作？
    header   = 选择操作
    options  = [ { "部署", "把当前分支部署到预发环境" },
                 { "回滚", "回滚上一次部署" } ]
```

### 3. mock 端点收到的三条请求（证明 tool_use 只落在真 agent 轮上）

| # | bytes | lastIsToolResult | hasMarker | 端点回了什么 |
|---|---|---|---|---|
| 1 | 4 051 | false | true | `text`（预检） |
| 2 | 82 383 | false | true | **`tool_use:AskUserQuestion`**（真 agent 轮） |
| 3 | 83 293 | false | true | `text` |

只有第 2 条（真 agent 轮，带完整 system prompt + skills）拿到 `tool_use`，所以上面那个待审批只对应
这一条请求，归属明确。

### 4. `approval_answer` 把这条挂起解除（证明它是活的、可应答的）

```json
{"ok":true,"requestId":"982d8392-ef2a-441a-b5d0-1db3b2a69cb6","decision":"allow"}
```

- 会话：`847e6d1b-3036-46f7-8a33-b29786df7deb`　实例端口：`10821`　临时根：`/tmp/voice-popup-jDJKMf`
- 探针退出码 `0`；读数同时落 `/tmp/voice-popup-jDJKMf/reading.json`（临时根，可能被 TTL 清掉，
  故本记录**内联**引用逐字读数，不依赖它）。

## 回答：语音层去读这个工具，能不能知道「正在等人回答、问题是什么」

**能。** 这一条 `AskUserQuestion` 的返回把三件事都摆出来了：

| 语音层要问的 | 返回里的哪一格 | 值 |
|---|---|---|
| 哪个会话在等？ | `session` | `847e6d1b-…` |
| 在等什么？ | `toolName` = `AskUserQuestion` | 是人机交互工具，不是普通工具 |
| 问题是什么？ | `questions[].question` / `.header` | 「语音发起的这一轮要执行哪个操作？」/「选择操作」 |
| 能怎么答？ | `questions[].options[].label` + `.description` | 部署 / 回滚，各带一句说明 |
| 等了多久？ | `waitedMs` | 157 |
| 怎么应答？ | `requestId` → `approval_answer` | `{ok:true,…,decision:"allow"}` |

也就是说，语音层**不需要**去解析 `inputSummary`（它对这一工具恰好是一段 JSON 串，没有人类可读的标量
键，200 字截断），因为 `questions[]` 已经把问题与选项**逐条展开**了。这正是 `approvals_list` 在
`mcp-approvals.ts` 里为 `AskUserQuestion` 专门做的那件事。

## 现状缺口（只指出，**不实现**）

读数证明「读得到」，但「语音层现在读不读得着」还有两处**接线**缺口，都在实现之外：

1. **语音桥声明了 `approvals_list`，但执行器没人接。** `server/modules/voice-realtime/voice-realtime-tools.ts`
   的六个镜像工具里**已经**有 `approvals_list`（schema 逐字含 `questions` 展开），`function_call` 按工具名
   路由到**注入的** `executor`。但该模块目前**没有任何出货消费者**：`grep -rn "voice-realtime" server/ |
   grep -v "server/modules/voice-realtime/"` 零命中，barrel 自己的注释写着「a later task wires a real
   Realtime client to `connect`」。**所以是声明在、执行器没人接**——缺口是接线，不是可读性。
2. **没有推送面。** 要发现「在等人」，语音层必须**主动**调 `approvals_list`（bridge 不会自动把它推给
   Realtime 模型）。provider 侧确实会发 `permission.required` / `action_required` 事件，但那走聊天 WS，
   不是 Realtime 工具通道。

## 建议

建议现状够用，**不建议现在为 `AskUserQuestion` 的可观测性做任何实现**。`approvals_list` 的返回已经
足以让语音层回答「哪个会话正在等人、问题是什么、有哪些选项、等了多久」；唯一缺口是语音桥的 executor
尚未接线（`connect()` 的消费者还没落地，这是 `voice-realtime` 模块自己注释里已登记的后续任务），它属于
「把桥接上真实 Realtime 客户端」的接线工作，**不是**本调查要补的洞，也不影响 GOAL-031 的退出条件。

## 边界（本任务**没**做什么）

- 未实现任何「语音应答 `AskUserQuestion`」的能力。
- 未改动 `server/modules/mcp-gateway/mcp-approvals.ts`，也未改动任何实现代码。
- 本任务对本分支的唯一改动是**本记录文件**；`tasks/gap-voice-realtime-popup-observability-investigation.md`
  的 AC 勾选由 Provider ABI（`task_write`）单独提交。收尾时 `git diff --name-only develop...HEAD` 逐字
  只有本记录文件一个名字。一次性探针脚本已删除。

## 未解释 / 未验证

- mock 端点按**请求体 + 体量**挑真 agent 轮（照 E8/E1）；这替换的是「真实模型自己想不想问」。**真实
  模型在什么提示下会自己冒出一个 `AskUserQuestion`，本记录没量**——本记录量的是「一旦它冒出来，语音层
  读不读得到」。
- `waitedMs` 是轮询**抓到的瞬时值**（157 ms），不是「用户实际等了多久」；随轮询节奏变化。
- 本记录只量了 `AskUserQuestion`。普通**权限请求**（如 `Write`/`Bash` 在 default 模式下撞墙）在
  `approvals_list` 里 `questions` 缺席、只剩 `inputSummary`（那时它是可读的 `file_path`/`command`）——
  这一格本记录没有单独取数。
