---
id: architecture-layout-aspect-hint
title: 布局应用容器宽高比：向 ELK 传 aspectRatio（兜底自实现 LayoutEngine），显著变化才重排
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

布局完全不看浏览器给的比例与尺寸：`RendererOptions` 只有 `layout` / `view` / `transform`，没有 width/height/aspect 入口；客户端虽有 ResizeObserver（`PlantUmlGraph.tsx` 的 fit 逻辑），但只用于缩放已生成的 SVG，**从不影响布局**。结果：ELK 按自己的默认比例排出 55k×6k 的极宽画布（宽高比 9–15），移动竖屏下尤其灾难。

修法：把容器宽高比作为**布局入参**传下去。
- **首选（依赖 plantuml-js）**：请其 `createRenderer` 接受 `layoutOptions: { aspectRatio }`（ELK 原生支持 `aspectRatio`）。已与对方会话提出，与其 `gap-compound-layout-proportion` 同属 compound 打包议题。
- **兜底（不依赖对方发布）**：`RendererOptions.layout` 接受自实现的 `LayoutEngine` 实例（公开接口 `{ layout(model): Promise<LayoutResult> }`）。我们可写一个薄封装 engine，内部调用 ELK 并注入 `aspectRatio`。**本条优先走兜底**，对方支持后切回首选。
- 客户端：渲染时读容器尺寸计算 `aspectRatio`（宽/高，clamp 到合理区间），经 ResizeObserver 在**宽高比变化显著**（如 >15%，防抖 250ms）时才重排；轻微变化只重新 fit，不重排。移动端竖屏（<1）与桌面横屏（>1）各自得到合适比例。

注意：重排会改变几何，因此必须与爆炸图的「一次布局 + 档位显隐」协调——仅在 aspect 显著变化时重排，并把当前 LOD 档位与焦点包在重排后重新应用（`explosionLod` 已有 apply 入口）。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/layoutAspect.test.tsx` exit 0：窄容器（如 1200×900）产出的画布宽高比落入预期区间（而非 9–15）；aspect 变化 <15% 不触发重排；>15% 触发一次且防抖
- [ ] 兜底 engine 单测：把 aspectRatio 传给底层布局（可用 spy/mock 断言入参），布局结果与默认路径结构等价（节点/边集合一致，仅几何不同）
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0（爆炸图/缩放用例不回归）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器：桌面（宽容器）与 375px 竖屏分别打开 architecture tab，两次布局产出的画布宽高比都接近各自容器（不再是一张 55k×6k 的横条）；窗口从横屏拉成竖屏时自动重排一次并保持当前 LOD 档位与焦点包。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/elkAspectEngine.ts
- src/modules/architecture/tests/layoutAspect.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- package.json
- tasks/architecture-layout-aspect-hint.md