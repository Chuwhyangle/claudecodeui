---
id: gap-voice-capture-process-check-timestamp-blind
title: AC-148 判据盲于 console 时间戳前缀：0deec1fc 给 stdout 每行加 ISO
  戳，判据仍按整行等值/startsWith('{') 匹配，真实服务进程的启动行与捕获行读成零（AC-148）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-148
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on` 上，本条为空）：立案时 `grep -lE '^status: (todo|ready|needs-human)$' tasks/*.md | xargs grep -lE '时间戳|timestamp|stampLines|timestamped-console'` 零命中；`grep -rln 'voice-capture-process-check' tasks/` 在 in-flight 状态里零命中。三份 `goal_ac: AC-148` 的任务（`gap-voice-capture-real-process`、`gap-voice-capture-criterion-hardened-root`、`gap-voice-capture-real-db-timing-attribution`）全部 `done` —— 本条不是重复立案，而是「早先的修复没有守住」的证据：判据在其落地后又被后来的兄弟改动打红。

**现状（本轮立案时实测，可复验）**

| 读数 | 实测 |
|---|---|
| `node scripts/voice-capture-process-check.mjs` | exit 1，5 条 `check.failure`：`startup.text.count is 0, expected exactly 1 (voice.capture mode=text)`、`capture.lines is 0, expected exactly 1`、`upstream.exact is false: the capture row does not carry the double's body verbatim`、`text.exact is false`、`unset.startup.line is <none>, expected voice.capture mode=off` |
| 真实服务进程本身 | 同一个子进程里 `http.status=200`、`http.text.exact=true`、`unset.httpStatus=200`、`unset.text.exact=true`、`double.requests=1` —— 转写通路正常，红的只是「从 stdout 里读启动行/捕获行」这一层 |
| 子进程 stdout 的行形状 | `server/index.ts:3` 先 `import './load-env.js'`，其 `server/load-env.ts:15` 调 `installTimestampedConsole(console)`（commit `0deec1fc`，`git merge-base --is-ancestor 0deec1fc HEAD` 为真），把 `console.log/info/warn/error/debug` 包成「每行前缀一个 ISO 时刻」。实测 `stampLines('voice.capture mode=text')` → `"2026-10-12T00:00:00.000Z voice.capture mode=text"`；`stampLines(JSON.stringify({event:'voice.capture',…}))` → `"2026-10-12T00:00:00.000Z {\"event\":\"voice.capture\",…}"` |
| 判据的匹配方式（`scripts/voice-capture-process-check.mjs`） | 启动行按**整行等值**：L578 `stdoutLines.filter((line) => line === STARTUP_TEXT_LINE).length`、L599 `if (line === STARTUP_TEXT_LINE || line === STARTUP_OFF_LINE) return line;`；捕获行按**行首字符**：L615 `if (!trimmed.startsWith('{')) continue;`。带戳后这三处都不再命中 ⇒ `startupLine='<none>'`、`startupTextCount=0`、`captureRows=[]`（`capture.lines=0`，`upstream.exact`/`text.exact` 因为无行可比而 false） |

**根因（一句话）**：`0deec1fc fix(logging): stamp every server.log line with the instant it was written` 改变了真实子进程 stdout 的**行形状**，而 AC-148 判据把行形状写死成「整行等值 / 行首 `{`」；兄弟改动没碰 voice-capture 的接缝，却让判据对「真实存在的带戳启动行与捕获行」失明。

**为什么早先的修复没守住**：`gap-voice-capture-real-process`（done）当时判据通过，是因为它面对的是**加戳之前**的 stdout 形状。此后 `0deec1fc` 在 develop 上落地（本分支 HEAD 的祖先），行形状改变，判据的解析假设随之失效 —— 这是「兄弟落地把一条 pin/判据打红」的类别，不是 voice-capture 接缝本身回退（真实子进程仍然 200 且逐字返回替身文本，见上表）。

**修法方向（不外扩到 logging 特性）**

1. 判据在**匹配前**先剥掉行首的 ISO 戳，剥除只对匹配用的副本做：`const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;`，用 `line.replace(STAMP, '')` 之后再走整行等值（L578/L599）与 `startsWith('{')`（L615）。**不改** `server/modules/logging/*` 的时间戳特性（`server.log` 需要它；AC-148 判的是真实进程，不是 logging）。
2. 修完必须**先证明带戳行确实存在**再比对：`text` 跑必须读出 `startup.text.count=1`、`capture.lines=1`、`upstream.exact=true`、`text.exact=true`，`unset` 跑读出 `unset.captureLines=0`、`unset.startup.line=voice.capture mode=off`。修法必须是「还原后仍逐字比对上」，而不是「放宽到看不见缺失」。
3. 判据的取假形态自测 `scripts/voice-capture-process-check.false-forms.test.mjs` 同步更新：它同样按整行等值断言 `startup.text.line`/`unset.startup.line` 两条读数（L167/L174），对未变异副本当前已必然红；更新后两条变异仍须分别指名红在 `startup.text.count` 与 `capture.lines`。
4. 不得引入出货源码 import：判据自读的 `service-source-imports` 必须仍为 `0`。去戳只用一个本地正则；import `stampLines`（哪怕只为正则会）会把该读数打红，不要用。

（可选观测项，非硬性，别做成 AC：加一条读数记录「匹配用行剥掉戳后剩余文本」或「本行是否带戳」，让「行存在但带戳」与「行根本不存在」在读数上可区分，压住未来再犯。）

## AC

- [x] `node scripts/voice-capture-process-check.mjs` 退出 0（当前退出 1、5 条 `check.failure`）：判据把带戳的真实启动行与捕获行还原后逐字比对一致。
- [x] 同一次运行里 `startup.text.count=1`、`capture.lines=1`、`upstream.exact=true`、`text.exact=true`，且 `unset.captureLines=0`、`unset.startup.line=voice.capture mode=off`：证明带戳行确实存在于真实子进程 stdout，而不是匹配放宽后「看不见缺失」。
- [x] `node --test scripts/voice-capture-process-check.false-forms.test.mjs` 退出 0：未变异副本两例退出 0，两条变异仍分别红在 `startup.text.count` 与 `capture.lines`（判据没有靠放宽把红改成绿）。
- [x] 判据读数里 `service-source-imports=0`，且读数仍全部来自子进程 stdout 与替身请求记录（去戳只作用于匹配副本，不改写原始读数行）。

## DoD

- 真实落地：在**带 `0deec1fc` 的树上**跑 `node scripts/voice-capture-process-check.mjs` → exit 0；stdout 读数包含 AC 第 2 条那七条期望值（本次实测的 5 条红读全部翻绿）。这是「真实服务进程 + 一次真实 HTTP」这条对象被真正操作过，不是只跑通一个解析单测。
- 取假形态自测 `node --test scripts/voice-capture-process-check.false-forms.test.mjs` 在真实树上 exit 0，两条变异各自 red 在具名读数（`startup.text.count` / `capture.lines`）。
- 判据未新增对出货源码的 import（`service-source-imports=0`），未改动 `server/modules/logging/*` 的时间戳特性。
- 落地到 develop。

## Touches

- scripts/voice-capture-process-check.mjs
- scripts/voice-capture-process-check.false-forms.test.mjs
- tasks/gap-voice-capture-process-check-timestamp-blind.md