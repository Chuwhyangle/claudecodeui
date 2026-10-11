---
id: AC-332
title: 'GOAL-038 的实现不回归 AC-323 的判据（第二段）：CMD2 vitest 紧凑栏三态、CMD3
  mobile-workspace -g " idle "、CMD4 npm run typecheck 三条命令链一字不改仍 exit 0'
status: active
kind: criterion
goal: GOAL-038
criterion: VOICE_REALTIME_MODE=continuous npx vitest run
  src/modules/chat/tests/composerCompactTier.test.tsx
  src/modules/chat/voice-realtime && VOICE_REALTIME_MODE=continuous npx playwright test
  e2e/mobile-workspace-composer-layout.spec.ts -g " idle " && npm run typecheck
expect: GOAL-038 的实现不回归 AC-323 在域判据的第二段。本记录与 AC-331 是同一次人（yale
  2026-10-11）裁定的产物：把原 AC-331 的四命令 && 串行链**按 goal driver 的硬闸切成两段**——driver
  用 CRITERION_TIMEOUT_MS = 12e4 spawn 判据，并在 120000ms 对 spawn 发 SIGKILL；记录 frontmatter
  里的 timeoutMs 只作用于闸自己的 runner，管不到那一刀。而四命令冷串行 floor 实测
  126037–130179ms（CMD1 79349 + CMD2 4175 + CMD3 27006 + CMD4 19649），恒 > 120000ms ⇒
  闸在 sweep 里结构性写不出 pass（memory：ac-wallclock-bound-below-a-mandated-floor-is-unsatisfiable、
  goal-gate-inherits-sweep-env-and-driver-kills-it-at-120s）。第一段（CMD1 三份 e2e spec）留在
  AC-331，本段承担 CMD2–CMD4；两段的并集与原 AC-331 的命令集合逐条相同，覆盖面一字未减。承重结构（防止本段空过翻绿）：(1)
  必须跑在 GOAL-038 实现落地后的树上——develop 基线本来就绿（AC-323 已 achieved），只有实现没把它搞红才有信息量；(2)
  ⛔ 不许靠放宽 AC-323 的判据换绿——四文件白名单守卫在本段同样成立（CMD3 的被判对象
  e2e/mobile-workspace-composer-layout.spec.ts 正在白名单内），其形式与基线重钉见 AC-331 的 expect
  第 (2) 条及其说明；(3) 判据**显式声明它判断的配置**：`VOICE_REALTIME_MODE=continuous` 逐命令前置。理由不是绕过什么，而是让判据不再取决于
  cwd 有没有 `.env`——e2e 的服务端由 server/load-env.ts 从 cwd 读 `.env`，任务工作树里没有该文件（`No .env file
  found … ENOENT`），于是同一个判据在主检出与工作树里判的不是同一件事；continuous 是本部署
  `.env:13` 的取值，也是 AC-323 基线读数的取得配置（仓内默认是 segmented，continuous 是 escape hatch，见
  server/modules/voice-realtime/voice-realtime-mode.ts），把它写进判据即把「基线」固定在判据里。默认
  segmented 配置下确实另有一处红（e2e/voice-realtime-live-session-send.spec.ts 的 375px 腿，`≥2` 行只到
  1，同树单变量可复现：未设 rc=1、=continuous 4 passed），已另案立案，不在本段判据的覆盖范围内——本段判的是部署态的回归。
origin: '人 yale 2026-10-11 裁定：AC-331 按拆分推进。依据（同日同树实测，唯一变量是 mode）：四命令
  && 串行链的绿灯 floor 126037–130179ms 高于 goal driver 的 CRITERION_TIMEOUT_MS = 12e4，记录上的
  timeoutMs 无论取多少都写不出 pass，故把 CMD2–CMD4 拆为本记录、并在两条记录的判据里显式前置
  VOICE_REALTIME_MODE=continuous（未设臂：CMD1 42575ms 内 rc=1、375px 腿红；continuous 臂：4 passed、17728ms）。'
activatedAt: 2026-10-11T09:45:32.000Z
timeoutMs: 100000
---
