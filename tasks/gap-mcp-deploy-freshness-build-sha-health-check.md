---
id: gap-mcp-deploy-freshness-build-sha-health-check
title: 发布新鲜度最小检测：/health 暴露 buildSha/builtAt，新增
  scripts/check-deploy-freshness.mjs 人工比对，不建调度器不自动重启
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**背景（2026-10-11 本轮实测，根因分析）：** 复核 `gap-mcp-session-get-projectid-null-under-production-gateway-assembly` 时发现生产服务（`claudecodeui-server.service`，端口 3001）当前跑的 dist-server 编译产物**不含**该修复提交 `ec07411f`，而本仓库 develop 早已包含。逐事实核对时间线（避免误判为「用了旧 checkout」）：

- `ec07411f` 在**它自己的任务分支**上提交于 19:10:38，但要经过机械 fan-in 才落到 develop——`git log` 显示它真正进入 develop 的 fast-forward 落在 19:19 之后（`b0e5886a` 19:19:09 是任务分支反向合并 develop 以便 ff，随后 `1cf74582` 19:22:39 才是 done 收口提交）。
- `dist-server/server/modules/mcp-gateway/mcp-gateway.transport.js` 的 mtime 是 19:17，`claudecodeui-server.service` 19:18:04 启动——**两者都早于 ec07411f 真正落到 develop 的时刻**。
- 结论：这**不是**「构建用了一份过期的 checkout」——构建发生的那一刻，develop 真的还没有这个修复，构建本身是忠实的。**真正的结构性缺口是：没有任何机制在「之后又有新提交落到 develop」时触发重新构建+重启。** 生产的新鲜度完全依赖人工、某一时刻点状的 `npm run build && systemctl --user restart`，而 Quay driver 的机械 fan-in 每隔几分钟就会往 develop 推新提交——人工部署几乎必然在部署后很快就落后，而且不会自愈。
- 旁证（同一因不同症）：`server/modules/system/system.service.ts` 的 `/update` 自助更新端点执行 `git checkout main && git pull && npm install`——checkout 的是 **`main`**（本仓库今天全部 MCP 工作都在 `develop`，`main` 落后得多），且只 `npm install`（`package.json` 的 `postinstall` 只跑 `scripts/fix-node-pty.js`，**不会**触发 `npm run build`）。这个端点即使被调用，也不会让生产跟上 develop。**本任务不改 `/update` 的行为**（那是更大范围的发布策略改动，值得单独讨论），只做最小的「能不能说清楚现在新鲜不新鲜」。

**要交付（最小可验收，只做检测，不做发布，不建调度器）：**

1. `scripts/write-build-info.mjs`（新建，纯脚本，不是服务的一部分）：在 `APP_ROOT` 下跑 `git rev-parse HEAD`（失败则 `gitSha: null`，不让构建因此失败），写 `dist-server/build-info.json` = `{gitSha, builtAt: new Date().toISOString()}`。`package.json` 的 `build:server` 脚本末尾追加 `&& node scripts/write-build-info.mjs`（现状 `"tsc -p server/tsconfig.json && tsc-alias -p server/tsconfig.json"`）。
2. `server/modules/system/system.service.ts` 新增纯函数 `export function readBuildInfo(appRoot: string): { gitSha: string | null; builtAt: string | null }`：读取 `path.join(appRoot, 'dist-server', 'build-info.json')`，文件不存在或 JSON 解析失败都返回 `{gitSha: null, builtAt: null}`（dev 模式下 tsx 直接读源码，从不产出这个文件，这是预期的「null」而不是错误）。路径选在 `dist-server/` 内部而不是 `APP_ROOT` 根——`findApplicationRoot`（`server/shared/utils.ts:1537-1543`）已经把「从 `server/index.ts` 启动」与「从 `dist-server/server/index.js` 启动」两种模式都折算到同一个 `APP_ROOT`，但只有后者该有这份文件；放在 `dist-server/` 里能让「有没有被真的构建过」本身可判断，不会在纯 tsx 开发模式下读到上一次构建遗留的陈旧文件。
3. `server/index.ts` 的 `/health` 路由（`:818-825`）增加 `buildSha`、`builtAt` 两个字段（调用 `readBuildInfo(APP_ROOT)` 一次，与 `RUNNING_VERSION` 同样在启动时读一次、不逐请求重读——理由与 `RUNNING_VERSION` 那段既有注释一致：长驻进程不该在运行期途中改变自己对「我是谁」的认知）。只增字段，不改 `status`/`timestamp`/`installMode`/`version` 的既有形状。
4. `scripts/check-deploy-freshness.mjs`（新建，人工手动运行的一次性检测工具，**不是**定时任务、不是服务的一部分、不自动重启任何东西）：参数 `--url <health-url，默认 http://127.0.0.1:3001> --ref <git ref，默认 HEAD>`。流程：`fetch(url + '/health')` 读 `buildSha`；本地跑 `git rev-parse <ref>`；若 `buildSha` 为 `null` → 打印 `UNKNOWN（该实例可能是 tsx 开发模式，或构建早于本检测工具存在）`，exit 2；若 `buildSha === ref 的 sha` → 打印 `FRESH`，exit 0；否则用 `git merge-base --is-ancestor <buildSha> <ref>` 确认 `buildSha`确实是 `<ref>` 的祖先，再用 `git rev-list --count <buildSha>..<ref>` 数落后的提交数，打印 `STALE，落后 N 个提交（<buildSha> → <ref>）`，exit 1；`buildSha` 不是 `<ref>` 的祖先（分叉，例如构建自 main 而不是 develop）时打印 `DIVERGED`，exit 1。
5. **本任务不做**：自动重启、cron/定时检测、把这个检测接进 Quay driver 或任何现有调度循环、改 `/update` 端点的行为。这些都是后续可能的方向，不在这个最小任务里。

## AC

- [ ] 新增/扩展判据逐文件运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/system/tests/system.service.test.ts`，新增用例覆盖 `readBuildInfo`：真实临时目录下写一份 `dist-server/build-info.json` 能原样读出；文件不存在、JSON 损坏两种情形都返回 `{gitSha: null, builtAt: null}` 而不抛错。**不新增测试文件**（直接扩展既有的 `system.service.test.ts`，不移动 `quay-test-script.test.ts` 的计数钉）。
- [ ] `node scripts/check-deploy-freshness.mjs --url http://127.0.0.1:0 --ref HEAD`（指向一个必然连不上的端口）能正确处理网络错误，打印诊断信息，非 0 退出，不抛未捕获异常。
- [ ] `npm run typecheck` 退出码 0。

## DoD

**真服务，分两段，且不得触碰正在运行的生产服务（3001）：**
1. 用 `scripts/mcp-smoke.mjs` 的 `bootServer`（临时目录、临时端口）起一个**未经构建**的 tsx 实例，调 `/health`，确认 `buildSha`/`builtAt` 都是 `null`（证明 dev 模式不会假冒一个构建身份）。
2. 在同一个临时目录结构里手工放一份伪造的 `dist-server/build-info.json`（内容为当前 `git rev-parse HEAD`），确认（通过直接调用 `readBuildInfo`，不必再起一次完整服务）函数能读出同一个 sha；用本任务新建的 `scripts/check-deploy-freshness.mjs` 对着这份伪造数据跑一次，报告 `FRESH`。
3. **额外读数（如实记录现网现状，不作为本任务的通过条件，只是证明这个检测工具有能力发现真实问题）：** 对正在运行的生产服务只读调用 `curl http://127.0.0.1:3001/health`（本任务落地前，该服务跑的还是旧版 `/health`，没有这两个字段——这一步本身就是「检测缺口确实存在」的证据）。**本任务落地后**，若该服务尚未重建+重启，再读一次 `/health` 预期仍是旧形状（没有 `buildSha` 字段），这正确地说明「代码修好了，但没人部署」，不应被误读为检测工具本身有问题。

## Touches

- scripts/write-build-info.mjs（new）
- scripts/check-deploy-freshness.mjs（new）
- package.json（`build:server` 脚本追加一步）
- server/modules/system/system.service.ts
- server/modules/system/tests/system.service.test.ts
- server/index.ts
- tasks/gap-mcp-deploy-freshness-build-sha-health-check.md（self）
