---
id: gap-ui-scenario-runner-selects-visible-project-row-and-names-missing-surface
title: ui-scenario 运行器：选项目要点可见行，缺语义面要说清原因
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 相关但机制不同：`gap-chat-banners-paused-pending-signal-redesign`（已 done）只在 DoD 里记录了现象并改用一次性 Playwright 绕过，运行器本身没人修；本任务修运行器。已查 `task-granularity-advice`：没有 Touches 同文件的在飞任务，决定：独立立案。

背景（2026-10-25 在 `Pin to wall` 星标与会话时间重叠的修复验证中复现）：`node scripts/ui-scenario.mjs e2e/scenarios/cockpit-mode-switch.json --base-url <实例> --auth-token <token> --project claudecodeui --session <名>` 与 `quay-wall-focus-pin-utter.json` 均 exit 2，stderr 为 `the fixture project "claudecodeui" never appeared in the sidebar`（`scripts/ui-scenario.mjs` 的 `selectProjectSession`）。会话行类 UI 改动因此没有可用的场景运行器报告，AGENTS.md 的 UI 验证第 2 条只能写成「未跑起来」。两个独立的机制：

1. **选中不可见元素**：`selectProjectSession` 用 `page.getByText(project, { exact: true }).first()` 并等它 `visible`。侧栏项目行把 displayName 与路径后缀并列渲染，displayName 的 `<span class="truncate">` 在 flex 挤压下宽度为 0，`.first()` 恰好命中它，Playwright 判为不可见，超时后误报「项目从未出现」。修法：在所有精确匹配里取第一个**可见**的（`locator.filter({ visible: true })` 或逐个 `isVisible`），点它；会话行同理。
2. **缺语义面时报错不可读**：语义面（`window.__cloudcliScenario`）只在开发构建挂载（`import.meta.env.DEV`），隔离实例（`scripts/isolated-instance.sh`）跑的是生产 dist，运行器在 `waitForSurface` 等满 `BOOT_TIMEOUT_MS` 后给出泛化超时。修法：等待失败时抛出点名原因的错误（语义面未挂载，需要开发构建；并给出启动方式），仍走 exit 2。

不做：不新增场景、不改 `window.__cloudcliScenario` 的读数/断言词表、不改侧栏渲染本身。

## AC

- [x] `e2e/ui-scenario-runner.spec.ts` 新增用例（标题含 `zero-width`）：夹具里项目名 span 先于可见行出现且宽度为 0，运行器仍以 exit 0 跑完 `cockpit-mode-switch.json`；命令 `bash scripts/with-memory-cap.sh npx playwright test e2e/ui-scenario-runner.spec.ts -g "zero-width"` 退出码 0。
- [x] 同文件新增用例（标题含 `without the semantic surface`）：把运行器指向一个不挂语义面的静态页，断言 exit 2 且 stderr 含 `semantic surface`，并在 `BOOT_TIMEOUT_MS` 内返回；`... -g "without the semantic surface"` 退出码 0。
- [x] 既有两臂不退化：`bash scripts/with-memory-cap.sh npx playwright test e2e/ui-scenario-runner.spec.ts -g "the UI scenario runner on the Quay wall"` 退出码 0。
- [x] `node --check scripts/ui-scenario.mjs` 退出码 0。

## DoD

在真实对象上各走一次并贴出输出：(a) 开发构建的真实侧栏（项目名 span 实测宽度为 0）上，`node scripts/ui-scenario.mjs e2e/scenarios/cockpit-mode-switch.json --project claudecodeui --session <真实会话名>` 现在 exit 0，JSON 报告与检查点截图存 `tmp/`；(b) 对 `scripts/isolated-instance.sh start` 起的生产构建实例跑同一命令，exit 2 且 stderr 明确说明「语义面未挂载、需要开发构建」，不再是泛化超时。夹具与单测只是必要条件，不算完成。

## Evidence

- AC1 `-g "zero-width"` → `1 passed (3.2s)`。夹具自检通过：decoy span `getBoundingClientRect().width === 0`、Playwright `toBeHidden()`、且在精确匹配里 DOM 先于可见行（`firstIsDecoy=true`）；运行器 `exit 0`、`stepCount=3`、3 张检查点截图非空。
- AC2 `-g "without the semantic surface"` → `1 passed (32.2s)`；运行器 `exit 2`、`stdout` 无报告、stderr 含 `semantic surface`，30.5s 结束（受 `BOOT_TIMEOUT_MS` 约束，不是挂死）。
- AC3 `-g "the UI scenario runner on the Quay wall"` → `1 passed, 1 skipped (12.7s)`，命令退出码 0。wall 臂的 skip 是该用例既有的 `test.skip`（本机 quay-fleet registry 未登记临时夹具项目），不是新增退化。
- AC4 `node --check scripts/ui-scenario.mjs` → exit 0。
- DoD(a) 开发构建：worktree 全量构建后，`SERVER_PORT=<隔离后端> vite` 的 dev 实例（`http://127.0.0.1:6191`，语义面已挂载）。侧栏实测：`span[title="claudecodeui"]` 宽 `0`；`getByText("claudecodeui",{exact:true}).first()` resolved=1 `visible=false`；`filter({visible:true})` count=`0`（即只按「第一个可见匹配」仍选不到，必须点它所属的行）。
  `node scripts/ui-scenario.mjs e2e/scenarios/cockpit-mode-switch.json --base-url http://127.0.0.1:6191 --auth-token <token> --project claudecodeui --session "会话列表 Pin to wall 按钮位置重叠" --out tmp/dod/dev` → **exit 0**，stderr `ui-scenario: passed (3 steps, 4293ms, 3 checkpoint(s))`。报告 `tmp/dod/dev/report.json`；截图 `tmp/dod/dev/step-1-open-session.png` (228577 B)、`step-2-open-cockpit.png` (29700 B)、`step-3-open-session.png` (26016 B)；侧栏截图 `tmp/dod/dev-sidebar.png`。
- DoD(b) 生产构建实例：`bash scripts/isolated-instance.sh start`（worktree 的 `dist/` + `dist-server/` 全量构建，:6091，residentRestore disabled）。同一命令 → **exit 2，33s**，stderr：
  `ui-scenario: Error: the semantic surface (window.__cloudcliScenario) was not mounted within 30000ms. It is installed only by a development build: main.tsx gates it on import.meta.env.DEV plus localStorage['ui-scenario']='on'. A page served from a production dist/ build (for example an instance started by scripts/isolated-instance.sh) has no semantic surface to drive. Point --base-url at the Vite dev server instead (npm run client, or npm run dev).`
  stdout 0 字节（不再是无信息量的泛化超时）。证据：`tmp/dod-production-stderr.txt`。

## Touches

- scripts/ui-scenario.mjs
- e2e/ui-scenario-runner.spec.ts
- tasks/gap-ui-scenario-runner-selects-visible-project-row-and-names-missing-surface.md
