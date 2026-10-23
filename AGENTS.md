# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

### UI 验证

凡改动 UI 的任务，Definition of Done 必须包含下面两条：

1. **MCP 浏览器实际操作 + 截图**：在真实运行的页面上把改动涉及的交互亲手走一遍，截图存 `tmp/`，并在任务里贴出。
2. **场景运行器报告**：存在可用场景时，同时跑 `node scripts/ui-scenario.mjs <scenario.json> …` 并贴出 JSON 报告与检查点截图；大颗粒度的业务场景回归以运行器为准，MCP 浏览器用于视觉验证与探索。

排查失败步时，优先用 `browser_evaluate('window.__cloudcliScenario.read()')` 一次取结构化读数（焦点、可见集、托盘、输入包、各步耗时），不要用整页 snapshot 反推。语义面只在开发构建、且 `?ui-scenario=1` 或 `localStorage['ui-scenario'] = 'on'` 时挂载，生产构建里不存在。

## Running tests

Never run an unbounded multi-file `--test` fan-out, or the full suite, from inside a session: the
session's cgroup caps at 8G and the kernel OOM-kills it (exit 137). Scale the runner to what you
are about to run — one file directly, a glob under `with-memory-cap.sh` with a concurrency clamp,
the full suite only in quay's fan-in. The rules and the table are in
`docs/operations/process-isolation-and-memory-caps.md` → "Running tests from a Claude session".
