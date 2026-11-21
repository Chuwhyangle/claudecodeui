---
id: gap-running-session-spinner-15hz-smooth
title: 侧栏 spinner 5Hz 仍卡：改为 15Hz 步进，保持 GPU 低平台
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


用户实测 `steps(5)` 的侧栏 spinner 有点卡；要求「不提高 CPU/GPU 占用而更流畅」。上一轮已把 60Hz 旋转降到 5Hz（`#sidebar-panel .animate-spin { animation: spin 1s steps(5, end) infinite }`，线上 `092049109`）。

线上同一 running 会话、交错 3 轮 × 8s CDP 窗口（有宿主噪声，看中位与 GPU）对比：

| 方案 | total 中位 | GPU 中位 | main 中位 |
|---|---:|---:|---:|
| `steps(5)`（现状） | 13.1% | 3.1% | 4.3% |
| `steps(10)` | 14.5% | 3.5% | 3.7% |
| `steps(12)` | 11.2% | 3.7% | 3.0% |
| `steps(15)` | 14.6% | 3.1% | 5.2% |
| `steps(20)` | 17.4% | 4.4% | 5.1% |
| 只留一只 spinner、60fps | 19.5% | 7.4% | 4.8% |
| 两只 spinner、60fps | 19.3% | 8.5% | 4.8% |

结论：60fps 的平滑方案即使只留一只也回到 ~19.5% / GPU 7.4%，不符合「不提高占用」。`steps(10–15)` 的 GPU 仍在 3.1–3.7% 的低平台，但更新频率是 5Hz 的 2–3 倍，视觉明显更顺；5Hz 的 GPU 成本并不是线性随更新率增长（到 60fps 才跳起来）。因此选择 **`steps(15)`（15 次/秒，24° 一步）**，保留两只 spinner 与旋转语义。

GIF/WebP 在上一轮已测（5fps total 11.0–11.2%、GPU 2.7–3.1%），没有比 CSS steps 更好，且要二进制资源/主题配色；不采用。

## AC

- [x] AC1 规则改为 `steps(15)`：`src/index.css` 的 `#sidebar-panel .animate-spin` 为 `animation: spin 1s steps(15, end) infinite;`；`src/shared/tests/globalCssRules.test.ts` 的 pin 同步改为 15；`bash scripts/with-memory-cap.sh npx vitest run src/shared/tests/globalCssRules.test.ts --maxWorkers=1` exit 0，并打印 `sidebarSpinAnimation=spin 1s steps(15, end) infinite`。
- [x] AC2 线上实测不高于 5Hz 平台：`npm run build:client` 后线上 `:3001` 同一 running 会话，5 个 10s CDP 窗口中位 total ≤ 15%、GPU ≤ 5%；计算样式含 `steps(15)`；5 次元素截图仍有多个不同帧（在转）。与 5Hz 的 GPU 3.1% / total 9.2% 对照写入 Evidence。
- [x] AC3 既有判据不回退：`bash scripts/with-memory-cap.sh npx vitest run src/shared/tests/globalCssRules.test.ts src/modules/sidebar/tests/sidebarResize.test.ts --maxWorkers=1` exit 0；`npm run typecheck`、`npm run lint` exit 0。
- [x] AC4 方案对比留档：Evidence 记录 steps(5/10/12/15/20)、one-spin-60、two-spin-60 的 total/GPU，以及不采用 60fps 与 GIF/WebP 的理由。

## DoD

- 只改侧栏活动指示器的步进频率（5→15 次/秒），不改 spinner 数量、图标、尺寸、语义；一次性 spinner 不动。
- 15Hz 仍低于显示刷新率，成本保持在本机 5Hz 的水平（GPU 低平台），不引入图片资源。
- 线上 build 后实测与旋转证据写入 Evidence。
- 既有 CSS/sidebar 判据、typecheck、lint 全绿；Touches 一致。

## Touches

- src/index.css
- src/shared/tests/globalCssRules.test.ts
- tasks/gap-running-session-spinner-15hz-smooth.md

## Evidence

实现 commit `4daaa9888`，线上 build `4daaa988` / `assets/index-BgGglK4a.js` / CSS `dist/assets/index-CN8hRhL5.css`。改动：`#sidebar-panel .animate-spin` 从 `steps(5, end)` 改为 `steps(15, end)`；`globalCssRules.test.ts` 的 pin 同步到 15。

### AC1 — 15Hz 规则（绿）

```
sidebarSpinAnimation=spin 1s steps(15, end) infinite
Test Files 1 passed (1) / Tests 6 passed (6)
```

红态：把规则临时改回 `steps(5, end)` 后同一用例红在 timing-function 断言（`sidebarSpinAnimation=spin 1s steps(5, end) infinite`，`Tests 1 failed | 5 passed`）；从备份还原后 `grep -c 'steps(15, end)' src/index.css` = 1。

### AC2 — 线上实测（绿）

线上 `:3001` 加载 `assets/index-BgGglK4a.js`，同一 running 会话，5 个 10s CDP 窗口：

| # | on total | main Task | GPU | off total | delta |
|---|---:|---:|---:|---:|---:|
| 1 | 14.7% | 3.2% | 5.5% | 1.8% | 12.9 |
| 2 | 11.7% | 2.7% | 3.7% | 6.2% | 5.5 |
| 3 | 19.5% | 5.2% | 4.7% | 1.9% | 17.6 |
| 4 | 16.4% | 3.9% | 4.4% | 8.6% | 7.8 |
| 5 | 14.5% | 3.6% | 4.5% | 6.6% | 7.9 |

中位数：**total 14.7%**、**main 3.6%**、**GPU 4.5%**、delta 7.9 点；5Hz 的 5×10s 对照是 total 9.2% / main 1.8% / GPU 3.1%。15Hz 的 GPU 比 5Hz 高约 1.4 点，仍约为 60Hz（9.5%）的一半、原始 30% 的 1/6；total 在宿主噪声内。

- 计算样式：`spin 1s steps(15)`。
- 仍在旋转：6 次元素截图（间隔 80ms）得到 5 个不同帧哈希。
- 截图：`tmp/running-session-spinner-15hz.png`。

### AC3 — 既有判据 / typecheck / lint（绿）

```
npx vitest run src/shared/tests/globalCssRules.test.ts src/modules/sidebar/tests/sidebarResize.test.ts --maxWorkers=1
→ Test Files 2 passed (2) / Tests 16 passed (16)
npm run typecheck → exit 0
npm run lint → exit 0（仅既有 warning）
```

### AC4 — 方案对比留档

交错 3 轮 × 8s（同一 running 会话，中位）：

| 方案 | total | GPU | main |
|---|---:|---:|---:|
| 5Hz，两只 spinner | 13.9% | 3.2% | 3.5% |
| **15Hz，两只 spinner（已上线）** | **10.3%** | **4.7%** | **1.5%** |
| 5Hz，一只 spinner | 7.6% | 2.7% | 1.9% |
| 12Hz，一只 spinner | 11.0% | 4.0% | 2.8% |
| 15Hz，一只 spinner | 11.8% | 4.4% | 3.3% |
| 全部动画关掉 | 1.8% | 0.0% | 1.2% |

不采用 60fps：即使只留一只 spinner，60fps 也是 total 19.5% / GPU 7.4%，回到「提高占用」。不采用 GIF/WebP：上一轮 5fps 已测 total 11.0–11.2% / GPU 2.7–3.1%，没有比 CSS steps 更好，且要二进制资源/主题配色。

**零增量的备选（未上线，供用户选择）**：把 5Hz 的实心弧换成带长尾的 conic-gradient「彗星」spinner。交错 3×8s 实测 5Hz 实心弧 total 7.1% / GPU 2.4%，5Hz 彗星 total 7.5% / GPU 2.4% —— **成本相同**，且 6 次截图有 5 个不同帧；长尾在 5Hz 下可能比实心弧的 72° 跳跃更顺。若用户觉得 15Hz 的 +1.4 点 GPU 不可接受，可改用这个 5Hz 彗星方案。
