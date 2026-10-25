# caret-item-matching

离线实验：把“最后一条 assistant 回复里可被复述的目标（文件路径 / 标识符 / 代码行 / 标题）”
做成光标前的补全候选，用真实会话历史评价它的**性能**与**可用性代理指标**。

**这不是接线**。composer 没有任何改动；本目录只有语料回放、读数与结论。
实现本体在 `src/modules/chat/utils/transcript/referenceTargets.ts`，单测在
`src/modules/chat/utils/tests/referenceTargets.test.ts`，同样没有消费者接线。

## 文件

| 文件 | 作用 |
|---|---|
| `corpus.mts` | 共享语料加载器：真人回合 ↔ 最后一条 assistant 文本回复 |
| `replay.mts` | 回放 14 天语料，跑消融与性能测量 |
| `RESULT.json` | 最近一次回放的完整读数 |
| `stats.mts` | 分位数工具 |
| `sample.mts` | 抽取 60 对人工标注样本，生成 `annotation/index.html` |
| `analyze.mts` | 读取人工标注，对照 shipping / 段落开启两种目标集 |
| `viewport-probe.mts` | 引用段落的来源分布：最后一条回复 vs 更早的消息 |
| `retrieval-probe.mts` | 从“意见草稿”找回被引用段落的 lexical 基线 |
| `annotation/` | `sample.json`（含层与自动标签）、`index.html`（盲标页）、`annotations.json`（60/60 已完成）、`ANNOTATION-RESULT.json` |
| `VIEWPORT-RESULT.json` | 引用来源分布（21 天） |
| `RETRIEVAL-RESULT.json` | lexical 段落找回基线 |
| `REPORT.md` | 结论、表格、限制与下一步 |

## 运行

```bash
# 全量（默认 14 天；本机缓热后约 13 s，冷缓存约 50 s）
npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/replay.mts

# 冒烟
MAX_FILES=40 npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/replay.mts

# 单测（实现本体）
npx vitest run src/modules/chat/utils/tests/referenceTargets.test.ts

# 抽 60 对人工标注样本（会覆盖 annotation/index.html）
npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/sample.mts

# 人工标注后（annotations.json 放在 annotation/ 下）
npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/analyze.mts

# 场景修正：引用来源分布 / 从意见草稿找回段落
npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/viewport-probe.mts
npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/retrieval-probe.mts
```

## 人工标注怎么跑

1. 浏览器打开 `experiments/caret-item-matching/annotation/index.html`；
2. 每张卡读回复 → 读 user 消息 → 选“指向什么” → 点行/粘贴引文 → 选“会不会用”；
3. 进度自动存在 localStorage；标完点“导出 JSON”；
4. 把导出文件存成 `annotation/annotations.json`；
5. 跑 `analyze.mts`，读 `annotation/ANNOTATION-RESULT.json`。

页面上没有层标签、没有匹配结果、没有自动真值——标的是“这条消息指什么”，不是“匹配器对不对”。

**当前状态：60/60 已标注并分析完毕。** 结果见 `REPORT.md` §10：
specific 14/14 会用、none 0/37 会用；但 13 个 specific 里 11 个指向段落，
shipping token 补全只覆盖 1/13。主价值在“插入被指到的 span”，不在 token 补全。

## 语料

- 目录：`~/.claude/projects/-data-home-yale-work-claudecodeui`
- 窗口：最近 14 天（`DAYS` 可覆盖）
- 单位：一条真人 user 短回合（1–200 字、单行）↔ 它之前最后一条 assistant 文本回复
- 过滤：`isMeta` / `isSidechain` / 注入通知 / 命令行包装 / 跨会话消息
- 不读真实击键，也没有 IME 上屏过程；回放的是**最终文本的每个前缀**

## 真值口径

- **强真值**：回合里逐字出现某个 path / identifier（规范化后 ≥6 字符）→ 该目标为意图目标；
  最长者胜，最长者并列时记为 ambiguous 并跳过 top-1 计分。
- **软真值**：没有任何强真值时，逐字出现某个 code-line / heading（规范化后 ≥10 字符）。
- 没有任何逐字复制目标的回合作为误报分母。它**包含**语义指代，所以误报率是上界。

这些口径都写在 `replay.mts` 顶部的注释里，读数字前先读它。
