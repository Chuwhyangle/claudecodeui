---
id: cockpit-scenarios-and-safe-isolated-instance
title: 观察墙 T7：场景运行器接入驾驶舱（3 个端到端场景）+ 安全隔离实例脚本（强制关闭常驻会话恢复）
status: ready
labels:
  - cockpit
  - testing
  - ops
parent: null
children: []
extra: {}
---
## Proposal

决策出处：2026-10-24 与用户确定的「观察墙」方案（驾驶舱首先是观察面）。依据：14 天负载分析（2159 条人类输入、相邻输入一半落在不同会话、切换中位间隔 2.4 分钟；只看不打字的切换未被记录，真实观察负载更高）；用户确认观察会话输出 / quay 状态 / 架构以及为此做的切换是最大负载。硬约束（quay references）：读数三态（取不到 = 未评估 + 原因，不得显示为绿）、每盏绿灯带活性时间戳、语义判断标注「仅建议」、驾驶舱本身比被治理对象小一个量级。

问题：(1) 场景运行器目前只认识 quay-panel，驾驶舱任务的 DoD 无法跑大颗粒度场景，导致单元级 AC 全绿而真实路径有问题（2026-10-24 走查发现 15 处）。(2) 每次验证都手工拼隔离实例；2026-10-24 用复制的 live DB 起实例时，因常驻会话恢复默认开启，对线上同一批 16 个真实会话各起了一个重复的 `claude --resume` 进程。

方案：
1. `scripts/isolated-instance.sh start|stop|status`：复制 `~/.cloudcli/auth.db`（better-sqlite3 backup）到临时目录、为现有用户设置一次性密码、生成临时 settings 文件且**强制** `residentRestore.enabled=false`、选空闲端口启动当前 `dist-server`、等待健康检查、登录取 token 输出到文件；启动后检查 `[resident-restore]` 日志，started > 0 则立即停止并报错。`stop` 按 scope 名（`claudecodeui-session-<pid>-*`）逐个停止并杀掉 server，不按命令行文本 pkill。
2. 场景运行器支持打开 `/cockpit`（词表增加 cockpit 视图），语义面读数增加 驾驶舱焦点 / 墙对象 / 回声。
3. 三个场景：会话 → 驾驶舱 → 回到原会话（模式切换）；在观察墙用序号选中一个磁贴并预览、差量清零；两个上下文中一端预览使另一端差量同步清零。

## AC

- [x] AC1: `node --test scripts/isolated-instance.test.mjs` exit 0——生成的 settings 文件中 residentRestore.enabled 为 false；日志出现 started>0 时脚本以非零退出并执行 stop；stop 只针对本实例 pid 的 scope（桩 systemctl 计数）。
- [x] AC2: `npx playwright test e2e/ui-scenario-runner.spec.ts` exit 0——新增驾驶舱场景主臂通过；控制臂（改错一步期望）以非零退出且报告指出该步序号。
- [x] AC3: `npm run typecheck` 通过。

## DoD

- 用脚本起一次实例，贴出 `[resident-restore]` 为 0 的日志与三个场景的运行器报告；stop 后确认无残留 scope 与端口。

## Notes

### 落地读数（2026-10-24，worktree `cockpit-scenarios-and-safe-isolated-instance`）

- **隔离实例**：`bash scripts/isolated-instance.sh start` 输出 `{"ok":true,...,"port":29013,"resident_restore_started":0,...}`；settings 文件为 `{"residentRestore":{"enabled":false}}`；`tmp/isolated-instance/server.log` 中 `[resident-restore]` 命中 **0** 行（restore 被关掉时 server 根本不调度该 pass），脚本另打印 `resident-restore started=0 (restore is disabled; a pass cannot run)`。`stop` 输出 `{"ok":true,"residual_scopes":"","stopped_scopes":"","port_still_serving":false}`；停后该 pid 的 scope 列表为空、29013 端口无监听、`server.pid` 已清除。实例无任何 `claude` 子进程。
- **场景运行器**：`e2e/scenarios/cockpit-mode-switch.json` 三步（会话 → 驾驶舱 → 原会话），在真实隔离实例 + vite dev client 上 `ok:true, stepCount:3, 3 checkpoints`，第 3 步 route 与第 1 步逐字相同（`/session/d01bc610-…`），即驾驶舱记录的产品返回路径。e2e 两臂（主臂 + 改错 `cockpitMounted` 的控制臂）在 `npx playwright test e2e/ui-scenario-runner.spec.ts` 内落绿：`1 passed, 1 skipped (13.1s)`。
- **AC2 的 skip 是环境条件，不是本任务引入的失败**：Quay 面板只在项目被 quay-fleet 注册时才发布可寻址视图契约；e2e 的临时 fixture 目录不在本机 `~/.quay-fleet/registry.json` 中，故墙场景拿不到 `fleetProjectId`。spec 先读 snapshot 的 `fleetProjectId`，为 null 时显式 `test.skip` 并给出启用命令；同一 skip 在主检出上同样复现（本任务未改动该机制）。驾驶舱场景不需要 registry，始终运行。
- **未产出的两个观察墙场景（如实）**：`e2e/scenarios/cockpit-wall-preview-seen.json` 与 `cockpit-seen-cross-device.json` 依赖 T1（`ObservedObject`/`SeenCursor`/差量 API）与 T5（观察墙 UI：磁贴预览、打开即 seen、跨设备差量清零），两者在 develop 上尚未落地（T1 `ready`、T5 `todo`）。本任务交付的是运行器词表（session/cockpit opener）与驾驶舱读数（`cockpit.view/focus/wallObjects/echo`），不写依赖未存在契约的假场景文件——待 T1/T5 落地后按真实 `data-*`/API 契约补写，届时同一 runner 直接可用。
- **驾驶舱读数来源**：驾驶舱页面不导入 dev-only 语义面（生产包不得携带），其 `data-cockpit-view` / `data-cockpit-focusables` / `data-cockpit-focus` 本就是渲染器画出的同一份声明；`scenarioSurface.read().cockpit` 读这些属性，`echo` 在 `[data-testid="cockpit-echo"]` 出现前诚实为 `null`。
- **安全项**：隔离实例额外设置 `CLAUDE_SESSION_SCOPE_SWEEP=off`，避免一次性 server 启动时做 host-wide orphan scope sweep 而误收线上会话 scope。

## Touches

- scripts/isolated-instance.sh
- scripts/isolated-instance.test.mjs
- scripts/ui-scenario.mjs
- src/modules/ui-scenario/scenarioSurface.ts
- e2e/ui-scenario-runner.spec.ts
- e2e/scenarios/cockpit-mode-switch.json
- e2e/scenarios/cockpit-wall-preview-seen.json
- e2e/scenarios/cockpit-seen-cross-device.json
- playwright.config.ts
- tasks/cockpit-scenarios-and-safe-isolated-instance.md
