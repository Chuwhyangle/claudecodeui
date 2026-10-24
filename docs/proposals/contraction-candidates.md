# 收缩候选：把「从不发声的仪器」变成可裁定的对象

**日期**：2026-10-24
**状态**：提案（只读原型已随本任务落地；裁定动词与落地路径待用户审阅）
**原型**：`scripts/contraction-candidates/scan.mjs`
**判据**：`scripts/contraction-candidates/scan.test.mjs`

## 1. 背景：膨胀相是自动的，收缩相没有机制

quay 的《维度边界与结晶》§10.4 记录了一个可测的不对称：四次收缩动作全部由人发起，由机制发起的为 0 次。
原因不是删除候选不可知，而是「它从没响过」这句话在系统里**无法被查询**——纯读契约让机制不留痕迹，而
「证明一个机制没用」恰恰依赖痕迹（见 quay `docs/analysis/crystallization-the-contraction-phase-has-no-mechanism.md` §2）。

观察层已经能回答「什么还活着」（会话活性、项目五层真相、架构差分）。本提案补的是同一个语法的另一半：
**把「已经不发声」的读数汇成一批可裁定的对象**，交给人的收缩动词，而不是让驾驶舱自己删除任何东西。
ADR-021 要求元机制比被治理对象小一个量级；现实是 3.7 倍倒挂——这条比值本身就是本提案的第一类读数。

## 2. 信号盘点：六类可计算的收缩候选

每一类都给出数据来源、计算方法、窗口、误报风险与反例检查。原型实现的是标 ✅ 的类；标 ◻ 的类写明了
数据源与口径，留给后续任务。

| # | 类别 | 原型 | 数据来源 | 计算方法 | 窗口 |
| --- | --- | --- | --- | --- | --- |
| A | 零事件 / 恒绿 / 恒红的闸与判据 | ✅ `never-red-gate` `never-green-gate`；◻ 零事件 | `<repo>/.quay/gate-events.jsonl`；闸定义（`.quay/config.yml`、插件注册表） | 按 `gate` 分组统计 `verdict`；`fail=0` 且 `pass>0` → 恒绿；`pass=0` 且 `fail>0` → 恒红；声明了但窗口内 0 事件 → 零事件（需要闸注册表，原型未接） | 30 天（可调） |
| B | 零读者的状态文件 / 账本 | ✅ `zero-reader-state-file` `silent-ledger` | `<repo>/.quay/*.json`、`*.jsonl`；仓库内代码（`.ts/.mjs/.js/.py/.sh`） | 对状态文件 basename 做代码字面量引用索引，按邻近行区分 read/write 动词；有写无读 → 候选。账本再有「有声明引用 + 窗口内无记录」→ 静默账本 | 30 天；状态文件不设窗口（存在即读） |
| C | 读数恒定的仪器 | ✅ `constant-reading-instrument` `never-evaluated-instrument` | `.quay/*.jsonl`（尾采样 200 条） | 对记录里每个「有意思」的字段（`evaluated`/`count`/`verdict`/`ok`…）检查是否 20 条以上完全同值；`evaluated:false` 全覆盖单独成类 | 最近 200 条记录 / 30 天 |
| D | 从未被触发的规则 / 机制 | ✅ `silent-ledger`（覆盖机制落盘通道）；◻ 人工转向通道 | 机制自己的事件账本（如 meta-driver 的人工转向记录） | 声明了账本、代码仍引用、窗口内 0 条记录 → 「规则存在但没被触发」；计数需要机制注册表（原型未接） | 30 天 |
| E | 文档与代码比例、长期无人引用的文档 | ✅ `unreferenced-doc`；◻ 文档/代码比 | `docs/**/*.md`、`adr/**/*.md`；全仓库文本引用；`git log -1` 最近改动 | basename 在其它任意文件中的引用数 = 0 且最近改动早于窗口 → 候选。文档/代码比沿用 `two-phase-state.json` 的 L_D 规则（`docLines/codeLines`，>3.0 且 docLines>20 才报） | 30 天 |
| F | 元机制体积 | ✅ `meta-mechanism-ratio` | 治理目录（`scripts`、`plugin/scripts`、`orchestration`…）与被治理目录（`src`、`server`、`packages/*/src`） | 非空行数比；治理/被治理 ≥ 1.0 时报警（ADR-021 期望小一个量级，即 ~0.1） | 当前树 |

**为什么是这六类**：它们都满足三个条件——(1) 读数已经存在于项目自己写的文件里，不需要新增仪表；
(2) 计算是一次 grep/一行聚合，不是语义判断；(3) 每个读数都有一个具体的「它可能仍然必要」的反例。
不满足第 3 条的信号不进清单，因为不可反驳的候选会变成噪音，而噪音会让收缩动词再次退回给人。

## 3. 计算方法与只读扫描原型

```bash
node scripts/contraction-candidates/scan.mjs --root /data/home/yale/work/quay --json > /tmp/cc-quay.json
node scripts/contraction-candidates/scan.mjs --root /data/home/yale/work/claudecodeui --json
node scripts/contraction-candidates/scan.mjs --root /data/home/yale/work/quay-fleet --json
```

输出为一份 JSON：

```json
{
  "schemaVersion": 1,
  "tool": "contraction-candidates-scan",
  "root": "…", "generatedAt": "…",
  "window": { "days": 30, "since": "…" },
  "summary": { "candidates": 69, "byKind": { "never-red-gate": 4 }, "kindsCovered": ["…"] },
  "candidates": [
    { "kind": "never-red-gate", "target": "gate:retreat",
      "evidence": ["events=38 (pass=38 warn=0 fail=0 other=0)", "…"],
      "window": "last 30d", "confidence": "medium",
      "counterCheck": "A gate with a success-only transition arm cannot fail by construction…" }
  ],
  "skipped": [ { "source": "meta-mechanism-ratio", "reason": "ratio 0.09 …" } ]
}
```

设计约束：

- **只读**：进程的每一次文件系统调用都是读；不创建、不写、不改名、不删除。判据在夹具仓库上比较
  `git status --porcelain` 运行前后是否逐字节一致。
- **缺数据源不是错误**：没有 `.quay/`、不是 git 仓库、某个目录不存在，都进入 `skipped` 并写明原因，
  退出码仍为 0。这对应观察层「读数三态」：取不到 = 未评估 + 原因，**绝不显示为 0 候选 = 绿**。
- **每条候选必须带 `evidence[]` 与 `counterCheck`**：前者是可回查的读数，后者是「它可能仍然必要」的
  具体检查。没有 counterCheck 的候选按未验证处理。
- **置信度是启发式**：`high` 只在「仓库内有生产代码写它、且没有任何读调用」时给出；只被测试写入、
  或只经常量间接读取的文件降为 `low`，因为行级启发式看不见 `const REL = "…"; read(join(dir, REL))`。
- **不读 fleet 内部状态文件**：本原型只扫描各项目自己的仓库。fleet 的 `.quay/gate-events.jsonl` 与
  `~/.quay-fleet/decisions.jsonl` 不在扫描面内；需要时由 quay-fleet 暴露只读动词（见 §7）。

## 4. 误报与反例检查

| 读数 | 误报形态 | 反例检查（人工） |
| --- | --- | --- |
| 恒绿闸 | 转变类闸（`retreat`/`complete`/`promote`）按构造只有成功臂，失败记录在别的闸名下 | 读闸定义；同一次失败是否在 `acceptance`/`dod` 里已变红 |
| 恒红闸 | 闸本身是正确的警报，只是每次都被人处理掉了 | 数「每次红之后结果是否改变」；若人在行动，它是承重的，不是噪音 |
| 零读者状态文件 | 读者在别的仓库（quay CLI、fleet、插件缓存），或经共享常量间接读取 | 在消费者仓库和已安装插件里 grep basename；查 `const REL = "…"` 形式的路径常量 |
| 静默账本 | 账本只在罕见事件（合并锁升级、自漂移发现）时追加，长空窗是正常的 | 对比同窗口内「本可以触发」的机会数（例如合并次数） |
| 恒定读数 | 常量可能正确（空集合就是 0 cycles；配置的 mode 本来就不变） | 找一个独立生产者交叉核对；读 `reason` 字段区分「测出来是常数」与「输入不可用」 |
| 零引用文档 | 文档只是靠会话/外部引用，或索引文件本身不在扫描面；JSON 转义的 `\n` 会截断 basename | 在全仓库（含 `experiments/`）grep basename；检查文档角色（入口/日期记录/活契约） |
| 元机制比值 | 治理代码本身是可信度的来源，不是浪费 | 把比值当成「去读最大的治理文件」的指针，逐文件用 A 类读数裁定 |

在这份原型的第一次真实运行中，上述检查抓到了三个**自己的**误报：`anchor-kind-stops.json` 的读端经
`ANCHOR_KIND_STOPS_REL` 常量间接访问（已把「仅测试写入」降为 `low`）、两份提案文档实际被
`docs/analysis/*.json` 的转义字符串和 `experiments/` 引用（已修 JSON `\n` 解析并把 `experiments/`
纳入引用面）。这说明「候选」与「事实」之间必须隔一次人工核对，而不是让扫描直接进删除队列。

## 5. 观察墙呈现：方向面的一块周期性磁贴

观察墙现有三类磁贴（会话 / 项目 / 架构）都是**实时**的。收缩候选不是实时信号：它的读数以天/周为单位
变化，做成实时磁贴只会制造「又有一条候选」的噪声。因此它进入**方向面（direction face）**，与三类
观察面并列而不是混入其中：

- **磁贴标题**：「可能该退役的仪器」，副标题带最近一次扫描时间（不是「刚刚」，因为它是周期性读数）。
- **磁贴摘要**：按类别计数（`恒绿闸 4 · 恒红闸 1 · 静默账本 10 · 元机制 4.19×`），不展示每条候选。
- **三态**：数据源缺失/扫描失败 → 显示「未评估 + 原因」；扫描成功且 0 候选 → 这是**真正的好消息**，
  显示「窗口内无候选」并带时间戳，而不是空白。
- **原地预览**：展开后按置信度排序列出候选；每条显示 `kind`、`target`、`evidence[]`、`window` 与
  `counterCheck`。`counterCheck` 与控制臂放在同一个视线内——让人在裁定前先看到「它可能仍然必要」。
- **不占实时 12 块上限**：方向面磁贴是周期性的，不参与会话/项目/架构磁贴的折叠预算；但也不置顶，
  避免把慢信号伪装成需要注意的即时事件。
- **周期**：默认每日一次（可配置为每周）。扫描在服务端/后台跑，驾驶舱只读最近一次 JSON 结果；
  不在打开页面时现扫三个仓库。
- **排序**：`meta-mechanism-ratio`（仓库级、一天最多一条）→ `never-green-gate`（恒红比恒绿更可能是
  断掉的警报）→ `silent-ledger` → `never-red-gate` → `zero-reader-state-file` → `unreferenced-doc`。
  置信度只作为同类内的次序，不跨类提升。

## 6. 裁定与落地：人的动词 → quay 退役任务

驾驶舱**只提案，不删除**。每条候选的裁定是下列四个动词之一，全部由人发起：

| 动词 | 含义 | 落地 |
| --- | --- | --- |
| **退役** | 这个仪器/文件/规则不再需要 | 由 quay 立一条 `todo` 退役任务（正文带候选的 `kind`/`target`/`evidence`/`counterCheck`），走正常的 ready→done 链路；驾驶舱不执行删除 |
| **保留并注明理由** | 它仍然必要，但理由是扫描看不见的 | 写入一条抑制记录（`target` + `reason` + `reviewAfter`），在 `reviewAfter` 之前不再浮到预览顶部；保留理由必须是人写的，不能由扫描生成 |
| **改为按需** | 不再周期性运行，但保留代码路径供手动调用 | 立一条 `todo` 任务：移除调度/注册，保留命令与测试；不是删除实现 |
| **误报** | 读数本身是错的 | 记录误报原因，作为扫描器的改进输入；候选不进入退役队列 |

落地路径的硬约束：

1. **裁定 → 任务**：任何会导致代码/配置变化的动词（退役、改为按需）都落成 quay 任务，由 worker 执行；
   驾驶舱不直接改仓库。
2. **抑制记录**：`保留` 与 `误报` 需要一个可读的决策账本（建议 `contraction-decisions.jsonl`，字段
   `target/verb/reason/reviewAfter/decidedBy/decidedAt`）。该账本的写入是**人的动作**，不是扫描器的
   自动行为；扫描器只读它来做排序与去重。
3. **可撤销**：所有四个动词都带 `reviewAfter`；到期后候选重新出现，人可以选择维持或改判。没有「永久
   绿」的抑制。
4. **不自动收缩**：阈值达标本身不触发删除。机制只负责把候选送到人面前；这与「四类收缩动作全部人工
   发起」的现状一致，也是 ADR-021 说元机制必须更小的原因——自动删除会把治理负担换成治理风险。

## 7. 与 fleet attention 的关系

fleet attention 是**打断式**通道：它回答「现在有什么需要你处理」。收缩候选是**慢**通道：它回答
「有什么可能已经没用了」。两者不应混用，否则退役候选会稀释真正的即时注意力。

- 收缩候选**默认不进** fleet attention；它们只出现在驾驶舱的方向面。
- 唯一允许的升级：一条 `保留` 记录过了 `reviewAfter` 仍未被复核，或一条退役任务在池中滞留超过
  N 天——此时由 fleet 接收一条**低优先级**的 attention，类别复用 fleet 现有的 backlog 类，而不是
  新增打断类别。
- fleet 侧的输入必须走只读动词。按「CloudCLI 不读 fleet 内部状态文件」的原则，本任务**没有**读取
  `~/.quay-fleet/decisions.jsonl`；若要把「机制发起 vs 人工发起」的收缩比例也变成候选，先请
  quay-fleet 暴露基于该账本的 `inventory --json`，口径定了再立读口（本任务 Notes 已记录）。
- 驾驶舱方向面的数据来自各项目仓库内的扫描结果与决策账本，不依赖 fleet 的内部文件格式。

## 8. 真实扫描结果（2026-10-24，窗口 30 天）

命令：`node scripts/contraction-candidates/scan.mjs --root <repo> --json`，三个根均 exit 0。

| 仓库 | 候选总数 | 分类计数 | 其他读数 |
| --- | --- | --- | --- |
| quay | 69 | 恒绿闸 4 · 恒红闸 1 · 恒定读数 5 · 静默账本 10 · 零读者状态 23 · 零引用文档 25 · 元机制比值 1 | 459,635 条闸事件；1,831 个代码文件；244 份文档 / 7,272 个文本文件 |
| claudecodeui | 21 | 恒绿闸 3 · 恒定读数 4 · 零读者状态 14 | 129,511 条闸事件；1,958 个代码文件；元机制比值 0.09（低于阈值） |
| quay-fleet | 12 | 恒绿闸 1 · 恒定读数 1 · 零读者状态 10 | 203,705 条闸事件；242 个代码文件；元机制比值 0.03（低于阈值） |

**三条最有把握的候选及证据**（跨仓库）：

1. `quay / meta-mechanism-ratio`：治理 234,671 行 / 被治理 55,980 行 = **4.19×**。ADR-021 期望
   元机制小一个量级；这是倒挂最直接的一条读数。
2. `quay / silent-ledger:.quay/inner-tick-log.jsonl`：文件 1.30 MB，最后写入 2026-08-24（窗口内 0 条），
   但 `plugin/scripts/outer-anchor-check.ts` 与两份 registry 测试仍把它声明为必需指针。
   「声明还在、账本已静默」——正是提案 1 要找的形态。
3. `quay / never-green-gate:adr-007`：7 条事件、`pass=0 fail=7`，原因文本为
   「no living product-code L_S instrument」。恒红本身不是罪证，但它与「收缩相没有机制」同源：
   一个只能报「缺少仪器」的闸，需要人决定是补仪器还是退役闸。

**人工核对（DoD）**：抽查 7 条，全部属实：

| # | 候选 | 核对命令/读数 | 结论 |
| --- | --- | --- | --- |
| 1 | `gate:complete`（quay） | 独立重算 30 天：pass=564 fail=0 | 属实 |
| 2 | `gate:retreat`（quay） | 独立重算：pass=38 fail=0 | 属实 |
| 3 | `gate:adr-007`（quay） | 独立重算：pass=0 fail=7 | 属实 |
| 4 | `meta-mechanism-ratio`（quay） | `find … \| xargs cat \| grep -c '[^[:space:]]'`：234,671 / 55,980 = 4.19 | 属实 |
| 5 | `gate:complete`（claudecodeui） | 独立重算 30 天：pass=877 fail=0 | 属实 |
| 6 | `silent-ledger:.quay/inner-tick-log.jsonl`（quay） | 引用 3 处（`outer-anchor-check.ts` + 2 个测试）；`mtime=2026-08-24` | 属实 |
| 7 | `unreferenced-doc:docs/plans/1-quay-continuous-bootstrap-read-path-slimming.md`（quay） | 全仓库 grep basename：0 处；`git log -1` = 2026-07-17 | 属实 |

已知的**假阳性**（如实记录，不隐藏）：`anchor-kind-stops.json` 的读端经路径常量间接访问，行级启发式
看不到，扫描器把它标成零读者；在加入「仅测试写入 → low」规则后已降级但仍会出现在列表里。这类候选
必须过 `counterCheck`，不能直接进退役队列。

## Adjudication

**待用户审阅。本任务在评审前不得置 done。**

需要裁定的三个决定：

1. **信号清单是否就是这六类**，特别是：A 类的「声明了但零事件」与 D 类的「人工转向通道从未使用」
   需要机制注册表，是否值得为它们新增读口，还是先只用已落地的四类。
2. **观察墙的位置**：方向面作为与三类观察面并列的第四面（本提案的默认），还是并入现有的「项目」
   磁贴作为一行摘要。
3. **裁定动词**：`退役 / 保留并注明理由 / 改为按需 / 误报` 四个动词是否够用；抑制账本
   `contraction-decisions.jsonl` 的字段与复核周期（默认 90 天）是否可接受。

评审结论以 commit message 或本任务 `## Notes` 补记留痕；评审通过后由人把任务置 done，再由 quay 立
第一条退役任务验证整条链路。
