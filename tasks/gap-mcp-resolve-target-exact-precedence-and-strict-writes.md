---
id: gap-mcp-resolve-target-exact-precedence-and-strict-writes
title: MCP 目标解析按精确优先（AC-333）：精确 id、完整路径、唯一精确标题先于子串；写工具只接受精确目标，子串只用于只读发现
status: done
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

**Finding（2026-10-11，代码核实 + 审计读数）：** `server/modules/mcp-gateway/mcp-resolve-target.ts:154-194` 的 `resolveMcpTarget` 只有两层：先做精确 id 匹配（逐字），再做不区分大小写的标题**子串**匹配，唯一命中才接受。**没有「精确标题」层，也不匹配项目路径。** 结果是 `sessions_list(project="quay")` 和 `quay_snapshot(project="quay")` 只要还存在 `quay-web`、`foo-quay` 这类标题，就必然得到 `TARGET_AMBIGUOUS`，调用方只能先 `projects_list` 再改用 UUID。审计表 `mcp_audit_log` 在 10-07 至 10-11 记录 `sessions_list` 失败 32/145 次（22%），是所有工具中失败率最高的（审计不存错误码，所以这个归因是吻合而非证明）。另外，写工具在子串唯一命中时会默默执行，这与外部 Agent 2026-10-11 的裁定 D1 冲突：写操作只允许 UUID、规范化完整路径或唯一精确名称。

**要交付（AC-333，GOAL-039）：**

1. `resolveMcpTarget` 的优先级改为：精确 id（逐字，现状）→ *(仅项目)* 规范化绝对路径相等（`path.resolve` 并去掉末尾分隔符，不跟随 symlink）→ 去首尾空白后区分大小写的精确标题唯一命中 → 不区分大小写的精确标题唯一命中 → 子串唯一命中（现状）→ 歧义或无命中。某一层有多个命中时，在该层直接报 `TARGET_AMBIGUOUS`，不再向下一层退。
2. `McpResolveEntry` 增加可选字段 `path`。`server/index.ts` 的 `resolveDeps.listProjects` 填入 `project_path`；会话不填。返回结果增加 `matchType: 'id' | 'path' | 'exact_title' | 'exact_title_ci' | 'substring'`。候选列表逐条带 `{id, title, path?, matchType}`。只增字段，不删字段。
3. 写工具严格性：`resolveInputTargets` 需要知道当前工具是否只读。只读与否**从 `MCP_TOOL_ANNOTATIONS` 的 `readOnlyHint` 派生**（`mcp-tool-annotations.ts`），不另写一份工具名单。工具不是只读、且命中层是 `substring` 时，抛出 `McpToolError('TARGET_AMBIGUOUS', …, false, {query, kind, reason: 'exact_target_required', candidates: [那一条]})`，消息为英文，说明「写操作需要 id、完整路径或精确标题」。处理函数不得被调用。
4. 错误码沿用 `TARGET_AMBIGUOUS`，不新增词表项（D1 要求兼容）。各工具 `_meta['cloudcli/errorCodes']` 的声明若因此需要给写工具补 `TARGET_AMBIGUOUS`，同步补上。
5. 更新 `project` / `session` 参数的描述文本（英文），写明优先级和写工具只接受精确目标。描述集中在哪里就改哪里，不散改。
6. **新判据文件** `server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts` 承载 AC-333 的 (a)–(h)。断言必须写在新文件里：AC-333 的判据带存在性闸，如果只改既有文件，判据会在动工前就空过。既有 `mcp-resolve-target.test.ts` (f) 的正向对照目前用 `session: 'Solo Active'`（子串）调 `session_send`，在新语义下会被拒。改为用精确标题 `'Solo Active Session'` 到达处理函数，并在同一条腿里增加「子串 `'Solo Active'` 被拒、`reason` 为 `exact_target_required`、调用计数为 0」，断言强度不降。
7. 计数钉同步：新增一个服务端测试文件，必须同步 `server/shared/tests/quay-test-script.test.ts` 钉住的测试文件总数（AC2、AC3 两处），并向 `scripts/suite-duration-baseline.tsv` 追加新文件的耗时行。否则全队 suite 变红，且被报为 UNATTRIBUTABLE。

**回归面（立案时已 grep）：** 全仓以字面量名称调用写工具的只有三处：`mcp-resolve-target.test.ts:563`（需改，见第 6 条）、`mcp-session-lifecycle.test.ts:752`（`'Alpha'` 多命中仍报歧义，不受影响；它的唯一命中分支用的是 id）、`mcp-write-notification.test.ts:639`（`no-such-project` 无命中，不受影响）。

## AC

- [x] AC-333 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts`，覆盖 AC-333 读数 (a)–(h)。
- [x] AC-333 的取假形态 (i)–(iv) 逐条执行：每条记录变异 diff、逐字失败行与恢复命令，写进本任务的完成记录。
- [x] 下列既有判据逐文件运行退出码 0（tsx runner）：`mcp-session-lifecycle.test.ts`、`mcp-write-notification.test.ts`、`mcp-error-envelope.test.ts`、`mcp-english-only.test.ts`、`mcp-tool-annotations.test.ts`、`mcp-invalid-argument.test.ts`、`mcp-read-tools.test.ts`，以及 `server/shared/tests/quay-test-script.test.ts`。
- [x] `npm run typecheck` 退出码 0。

## DoD

在真实服务实例（非夹具）上实际操作一次。用 `scripts/mcp-smoke.mjs` 的 `bootServer` 从 worktree 起真 `server/index.ts`，临时 `DATABASE_PATH`、`listen(0)` 端口；**不得重启或改动正在运行的 CloudCLI 服务**。播种真 PAT 与四个项目：`quay`、`quay-web`、`foo-quay` 及一个同名对照。经 `/mcp` 调用并读数：
- `sessions_list {project:"quay"}` 成功；
- `quay_snapshot {project:"quay"}` 不报 `TARGET_AMBIGUOUS`（项目无 `.quay` 配置时得到 `no_quay_config` 也算解析成功）；
- `session_create {project:"qua", provider:<debug agent>}` 返回 `TARGET_AMBIGUOUS` 且 `details.reason=exact_target_required`，库里没有新会话行；
- `session_create {project:<quay 的绝对路径>, provider:<debug agent>}` 成功。

逐字记录四次调用的请求与响应摘要。仅有测试夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-resolve-target.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-resolve-target-exact-precedence-and-strict-writes.md（self）

## 完成记录

实施提交：`af7009bb`（分支 `task/gap-mcp-resolve-target-exact-precedence-and-strict-writes`）。

### AC-333 判据（AC 第 1 条）

命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts`
读数：`ℹ tests 17  ℹ pass 17  ℹ fail 0`，退出码 0。新文件的 `[fixture] write tools (15)=[…]` 行确认写工具集合来自 `MCP_TOOL_ANNOTATIONS` 本身（含 `approval_answer`、`session_send`、`session_interrupt`、`session_close`、`session_create` 等）。

### AC-333 取假形态 (i)–(iv)（AC 第 2 条）

每条：先在 `mcp-resolve-target.ts` 上施加变异 → 逐字运行上面的两文件命令 → 记录失败行 → `git -C <worktree> restore server/modules/mcp-gateway/mcp-resolve-target.ts` 复原。四次复原后 `git status --porcelain` 为空，重跑判据 17/17 通过（退出码 0）。

**(i) 删除区分大小写的精确标题层**（变异 diff：删去 `resolveMcpTarget` 中 `// Layer 3 — a trimmed, case-SENSITIVE exact title.` 至 `if (exactTitle.length > 1) { return ambiguous(…'exact_title'…); }` 整块）。
失败行（逐字）：
```
✖ (c) a unique case-sensitive exact title resolves, beating the ambiguous substring
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'exact_title_ci'
  - 'exact_title'
      at …tests/mcp-resolve-target-precedence.test.ts:212:10
```
同因连带红：(d) `:226`、(e) `:253`、(h) `:347`。恢复命令：`git -C <worktree> restore server/modules/mcp-gateway/mcp-resolve-target.ts`。

**(ii) 写工具接受子串**（变异 diff：删去 `resolveOrThrow` 中 `if (strict && result.matchType === 'substring') { …reason: 'exact_target_required'… }` 整块，写工具退回只读语义）。
失败行（逐字）：
```
✖ (g) every write tool (from the annotations table) refuses a substring-only target
  AssertionError [ERR_ASSERTION]: Missing expected exception: approval_answer must refuse a substring-only target
      at …tests/mcp-resolve-target-precedence.test.ts:307:12
```
连带红：(h) `:372`。恢复命令同上。

**(iii) 不区分大小写的精确标题层排到区分大小写层之前**（变异 diff：在 `resolveMcpTarget` 中交换 Layer 3 与 Layer 4 两个整块的位置）。
失败行（逐字）：
```
✖ (d) a case-insensitive exact title resolves only after the case-sensitive layer
  AssertionError [ERR_ASSERTION]: expected a resolution, got {"ok":false,"code":"TARGET_AMBIGUOUS","query":"quay","kind":"project","candidates":[{"id":"p-quay-upper","title":"Quay","path":"/work/quay-upper","matchType":"exact_title_ci"},{"id":"p-quay-lower","title":"quay","path":"/work/quay-lower","matchType":"exact_title_ci"}],"message":"2 projects match \"quay\"; name exactly one — the gateway will not pick for you."}
      at ok (…tests/mcp-resolve-target-precedence.test.ts:114:10)
      at …tests/mcp-resolve-target-precedence.test.ts:226:20
```
同因连带红：(c) `:212`、(e) `:253`、(h) `:347`。恢复命令同上。

**(iv) 手写写工具名单漏一个工具**（变异 diff：把 `const strict = toolName !== undefined && readMcpToolAnnotations(toolName).readOnlyHint === false;` 换成一份手写 14 名 `Set`，故意漏掉 `approval_answer`）。
失败行（逐字）：
```
✖ (g) every write tool (from the annotations table) refuses a substring-only target
  AssertionError [ERR_ASSERTION]: Missing expected exception: approval_answer must refuse a substring-only target
      at …tests/mcp-resolve-target-precedence.test.ts:307:12
```
连带红：(h) `:372`。恢复命令同上。

### 既有判据（AC 第 3 条）

八个文件逐一（串行）运行 `npx tsx --tsconfig server/tsconfig.json --test <file>`，逐个退出码 0：`mcp-session-lifecycle.test.ts`、`mcp-write-notification.test.ts`、`mcp-error-envelope.test.ts`、`mcp-english-only.test.ts`、`mcp-tool-annotations.test.ts`、`mcp-invalid-argument.test.ts`、`mcp-read-tools.test.ts`、`server/shared/tests/quay-test-script.test.ts`。

### 类型检查（AC 第 4 条）

`npm run typecheck`（`tsc --noEmit` 三个 project：根、`server`、`scripts`）退出码 0。


### DoD 真服务读数（2026-10-11，由讨论会话在 develop `ff15c01d` 上补做：worker 完成记录缺这一节）

方法：探针脚本放在仓库外 `/tmp`，导入 `scripts/mcp-smoke.mjs` 的 `bootServer`、`seedAccessToken`、`mcpConnect`，起真 `server/index.ts`（临时 `DATABASE_PATH`、`listen(0)`，端口 9851，`DEBUG_AGENT=1`）。正在运行的 CloudCLI 服务未被触碰。播种 5 个项目：`quay`、`quay-web`、`foo-quay`、两个标题都是 `app` 的目录。用真 PAT 经 `/mcp` 调用：

1. `sessions_list {project:"quay"}` → `isError:false`，`{"sessions":[],"total":0}`（改动前应为 TARGET_AMBIGUOUS）。
2. `quay_snapshot {project:"quay"}` → `isError:false`，`{"status":"no_quay_config","project":"p-quay"}`。
3. `session_create {project:"qua",provider:"debug"}` → `TARGET_AMBIGUOUS`，3 个候选，每个都带 `path` 与 `matchType:"substring"`；会话行数 0→0。（DoD 原文用 `qua` 想测 `exact_target_required`，但 `qua` 命中 3 个项目，走的是多义分支，所以补测了 3b。）
4. `session_create {project:"<临时目录>/ws/quay",provider:"debug"}` → `isError:false`，返回 sessionId；会话行数 1。
5. （3b）`session_create {project:"web",provider:"debug"}`，`web` 只以子串命中 `quay-web` 一个项目 → `TARGET_AMBIGUOUS`，`details.reason:"exact_target_required"`，候选恰为 `quay-web` 一条；会话行数 1→1。
6. （3c）`sessions_list {project:"web"}` → `isError:false`（只读工具仍可凭子串发现）。
7. 同名对照：`sessions_list {project:"app"}` → `TARGET_AMBIGUOUS`，两个候选，`matchType:"exact_title"`，各自带不同 `path`。

结束后服务进程已退出，临时目录已删除，无残留进程。

**复核中发现的后续缺陷**（已另立任务 `gap-mcp-resolve-target-path-layer-resolves-relative-names-against-server-cwd`）：路径层会把相对串按服务 cwd 补成绝对路径，裸名 `app` 可能静默解析到 `<cwd>/app`。现网 cwd 下没有子目录项目，所以目前没有实际误命中。