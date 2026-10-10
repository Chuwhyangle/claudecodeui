# Live Monitor 48h 历史事件回放 — 结果

窗口 `2026-10-08T17:00Z → 2026-10-10T17:00Z`（`--now 2026-10-10T17:00:00Z`）。规则与阈值见 PREREG.md；
逐条通知见 NOTIFICATIONS.md；机读数值见 RESULT.json。所有输入都是真实载体，没有合成或补写
任何历史记录（lib.test.mjs 里的是单规则单元夹具，不进入回放）。

复现：`node collect.mjs --now 2026-10-10T17:00:00Z && node replay.mjs`（只读；task 正文按 `now`
时刻的 develop 树读取。载体被轮转后无法复现，这一点见数据缺口 G9）。

## 1. 输入面

| 项目 | 心跳 | outcome | suite 轮 | 状态迁移(git) | 备注 |
|---|---|---|---|---|---|
| claudecodeui | 6,001 | 157 | 133 | 296 | 主力 |
| quay | 4,766 | 112 | 71 | 231 | |
| archguard | 9,316 | 8 | 7 | 20 | |
| cantus | 9,484 | 11 | 7 | 24 | |
| meta-cc | 9,633 | 0 | 0 | 0 | 48h 只有心跳 |
| quay-fleet | 0 | 0 | 0 | 0 | 驱动自 09-23 起静默，但仍有 3 个 needs-human 挂着 |

原始事件合计 **40,513** 条（心跳 39,200 = 96.8%）。

## 2. 各级管线的削减

| 阶段 | 输入 → 输出 | 说明 |
|---|---|---|
| ① 机械去重去抖 | 39,200 心跳 → 77 次已稳定的投影变化 + 157 次抖动丢弃 | 38,803 条与前一轮投影相同。精确重复 = 0（这些载体本身不重复写） |
| ② 失败恢复合并 | 148 次尝试失败 → 71 条 `recovered`（合并了 136 次失败） | 6h 内自愈的占 92%；88 次 suite red → 38 条 red→green；窗口结束时仍开放 6 条失败链 |
| ③ 语义增量 | 1,510 → 964 | 丢掉：144 ff-escalation（全是 `resolved`）、92 绿 suite、81 条 promote 回声（git 已有）、77 次 stop_reason 类别翻动、17 条 needs-human 心跳回声、46 次重复 red、69 次重复失败 |
| ④ 分级 | Ignore 461 / Record 452 / **Notify 39 / Escalate 20** | |

**每 48h 59 条告警（约 30 条/天）**，覆盖 38 个 task；对比天真监视器 291 条（覆盖 84 个 task）。
原始事件 → 告警压缩比 **687×**；相对天真监视器 **4.9×**。

| 规则 | 条数 |
|---|---|
| Notify: human-decision（进入 needs-human） | 30 |
| Notify: failure-unrecovered（失败链开放 >6h） | 6 |
| Notify: release-dependency-parked / -stalled | 1 / 1 |
| Notify: cross-project-upstream-landed | 1 |
| Escalate: failure-streak（≥3 次失败且未落地） | 13 |
| Escalate: needs-human-expired（≥24h） | 7 |

每个 task 的告警条数：1 条 22 个、2 条 12 个、3 条 4 个、4 条 2 个。

## 3. 误报 / 漏报（结局派生标签）

标签：GT+ 34（33 个进入过 needs-human，1 个卡死），GT− 50（失败后在没有 needs-human 的情况下自行落地）。

| | 原型 | 天真监视器 |
|---|---|---|
| 被通知的 task | 38 | 84 |
| precision | **0.84**（32/38） | 0.40（34/84） |
| recall | 0.94（32/34） | 1.00 |
| 晚于出口才通知 | 0 | 0 |

**⚠ recall 有一大半是自证的**：33/34 个 GT+ 的定义就是「进入 needs-human」，而原型对进入 needs-human
必发 Notify。真正不循环的读数只有：(a) 误报那一侧；(b) 唯一一个「卡死」类 GT+
（`gap-claudecodeui-scoped-self-test-and-concurrent-worker-sessions-bypass-resource-gate`，1 次失败后
6h 无新尝试）被 `failure-unrecovered` 抓到了；(c) 下面的过期与漏报。

**误报 6 个，全部是失败类规则打在了最后自愈的 task 上：**

| task | 规则 | 失败次数 | worker 会话 |
|---|---|---|---|
| claudecodeui/gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged | failure-streak | 3 | 9 |
| claudecodeui/gap-mcp-session-send-reports-pending-interaction-it-queued-behind | failure-streak | 3 | 8 |
| claudecodeui/gap-debug-agent-simulates-permission-popup-for-mcp-e2e | failure-streak | 3 | 10 |
| quay/gap-routine-semantic-dedup-scan-parse-args-handrolled-variants | failure-streak | 3 | 4 |
| claudecodeui/gap-ac120-upload-input-locator-ambiguous | failure-unrecovered | 1 | 3 |
| quay/gap-ownership-replay-benchmark-redesign-two-stage | failure-unrecovered | 1 | 1 |

这几条按「结局」算是误报，但按「成本」不一定：前三个分别烧了 8–10 个 worker 会话才落地。到底
「烧了 10 个会话最后落地」值不值得通知，是**要人来定的策略**（见第 6 节 D1）。

**漏报 2 个，都是窗口边界造成的**：`quay/gap-goal030-post-merge-promotion-events-reading`、
`quay/gap-goal031-ac-coverage-suite-smoke-and-runtime-semantics` 在窗口开始之前就停进了 needs-human
（真实 Notify 本该在窗口外发出），又在 24h 过期之前离开。只回放 48h 的监视器看不到它们的入口。

## 4. 指定场景

| 场景 | 真实数据里出现的 | 原型的行为 | 证据 |
|---|---|---|---|
| **needs-human 过期** | 5 个在窗口开始前就已挂 >24h（quay-fleet ×3，挂 18–21 天；quay ×1；claudecodeui ×1，挂 20 天）；窗口内又有 2 个超过 24h | 7 条 Escalate；窗口前就已过期的，在窗口起点触发 | NOTIFICATIONS.md 头 5 行；needs-human-episodes.json |
| **发布依赖** | `claudecodeui/gap-quay-tab-loop-pulse-gantt-integration`：「**解除条件**：quay 出正式发布（含 kernel 的 tag + 插件产物 …）」 | park 时 Notify，6h 后 stalled Notify，24h 后 Escalate 过期 | git 状态史 + 该任务正文 |
| **测试红转绿** | 88 次 suite red（42 条红链）；38 条链后来转绿 | 每条链合并成 1 条 `red-to-green` Record；红本身不通知，除非 6h 不恢复 | RESULT.json `stage2` |
| **跨项目依赖** | task 正文里有 19 条跨项目引用边（15 个上游 quay task → claudecodeui）；窗口内只有 1 个上游落地时下游还开着 | `quay/gap-dashboard-kernel-not-packaged-in-plugin-artifact` 落地 → Notify `claudecodeui/gap-quay-tab-loop-pulse-gantt-integration` | NOTIFICATIONS.md `← quay/...` 一行 |
| **真实人工决策** | 38 段 needs-human：机械停派（归因不出 / 重试上限）17 段，task_write 写入 14 段，窗口前遗留 7 段；已关闭的中位时长 1.3h、p90 17.8h；出口：→todo 24、→done 4、→ready 1、→superseded 1、仍开着 8 | 一律 Notify；>24h Escalate | needs-human-episodes.json |

关于「真实人工决策」：17 段机械停派里有 16 段回到了 todo，但谁做的决定**从数据里看不出来**（G1）。所以原型
现在没法把「真要人拍板」和「机器停了一下、机器自己又放回去」分开，30 条 human-decision Notify 里有一部分
可能其实是噪声。这是当前最大的不确定性。

## 5. 运行中发现并修掉的问题（都有单测钉住）

1. **心跳里的 `needs_human` 是「本轮新停派」，不是常驻集合**（运行前修正，已写进 PREREG）。
2. **跨源竞态**：`10-09T10:36:56.577Z` 那一轮心跳把 `gap-live-voice-exclusive-mode-fixed-bar` 列进了 needs_human，
   但 git 里这个 task 在 3.5s 之前就已经翻成 done，心跳自己也带着 `committed:false`。如果不处理，就会产生一条
   假的 30h 过期 Escalate。修法：过滤掉 `committed:false`，并且已经 done/superseded 的 task 不再接受停派信号。
3. **窗口开始前就停进 needs-human 的 task 看不见**：从窗口起点的 develop 树里取出这些 task，入口时间用真实的
   park commit 时间；它们只记 Record，过期在窗口起点 Escalate。
4. **回放过程中线上系统在变**（两次运行之间有 task 落地），所以 task 正文改为按 `now` 时刻的 git 树读取。

**事后修改（看过结果之后改的）**：发布依赖规则。v1 只看关键词（正文里出现 发布/publish/（待外部）），
把 3 个 task 标成了发布依赖，6 条通知里只有 1 个 task 是对的：`（待外部）` 指的是「等外部的人」，
`项目新版本发布` 只是正文内容。v2 要求发布类词和阻塞条件（解除条件/阻塞/等待/blocked…）出现在**同一行**，
并去掉 `（待外部）`。两组读数：

| | v1 关键词 | v2 strict（默认） |
|---|---|---|
| 标成发布依赖的通知 | 6（3 个 task） | 2（1 个 task） |
| 人工读正文后确认是发布依赖的 task | 1/3 | 1/1 |

整体 precision/recall 两组相同，因为改变的只是规则标签，不影响是否通知。

## 6. 数据缺口

| # | 缺口 | 影响 |
|---|---|---|
| G1 | **状态迁移的执行者无法识别**：git 作者在每个项目里都是同一个（`Observer Probe` / `t`），`task_write by cli:<pid>` 里的 pid 是 quay CLI 的，不是会话的，`~/.claude/sessions/<pid>.json` 也对不上（0/全部） | 「真实人工决策」无法验证；needs-human 的出口是人还是机器分不出来 |
| G2 | **没有发布事件载体**（tag / npm publish / 插件产物） | 发布依赖什么时候解除观测不到，recall 没法测 |
| G3 | **跨项目依赖只能从正文文本里推断**，没有结构化的 `depends_on` | 19 条边全靠 id 文本匹配；重名 id 直接放弃；正文改动后边就会变 |
| G4 | **非 worker 会话的关联没有选择性**：66 条告警里 60 条都有主目录会话「提到」这个 task（外层/manager 会话什么都提） | 「关联会话」只有 worker 会话（来自 `session_id`）是可靠的；其余的需要结构化的 session↔task 链接 |
| G5 | `task-status-events.jsonl` 只记 promote | needs-human 进出、done 都只能靠解析 git diff |
| G6 | `fan-in-ff-escalations` 在窗口内只有 `resolved` | 没法从这里得到「升级开启」 |
| G7 | 窗口内 `halted`/`error` 一次都没有出现过 | driver-stuck 规则只有单测，没有在真实数据上验证过 |
| G8 | **静默项目分不清是停了还是闲着**：quay-fleet 驱动自 09-23 起没有任何心跳，但挂着 3 个 needs-human | 原型只能靠过期把它们抓出来；「驱动停了」本身目前不产生信号 |
| G9 | 载体只追加、会轮转；回放依赖 `--now` 和载体还在 | 隔得越久越没法复现；如果要做长期基线，需要把窗口快照归档 |
| G10 | GT 是结局派生的，不是人工标注 | 第 3 节的 precision 只是「对结局」的读数；还需要人工抽检 |

## 7. 要人来定的（不由本实验决定）

- **D1 失败成本策略**：「≥3 次失败最终落地」算误报（当前 GT 的口径），还是值得通知的成本信号？
  这会直接把 precision 在 0.84 和 1.0 之间移动。
- **D2 机械停派要不要降级**：17 段机械停派里 16 段回到 todo。如果它们大多是机器自己恢复的，
  human-decision 应该只对 task_write 写入的停派发 Notify，机械停派降成 Record，等 G1 补上再说。
- **D3 人工抽检**：从 NOTIFICATIONS.md 里抽 10–15 条（建议包括全部 6 条误报、7 条过期和那条跨项目通知），
  标「该不该打扰我」，用来校准 G10。
