# 会话生命周期统一与 Claude 常驻会话模式 Proposal

*2026-09-25 · 状态：草案，未实施*

## 摘要

本提案做两件事：

1. **统一会话生命周期管理**。新增一个宿主层（session host），统一回答所有 provider（Claude、Codex、Cursor、OpenCode）的三个问题：进程为什么还活着、什么时候关、怎么关。现有的每轮一个进程模式（下称 **per-run**）完整纳入这一层。
2. **给 Claude 增加第二种运行模式：常驻（resident）**。常驻会话的 `claude` 子进程在两轮之间不退出，stdin 一直由服务端握着，用户的每条消息都推进同一个进程。这样 `CronCreate`、`ScheduleWakeup`、`Monitor`、后台 subagent 和跨会话 `SendMessage` 都能跨轮工作，会话也有了稳定的进程地址。

已定原则：

1. 服务重启后常驻进程**不自动恢复**。
2. 常驻会话**默认放开权限**（`bypassPermissions`），以便无人值守时也能运行。
3. 常驻会话**不限数量**，但长期不活动的会话自动关闭。
4. per-run **完整纳入宿主层**。第一步只做包装，不改变任何现有行为。
5. 宿主与会话按 **1:N** 建模：一个宿主进程可以承载多个会话。Claude 始终是 1:1，但 Codex `app-server`、`opencode serve` 这类多路复用进程可以直接接入。
6. 常驻会话忙时（包括无人轮进行中）收到用户消息，行为**与 Claude Code CLI 一致**：服务端不自行排队，也不拒绝，而是立即写入进程输入，这条消息落在哪一轮由 CLI 决定。

per-run 仍是所有 provider 的默认模式，行为不变。

## 背景与实测读数

### 生命周期现在散落在四处

`IProviderRuntime`（`server/shared/interfaces.ts:30`）只有 `run(command, options, writer, context)` 和 `abort(sessionId)` 两个方法，默认把 `run` 的 promise 当作"这一轮"。各 provider 各自维护活跃表，管理层看不到：

| Provider | 活跃表 | 进程形态 |
|---|---|---|
| Claude | `activeSessions`（`claude-runtime.provider.js`） | 每轮一个 SDK `query()`；启动了后台工作时持有 stdin，静默 30 分钟后释放 |
| Codex | `activeCodexSessions`（`codex-runtime.provider.ts`） | SDK 每轮起一个 `codex exec`；`app-server` 只用于 fork，每次操作起一个进程 |
| Cursor | `activeCursorProcesses` | 每轮 spawn `cursor-agent` |
| OpenCode | `activeOpenCodeProcesses` | 每轮 spawn `opencode` |

轮次层已经统一：`chatRunRegistry` 按 app session 记录"是否有 run 在跑"，支持无连接的写入者（定时消息即如此），并按 `seq` 回放。

**Claude 其实已经有"进程比轮次活得长"的第三种状态。** `result` 到达时，客户端已经收到 `complete`；但持有期间 `for await` 循环还在继续，`run()` 的 promise 要等进程退出才结束。这段持有期只存在于 Claude runtime 内部，管理层既列不出来，也无法手动关闭。

### Claude 现在的进程形态

聊天标签页通过 `@anthropic-ai/claude-agent-sdk`（0.3.165）的 `query()` 驱动 `claude` 二进制，`entrypoint` 为 `sdk-ts`。SDK 用的就是全局安装的那个 `claude.exe`（`CLAUDE_CLI_PATH` 未设置，从 PATH 解析）。

`server/modules/providers/list/claude/claude-runtime.provider.js` 的行为：

- 每次 `chat.send` 调用一次 `query()`，也就是起一个新进程。同一会话 12:45:59 起的 pid 3829233，到 14:15 已不在，换成 14:15:32 起的 pid 1290562；peer 名也从 `claudecodeui-a5` 变成 `claudecodeui-a0`。
- 已有"持有 stdin"机制（`createHeldPromptStream` + `scheduleRelease`）。只有这一轮启动了后台工作（`startsBackgroundWork`：`Monitor`、`ScheduleWakeup`、`CronCreate`、`TaskCreate`、`Workflow`、后台 `Bash`、后台 `Agent`）才持有，**静默 30 分钟**（`BG_WAIT_CEILING_MS`）后释放。
- 新的一轮会**顶替**旧的持有（`getSession(...)?.releaseInput?.()`），旧进程退出。

### 这造成的问题

| 能力 | per-run 下的实际行为 | 依据 |
|---|---|---|
| `Monitor` | 可用，在到期前收到通知 | 实测：历史 sdk-ts 会话 46 次调用中 41 次收到通知 |
| `CronCreate` | 预计最多触发一次；周期大于 30 分钟则不触发；用户一说话就丢 | 代码推导，**未实测**；历史转录中 0 次使用 |
| `ScheduleWakeup` 大于 30 分钟 | 预计不触发 | 代码推导，未实测 |
| `SendMessage` 收 | 仅在某一轮运行或持有期间可达；peer 名和 socket 每个进程都变 | 实测：同一会话先后出现 `quay-ac` → `quay-a8` → `quay-8a`，旧 socket `ENOENT` |
| 空闲会话 | 没有进程，不可达 | 实测：`~/.claude/sessions/` 中查不到该 sessionId |

### SDK 提供的能力（`sdk.d.ts`）

- `Query` 控制方法：`interrupt()`、`setPermissionMode()`、`setModel()`、`setMaxThinkingTokens()`、`applyFlagSettings()`、`stopTask()`、`streamInput()`、`close()`。所以改模型、改思考强度**不需要重启进程**。
- `Options.extraArgs`：可透传 `--name` 等 CLI 参数。
- `Options.spawnClaudeCodeProcess`：可自定义进程启动方式，用于把每个常驻进程放进独立 cgroup scope。
- `permissionMode: 'bypassPermissions'` 要求同时设 `allowDangerouslySkipPermissions: true`。

### 控制协议里可直接用的事件与回调（`sdk.d.ts` 0.3.165，2026-09-25 核对）

Remote Control 的 worker 与 SDK 的 `Query` 讲同一套 stream-json 控制协议（依据：对 `claude` 2.1.282 二进制的静态字符串分析，未运行验证）。交互体验的差距来自宿主实现了多少协议，不来自传输。本仓 SDK 类型里已有、而现有 Claude runtime（只按 `assistant`/`result` 分支）没用上的：

| 能力 | SDK 里的形态 | 本方案的用法 |
|---|---|---|
| 会话状态 | system `session_state_changed`，`state: 'idle' \| 'running' \| 'requires_action'`；类型注释称 `idle` 在 heldBackResult 刷出、后台 agent 循环结束后才发，是"authoritative turn-over signal" | 轮次边界与 busy/idle（§7、§8） |
| 后台任务生命周期 | system `task_started` / `task_updated` / `task_progress` / `task_notification`（带 `task_id`、`tool_use_id`、`completed/failed/stopped`） | `background-task` / `monitor` 保活理由（§3、§7） |
| cron 与后台任务的权威清单 | Stop 与 SubagentStop hook 输入里的 `session_crons: SessionCronSummary[]`（`id`、`schedule`、`recurring`、`prompt`；注释写明覆盖 CronCreate、ScheduleWakeup、`/loop`）与 `background_tasks` | 每轮结束时对账 cron 保活理由（§10） |
| 输入来源 | `SDKUserMessage.origin`：`human` / `peer{from,name}` / `task-notification` / `channel` / `coordinator` / `auto-continuation` | 识别无人轮触发类型与跨会话发送方（§8、§15.6） |
| CLI 的输入队列 | `SDKUserMessage.priority: 'now' \| 'next' \| 'later'`；控制请求 `cancel_async_message(message_uuid)` 从 command queue 撤掉尚未出队的消息 | 忙时输入与撤回（§8、§15.7） |
| 需要人回应的请求 | `canUseTool`、`onElicitation`（MCP elicitation）、`request_user_dialog` 回调 | 无人值守拦截面（§9） |
| Ctrl+B | `backgroundTasks(toolUseId?)` | 以后的可选 UI 动作 |
| Remote Control | 只有 settings 里的 `remoteControlAtStartup`、`isolatePeerMachines`；**没有** `Query.remoteControl()` 方法（CLI 2.1.282 的 bundle 里有） | 常驻进程强制隔离（§9） |

SDK 类型落后于 CLI：`scheduled_task_fire`、`side_question`、`peer_message_hold`、`claim_session` 只出现在 CLI 字符串里、SDK 类型里没有。driver 遇到未知 system subtype 必须放过而不报错；这些 subtype 的真实形态由实验 E9 取读数。

### 其他 provider 的长驻潜力

- **Codex**：`codex app-server` 讲 JSON-RPC（`thread/start`、`turn/start`、`turn/interrupt` 加通知流），天然是长驻、一个进程多个 thread 的协议。本仓已用它做 fork（`codex-app-server.client.ts`），但每次操作都起一个新进程。
- **OpenCode**：`opencode serve` 是一个进程承载多个会话的 HTTP 服务。
- **Cursor**：暂无已知的长驻入口。

后两种多路复用形态决定了宿主与会话要按 1:N 建模（原则 5）。

### 外部实测（`orchestration/SPEC-web-session-observability-and-control-2026-08-24.md`，本仓未复核）

- stream-json 形态下，stdin 不关，进程就不退出；静默 15.3 分钟后仍能处理新消息。
- 后台 subagent 可以在轮次结束后异步完成并推送结果。
- `-p` / SDK 进程会注册为可寻址会话，`SendMessage` 送达 25/25。

## 目标

1. 所有 provider 的活跃进程由同一个宿主层管理，共用一套状态机、保活理由、关闭原因和列表接口。
2. per-run 纳入宿主层后，现有行为和测试不变。
3. 常驻会话中，`CronCreate`、`ScheduleWakeup`、`Monitor`、后台任务能跨多轮、跨用户消息持续工作。
4. 常驻会话存活期间有**稳定**的 SendMessage 地址，界面可以复制。⚠️ **2026-09-30 按人 yale 裁定改写**：地址不再由 App 自造，改为**读** Claude Code 自己给进程的派生名，因此不再跨重启固定——见 §12 的修订块。
5. 无人值守触发的轮次（cron、Monitor 通知、跨会话消息）能执行，并出现在聊天记录中。
6. 用户能看到哪些会话在常驻、为什么还活着，并能手动关闭。
7. 长期不活动的常驻会话自动关闭；常驻进程失控时只杀它自己，不连累服务和别的会话。

## 非目标

- 服务重启后恢复常驻进程或其 cron（原则 1）。
- 持久化 cron（把 `CronCreate` 转成 CloudCLI `scheduled-messages`）。需要"持久定时"的用户用现有的定时消息功能。
- 本期**不实现** Codex、Cursor、OpenCode 的常驻模式。但宿主层接口必须能容纳它们（含 1:N 多路复用）。本期它们以 per-run 宿主身份进入统一的宿主列表。
- Shell 标签页（PTY 里的交互式 CLI）本身的行为变化。唯一改动是常驻会话中不提供 Shell 标签页（§12、§15.9）。
- 依赖 Claude Code 自带的 `--bg`/daemon：本机日志显示它一周内因二进制修改时间变化自重启 613 次，最后一次重启失败（`EACCES`），不适合作为基础。另据对 2.1.282 二进制的静态分析：它托管的是 PTY 里的 TUI，对外是终端输出流而不是结构化事件；控制套接字（`/tmp/cc-daemon-<uid>/…/control.sock`）的协议没有文档；它让会话活过宿主重启，与原则 1 相反。
- 以 Remote Control 作为界面或传输：它是连向 Anthropic 后端的出站桥，只能在 claude.ai 上使用；`--sdk-url` 保留给官方 worker 且有主机白名单；要求订阅完整登录、只走 `api.anthropic.com`，与本仓的第三方端点用法互斥。能力矩阵预留 `residentFeatures.remoteControl`，本期恒为 `false`，常驻进程还要强制关闭它（§9）。

## 方案

### 1. 分层

```
L1 轮次层   chatRunRegistry（已有，小改）   run = 一轮；来源 user | scheduled | unattended
L2 宿主层   SessionHostManager（新）        宿主状态机、会话绑定、保活理由、策略、关闭原因、空闲回收、停机
L3 进程层   ProcessContainment（新）        spawn 包装（systemd scope、内存上限）、启动时残留清扫
```

- **L1** 只加两样东西：run 的来源字段，以及由宿主主动开 run 的入口（无人轮用）。前端看到的仍是 run 与 `seq`/replay/`complete`，不需要区分进程形态。
- **L2** 是新增的核心，per-run 和 resident 共用，区别只在策略参数（§3）。
- **L3** 与 provider 无关：Claude 通过 `spawnClaudeCodeProcess` 接入；Codex app-server、cursor、opencode 本来就是自己 spawn 进程，可以直接套用。

L2、L3 放进新模块 `server/modules/session-hosts/`，只通过 `index.ts` 暴露。跨模块共享的类型放 `server/shared/types.ts`，driver 接口放 `server/shared/interfaces.ts`（按 `backend-module-standards`）。

### 2. 宿主模型：ProcessHost 1 — N SessionBinding

```ts
type ProcessHost = {
  hostId: string;
  provider: LLMProvider;
  mode: 'per-run' | 'resident';
  state: HostState;                 // 见 §3
  pid: number | null;
  scopeUnit: string | null;         // L3 的 systemd scope，没有则为 null
  startedAt: number;
  bindings: Map<string, SessionBinding>;   // key = appSessionId
  closeReason: HostCloseReason | null;
};

type SessionBinding = {
  appSessionId: string;
  providerSessionId: string | null;
  state: 'idle' | 'busy';
  leases: HostLease[];              // 见 §3
  lastActivityAt: number;
  peerName: string | null;          // 可寻址时的 SendMessage 地址（2026-09-30 起读自 CLI 注册表，非 App 自造）
  detachReason: HostCloseReason | null;
};
```

- manager 维护两个索引：`hostId → ProcessHost` 和 `appSessionId → hostId`。后者用来强制单写者不变量（§13）。
- **保活理由与空闲判定挂在绑定上**：cron 属于某个会话，而不属于某个进程。**宿主在所有绑定都解除后关闭**。
- 解除绑定具体做什么由 driver 决定。Claude 是 1:1，解除即关闭进程；多路复用的 provider 可以只注销这个 thread 或会话，进程只要还有别的绑定就继续运行。
- 本期所有宿主都只有一个绑定：per-run 每轮一个宿主，Claude resident 每个会话一个宿主。

### 3. 保活理由、策略、状态机与关闭原因

**保活理由**（lease）表示"这个会话为什么还需要宿主"：

```ts
type HostLease =
  | { kind: 'turn'; runId: string }
  | { kind: 'background-task' | 'monitor'; id: string }
  | { kind: 'cron'; id: string; recurring: boolean; expiresAt: number }
  | { kind: 'resident-policy' };        // 常驻本身就是一条永久保活理由
```

保活理由的来源以 CLI 自己的事件与清单为准，不靠工具名推测：`background-task` / `monitor` 由 `task_started` 加、由 `task_notification` 解除（按 `task_id` 对应）；`cron` 由每轮结束时 Stop hook 输入的 `session_crons` **整体覆盖**。driver 拿不到这些数据时（旧版 CLI、hook 未触发）才退回到工具名推测，并在宿主快照里标注该绑定的保活理由为 `inferred`。

**策略**把 per-run 和 resident 表达为同一组参数：

| 参数 | per-run | resident |
|---|---|---|
| `supersedeOnNewTurn`：新的用户轮是否顶替旧宿主 | `true`（现行为） | `false` |
| `closeWhenLeasesEmpty`：没有保活理由时是否立即关闭 | `true` | `false` |
| `quietCeilingMs`：静默多久强制关闭 | 30 分钟（现 `BG_WAIT_CEILING_MS`） | `RESIDENT_IDLE_TIMEOUT`，默认 24 小时 |
| 忙时收到新用户消息 | 由前端排队（现行为） | 立即写入进程（原则 6，§8） |

**宿主状态机**（两种模式共用）：

```
starting → idle ⇄ busy → lingering → closing → closed
                    ↑________|
```

- `busy`：存在 `turn` 保活理由。
- `lingering`：轮次已结束，但还有后台、monitor 或 cron 保活理由。现在 Claude 的"持有 stdin"就是这个状态，**第一次变得可观测**。
- 没有其他保活理由时，resident 停在 `idle`（它还有 `resident-policy`），per-run 则直接进入 `closing`。

**关闭原因**（两种模式共用一个枚举，写入 `closeReason` 或 `detachReason` 并在界面显示）：

| 原因 | 适用 | 触发 |
|---|---|---|
| `turn-complete` | per-run | 一轮结束，且没有保活理由 |
| `released` | per-run | 持有期结束（后台工作已回报，或静默到上限） |
| `superseded` | per-run | 新的一轮顶替了持有中的进程 |
| `aborted` | per-run | 用户停止（per-run 下停止即杀进程） |
| `user` | 两者 | 用户点"关闭常驻进程"，或删除、归档会话 |
| `idle` | resident | 空闲超时（§10） |
| `mode-change` | 两者 | 在两种模式之间切换 |
| `rewind` | resident | 编辑已发送的消息，需要带截断点重启（§13） |
| `exited` | 两者 | 进程自行退出或崩溃，附 `detail`：`oom`、`signal` 或 `error` |
| `server-shutdown` | 两者 | 服务正常停止 |

### 4. Provider driver 接口与默认包装

`IProviderRuntime` 不变，新增一个可选 facet，写法与现有的 `fork?`、`rename?` 一致：

```ts
interface IProviderHostDriver {
  /** 起一个宿主进程；多路复用的 provider 可以返回已有的进程。 */
  startHost(init: HostStartInput, sink: HostEventSink): Promise<HostHandle>;
  /** 在宿主上打开一个会话绑定（Claude：与 startHost 同一动作）。 */
  bind(host: HostHandle, binding: BindInput): Promise<void>;
  /** 用户输入。per-run：等价于现在的 run()；resident：写入进程输入。 */
  submit(host: HostHandle, appSessionId: string, turn: TurnInput): Promise<void>;
  /** 只停当前一轮。per-run 实现为杀进程（现行为）。 */
  interrupt(host: HostHandle, appSessionId: string): Promise<boolean>;
  /** 改模型、思考强度、权限模式；返回立即生效还是下一轮生效。 */
  reconfigure(host: HostHandle, appSessionId: string, patch: HostReconfigure): Promise<'live' | 'next-turn'>;
  unbind(host: HostHandle, appSessionId: string, reason: HostCloseReason): Promise<void>;
  closeHost(host: HostHandle, reason: HostCloseReason): Promise<void>;
}

/** driver 向 manager 上报：轮次开始/结束、保活理由增减、pid、peer 名、进程退出。 */
type HostEventSink = { /* turnStarted, turnEnded, leaseAdded, leaseRemoved, identity, exited */ };
```

`IProvider` 新增 `readonly hostDriver?: IProviderHostDriver`。

**默认包装**（阶段 1a）。没有 `hostDriver` 的 provider，由 manager 用现有的 `run`/`abort` 生成一个 per-run 宿主，**不改任何 runtime 代码**：

- `submit` 调用 `runtime.run()`，宿主进入 `busy`。
- writer 上观测到 `complete` 时，解除 `turn` 保活理由。
- 如果此后 `run()` 的 promise 还没结束，就进入 `lingering`（Claude 的持有期就这样自然显现），等 promise 结束再关闭。
- promise 在 `complete` 之前或同时结束，记为 `turn-complete`；在它之后结束，记为 `released`。
- `interrupt` 调用 `runtime.abort()`，记为 `aborted`；`closeHost` 同样调用 `runtime.abort()`。

这样四个 provider 从第一步起就都出现在统一的宿主列表里。Claude 的顶替和 30 分钟释放仍在它的 runtime 内部完成，manager 只观察结果。到阶段 1b 再实现 Claude per-run driver，把这两项迁入 manager 的策略，并能区分出 `superseded`。

### 5. 能力矩阵

在 `provider-capabilities.service.ts` 中增加以下字段。前端据此渲染，不在组件里按 provider 分支：

```ts
lifecycleModes: ('per-run' | 'resident')[];
multiplexedHost: boolean;            // 一个进程承载多个会话
residentFeatures?: {
  interruptKeepsProcess: boolean;
  liveReconfigure: ('model' | 'effort' | 'permissionMode')[];
  unattendedTurns: boolean;          // cron、wakeup、跨会话消息
  addressable: boolean;              // 有可读的 SendMessage 地址（不承诺跨重启不变，见 §12）
  inputWhileBusy: boolean;           // 忙时输入直达进程（原则 6）
  cancelQueuedInput: boolean;        // 尚未出队的输入可撤回（cancel_async_message）
  authoritativeLeases: boolean;      // 保活理由来自 CLI 的事件与清单，而非推测
  remoteControl: false;              // 预留；本期恒为 false，常驻进程强制关闭（§9）
};
```

| Provider | `lifecycleModes` | `multiplexedHost` | 备注 |
|---|---|---|---|
| Claude | `['per-run', 'resident']` | `false` | `residentFeatures` 已由实验 E1–E8 实测确认（见「阶段 0 结论」）：`{ interruptKeepsProcess: true, liveReconfigure: [], unattendedTurns: true, addressable: true, inputWhileBusy: true }`；`liveReconfigure` 不在 E1–E8 范围内，**待单独验证**。 |
| Codex | `['per-run']` | `false` | 将来接 app-server 时改为两者，`multiplexedHost: true`，`unattendedTurns: false` |
| Cursor | `['per-run']` | `false` | |
| OpenCode | `['per-run']` | `false` | 将来接 `opencode serve` 时可改为两者，`multiplexedHost: true` |

### 6. 模式与数据模型

`sessions` 表新增一列（沿用 `migrations.ts` 的 `addColumnToTableIfNotExists` 写法）：

- `lifecycle_mode TEXT DEFAULT 'per-run'`：取值 `'per-run' | 'resident'`，表示用户对该会话的**偏好**，不代表进程是否存在。写入时按能力矩阵的 `lifecycleModes` 校验，不支持的模式拒绝写入。

宿主、绑定和保活理由都只在内存中，不入库（原则 1 决定了它们没有跨重启的意义）。

入口：新建会话时可以选"常驻"；已有会话可以在会话菜单中"转为常驻"或"关闭常驻模式"。两个入口只对能力矩阵中列出 `resident` 的 provider 显示。关闭常驻模式会先以 `mode-change` 关闭常驻进程。交互细节见 §15。

### 7. Claude 常驻 driver

新文件 `server/modules/providers/list/claude/claude-host-driver.provider.ts` 实现 `IProviderHostDriver`。resident 宿主持有：

- 一个**不结束**的 `AsyncIterable<SDKUserMessage>` 输入队列，作为 `query()` 的 `prompt`；
- 这个 `Query` 对象；
- 一个贯穿进程生命周期的读取循环，通过 `sink` 上报轮次与保活理由：
  - **轮次边界**以 `result` 为准（阶段 0 实测每轮恰有一条）。E9 实测：常驻 stream-json 与 SDK `query()` 两条路**都没有** `session_state_changed`（含 `running → idle` 与 `requires_action`）——它是 remote-io/CCR 路径上的信号，纯 `--print --input-format stream-json` 不提。因此 driver **不要**等这个事件；一轮的开始另有 `system/init`（每轮一条），每条输入排进了哪一轮看 `command_lifecycle` 的 `queued → started → completed`。"等待人回应"不靠 `requires_action` 判定，而是由 §9 的三个入口自己上报（pending 控制请求在场即有人要回应）；
  - **保活理由**按 §3：`task_*` 事件驱动后台任务，Stop hook 的 `session_crons` / `background_tasks` 每轮对账 cron；`startsBackgroundWork` 只作为拿不到事件时的兜底；
  - 未知的 system subtype 放过，不中断读取循环；
- 启动时强制的 flag settings：`remoteControlAtStartup: false`、`isolatePeerMachines: true`（§9），实际生效值写进宿主快照。

与 per-run 的操作差别：

| 操作 | per-run | resident |
|---|---|---|
| `chat.send` | 新建 `query()` | 若已有宿主：写入输入队列；否则先启动 |
| 一轮结束 | `result` 后释放 stdin，进程退出 | `result` 只表示一轮结束，进程继续 |
| 停止当前回答（abort） | 杀掉整个运行 | `query.interrupt()`，进程和 cron 保留 |
| 改模型/思考强度 | 下一轮带新参数 | `setModel()` / `setMaxThinkingTokens()` |
| 改权限模式 | 下一轮带新参数 | `setPermissionMode()`（见 §9） |
| 关闭 | 不适用 | 结束输入队列（stdin EOF），CLI 正常退出；超时后 `close()` |

SDK 选项构建（`mapCliOptionsToSDK` 等）从 `claude-runtime.provider.js` 中抽出，供两种模式共用。

### 8. 轮次、事件通道与忙时输入

<!-- anchor: resident-drain-merge -->

**忙时输入的排空合并（C-4，2026-10-16 实测补记）**：下面「三档都不并入当前轮」说的是**不并进正在跑的那一轮**；被排在它后面的多条 `later` 消息会在当前轮结束后被 CLI **排空合并成同一个 turn**——SPEC §2 的实测帧序里，两条 `later` 共用一个 `init` 与一个 `RESULT`（`RESULT(A) → completed(A) → started(B), started(C) → 一个 init → … → RESULT → completed(B), completed(C)`）。所以「每条各起一个 turn」不成立（SPEC §2 **C-4**）：一个 turn 可以绑定多条投递；这些投递的终态与该合并 turn 的 `RESULT` 的先后也**不固定**（SPEC §2 **C-3**，投递终态只由 lifecycle 驱动、turn 终态只由 `RESULT` 驱动）。

一个常驻进程里会出现两类轮次：

- **用户轮**：由 `chat.send` 写入的消息引起；
- **无人轮**：由 cron 触发、Monitor/后台任务回报或跨会话消息到达引起，没有对应的发送动作，可能也没有浏览器在线。

**轮次归属**：driver 的读取循环按 CLI 输出流中的轮次边界（§7：`session_state_changed`，退回 `result`）上报 `turnStarted`/`turnEnded`，manager 据此在 `chatRunRegistry` 中开、结 run：

- 用户轮的 run 由 `chat.send` 路径打开，来源记为 `user`；
- 无人轮的 run 由 manager 打开，来源记为 `unattended`；定时消息沿用现有来源 `scheduled`。
- 所有 run 沿用 seq、replay、`complete` 语义，前端不需要区分进程形态。无人轮没有连接也照常记录，浏览器连上后可以回放。

**忙时输入（原则 6：与 Claude Code CLI 一致）**：

- 常驻会话 `busy` 时收到 `chat.send`，不论当前是用户轮还是无人轮，服务端都**不返回 `RUN_IN_PROGRESS`，也不自行排队**，而是立即把消息写入进程输入。
- 这条消息是并入当前轮，还是等当前轮结束后另起一轮，由 CLI 决定。服务端只按输出流中实际出现的轮次边界切分 run，并把这条用户消息记进它实际所属的那一轮。
- 前端依据 `residentFeatures.inputWhileBusy` 跳过本地排队，直接发送（§15.7）。per-run 会话的前端排队不变。
- 行为基准是交互式 Claude Code CLI 在同样情况下的表现。实验 E2/E3 要同时记录交互式 CLI 和 SDK stream-json 输入两种形态下的实际行为。**如果两者不一致**，把差异写回本文档，由用户决定：是在服务端补齐到交互式 CLI 的行为，还是接受 stream-json 的行为。
- **实测基准（2026-09-25，E2/E3）**：两种形态**一致**——busy 时推入的用户消息**另起一轮**，不丢、不拒。stream-json 形态与交互式 CLI 形态各读到 2 条真 agent 轮；无人轮进行中推入同样另起一轮（注入后出现 2 条 `result`）。因此 driver 不需要为"并入"写分支，只按 `result` 边界切分即可。原始读数见 `claude-resident-sessions-experiments.md`。人工确认行见该文件（`E2/E3 基准确认：`）。
- **落到协议上**：忙时写入的消息进入 CLI 自己的 command queue。服务端给每条消息分配 uuid，写帧时把它作为 `command_uuid`。**E9 实测**：三档 `now` / `next` / `later` 都被 CLI 收下并进队列（可见形态就是 `command_lifecycle` 的 `queued → started → completed`），区别只在**出队顺序**——`now` 排到 `later` 前面（`now` 在 00:40:07.477 `started`，`later` 在 00:40:07.513），三档**都不并入**当前轮；交互式 CLI 的忙时输入同样落在后一轮（E9 9.8），与 E2/E3 的 stream-json 形态一致。所以写入用"排在当前轮之后"的那一档即可复现交互式行为，要插队才用 `now`。**读数缺口**：`next` 那一档在 E9 里于排队时被撤掉，没读到它自己执行时的落点，故精确归属只定到 `now` 与 `later`（原始读数见记录文件 E9 节）。
- **撤回**：服务端调用 `cancel_async_message(message_uuid)`。E9 实测**三种时机都没有 `control_response` 回来**（仍在队列里 / 已被处理完 / uuid 不存在，读到的都是"无响应"），所以**不能靠控制响应判断撤回是否成功**；判据是 `command_lifecycle` 的 `cancelled`——排队中撤掉的那条确实发出 `state=cancelled`，且它的文本再没出现在任何一轮请求里；已出队的那条毫无反应，即 no-op。界面按 `cancelled` 事件提示"已撤回"，未收到该事件就提示"已开始处理，无法撤回"。
- **无人轮的触发类型**：读用户消息的 `origin`——`peer` 取 `from` / `name` 作发送方，`task-notification` 为后台任务回报。**cron 触发的轮不在其中**：E9 实测它既不新造用户帧、也没有任何 `origin`，也**不**另发 `scheduled_task_fire`；它在流里的唯一形态是一条 CLI 自己造 `command_uuid` 的 `command_lifecycle`（该 uuid 从未 `queued`——宿主的已推 uuid 集合里没有它）。因此 driver 判"这是无人轮"用`command_uuid 不在本宿主已推集合里`，触发类型用 §10 的 Stop hook 清单（`session_crons` 与 `background_tasks`）对账，而不是读 `origin`。`origin` 与 `scheduled_task_fire` 都读不到时显示"非用户触发"。

**兜底**：无人轮同样写进转录文件，现有的转录监听和同步会把它补进会话。实时推送是"尽力而为"，转录才是最终来源。

**通知**：无人轮结束时复用现有的 `notifyBackgroundWorkCompleted`（Web Push），文案按轮次首条输入的 `origin` 区分"定时任务触发""后台任务回报"和"收到跨会话消息"。

### 9. 权限：默认放开

- 常驻进程以 `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` 启动。原因：cron 或跨会话消息触发的轮次，服务端在它开始前无法预知，只有整个进程放开，才能保证无人时不卡住。
- 用户在常驻会话中切换到别的权限模式时，调用 `setPermissionMode()`，**并提示**：切换后，无人轮遇到权限确认会按下一条的规则处理。
- 无人时需要人回应的请求有**三个入口**，全部要拦截，只拦一个的话另外两个会让该轮一直挂起：
  - `canUseTool`：`AskUserQuestion`、`ExitPlanMode`（E8 已证实 bypass 下仍走此回调）；
  - `onElicitation`：MCP 服务器发起的 elicitation。E9 已读到实物：MCP 工具的 `elicitation/create` 被 CLI 转成一条 `control_request`（`subtype: "elicitation"`，带 `mcp_server_name` / `message` / `mode` / `requested_schema`）交给宿主——这个入口确实要接；
  - `request_user_dialog`：CLI 请求宿主弹出对话框。E9 **没触发到**它的入口（工具驱动的阻塞对话框要有对应工具在场），该 subtype 只在 SDK 的类型联合里、实跑没读到，属**读数缺口**——实现时按类型定义接，并在缺实物读数的情况下保守处理（收到即按无人值守策略应答）。
  - `side_question` **不属于**这三个入口，方向相反：上面三个都是 CLI 问宿主（CLI → 宿主的 `control_request`），`side_question` 是宿主问 CLI（宿主 → CLI 的 `control_request`）。E9 实测 CLI 侧认这个 subtype（发出了 `control_request_progress`），但**没有**回 `control_response`（8s 窗口内无响应）。故无人值守**不需要**为它写拒绝分支；它是宿主可主动使用的能力，响应的可用性待补读数（记录文件 E9 9.6）。
  - 若当前没有浏览器连接，或没有用户轮在进行：三个入口一律**自动拒绝或取消**，附一句"当前无人值守，请在下次用户消息中再问"，同时推送通知。普通工具权限请求在 bypass 下不会出现。
  - 有人在线时维持现有弹窗流程，超时（`TOOL_APPROVAL_TIMEOUT_MS`）后按现有逻辑处理。
- 启用常驻时，界面必须明确告知：该会话会以跳过所有权限确认的方式运行。
- **强制关闭 Remote Control 的跨机器可达性**：常驻进程启动时以 flag settings 强制 `remoteControlAtStartup: false`、`isolatePeerMachines: true`，并把实际生效值写进宿主快照。原因：用户的全局 settings 若开了 `remoteControlAtStartup`，一个 bypass 的常驻进程会被桥接到 Anthropic 后端，其他**机器**上的 peer 也能给它发 SendMessage，信任边界就不再是下面写的"同一 Unix 用户"。E9 对"能否压过"**没取到读数**：`get_settings` 这个 subtype 在两条腿上都不返回响应（记录文件 E9 9.7 两处都记"无响应"），本机也没有可用的 Remote Control 后端可比对，因此既没有"压过"的证据也没有"压不过"的证据——`--settings` 写进去的值是否真的赢过用户 settings，**本实验不能作数**。据此**走最保守分支**（不依赖这条读数）：检测到 Remote Control 已开启就拒绝以 bypass 启动常驻进程，并在界面说明。

**风险须写明**：按外部 SPEC §7.3，`<cross-session-message>` 直接进入对方上下文，不经审批。常驻 + bypass 意味着**本机同一 Unix 用户下的任何 Claude 会话都能让这个会话不经确认执行任意命令**。信任边界因此等于"同一 Unix 用户"（前提是上一条的 Remote Control 隔离生效），这一点要在界面和文档里写清楚。

### 10. 常驻的启动、空闲判定与服务重启

**启动**：用户首次在常驻会话中发送消息，或手动点"启动"时，才懒启动。**不在服务启动时自动拉起**。

**空闲判定**（按绑定）：`lastActivityAt` 在任何一轮开始或结束、收到任何流消息、用户发送时更新。**浏览器打开或停留在该会话不算活动**，否则一个忘了关的标签页会让进程永不回收。满足下列全部条件，且持续 `RESIDENT_IDLE_TIMEOUT`（默认 **24 小时**，可配置），即以 `idle` 解除绑定：

1. 绑定状态为 `idle`；
2. 除 `resident-policy` 外，没有 `background-task`、`monitor` 保活理由；
3. 没有未过期的 `cron` 保活理由。

**cron 保活理由按 CLI 的清单对账**：driver 在 SDK 的 `hooks` 选项里注册 Stop 与 SubagentStop 回调，每轮结束时用 hook 输入的 `session_crons`（覆盖 CronCreate、ScheduleWakeup、`/loop`）**整体覆盖**该绑定的 cron 保活理由，用 `background_tasks` 核对后台任务。模型没有显式删除 cron 时也不会误判；状态条能显示真实的 cron 表达式与 prompt。E1 读到的工具回执写明周期任务"Auto-expires after 7 days"，所以 `expiresAt` 仍取创建时间加 7 天作上限。

E9 实测这条清单路径可靠：`claude` 2.1.282 下 **Stop hook 每轮都触发**，`session_crons` 与 `background_tasks` 两个键**每轮都在**（有周期 cron 在场时 `session_crons` 逐次非空且带 `{id, schedule, recurring, prompt}`；有在飞的后台 Bash 时 `background_tasks` 给出 `{id, type, status, description, command}`），cron 无人轮也一样触发。所以只有**旧版 CLI 没有这两个键**时才退回按工具名推测：观察流中的 `CronCreate`（记录 id 与 `recurring`）、`CronDelete` 和一次性任务的触发。推测不准的后果只是多活一段时间或按 7 天上限关闭。周期任务每次触发也会刷新 `lastActivityAt`。

界面**不显示**"即将因空闲关闭"的预告。关闭后会话显示 `idle` 原因，用户下一次发送即重新拉起。

**服务重启**（原则 1）：

- 正常停止时，manager 以 `server-shutdown` 对所有宿主调用 `closeHost`，两种模式都包括：resident 结束输入队列，最多等待 N 秒，超时则 `close()`；per-run 沿用 `abort`。统一接入 `server/index.ts` 的 `shutdownRuntimeServices`。
- 常驻进程放在独立 scope（§11）后会**逃出服务的 cgroup**：服务被杀时它们不会随之被杀，只会因 stdin EOF 退出。为防止 CLI 未及时退出，服务启动时由 L3 **清扫**残留的 `cloudcli-host-*.scope`（`systemctl --user stop`），只清理、不接管。
- 重启后，会话的 `lifecycle_mode` 仍为 `resident`，但进程已不存在，界面显示"常驻进程已随服务重启关闭，定时任务已丢失"。用户下一次发送时重新拉起（`--resume`）。这是用户触发的，不属于自动恢复。

**E5 实测（2026-09-25）：清扫不是可选项。** 扮演服务进程的父进程被 `SIGKILL` 后，常驻 `claude`
**120 秒内没有退出**（不会因 stdin EOF 自行退出），只能被 `kill`。所以上面这条"服务启动时清扫
残留 scope"必须真的实现，L3 的清扫逻辑不能省。E5 那次实验自己也把留下的常驻进程 SIGKILL 掉了
（读数里的 `残留清扫：已由本实验清扫（SIGKILL），无残留`）——每轮实验不留残留进程。

### 11. 资源：不限数量，但要有内存包络（L3）

原则 3 不限数量。但 2026-09-25 的事故说明，不设上限的进程群会把整机拖进换页：负载一度到 4309，OOM 杀了 36 次。所以建议**不限个数，只限内存**：

- L3 提供统一的 spawn 包装：`systemd-run --user --scope --unit=cloudcli-host-<短ID> --slice=cloudcli-resident.slice -p MemoryMax=<单进程上限> -p MemorySwapMax=0`，可复用 `scripts/with-memory-cap.sh` 的思路。Claude 通过 `spawnClaudeCodeProcess` 接入；将来的 Codex app-server、`opencode serve` driver 直接调用同一个包装。
- 本期只对 resident 宿主启用这个包装；per-run 宿主保持现状，是否纳入另行决定。
- `cloudcli-resident.slice` 设一个总的 `MemoryMax`/`MemoryHigh`。超出时，内核只在常驻进程之间选受害者，服务本身和 per-run 会话不受影响。
- 被 OOM 杀掉的宿主显示 `exited`，`detail = oom`（从 journal 或退出信号判断）。
- 没有 systemd 时退化为不包装，并在日志里说明一次。

两个上限的具体数值需要实测后再定（见实验 E7），这里**不给拍脑袋的数**。E7 的**真实模型**一轮实际
观察窗只有 0.10 小时（峰值树 RSS 262532KB，0.10 小时花掉 $1.0836），**远不到 ≥24 小时**，只够说明
"没有分钟级的暴涨"——两个上限的数值**仍未定**，见「阶段 0 结论」的 E7 行。

**待确认**：是否接受"不限个数，但有总内存上限"。如果连总内存上限也不要，常驻进程就只能和服务一样没有保护。

### 12. 身份与寻址

**2026-09-30 重写（人 yale 三条裁定后取 (a)：CloudCLI 不自赋名）。** 本节取代原先「`extraArgs: { name: '<标题 slug>-<会话 ID 前 6 位>' }`」的承诺；那条规则已从产品里整条移除，`residentPeerName` 不再存在。裁定逐字：「冲突是什么？CloudCLI 不要自己加戏就好；不要干扰 Claude Code 的行为。」与同日更早一条：「优先明确 Claude Code 的机制并遵循。在会话名称这方面（尤其是 resident session），把 CloudCLI 看作 Claude Code 的轻量 wrapper。……CloudCLI 中存储的会话名称应看作是 Claude Code 中的会话名称的 cache。」第三条裁定（同日晚，针对 App 侧占位名）逐字：「正常情况下，这个名字应当只显示几秒，然后被 Claude Code 生成的名字换掉。我不指望用这个 derived 收发消息。」⇒ 占位名保留，但必须是过渡态、且永远不得作为地址。

**2026-09-30 修订（本任务 `gap-claude-peer-name-follows-ai-title`）：App 仍不自造名字，但把「会话自己的标题」交回给 Claude Code。** 上一段裁定的是「不要自赋名」，不是「不要交名」：交回的若是 Claude Code 自己已经写下的标题，就没有任何 App 侧的发明，而进程注册名从 `derived`（目录名 + 两个随机字符）升为 `auto`——CLI 专为「采纳来的标题」留的那一档，`user`（有人把名字交给过它）仍然不会被误记。逐字裁决仍是 yale 的那条：「把 CloudCLI 看作 Claude Code 的轻量 wrapper……App 里存的会话名是 Claude Code 会话名的 cache」。

**2026-10-01 修订（本任务 `gap-claude-peer-name-title-guard`）：交出去的必须是会话**真有**的标题；阶梯兜底值一律不交。** 上一条修订把「`getSessionInfo().summary`」写成了交付值，而 `summary` 是 Claude Code 那条阶梯的结果（`customTitle || aiTitle || lastPrompt || summaryHint || firstPrompt`），不是「这个会话有没有标题」的判据：**每个**会话都有 `summary`，最后一档就是首条消息原文。于是一个还没有标题的会话读回来是首条消息，被交出去、被 CLI 落成 `custom-title`，而 `custom-title` 在 App 的档位表里是 `manual`（rank 3）——**高于 `ai`（rank 2）**。后果比不交更坏：本可自愈的 `derived` 占位名被冻结成「首条消息」，Claude Code 之后补上的标题再也压不上来。（2026-10-01 实测：新代码在 :3001 上，某会话跑两轮后注册表 `nameSource: 'auto'`、name = 首条消息原文，App 侧档位 `manual`，而转录里根本没有 `ai-title`。这不罕见——最近 48 小时 CloudCLI 新建 522 个会话，只有 18 个（3%）有 `ai-title`。）交出去的**必须**是这个会话真有的标题：`customTitle` 那一档（SDK 编译为 `customTitle || aiTitle`），即生成标题与人工 `/rename` 都算，阶梯落到首条消息时它是 `undefined`，函数返回 `null` 就等于不传。⚠️ 不要拿 App 自己那列 `transcript_name_source` 当判据：它可能已被覆盖档位（`manual` / `self-assigned`）改写，描述的是本 App 的读数，不是「Claude Code 侧有没有标题」。判据：`server/modules/providers/tests/claude-peer-name-title-guard.test.ts`。

- **交给谁、交什么。** 三条启动路径共用一个读法 `resolveClaudeSessionTitle(providerSessionId, projectPath)`：`getSessionInfo(providerSessionId, { dir: projectPath }).customTitle`——这个会话**真有的**标题（生成标题或 `/rename` 皆可），阶梯只落到首条消息时为 `null` 即不交（见上一段修订）。**绝不**交 App 缓存到会话行上的显示名（`sessionSummary`）——那正是这条修订要拿掉的东西。落点三处：`mapCliOptionsToSDK` 的 `sessionTitle` 选项（被 `queryClaudeSDK` 与 `buildResidentSdkOptions` 共用）、resident 冷启动 `startResidentHost`、以及 per-run host driver 的 `openRun`（该处把包直接交给 `query`，写的是 SDK 自己的 `title` 键）。
- **什么时候交。** **不在创建会话的那一轮交**：SDK 一旦收到 `title` 就完全跳过自己的标题生成，创建轮交名会让会话永远没有标题可采纳（本任务判据的第一条腿量的就是这件事）。从第二轮起交，条件是自限的而不是靠轮次计数器：创建轮正是标题**正在被生成**的那一轮，此刻没有 `customTitle` 可读，自然交不出去；`providerSessionId` 为空（全新的、或 App 从未 resume 过的会话）直接返回，连磁盘都不读。
- **副作用（接受）。** 交名的那次启动会把该标题落成一条 `custom-title`，于是它压过下面那条 `ai-title`。**安全绳**：落下的 `custom-title` 必须与转录里已有的 `ai-title` 逐字节相同——交出去的就是那条标题，所以一旦 App 交的是别的东西，落下的串在会话自己的历史里根本不存在。
- **更正一处被证伪的子命题。** 原计划写「后续 resume 名字冻结在首次采纳值」。实测不是这样：**进程注册名跟着交出去的串走**——同一个会话第二次 resume 交一个不同的标题，注册名就变成那个新串。真正冻结的是 **App 的输入端**：采纳后的标题已被落成 `custom-title`，它压过 `ai-title`，所以 `getSessionInfo().summary` 之后一直返回首次采纳值，每一轮交出去的都还是同一个串。判据里那条 freeze 腿把这条读数的两半分别断死：resume 交 `AC171 Later <tag>` ⇒ ①注册名逐字等于该新串（注册表不冻结）、②转录的 `custom-title` 序列与采纳时**逐元素相同**、新串根本没进阶梯、③此后再读 `getSessionInfo().summary` 仍是首次采纳值（App 输入端冻结，名字因此稳定）。另有一条「交 App 缓存名」的正控制，其注册名确实变成了交出去的 App 名。
- **另一处更正：per-run host driver 不在生产的 per-run 启动路径上。** `ClaudePerRunHostDriver` 的动词只在宿主 `mode !== 'resident'` 时被 resident driver 委派到，而生产的 per-run 派发（`providerRuntimeService.run` → `trackPerRunTurn` → `provider.runtime.run`）根本不经过它。因此「两条启动路径」的实测落点是**运行时的 per-run 派发**与**resident 冷启动**；`openRun` 仍然一并改了（它是声明的落点，且手里确实是一个直接交给 `query` 的包），但它那一半没有生产读数，只有代码上的一致。
- **判据**：`server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts`。九条读数，每条打印 `path=per-run|resident`：新会话首轮不交名且转录里确有 `ai-title`；交名启动的正控制（零次标题生成请求、注册名逐字节等于交出去的串）；第二轮起注册名逐字节等于 `getSessionInfo().summary` 且 `nameSource === 'auto'`；安全绳；交 App 缓存名的控制（安全绳在它身上确实失败）；后续轮名字不动；**冻结腿**（resume 交一个全新标题 ⇒ 注册名跟着动、阶梯不动、`summary` 不动）；resident 冷启动首启 `derived`、重启 `auto`。假形态逐条验过红：首轮交名（腿 1 红）、交 App 缓存名（腿 2 红）、安全绳改成恒真（腿 2c 红）。

- **真服务读数（本任务 DoD，2026-09-30）。** 在 `node dist-server/server/index.js`（本 worktree 自己 build 的产物）上建一个 per-run 会话跑两轮，模型走本机那个真网关。**第一轮**结束：注册表 `name="work-70"`、`nameSource="derived"`，转录里已有 `ai-title`（`"ZZDOD_ROUND_ONE 首轮回复测试"`）⇒ 生成确实没被抑制。**第二轮**结束：`nameSource="auto"`，`name` 与该会话的 `getSessionInfo(sessionId, { dir }).summary` 逐字相等。`ListAgents` 读到的那条注册记录整条打印出来，`name` 就是这个可读标题，不再是 `work-70`。安全绳成立（`custom-title` 与 `ai-title` 同为那一个串），`server.log` 新增地址不匹配行 0 条。**两处偏离要说清**：①端口不是 3001 —— 3001 上跑的是 develop 检出的改前构建，且从会话内部重启它是禁止的，所以读数取自本 worktree 构建的产物、监听 `listen(0)` 探得的端口，其余（隔离的 `DATABASE_PATH`/`HOME`/`CLAUDE_CONFIG_DIR`、`HOST=127.0.0.1`、真模型条目）都是真的；②本机网关的标题生成**不稳定**——同一个脚本、同一段提示词，有一次整轮没落下 `ai-title`（于是第二轮交出去的是首条提示词文本，而非标题），重跑才出现，所以这条读数以「转录里出现 `ai-title`」为重跑前提。附带一条未诊断的观察：同一轮里 App 自己的 `sessions` 行 8 秒后仍是 `transcript_name="Untitled Session"`、`name_source="derived"`，即索引器没在这段窗口内重扫；DoD 第 3 条读的是 `ListAgents`（进程注册表），不依赖这一行，故未再追。
- **真服务读数（本任务 DoD，2026-10-01）。** 同样在 `node dist-server/server/index.js`（本 worktree 自己 build 的产物）、`HOST=127.0.0.1`、`listen(0)` 探得的端口上跑，会话经 App 自己的 HTTP + WebSocket 面建立与驱动（`POST /api/providers/sessions`、`chat.send`），模型走本机真网关。**两条腿都取到了真会话**：①**有标题腿**——某个会话的转录里已有 `ai-title`（`DOD-TITLED-… titled-r1-a1`）之后跑第二轮，活动进程注册表读 `nameSource="auto"`、`name` 与那条 `ai-title` 逐字节相等，App 行 `transcript_name_source="ai"`（证明守卫没有把整条路堵死）；②**无标题腿**——另一个会话首轮消息是 `hi`，跑满两轮后转录里 `ai-title` **0 条**、`custom-title` **0 条**，注册表 `nameSource="derived"`（`workspace-3f`），App 行 `transcript_name_source="derived"` 且 `jsonl_path` 已写（这一行不是空读：索引器确实扫到了这份转录）。**一条本机性质要先量出来**：这台网关的标题生成**看内容**——首条消息 `hi` 不落 `ai-title`，而普通提示词、长提示词、代码块三种都给（3/4 有标题），所以「一个没有 `ai-title` 的会话」在真服务上是可造的，但要先探、不能假定；无标题腿正是用这个形状造的。**两处偏离照旧**：端口不是 3001（3001 是本会话自己的宿主，从会话内部重启它是禁止的）；隔离靠 `HOME` 而不是 `CLAUDE_CONFIG_DIR` —— 服务的会话索引器是按**进程 home** 去解析 `~/.claude` 的，只隔离 `CLAUDE_CONFIG_DIR` 会让服务继续盯着真的 `~/.claude`（实测：那样配置时服务日志里同步的是本会话自己的转录），从而 App 行那条读数永远等不到本次运行的转录、变成空读。
- 常驻启动**不向 CLI 传任何名字**：没有 `--name`，也没有等价的 `extraArgs.name`。理由是逐帧可量的：CLI 的显示阶梯是 `agent-name` > `custom-title` > `ai-title` > 首条消息，而 `--name` **同时**写成 `agent-name` 与 `custom-title` 两条（实测：带 `agent-name` 的转录里 2748/2749 条同时带一条等值的 `custom-title`），落库档位又是 `agent`/`manual` 两档高于 `ai` ⇒ 启动瞬间就钉死一个 App 自造的名字，会话随后挣到的 `ai-title` 再也翻不上来（本机实测：1513/1643 行显示名只来自 35 个自造串）。第二档出路（`--name` 取 Claude Code 已有的名字）同样出局：它仍然钉死名字，仍然改 Claude Code 的行为。
- **地址是读来的，不是算出来的。** 绑定的 `peerName` 取自 Claude Code 自己的进程注册表 `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` 的 `name`；同一记录里的 `sessionId`（用于拒绝 pid 复用带来的陈旧文件）与 `messagingSocketPath`（地址可达的依据）一并校验（`readCliSessionRegistration`，由 `startIdentityReadback` 在每条宿主上读一次，超时读不到就报 `null` 而不是猜）。注册名的 `nameSource` 因此是 `derived`（CLI 自己的派生名），而不是 `user`（有人把名字交给过它）。**实测（2026-09-30，`~/.claude/sessions/*.json`）**：App 起的常驻进程一律 `nameSource: 'derived'`，交名启动（`--name`／`extraArgs.name`）的进程一律 `'user'`。**（本条读数已被上方修订取代其一半）**：会话已有自己的标题时，App 现在把那条标题交回去，注册名随之落 `auto`；`derived` 只剩两种情况——会话还没有标题（它自己的第一轮），以及交名前的历史读数。
- **地址在进程生命周期内固定，但不跨重启固定。** App 里改名只改 Claude Code 侧的会话名（`IProviderSessionRename`，见 §14 与 `## 裁定后的复测` 第 5 条），进程与它的注册名都不动。重启会得到一个新的派生名——那是 Claude Code 自己的派生规则，本提案不再承诺更多；也不再拿上一次的名字当种子（旧实现正是因此每次重启多一截 `-<id6>`，实测形状 `-9959ff-9959ff`）。**代价**：地址不再可预测；`AC-164` 的承诺已随之修订（见 `goals/AC-164-*.md`）。
- **`derived` 名的可达性已实测**（上文「承重假设仍未验证」一句随之作废），这是 (a) 的承重读数：另一个会话向它 `SendMessage`，对方真的产出一轮（`source=unattended`、触发 `cross-session-message`、`chat.subscribe(lastSeq=0)` 完整回放）。判据：`server/modules/providers/tests/claude-resident-addressable.test.ts`。该判据同时带一条**交名启动**的正控制（同一个会话、只改这一处：把名字交给进程 ⇒ 注册表读 `user`、转录里成对写下那个名字），因此「把 `--name` 加回去」的假形态会红在 `derived`→`user`、转录里的自写名、以及地址尾部的 `<id6>` 形状三处。
- 历史读数（E6，仍为真但已不使用）：`-n, --name <name>` 是合法旗标，中文与空格被原样接受（本地转录里 `agent-name` / `custom-title` 与设定值逐字一致）；但该名字**不进** `/v1/messages` 请求体，所以「是否生效」只能读进程自己的记录——(a) 下读的是进程注册表，不是转录。
- 会话菜单新增"复制 SendMessage 地址"，仅当绑定存活且 `addressable` 时可用。地址按上款**读自 Claude Code 的进程注册名**，既不是 App 自造的 `<slug>-<id6>`，也**不是** App 在会话尚无名字时的那个占位名（`buildCloudCliSessionName`，落库为 `derived`）——占位名是显示用的过渡值，Claude Code 自己的标题一到就换掉（2026-09-30 实测约 2 秒），它永远不是地址。人 yale 2026-09-30 补充裁定逐字：「正常情况下，这个名字应当只显示几秒，然后被 Claude Code 生成的名字换掉。我不指望用这个 derived 收发消息。」
- 会话详情显示 pid、peer 名、启动时间、内存（读 scope 的 `memory.current`）、状态和保活理由。这些数据来自统一的宿主接口。
- 在 Shell 标签页执行 `claude --resume` 会让同一会话多出第二个写入者。因此**常驻会话不支持 Shell 标签页**：只按 `lifecycle_mode` 判断，与进程是否存活无关，也不提供强行打开。关闭常驻模式后恢复可用。
- **2026-10-01 修订（本任务 `gap-claude-resident-name-mirror-window-opens-too-late`）：镜像控制帧的开窗时机从「每轮 `result`」提前到「该轮首条流上消息」——生成标题在首轮**进行期间**就已定稿，等 `result` 会把「侧栏显示名」与「可寻址的注册名」的不一致拖满整个首轮。** 改前的窗口挂在 `result` 分支上（`claude-host-driver.provider.ts` 的 `observe`：`if (message?.type !== 'result') return;` 之后才 `scheduleTitleMirror`），故整个回合进行期间一次尝试都不做。实测（本会话就是证人，pid 3822352）：进程 `startedAt` → 注册名由 `derived` 变 `user`（值 = ai-title）晚了 **362 秒**，而那 362 秒里属于「等标题定稿」的是 **0 秒** —— 按判据自身「同值连读两次」的规则，300ms 轮询下再等 600ms 即可；时间全花在等首轮结束。**承重读数（先于实现取，未取到肯定读数前不动产品代码）**：同一个真 claude 进程被 mock 闸在**飞行中**（agent 应答未放行），经 `writeRaw` 写一帧 `rename_session` ⇒ 注册表 `name` 逐字等于该串、`nameSource` 由 `derived` 变 `user`、`nameSince` 前移（`1790863696923` → `1790863697011`，实测）、**pid 与 `startedAt` 均不变**，且该回合仍走到 `result`（`exit=0 aborted=false`）；负控制同窗口不写帧的那条腿仍是 `derived`、名字不动。**改后**：新会话跑一轮、mock 在前把 `ai-title` 落进转录，注册表在**尚未出现任何 `result`**（`completes=0`）时就读到 `name` = 该 `ai-title` 逐字节、`nameSource` 非 `derived`；`nameSince` 前移约 600ms（标题落盘后两次同值读，正好是一个 settle 间隔）。三条不变量（不提前 / 只镜像 / 只发一次）原样保留；**读预算**按「每轮一个窗口」核过 —— 窗口由该轮首条消息开、`open` 闩锁挡住同轮重复开窗（否则忙碌回合会变成「每条消息一次转录读」），`openedForTurn` 在每个 `result` 清掉，于是下一轮在它自己的首条消息再开一个；每轮仍是一个有界窗口（20s、300ms 轮询），与旧的 `result` 开窗同价。判据：`server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts`。
- **2026-10-01 补充（同任务）：改名控制帧的副作用要找住最顶那一档 —— 除 `custom-title` 外还追加一条 `agent-name`。** `gap-claude-resident-name-live-mirror` 的「副作用夹住」只夹了 `custom-title`，**漏了 `agent-name`**（CLI 显示阶梯的顶档 —— 正是当年 `--name` 写进去的那一档，见上上条：`agent-name` > `custom-title` > `ai-title` > 首条消息）。实测（新判据在本机真 claude 上读回）：一次采纳动作落下的转录行是 `customTitles=[<镜像值>]` 与 `agentNames=[<镜像值>]`，各 +1，值都逐字等于镜像值。判据把两者**逐个**夹到逐字等于镜像值，并各加一条「必须至少追加一行」的断言，免得空列表把 `every` 变成恒真。

### 13. 跨模式规则

1. **单写者不变量**：同一个 provider session 在任何时刻最多只有一个绑定。由 manager 的 `appSessionId → hostId` 索引强制执行；从阶段 1b 起，它取代 Claude runtime 内部的 `releaseInput` 顶替逻辑。
   - per-run 转 resident 时，若旧的 per-run 宿主仍在持有期，先以 `superseded` 关闭它。
   - Shell 标签页按 §12 对常驻会话禁用。在 tmux 或外部终端里 `--resume` 仍无法阻止（见风险）。
2. **停止与关闭分开**：
   - `chat.abort` 调用 `interrupt`：per-run 下杀进程（现行为），resident 下只停当前一轮。
   - 新增的关闭动作调用 `unbind(..., 'user')`，只对 resident 开放。
3. **模式切换**：宿主 `busy` 时不切换（前端按 `!isProcessing` 禁用入口，§15.2），本轮结束后才能切换。resident 转回 per-run 时，以 `mode-change` 解除绑定。
4. **编辑已发送消息**（`chat.edit-send`，即 Claude 的 `resumeSessionAt`）：resident 下无法就地回退，只能以 `rewind` 关闭进程，再带截断点重新拉起。cron 和后台任务会丢失，前端必须先确认，确认框列出会丢失的内容（格式同 §15.2）。
5. **分叉出的会话继承源的 `lifecycle_mode`**（2026-10-07 人的裁定取代此条原文「分叉出的会话默认 per-run」，AC-169 判据 (3) 随之作废）：resident 源 fork 出的新会话为 resident，per-run 源 fork 后仍为 per-run。只复制**偏好值**，不拉起进程 —— fork 后没有 host，进程在第一次发送时才起。判据读数见 `server/modules/providers/tests/session-fork.test.ts`（`sourceMode=resident forkedMode=resident hostsStartedByFork=0`）。

### 14. 与现有功能的关系

| 功能 | 处理 |
|---|---|
| 定时消息（`scheduled-messages`） | 常驻会话：`interruptActiveRun` 为真且 busy 时，先 `interrupt()` 再写入输入；否则按 §8 的忙时输入规则直接写入。不重启进程 |
| 分叉会话 | 继承源的 `lifecycle_mode`（2026-10-07 人的裁定取代原「新会话默认 per-run」）：resident 源 → resident fork，per-run 源 → per-run fork；只复制偏好，不拉起进程 |
| 编辑已发送消息 | 常驻会话按 §13 第 4 条处理 |
| 归档/删除 | 先以 `user` 关闭常驻进程 |
| Running sessions 视图 | 改为读统一的宿主接口；分"正在运行"和"常驻（空闲）"两组；侧栏徽标只计正在运行的（§15.8） |
| Shell 标签页 | 常驻会话不提供（§12） |
| `claude.exe` 被替换 | 常驻进程已加载旧版本，不受影响；新启动可能失败，按 `exited` 报告，可以重试 |

### 15. 前端交互

用户只需要回答两个问题：**这个会话是不是常驻的**（偏好，静态标记），和**它的进程现在在不在、为什么**（运行状态，动态）。界面上不出现"per-run"字样：默认模式不加任何标记，只有常驻会话多一个标记。常驻入口按能力矩阵的 `lifecycleModes` 显示（本期只有 Claude）。

#### 15.1 状态的视觉映射

侧栏已用三种信号：绿色脉冲点（活跃）、琥珀点（需要处理）、旋转图标（处理中）。常驻标记**不用点**，而用静态小图标，放在 provider logo 旁、`SessionBranchBadge` 的位置。

| 状态 | 侧栏行 | 会话内状态条 |
|---|---|---|
| 常驻，进程未启动或已关闭 | 空心图标 | `常驻 · 未运行（原因）` + [启动] |
| 常驻，空闲 | 实心图标 | `常驻 · 空闲 · 2 个定时任务 · 1 个监视` |
| 常驻，运行中 | 实心图标 + 现有旋转图标 | 同上，状态为"运行中" |
| `exited` / OOM | 红色图标 | 横幅 + [重新启动] |
| 有未读的无人轮输出 | 沿用现有"最近活跃"点 | — |

状态条上的计数直接来自绑定的保活理由（§3）。不提供"即将因空闲关闭"的预告（§10）。

#### 15.2 开启与告知

- **新建会话**：在 `ProviderSelectionEmptyState` 的 provider/model 卡旁加"常驻"开关，仅对能力矩阵含 `resident` 的 provider 可见。打开开关后**就地展开**告知，不弹窗，内容有两点：该会话会跳过所有权限确认；同一 Unix 用户下的任何 Claude 会话都能不经确认驱动它执行命令（§9）。告知下方是"我了解"勾选框，未勾选时发送按钮禁用。每个常驻会话开启时都要勾选一次。
- **已有会话**：`SessionOptions` 菜单加"转为常驻…"，打开同样内容的告知与勾选框，确认后生效。会话正在处理时禁用该项（与 `canFork` 一样按 `!isProcessing` 判断）。
- **关闭常驻模式**（菜单项文案，即转回 per-run）：若仍有存活的 cron 或未结束的后台工作（按 §10 的清单），确认框**列出会丢失的内容**（如"2 个定时任务、1 个监视将停止"）；没有就直接切换。
- **归档 / 删除**：进程存活时，现有确认框补一句"常驻进程会被关闭，定时任务会丢失"。
- **分叉**：新会话继承源的 `lifecycle_mode`（2026-10-07 人的裁定取代原「默认 per-run」），不需要额外提示 —— resident 源在进入常驻时已经过 §15.2 的知情面，fork 不另加确认流。

#### 15.3 会话内状态条

放在消息区顶部、标题下方，**不放进 composer 底栏**（底栏在移动端已没有余量）。点开为 popover，移动端为 sheet：

```
┌ 常驻 · 空闲 · 2 个定时任务 · 1 个监视 ─────────────── ⌄ ┐
│ SendMessage 地址  fix-login-a1b2c3        [复制]        │
│ pid 1290562 · 启动于 14:15 · 内存 412 MB                │
│ 后台工作                                                  │
│   ⏰ */30 * * * *  "检查构建状态…"  (重启即丢失)         │
│   📡 Monitor     tail build.log                          │
│ 定时消息（持久）  1 条  → 打开                            │
│                               [关闭常驻进程]  (危险样式) │
└──────────────────────────────────────────────────────────┘
```

Claude 自建的 cron 显示 CLI 清单里的表达式与 prompt 摘要，标注"重启即丢失"，与持久的 `scheduled-messages` 分开列出，让用户分清两者。保活理由退回到推测时（§3 的 `inferred`），该行改为"推测存活"。

#### 15.4 停止与关闭分开

- composer 的停止按钮在常驻会话中只调用 `interrupt()`，提示文字为"停止当前回答（进程和定时任务保留）"。
- "关闭常驻进程"是破坏性操作，只出现在状态条 popover 和会话菜单，不出现在 composer。有后台工作时要二次确认。

#### 15.5 权限菜单

复用 `ComposerPermissionMenu` 现有的 `bypassPermissions` 橙色警告样式。常驻会话从 bypass 切到其他模式时，在菜单内就地显示一行"无人值守时的确认请求会被自动拒绝"，不另弹窗。

#### 15.6 无人轮在聊天记录中的呈现

无人轮不能看起来像用户消息。每个无人轮前加一条分隔标签：

- `⏰ 定时任务触发 · 14:00`
- `✉ 来自 quay-ac 的跨会话消息 · 14:03`：正文用独立的气泡样式并**显示发送方**，在界面上落实 §9 的信任边界。
- `📡 监视通知 · build.log`

无人值守时被自动拒绝的请求（§9 的三个入口）显示为卡片："无人值守时已自动拒绝"，附 [现在回答]，点击后把问题带入 composer。

触发类型与发送方读用户消息的 `origin`（§8）。读不到时统一显示"非用户触发"。

#### 15.7 运行中发送

按原则 6，常驻会话（`inputWhileBusy` 为真）运行中发送时：

- **不走** `QueuedMessageCard`。那是前端本地排队，消息还没离开浏览器；常驻会话的消息会立即送进进程。
- 消息立即出现在聊天记录中，状态标注跟随 CLI 的实际行为：E2/E3 实测为另起一轮，所以标"将在当前回答结束后处理"；若 E9 读到某一档 `priority` 会并入当前回答，则按实际写入的那一档标注。不伪装成前端排队。
- 消息在 CLI 队列里尚未出队时，带 [撤回]；撤回调用 `cancel_async_message`（§8）。已出队时 [撤回] 消失，改为"已开始处理"。
- 无人轮进行中发送，规则相同。
- per-run 会话维持现有的 `QueuedMessageCard` 排队。

#### 15.8 Running 视图与侧栏徽标

- 数据来自统一的宿主接口（`GET /api/session-hosts`）。
- 侧栏 Running 徽标的数字**只统计正在运行的会话**，空闲的常驻会话不计入。
- Running 视图分两组："正在运行"和"常驻（空闲）"。第二组每行都有 [关闭]。

#### 15.9 其他入口

- **复制 SendMessage 地址**：放在 `SessionOptions` 中，紧挨现有"复制会话 ID"（`useProviderSessionIdCopy`）。进程不在时该项禁用并写明原因，不隐藏。
- **Shell 标签页**：常驻会话中禁用，提示"常驻会话不支持 Shell，关闭常驻模式后可用"。

## 需要修改的文件

服务端（按 `.agents/skills/backend-module-standards` 执行：新文件用 TypeScript，跨模块只经 `index.ts`）：

- 新增模块 `server/modules/session-hosts/`：
  - `index.ts`
  - `session-host-manager.service.ts`（L2：宿主表、绑定、保活理由、策略、默认包装、空闲回收、停机）
  - `process-containment.service.ts`（L3：scope 包装与启动清扫）
  - `session-hosts.routes.ts`
  - `tests/`
- `server/shared/interfaces.ts`：新增 `IProviderHostDriver`；`IProvider` 增加可选的 `hostDriver`。
- `server/shared/types.ts`：`HostState`、`HostLease`、`HostCloseReason`、`LifecyclePolicy`、`HostSnapshot` 等共享类型（按分组注释格式）。
- `server/modules/providers/list/claude/claude-runtime.provider.js`：抽出 SDK 选项构建，供两种模式共用；阶段 1b 把顶替与持有交给 manager。per-run 行为不变。
- 新增 `server/modules/providers/list/claude/claude-host-driver.provider.ts`：§7 的 driver。
- `server/modules/providers/list/claude/claude.provider.ts`：挂上 `hostDriver`。
- `server/modules/providers/services/provider-capabilities.service.ts`：§5 的字段。
- `server/modules/providers/services/provider-runtime.service.ts`：`run`/`abort` 改为经 manager 分派。
- `server/modules/websocket/services/chat-websocket.service.ts`：`chat.send`/`chat.abort` 经 manager；resident 忙时输入不再返回 `RUN_IN_PROGRESS`。
- `server/modules/websocket/services/chat-run-registry.service.ts`：run 来源字段；manager 开 run 的入口；resident 下由轮次边界决定 run 起止。
- `server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts`：常驻会话的投递路径。
- `server/modules/database/migrations.ts`、`schema.ts`、sessions 仓储：新增 `lifecycle_mode` 列。
- `server/index.ts`：停机时调用 manager；启动时调用 L3 清扫。
- REST 接口：
  - `GET /api/session-hosts`：列表，含 provider、模式、状态、绑定、保活理由、pid、内存、关闭原因；
  - `POST /api/session-hosts/:sessionId/start`；
  - `POST /api/session-hosts/:sessionId/close`。

前端（§15，按 `.agents/skills/frontend-module-standards` 放入对应模块）：

- `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx`：常驻开关、就地告知与勾选框。
- `src/modules/chat/`：
  - 会话内状态条与 popover；
  - 无人轮分隔标签、跨会话消息气泡、自动拒绝卡片；
  - 停止按钮文案；
  - `composer/ComposerPermissionMenu.tsx` 的切换提示；
  - `hooks/useChatComposerState.ts`：`inputWhileBusy` 时跳过本地排队（§15.7）。
- `src/modules/sidebar/SidebarSessionItem.tsx`：常驻图标及其状态。
- `src/modules/sidebar/SessionOptions.tsx`：转为常驻 / 关闭常驻模式、复制 SendMessage 地址、关闭常驻进程。
- `src/modules/sidebar/SidebarHeader.tsx` 与 Running 视图：改读宿主接口；徽标只计正在运行的会话；列表分两组。
- `src/modules/project-workspace/WorkspaceTabs.tsx`：常驻会话禁用 Shell 标签页。

文档：

- `server/modules/providers/README.md`：新增 `hostDriver` facet 说明，以及"如何接入常驻"。
- `docs/architecture/03-conversation-handoff.md`：补充宿主层，以及"一个进程多轮""一个进程多会话"的身份与轮次模型。
- `docs/operations/process-isolation-and-memory-caps.md`：补充常驻 slice 与清扫。

## 验证方法

### 阶段 0：实验（实施常驻前必须先做）

用一次性的临时实例，**显式指定临时 `DATABASE_PATH`**（本机 shell 已导出 `DATABASE_PATH`，指向真实库），用 SDK 最小脚本驱动，不碰生产会话。

| 编号 | 问题 | 通过条件 |
|---|---|---|
| E1 | 常驻输入下 `CronCreate` 是否按时触发，触发轮是否出现在输出流 | 1 分钟一次性任务按时触发；周期任务连续触发 ≥3 次 |
| E2 | 进程 busy 时推入用户消息，是并入当前轮还是另起一轮；**交互式 CLI 在同样情况下怎么做** | 两种输入形态的行为都有记录。一致，则直接作为 §8、§15.7 的基准；不一致，则写回差异，交由用户决定 |
| E3 | 无人轮（cron 触发、跨会话 `SendMessage`）进行中推入用户消息；busy 时跨会话消息到达 | 不丢失；记录并入或排队的方式，并与交互式 CLI 对照 |
| E4 | `interrupt()` 后进程与 cron 是否仍存活 | 进程存活，cron 继续触发 |
| E5 | 服务进程被 kill 后，常驻进程是否因 EOF 退出；多久退出 | 进程在 N 秒内退出；否则清扫逻辑是必需的 |
| E6 | `extraArgs.name` 是否生效，是否接受中文和空格 | peer 名等于设置值 |
| E7 | 长驻内存增长 | 至少 24 小时浸泡，记录 RSS 曲线，以此确定 §11 的数值 |
| E8 | `bypassPermissions` 下 `AskUserQuestion` 走不走 `canUseTool` | 能在回调中拦截 |
| E9 | 控制协议清单（2026-09-25 追加，依据对 CLI 二进制与 `sdk.d.ts` 的核对）：常驻 stream-json 下 `session_state_changed` 相对 `result` 的时序；`task_started` / `task_notification` 是否覆盖 Monitor、后台 Bash、后台 Agent；Stop hook 输入的 `session_crons` / `background_tasks` 是否每轮都有值；cron 触发、Monitor 回报、跨会话消息各自的 `origin`，以及是否出现 `scheduled_task_fire`；`priority` 三档各落在哪一轮、交互式 CLI 用哪一档；`cancel_async_message` 在出队前后的效果；`onElicitation`、`request_user_dialog`、`side_question` 的实际入口；flag settings 能否压过用户 settings 关掉 `remoteControlAtStartup` 并开启 `isolatePeerMachines` | 每项都有原始读数；§7、§8、§9、§10 里原先待 E9 定的四处已按读数定稿（结论见下表 E9 行） |

实验会真实调用模型，产生费用。

### 阶段 0 结论（2026-09-25 E1–E8 实测 `claude` 2.1.282；2026-09-26 E9 实测 `claude` 2.1.283）

原始读数（pid、时间戳、消息类型序列、RSS 样本）逐节写在
`docs/proposals/claude-resident-sessions-experiments.md`，`node scripts/resident-experiment.mjs
--check-record` 可校验九节齐全（E1–E9）。实验脚本是 `scripts/resident-experiment.mjs`，护栏测试是
`scripts/resident-experiment.test.mjs`。逐条结论：

| 编号 | 结论 | 对文档的影响 |
|---|---|---|
| E1 | **成立**。常驻进程里 `CronCreate` 被接受（工具返回 `Scheduled recurring job … Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days.`），330s 窗口内按分钟面连续触发 **5** 次（要求 ≥3），每次都作为一次独立的无人轮出现在输出流里（多一条 `result`）。 | §10 的"cron 保活理由是推测出来的"成立；§8 的无人轮定义成立。 |
| E2 | **两种形态一致：都另起一轮**。stream-json 形态：一轮进行中推入第二条用户消息，出现 2 个 `result`。交互式 CLI 形态读数见记录文件。 | §8、§15.7 的基准填"另起一轮"，**不是**"并入当前回答"。 |
| E3 | **不丢失，且另起一轮**。无人轮（cron 触发）进行中推入用户消息：2 条用户消息 + 1 次无人轮共产生 3 个 `result`，说明插入的消息既没被拒，也没并进正在跑的那一轮。 | §8 忙时输入规则成立；§15.7 的文案按"另起一轮"写。 |
| E4 | **成立**。`interrupt()` 后同一 pid（如 `3849730`）仍存活，cron 从 1 次继续涨到 2 次——`interrupt()` 只停当前这一轮。 | §7 的 `interrupt()`／§15.4 的"停止"语义成立。 |
| E5 | **必须清扫**。扮演服务进程的子进程被 `SIGKILL` 后，常驻 `claude` 进程 **120s 内没有退出**（不会因 stdin EOF 自行退出）。 | §10 的服务重启清扫不是可选项；L3 清扫必须实现。注意：这个不退出的进程要由清扫逻辑**真的 kill 掉**，否则每轮实验都会在机器上留一个常驻进程（本实验自己也收尾清扫了）。 |
| E6 | **成立，且中文与空格被原样接受**。`-n, --name <name>` 是合法旗标；`extraArgs.name` 的值出现在**本地转录**里，`agent-name` 与 `custom-title` 均与设定值逐字一致（含 `实验会话 中文 空格`）。 | §12 的 `extraArgs.name` 方案可照原样落地。**判定通道要注意**：这个名字不进 `/v1/messages` 请求体，用 mock 端点看请求体是**看不出来**的——driver 若要读取 peer 名，读转录（`<configDir>/projects/<slug>/<session>.jsonl` 里的 `agent-name` 记录），不要读请求体。 |
| E7 | **未达标（阻塞项）**。**真实模型**下观察窗 **0.10 小时**，远不到 ≥24 小时；峰值树 RSS 262532KB；0.10 小时花掉 $1.0836（input 29080 / output 11964 / cache_read 300928 tokens），期间 1 次 cron 无人轮。只够说明"分钟级没有暴涨"，**不足以**定 §11 的两个上限数值。 | §11 的"不给拍脑袋的数"仍然成立——数值待一次真正的 24 小时浸泡。 |
| E8 | **成立**。`bypassPermissions` 下 `AskUserQuestion` 仍然走 `canUseTool`（被调用 1 次），可以在回调里拦截并自动拒绝。 | §9 的无人值守处理（自动拒绝 `AskUserQuestion`/`ExitPlanMode`）可实现。 |
| E9 | **九项都有原始读数，两处缺口如实记下**。9.1 轮次边界：raw 驱动与 SDK `query()` 两条路都**没有** `session_state_changed`（各 0 条），可用把手是「每轮一条 `system/init` + 轮末一条 `result`」。9.2 忙时队列：三档 `now`/`next`/`later` 都进 `command_lifecycle` 队列（`queued → started → completed`），`now` 出队排在 `later` 之前，三档都不并入当前轮；`cancel_async_message` 三种时机**都没有 `control_response`**，但排队中撤掉的那条确实发 `state=cancelled` 且文本再没进任何一轮请求。9.3 后台工作：读到 `task_started` / `task_notification` / `background_tasks_changed`；工具表里**没有 Monitor**、有 ScheduleWakeup。9.4/9.5 cron 无人轮：既不新造 `user` 帧也没有 `origin`、**没有** `scheduled_task_fire`，唯一形态是 CLI 自造 `command_uuid` 的 `command_lifecycle`；Stop hook 2 次调用里 `session_crons` 2 次非空、`background_tasks` 1 次非空。9.6 人工入口：`elicitation` 读到 1 条实体控制请求；`side_question` 方向相反（宿主问 CLI）且无响应；`request_user_dialog` 没触发到。9.7 flag settings：`get_settings` 无响应，**没读到**"能否压过"，故走最保守分支。9.8 交互式忙时：第二条消息落在后一轮，与 stream-json 形态一致。**缺口**：`next` 档执行时的落点、`request_user_dialog` 的实物，都待补读数。 | §7 轮次边界改以 `result` / `system/init` 为准（**不要**等 `session_state_changed`）；§8 忙时输入按"排队不并入"落地、撤回判据改用 `cancelled` 事件而不是控制响应；§9 `onElicitation` 确认要接、`side_question` 移出"要拦的三个入口"、Remote Control 走最保守分支；§10 Stop hook 的 `session_crons` / `background_tasks` 确认为权威清单。 |

补充两条实测细节，写驱动的人必须知道：

1. **一轮开始时会发两条 `/v1/messages` 请求**：一条 ~2KB 的预检（也带 `tools`、也带用户文本），
   一条 ~77KB 的真 agent 轮（完整 system prompt + skills 前导）。**按序号或按"请求里有没有用户
   文本"去识别这一轮，都会识别错**——实验中把 `tool_use` 发给预检那条时，回复被丢弃，那一轮
   拿到别处的文本就结束了，读数长得像"CronCreate 不触发"，其实是工具从没被创建。要按**请求体
   体量**挑（真轮 >10KB）。
2. **每轮以正好一条 `result` 结束**（`subtype: success/error`）。数轮次就数 `result`；不要用
   "最新一条消息里有没有某个标记"来数触发——cron 推入的那一轮里，标记同时出现在历史
   （`tool_use` 的入参）和最新消息里，会数错。

`residentFeatures` 按 E1–E8 可填的项（`liveReconfigure` 不在本轮实验范围内，**留空待验**）：

```ts
residentFeatures: {
  interruptKeepsProcess: true,   // E4
  liveReconfigure: [],          // 未被 E1–E8 覆盖，需单独验证
  unattendedTurns: true,        // E1、E3
  addressable: true,            // E6
  inputWhileBusy: true,         // E2
}
```

⚠️ **本节结论仍未过人工关卡**：E2/E3 的基准（忙时推入用户消息 = 另起一轮）还等着人签字；记录文件
`docs/proposals/claude-resident-sessions-experiments.md` 里以 `E2/E3 基准确认：` 开头的那一行**只能由
人（yale）写**，执行者不得代写。加上 E7 的 ≥24 小时浸泡尚未达标，任务 `gap-claude-resident-phase0-experiments`
的正确终态是 `needs-human`，不是 `done`——机器能验的四条 AC 已全绿，卡住的正是人证那一关。

### 阶段 1 起：自动化测试

- **默认包装**（阶段 1a）：
  - 用四个 provider 现有 runtime 测试的伪造流，验证宿主经历 `starting → busy → closed`，关闭原因为 `turn-complete`。
  - Claude 伪造"`complete` 之后 promise 仍未结束"的情形，验证经过 `lingering`，原因为 `released`。
  - `abort` 记为 `aborted`。
  - 现有全部 runtime 与 chat 测试不改一行，照常通过。
- **manager 状态机**：
  - 保活理由增减驱动的状态切换；每种关闭原因都要覆盖。
  - 1:N 下，解除一个绑定时，仍有其他绑定的宿主不关闭；最后一个绑定解除时宿主关闭。
  - 单写者冲突被拒绝。
- **空闲判定**：
  - cron 对账的正反例：Stop hook 的 `session_crons` 非空时 24 小时不关；清单变空后按正常计时关闭；7 天过期后关；拿不到清单时退回推测并标注 `inferred`。
  - 浏览器停留不刷新 `lastActivityAt`。
- **Claude resident driver**（伪造 SDK 流）：
  - 用户轮不重启进程；abort 调用 `interrupt` 而不关闭进程；
  - 无人轮会建 run，来源为 `unattended`，可以回放；
  - 忙时 `chat.send` 不返回 `RUN_IN_PROGRESS`，消息按伪造流给出的轮次边界归入对应的 run；出队前撤回调用 `cancel_async_message`；
  - 轮次边界取 `session_state_changed`，缺失时退回 `result`；`task_*` 事件增减保活理由；未知 system subtype 不中断读取循环；
  - 无人时 `canUseTool`、`onElicitation`、`request_user_dialog` 三个入口都被拒绝，轮次不挂起；
  - 启动参数里 `remoteControlAtStartup` 为 false、`isolatePeerMachines` 为 true。
- **L3 清扫**：残留 scope 被停止而不被接管；没有 systemd 时正确退化。
- **迁移**：`lifecycle_mode` 默认为 `per-run`；写入不在 `lifecycleModes` 中的模式时被拒绝。
- **前端组件**：
  - 常驻标记的各个状态、关闭按钮；
  - bypass 告知，以及未勾选时禁用发送；
  - "已随服务重启关闭"提示；
  - 无人轮分隔标签；
  - Running 徽标计数与分组；
  - Shell 标签页禁用；
  - `inputWhileBusy` 时不走 `QueuedMessageCard`。

## 验收标准

1. per-run 会话的全部现有测试保持通过，行为没有变化。
2. 阶段 1a 之后，Claude、Codex、Cursor、OpenCode 的运行中会话都出现在 `GET /api/session-hosts` 中，带状态和关闭原因；Claude 的持有期显示为 `lingering`。
3. 常驻会话中，用户连续发送 3 条消息，pid 不变。
4. 常驻会话创建的 1 分钟周期 cron，在用户中途发送消息后仍继续触发，触发内容出现在聊天中。
5. 常驻会话在用户轮或无人轮进行中收到用户消息时，既不被拒绝，也不在前端排队；消息落在哪一轮，与 E2/E3 记录的 CLI 行为一致。
6. 常驻会话存活期间，另一个会话用界面上复制的地址 `SendMessage`，对方能收到并产生一轮。
7. 无浏览器在线时发生的无人轮，打开页面后可以看到。
8. 空闲超时到达后进程退出，界面显示 `idle` 原因；有已知 cron 时，不在 24 小时处关闭。
9. 重启服务后没有残留的常驻进程，会话显示"已随服务重启关闭"，下一次发送时重新拉起。
10. 常驻进程超出单进程内存上限时，只有它被杀，服务与其他会话不受影响。
11. 开启常驻时，未勾选"我了解"就无法发送；勾选后才能创建或转换。
12. 浏览器一直停留在某个常驻会话上，不会阻止它在空闲超时后关闭。
13. 侧栏 Running 徽标不计入空闲的常驻会话；Running 视图分"正在运行"和"常驻（空闲）"两组。
14. 常驻会话的 Shell 标签页不可用；关闭常驻模式后恢复可用。
15. 无人轮在聊天记录中带触发类型标签，不以用户消息的样式显示。
16. 常驻进程的 Remote Control 跨机器可达性被强制关闭：即使用户 settings 开了 `remoteControlAtStartup`，宿主快照里的实际生效值仍为关闭；做不到时拒绝以 bypass 启动并说明。
17. 状态条的 cron 行来自 CLI 清单：模型没有调用 `CronDelete`、但清单里已没有该 cron 时，状态条与保活理由里都不再出现它。

## 风险与注意事项

- **安全**：常驻 + bypass + 跨会话消息不经审批，意味着同一 Unix 用户下的任何会话都能驱动它执行命令。这是原则 2 的直接代价，需要让用户知情。
- **包装改动面大**：阶段 1a 让所有 provider 的 `run`/`abort` 改为经 manager 分派，所有聊天都走这条路径。回归护栏是"现有测试不改一行照常通过"；此外，manager 在 1a 只观察、不做决策。
- **忙时输入依赖 CLI 行为**：原则 6 把行为基准交给了 CLI。若 SDK stream-json 与交互式 CLI 不一致（E2），需要另做决定；CLI 版本升级也可能改变这一行为，轮次归属会随之变化。
- **cron 状态**：以 Stop hook 的 `session_crons` 对账为准；只有拿不到清单时才退回推测，推测错误只影响关闭时间。
- **SDK 与 CLI 版本差**：SDK 0.3.165 的类型落后于全局 `claude` 2.1.282（`scheduled_task_fire`、`side_question`、`peer_message_hold`、`claim_session` 只在 CLI 里）。driver 必须放过未知 subtype；每份实验与冒烟记录写明两者版本；本机全局重装 `claude` 会改变行为，归因时先看二进制 mtime。
- **Remote Control 扩大信任边界**：见 §9，常驻进程必须强制关闭，并以验收标准 16 钉住。
- **上下文增长**：多日常驻依赖 CLI 自身的自动压缩，长期行为未测。
- **二进制替换**：本机 `claude.exe` 的修改时间被频繁改动，来源未查明；常驻进程启动失败时要可见、可重试。
- **转录双写者**：Shell 标签页已通过禁用排除（§12）；但用户在 tmux 或外部终端里 `--resume` 同一会话仍无法阻止，后果未验证。
- **计费**：聊天已走 SDK，常驻不改变认证方式；但无人轮会在用户不在场时消耗额度，cron 频率过高时要让用户能看到用量。

## 推荐实施顺序

1. **阶段 0**：做实验 E1–E8，把结论写回本文档。
2. **阶段 1a（纯包装）**：`session-hosts` 模块、共享类型、默认包装；`provider-runtime.service.ts` 改为经 manager 分派；`GET /api/session-hosts`；停机接入。行为不变，现有测试不改。
3. **阶段 1b**：Claude per-run driver。把顶替与 30 分钟持有迁入 manager 的策略，能区分 `superseded`；单写者由 manager 强制。
4. **阶段 2（Claude 常驻最小版）**：`lifecycle_mode` 列、能力矩阵字段、Claude resident driver、输入队列、`interrupt`、手动关闭、L3 启动清扫、bypass 启动并强制关闭 Remote Control（§9）、按控制协议事件切分轮次与维护保活理由（§7）。默认关闭，仅能通过 API 开启。
5. **阶段 3**：无人轮进入 run 注册表与通知（触发类型读 `origin`）；按 E2/E3/E9 的结论落地忙时输入与撤回；空闲自动关闭（cron 按清单对账）。
6. **阶段 4**：L3 独立 scope 与总内存上限（依据 E7 的数值）。
7. **阶段 5**：前端（§15）——模式选择与 bypass 告知、状态标记与状态条、关闭、复制地址、无人轮呈现、Running 分组（改读宿主接口）、Shell 禁用、忙时直发（§15.7，依据 E2/E3 的结论）。
8. **阶段 6**：文档——providers README、架构 03、运维文档。
9. **以后**：Codex app-server、`opencode serve` 的多路复用 resident driver，接入同一个宿主层。
