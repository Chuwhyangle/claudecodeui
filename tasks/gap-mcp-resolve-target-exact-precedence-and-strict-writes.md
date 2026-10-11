---
id: gap-mcp-resolve-target-exact-precedence-and-strict-writes
title: MCP 目标解析按精确优先（AC-333）：精确 id、完整路径、唯一精确标题先于子串；写工具只接受精确目标，子串只用于只读发现
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

- [ ] AC-333 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts`，覆盖 AC-333 读数 (a)–(h)。
- [ ] AC-333 的取假形态 (i)–(iv) 逐条执行：每条记录变异 diff、逐字失败行与恢复命令，写进本任务的完成记录。
- [ ] 下列既有判据逐文件运行退出码 0（tsx runner）：`mcp-session-lifecycle.test.ts`、`mcp-write-notification.test.ts`、`mcp-error-envelope.test.ts`、`mcp-english-only.test.ts`、`mcp-tool-annotations.test.ts`、`mcp-invalid-argument.test.ts`、`mcp-read-tools.test.ts`，以及 `server/shared/tests/quay-test-script.test.ts`。
- [ ] `npm run typecheck` 退出码 0。

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
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-resolve-target-exact-precedence-and-strict-writes.md（self）
