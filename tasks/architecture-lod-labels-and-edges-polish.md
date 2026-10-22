---
id: architecture-lod-labels-and-edges-polish
title: 低缩放档位的 package 标题不重影不重叠、权重标签与边更清晰、空包框降权
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-23 在新构建上看低缩放（package 档位，Quay OO 会话 19%、32%）的画面，已经做到标题反向缩放到 15px、关系线是正交虚线并带 `×N` 权重，但仍有四处视觉问题：

1. **标题重影**：反向缩放后的覆盖标题（`[data-architecture-lod-labels]`）与 plantuml-js 原来的 3px 小标题画在同一位置，叠成重影（例如左上角 `modules (40)` 与它自己的缩小版叠在一起）。修法：覆盖标题生效的 package，原来的 `.uml-package > text` 在该档位隐藏（`visibility: hidden` 或 `opacity: 0`，不删 DOM，`data-package-id` 契约不变），退出该档位时恢复。
2. **标题互相重叠、盖住权重标签**：Quay OO 的手机视口与桌面 32% 缩放下，`modules/chat (6)` 与 `modules/ch…` 重叠，`×10` 被 `provider…` 压住。修法：新增纯函数 `planLodLabels(frames, scale, viewport, edgeLabels)`：按框面积从大到小贪心放置，已放置标题的屏幕矩形与候选标题的矩形（含 4px 外边距）相交则候选被省略；与边权重标签相交的候选同样省略；被截断的标题优先显示最后一段加计数（`modules/chat/audio (1)` 截成 `audio (1)` 而不是 `modules/ch…`）。
3. **权重标签与边的清晰度**：`×N` 标签没有底色，压在边与框线上难读；LOD 边的线宽按世界单位缩放导致低缩放下过粗（实测约 4px 的粗虚线，与原有实体边的细线风格不一致）。修法：权重标签带与画布底色一致的描边光晕（`paint-order: stroke`，宽 3px）；LOD 边的屏幕线宽 = `clamp(1, 1 + log2(weight) * 0.5, 2.5)` px（用 `vector-effect: non-scaling-stroke`，不随缩放变粗），虚线间距同样用屏幕单位，与原有实体边的虚线节奏接近。
4. **空包框视觉权重过重**：包内实体框在该档位被隐藏后，大块空包框（如 875×325 的空白矩形）仍用满边框与填充，抢走注意力。修法：在该档位下，内部没有任何可见实体框的包框（只含子包的除外）加 `arch-lod-empty-frame` 类，填充不透明度降到 40%、边框降为 0.5 倍粗细；该类随档位切换增删。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/explosionLod.test.tsx` exit 0：`planLodLabels` 纯函数用例——两个相交的候选里面积大的保留、小的省略；与权重标签相交的候选被省略；截断时显示最后一段加计数；外边距 4px 的边界用例（恰好相邻不算相交）；同输入同输出（确定性）；既有 LOD 用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：package 档位下覆盖标题生效的 package，其原小标题 `.uml-package > text` 不可见（`visibility: hidden` 或 `opacity: 0`），切回实体档位后恢复可见；LOD 边的线宽计算函数用例（权重 1、4、16、1000 的屏幕线宽落在 1–2.5px 且单调不减）；LOD 边带 `vector-effect: non-scaling-stroke`；权重标签带描边光晕；内部无可见实体的叶子包框带 `arch-lod-empty-frame` 且只含子包的包框不带；切档后类被移除
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（在既有几何守卫里增加断言，整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 为它加条目并写明实测）：低缩放档位下所有可见覆盖标题的屏幕矩形两两不相交，且与可见权重标签不相交；没有任何 package 同时存在可见的覆盖标题与可见的原小标题；LOD 边的屏幕线宽 ≤ 2.5px
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：新增控制臂——关闭标题避让后同一读数里出现相交的标题对（证明守卫能取假），主臂与控制臂用同一读取函数
- [ ] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（1440×765）打开 claudecodeui 项目的「Quay 的 OO 设计重构」会话，分别在 19% 与 32% 缩放下：标题清晰无重影、互相不重叠、不压住 `×N`；关系线是细虚线（≤ 2.5px）、权重标签读得清；大块空包框明显变淡。再用手机视口（390×844）看同一会话，标题不再互相重叠。贴屏幕矩形相交读数与前后截图。

## Touches

- src/modules/architecture/explosionLod.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/explosionLod.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-lod-labels-and-edges-polish.md
