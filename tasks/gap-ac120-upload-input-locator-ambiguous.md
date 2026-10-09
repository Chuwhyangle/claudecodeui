---
id: gap-ac120-upload-input-locator-ambiguous
title: AC-120 判据的定位被语音实时控件的第二个音频 file input 撞成二义：setInputFiles 报 strict mode
  violation（入口本体仍在）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-120
---
## Proposal

**现状（2026-10-09 本轮直接复跑，不是台账尾巴）**

`npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` **退出 1**，红在 `e2e/voice-trim.spec.ts:569`（`uploadFixture` 里的 `uploadInput().setInputFiles(AUDIO_FILE)`）：

```
Error: locator.setInputFiles: Error: strict mode violation: locator('input[type="file"][accept="audio/*"]') resolved to 2 elements:
    1) <input type="file" class="sr-only" accept="audio/*" data-testid="voice-realtime-upload-input"/> aka getByTestId('voice-realtime-upload-input')
    2) <input type="file" class="hidden" accept="audio/*"/> aka locator('input[type="file"]').nth(2)
  at uploadFixture (/data/home/yale/work/claudecodeui/e2e/voice-trim.spec.ts:569:5)
  at /data/home/yale/work/claudecodeui/e2e/voice-trim.spec.ts:724:21
```

台账同形（`.quay/gate-events.jsonl`）：AC-120 在 `2026-10-09T05:38:12.430Z` `verdict: pass`（treeSha `c76d463f01cb4b5b5836d53e8596484b93a58af6`）→ `2026-10-09T07:41:42.863Z` `verdict: fail`（treeSha `645abad15622d872a54a2199bfc9d24a5f4d4a40`）、`07:42:02.377Z` fail。台账 reason 只留了截断的 `[WebServer]` stderr 噪声（BABEL deopt / vite ws proxy EPIPE），**红不在断言、也不在启动前导**：本轮直跑复现出确定性的 `strict mode violation`（不是负载 flake —— 同一命令本机稳定重现同一行）。

**根因（四跳，逐跳可指）**

1. `e2e/voice-trim.spec.ts:553` 的 `uploadInput()` 是 `page.locator('input[type="file"][accept="audio/*"]')`。它上方 `:543–548` 的注释写明定位口径：靠 `accept="audio/*"` 而不是位置，因为 composer 的附件选择器也是 file input（那个没有 `accept="audio/*"`）—— 这是对「页面里**只有一个** `accept="audio/*"` 的 file input」的隐含假设。
2. `src/modules/chat/voice-realtime/VoiceRealtimeControl.tsx:92–97` 挂了第二个 `<input type="file" accept="audio/*" data-testid="voice-realtime-upload-input" class="sr-only">`（AC-315 的文件上传入口）。
3. 该控件由 `src/modules/chat/ChatInterface.tsx:752–753` 在 `isActive` 时**无条件**渲染在 composer 上方，**与 `?voiceDebug` 无关** —— 所以 `/?voiceDebug=1`（leg 1）与 `/?voiceDebug=off`（leg 2）两种 URL 下它都在场，宽定位在两条腿里都无法唯一。
4. 引入该 input 的提交是 `19ed0cb2`（`feat(voice-realtime): add file-upload audio source and proxy protocol-simulation tests (AC-315)`），`git merge-base --is-ancestor 19ed0cb2 HEAD` 退出 0；它落在 05:38 的 pass（treeSha `c76d463f`）之后、07:41 的 fail（treeSha `645abad1`）之前，与翻红时刻一致。

后果：`uploadInput()` 从「唯一」变成「两个」，Playwright 严格模式在 leg 1 的 `setInputFiles` 处直接抛错（`:569`，`e2e/voice-trim.spec.ts:724` 是 leg 1 的调用点）；即便跳过 leg 1，leg 2 的 `await expect(uploadInput()).toHaveCount(0)`（`:756`）也会因那个常驻的实时控件 input 命中 1 而红。**入口本体没消失**：`src/modules/chat/composer/VoiceUploadButton.tsx`、`ChatComposer` 的开关渲染、`useVoiceInput` 的同一条 `transcribeVoice` 链都还在 —— 红的只是**定位**，不是 AC 的保证。

**为什么前两次修复没有守住**

<!-- dedup-ref --> `gap-voice-file-upload-input`（done，`goal_ac: AC-120`）与 `gap-voice-upload-leg-unmeasured-under-shipped-recogniser`（done，`goal_ac: AC-120`）把这条判据做绿过（后者在 treeSha `39a17380` 上 AC-119/120/121/122 四腿全绿）。它们写守卫时，composer 的 footer 里只有一个 `input[type=file][accept="audio/*"]`；AC-315 的 `19ed0cb2` 在**另一个**语音面（`VoiceRealtimeControl`，GOAL-031 的产品面）加了第二个同形 input，并被无条件渲染进同一页面 —— 那两次的内容没错，是判据对「同形 input 只有一份」的隐含假设被打破。这两条 done 不构成 duplicate，因此本任务为新案（done 不构成 duplicate 的规则）。

**方案（把每条腿的定位收敛到它自己的元素，不弱化任何既有断言）**

1. `src/modules/chat/composer/VoiceUploadButton.tsx`：给它那个隐藏 input 一个稳定标识 `data-testid="voice-upload-input"` —— 与 `VoiceRealtimeControl` 用 `data-testid` 定位自己的 input 同构（每个语音面认领自己的元素）。
2. `e2e/voice-trim.spec.ts`：`uploadInput()`（`:553`）改为按该标识定位（`page.getByTestId('voice-upload-input')` 或等价的 `[data-testid="voice-upload-input"]`），并更新 `:543–548` 的注释：`accept="audio/*"` 不再足以区分，因为实时控件也挂了一个同 accept 的 input。`uploadEntry()`（`:556`，`getByRole('button', { name: 'Upload audio file' })`）不变 —— 实时控件那个按钮的名字是 `Upload audio`（来自 `voice.realtime.upload`），与 `Upload audio file` 不相撞。
3. 保持判据语义逐字不变：leg 1 仍断言入口可见 → 提交 fixture → 请求体是链路产出的音频（`RIFF`、长度界 `(0, FIXTURE_SEC + CAPTURE_TOLERANCE_SEC]`）→ composer 持有识别器文本 → `[voice] identifier fidelity` 打印到达（同一条链的证明）；leg 2 仍断言 `?voiceDebug=off` 下入口不可见、未发出请求。

**边界（不做）**

不改 `VoiceRealtimeControl` 的渲染条件或语义（它是 GOAL-031 / AC-315 的产品面，默认可见是有意为之）；不动 `useVoiceInput` / 裁剪链 / `transcribeVoice`；不削弱 `e2e/voice-trim.spec.ts` 任一既有断言；不改识别器替身；不新增开关；不引入新依赖；不改 AC-120 的 `criterion` 命令。

## AC

- [ ] AC1 `npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` 退出 0。修前同命令退出 1、红在 `e2e/voice-trim.spec.ts:569` 的 `locator.setInputFiles: Error: strict mode violation: locator('input[type="file"][accept="audio/*"]') resolved to 2 elements`（原文见 Proposal）；修前原文记进 DoD。
- [ ] AC2 `npx playwright test e2e/voice-trim.spec.ts`（整文件，AC-119/120/121/122 全腿）退出 0 —— 没有哪条腿被本改动弄红。
- [ ] AC3 定位收敛、不再靠同形属性：`grep -cF 'input[type="file"][accept="audio/*"]' e2e/voice-trim.spec.ts` 输出 `0`；`uploadInput()` 改为按 `VoiceUploadButton` 自己的稳定标识定位，即 `grep -cF 'voice-upload-input' e2e/voice-trim.spec.ts` ≥ `1` 且 `grep -cF 'voice-upload-input' src/modules/chat/composer/VoiceUploadButton.tsx` ≥ `1`。
- [ ] AC4 判据未被削弱（同一组既有断言仍在）：`grep -cF 'the chosen file never reached the recogniser' e2e/voice-trim.spec.ts` ≥ `1`；`grep -cF 'the chosen file reached the recogniser without travelling the same transcription chain' e2e/voice-trim.spec.ts` ≥ `1`；`grep -cF "getByRole('button', { name: 'Upload audio file' })" e2e/voice-trim.spec.ts` ≥ `1`；`grep -cF 'toHaveCount(0)' e2e/voice-trim.spec.ts` ≥ `1`。
- [ ] AC5 取假承重（两条，各留原文，随后均还原）：把 `uploadInput()` 改回宽定位 `input[type="file"][accept="audio/*"]` ⇒ AC1 退出非 0、红在同一 `strict mode violation`（证明新定位是承重的，不是装饰）；把 composer 的入口做成常显（`?voiceDebug=off` 下仍渲染 `VoiceUploadButton`）⇒ AC1 退出非 0、红在 leg 2 的 `uploadEntry()`/`uploadInput()` `toHaveCount(0)`。两次退出码与失败行原文记进 DoD。
- [ ] AC6 `npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`（`npx playwright test e2e/voice-trim.spec.ts -g "AC-120"`），AC-120 在 `.quay/gate-events.jsonl` 的尾巴由 `2026-10-09T07:41:42.863Z` 的 fail 转回 pass。
- **真落地**：不是「命令变绿」，而是**一份已知 WAV 经 composer 那个开关控制的入口进入链路，且判据读到的上传体确实来自该文件** —— leg 1 打印的读数原文（`[voice-upload] file=…s uploaded=…s bytes=…`）里 `uploaded` 落在 `(0, FIXTURE_SEC + CAPTURE_TOLERANCE_SEC]`、上传体头是 `RIFF`、且 `[voice] identifier fidelity` 打印到达；leg 2 在 `?voiceDebug=off` 下入口计数为 0、识别器请求数为 0。完成记录引用同一段原文。
- **撞车来源如实登记**：完成记录写明新增 input 的提交 `19ed0cb2` 与它所属的 AC（AC-315），并说明本任务只收敛 AC-120 自己的定位、未改对方产品面。
- **三条读数原文**（命令 + 退出码 + 失败行）：修前 AC1（Proposal 已录原文）；取假（宽定位还原）后的 AC1；取假（入口常显）后的 AC1。
- **L_D 该轴仍暗，理由**：本任务只修 e2e 定位与一处 `data-testid`，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 本任务的读数是入口的可见性与上传体的容器/长度，不是生成质量轴读数；目标层判据由 GOAL-006 的其余判据承担。

## Touches

- e2e/voice-trim.spec.ts
- src/modules/chat/composer/VoiceUploadButton.tsx
- tasks/gap-ac120-upload-input-locator-ambiguous.md
