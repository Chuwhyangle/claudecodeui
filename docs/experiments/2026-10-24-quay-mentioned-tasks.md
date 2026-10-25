# 会话中提到的 task/goal 完整 id:扫描统计

日期:2026-10-24 · 脚本:`experiments/quay-mentioned-tasks/scan_mentions.py`

为「header 甘特图点击展开 → 当前会话提到过的任务列表」这个方向做前置实验,回答两个问题:

1. task/goal 完整 id 在 `user`/`assistant` 消息正文(排除 tool 调用)里出现的频率与分布;
2. 取数该扫**全量 transcript** 还是**最近 N 条**。

## 方法

- **范围**:本项目(`claudecodeui`)transcript 目录下按 mtime 最近的 250 个会话。
- **词汇表**:`tasks/*.md` 的 1078 个任务 slug + `goals/*.md` 的 49 个 `GOAL-NNN`;
  `AC-*` 明确排除。
- **正文定义**:`user`/`assistant` 条目的 `text` 块;`assistant` 的 `tool_use`/`thinking`
  块与 `user` 的 `tool_result` 块丢弃。
- **匹配**:按非 id 字符切词,对闭集做大小写不敏感**精确**匹配(不模糊、不前缀);
  抽查确认无短/泛化任务 id,命中都是真正文(markdown 表格、列表、worker 分发 prompt)。
- **位置单位**:一条 user 消息或一个 assistant text 块记为一个「body 单元」。

## 结果

### 1. 出现频率

| 指标 | 值 |
|---|---|
| 有提及的会话占比 | **242/250 = 96.8%** |
| 正文提及总次数 | 1812 |
| 若把 tool 块也算进去 | 18795(≈10× 噪音) |
| 每会话 distinct id 数(min/median/max) | 1 / **1** / 89 |
| 种类分布 | task **1190** · goal 32 |

**worker 会话 vs 人类会话**(按首个 user 消息是否含分发 prompt `Task: … Repo root:` 切分):

| 组 | 会话数 | 有提及 | distinct/会话(中位) | 长度 body 单元(中位) |
|---|---|---|---|---|
| worker(被分发的任务会话) | 108 | **100%** | 1(即自己被分发的任务) | 453 |
| 人类会话 | 142 | **94%** | **2** | **15** |

### 2. 提及深度分布(全量 vs 最近 N 条)

| 只扫最近 N 条 body 单元 | 覆盖所有提及的会话占比 | 显示为空列表的会话数 |
|---|---|---|
| 20 | 38.4% 提及落在窗口内 | **28/242(12%)** |
| 50 | 45.3% | 27(11%) |
| 100 | 49.5% | 19(8%) |
| 200 | 56.3% | 10(4%) |
| 500 | 69.9% | 1 |
| 全量 | 100% | 0 |

会话长度差异极大:min 3 / median 99 / max **3793** 个 body 单元。worker 会话在每轮
summary 里反复重命名自己的任务 id,因此提及贯穿整个长 transcript——只扫尾部窗口会
漏掉会话开头的分发 prompt 与早期的提及。

## 对方案的含义

1. **排除 tool 调用是必要且有效的降噪**:tool 块里的 id 是正文的 ~10 倍,不排除会
   把「agent 内部操作过的对象」误报成「对话里提到的任务」。
2. **必须扫全量**:只扫最近 20 条会让 12% 的会话显示为空列表(明明提过任务)。
   成本上全量可行——人类会话很短(中位 15 单元),worker 会话虽长但 server 已有
   增量 transcript reader(`claude-sessions.provider.ts` 的 `transcriptParseBytes`),
   可做增量/缓存,不必每次重读。
3. **展开列表会很短**:人类会话中位只有 2 个 distinct id,popover 完全装得下;这也
   印证了形态选 A(popover 就地展开)而非 drawer。
4. **worker 会话里「提到」≈「本会话被分发的任务」**:108 个 worker 会话 100% 命中、
   中位 1 个,命中 id 就是自己被分发的任务。所以正文提及这一条臂,在 worker 会话上
   几乎等价于「本会话正在驱动的任务」——想省掉单独读 `.workflow-events/` 的权威臂
   也有依据。
5. **goal id 在正文里几乎不出现**(32 vs task 1190):goal 出现在 tool 调用和分发
   prompt 里,不在对话正文。若要展示 goal,应改为从 task 的 frontmatter(`goal:`/
   `goal_ac:`)join 出来,而不是靠正文提及。
