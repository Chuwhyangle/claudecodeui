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


用户在有 GPU 的笔记本上用新 bundle（`https://cloudpit.lrfz.com/assets/index-JDsoKD9U.js`）打开活跃会话，仍观察到 **20%+ CPU**；推理结束后降到约 5%。上一轮已修掉 shimmer 与 backdrop-filter，残余的持续动画只剩侧栏两只 `Loader2 animate-spin`（`SidebarSessionItem.tsx:235` 与 `ResidentMark.tsx:70`，同一 running 会话各一只）以及两个 opacity pulse。

CDP 仔细查过：

- 两只 spinner **已经有自己的 compositor layer**（LayerTree: layer 511/507，16×16，`drawsContent=true`），不是“没被提升”的问题；再包 promoted wrapper 无帮助。
- 页面有 **172 个 compositor layers**（91 个 draw content）。60fps 的旋转让合成器/GPU 每帧处理整棵 layer tree；在空白页里单个 SVG 旋转只有 ~1.2% GPU，放进这个页面后每只约 4–5%。
- 同一线上 running 会话 8s 窗口实测（有宿主噪声，看中位/相对值）：60Hz 两只 spinner **total 20.4%、GPU 9.5%、main 4.3%**；`animation: spin 1s steps(5, end) infinite` 后 **total 8.4%、GPU 3.5%、main 1.9%**；`steps(10)/2s` total 13.7%；`steps(20)/4s` total 16.0%；全动画关掉的对照 total 5.2%。
- GIF/WebP 对比（同样的 5fps）：GIF **total 11.2%、GPU 3.1%**；WebP **total 11.0%、GPU 2.7%**；两者都验证了会动（两次元素截图字节不同）。CSS `steps(5)` 的 total 更低，且没有二进制资源、能随主题配色、无需处理 GIF 的 1-bit 透明/调色板。结论：**不用 GIF/WebP，用 CSS steps(5)**。
- 用户明确要求：**5Hz 足够**，但必须仍能看到它在转。

## AC

- [x] AC1 5Hz 规则存在且被钉住：`src/index.css` 包含 `#sidebar-panel .animate-spin { animation: spin 1s steps(5, end) infinite; }`；`src/shared/tests/globalCssRules.test.ts` 新增用例先打印 `sidebarSpinAnimation=spin 1s steps(5, end) infinite` 再断言；命令 `bash scripts/with-memory-cap.sh npx vitest run src/shared/tests/globalCssRules.test.ts --maxWorkers=1` exit 0。红态：未加规则时同一用例红在“找不到该规则”；把值改成 `linear` 时红在 timing-function 断言。
- [x] AC2 线上实测：`npm run build:client` 后线上 `:3001` 打开同一 running 会话，5 次 10s CDP 窗口（页级 `Performance.getMetrics` + 浏览器级 `SystemInfo.getProcessInfo`）中位数满足：total ≤ 15% of one core、GPU ≤ 5%；计算样式 `getComputedStyle(spinner).animationTimingFunction` 含 `steps(5)`；`document.getAnimations()` 仍有名为 `spin` 的动画（说明还在转）；修复前对照 20.4% / GPU 9.5% 写入 Evidence。
- [x] AC3 既有判据不回退：`bash scripts/with-memory-cap.sh npx vitest run src/shared/tests/globalCssRules.test.ts src/modules/sidebar/tests/sidebarResize.test.ts --maxWorkers=1` exit 0；`npm run typecheck`、`npm run lint` exit 0。
- [x] AC4 GIF/WebP 结论留档：Evidence 写明二者的实测 total/GPU（GIF 11.2/3.1、WebP 11.0/2.7）与不采用的理由（比 CSS steps(5) 的 8.4/3.5 更差或相当；二进制资产、主题配色、GIF 透明质量）。

## DoD

- 规则只作用于侧栏活动指示器（`#sidebar-panel .animate-spin`），不改 spinner 的数量、图标、尺寸或语义；composer/复制按钮等一次性 spinner 不动。
- 5Hz 是 5 次/秒的步进旋转，视觉上仍能辨认出在转；不引入 GIF/WebP/APNG 资源。
- 线上 build 后实测读数写入 Evidence，并与修复前 20.4% / GPU 9.5% 对照。
- 既有 CSS/sidebar 判据、typecheck、lint 全绿；Touches 与实际改动一致。

## Touches

- src/index.css
- src/shared/tests/globalCssRules.test.ts
- tasks/gap-running-session-spinner-5hz.md

## Evidence

实现 commit `5951fe7f2`（worktree `task/gap-running-session-spinner-5hz`），线上 build `092049109` / `assets/index-BsbSiX79.js` / CSS `dist/assets/index-zk0HbKdJ.css`。改动：`src/index.css` 在 `@layer utilities` 增加 `#sidebar-panel .animate-spin { animation: spin 1s steps(5, end) infinite; }`；`src/shared/tests/globalCssRules.test.ts` 新增 5Hz pin。spinner 数量、图标、尺寸、语义均未改；composer/复制按钮等一次性 spinner 仍为线性 60fps。

### AC1 — 5Hz 规则（绿）

```
cd <worktree> && bash scripts/with-memory-cap.sh npx vitest run src/shared/tests/globalCssRules.test.ts --maxWorkers=1
```

```
sidebarSpinAnimation=spin 1s steps(5, end) infinite
Test Files 1 passed (1) / Tests 6 passed (6)
```

红态：把 CSS 值临时改成 `linear` 后同一用例红在 timing-function 断言，读数 `sidebarSpinAnimation=spin 1s linear infinite`，`Tests 1 failed | 5 passed`；随后从备份 `cp` 还原（`steps(5, end)` 回读在 `src/index.css:818`）。

### AC2 — 线上实测（绿）

线上 `:3001` 加载 `assets/index-BsbSiX79.js`，同一 running 会话（`7126bf10-…`，running badge=1），5 个 10s CDP 窗口：

| # | on total | main Task | GPU | off total | delta |
|---|---:|---:|---:|---:|---:|
| 1 | 13.1% | 3.5% | 3.7% | 5.9% | 7.2 |
| 2 | 16.0% | 4.0% | 3.1% | 8.6% | 7.4 |
| 3 | 9.2% | 1.8% | 3.3% | 6.0% | 3.2 |
| 4 | 8.0% | 1.7% | 2.9% | 2.0% | 6.0 |
| 5 | 7.6% | 1.6% | 2.6% | 6.6% | 1.0 |

中位数：**total 9.2%**、**main 1.8%**、**GPU 3.1%**、delta 6.0 点；修复前同一会话 8s 窗口是 **20.4% / main 4.3% / GPU 9.5%**。

- 计算样式：`getComputedStyle(spinner)` → `spin 1s steps(5)`（Chrome 省略 `end`）。
- 仍在旋转：对第一个 spinner 连续 5 次元素截图（间隔 160ms），得到 **3 个不同帧哈希**（`distinctFrames=3`，`rotates=true`）。
- 截图：`tmp/running-session-spinner-5hz.png`。

### AC3 — 既有判据 / typecheck / lint（绿）

```
npx vitest run src/shared/tests/globalCssRules.test.ts src/modules/sidebar/tests/sidebarResize.test.ts --maxWorkers=1
→ Test Files 2 passed (2) / Tests 16 passed (16)
npm run typecheck → exit 0
npm run lint → exit 0（仅既有 warning）
```

### AC4 — GIF/WebP 对比（不采用）

同一线上页面、同一 running 会话、8s 窗口；GIF/WebP 都是 5 帧 / 200ms = 5fps，并先用两次元素截图确认确实在动（GIF `bytesA=253, bytesB=244`，WebP `235/244`，均 `changed=true`）：

| 方案 | total | GPU | main |
|---|---:|---:|---:|
| 60Hz SVG（修复前） | 20.4% | 9.5% | 4.3% |
| **CSS `steps(5)`** | **8.4%** | **3.5%** | **1.9%** |
| GIF 5fps | 11.2% | 3.1% | 2.0% |
| WebP 5fps | 11.0% | 2.7% | 2.2% |

结论：GIF/WebP 的 GPU 略低，但 total 比 CSS `steps(5)` 高，且要新增二进制资源、无法跟随 `currentColor`/主题、GIF 只有 1-bit 透明与调色板（深色背景下边缘更差）。**采用 CSS `steps(5)`**，不引入图片资源。
