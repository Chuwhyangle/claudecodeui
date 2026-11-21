---
id: gap-running-session-spinner-5hz
title: 运行中会话侧栏 spinner 60Hz 旋转持续占 CPU：改为 5Hz 步进并保留旋转
status: todo
labels:
  - gap
  - defect
  - ui
parent: null
children: []
extra: {}
---
## Finding

**PARKED** 临时挂起：本任务由人类主会话在独立 worktree 实现并采集线上 CDP 读数；解除前不要派发 worker。完成时删除本行。

用户在有 GPU 的笔记本上用新 bundle（`https://cloudpit.lrfz.com/assets/index-JDsoKD9U.js`）打开活跃会话，仍观察到 **20%+ CPU**；推理结束后降到约 5%。上一轮已修掉 shimmer 与 backdrop-filter，残余的持续动画只剩侧栏两只 `Loader2 animate-spin`（`SidebarSessionItem.tsx:235` 与 `ResidentMark.tsx:70`，同一 running 会话各一只）以及两个 opacity pulse。

CDP 仔细查过：

- 两只 spinner **已经有自己的 compositor layer**（LayerTree: layer 511/507，16×16，`drawsContent=true`），不是“没被提升”的问题；再包 promoted wrapper 无帮助。
- 页面有 **172 个 compositor layers**（91 个 draw content）。60fps 的旋转让合成器/GPU 每帧处理整棵 layer tree；在空白页里单个 SVG 旋转只有 ~1.2% GPU，放进这个页面后每只约 4–5%。
- 同一线上 running 会话 8s 窗口实测（有宿主噪声，看中位/相对值）：60Hz 两只 spinner **total 20.4%、GPU 9.5%、main 4.3%**；`animation: spin 1s steps(5, end) infinite` 后 **total 8.4%、GPU 3.5%、main 1.9%**；`steps(10)/2s` total 13.7%；`steps(20)/4s` total 16.0%；全动画关掉的对照 total 5.2%。
- GIF/WebP 对比（同样的 5fps）：GIF **total 11.2%、GPU 3.1%**；WebP **total 11.0%、GPU 2.7%**；两者都验证了会动（两次元素截图字节不同）。CSS `steps(5)` 的 total 更低，且没有二进制资源、能随主题配色、无需处理 GIF 的 1-bit 透明/调色板。结论：**不用 GIF/WebP，用 CSS steps(5)**。
- 用户明确要求：**5Hz 足够**，但必须仍能看到它在转。

## AC

- [ ] AC1 5Hz 规则存在且被钉住：`src/index.css` 包含 `#sidebar-panel .animate-spin { animation: spin 1s steps(5, end) infinite; }`；`src/shared/tests/globalCssRules.test.ts` 新增用例先打印 `sidebarSpinAnimation=spin 1s steps(5, end) infinite` 再断言；命令 `bash scripts/with-memory-cap.sh npx vitest run src/shared/tests/globalCssRules.test.ts --maxWorkers=1` exit 0。红态：未加规则时同一用例红在“找不到该规则”；把值改成 `linear` 时红在 timing-function 断言。
- [ ] AC2 线上实测：`npm run build:client` 后线上 `:3001` 打开同一 running 会话，5 次 10s CDP 窗口（页级 `Performance.getMetrics` + 浏览器级 `SystemInfo.getProcessInfo`）中位数满足：total ≤ 15% of one core、GPU ≤ 5%；计算样式 `getComputedStyle(spinner).animationTimingFunction` 含 `steps(5)`；`document.getAnimations()` 仍有名为 `spin` 的动画（说明还在转）；修复前对照 20.4% / GPU 9.5% 写入 Evidence。
- [ ] AC3 既有判据不回退：`bash scripts/with-memory-cap.sh npx vitest run src/shared/tests/globalCssRules.test.ts src/modules/sidebar/tests/sidebarResize.test.ts --maxWorkers=1` exit 0；`npm run typecheck`、`npm run lint` exit 0。
- [ ] AC4 GIF/WebP 结论留档：Evidence 写明二者的实测 total/GPU（GIF 11.2/3.1、WebP 11.0/2.7）与不采用的理由（比 CSS steps(5) 的 8.4/3.5 更差或相当；二进制资产、主题配色、GIF 透明质量）。

## DoD

- 规则只作用于侧栏活动指示器（`#sidebar-panel .animate-spin`），不改 spinner 的数量、图标、尺寸或语义；composer/复制按钮等一次性 spinner 不动。
- 5Hz 是 5 次/秒的步进旋转，视觉上仍能辨认出在转；不引入 GIF/WebP/APNG 资源。
- 线上 build 后实测读数写入 Evidence，并与修复前 20.4% / GPU 9.5% 对照。
- 既有 CSS/sidebar 判据、typecheck、lint 全绿；Touches 与实际改动一致。

## Touches

- src/index.css
- src/shared/tests/globalCssRules.test.ts
- tasks/gap-running-session-spinner-5hz.md
