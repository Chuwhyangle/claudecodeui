---
id: AC-279
title: 停在 Conversations 视图时，新建或改名为命中规则的会话不会冒出来
status: achieved
kind: criterion
goal: GOAL-002
criterion: npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts
expect: 真实 Chromium 驱动真实服务（playwright webServer 与隔离数据目录）：登录 →
  经侧边栏的会话过滤编辑器保存一条规则（不得用 API 直建规则代替 UI 录入） → 切到 Conversations 视图并等列表加载完 →
  在页面已加载之后，经真实路径新建会话（写入真实转录文件，由后端 synchronizer 与文件监听器发现，与 quay drivers
  新建会话同一机制，不得向页面注入伪造的 session_upserted
  帧）。断言三件事。其一，正对照：同样方式新建、名字不命中规则的会话在限定时间内出现在列表里，证明新会话推送真的送达了该视图。其二，新建且名字命中规则的会话在同一时间窗内不出现，包括先无名、后补上命中名字的形态，以及列表里已有的行被改名为命中规则后消失。其三，一致性，重新加载
  Conversations（切走再切回，并整页刷新一次）后列表的成员与实时更新得到的完全一致，即实时视图与重新加载视图对命中规则的会话不能有分歧。同时断言页面无未翻译的
  i18n 字面量。取假形态：去掉新会话插入分支里的过滤判断，或去掉改名分支里的移除，该 spec 必须变红（正对照保证红不是因为什么都没发生）。⚠️
  当前必红：e2e/session-filter-conversations-live.spec.ts 不存在。
origin: 2026-10-06 落地复核。修复 e3a08557 已进构建并重启，用户仍看到问题。根因在
  src/modules/sidebar/hooks/useSidebarController.ts 的 session_upserted
  订阅，对列表里没有的会话无条件插入一行，对已有行只改标题，整段不认识项目的会话过滤规则，而 e3a08557 只改了 Projects
  列表一侧。库里事实是干净的（10-05 12:00Z 之后新建的会话在各项目几乎全被规则命中）且 recent
  接口本身已按规则过滤，所以只有实时路径漏。AC-101 与 AC-102 都只看静态结果，抓不到这条路径。
activatedAt: 2026-10-06T01:00:39.110Z
statusLog:
  - at: 2026-10-20T13:42:03.761Z
    from: active
    to: achieved
    actor: goal-cli
    reason: ""
---
