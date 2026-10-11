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

关于「真实人工决策」：17 段机械停派里有 16 段回到了 todo。**本节是改写前的读数**：当时谁做的决定**从数据里
看不出来**（G1），所以原型没法把「真要人拍板」和「机器停了一下、机器自己又放回去」分开，30 条 human-decision
Notify 里有一部分可能其实是噪声。**G1 已在本任务（§8）用 park commit subject 归因，D2 据此把机械停派降成
Record**；上面的 30 条读数保留为改写前的基线。

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
| ~~G1~~ | **状态迁移的执行者无法识别**：git 作者在每个项目里都是同一个（`Observer Probe` / `t`），`task_write by cli:<pid>` 里的 pid 是 quay CLI 的，不是会话的，`~/.claude/sessions/<pid>.json` 也对不上（0/全部） | **本任务（§8）已关**：执行者由 park commit subject 判（机械 / `task_write`），38/38 段定位、`unknown` 0；`task_write` 的发起会话再按会话标题细化，剩下的诚实记为 `cli-unattributed`/`session-other`。git 作者仍然不可用 |
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
  这会直接把 precision 在 0.84 和 1.0 之间移动。→ **本任务按「成本信号」落地**（§8.2）：这类命中改发
  `Notify: cost-signal` 并单列，既不计误报也不算命中；§8.3 给出前后对照。
- **D2 机械停派要不要降级**：17 段机械停派里 16 段回到 todo。如果它们大多是机器自己恢复的，
  human-decision 应该只对 task_write 写入的停派发 Notify，机械停派降成 Record，等 G1 补上再说。
  → **本任务落地**（§8.2）：G1 已补上（§8.1），机械停派一律 `Record: mechanical-park`，
  只有 `task_write` 写入的停派才 `Notify: human-decision`。
- **D3 人工抽检**：从 NOTIFICATIONS.md 里抽 10–15 条（建议包括全部 6 条误报、7 条过期和那条跨项目通知），
  标「该不该打扰我」，用来校准 G10。→ **已作为固定标尺用在本任务**（§8.3）：14 行（打扰 7 / Record 7）
  来自父任务 `## Resolution`，逐行给出新旧规则下的落点。

---

## 8. 本任务重跑：G1 执行者归因 + D1/D2/③ 规则改写

窗口不变（`2026-10-08T17:00Z → 2026-10-10T17:00Z`，`--now 2026-10-10T17:00:00Z`），同一份 `out/events.jsonl`
（载体未轮转，G9 未触发，无缺失分段）。复现：`node collect.mjs --now 2026-10-10T17:00:00Z && node replay.mjs --out out`；
D1/D2/③ 默认开（`lib.mjs` 的 `DEFAULTS`），关掉它们即 §8.3 的 before 列。**§1–§7 是改写前的基线，保留不动。**

### 8.1 G1 取证：执行者归因

G1 原说「谁做的决定从数据里看不出来」。重跑发现它**可从 park commit 的 subject 判**，不必解会话 pid：

| 判据（写在 `lib.mjs: classifyExecutor`） | 读法 | 归到 |
|---|---|---|
| subject 含 `归因不出` / `重试上限`（机械停派） | subject | `mechanical` |
| subject 含 `task_write by cli:<pid>` | subject | `task_write` |
| 其它 / 缺失 | —— | `unknown`（不臆造） |

`task_write` 的**发起会话**是第二个、更弱的问题：按会话标题（`~/.claude/projects/-data-home-yale-work-<proj>*/<sid>.jsonl`
的 `custom-title`；worker 会话是 `<proj>-task-worker`/`-fix-worker`）细化成 `worker-session` / `session-other`。匹配用**严格 id**：
写工具（MCP `task_write` 或 `quay task edit/write`）自己的 `id` 目标必须等于被停派的 task——正文里只是**提到**某 task id 不算命中。
匹配不上就记 `cli-unattributed`，**不臆造「人工」**。

**覆盖率 38/38，`unknown` 0（≤8）**；执行者 `{task_write: 18, mechanical: 20}`，发起方
`{driver: 20, worker-session: 10, cli-unattributed: 4, session-other: 4}`。（对照 §4：改写前只分得出「17 机械 / 14 task_write / 7 窗口前遗留」，且分不出发起方。）
⚠ 严格匹配下**没有任何一段能正当地归为「人工手写」**：18 段 `task_write` 里 14 段来自 worker 会话、4 段会话不在窗口内。

逐段证据（机读全量见 `needs-human-episodes.json`；sha = park commit，`git -C <proj> show <sha>` 可验）：

| # | 项目 | task | executor | actor | park sha | 进入 (UTC) | 退出 |
|---|---|---|---|---|---|---|---|
| 1 | quay-fleet | `gap-pwa-ac077-antishadow-control-splice-exact` | mechanical | driver | `77759c5867` | 2026-09-19T10:10Z | （仍开） |
| 2 | quay | `gap-retire-needs-human-cause-enumeration` | task_write | cli-unattributed | `2400cfa449` | 2026-09-20T07:02Z | （仍开） |
| 3 | claudecodeui | `gap-server-phase-concurrency-clamp` | task_write | cli-unattributed | `7c6e5ea29c` | 2026-09-20T22:49Z | （仍开） |
| 4 | quay-fleet | `gap-ac014-duplicate-sessionkey-from-resume` | mechanical | driver | `4393286d3d` | 2026-09-21T03:50Z | （仍开） |
| 5 | quay-fleet | `gap-ac009-criterion-transient-cli-unavailable` | mechanical | driver | `61befd1b7a` | 2026-09-23T03:49Z | （仍开） |
| 6 | quay | `gap-goal030-post-merge-promotion-events-reading` | task_write | worker-session | `948fcf2fbf` | 2026-10-08T03:03Z | 2026-10-08T23:31Z |
| 7 | quay | `gap-goal031-ac-coverage-suite-smoke-and-runtime-semantics` | task_write | cli-unattributed | `a821d680eb` | 2026-10-08T14:37Z | 2026-10-08T22:39Z |
| 8 | claudecodeui | `gap-ac153-criterion-wallclock-load-headroom` | task_write | worker-session | `0e281f24b6` | 2026-10-08T17:30Z | 2026-10-08T22:22Z |
| 9 | claudecodeui | `gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence` | task_write | session-other | `6fa651c80e` | 2026-10-09T00:00Z | 2026-10-09T01:17Z |
| 10 | claudecodeui | `gap-voice-realtime-dashscope-transport-harness` | mechanical | driver | `09faef7e22` | 2026-10-09T00:06Z | 2026-10-09T01:11Z |
| 11 | claudecodeui | `gap-ac140-dashscope-public-host-second-copy` | mechanical | driver | `b63c9b0c2a` | 2026-10-09T02:37Z | 2026-10-09T03:16Z |
| 12 | quay | `gap-direct-to-develop-bypass-check-git-fixture-cost` | mechanical | driver | `01eba64707` | 2026-10-09T02:48Z | 2026-10-09T03:13Z |
| 13 | claudecodeui | `gap-voice-realtime-browser-e2e-current-session` | task_write | session-other | `66bd8c89da` | 2026-10-09T04:53Z | 2026-10-09T06:25Z |
| 14 | claudecodeui | `gap-voice-realtime-microphone-human-smoke-test` | task_write | cli-unattributed | `32977e4665` | 2026-10-09T06:22Z | （仍开） |
| 15 | quay | `gap-goal033-selfhost-and-archguard-evidence` | mechanical | driver | `9703822297` | 2026-10-09T06:58Z | 2026-10-09T07:02Z |
| 16 | claudecodeui | `gap-asr-wire-probe-ws-frame-false-positive` | task_write | session-other | `be1b641f8c` | 2026-10-09T08:12Z | 2026-10-09T08:46Z |
| 17 | claudecodeui | `gap-goal-033-ac317-runnable-criterion` | task_write | worker-session | `0bdc0cde77` | 2026-10-09T09:29Z | 2026-10-10T03:48Z |
| 18 | claudecodeui | `gap-quay-tab-loop-pulse-gantt-integration` | task_write | worker-session | `1cdcfb8155` | 2026-10-09T10:22Z | （仍开） |
| 19 | claudecodeui | `gap-ac315-upload-criterion-boot-race` | task_write | session-other | `a1fa372595` | 2026-10-09T11:43Z | 2026-10-10T05:31Z |
| 20 | claudecodeui | `gap-ac188-composer-stop-outlives-dock-idle` | mechanical | driver | `e9c8911d5d` | 2026-10-09T17:26Z | 2026-10-10T02:08Z |
| 21 | claudecodeui | `gap-voice-segmented-relay-segmenter-relay-profile` | task_write | worker-session | `5a42d83fe6` | 2026-10-10T01:46Z | 2026-10-10T02:07Z |
| 22 | claudecodeui | `gap-goal-034-exit-conditions-section` | task_write | worker-session | `f6f6739720` | 2026-10-10T02:21Z | 2026-10-10T03:48Z |
| 23 | claudecodeui | `gap-voice-segmented-relay-segmenter-relay-profile` | mechanical | driver | `ddc0898934` | 2026-10-10T02:55Z | 2026-10-10T03:00Z |
| 24 | claudecodeui | `gap-goal-033-ac317-runnable-criterion` | task_write | worker-session | `99c4e73ac1` | 2026-10-10T03:54Z | 2026-10-10T05:26Z |
| 25 | claudecodeui | `gap-voice-segmented-relay-protocol-server-commit` | task_write | worker-session | `2e54b173e3` | 2026-10-10T05:12Z | 2026-10-10T08:14Z |
| 26 | quay | `gap-release-workflow-definition-lags-one-release` | mechanical | driver | `15d2afda0c` | 2026-10-10T06:39Z | 2026-10-10T07:32Z |
| 27 | claudecodeui | `gap-effective-capacity-probe-cgroup-cpu-mem-quota` | mechanical | driver | `9c2801f1bd` | 2026-10-10T08:18Z | 2026-10-10T08:44Z |
| 28 | claudecodeui | `gap-input-outline-classifies-turns-by-origin` | mechanical | driver | `a62d6610af` | 2026-10-10T08:31Z | 2026-10-10T09:27Z |
| 29 | claudecodeui | `gap-with-memory-cap-default-adapts-to-effective-memory` | mechanical | driver | `0d4e48840c` | 2026-10-10T09:05Z | 2026-10-10T09:53Z |
| 30 | claudecodeui | `gap-voice-segmented-relay-client-wiring` | mechanical | driver | `09e025cc68` | 2026-10-10T09:08Z | 2026-10-10T09:30Z |
| 31 | claudecodeui | `gap-input-outline-classifies-turns-by-origin` | mechanical | driver | `621505870f` | 2026-10-10T09:55Z | 2026-10-10T16:57Z |
| 32 | claudecodeui | `gap-voice-segmented-relay-client-wiring` | mechanical | driver | `aba3e64be2` | 2026-10-10T10:03Z | 2026-10-10T10:47Z |
| 33 | claudecodeui | `gap-session-host-control-lease-gate-rest-parity-followup` | task_write | worker-session | `a7af89051f` | 2026-10-10T10:11Z | 2026-10-10T12:31Z |
| 34 | claudecodeui | `gap-with-memory-cap-default-adapts-to-effective-memory` | mechanical | driver | `32c49bcfca` | 2026-10-10T10:14Z | 2026-10-10T11:55Z |
| 35 | claudecodeui | `gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu` | mechanical | driver | `1d858520eb` | 2026-10-10T10:33Z | 2026-10-10T11:55Z |
| 36 | claudecodeui | `gap-voice-realtime-upstream-pool-rotation` | mechanical | driver | `0e9bee67a9` | 2026-10-10T10:38Z | 2026-10-10T11:55Z |
| 37 | quay | `gap-ac356-criterion-environment-fatal-window-check-unsatisfiable` | mechanical | driver | `a59fd21c11` | 2026-10-10T11:42Z | 2026-10-10T12:21Z |
| 38 | claudecodeui | `gap-goal-037-exit-conditions-section` | task_write | worker-session | `a4612658b8` | 2026-10-10T16:39Z | （仍开） |

**诚实标出的不可归因部分**：4 段 `cli-unattributed`（#2/#3/#7/#14）与 4 段 `session-other`（#9/#13/#16/#19）——写工具
确实写入了（`task_write`），但发起会话要么不在窗口内的会话记录里（cli-unattributed），要么标题不是 worker 会话
（session-other，可能是外层/manager 会话代写）。这两类共 8 段，**不当作「人工拍板」计入**。

### 8.2 三条规则改写（D1 / D2 / ③）

① **失败成本信号（D1）**：`failure-streak` 命中但该 task 最终落地 ⇒ 记 `Notify: cost-signal`，**单列成 `costSignals`，
既不算误报也不算命中**（`score()` 里走独立的 `cost` 桶）。改写前这类是 Escalate + 记误报。
② **机械停派降级（D2）**：G1 判定为 `mechanical` 的 park ⇒ `Record: mechanical-park`；只有 `task_write`
写入的 park 才 `Notify: human-decision`（发布依赖仍走 `release-dependency-parked`）。
③ **过期 → backlog 汇总**：窗口开始前就已过期的遗留 park，从逐条 Escalate 收成**一条** `Record: pre-window-backlog`
（`attrs.count` + `attrs.tasks`），窗口内新过期的仍逐条 Escalate。

三条都由 `DEFAULTS` 的 `d1`/`d2`/`backlogSummary` 门控，因此同一窗口可以用旧规则重评（= §8.3 的 before 列）。

### 8.3 同窗口前后对照（before = D1/D2/③ 全关，after = 全开）

| | before（旧规则） | after（本任务） | Δ |
|---|---|---|---|
| 告警条数（Notify+Escalate） | 59 | **37** | −22 |
| Notify | 39 | 26 | −13 |
| Escalate | 20 | 11 | −9 |
| Record | 452 | 470 | +18 |
| Ignore | 461 | 461 | 0 |
| precision | 0.842（32/38） | **0.955**（21/22） | +0.113 |
| 误报 fp | 6 | **1** | −5 |
| 漏报 fn | 2 | 13 | +11（见下） |
| cost 信号 | —（旧规则记为误报） | 4 | — |

before 列**逐位复现 §1–§3 的原始读数**（59 / 39 / 20 / 452 / 461 / 0.842 / fp 6 / fn 2），所以它是可信的基线。

**4 条 cost 信号**（原 §3 误报表 #1–#4，正是「烧了 8–10 个 worker 会话才落地」那四条）：
`claudecodeui|gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged`、
`claudecodeui|gap-mcp-session-send-reports-pending-interaction-it-queued-behind`、
`quay|gap-routine-semantic-dedup-scan-parse-args-handrolled-variants`、
`claudecodeui|gap-debug-agent-simulates-permission-popup-for-mcp-e2e`。

**fn 13 的构成**（`contrast.after.fnBreakdown`）：D1/D2/③ 有意降级的中转 = `byDesignMechanicalD2` 6 + `byDesignPreWindowRule3` 5 = **11**；
真·边界漏报 `other` = **2**，正是 §3 原有的那两条（`quay/gap-goal030-…`、`quay/gap-goal031-…`，窗口前已停、窗口内离开）。
即 fn 增量 11/11 是**策略**而非缺口：结局派生标签把「进入 needs-human」一律算 GT+，而 D2/③ 有意把机械停派与遗留 park 降成 Record——
这是标签口径与降噪策略的已知错配，不是漏报。

**D3 固定标尺（14 行，打扰 7 / Record 7）逐行落点**（跑红条件 = 任一「打扰」行丢失）：

| # | 标注 | 项目 | task | 期望规则 | after 落点 | 判 |
|---|---|---|---|---|---|---|
| 1 | 打扰 | claudecodeui | gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged | cost-signal | Notify:cost-signal | ✓ |
| 2 | 打扰 | claudecodeui | gap-mcp-session-send-reports-pending-interaction-it-queued-behind | cost-signal | Notify:cost-signal | ✓ |
| 3 | 打扰 | quay | gap-routine-semantic-dedup-scan-parse-args-handrolled-variants | cost-signal | Notify:cost-signal | ✓ |
| 4 | 打扰 | claudecodeui | gap-debug-agent-simulates-permission-popup-for-mcp-e2e | cost-signal | Notify:cost-signal | ✓ |
| 5 | Record | claudecodeui | gap-ac120-upload-input-locator-ambiguous | failure-unrecovered | Notify:failure-unrecovered | 残留 |
| 6 | Record | quay | gap-ownership-replay-benchmark-redesign-two-stage | failure-unrecovered | Notify:failure-unrecovered | 残留 |
| 7 | Record | quay-fleet | gap-pwa-ac077-antishadow-control-splice-exact | — | Record:pre-window-backlog | ✓ |
| 8 | Record | quay | gap-retire-needs-human-cause-enumeration | — | Record:pre-window-backlog | ✓ |
| 9 | Record | claudecodeui | gap-server-phase-concurrency-clamp | — | Record:pre-window-backlog | ✓ |
| 10 | Record | quay-fleet | gap-ac014-duplicate-sessionkey-from-resume | — | Record:pre-window-backlog | ✓ |
| 11 | Record | quay-fleet | gap-ac009-criterion-transient-cli-unavailable | — | Record:pre-window-backlog | ✓ |
| 12 | 打扰 | claudecodeui | gap-voice-realtime-microphone-human-smoke-test | needs-human-expired | Escalate:needs-human-expired | ✓ |
| 13 | 打扰 | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | needs-human-expired | Escalate:needs-human-expired | ✓ |
| 14 | 打扰 | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | cross-project-upstream-landed | Notify:cross-project-upstream-landed | ✓ |

**7 条「打扰」全部落在期望规则上**（4 × cost-signal、2 × needs-human-expired、1 × cross-project-upstream-landed），
标尺不丢；`rulerFailures` 为空 ⇒ `node replay.mjs` 退出码 0。

**残留（诚实记录）**：D3 把 #5/#6 标成 Record，但两者在 after 里仍是 `Notify: failure-unrecovered`。原因是 AC2 的 ①
只覆盖 `failure-streak`，不覆盖 `failure-unrecovered`；且人当初判 #5 的前提是「failures=1」，而原始窗口里
`gap-ac120-upload-input-locator-ambiguous` 实际有 **3 次**失败（⇒ 它本身是 cost 信号、而非「1 次失败卡死」）。
这 2 行不改规则、如实留作对 D3 前提的复核对齐点。

### 8.4 取假：关掉 D1 ⇒ 4 条 cost 信号消失、标尺变红（AC4）

| 项 | 内容 |
|---|---|
| 变异（diff） | `lib.mjs` 的 `DEFAULTS`：`-  d1: true,` → `+  d1: false,`（单行） |
| 命令 | `node replay.mjs --out out; echo exit=$?` |
| 失败行 | `cost-signal notifications (0):`；标尺 ` 1..4 打扰 … expect=cost-signal -> Escalate:failure-streak   ✗ LOST`；`RULER FAIL: 4 打扰 row(s) lost: #1(gap-voice-false-forms-…), #2(gap-mcp-session-send-…), #3(gap-routine-semantic-dedup-…), #4(gap-debug-agent-simulates-…)`；`exit=1`，且 `RESULT.json.costSignals = []` |
| 旁证 | 对照列同时掉回旧口径：`precision 0.842→0.778`、`fp 6→6`（那 4 条又变回误报） |
| 还原 | 把该行改回 `d1: true`（或 `git checkout -- lib.mjs`）；重跑 ⇒ `cost-signal notifications (4)`、无 `RULER FAIL`、`exit=0` |

### 8.5 边界与遗留

- **不接产品面**：整体仍在 `experiments/live-monitor-replay/`，零生产代码 import（`git grep -l "live-monitor-replay" HEAD -- server src scripts e2e package.json` 为空）。
- **G9 未触发**：窗口内 `.quay/*.jsonl` 与 `tasks/` 均未轮转，本次重放没有缺失分段；但载体一旦轮转即不可复现，长期基线仍需快照归档。
- **仍不可归因**：8 段 `task_write` 的发起会话只到「worker 会话 / 非 worker 会话 / 窗口外」粒度（§8.1）；真正的「人手动拍板」在本窗口内**没有正例**可标。
- **标签口径 vs 策略**：`fnBreakdown` 的 11/11 是 D2/③ 的有意降级，需在下一轮把 GT 的「进入 needs-human 即 GT+」口径拆开，否则 fn 会被系统性高估。
