---
id: quay-fleet-cli-locator-and-handshake
title: fleet CLI 单一定位（QUAY_FLEET_BIN → PATH → ~/.quay-fleet/bin）+ --version
  契约握手，替换三处不一致的路径解析
status: ready
labels:
  - wall
  - contract
  - quay
  - ops
parent: null
children: []
extra: {}
depends_on:
  - cockpit-live-verification-defects
---
## Proposal

决策出处：用户 2026-10-23 确认的 quay-fleet 发布 / 安装方案（与 quay-fleet 协作会话对齐）。fleet 侧将提供：git tag + `npm i -g` 的版本化安装、`self-install|upgrade` 维护的稳定软链接 `~/.quay-fleet/bin/quay-fleet`（只准备不重启）、以及 `quay-fleet --version --json` 契约握手 `{name, version, contracts:{wallUri:"v0", registry:1, interfaceSession:"v0"}}`（握手以 `contracts` 为准，`version` 只作日志）。本任务是 CloudCLI 侧的消费方改造。

现状（2026-10-23 实读）：CloudCLI 有**三处各自解析** fleet CLI 路径，行为还不一致——
- `server/modules/quay/quay-fleet-project-id.ts:173`：`QUAY_FLEET_BIN` → PATH 上的 `quay-fleet`；
- `server/modules/quay/quay-fleet-registry.ts:146`：同上；
- `server/modules/quay/quay-uri-resolve.ts:384`：只读 `QUAY_FLEET_BIN`，**不回落 PATH**。
线上 :3001 的服务环境两者都没有，于是墙 / 驾驶舱整体静默失效（运维侧暂以 systemd drop-in `70-quay-fleet.conf` 指向开发检出应急）。

方案：
1. **单一定位函数**（新文件 `server/modules/quay/quay-fleet-locator.ts`）：查找顺序 `QUAY_FLEET_BIN` → PATH 上的 `quay-fleet` → `~/.quay-fleet/bin/quay-fleet`（存在且可执行）。三处调用点全部改用它；不再有各自的默认值。
2. **启动握手**：定位成功后执行一次 `quay-fleet --version --json`（带超时与 TTL 缓存），校验 `contracts`：CloudCLI 声明自己支持的契约版本（`wallUri: v0`、`registry: 1`、`interfaceSession: v0`）。结果分四态：`ok` / `missing`（找不到 CLI）/ `incompatible`（列出哪个契约过旧或过新）/ `no-handshake`（旧版 fleet 不认 `--version`，视为兼容但标注「未握手」，以便过渡期不中断）。
3. **状态透出**：`GET /api/quay/fleet-summary` 顶层的 `fleet` 字段（由 `cockpit-live-verification-defects` 引入）扩展为 `{available, state, binPath, version, contracts, reason}`；驾驶舱与 Quay 面板按 state 显示一行说明（缺失 / 版本不兼容 / 未握手），不逐个项目显示「未登记」。
4. 不在本任务里改 systemd 配置；fleet 的 `self-install` 落地并实际安装后，由会话 / 用户删除应急 drop-in `70-quay-fleet.conf` 并重启（运维步骤，记录在 DoD）。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay-fleet-locator.test.ts` exit 0——注入的环境 / PATH / 文件系统桩下：设了 `QUAY_FLEET_BIN` 用它；未设时用 PATH 命中；PATH 无命中时用 `~/.quay-fleet/bin/quay-fleet`；三者皆无返回 `missing`。
- [x] AC2: 同一测试文件——握手桩返回兼容 contracts ⇒ `ok`；`wallUri` 为 `v1` ⇒ `incompatible` 且 reason 点名 `wallUri`；`--version` 以 unknown command 失败 ⇒ `no-handshake`；超时 ⇒ `missing` 以外的独立 reason，不抛出。
- [x] AC3: `git grep -n "process.env.QUAY_FLEET_BIN\|process.env\[QUAY_FLEET_BIN_ENV\]" -- server ':!server/modules/quay/quay-fleet-locator.ts' ':!**/tests/**'` 无命中（只剩定位函数一处读取）。
- [x] AC4: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay-fleet-project-id.test.ts` 与 `server/modules/quay/tests/quay-uri-resolve.test.ts` 各自 exit 0（既有用例不弱化）；`npm run typecheck` 通过。

## DoD

- 用真实 fleet 检出实测三种定位来源（环境变量 / PATH 上的链接 / `~/.quay-fleet/bin`）各一次，贴出 `fleet-summary` 的 `fleet` 字段；fleet 握手命令落地前如实显示 `no-handshake`。
- **MCP 浏览器（或独立 Playwright）实际操作 + 截图（必做）**：无任何定位来源时驾驶舱显示「找不到 quay-fleet」；截图存 `tmp/`。
- 运维收尾（fleet `self-install` 落地并安装后）：删除 `~/.config/systemd/user/claudecodeui-server.service.d/70-quay-fleet.conf`，`daemon-reload`，由用户重启服务，确认 `fleet.binPath` 指向 `~/.quay-fleet/bin/quay-fleet`。若届时 fleet 侧未落地，如实写明并保留 drop-in。

## Touches

- server/modules/quay/quay-fleet-locator.ts
- server/modules/quay/tests/quay-fleet-locator.test.ts
- server/modules/quay/quay-fleet-project-id.ts
- server/modules/quay/quay-fleet-registry.ts
- server/modules/quay/quay-uri-resolve.ts
- server/modules/quay/quay.service.ts
- server/modules/quay/tests/quay-fleet-project-id.test.ts
- server/modules/quay/tests/quay-uri-resolve.test.ts
- server/shared/types.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- src/shared/types.ts
- src/modules/cockpit/CockpitPage.tsx
- src/modules/quay/QuayPanel.tsx
- tasks/quay-fleet-cli-locator-and-handshake.md
