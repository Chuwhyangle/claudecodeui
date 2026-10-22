---
id: architecture-content-and-copy-fixes
title: 内容与文案：范围/详情无效时给出原因、PlantUML 构造型写成真构造型、种类说法与筛选角标准确、检查器与会话命中说清楚
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-22 用 MCP 浏览器在本会话（claudecodeui 项目）看到一批「内容不准或说不清」的问题，彼此独立，集中在读数、检查器、会话页、文本复制与图例上。

1. **范围与详情两个旋钮看起来是死的**：本会话里范围 +0/+1/+2/+3 渲染的图完全一样（40 个节点、viewBox 相同），详情 Core/Common/All 也一样，只有读数里「隐藏 N 个函数」在变（5→158→451→637）。原因是 40 个节点全是 `direct` 种子（免隐藏、免裁剪），扩展出来的邻居全被筛选隐藏。修法：读数在范围变化时说明「范围 +N 又找到 K 个相关，都被筛选隐藏（函数 F · 调用 C）」并带一键「显示函数」；详情无变化时在档位按钮上给提示「无变化：当前显示的 N 个都是会话里直接提到的」。
2. **复制出去的 PlantUML 把构造型拼进类名**：文本是 `class "<<function>> displayName" as n5`。修法：构造型作为真正的构造型（`class displayName as n5 <<function>>`）进入桥接与模型，`toPlantUml` 才能产出标准写法；画面上构造型的显示方式保持与现状等价（仍显示 `<<function>>` 与实体名，`data-entity-id` 不变）；文本中任何被引号包住的名字里不得出现 `<<`。
3. **读数把函数叫「classes」**：`Showing 40 classes` 实际画出的是带橙框的 `<<function>>`。修法：改成按种类的如实说法「显示 40 个（40 函数）」，种类拆分取自被画出的实体。
4. **`Filter ▾ 4 on` 的含义不明**：它数的是「正在隐藏东西的筛选项」，不是「打开的选项」，默认恰好有 4 个元素选项是开的，极易误读。修法：角标改为「隐藏中 N」并带 `title`/`aria-label` 说明；弹层里每个选项的开/关状态用文字或图标（✓）表达，不只靠底色深浅。
5. **检查器对函数说「0 in · 0 out」「No drawn relations」**：函数的关系全是被筛选隐藏的调用边。修法：写成「画出 0 条；被筛选隐藏 N 条（调用）」并带一键「显示调用」。
6. **悬停提示泄露内部 id**：`93e0a992/modules/architecture/archguardToPlantUml.ts.displayName — relations: no outgoing/incoming relation` 含 scope key。修法：提示只显示「实体名 · 文件路径 · 出/入关系数」，关系为 0 且有被隐藏的关系时一并说明。
7. **「Sessions」命中有一半不是提及**：15 条里不少只有绝对路径（来自 `Read`/`Edit` 工具调用按文件命中），角色写「Assistant」、名字没有高亮；摘录常从词中间截断。修法：每条命中带类型徽标（消息 / 工具：Read 文件 / 工具输出）；按文件命中的写「提到了该文件，不是该名字」；摘录在词边界截断并带首尾省略号；路径摘录显示项目相对路径。
8. **「复制为会话上下文」的头部写项目 UUID**：`project b0a96771-c926-468a-bf18-09a5b3708039`。修法：写项目名与会话标题，UUID 只放在括号里的次要位置。
9. **图例只有文字**：没有线型与箭头色块，`△ inheritance · △ implementation` 用同一个符号，写「● seed」而实际种子是橙色粗边框。修法：图例用小 SVG 色块逐项示意（实线/虚线、各类箭头、构造型、种子的橙色粗边框、折叠标记），继承与实现的符号可区分。
10. **文件图里展开读数仍显示类图的种类统计**（`486 functions · 6 classes`）。修法：文件图视角下该行改为文件相关的说明或隐藏。
11. **成员签名带绝对路径**：`idShape — import("/data/home/yale/work/claudecodeui/src/modules/architecture/rendererContract").ArchitectureNodeIdShape`。修法：服务端归一成员类型字符串，把 `import("…/Name")` 缩成 `Name`；不改 `arch.json` 本身。
12. **邻域视图默认显示 `<<uses>>` 边标签**，与「边标签默认隐藏、悬停才出现」的设计不一致。修法：邻域视图与其他视图一致。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/readoutNumbers.test.ts src/modules/architecture/tests/architectureTab.test.tsx` exit 0：范围变化后读数出现「又找到 K 个相关，都被筛选隐藏」与「显示函数」操作，点击后函数出现；详情无变化时档位按钮有「无变化」提示；读数按种类如实说「N 个（F 函数 · C 类…）」，不再把函数叫 classes；筛选角标读「隐藏中 N」且有 `aria-label`；弹层选项开/关有 ✓ 或文字；文件图视角不出现类图的种类统计行
- [ ] `npx vitest run src/modules/architecture/tests/plantUmlText.test.ts src/modules/architecture/tests/archguardToPlantUml.test.ts` exit 0：函数实体的文本是 `class <名> as <别名> <<function>>` 形态，任何带引号的名字里不含 `<<`；文本经 plantuml-js `checkSyntax` 无 error 且经 `parsePlantUml` 得到的构造型为 `function`；画面上仍有 `<<function>>` 与实体名（既有 DOM 契约用例不回归）
- [ ] `npx vitest run src/modules/architecture/tests/dockInspector.test.tsx src/modules/architecture/tests/textPanel.test.tsx` exit 0：关系全被筛选隐藏的函数的检查器写「被筛选隐藏 N 条」并有「显示调用」；悬停提示不含 scope key（不含 `^[0-9a-f]{8}/`）；会话命中带类型徽标，按文件命中的写明「不是该名字」，摘录不从词中间开头；复制头部含项目名与会话标题
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/generator.test.ts server/modules/architecture/tests/architecture-routes.test.ts` exit 0：成员类型 `import("/abs/path/Name").Type` 被归一为 `Type`，不含绝对路径；不带此类类型的既有响应逐字节不变
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器打开 claudecodeui 项目的会话 `c5a57036-de6c-482e-9078-d5572e528ef5` 的 architecture tab：把范围从 +0 调到 +3，读数每次说明新增了多少被隐藏的相关项并能一键显示函数；读数不再把函数叫 classes；Filter 角标读得懂；选中一个函数，检查器说明它的关系被筛选隐藏了多少；悬停提示里没有 8 位十六进制前缀；Sessions 页每条命中有类型徽标；点「Text」复制，粘出的 PlantUML 里函数是标准构造型写法、头部是项目名；图例里有线型和箭头的色块。证据是截图与复制出的文本。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitectureInspector.tsx
- src/modules/architecture/ArchitectureTextPanel.tsx
- src/modules/architecture/plantUmlText.ts
- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/readoutNumbers.ts
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/tests/readoutNumbers.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/plantUmlText.test.ts
- src/modules/architecture/tests/archguardToPlantUml.test.ts
- src/modules/architecture/tests/dockInspector.test.tsx
- src/modules/architecture/tests/textPanel.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- server/modules/architecture/generator.ts
- server/modules/architecture/service.ts
- server/modules/architecture/tests/generator.test.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- tasks/architecture-content-and-copy-fixes.md
