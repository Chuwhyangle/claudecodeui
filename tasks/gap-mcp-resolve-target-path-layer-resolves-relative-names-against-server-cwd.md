---
id: gap-mcp-resolve-target-path-layer-resolves-relative-names-against-server-cwd
title: AC-333 路径层把相对名称按服务 cwd 补全：裸名 app 会静默解析到 <cwd>/app 而非精确标题 app，且写工具放行；只对绝对路径启用路径层
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-333
---
## Proposal

**Finding（2026-10-11，复核 `af7009bb` 时直接调用 `resolveMcpTarget` 复现）：** AC-333 的路径层（`server/modules/mcp-gateway/mcp-resolve-target.ts` 的 Layer 2）对**任何**查询都执行 `normalizeTargetPath(query)` = `path.resolve(query)`，相对串会以**服务进程的 cwd** 为基准补成绝对路径。复现脚本：项目 A 位于 `<cwd>/app`、标题为 `something-else`；项目 B 位于 `/srv/elsewhere/app`、标题为 `app`。`resolveMcpTarget('app','project',deps)` 返回 `{"ok":true,"id":"p-cwd-app","matchType":"path"}`，`'./app'` 也一样。也就是说，一个裸名称没有按精确标题解析到 B，而是按服务 cwd 静默解析到 A。又因为 `matchType` 是 `path`，写工具的严格性检查（只拒绝 `substring`）也放行，与 D1「规范化**完整**路径」的裁定不符。读数依赖服务从哪个目录启动，同一请求在不同部署下解析到不同项目。

现网暴露面（只读查询 `projects`）：运行中服务的 cwd 是 `/data/home/yale/work/claudecodeui`，其下没有直接子目录项目，所以目前没有实际误命中。这是契约缺陷，不是正在发生的事故。

**要交付：**

1. 路径层只在 `path.isAbsolute(query)` 为真时参与；相对串（`app`、`./app`、`../x`）直接跳过路径层，进入标题层。不做 `~` 展开。
2. 在既有判据文件 `server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts` 里加一条腿：夹具含上面的 A、B 两个项目，断言 `app` 解析到 B 且 `matchType` 为 `exact_title`；`./app` 不解析到 A（无命中或按标题层的结果，如实断言）；A 的绝对路径仍然解析到 A 且 `matchType` 为 `path`。先写测试观察红，逐字记录失败行。
3. 不新增测试文件（不移动计数钉），不改错误码与输出形状。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts` 退出码 0（即 AC-333 判据），并包含第 2 条描述的新腿；改动前同一新腿为红，失败行记录在完成记录里。
- [x] 取假：删掉 `path.isAbsolute` 守卫后新腿必须红，记录变异 diff 与失败行后恢复。
- [x] `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作一次（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得重启或改动正在运行的 CloudCLI 服务**）。在该实例进程的 cwd 下建一个子目录项目 A（标题与 B 不同），另建标题为 `app` 的项目 B。经 `/mcp` 调 `sessions_list {project:"app"}`，读数命中的是 B 而非 A；再用 A 的绝对路径调用，命中 A。逐字记录请求与响应摘要。仅有测试夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-resolve-target.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts
- tasks/gap-mcp-resolve-target-path-layer-resolves-relative-names-against-server-cwd.md（self）

## 完成记录

实施提交：`4fd31dcb`（分支 `task/gap-mcp-resolve-target-path-layer-resolves-relative-names-against-server-cwd`）。改动仅两处：Layer 2 守卫 `if (kind === 'project' && path.isAbsolute(query))`，以及既存判据文件里新增的腿 (i)；未新增测试文件、未改错误码与输出形状。

### AC 第 1 条 — AC-333 判据命令 + 新腿

命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts`
读数：`ℹ tests 18  ℹ pass 18  ℹ fail 0`，退出码 0。

新腿 (i) 通过后的读数（逐字）：
```
[i] query="app" -> {"ok":true,"id":"p-elsewhere-app","matchType":"exact_title","matched":{"id":"p-elsewhere-app","title":"app","path":"/srv/elsewhere/app","matchType":"exact_title"}}
[i] query="./app" -> {"ok":false,"code":"PROJECT_NOT_FOUND","query":"./app","kind":"project","candidates":[],"message":"No project has a title containing \"./app\"."}
[i] query="…/app" -> {"ok":true,"id":"p-cwd-app","matchType":"path","matched":{"id":"p-cwd-app","title":"something-else","path":"…/app","matchType":"path"}}
```
即 `app` 按精确标题命中标题为 `app` 的项目 B（`exact_title`）；`./app` 无命中（`PROJECT_NOT_FOUND`，候选为空），不再静默落到 A；A 的绝对路径仍按路径层命中 A（`path`）。

改动前同一新腿为红，失败行（逐字）：
```
[i] query="app" -> {"ok":true,"id":"p-cwd-app","matchType":"path","matched":{"id":"p-cwd-app","title":"something-else","path":"/data/home/yale/work/claudecodeui-worktrees/gap-mcp-resolve-target-path-layer-resolves-relative-names-against-server-cwd/app","matchType":"path"}}
  AssertionError [ERR_ASSERTION]: a bare name must resolve by title, not by the cwd path
      at TestContext.<anonymous> (/data/home/yale/work/claudecodeui-worktrees/gap-mcp-resolve-target-path-layer-resolves-relative-names-against-server-cwd/server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts:419:10)
    actual: 'p-cwd-app',
    expected: 'p-elsewhere-app',
```
（红时裸名 `app` 被 `path.resolve` 按服务 cwd 补成 `<cwd>/app`，以 `matchType: 'path'` 命中标题为 `something-else` 的项目 A。）

### AC 第 2 条 — 取假

变异 diff：`if (kind === 'project' && path.isAbsolute(query)) {` → `if (kind === 'project') {`（删掉 `path.isAbsolute` 守卫）。重跑 precedence 单文件读数 `ℹ pass 9  ℹ fail 1`，失败行（逐字）：
```
[i] query="app" -> {"ok":true,"id":"p-cwd-app","matchType":"path","matched":{"id":"p-cwd-app","title":"something-else","path":"/data/home/yale/work/claudecodeui-worktrees/gap-mcp-resolve-target-path-layer-resolves-relative-names-against-server-cwd/app","matchType":"path"}}
  AssertionError [ERR_ASSERTION]: a bare name must resolve by title, not by the cwd path
      at TestContext.<anonymous> (/data/home/yale/work/claudecodeui-worktrees/gap-mcp-resolve-target-path-layer-resolves-relative-names-against-server-cwd/server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts:419:10)
    actual: 'p-cwd-app',
    expected: 'p-elsewhere-app',
```
恢复守卫后重跑两文件判据 18/18 通过（退出码 0）。

### AC 第 3 条 — typecheck

`npm run typecheck`（`tsc --noEmit -p tsconfig.json && tsc --noEmit -p server/tsconfig.json && tsc --noEmit -p scripts/tsconfig.json`）退出码 0。

### DoD — 真实服务实例

用 `scripts/mcp-smoke.mjs` 的 `bootServer`（临时 `DATABASE_PATH`、随机 `listen(0)` 端口、cwd = worktree 根）起真实例，**未触碰运行中的 CloudCLI 服务**（`assertSafePort` 拒绝 3001）。播种：项目 A 位于 `<cwd>/app`、标题 `something-else`（session `dod-session-A`）；项目 B 位于临时根下 `elsewhere/app`、标题 `app`（session `dod-session-B`）。经 `/mcp`（PAT scope `cloudcli:read`）读数（逐字）：

```
[read] sessions_list {project:"app"} isError=false sessions=["dod-session-B"]
[read]   raw={"sessions":[{"id":"dod-session-B","title":"session-in-titled-app","provider":"claude","projectId":"59ae26ed-a223-4955-9e78-87e9d27f5c0a","lifecycleMode":"per-run","hostState":null,"running":false,"awaitingUser":false,"lastActivity":{"relative":"40 minutes ago","iso":"2026-10-11T10:00:00.000Z"}}],"total":1}
[read] sessions_list {project:"/data/home/yale/work/claudecodeui-worktrees/gap-mcp-resolve-target-path-layer-resolves-relative-names-against-server-cwd/app"} isError=false sessions=["dod-session-A"]
[read]   raw={"sessions":[{"id":"dod-session-A","title":"session-in-cwd-app-dir","provider":"claude","projectId":"e06b5893-8a12-4de7-a1e4-1b4f29649533","lifecycleMode":"per-run","hostState":null,"running":false,"awaitingUser":false,"lastActivity":{"relative":"40 minutes ago","iso":"2026-10-11T10:00:00.000Z"}}],"total":1}
```

裸名 `app` 命中 B（projectId `59ae26ed…`，标题 `app`），A 的绝对路径命中 A（projectId `e06b5893…`）。收尾：`server.stop()`、删除 `<cwd>/app` 与临时根；`git status` 只剩两个改动文件，无残留进程/目录。