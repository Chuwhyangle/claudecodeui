---
id: gap-live-voice-exit-icon-square-and-realtime-locale-keys
title: Live Voice Exit 按钮改回与相邻按钮统一的纯图标方块（LogOut + tooltip，共用 iconButtonClass），并为
  voice.realtime.* 补齐 12 个语言的翻译键
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 逐文件复核，带 file:line）

- `fad808b0`（2026-10-11，「separate the leave control from the stop…」，任务 `gap-live-voice-stop-vs-exit-affordances`）把 Live Voice 栏最右的红色纯图标停止方块换成了带文字的「Exit」按钮。现形态见 `src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx:354-367`：外包一个 `border-l` 分隔的 `<span>`（`:354`），按钮 class 为 `inline-flex h-10 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border/60 px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:px-3`（`:361`），内容是 `LogOut` 图标（`:363`）+ `data-testid="voice-realtime-exit-label"` 的可见文字 `t('voice.realtime.exitLabel',{defaultValue:'Exit'})`（`:364-366`）。
- 相邻的 Retry / Mute 用的是 `iconButtonClass`（`VoiceRealtimeBar.tsx:72-73`）：`inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-border/60 text-foreground transition-colors hover:bg-accent disabled:opacity-50`，纯图标（`:328`、`:341`）。Exit 与它们宽度、字色（`text-muted-foreground` vs `text-foreground`）、内容形态都不一致。
- **voice.realtime 全部没有翻译**：12 个 `src/modules/i18n/locales/*/chat.json`（de en es fr id it ja ko ru tr zh-CN zh-TW）的 `voice` 块里都没有 `realtime` 子块（zh-CN 的 `voice` 块在 `src/modules/i18n/locales/zh-CN/chat.json:100`），所以所有 `voice.realtime.*` 标签在任何语言下都回落到英文 `defaultValue`。代码里实际用到的键：`VoiceRealtimeBar.tsx` 的 busy / connecting / disconnected / exit / exitLabel / failed / listening / mute / muted / refused / retry / stopped / unanswered / unmute；`src/modules/chat/composer/ChatComposer.tsx:433,946,948` 的 unavailable / enter；`src/modules/chat/ChatInterface.tsx:479,1085` 的 needsSession。
- ⚠️ `voice.realtime.stopped`（`VoiceRealtimeBar.tsx:204-206`）的 `defaultValue` 是 JS 模板串 `` `Stopped the current turn — ${stopped.depth} still queued` ``，**没有把 depth 作为插值参数传给 t()**——一旦加了翻译，译文拿不到数字。加翻译时须改成 `{{depth}}` 插值并传 `depth`。`busy` 已正确使用 `{{elapsed}}` / `{{bytes}}`（`:229-234`）。

### 人的裁定（2026-10-11，操作者）

- Exit 改回**与相邻按钮统一的纯图标方块**：用离开语义的图标（`LogOut`），**无可见文字**，用 `title` + `aria-label` 提供 tooltip / 可访问名，**直接使用 `iconButtonClass`**（`text-foreground`、`h-10 w-10`）。
- **保留 `fad808b0` 引入的「离开 ≠ 停止」语义分离**：不得重新引入旧的停止语义（实心 `Square` / destructive 红底 / 点击即 abort）；`handleEnd` 仍只 `end()` + `onExit()`，不 abort 任何 run；running 行自己的 `running-turn-stop` 不动。分隔线 wrapper 是否保留由实施者按视觉统一取舍，但 `data-testid="voice-realtime-end"` 不变。
- 给 `voice.realtime.*` 加翻译键（至少 exit 与 VoiceRealtimeBar 用到的其它 aria/tooltip 标签），使标签本地化。

### 实施要点

1. `VoiceRealtimeBar.tsx:354-367`：按钮改用 `iconButtonClass`，删掉 `voice-realtime-exit-label` 那个 `<span>`；`aria-label` / `title` 继续用 `voice.realtime.exit`。`voice.realtime.exitLabel` 键随之不再使用（从代码删，不必加翻译）。同步改写 `:346-353` 的注释（它描述的是「labelled outline」形态）。
2. 12 个 `chat.json`：在**既有的 `"voice"` 块内部**加 `"realtime": {…}` 子块——⛔ 不得新加第二个顶层 `"voice"` 键（`src/modules/i18n/tests/localeDuplicateKeys.test.ts` 的 AC-171 原始文本扫描会红，`JSON.parse` 也会静默吞掉前一块）。en 的值与代码里的 `defaultValue` 一致；`stopped` 改为插值（见上）。
3. 既有断言随裁定改写（照实记录，不得静默删）：`src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx:386-388` 断言「the leave control carries a visible text label」；`e2e/voice-realtime-composer-embedded.spec.ts:1074` 断言 `voice-realtime-exit-label` 文字为 `Exit`。两处都按新裁定改为「无可见文字、有 aria-label/title、使用 iconButtonClass」，而「两键图标不同 / 不含 square / 含 log-out」与「退出不 abort」的断言保留。注意：`e2e/voice-realtime-composer-embedded.spec.ts` 是 AC-323 判据文件之一（AC-331 的「一字不改」守卫只限定于 `ec621a2b` / `8be9df6b` 两个实现提交自身的 diff，不覆盖本任务），本任务对它的改动仅限 `:1074` 那一行断言。

### 关联 / 粒度

<!-- dedup-ref --> 本任务反转 `gap-live-voice-stop-vs-exit-affordances`（done）AC1 里「退出键带可见文字标签」这半句，依据是上面的人的裁定；该任务的「离开 ≠ 停止」语义与两键图标不同保持不变。`gap-live-voice-e2e-scripted-upstream`（ready，工作树中）的新 spec `e2e/voice-realtime-scripted-scenarios.spec.ts:666` 同样断言 `voice-realtime-exit-label == 'Exit'`——那个文件尚未落 develop，不列入本任务 Touches；若它先落地，本任务实施时把该行一并按新裁定改写并在验证记录披露；若本任务先落地，那个任务 fan-in 时会因该断言红，需要它的执行者按本裁定改写。kept separate：操作者要求三条独立立案。

## AC

- [ ] AC1 纯图标方块（**取假形态，排在判据文件最前**）：`src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` 断言 `voice-realtime-end` 按钮 (a) `textContent.trim() === ''`（无可见文字），(b) 有非空 `aria-label` 与 `title`，(c) `className` 与 Mute 按钮（`voice-realtime-mute`）的 `className` 完全相同（即共用 `iconButtonClass`，含 `h-10 w-10` 与 `text-foreground`），(d) svg class 含 `log-out` 且不含 `square`；并且 `voice-realtime-exit-label` 不存在。判据 `npx vitest run src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` 退出 0（在未修复的树上 (a)(c) 必红，实施者记一次红读数）。
- [ ] AC2 离开不停止（负控，保留）：同一文件里「leaving Live Voice does not abort the running turn」的既有断言（`state.aborts === 0`）仍在且绿。判据同 AC1 命令退出 0。
- [ ] AC3 zh-CN 本地化：`node -e "const j=require('./src/modules/i18n/locales/zh-CN/chat.json');for(const k of ['exit','retry','mute','unmute','listening','connecting','muted','failed','disconnected','refused','stopped','busy','unanswered','enter','unavailable','needsSession']){const v=j.voice&&j.voice.realtime&&j.voice.realtime[k];if(typeof v!=='string'||!v.trim())throw new Error('missing voice.realtime.'+k)}"` 退出 0。
- [ ] AC4 12 个语言都有 exit：`node -e "const fs=require('fs');const d='src/modules/i18n/locales';for(const l of fs.readdirSync(d)){const j=JSON.parse(fs.readFileSync(d+'/'+l+'/chat.json','utf8'));if(!j.voice?.realtime?.exit)throw new Error(l)}"` 退出 0。
- [ ] AC5 stopped 带插值：`grep -c "{{depth}}" src/modules/i18n/locales/zh-CN/chat.json` ≥ 1，且 `grep -n "voice.realtime.stopped" -A3 src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx` 显示 `depth` 作为 t() 参数传入（不再是 `${stopped.depth}` 模板串）。
- [ ] AC6 locale 无重复键：`npx vitest run src/modules/i18n/tests/localeDuplicateKeys.test.ts` 退出 0。
- [ ] AC7 e2e（**自证；fan-in suite 不跑 Playwright**）：`VOICE_REALTIME_MODE=continuous npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` 退出 0（含改写后的退出键形态断言）。
- [ ] AC8 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：真实浏览器、界面语言切到简体中文，进入一个真实会话的 Live Voice——栏上 Exit 是与 Mute/Retry **同尺寸、同字色的纯图标方块**（LogOut 图标、无文字），悬停显示中文 tooltip（`title`），其余栏上标签（监听中/静音/重连等）也显示中文；在 Claude 回合在飞时点 Exit，回合**继续跑完**（不 abort）。证据落在本任务 `## 验证记录`：中文界面下栏的截图（桌面宽度与 375px 各一张）、tooltip 可见的截图或 DOM 读数（`title`/`aria-label` 值）、以及点 Exit 后回合继续的读数。仅有单元测试不算 done。

## Touches

- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx
- e2e/voice-realtime-composer-embedded.spec.ts (only the exit-label assertion near :1074)
- tasks/gap-live-voice-exit-icon-square-and-realtime-locale-keys.md (self)
