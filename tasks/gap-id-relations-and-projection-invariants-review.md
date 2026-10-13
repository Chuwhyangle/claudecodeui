---
id: gap-id-relations-and-projection-invariants-review
title: 架构审查文档：inputId/deliveryId/runId 的稳定关系与事实投影不变量（未审查不得大规模重构）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

本会话四次实测暴露的缺陷表面各异——**气泡永久悬空**、**「Waiting in the queue」行残留**、**busy 发送的消息气泡消失**、**页面长时间不更新**——但共有一个成因：**跨面传递的"身份"不稳定**，而**"哪条事实该投影成哪一行/哪个状态"没有书面不变量**。于是每个面各自用启发式推断身份（文本匹配、时间戳先后、行是否可见），推断失败就以"永远悬空"或"提前消失"收场。

在写更多修复、尤其在任何**大规模重构**之前，必须先有一份**经审查的**身份与投影契约——否则同一类错误只会被搬到新位置。这就是本任务存在的理由。

**扩展既有文档，不重写**：
- `docs/proposals/chat-transcript-streaming-architecture.md`——「**单一身份 · 结构化顺序 · 幂等归约**」，§1 设计原则（可检验的不变量），§529「验收：性质测试（取代现在的逐形态用例）」。
- `docs/proposals/voice-realtime-persistent-control-SPEC.md`——§4 身份模型、§7.1 条目级（一条用户说的话）状态机。

**本任务只产出文档**，不改产品代码。

文档至少包含四节：

**(a) 稳定 id 关系** —— `inputId` / `deliveryId` / `runId` 各自的**分配点**（谁、在什么时刻分配）、**生命周期**（何时生效、何时退休）、**关系边**（一个 `runId` 覆盖哪些 `deliveryId`；一个 `deliveryId` 覆盖哪些 `inputId`；一对一 / 一对多 / 多对一分别出现在哪些路径）。每项都要标注**现状实现位置**（`文件:行`）。

**(b) 事实投影不变量** —— 一条事实（persisted user turn / delivery / 队列命令 / 分段投递）在什么条件下**必须**投影成哪一行、什么条件下**必须**退休。**"退休的键"必须写明**，并沿用已经写对的那条口径：`markDeliveredVoiceMessages` 的「**替代物可见**」，而不是"服务端说了某个状态"。每条不变量给出**可检查的断言形式**，不是散文。

**(c) 重构闸门** —— 声明后续任何触及身份或投影的重构，必须先在本文档取得裁定并引用对应章节号；给出可检查的形式。

**(d) 现状缺口清单** —— 把本会话四次实测缺陷逐条映射到 (a)/(b) 中**缺失的那一条**，写明该补哪条不变量与其编号。

## Plan

1. 通读两份既有文档，抽取已有的不变量表述，避免重述。
2. 逐面标注三个 id 的分配点 / 生命周期 / 关系边（现状，含 `文件:行`）。
3. 写 (b)，每条给出可检查的断言形式。
4. 写 (d)，逐条对应四次实测缺陷，指到具体缺口编号。
5. 交人（或独立审查者）给出一条裁定记录，写进文档。

## AC

- [x] AC1 `docs/proposals/id-relations-and-projection-invariants.md` 存在，含 (a)(b)(c)(d) 四节且每节非空。
- [x] AC2 (a) 中三个 id **每个**都写齐「分配点 / 生命周期 / 关系边」三项，且每项都带现状实现位置——断言：三个 id 各自至少有 3 处 `文件:行` 引用。
- [x] AC3 (b) 每条不变量都有**可检查的断言形式**（不是散文），且其中至少一条明确写出「退休的键 = 替代物可见」。
- [x] AC4 (d) 把四次实测缺陷（气泡悬空 / 队列行残留 / busy 气泡消失 / 刷新不更新）逐条映射到 (a) 或 (b) 的某一条，并给出缺口编号。
- [x] AC5 取假形态：抽掉文档中所有 `文件:行` 引用 ⇒ AC2 红（证明 AC2 不是散文自证）。

## DoD

存在一份经审查的身份与投影契约文档；后续任何触及身份或投影的大规模重构都必须先引用它取得裁定；本会话四次实测缺陷都能在文档里找到对应的缺口条目与编号。

## Touches

- docs/proposals/id-relations-and-projection-invariants.md (new)
- docs/proposals/chat-transcript-streaming-architecture.md
- tasks/gap-id-relations-and-projection-invariants-review.md

## Notes

本任务是**审查文档**，不要求也不允许顺手重构代码；它的价值在于让后续重构有据可依。若写作过程中发现现有实现与 (b) 的不变量冲突，只记录为缺口（写进 (d)），不在本任务内修。

---

### 实现记录（worker，2026-10-13）

交付 `docs/proposals/id-relations-and-projection-invariants.md`（新增），并在 `chat-transcript-streaming-architecture.md` 追加 §12 指向它（`task/gap-id-relations-and-projection-invariants-review` 分支，提交 `3774b548`）。逐 AC 核验：

- **AC1**：§(a) 94 行 / §(b) 95 行 / §(c) 15 行 / §(d) 20 行，均非空。
- **AC2**：§A.1（inputId）20 处、§A.2（deliveryId）19 处、§A.3（runId）13 处**去重后**的 `文件:行` 引用，各自远超 3；每个 id 的「分配点 / 生命周期 / 关系边」三栏都带 `文件:行`。**如实登记**：`inputId` / `deliveryId` 在 `develop` 中**无同名字面符号**，故钉住其 de-facto 载体（`itemId`/`seq`/`local_*`/`live:*`；`queuedMessageUuid`）。
- **AC3**：B-1..B-7 七条不变量，各含 `∀ … ⇒ …` 可检查断言；**B-1** 明写「退休的键 = **替代物可见**」（引 `placeCaptions.ts:111/504/519`、`useSessionStore.ts:754`）。
- **AC4**：D1→**G-A1/G-B5**、D2→**G-A2/G-B2**、D3→**G-B1**、D4→**G-B4**（另列同源 G-A3/G-B6/G-B8）。
- **AC5 取假形态（已机械执行）**：以 `sed -E 's#<path>:<n>##g'` 抽掉全部 `文件:行` 后，§A.1/§A.2/§A.3 各降为 0 处 ⇒ 断言 `< 3` 成立 ⇒ **AC2 红**，证明 AC2 数的是可定位实现坐标而非散文自证。

引用的 `文件:行` 均按 `develop @ 97a797d0` 校准（含 `useVoiceRealtimeSession.ts:1412` 归属违规点、`:1433` 读 `queuedMessageUuid`、`replayCursor.ts:90` `subscribeTargetFor`、`:2127` `noteStatus`）。
