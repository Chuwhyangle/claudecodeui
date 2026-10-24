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

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/liaison/tests/liaison-deliver.test.ts` exit 0——桩 fleet registry + 桩常驻注册表：resolved 且存活时经会话发送服务投递恰好一次并带前缀；dead 时写入收件箱、不调用发送；ambiguous 时拒绝投递并产生上报；会话恢复事件触发收件箱补投且不重复。
- [ ] AC2: 同一测试文件——fleet CLI 不可用时返回明确错误，不静默丢消息（消息保留在本地待投队列）。
- [ ] AC3: `npm run typecheck` 通过；新模块目录按 AC-394 棘轮登记。

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
- tasks/liaison-delivery-by-initiative-and-project.md
