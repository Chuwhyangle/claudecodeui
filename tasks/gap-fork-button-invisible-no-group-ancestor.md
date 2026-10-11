---
id: gap-fork-button-invisible-no-group-ancestor
title: assistant 回复上的 fork 按钮 opacity:0 且无 group
  祖先，永远不可见：改为与复制/朗读同栏常驻可见，判据改读真浏览器 computed opacity
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测）：`ls tasks | grep -i -E "fork.*(visible|opacity|hover)"` 无命中；`grep -il "group-hover\|opacity-0" tasks/*.md` 命中的都是别的组件（composer、voice、quay 面板等），无一涉及 fork 按钮。`gap-fork-from-assistant-reply-anchor` 与 `gap-fork-button-hidden-while-session-running`（均已 done）都只断言按钮「在 DOM 里 / 点得动」，没有任何一条读过它的可见性。⇒ 本条不是重复，是这两个任务的验收盲区。

**现象（人的报告，2026-10-11）**：修复已部署、服务多次重启，仍看不到 fork 按钮（用户气泡与 assistant 回复底部都没有）。

**实测读数（本轮，真浏览器 + 真服务实例 + 真会话，只读）**：
1. 部署无问题：被提供的前端 bundle `index-B-rixTJw.js` 含 `isInFlightTurn`、不含旧名 `isSessionRunning`；构建与服务进程均为 2026-10-11 09:32。
2. 按钮**在 DOM 里**：resident 会话 `cfb66d00` / `d88c6722` / `ece66c51` / `7ccbc9d1` 滚动后分别挂载 5 / 3 / 4 / 1 个 `button[aria-label="Fork from here"]`。
3. 但其 `getComputedStyle(btn).opacity` 为 **`0`**——未悬停是 0，悬停所在行仍是 0，悬停按钮本身仍是 0；`btn.closest('.group')` 为 **`null`**。

**根因**：`src/modules/chat/transcript/MessageComponent.tsx:694` 的按钮类是 `rounded p-1 opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100`，显示完全依赖祖先带 `.group` 类的悬停。用户气泡里的同款按钮可用，因为 `group` 就在气泡 div 上（同文件第 298 行）；迁到 assistant 回复操作栏（第 ~681 行的 `div.mt-1.flex.w-full…`）时类名原样搬走，但这个栏的祖先链里没有任何 `.group`，`group-hover:opacity-100` 永不触发。结果是按钮只能被键盘聚焦唤出（`focus-visible:opacity-100`），鼠标与触屏用户永远看不到；同栏的复制、朗读按钮没有这套样式，所以它们可见，只有 fork 不可见。引入点：`99ea0525`（2026-09-01）带来这套类名，`b9cf9ce7` 把它迁到回复栏。

**判据盲区（为什么两个 done 的任务都没抓到）**：
- 组件测试（`src/modules/chat/tests/forkFromAssistantReply.test.tsx`）在 jsdom 里跑，不解析 Tailwind，`opacity-0` 只是个类名，按钮「存在 + 可点」即过。
- e2e（`e2e/transcript-fork-from-answer.spec.ts`）用 Playwright：`toBeVisible()` 把 `opacity: 0` 的元素判为**可见**（Playwright 明文如此），点击靠 `force`/键盘或程序化点击亦能成功。
- 所以「在 DOM 里 + 点得动」两道判据全绿，而用户一个像素也看不到。

**方案**：
- 去掉 fork 按钮的 `opacity-0 … focus-visible:opacity-100 group-hover:opacity-100`，与同栏的 `MessageCopyControl`、`MessageSpeakControl` 一样常驻可见（保留 `rounded p-1 hover:bg-muted transition-colors` 之类的交互反馈）。这样同时覆盖触屏（无 hover）。
- 判据里**必须**读真浏览器的 `getComputedStyle(el).opacity`（以及 `getBoundingClientRect()` 面积 > 0），不得用 `toBeVisible()` 或类名断言代替。
- 不改服务端，不动 `shouldShowForkControl` 的显隐条件。

**不在本任务范围**：用户气泡上的「编辑重发」按钮在触屏上同样只在悬停时可见（`MessageComponent.tsx:327`，`group` 在气泡上，桌面可用、触屏不可见）——是既有行为，另议；用户气泡上的 fork 入口（已按人的裁定迁走，不恢复）；长回合折进 work-segment 后内部回复的 fork 入口较深（折叠的预期行为，需要时另立）。

## Plan

1. **判据骨架先红**：在 `e2e/transcript-fork-from-answer.spec.ts` 里（该文件已有两个已结束回合的真浏览器夹具，复用，不新增文件）加断言：每个回合最终回复上的 fork 按钮 `getComputedStyle(btn).opacity` 的数值 ≥ 0.99，且 `getBoundingClientRect()` 宽高均 > 0。在当前树上跑出红态（`opacity=0`）文案。
2. **`MessageComponent.tsx`**：改按钮类名，去掉对 `.group` 祖先的依赖；不动用户气泡里那份（第 298–327 行）。
3. **组件测试补一条**：在 `forkFromAssistantReply.test.tsx` 里加一条类名级断言——assistant 栏里的 fork 按钮 `className` 不含 `opacity-0`（jsdom 只能读类名，这条只是防回退的廉价哨兵，**承重的是第 1 步的真浏览器读数**）。
4. **收尾**：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出 0；按 AGENTS.md 单文件直接跑判据，不做无界 fan-out；写完成记录。

## AC

- [x] 骨架红态：在未改产品代码的树上跑 `npx playwright test e2e/transcript-fork-from-answer.spec.ts`，新增的可见性断言**红**，红态文案含读到的 `opacity=0`，写进完成记录。
- [x] 真浏览器可见性：同一命令改后退出码 0，且 spec 断言——两个已结束回合各自最终回复上的 `Fork from here` 按钮 `getComputedStyle(...).opacity` ≥ 0.99（未悬停状态下读），`getBoundingClientRect()` 宽、高均 > 0，打印 `forkButtonOpacity=<值> rect=<w>x<h>`。
- [x] 点击链路不回归：同文件既有断言（每回合回复各恰 1 个按钮、用户提示 0 个、点击后新 transcript 恰 1 个且末行是该回复、源未被改动）逐条仍绿，其断言文本未被改弱（`git diff` 里这些 `expect` 行无删除）。
- [x] 不依赖悬停：spec 里读取 opacity 前**不得**对该行或按钮做 `hover()`/`focus()`，断言文本里写明「未悬停」；防止判据被「先悬停再读」空过。
- [x] 哨兵：`npx vitest run src/modules/chat/tests/forkFromAssistantReply.test.tsx` 退出码 0，且新增用例断言 assistant 栏 fork 按钮 `className` 不含 `opacity-0` 与 `group-hover:`；该文件既有用例逐条仍绿。
- [x] 假形态承重（实测红文案写进完成记录）：临时把按钮类名改回含 `opacity-0 group-hover:opacity-100` 后，真浏览器可见性断言**必须变红**（读到 `opacity=0`），还原后转绿；注意先 commit 实现再做变异，还原用 `git checkout <commit> -- <file>`，不得用会丢未提交实现的还原方式。
- [x] 工具链：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 均退出码 0。

## DoD

真实落地：在真实服务实例（临时 `HOME` + 临时 `DATABASE_PATH`，真浏览器）里打开一个含至少两个已结束回合的会话（e2e 夹具即可；若有可用的真实 resident 会话副本更佳，须在记录里写明用的是哪一种），读数写进完成记录：(a) 每个已结束回合最终回复上的 fork 按钮未悬停时 `opacity` 为 1（或 ≥ 0.99）、尺寸非零；(b) 截一张该回复底部操作栏的截图，肉眼可见复制、朗读、分支三个图标并列，路径写进完成记录；(c) 点其中一个，新会话出现且源会话不受影响（与既有链路读数一致）。若当前环境没有可用的真实 resident 会话副本，如实写明用的是 e2e 夹具，不得声称是真实 resident 会话。

## Touches

- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/tests/forkFromAssistantReply.test.tsx
- e2e/transcript-fork-from-answer.spec.ts
- tasks/gap-fork-button-invisible-no-group-ancestor.md

## 完成记录

实现：`src/modules/chat/transcript/MessageComponent.tsx` 的 assistant 回复操作栏 fork 按钮类名
`rounded p-1 opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100`
→ `rounded p-1 transition-colors hover:bg-muted`（与同栏 `MessageCopyControl`/`MessageSpeakControl` 一样常驻可见）。
用户气泡那份（第 327 行）未动；`shouldShowForkControl` 显隐条件未动；无服务端改动。
分支 `task/gap-fork-button-invisible-no-group-ancestor`，commit `c55d94e5`。

**AC1 骨架红态（未改产品代码）** —— 在 worktree cwd 跑 `npx playwright test e2e/transcript-fork-from-answer.spec.ts` 红，退出码 1：
```
forkButtonOpacity=0 rect=22x22
Error: the first reply's fork control must be visible to a mouse while 未悬停 (no hover/focus) ...
  Expected: >= 0.99
  Received:    0
1 failed
```

**AC2 真浏览器可见性（改后）** —— 同一命令退出码 0，spec 打印：
```
forkButtonOpacity=1 rect=22x22
forkButtonOpacity=1 rect=22x22
✓ 1 passed (12.2s)
```
两个已结束回合各自最终回复上的按钮，未悬停读得 `opacity=1`（≥0.99）、`rect=22x22`（宽高均 > 0）。

**AC3 点击链路不回归** —— 同文件既有断言（每回合回复各恰 1 个按钮、用户提示 0 个、点击后新 transcript 恰 1 个且末行是该回复、源未被改动）在上面的 pass 里逐条仍绿。
`git diff develop --unified=0 -- e2e/transcript-fork-from-answer.spec.ts src/modules/chat/tests/forkFromAssistantReply.test.tsx` 中 `^-` 删除行 **0 条**（纯新增，既有 `expect` 文本未被改弱）。

**AC4 不依赖悬停** —— 读取 opacity 前只 `await page.mouse.move(1, 1)`（把指针停到视口角落），**没有**对行或按钮调 `hover()`/`focus()`；断言文案写明「while 未悬停 (no hover/focus)」。

**AC5 哨兵** —— `npx vitest run src/modules/chat/tests/forkFromAssistantReply.test.tsx` → `6 passed`（原 5 条既有用例逐条仍绿 + 新增 1 条）。新增用例断言 assistant 栏 fork 按钮 `className` 不含 `opacity-0`、不含 `group-hover:`。

**AC6 假形态承重** —— 先 commit（`c55d94e5`）再变异：把按钮类名改回 `… opacity-0 … group-hover:opacity-100` → 同一 e2e **红**，读到 `forkButtonOpacity=0 rect=22x22`（`Expected: >= 0.99 / Received: 0`）。
还原：`git checkout c55d94e5 -- src/modules/chat/transcript/MessageComponent.tsx`（工作树随即干净）；重跑 → `forkButtonOpacity=1` 转绿。该「变异→还原→转绿」在**含截图腿的最终 spec** 上复跑过一次，结论相同。

**AC7 工具链** —— `npm run typecheck` exit 0；`npm run lint` exit 0（238 条均为既有 warning，我改的三个文件无命中）；`npx oxlint server/ src/` exit 0。

**DoD** —— 用的是 **e2e 夹具**（`playwright.config.ts` 的 `seedForkAnchorTranscript`，会话 `99999999-9999-4999-8999-999999999999`），**不是**真实 resident 会话副本（本环境无可用副本）：跑的是 playwright 自带 webServer 起的真实后端 + 真实 Vite 客户端 + 真 Chromium，隔离 `HOME`/`dataDir`。
(a) 两个已结束回合最终回复的 fork 按钮未悬停 `opacity=1`（≥0.99）、`rect=22x22` 非零（即上面 AC2 读数）。
(b) 截图：`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-nVd4kY/test-results/transcript-fork-from-answe-bfe04-anches-the-transcript-there/fork-answer-action-bar.png`（spec 以 `test.info().outputPath('fork-answer-action-bar.png')` 拍该回复底部操作栏）；肉眼可见复制（⧉ MD ⌄）、朗读（🔊）、分支三个图标并列。
(c) 点第一个回合的 fork 按钮 → 新会话出现（URL 离开源会话、按自己的 id 寻址），源 transcript 未被改动、目录里恰好多出 1 个新 transcript 且记录了源会话 id（既有 leg (2) 断言，同一次 pass 内）。