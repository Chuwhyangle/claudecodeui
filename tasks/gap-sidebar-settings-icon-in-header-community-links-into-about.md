---
id: gap-sidebar-settings-icon-in-header-community-links-into-about
title: 侧栏底部 Report Issue / Join Community / Settings 三行占掉会话列表空间：Settings
  上移为标题右侧纯图标（桌面+手机），Report Issue 与 Join Community 收进设置「关于」页
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

人 yale 2026-10-23 的裁定：侧栏底部的 Report Issue / Join Community / Settings 三个入口（`src/modules/sidebar/SidebarFooter.tsx`，桌面 3 行、手机 3 个 h-10 整行按钮）占掉过多纵向空间，挤压会话列表。处理方式：Settings 上移到顶部 CloudCLI 标题行右侧，仅保留图标；Report Issue 与 Join Community 收进 Settings；手机端同步上移为图标。

现状读数（2026-10-23，读代码）：
1. `SidebarHeader.tsx` 桌面标题行（约 L102-160）右侧已有刷新、新建、收起三个 h-7 w-7 图标；手机头部（约 L280-310）右侧有刷新、新建两个 h-8 w-8 图标。两处都没有 `onShowSettings` 入口，`SidebarContent.tsx` 在 L221 渲染头部、L703 渲染 `SidebarFooter` 并传入 `onShowSettings`。
2. 设置「关于」页 `src/modules/settings/tabs/AboutTab.tsx` 已经含 GitHub 仓库、Discord（`DISCORD_URL`）、文档、cloudcli.ai 链接，但没有 Report Issue；`SidebarFooter.tsx` 与 `SidebarCollapsed.tsx` 各自复制了一份 `DiscordIcon`，`AboutTab.tsx` 又有一份。
3. 收起态 `SidebarCollapsed.tsx` 已是纯图标，含 Settings / Report Issue / Discord 三个图标，不在本任务范围内。

要做的事：
A. `SidebarHeader` 新增 `onShowSettings` 属性：桌面标题行在 logo 与标题右侧加一个 Settings 图标按钮（`Settings` 图标，h-7 w-7，与现有三个操作图标同风格，置于刷新之前），手机头部同样加一个 h-8 w-8 图标（点击区域不小于现有手机图标）。按钮带 `title` 与 `aria-label`，文案复用现有 i18n 键 `actions.settings`。`SidebarContent.tsx` 把 `onShowSettings` 传给头部。
B. `SidebarFooter` 删除桌面与手机共 6 个入口块（Report Issue、Join Community、Settings 各两份）及 `DiscordIcon`、`GITHUB_ISSUES_URL`、`DISCORD_INVITE_URL`、`Bug`/`Settings` 导入，`onShowSettings` 属性随之移除；更新横幅、重启提示、版本品牌行保持原样。
C. 设置「关于」页补一条 Report Issue 链接（`https://github.com/siteboon/claudecodeui/issues/new`，新窗口，`rel="noopener noreferrer"`，与同页 Discord 链接同样式），文案走 i18n；Join Community 已存在则不重复添加。新增键同步补进全部 12 个 locale（`en es fr id ja ko tr zh-CN zh-TW de it ru`），`actions.reportIssue` / `actions.joinCommunity` 若不再被侧栏引用，评估后迁入 settings 命名空间或保留并说明。
D. 把 `DiscordIcon` 提取到共享位置，`AboutTab` 与 `SidebarCollapsed` 复用，去掉重复；不要为此新增跨模块深导入（遵循 `$frontend-module-standards`）。
E. 留意两条测试 mock：`tests/sidebarResize.test.ts`、`tests/sessionFilterEditor.test.tsx` 对 `SidebarFooter` 的 mock 不受属性变化影响；`tests/SidebarHeaderGoHome.test.tsx` 的 `baseProps` 要补 `onShowSettings`。

不做：不改收起态；不改 Settings 弹窗的路由与默认页；不新增下拉菜单（Report/Discord 放进已有的「关于」页，而不是 Settings 图标上的弹层）。

## AC

- [ ] `grep -nE "reportIssue|joinCommunity|DISCORD_INVITE_URL|GITHUB_ISSUES_URL" src/modules/sidebar/SidebarFooter.tsx` 无输出，且 `grep -c "onShowSettings" src/modules/sidebar/SidebarFooter.tsx` 为 0
- [ ] 新增单测（`src/modules/sidebar/tests/SidebarHeaderSettings.test.tsx`）：渲染 `SidebarHeader` 桌面与手机两个头部，各存在一个 `aria-label` 为 `actions.settings`（key-echo `t`）的按钮，点击触发一次 `onShowSettings`；`npx vitest run src/modules/sidebar/tests/SidebarHeaderSettings.test.tsx src/modules/sidebar/tests/SidebarHeaderGoHome.test.tsx` 退出码 0
- [ ] 新增单测（`src/modules/settings/tests/aboutTabCommunityLinks.test.tsx`）：渲染 `AboutTab`，存在指向 `https://github.com/siteboon/claudecodeui/issues/new` 与 `https://discord.gg/buxwujPNRE` 的链接，且均带 `target="_blank"` 与 `rel` 含 `noopener`；`npx vitest run` 该文件退出码 0
- [ ] `grep -rn "function DiscordIcon" src | wc -l` 为 1（只剩共享的一份）
- [ ] 新增的 i18n 键在 12 个 locale 里齐全：`node --test` 或 vitest 的现有 i18n 完整性测试（`src/modules/settings/tests/i18n*Completeness.test.ts`）退出码 0，且 `grep -L "<新键名>" src/modules/i18n/locales/*/settings.json` 无输出
- [ ] `npm run typecheck`（或仓库现行的前端 typecheck 命令）退出码 0；`npx eslint src/modules/sidebar src/modules/settings` 退出码 0（含 boundaries 规则）

## DoD

真实页面验证（仓库 UI 规则）：在运行的开发构建上，用 MCP 浏览器分别在 1280×800 与 390×844 两个视口走完交互并把截图存 `tmp/`：① 标题行右侧出现 Settings 图标，点击打开设置弹窗；② 在设置「关于」页看到并能点开 Report Issue 与 Join Community（只验证 href，不必真的跳转外网）；③ 侧栏底部不再有三行入口，会话列表可见高度相比改动前增加（在 PR 描述里贴前后两张截图与 `getBoundingClientRect` 读数）；④ 桌面标题在默认 288px 宽度下不被 `truncate` 成省略号。存在可用的场景运行器场景时，同时跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴 JSON 报告与检查点截图。仅有单测与类型检查不算完成。

## Touches

- src/modules/sidebar/SidebarHeader.tsx
- src/modules/sidebar/SidebarFooter.tsx
- src/modules/sidebar/SidebarContent.tsx
- src/modules/sidebar/SidebarCollapsed.tsx
- src/modules/settings/tabs/AboutTab.tsx
- src/modules/sidebar/tests/SidebarHeaderSettings.test.tsx
- src/modules/sidebar/tests/SidebarHeaderGoHome.test.tsx
- src/modules/settings/tests/aboutTabCommunityLinks.test.tsx
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- tasks/gap-sidebar-settings-icon-in-header-community-links-into-about.md
