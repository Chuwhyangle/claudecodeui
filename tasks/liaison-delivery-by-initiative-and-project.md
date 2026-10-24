---
id: liaison-delivery-by-initiative-and-project
title: M3 联络投递：按（倡议, 项目）经 fleet registry 解析联络会话并投递，不在则进倡议收件箱、恢复后补投
status: ready
labels:
  - initiative
  - liaison
parent: null
children: []
extra: {}
---
## Proposal

决策出处：用户 2026-10-24 同意的跨项目机制 M3——「两个会话直接协作、只把裁定上报给人」常规化：每个倡议在每个参与项目里各有一个固定的联络会话，人向上、向外退出。设计与 quay-fleet 协作会话对齐：fleet 是星形拓扑的中心，registry 按（倡议, 项目）登记联络会话（fleet 任务 `fleet-registry-liaison-role`），稳定寻址先由只读探针验证（fleet 任务 `fleet-liaison-stable-addressing-probe`）。

前置：本任务在 fleet 的 `fleet-registry-liaison-role` 落地、且 `fleet-liaison-stable-addressing-probe` 给出结论（会话身份用 pid / sessionId / name 中哪个稳定、同名如何消歧）之后再做；探针结论若改变寻址方案，先按结论修订本任务正文。

问题：今天跨会话协作 4 次遇到 socket 地址失效，`ListAgents` 中 3 个会话同名——按名字或 socket 找人不可靠。CloudCLI 托管着会话（常驻会话注册表知道哪些会话存活、`session_send` 能投递），是联络消息的自然投递层。

方案：
1. 服务端 `liaison` 投递服务：`deliver({initiative, project, message, from})` → 调 fleet registry 按（倡议, 项目）解析联络会话 id → 若该会话在 CloudCLI 中存活（常驻注册表），经既有会话发送服务投递，消息带 `[liaison <initiative>/<from-project>]` 前缀与倡议 URI；不存活 ⇒ 写入 fleet 倡议收件箱（复用 fleet 的 outbox/inbox 投递语义），会话恢复（常驻恢复或下次打开）时补投。
2. 解析结果三态：resolved / ambiguous（多个候选，拒绝投递并上报）/ dead（进收件箱）。
3. 联络会话启动或恢复时向 fleet 重新登记（若探针结论要求）。
4. 只做投递，不做决策；投递记录可查（谁、何时、哪条倡议、结果）。

## 探针结论与正文修订

`fleet-liaison-stable-addressing-probe`（fleet 任务，2026-10-24 结论）实测：网关 sessionId 是唯一跨进程重启仍稳定的登记身份；本地 provider sessionId 随进程消失；pid 每次重启都变且可复用（须靠 procStart 核对）；name 不是地址（实测 3 个同时活着的同名会话）。据此本任务的寻址按结论收窄：

- registry 的 `liaisonSessions[initiative][project]` 值 = CloudCLI 会话 id（即网关 sessionId），解析只按二键读 registry，**name 永不参与解析**。
- 存活判定用 CloudCLI 自己的常驻注册表（`sessionHostManager.liveHostForSession`）——在本进程里它是授权读数，比 fleet 侧 `~/.claude/sessions/<pid>.json → procStart` 的本地核对更强；后者仍留给没有该注册表的读者。
- 重登记只在网关 id 变化时发生（fleet `registry sessions add` 同 pair 换 id 即一条登记），本任务不新增重登记机制。
- 缺席（unregistered / 登记了但不存活）⇒ 倡议收件箱；fleet 不可用是**另一种读数**（错误 + 本地待投队列），不与缺席同形。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/liaison/tests/liaison-deliver.test.ts` exit 0——桩 fleet registry + 桩常驻注册表：resolved 且存活时经会话发送服务投递恰好一次并带前缀；dead 时写入收件箱、不调用发送；ambiguous 时拒绝投递并产生上报；会话恢复事件触发收件箱补投且不重复。
- [x] AC2: 同一测试文件——fleet CLI 不可用时返回明确错误，不静默丢消息（消息保留在本地待投队列）。
- [x] AC3: `npm run typecheck` 通过；新模块目录按 AC-394 棘轮登记。

## DoD

- 用两个真实会话做一次往返：A 会话以（倡议, 项目 B）为地址投递，B 会话收到；重启 B 后再投递一次仍能送达。
- 隔离实例验证必须关闭常驻会话恢复。

## Touches

- server/modules/liaison/index.ts (new)
- server/modules/liaison/liaison.module.ts (new)
- server/modules/liaison/liaison-deliver.service.ts (new)
- server/modules/liaison/liaison-store.ts (new)
- server/modules/liaison/tests/liaison-deliver.test.ts (new)
- server/index.ts
- server/shared/tests/server-import-cycle-budget.test.ts
- server/shared/tests/server-import-cycle-budget.baseline.json
- server/shared/tests/quay-test-script.test.ts
- tasks/liaison-delivery-by-initiative-and-project.md

## Evidence

**实现**（分支 `task/liaison-delivery-by-initiative-and-project`，提交 `82980a12f` + `510843f22` + `8b1a5e751`）：
- `server/modules/liaison/liaison-deliver.service.ts`：`deliver()` 的四条判决按固定顺序——registry 不可用（错误 + 本地待投队列）→ ambiguous（拒绝 + 上报，不猜）→ dead/unregistered（倡议收件箱）→ 登记了但不存活（收件箱，记下等待的 sessionId）→ resolved+live（经注入的会话发送服务投递恰好一次）。正文按探针结论收窄：只按（initiative, project）二键读 registry，name 不参与；存活用注入的常驻注册表读数；登记身份 = CloudCLI 会话 id。消息形如 `[liaison <initiative>/<from>] initiative://<initiative>\n<原文>`。
- `server/modules/liaison/liaison-store.ts`：倡议收件箱 + 投递记录，两个追加式 JSONL（`inbox.jsonl` 的 `queued`/`delivered` 两态、按 deliveryId 去重；`deliveries.jsonl` 一行一次尝试），落盘位置 `<QUAY_FLEET_HOME>/liaison/`。坏行 ⇒ 具名 `liaison store is corrupt`，⛔ 不读成空收件箱。
- `server/modules/liaison/liaison.module.ts`：组合 + HTTP 面（`POST /api/liaison/deliver`、`GET /api/liaison/deliveries`、`GET /api/liaison/inbox`）+ 真实 `quay-fleet` runner（复用 `locateQuayFleetCli` 的**唯一**查找顺序，由 `server/index.ts` 注入）。
- `server/index.ts`：构建模块、挂载路由；`runFleet` 注入定位到的 CLI，`isSessionLive` = `sessionHostManager.liveHostForSession`，`sendMessage` = 进程唯一的 chat control；常驻注册表的 `onChange` 是「某会话现在有人服务了」的唯一announcement（常驻恢复与首次打开都覆盖），监听器按集合差集识别「刚变为存活」，逐个触发补投。
- AC-394：`modules/liaison` 登记进 `MANIFEST_PIN` 与 baseline `directoryManifest`（nodeCount 52 → 53）；模块只 import node 内建、`server/shared/**` 与自身。

**AC 读数**（本 worktree 最终树实跑）：
- AC1：`npx tsx --tsconfig server/tsconfig.json --test server/modules/liaison/tests/liaison-deliver.test.ts` ⇒ **tests 12 / pass 12 / fail 0 / EXIT=0**（1.8 s）。逐条对应：resolved+live 发送调用数为 1 且 `content` 以 `[liaison fleet-ui/claudecodeui] ` 开头、含 `initiative://fleet-ui`（「恰好一次」是发送桩的调用计数；同一 deliveryId 重投 ⇒ `already-delivered`，仍只发一次）；dead（未登记）/ 登记了但不存活 两条都进收件箱且发送 0 次（后者记下 sessionId）；ambiguous 返回 `ambiguous-liaison` + 全部候选、发送 0 次、收件箱 0 条、投递记录里产生一条具名候选的 `ambiguous` 上报；恢复事件把排队条目补投一次并清空收件箱，第二次恢复事件发送计数不变。
- AC2：同文件 3 条——CLI 不存在、非 JSON、`{ok:false}` 文档、runner 抛错四种「不可用」都返回 `registry-unavailable`（明确错误，message 说明消息已本地排队）且收件箱保留原文；负控证明**同一夹具**下格式良好的空列表读作 `dead` 而不是不可用（两种读数不同形）。另有一条：重投作为**原调用者**身份发出（队列条目携带 userId；DoD 实测发现不带身份的补投会被 control service 以 FORBIDDEN 拒绝并永远卡在队列里，已修 + 加判据）。
- AC3：`npm run typecheck`（client/server/scripts 三个 tsconfig）⇒ **EXIT=0**。AC-394 判据 `server-import-cycle-budget.test.ts` ⇒ 11/11 pass（manifest 53 项、新目录 not in `newDirectories`）；`oxlint` 对本任务改动文件 EXIT=0。
- 相邻判据：`quay-test-script.test.ts`（新增测试文件后重测文件数 416 → 417，两处 dispatch pin 同步改为 known=3 unknown=414 / known=1 unknown=416）⇒ 14/14 pass。全量 suite 由 worker-driver 的机械 fan-in 执行。

**DoD 读数**（隔离实例，`scripts/isolated-instance.sh`，机械保证 `residentRestore.enabled=false` + `CLAUDE_SESSION_SCOPE_SWEEP=off`；日志 `resident-restore started=0`）：
- B = 真实常驻会话 `c5a57036-de6c-482e-9078-d5572e528ef5`（provider session `db6f7025-…`，model sonnet），经 `POST /api/session-hosts/<B>/start` 拉起真实 CLI 进程（host pid 418285）。A = 本 worker 会话，以认证的 HTTP 调用 `POST /api/liaison/deliver`（`from: claudecodeui`）投递到 `(initiative=liaison-e2e, project=alpha)`；registry 由 fleet CLI `registry sessions add --role liaison --initiative liaison-e2e --project alpha` 在临时 `QUAY_FLEET_HOME` 上登记。
- 往返 #1：`{"ok":true,"outcome":"delivered","sessionId":"c5a57036-…","runId":"73e9f368-…"}`；B 的 transcript `~/.claude/projects/-data-home-yale-work-claudecodeui/db6f7025-….jsonl` 1 秒内出现 `[liaison liaison-e2e/claudecodeui] initiative://liaison-e2e\nDoD round trip #1: reply ACK1.`（type=user），随后 assistant 回 ACK1。
- B 关闭（`/close`，`running:false`）后投递 #2 ⇒ `{"ok":true,"outcome":"inbox","cause":"liaison-dead","sessionId":"c5a57036-…"}`，`GET /api/liaison/inbox` 读回原文。重启 B（新 host pid 435907）后 **2 秒内**自动补投：收件箱清空，transcript 出现 round trip #2，`GET /api/liaison/deliveries` 新增一条 `outcome:"delivered", detail:"redelivered from the initiative inbox on session recovery"`。
- 重启后按 DoD 再投 #3 ⇒ `{"ok":true,"outcome":"delivered","runId":"8e72a7f7-…"}`，B 的 transcript 2 秒内出现 round trip #3。实例已 `stop`（`residual_scopes:"", port_still_serving:false`）。

**边界（如实）**：
- `ambiguous` 在真实 registry 里不可达（存储是二键 map，一个 pair 只有一个值）；它是**读文档**的防御性分支（文档里同 pair 多个 id 时拒绝），由夹具钉住，不是日常路径。
- 倡议收件箱落在 fleet home 的 `liaison/` 下、复用 fleet outbox 的语义（追加式、queued/delivered 两态、按 id 去重），**不写** fleet 的 `outbox.jsonl`——那是 fleet 推给人的通道，联络消息是点对点。
- 补投的句柄来自常驻注册表的变更通告；若某部署关掉常驻模式、只用 per-run 主机，`liveHostForSession` 仍是同一读数，语义不变（本次未单独实测 per-run 目标）。