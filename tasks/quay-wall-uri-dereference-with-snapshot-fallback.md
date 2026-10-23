---
id: quay-wall-uri-dereference-with-snapshot-fallback
title: 墙 C 片：quay:// 引用解引用（fleet L1/L2 读口主路径 + snapshot 回落）
status: ready
labels:
  - wall
  - contract
  - quay
parent: null
children: []
extra: {}
depends_on:
  - quay-wall-addressable-view-and-input-package
---
## Proposal

决策出处：墙方向拆分（2026-10-23，用户已确认）中的 C 片。前置：`quay-wall-addressable-view-and-input-package`（A/B 片：`quay://` 地址工具、视图契约、引用式输入包）落地后再做；fleet 侧读口来自 quay-fleet 任务 `fleet-wall-object-uri-address-space`。

问题：A/B 片之后，输入包里送的是 `quay://<project>/task/<id>` 引用，但 CloudCLI 侧还没有任何地方能把引用读回成真实对象。下游（指挥会话、项目会话）拿到引用后需要一个解引用入口。

方案：
1. 解引用入口（服务端，挂在既有 `/api/quay` 路由下）：`resolve(uri)` 返回 L1 `{uri, type, actions}`，`summary(uri)` 返回 L2 `{summary, generatedAt, sourceEventId}` 或 absent。
2. **主路径**：调用 fleet 的 L1 `resolve` 与 L2 `summary` 读口（L2 读 `.quay/object-summaries.jsonl` 最新行，读路径零生成）。`type`/`actions` 枚举原样采用 fleet 返回值，本侧不另立动作集。
   - 枚举唯一来源：fleet 仓库 `config/object-uri.types.v0.json`（fleet commit `0bfb837` 定稿，v0）：task=[read,check,edit,promote,retreat,complete,log,gate]、goal=[read,check,gate,write]、ledger=[read]、board=[read]；`#ac-<n>` 不是独立 type，而是 task 上的片段，L1 额外返回 `fragment:{kind:"ac",index:n}`，actions=[read,check,edit]。CloudCLI 不复制这份枚举，回落路径也不自造 actions（为空）。
3. **回落路径**：fleet 读口不可用时，task 类 URI 从既有 quay snapshot 数据读回真实任务字段；结果带 `source: "snapshot-fallback"` 标记，`actions` 为空，L2 返回 absent。绝不现场调用 LLM 生成摘要。
4. 非法或未知 URI 返回明确的错误码，不抛未处理异常。

## AC

- [x] AC1: `npx vitest run server/modules/quay/tests/quay-uri-resolve.test.ts` exit 0——用桩 fleet 读口（桩数据取自 v0 枚举形状）：`#ac-<n>` URI 的结果透传 `fragment` 字段；`resolve(quay://<project>/task/<id>)` 返回桩给出的 type/actions 原值；`summary` 返回桩里最新一行；无行时返回 absent。
- [x] AC2: 同一测试文件——fleet 读口不可用时，task URI 读回的标题/状态与 snapshot 夹具中该任务的真实字段相等，且结果带 `source: "snapshot-fallback"`、`actions` 为空、L2 为 absent。
- [x] AC3: 同一测试文件——非法 URI（缺项目段、未知类型）返回错误码而非 500；整个文件中没有任何 LLM / 生成调用（以注入桩计数为 0 断言）。
- [x] AC4: `npm run typecheck` 通过；`server/modules/quay/tests/quay-fleet-summary.test.ts` 既有用例原样通过。

## DoD

- 在真实运行的 CloudCLI 上，对一块在途任务磁贴的 URI 调用解引用入口，读回与 Quay 面板一致的真实任务数据；如实写明当时走的是 fleet 主路径还是 snapshot 回落路径。

## Notes

实现读数（2026-10-23，worktree 分支 `task/quay-wall-uri-dereference-with-snapshot-fallback`）：

- **AC1/AC2/AC3 runner 偏差（如实）**：AC 写的 `npx vitest run server/modules/quay/tests/quay-uri-resolve.test.ts` 在本仓**按构造**不可能 exit 0——`vitest.config.ts` 的 `include` 只有 `src/**`，实测输出 `No test files found`、exit 1（同 `gap-voice-sensevoice-server-adapter` 已记录的 runner 偏差）。按本仓服务端规范 runner 实测：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/quay/tests/quay-uri-resolve.test.ts` → **exit 0，5 passed / 0 failed**。AC 的意图（用例全绿）按规范 runner 满足。
  - AC1：桩 fleet 的 L1 原样回传 type/actions；`#ac-3` 透传 `fragment:{kind:"ac",index:3}`；L2 返回桩台账最后一行；无行 ⇒ `absent`。
  - AC2：fleet 不可用时 task URI 的 `task.title`/`task.status` 与 snapshot 夹具逐字段相等，`source:"snapshot-fallback"`、`actions:[]`、L2 `absent`。
  - AC3：`quay://task/T-42` ⇒ `missing-project`；`quay://wall-proj/widget/T-42` ⇒ `unknown-type`；另有 `not-a-quay-uri` / `empty-id`；路由对非法引用回 400、无读口回 503（不是 500）；注入的 `generateSummary` 桩计数为 0。
- **AC4**：`npm run typecheck` → **exit 0**。`quay-fleet-summary.test.ts` + `quay.service.test.ts` → **38 passed，1 skipped**（skip 为既有用例：worktree 无 `.quay/plugin` 安装的 quay 插件，非本 delta）。`npx oxlint` 四个改动文件 → exit 0。
- **DoD（如实写明路径）**：生产 server 进程（`dist-server/server/index.js`，pid 3471507）跑的是本改动之前的构建且未重启（重启会杀掉跑在它下面的本 worker 会话）；改为用**真实路由 + 真实 service** 起临时 HTTP 实例：`createQuayRouter` + `createQuayService`，项目注册表取自运行中实例数据库的副本（`~/.cloudcli/auth.db` → `/tmp/quay-dod-probe.db`），CLI 为真实 `quay` 插件与真实 `quay-fleet`。在途磁贴取 snapshot `inFlight[0]` = `ui-scenario-driver-semantic-surface`，URI `quay://b0a96771-c926-468a-bf18-09a5b3708039/task/ui-scenario-driver-semantic-surface`：
  - **snapshot 回落路径**（部署现状：`QUAY_FLEET_BIN` 未设）：`GET /api/quay/resolve` → 200，`source:"snapshot-fallback"`、`actions:[]`、`task.title`/`status` 与 snapshot `tasks.recent` 行逐字相等（标题「UI 场景驱动：页内语义面 + 场景运行器…」、status `ready`）；`GET /api/quay/summary` → 200 `state:"absent"`。
  - **fleet 主路径**（读口指向 `/data/home/yale/work/quay-fleet/bin/quay-fleet.mjs`）：`#ac-1` URI → 200，`source:"fleet"`、`actions:["read","check","edit"]`、`fragment:{kind:"ac",index:1}`（fleet 原值）；`summary` → `source:"fleet"`、`state:"absent"`（该 workspace 台账无行，读路径未生成）。
- **地址空间桥接（实现要点）**：墙的引用带项目段（`quay://<project>/task/<id>`），而 fleet 读口按**单 workspace** 读、其地址无项目段（`quay://task/<id>`、`quay://goal/<id>`、`quay://ledger/<name>/<eventId>`，board 为 `quay://board/<project>`）。解引用入口把项目段用于选 workspace root（`wall summary --root`），调 fleet 前翻译成 fleet 自身地址；返回结果里的 `uri` 仍是墙的带项目段形式。
- **兼容边界**：回落只覆盖 task 引用（Proposal 的「task 类 URI」）；goal/ledger/board 在 fleet 不可用时返回 `fleet-unavailable`（503），不臆造数据。回落的 task 数据取 snapshot `tasks.recent`（面板渲染的同一列表，最近 10 条），超出该窗口 ⇒ `task-not-found`（404），如实不猜。部署要让主路径生效只需设 `QUAY_FLEET_BIN`。

## Touches

- server/modules/quay/quay.routes.ts
- server/modules/quay/quay.service.ts
- server/modules/quay/quay-uri-resolve.ts
- server/modules/quay/tests/quay-uri-resolve.test.ts
- tasks/quay-wall-uri-dereference-with-snapshot-fallback.md


2026-10-23 读口实测形状（fleet 已落地，按此接线）。fleet 读口是 `quay-fleet` CLI 的只读子命令（`../quay-fleet/bin/quay-fleet.mjs`），不是 HTTP：
- L1：`quay-fleet wall resolve <uri> --json` → `{"ok":true,"uri","type","label","actions":[…]}`；带 `#ac-<n>` 时 actions=["read","check","edit"]，并附 `fragment:{kind:"ac",index:n}`；畸形或未知 URI 以 exit 2 退出并给出具名 reason。
- L2：`quay-fleet wall summary <uri> --root <项目检出根> --json` → `{"state":"absent",…}` 或 `{"state":"ok","summary","generatedAt","sourceEventId",…}`。
- **`state:"absent"` 不等于读口故障**：fleet 的写路径还没接进 observe 循环，所以目前所有 URI 都返回 absent。absent ⇒ L2 为 absent，task 字段走 snapshot 并标 `source:"snapshot-fallback"`、reason `no-summary`；CLI 不存在、非零退出或 JSON 解析失败 ⇒ 同样回落，但 reason 为 `reader-unavailable`。两种 reason 必须区分，并各有测试用例。
- **⚠️ URI 语法分歧（已报 fleet 侧修正）**：fleet 落地的是不带项目段的 `quay://task/<id>`、`quay://board/<id>`；CloudCLI 已落地的、双方约定的语法是 `quay://<project>/task/<id>`、`quay://<project>/board`。fleet 现在会以 unknown-type 拒绝带项目段的 URI。本任务**只在一个适配函数里**把 CloudCLI 的 URI 转成 fleet 当前的形式（去掉项目段，项目段映射为 `--root`），并注释为临时措施；不得在其他地方出现无项目段的 URI；对外（输入包、API 返回）一律保留带项目段的原 URI。