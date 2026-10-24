---
id: gap-reply-suggestions-compact-footer-icon-only-suggest
title: 窄屏底栏：「建议」按钮改纯图标，修复有字时发送按钮被挤出屏幕（360/375px）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-24 在 :3001 真实页面上用 MCP 浏览器量过窄屏底栏（紧凑档）：输入框**有字**时，360px 宽的底栏 `scrollWidth` 368 对 `clientWidth` 342，溢出 26px；375px 溢出 11px（`scrollWidth` 368 对 357）；发送按钮的右边缘落在 377，超出表单右边缘 352，发送键被切掉一截。390px 恰好放下（372 对 372）。输入框为空时 360、375 都不溢出（342 对 342、357 对 357），所以前端任务的 DoD 当时没有抓到。

**原因。** 紧凑档底栏原本的预算是「六个主控件，不得换行」。后来加了带文字的「建议」按钮（宽 61px，约是其他按钮 32px 的两倍），有字时又多出清空 ✕（32px），总宽 368px。✕ 的隐藏阈值定在 360px 以下（`max-[359px]:hidden`），而 360 和 375 恰是常见机型宽度（多数 Android 与 iPhone SE）。

**决定（yale 2026-10-24）。** 紧凑档把「建议」按钮改成**纯图标**（32px，与其他工具按钮同宽），省下约 29px：360px 的溢出 26px 变为余量约 3px，375px 余量约 18px。✕ 保留。宽屏档的带文字按钮不变。

**要做的事。**

- `src/modules/chat/composer/ChatComposer.tsx` 里「建议」按钮：紧凑档渲染一个图标（沿用文件里已有的图标库，选一个表达「建议／灵感」的图标，如闪光），不显示文字；`aria-label` 与悬停提示仍是现有的「Suggest」「Suggesting…」文案键，进行中的状态用图标自身的旋转或禁用态表达，不能因为没有文字就失去「进行中」的读数。宽屏档保持现状。
- 该按钮的点击区域不小于 32×32，键盘可聚焦，焦点环可见。
- 360–389px 区间不能再靠「某个阈值以下才隐藏」来勉强放下：有字时 ✕ 在 ≥360px 都显示；低于 360px 的隐藏规则保留，并要在 320、340px 量出不溢出。
- 更新窄屏底栏相关的两处现有钉子，**按状态改写而不是改数字**：`chatComposerResponsive.test.tsx` 的「窄屏底栏控件」用例要反映现在的真实控件集合（含图标版「建议」；有字时再含 ✕），`composerCompactTier.test.tsx` 保持「底栏不换行」。

**范围外**：模型 chip 的点击行为、chip 行遮挡输入文字等（各有单独任务）；宽屏档的按钮样式。

## AC

- [ ] 紧凑档图标版逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/tests/composerClearInput.test.tsx` 退出码 0；用例（独立）：(a) 紧凑档「建议」按钮内没有可见文字节点，`aria-label` 等于现有 Suggest 文案；(b) 宽屏档仍显示文字「Suggest」；(c) 紧凑档请求进行中按钮禁用并带进行中的无障碍标记（`aria-busy` 或文案切换为 Suggesting…）；(d) 紧凑档、有字、宽度 ≥360px 时底栏控件按顺序为：附件、建议、更多、清空、模型、权限、麦克风、发送；(e) 紧凑档、空输入框时没有清空；(f) <360px 有字时没有清空；(g) 紧凑档底栏仍是不换行的（`flex-nowrap`）。
- [ ] 无多余的宽度回退：`grep -nE "max-\[359px\]:hidden" src/modules/chat/composer/ChatComposer.tsx` 仍有输出（<360px 的隐藏规则保留），且 `grep -cE "min-w-\[?[0-9]+" src/modules/chat/composer/ChatComposer.tsx` 的值不大于改动前（不靠加最小宽度硬撑；改动前的值在 DoD 里贴出）。
- [ ] 文案：不新增文案键；`en` 与 `zh-CN` 现有的 suggest／suggesting／suggestHint 三个键仍被引用：`grep -c "input.suggestions.suggest" src/modules/chat/composer/ChatComposer.tsx` ≥ 2。
- [ ] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面读数，缺一不可；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，不碰常驻 :3001，不重启常驻服务）；不要在运行中的会话页面按 Escape。MCP 浏览器的视口分别设为 320、340、360、375、390、412 像素宽，选可选模型里**名字最长**的一个。

- [ ] 每个宽度下，输入框**有字**与**为空**两态各取一次读数并贴出：底栏 `scrollWidth`、`clientWidth`、发送按钮右边缘与表单右边缘的差；要求溢出为 0（发送按钮完整在表单内）。360 与 375 两档是此前的失败点，要特别列出改动前后的对比（改动前值：360px 有字溢出 26px，375px 溢出 11px）。
- [ ] 360px 有字时底栏截图一张，375px 一张，390px 一张，320px 一张；贴出截图。
- [ ] 点图标版「建议」：贴请求读数（一次 POST）、点击中的进行状态截图、完成后 chip 被替换的截图。
- [ ] 键盘 Tab 到该按钮时焦点环可见（截图）；悬停提示显示「Suggest」文案。
- [ ] 开始打字的瞬间，右侧模型按钮的左边界移动的像素值（空 → 有字）贴出，确认没有可见跳动或被挤压变形。
- [ ] 宽屏（1280px）下按钮仍是带文字的版本，贴截图。

## Touches

- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/tests/chatComposerResponsive.test.tsx`
- `src/modules/chat/tests/composerCompactTier.test.tsx`
- `src/modules/chat/tests/composerClearInput.test.tsx`
- `tasks/gap-reply-suggestions-compact-footer-icon-only-suggest.md`
