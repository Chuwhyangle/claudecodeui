---
id: gap-live-voice-status-tool
title: 语音面 session_status
  工具（S-B）：模型主动查询全量执行状态（phase/runId/elapsed/排队字节/权限请求/statusSeq），读 G-1
  聚合器同一份读数；含"语音面独有工具"与 AC-2 镜像不变量的处理
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-status-aggregate-and-inject
---
## Proposal

### 现状（2026-10-11 逐文件复核，带 file:line）

**语音模型没有任何"问一句"的工具。** `VOICE_REALTIME_TOOLS` 被 filter 到 `tool.name === 'session_send'`（`server/modules/voice-realtime/voice-realtime-tools.ts:303-305`），所以模型想知道"Claude 现在在跑什么、排了几条"只能靠猜——`891da48b` 里它猜出了 6 次 `MODEL_TEXT_REPLY`。

**全量读数在别处已经存在，不必新造**：MCP gateway 已有 `session_get` / `run_get` / `overview`（18 个工具）能给出 session/run/排队/权限请求的完整读数；`session_get` 的 `pendingInteraction` 形状、`run_get` 的 run 行、`overview` 的 `running/awaitingPermission/aborted` 分桶都在。

**但规范要求读的是 L3 聚合器的同一份读数，而不是各自去翻 CLI**：SPEC §6.3 明写"读的是 L3 聚合的**同一份**状态（§8），避免两处读数打架"，并给出 `statusSeq` 作为同源证明。因此本任务**依赖** `gap-live-voice-status-aggregate-and-inject`（G-1）先建出聚合器与 `statusSeq`。

### ⚠️ 本任务撞上一条既有不变量：语音面必须逐字段镜像 gateway（AC-2）

`voice-realtime-tools.ts` 的 `REALTIME_TOOLS` 被要求与 MCP gateway 的工具描述符**逐字段一致**（`server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 的 AC-2 断言这一点；该文件头部的注释也说明"the other five were never used to good effect … cost about 600 tokens"）。而 `session_status` 是**语音面独有**的工具——gateway 侧今天**没有**对应物。若不处理，本任务落地即违反 AC-2。

**两条合法出路（实现时二选一并写清理由）**：
- **(a) 同时把它加到 gateway**（MCP 侧也有 `session_status` 对任何 MCP 客户端都有用，且镜像规则原样成立）；
- **(b) 把镜像不变量表述为"每个被镜像的工具逐字段一致；语音面独有的工具显式声明为 voice-only"**，并在 AC-2 测试里显式列出这个白名单。
**默认取 (b)**（范围最小、不动 gateway 的对外面），但必须在实现注释与 AC 里写明白名单只有一个成员，使后来者不能再往里塞。

规范全文见 `docs/proposals/voice-realtime-persistent-control-SPEC.md` §6.3 / §8（Draft-2，已合入 develop `ac5c4de5`）与 §16 的 **G-2**。

### SCOPE BOUNDARY

- ⛔ 不做状态**注入**（S-A，那是 G-1）。
- ⛔ 不做浏览器事件流（S-C）。
- ⛔ 不新增中止/回滚类元语（D-2 已裁定：语音面唯一中止元语是 `session_interrupt`）。

<!-- dedup-ref --> 机制去重（立案时实测，2026-10-11）：open 任务对 `session_status` / `状态聚合` 均 0 命中。`task-granularity-advice.js` 报 peers `gap-live-voice-voice-terminated-interrupt`、`gap-mcp-changes-on-demand-event-stream`、`gap-mcp-deploy-freshness-build-sha-health-check`（共触 `server/index.ts` 或语音工具面）——本任务声明 `depends_on` G-1，其余按 Touches 由调度器串行，**keep separate**。

## Plan

1. **描述符**：在 `voice-realtime-tools.ts` 增加 `session_status` 的 `RealtimeToolDescriptor`（`inputSchema` 只需可选的 `session`；`outputSchema` 按 SPEC §6.3 的字段表），并把 `VOICE_REALTIME_TOOLS` 的 filter 从"只留 send"改为"留 send + interrupt + status"（interrupt 由 T2 落地，本任务只加 status）。
2. **执行器**：`voice-realtime-live-executor.ts` 增加 `session_status` 分支，读的是 **G-1 的聚合器**（经新 deps seam 注入，装配点在 `server/index.ts`）。绑定会话语义与 `session_send` 一致（省略 ⇒ 本连接会话；指名单个别的 ⇒ 拒绝）。
3. **镜像不变量**：按上文 (a)/(b) 处理 AC-2；若取 (b)，在 `voice-realtime-bridge.test.ts` 的镜像断言里显式列出"voice-only 白名单 = ['session_status']"。
4. **工具预算**：三个工具的**总描述**必须 ≤ 今日 `session_send` 描述的两倍；超出则退化为"`session_status` 只在模型主动询问时暴露"。实测并记录三个描述的长度。
5. **静态门**：新增服务端测试文件 ⇒ 同步 `quay-test-script.test.ts` 的 `unknown=` 钉子与 `scripts/suite-duration-baseline.tsv`；`npm run typecheck`、`npm run lint`。

## AC

- [x] AC1 工具面（**取假形态，排在判据文件最前**）：`VOICE_REALTIME_TOOLS` 的名字集合恰为 `['session_send','session_interrupt','session_status']`。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-status-tool.test.ts` 退出 0，且**首条断言**即该集合相等。
- [x] AC2 字段完整：`session_status` 返回 SPEC §6.3 的全部字段；`idle`（无 run）时 `runId=null`、`elapsedMs=null`、`queuedItems=0`（给出读数）。
- [x] AC3 **同源**：同一次连接里，`session_status` 返回的 `statusSeq` 与 G-1 注入到上游的状态行里的 `statusSeq` **相等**（两个读数）。
- [x] AC4 会话绑定：指名单个**别的** session ⇒ 拒绝；省略 `session` ⇒ 答本连接会话（两条断言）。
- [x] AC5 镜像不变量：`voice-realtime-bridge.test.ts` 的 AC-2 绿，且"voice-only 白名单"恰含 `session_status` 一项（若取 (b)）；或 gateway 侧已有同名工具且逐字段一致（若取 (a)）。
- [x] AC6 工具预算：三个描述的总长度 ≤ `session_send` 单独长度的 2 倍（给出字节读数）。
- [x] AC7 离线：全程 `apiKey: ''` + scripted fake，**零云端调用**。
- [x] AC8 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

一个**真实对象**被操作过：在真 transport + 真 proxy（scripted fake）下，构造一个**正在跑且已排队若干条**的会话，然后**由模型侧发起一次 `session_status` 调用**，拿到的读数与同一时刻 S-A 注入到上游的状态行**逐字段同源**（`statusSeq` 相等），并给出两侧读数对照；全程零云端调用。⛔ 不做浏览器侧验收（那是 e2e 任务）。

## Touches

- server/modules/voice-realtime/voice-realtime-tools.ts
- server/modules/voice-realtime/voice-realtime-live-executor.ts
- server/modules/voice-realtime/tests/voice-realtime-status-tool.test.ts (new)（本任务判据文件）
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts (the AC-2 mirror assertion)
- server/modules/voice-realtime/tests/realtime-bridge-harness.ts (only if the capture path needs it)
- server/index.ts (executor deps wiring)
- server/shared/tests/quay-test-script.test.ts (only if the collected-file set or the baseline pin moves)
- scripts/suite-duration-baseline.tsv (only if the new test file needs a baseline row)
- tasks/gap-live-voice-status-tool.md (self)
- server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts (widening the voice tool surface adds the eighth executor route, which this file's route-table assertion pins)
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts (the same widened surface: its AC1 set-equality assertion pins the voice tool names)
