# Changelog

All notable changes to CloudCLI UI will be documented in this file.


## [1.40.0](https://github.com/yaleh/claudecodeui/compare/v1.39.0...v1.40.0) (2026-10-20)

### New Features

* add AC-409 live voice minimal config surface to goal-047 ([7c2c7e1](https://github.com/yaleh/claudecodeui/commit/7c2c7e1e11794db27540c73120b28eb6fd7d5ba2))
* add real-time paced audio source for voice-realtime sessions ([16cc7e8](https://github.com/yaleh/claudecodeui/commit/16cc7e8976971974151679d612b3a5df9149b426))
* add silence tail suppression probe and its readings report ([f237d83](https://github.com/yaleh/claudecodeui/commit/f237d83f51b9f512473f8a0dc0b671f3a5853d3b))
* **auth:** log every /api/auth request and the user-not-found rejection ([f52a198](https://github.com/yaleh/claudecodeui/commit/f52a198e16f43e0e9cba8a05c2168b8d7512bf24))
* **chat:** allocate a session when Live Voice opens a new conversation ([b36299d](https://github.com/yaleh/claudecodeui/commit/b36299d7b91dda1b466605b505cf14aec92ec336))
* **chat:** derive a resident pending row from the activity snapshot's deliveries ([9c0641c](https://github.com/yaleh/claudecodeui/commit/9c0641c8f202bf89db4bb1de8d5d1e7b6afcf91e))
* **chat:** keep the fork control visible without a `.group` ancestor ([c55d94e](https://github.com/yaleh/claudecodeui/commit/c55d94e5bc728854e12bf31328d4ae49463be0dc))
* **chat:** mark machine-origin transcript rows so they are not read as a person's ([989060b](https://github.com/yaleh/claudecodeui/commit/989060b4f1a7a7694d37712d70acfb96b2c7cb92))
* **chat:** merge Live Voice entry into the submit button ([6ddb14b](https://github.com/yaleh/claudecodeui/commit/6ddb14b9d14ee0ea329cdff5da2defb0774101fd))
* **chat:** render the dictation mic as a bordered chip ([048cc55](https://github.com/yaleh/claudecodeui/commit/048cc55232599a1657caf4129d35b7cdd7eb502e))
* **debug-agent:** a reproducible human permission popup for the MCP approval loop ([6afcc7a](https://github.com/yaleh/claudecodeui/commit/6afcc7a13fd92dfdb71cf378533cd0f9d1a0c966))
* declare loop.rerun_command + failed-file rerun dispatcher ([e115f2e](https://github.com/yaleh/claudecodeui/commit/e115f2e202535dffe90a6dfafd31e6dec0bfccac))
* **experiments:** Live Monitor 48h event replay prototype over real Quay carriers ([c9ee585](https://github.com/yaleh/claudecodeui/commit/c9ee58585133c6a2b14847cc6c54705ac5d1e2fa))
* **landing:** three-panel fleet overview and session terminal-state reduction ([063f1b5](https://github.com/yaleh/claudecodeui/commit/063f1b55f27fa433dd7c61457b08dd68d789a990))
* **live-monitor-replay:** G1 executor attribution + D1/D2/③ rule rerun ([c4dfc84](https://github.com/yaleh/claudecodeui/commit/c4dfc845d400a3768f2d73d623b98e7894e2c877))
* **live-voice:** 补录跨度守卫套 flag（默认 off）供 A/B 实测 ([2591ba8](https://github.com/yaleh/claudecodeui/commit/2591ba8b19b7c50a659d2a222094d5c535da0fe7))
* **mcp-changes:** serve Quay task status from a full-coverage async index ([17f22c8](https://github.com/yaleh/claudecodeui/commit/17f22c8e059cf80445b3a4c27ba7d7a34881605d))
* **mcp-gateway:** add audit telemetry columns and the mcp_usage_stats tool ([32ca0ff](https://github.com/yaleh/claudecodeui/commit/32ca0ff038f09a48ffbd32866f1fc2c3133a47b4))
* **mcp-gateway:** add the changes on-demand event stream (AC-335) ([3d65e88](https://github.com/yaleh/claudecodeui/commit/3d65e88fad9d21961651fb1a8d1d417627d91a22))
* **mcp-gateway:** resolve MCP targets by precedence and require exact targets for writes ([af7009b](https://github.com/yaleh/claudecodeui/commit/af7009bb6f4f66f6adb93d02bfb456ad16213f88))
* **mcp-gateway:** thread an optional correlationId through the write tools and read filters ([cebc261](https://github.com/yaleh/claudecodeui/commit/cebc2619f556c41d4f316215a0172dd3b8b3a118))
* **mcp:** bound the changes cursor with a server-side baseline LRU (AC-349) ([1eca6a3](https://github.com/yaleh/claudecodeui/commit/1eca6a36c2dd2266a463e80bfb5f6042d0eb4b49))
* **mcp:** draft_get / draft_set / draft_submit — read, replace and submit a session's unsent composer draft ([fa8c720](https://github.com/yaleh/claudecodeui/commit/fa8c72065828a3ab46c3362ac3795081d98ac347))
* **mcp:** expose pending interactions on session_get/sessions_list, distinguish interactive approvals, make approval_answer idempotent ([93342b2](https://github.com/yaleh/claudecodeui/commit/93342b274170ab5953b3e3801cb0ec1880cce31e))
* **mcp:** time-window pruning and a stable keyset cursor for session_search ([aa49832](https://github.com/yaleh/claudecodeui/commit/aa49832483f471f10f0d6a32d25b7d0b3efbd6f6))
* **mint-token:** add sweep subcommand to clear leftover observer-* subjects ([8a4f8dc](https://github.com/yaleh/claudecodeui/commit/8a4f8dc67b7fc30d2ae417fba912465f8f4cfc3d))
* **oauth-consent:** password-gate write-scope grants, group scopes by risk ([2a3be6c](https://github.com/yaleh/claudecodeui/commit/2a3be6c10386449c9f6e048bb7b95496f5c3c3b6))
* **quay:** fleet-summary endpoint and project-row task counts ([b2d274e](https://github.com/yaleh/claudecodeui/commit/b2d274e57b10d87cf6cb44bdb332b01dd660d64a))
* **quay:** relay the lanes verb for the Loop pulse gantt ([17bde94](https://github.com/yaleh/claudecodeui/commit/17bde94b606e234f319484ba0c8af08ca7d7b3a1))
* **quay:** render the Loop pulse gantt card from quay's packed lanes ([7fe72e7](https://github.com/yaleh/claudecodeui/commit/7fe72e71dc0f897b6bf0be13f1072d0b1a3d7f23))
* **quay:** wire the Loop pulse gantt to the shipped quay kernel ([06699ff](https://github.com/yaleh/claudecodeui/commit/06699ff9f36d7f14b8945b2470eb84a0896fe7f1))
* replay Live Voice P0.15 worst cases from a real independent re-run ([807ad0e](https://github.com/yaleh/claudecodeui/commit/807ad0ea8d748dd8edca845d21a12ab573ccc295))
* **scenarios:** share one session-lifecycle timeline with a pure execution surface ([f11bd1f](https://github.com/yaleh/claudecodeui/commit/f11bd1f8c379f24b8d8b1b2df47c9f7df0f4c1f3))
* **scripts:** add E10 入队—中断—出队 experiment (U1-U4) ([e256fb6](https://github.com/yaleh/claudecodeui/commit/e256fb6aab1b1bf8b724bf0b2dc3c8eb07a08ac4))
* **scripts:** name a missing declared optionalDependency in the suite prelude ([7f7c71f](https://github.com/yaleh/claudecodeui/commit/7f7c71f6969809cfd61566c520560627ab274465))
* **scripts:** name the memory-cap slice after the project, create it on demand ([3358d7e](https://github.com/yaleh/claudecodeui/commit/3358d7e486338707536dfabe883af706e3a32f09))
* **session-hosts:** refuse REST close under an active lease unless force:true (AC3-AC8) ([34ad8f0](https://github.com/yaleh/claudecodeui/commit/34ad8f036f365b925d7d7d15c61579c057652ab4))
* **sidebar:** navigate home from the wordmark and a mobile overview entry ([e91a889](https://github.com/yaleh/claudecodeui/commit/e91a889c985cb2ba859f0129f33d8ecdf6c63c6f))
* **sidebar:** render running sessions' phase, tool and elapsed ([d977c07](https://github.com/yaleh/claudecodeui/commit/d977c075f1bfd01a931f674013874d7694f347fb))
* **system:** report buildSha/builtAt on /health and add a manual freshness check ([2fd6870](https://github.com/yaleh/claudecodeui/commit/2fd68701158891d6614728bcba2da3d31ceec4bb))
* **test-sh:** server-phase concurrency ceiling adapts to effective CPU (min(16, effective_cpu x K)) ([ee847fe](https://github.com/yaleh/claudecodeui/commit/ee847fe0945147512652151c07019ff6e96a9cca))
* **vad:** five-scheme offline VAD comparison on the real 372.66 s uplink ([923d48f](https://github.com/yaleh/claudecodeui/commit/923d48f0a4b2a3cdf68523de929e690be96321d2))
* **vad:** replay three ML-VAD filtered uplink to real Qwen Realtime with silence backfill ([ec3502c](https://github.com/yaleh/claudecodeui/commit/ec3502c734f1d42bfa7b9c934ef248583b5abe43))
* **voice-e2e:** assert the narrator's announce remark and run-end summary ([575237e](https://github.com/yaleh/claudecodeui/commit/575237e08d75f1083a0306a3aa09f81765645865))
* **voice-realtime-ambiguity:** prereg the four ambiguity/world-model scenarios (AC-306) ([b1a6033](https://github.com/yaleh/claudecodeui/commit/b1a6033308229cdf54cf54b0208436d6d2629003))
* **voice-realtime:** add file-upload audio source and proxy protocol-simulation tests (AC-315) ([19ed0cb](https://github.com/yaleh/claudecodeui/commit/19ed0cb2ff1ea3270e8479ffd8fdd21ea8a11da4))
* **voice-realtime:** add http audio-upload diagnosis and upstream wire log ([775f4a4](https://github.com/yaleh/claudecodeui/commit/775f4a4c4cc31184d811f71ecfc38eaf524ec995))
* **voice-realtime:** add session_status voice tool reading the L3 status reading ([7bd2e9d](https://github.com/yaleh/claudecodeui/commit/7bd2e9d2354396e39e030ca8581da9de7fee6aea))
* **voice-realtime:** add the node-side uplink VAD classifier layer ([5aa5afe](https://github.com/yaleh/claudecodeui/commit/5aa5afe532266869c2fce3b173ee8eddfeabb1eb))
* **voice-realtime:** add the P0a live probes, traces and record checker ([abd2cd3](https://github.com/yaleh/claudecodeui/commit/abd2cd350d5de93a009ce0c299966a951baf584a))
* **voice-realtime:** add the P0b live probes, traces and the six-stage P0 conclusion ([74c9fae](https://github.com/yaleh/claudecodeui/commit/74c9fae1d2812d55c85f1ee5da4a119faa04b3cf))
* **voice-realtime:** add the segmented relay protocol and per-segment diagnosis (AC-319) ([d3d0bc2](https://github.com/yaleh/claudecodeui/commit/d3d0bc27701da24272e089284b21e6e206597b2e))
* **voice-realtime:** add the Silence Tail Suppression upload state machine ([32be79a](https://github.com/yaleh/claudecodeui/commit/32be79a9ab54f077d0675fa4b743d5afb8cd5516))
* **voice-realtime:** add three-arm same-source VAD replay probe ([93b3c8a](https://github.com/yaleh/claudecodeui/commit/93b3c8a53a1e6e011c3201fffa754c0d60192795))
* **voice-realtime:** audit a model stop as journal kind:interrupt ([0ad88ec](https://github.com/yaleh/claudecodeui/commit/0ad88ecb3e91a2493de67c28f3e6982a1da8a04d))
* **voice-realtime:** backchannel at the uncertain pause, not at every pause ([3779841](https://github.com/yaleh/claudecodeui/commit/37798418760c4289459cc356cf667650bc8f4168))
* **voice-realtime:** bound the Live Voice delivery queue and make refusal visible ([bc954a1](https://github.com/yaleh/claudecodeui/commit/bc954a1fab8501a9a837c3a2da3717eea08384bb))
* **voice-realtime:** cap tool_call_output size and add context-budget observation ([e2e126f](https://github.com/yaleh/claudecodeui/commit/e2e126f4c924e368a8bd16c1066aa5956e47320d))
* **voice-realtime:** capture uplink audio per connection with aligned endpoint timeline ([3a8ec1d](https://github.com/yaleh/claudecodeui/commit/3a8ec1dd3673c8f81656ffbdf7da8b4d35461ee5))
* **voice-realtime:** continuous default, drop transport toggle, attribute deliveries by committed-item watermark ([31e72df](https://github.com/yaleh/claudecodeui/commit/31e72dfd9100ea787150fac70a28407cda1c9b48))
* **voice-realtime:** CosyVoice TTS leaf — text → audio → downlink frames ([c3b668a](https://github.com/yaleh/claudecodeui/commit/c3b668af8f0a0cb6a5b3ce047cc0b660c2944aff))
* **voice-realtime:** date the server→upstream audio, with the socket's own backlog ([6be267f](https://github.com/yaleh/claudecodeui/commit/6be267f98da7baa8df2051c912e3e9f5a45deb0c))
* **voice-realtime:** declare segmented relay by default with a continuous fallback ([15a30dc](https://github.com/yaleh/claudecodeui/commit/15a30dcf7f8e80617b01c9225afc677b2e3bdc5b))
* **voice-realtime:** drive the bounded queue end to end and declare the e2e budget ([5bbfb1e](https://github.com/yaleh/claudecodeui/commit/5bbfb1e00e3dae7ed2c10e3269097e5d3d2ebdce))
* **voice-realtime:** drop transcript caption rows from the chat area ([2b7dfc1](https://github.com/yaleh/claudecodeui/commit/2b7dfc17decc7d90ee7bca1b0715174b6ac55bf5))
* **voice-realtime:** end a connection that spends at a runaway rate ([a3e2909](https://github.com/yaleh/claudecodeui/commit/a3e29098675325b3bf1cfb45acd773acdcb06a94))
* **voice-realtime:** enqueue the correction before the interrupt aborts (G1, AC-342) ([c397821](https://github.com/yaleh/claudecodeui/commit/c397821a2cf074feae1c840a24881da619c8618e))
* **voice-realtime:** fence model interrupts by run coverage and idempotence ([48e247d](https://github.com/yaleh/claudecodeui/commit/48e247d5a90d71b31207a8ed799f860851df0869))
* **voice-realtime:** fold the RunDigest into the status line and session_status ([d95dd0a](https://github.com/yaleh/claudecodeui/commit/d95dd0ac212fcc35310d784e9d3fd32109801673))
* **voice-realtime:** honest per-segment state from the graded ACK ([31eb4cd](https://github.com/yaleh/claudecodeui/commit/31eb4cde1d02bb956db03f18c5c7c0b79e341885))
* **voice-realtime:** inject a char-budgeted session context pack with hot-read relay settings ([27475e7](https://github.com/yaleh/claudecodeui/commit/27475e719312ed0d1169e97b2e1a9a9619a00351))
* **voice-realtime:** inject a compact execution-status line (S-A) ([36c353d](https://github.com/yaleh/claudecodeui/commit/36c353d1c46598589ae228496dc64e0865e821b6))
* **voice-realtime:** journal the window-opening queued frame ([b72ca56](https://github.com/yaleh/claudecodeui/commit/b72ca566f2d550f281fc3fb14b5e15f7fe7fadd6))
* **voice-realtime:** judge the three-arm VAD probe's ACs on measured frames, not self-report ([e59b022](https://github.com/yaleh/claudecodeui/commit/e59b022d1d030cad115466a125d3aa074515e4c6))
* **voice-realtime:** keep a warm standby upstream session and rotate to it when idle (AC-321) ([e0dfb90](https://github.com/yaleh/claudecodeui/commit/e0dfb90c8509461be8bc8264bf9214307e89f347))
* **voice-realtime:** keep the Live Voice entry tappable and answer the tap ([d5f9782](https://github.com/yaleh/claudecodeui/commit/d5f97823bef181cb3c869e25f425d1eed998475d))
* **voice-realtime:** Live Voice entry inside the composer, compact bar in the composer shell ([1264090](https://github.com/yaleh/claudecodeui/commit/1264090da1b2a555ca8b6d00d073e958ab3234a3))
* **voice-realtime:** make Live Voice a mutually exclusive fixed bar (AC-316) ([f6e678d](https://github.com/yaleh/claudecodeui/commit/f6e678d52000dd30f5ce8d103d91c7c2726d75d1))
* **voice-realtime:** make the upstream turn detector configurable (AC-325) ([a24cc9c](https://github.com/yaleh/claudecodeui/commit/a24cc9c6eb8e9835a165cb0f57419cd71865581f))
* **voice-realtime:** measure S-A status injection cost and latency offline ([9ea0378](https://github.com/yaleh/claudecodeui/commit/9ea03789d03b168051600afcf2858cca22365665))
* **voice-realtime:** narrator queue is droppable on a new user utterance (AC-406) ([69983a3](https://github.com/yaleh/claudecodeui/commit/69983a3f21448e93a260ef2e1fcc03cca0e686bc))
* **voice-realtime:** optional scripted upstream protocol state machine ([2822e5d](https://github.com/yaleh/claudecodeui/commit/2822e5d7e494d9169a0cbbfe7bf6f8ddfaa13324))
* **voice-realtime:** own omission-fill params in server/ and ship them with the build ([73109a1](https://github.com/yaleh/claudecodeui/commit/73109a1c0c6dc00766947f767bc555eabfffaa99))
* **voice-realtime:** per-connection transport opt-in ([9f32546](https://github.com/yaleh/claudecodeui/commit/9f32546e471ceb1430587b680856824f304176a8))
* **voice-realtime:** persist the live relay's own per-connection journal ([e49810f](https://github.com/yaleh/claudecodeui/commit/e49810fc7afbfbea9c23cc4c60b121d3e51e0645))
* **voice-realtime:** reconcile the segmented relay against one real run ([6c925d2](https://github.com/yaleh/claudecodeui/commit/6c925d287c6bdff17e1e973ccf922eee39fdef64))
* **voice-realtime:** reconnect a dropped voice connection and say so in a banner ([78bdb16](https://github.com/yaleh/claudecodeui/commit/78bdb16b8381766a36b6b697be65df944391188e))
* **voice-realtime:** refresh the queue depth on the turn boundary (AC-344) ([a181a92](https://github.com/yaleh/claudecodeui/commit/a181a925c187b45628a8b1d4e1802c387790162e))
* **voice-realtime:** resolve the realtime credential from per-user settings ([b1dc0a8](https://github.com/yaleh/claudecodeui/commit/b1dc0a80f68c8ae7500e6e57eff4923978fd9d6f))
* **voice-realtime:** resolve the spend window cap without a production default ([f17bf1d](https://github.com/yaleh/claudecodeui/commit/f17bf1de3b5a9233cc143341f0baa6ac59704e23))
* **voice-realtime:** resume a browser-suspended microphone AudioContext ([99790d1](https://github.com/yaleh/claudecodeui/commit/99790d1f3a7f0e928ba107564da2146092dc0a3c))
* **voice-realtime:** run-end narrator summary transition (AC-404) ([528512c](https://github.com/yaleh/claudecodeui/commit/528512cbd8483b11e12f6df0fd9f6dc609c5c194))
* **voice-realtime:** show the delivered message, marked as from the voice transcript ([ed3ba6a](https://github.com/yaleh/claudecodeui/commit/ed3ba6ac21f096465b8afcc1043c032389e837c5))
* **voice-realtime:** show the model's transcription of the user's audio as a user message (AC-317) ([e3c39c1](https://github.com/yaleh/claudecodeui/commit/e3c39c1a64b3fdb4887a412dac20c94d472147d4))
* **voice-realtime:** stamp a delivery's boundary when the model relayed it ([8e0f7d9](https://github.com/yaleh/claudecodeui/commit/8e0f7d9d9ce5a828665badf21fdd96d0eef5d508))
* **voice-realtime:** stop the current turn by voice ([f981e81](https://github.com/yaleh/claudecodeui/commit/f981e8128212622c8350a363bf04dcd65541fefb))
* **voice-realtime:** surface the delivery wait on the Live Voice row (AC-327) ([8be9df6](https://github.com/yaleh/claudecodeui/commit/8be9df6bc554d7daa76f1cb04ce7b3199e8b4c27))
* **voice-realtime:** tell the next turn what the interrupted turn was doing ([245a400](https://github.com/yaleh/claudecodeui/commit/245a4003cdab060fcf7aa5874682bd8bdb759efa))
* **voice-realtime:** uplink VAD production arm point ([8c22106](https://github.com/yaleh/claudecodeui/commit/8c221064924db64c6789ad1f1960bf2ca1ed35ed))
* **voice-realtime:** wire the browser's mic → editable intent → real session_send (AC-312) ([86fd9da](https://github.com/yaleh/claudecodeui/commit/86fd9da5c56cd2af7dbcec5ef2c2876db49f30b3))
* **voice-realtime:** 三臂探针在含连续无语音的 excerpt 上红先行复跑，复议零过滤的根因 ([319414e](https://github.com/yaleh/claudecodeui/commit/319414eebf03dacd2c7c538f2d19f690da3cad6f))
* **voice-realtime:** 连续模式真实校准 C-1/C-2/C-4/C-5 单次运行 + 成本基线 ([80e0aee](https://github.com/yaleh/claudecodeui/commit/80e0aeedd955c020227e739a1d875de445cb2c43))
* **voice-segmented-relay:** add a relay profile to the live segmenter ([6dc8e86](https://github.com/yaleh/claudecodeui/commit/6dc8e86cb9baf78f022da74adb84889ed7759610))
* **voice-segmented-relay:** wire the segmented relay into the Live Voice capture path ([be75b6e](https://github.com/yaleh/claudecodeui/commit/be75b6ebd49529ea1ee10b03ccdde156f662395d))
* **voice-turn-detection:** add P0.11 fine-grained Pareto densification sweep ([8986206](https://github.com/yaleh/claudecodeui/commit/8986206c58820b4d5eb042e6f2c21cc82bdbef32))
* **voice-turn-detection:** add P0.12 realtime timeout / 14s anomaly diagnosis ([e6f71cb](https://github.com/yaleh/claudecodeui/commit/e6f71cb6c24259c1ddc06931670643e820d2bcfe))
* **voice-turn-detection:** Chinese zero-shot Smart Turn v3.2 vs turn-1-mini + fine-tune readiness ([ced591e](https://github.com/yaleh/claudecodeui/commit/ced591e1c4ea88f5b096894bb6d3fda5818f1618))
* **voice-turn-detection:** compare Smart Turn v3.2 with the shipping VAD and probe non-realtime qwen tool calling ([670e83d](https://github.com/yaleh/claudecodeui/commit/670e83d74d012e8268b6c03f22a7a85e4a2759d1))
* **voice-turn-detection:** label the P0.8 summary with the small-sample caveat ([463fc12](https://github.com/yaleh/claudecodeui/commit/463fc12472d5f469229667070ebac1eb74a1ac5e))
* **voice-turn-detection:** P0.10 closing-safety B0-B4 ([1afcf98](https://github.com/yaleh/claudecodeui/commit/1afcf9883dd8562c340823f711502234c161ea97))
* **voice-turn-detection:** P0.13 English Smart Turn v3.2 vs p99lab/turn-1-mini unified benchmark ([17ed656](https://github.com/yaleh/claudecodeui/commit/17ed656891d2ac102f7f45f15a16ce01d4cbe24a))
* **voice-turn-detection:** P0.5 expansion — Smart Turn root cause, sample set, candidates, qwen probe ([b5ab3f9](https://github.com/yaleh/claudecodeui/commit/b5ab3f9630a12a4f61c5ef5babf69a9113adea3c))
* **voice-turn-detection:** p0.6 real-audio dataset, compiled smart-turn front-end, livekit v1-mini measured ([933a4bc](https://github.com/yaleh/claudecodeui/commit/933a4bc3cbdcc223aefacacddd81680d59123b13))
* **voice-turn-detection:** P0.7 unified eot-bench replay for Qwen Realtime ([66d39da](https://github.com/yaleh/claudecodeui/commit/66d39da2630feed778a76d89df4c7b16c9616b48))
* **voice-turn-detection:** P0.8 paired realtime-vs-non-realtime pilot ([df6e64d](https://github.com/yaleh/claudecodeui/commit/df6e64d2557ee73df66cfaeca09d180f02765e35))
* **voice-turn-detection:** P0.9 staged cheap feasibility — stage1 VAD sweep + stage2 local detectors ([a0f4a4c](https://github.com/yaleh/claudecodeui/commit/a0f4a4c73676f2b115fe07acdabe8397d784f9b8))
* **voice-vad:** uplink gate keeps real head-a audio + exit commit/response.create ([55bdca2](https://github.com/yaleh/claudecodeui/commit/55bdca2b6e8124bf96545339f17fbf0d7ca997a6))
* **voice:** add a local Kokoro TTS leaf behind VOICE_REALTIME_TTS_LOCAL ([5bba4be](https://github.com/yaleh/claudecodeui/commit/5bba4be947c764b9d661cf6cfb92fe6bdeced700))
* **voice:** add an arming phase until the first captured frame ([c99a0ea](https://github.com/yaleh/claudecodeui/commit/c99a0eaba8f6a52b42ea34647b43e06ebd302076))
* **voice:** admit Live Voice relays by UTF-8 byte budget, show the backlog ([866f9c4](https://github.com/yaleh/claudecodeui/commit/866f9c48269f5dc04a247345d9457905e0ba6daa))
* **voice:** announce closing-turn start confirmation ([9343214](https://github.com/yaleh/claudecodeui/commit/93432146b1a28389e83e840066d6b8ec230f1086))
* **voice:** generate run-end summaries through a side text model ([e0ee8c6](https://github.com/yaleh/claudecodeui/commit/e0ee8c6b133bfb74c6fe665ebd8a3f0e4e2809fe))
* **voice:** give live voice its own credential, separate from voice-input ([4e433b1](https://github.com/yaleh/claudecodeui/commit/4e433b1c18d4b29ab621219f19bf0cb24f3c531d))
* **voice:** hold ONE merged pending message in the relay (ruling 2026-10-14) ([9ccdc6e](https://github.com/yaleh/claudecodeui/commit/9ccdc6eb7cb8525183f513eadbe6130947223671))
* **voice:** reconcile live-voice queue depth against the host command_lifecycle ([047f0b4](https://github.com/yaleh/claudecodeui/commit/047f0b46db92eecf6b25ba277f01e839156c26a3))
* **voice:** record why a segmented segment was lost, without changing behaviour ([4fd9248](https://github.com/yaleh/claudecodeui/commit/4fd9248e70727fe582dd5d5970ba895ef1a36aec))
* **voice:** route announce remark into the narrator queue ([f18c966](https://github.com/yaleh/claudecodeui/commit/f18c966ee5d164c5e85eb8854586c84d9cedb02a))
* **voice:** shorten the fixed announce phrases to interjections ([34647ae](https://github.com/yaleh/claudecodeui/commit/34647ae0aa269cb9dbc269c969f732f60663b620))
* **voice:** speak the model's text reply through the narrator ([d91686d](https://github.com/yaleh/claudecodeui/commit/d91686d444418c527c5e823f9ba9294fa3621253))
* **voice:** surface the heard-not-forwarded disposition under the continuous relay ([4245cfe](https://github.com/yaleh/claudecodeui/commit/4245cfe4d5dd3c25a372f3af20beac89cd9417e2))
* **voice:** switch narrator TTS to qwen3-tts-flash with a system voice ([6709029](https://github.com/yaleh/claudecodeui/commit/6709029cc4712fb3aeaa2a1678ea6e202730093d))
* **voice:** wire narrator TTS downlink and split Voice settings tabs ([e1323ab](https://github.com/yaleh/claudecodeui/commit/e1323ab944cc1208c48f7fab9d2bbcb8654e2764))
* **voice:** withdraw a single pending utterance from the Live Voice queue ([6c5378b](https://github.com/yaleh/claudecodeui/commit/6c5378b757f3ff3c23c6caa3b41d8bdd45c47bca))
* 加 continuous 传输小额真实校准（R-1/R-2/R-3）读数与实验脚本 ([e089cab](https://github.com/yaleh/claudecodeui/commit/e089cabf6b51cdd2709357dc95ad083b38829e92))

### Bug Fixes

* **asr-wire-probe:** parsed-text-field must parse a response body, not a WS frame (AC-129) ([f164111](https://github.com/yaleh/claudecodeui/commit/f164111ceefdcc59895d5bc8d16fb1f1aca19d5e))
* **auth:** lapse the session only on a server-side 401 ([f30cf7e](https://github.com/yaleh/claudecodeui/commit/f30cf7e5b405deb665ba9c9409b9b0146995c765))
* **auth:** let only the server's 401 end the session ([ea98469](https://github.com/yaleh/claudecodeui/commit/ea98469539a562b749875e27d697cc3b83453ccb))
* **auth:** reject replayed older X-Refreshed-Token and mark /api uncacheable ([b658f47](https://github.com/yaleh/claudecodeui/commit/b658f47a9c12fba63e770d21c542997b776a949c))
* **chat:** Escape stops the turn only from the composer, and only with no layer open ([41230d8](https://github.com/yaleh/claudecodeui/commit/41230d873151391ed88f49e2744f19ac5ff6234c))
* **chat:** hide the fork control per turn, not per session ([1c92f63](https://github.com/yaleh/claudecodeui/commit/1c92f63bacd49114e11d33e6f38714a16f3ddb4d))
* **chat:** keep a busy-send message until its turn row is visible ([f2d5878](https://github.com/yaleh/claudecodeui/commit/f2d5878586a09a79b58ee5de9c0fcb96bff639d0))
* **chat:** keep pending questions answerable while Live Voice is active ([d645c70](https://github.com/yaleh/claudecodeui/commit/d645c702621f5cded6c86f07a3a42fe05adae057))
* **chat:** keep the deferred pin when a settle clamps the viewport to the bottom ([17515c7](https://github.com/yaleh/claudecodeui/commit/17515c7f57faf140be1157524ac64f431ee344f9))
* **chat:** one bubble for an idle resident send ([6952b30](https://github.com/yaleh/claudecodeui/commit/6952b309112cd662f0cefdf28fd0ef0401a9515a))
* **chat:** only let a gesture detach the transcript follow ([97c0ed4](https://github.com/yaleh/claudecodeui/commit/97c0ed4d17226f16f03811da5a6e2bb31a51208a))
* **claude-history:** 请求捕获行不再被投影成聊天消息 ([343f3d3](https://github.com/yaleh/claudecodeui/commit/343f3d33a90ba32068c91f9943482172b22578fc))
* **claude:** settle every round a merged resident turn ends ([695096d](https://github.com/yaleh/claudecodeui/commit/695096dc392e052a41c4da393c4eb672c0804de9))
* consume resident intent when the Live Voice entry allocates a session ([fd732fd](https://github.com/yaleh/claudecodeui/commit/fd732fdb969a94b2455d9f2d94aee8dcd93ae245))
* **debug-agent:** ignore checkout path when scanning the load-arm red for a readiness cause ([76e07df](https://github.com/yaleh/claudecodeui/commit/76e07df5bf4f80caa56fb4a731d83cbe1d286803))
* derive the Quay In-flight card from the same lanes reading as the Loop pulse gantt ([ac55c82](https://github.com/yaleh/claudecodeui/commit/ac55c8262e74a4a32c8cbc425c58c986d081dab9))
* **e2e:** AC-345 case 4 重锚——中断的更正跑了跨度守卫，判据前提过期 ([8c3c60c](https://github.com/yaleh/claudecodeui/commit/8c3c60c9924d2c2ca097555aa800a5be10b531de))
* **e2e:** arm AC-323 composer spec with a first captured frame that does not spend the call ([8cb707a](https://github.com/yaleh/claudecodeui/commit/8cb707acc86b609d09b2cd44d4d2bd0f81bf62bf))
* **e2e:** extend the boot-readiness/reload discipline to AC-328's fixture and leg 2 ([201e3ac](https://github.com/yaleh/claudecodeui/commit/201e3acb9b14169637448f19d89e386bbed84ced))
* **e2e:** gate AC-328's leg 1 on the app rendering, not on a fixed read-count window ([01d5644](https://github.com/yaleh/claudecodeui/commit/01d5644d5ec4bcb174f76d5841fe20760ccc3e6c)), closes [#root](https://github.com/yaleh/claudecodeui/issues/root) [#root](https://github.com/yaleh/claudecodeui/issues/root)
* **e2e:** give the composer-embedded spec's inline FakeAudioContext the statechange API ([fbb9221](https://github.com/yaleh/claudecodeui/commit/fbb92218684ff6e8a737c58d202c784a1fe29ad6))
* **e2e:** give the reload path a bounded decision window that can replay (AC-315) ([25e6fb2](https://github.com/yaleh/claudecodeui/commit/25e6fb28b3524b932691f75d958d091a269b88f8))
* **e2e:** give the upload fixture speech the relay can commit, and bound its round trip ([47407fc](https://github.com/yaleh/claudecodeui/commit/47407fca139d411966917e8f144b1865f4ca3cde))
* **e2e:** locate the voice-upload input by its own test id (AC-120) ([0aad71d](https://github.com/yaleh/claudecodeui/commit/0aad71dfafbe056be768bd831a8d44235b9de7bc))
* **e2e:** make the access-tokens startup guard replay reachable ([1c611f1](https://github.com/yaleh/claudecodeui/commit/1c611f1454e7de64ffe3e98312fa11d79f1ebc4f))
* **e2e:** run the AC-142 legs on one document instead of three (AC-142) ([f0cdab3](https://github.com/yaleh/claudecodeui/commit/f0cdab3c19ef751a44774b05a7f52456467234f1))
* **e2e:** run the voice-realtime replay server from a .env-free root ([60de041](https://github.com/yaleh/claudecodeui/commit/60de041a6f6f7d126c306815d7552629b3fb9a32))
* **e2e:** sample voice rows via textContent and declare AC-315 gate timeoutMs ([753d249](https://github.com/yaleh/claudecodeui/commit/753d249fdb500ee14556e059dbf61cd3036f932e))
* **e2e:** share one account between the two voice-realtime specs, add upload mobile leg ([ef44909](https://github.com/yaleh/claudecodeui/commit/ef449097255993b45cdb108595d31de342296c0a))
* **e2e:** the scripted upstream speaks for the session the scenario is on, not every live connection ([43e03a5](https://github.com/yaleh/claudecodeui/commit/43e03a5146994876b483ddc692e3db7005f005a1))
* **e2e:** 用例 4 的守卫读数再收紧——逐字断言该句在更正之前（spoken order） ([af3f21b](https://github.com/yaleh/claudecodeui/commit/af3f21b9b1a43764efad2a9e669088a35a32ada6))
* **fan-in-suite:** re-judge a contention red alone in both suite judges ([bfba71e](https://github.com/yaleh/claudecodeui/commit/bfba71e208f121413d4992458172bcb9319b3f85))
* **fan-in:** cover new voice-realtime tests in the duration baseline ([0a1b116](https://github.com/yaleh/claudecodeui/commit/0a1b116169f3a7e288c57d251c339e582ac778f7))
* **goals:** declare AC-316 timeoutMs above its serial criterion wallclock ([5423a03](https://github.com/yaleh/claudecodeui/commit/5423a03f52b95f819518019c5f7c0a0c7edda43b))
* **goals:** declare AC-323 timeoutMs above its serial criterion wallclock ([19df213](https://github.com/yaleh/claudecodeui/commit/19df2137f2bbffeb2dba4adfdc3451736b61a842))
* **goals:** declare AC-331 timeoutMs above its serial criterion wallclock ([b53fa70](https://github.com/yaleh/claudecodeui/commit/b53fa704f89a7638f9ebb7caa1178df4430421b8))
* **goals:** declare AC-345 timeoutMs 118000 so its criterion survives the gate budget ([707cff1](https://github.com/yaleh/claudecodeui/commit/707cff15d1d3f7e79561f869c134d5af415f35ca))
* **live-voice:** 每段音频只进一条文本——有 response 就只用 response ([0b9e9ab](https://github.com/yaleh/claudecodeui/commit/0b9e9abba62e75ac1054d80604c90e4232a0e937))
* **logging:** stamp every server.log line with the instant it was written ([0deec1f](https://github.com/yaleh/claudecodeui/commit/0deec1fc1345e26acf73baabc07645b9d200dee7))
* **mcp-gateway:** forward session_create's launch selection to the row writer ([6e0e412](https://github.com/yaleh/claudecodeui/commit/6e0e41234d05e37e5a984e5cc0a4300a1730f62b))
* **mcp-gateway:** hand the run registry to the write tools whole so a correlationId actually lands ([f447d6a](https://github.com/yaleh/claudecodeui/commit/f447d6a51a7854a5076f8e4ced27427fa239197f))
* **mcp-gateway:** import database connection through its barrel ([1bd3afa](https://github.com/yaleh/claudecodeui/commit/1bd3afac09214092cd62a3b7b7e1ee78073a5ccb))
* **mcp-gateway:** keep getProjectIdByPath when assembling read tools ([ec07411](https://github.com/yaleh/claudecodeui/commit/ec07411fcc72ff50fb5d3ed6bf3edaeddb8553dd))
* **mcp-gateway:** read a session by id past the recents page; model small-envelope defects ([2d65c10](https://github.com/yaleh/claudecodeui/commit/2d65c10797f47b8c25d25e5977e6070def6c4904))
* **mcp-gateway:** real overview outputSchema + splice error envelope into every declared shape ([3b87403](https://github.com/yaleh/claudecodeui/commit/3b8740321002291adcbd30f0988b73260b703753))
* **mcp-gateway:** restrict target path layer to absolute references ([4fd31dc](https://github.com/yaleh/claudecodeui/commit/4fd31dcb6a1b8212355c1c3a5494ea910d8be707))
* **mcp:** page changes' sessions by ascending keyset so no row is lost ([b2adb54](https://github.com/yaleh/claudecodeui/commit/b2adb54ee223a95e7be4aa446fffd3bf5b5773c6))
* **oauth-consent-tests:** count denials instead of narrowing them with every() ([19722a8](https://github.com/yaleh/claudecodeui/commit/19722a81ae0acb7eb655f730726f3988da7a6c66))
* **oauth-consent:** scroll the consent page inside itself so Allow/Deny are reachable ([fbee8e7](https://github.com/yaleh/claudecodeui/commit/fbee8e7dd2323e5ba6970f8fb691dc838dbd1ea9))
* **outline:** classify user turns by origin, not transport shape ([87a16a1](https://github.com/yaleh/claudecodeui/commit/87a16a1a171efcf086e6f2f41f3cdaeecd97cfa8))
* **project-workspace:** carry hasQuayConfig through the deep-link project copy ([e5d4fbc](https://github.com/yaleh/claudecodeui/commit/e5d4fbc1a626cac1a99fc069bc45e6a3f111870b))
* **providers:** return the empty token reading with a context window before the transcript exists ([fbeada4](https://github.com/yaleh/claudecodeui/commit/fbeada489d4d7dcf69c644b85179767328c94680))
* **providers:** stamp a cold/idle resident round's turn index at arm time ([d4102bc](https://github.com/yaleh/claudecodeui/commit/d4102bcaa5c75ff7f26063a039f24e68fa64d0a4))
* **providers:** state cancelQueuedInput true, measured by E9 and E10/U4 ([2129c67](https://github.com/yaleh/claudecodeui/commit/2129c678ef009b98f21196d82152311959265eff))
* **quay:** bump server test-count pins for the merged tree ([86a2c07](https://github.com/yaleh/claudecodeui/commit/86a2c07b8feb360bf42d3e81a3a11e0d9c91cc54))
* **quay:** bump stale server test-count pins for the new session-hosts test ([17245b7](https://github.com/yaleh/claudecodeui/commit/17245b7840adea9faf3a2a12dfda016ec2e41f9d))
* **quay:** drive the window selector from the requested window, not the snapshot ([bd7d888](https://github.com/yaleh/claudecodeui/commit/bd7d888e89e5e62b78b2aee35c19f5ea40529944))
* **quay:** keep the overflow count visible when no lane is occupied ([2b55b2a](https://github.com/yaleh/claudecodeui/commit/2b55b2a62d40d322d0d84f53299f4b2b49c45a1c))
* **quay:** re-read only the gantt on a window change, in place ([6803257](https://github.com/yaleh/claudecodeui/commit/680325788597be40bb63ca3408130f3b39f16386))
* **quay:** share one explicit time axis across the tab's three charts ([be3b3c3](https://github.com/yaleh/claudecodeui/commit/be3b3c35f16344d0c78af101152f49b41d6fedce))
* **quay:** truncate the detail-list id span instead of overflowing the Quay tab on narrow screens ([10a8724](https://github.com/yaleh/claudecodeui/commit/10a8724601ca951579681c6663137ed9da495477))
* re-derive the In-flight card from the new window's lanes on a window switch ([6bb2fa7](https://github.com/yaleh/claudecodeui/commit/6bb2fa7bbbb5192479a7fe2a6defff8d6ef07db7))
* **scripts:** annotate voice-realtime-diagnose so the scripts typecheck passes ([f3d6858](https://github.com/yaleh/claudecodeui/commit/f3d6858e239e447f9af2a13c882b68064c84c5c3))
* **scripts:** strip the child console stamp before matching AC-148 stdout ([6cbd62b](https://github.com/yaleh/claudecodeui/commit/6cbd62b5bba78ad11ce7e397ac2508ce8a331206))
* **scripts:** treat only exit 1 from optional-deps-preflight as an env verdict ([7645bf3](https://github.com/yaleh/claudecodeui/commit/7645bf34752e312a1fcd1f46cefc0eb212f28baf))
* **scripts:** type E10 helpers under strict checkJs ([2c4bc49](https://github.com/yaleh/claudecodeui/commit/2c4bc499420cee54deaedb7e796a84b94c69e1cc))
* **scripts:** type the env copy before deleting QUAY_MEMORY_MAX ([79f2673](https://github.com/yaleh/claudecodeui/commit/79f2673d120b0809f549322691703b46202b103a))
* **scripts:** type the voice-realtime-diagnose params so scripts/ typechecks ([f699d8f](https://github.com/yaleh/claudecodeui/commit/f699d8fa40dd64bde1a216dfd1f5c93a9fbdbc9e))
* **scripts:** with-memory-cap resolves bare commands from repo node_modules/.bin ([87fabcd](https://github.com/yaleh/claudecodeui/commit/87fabcd6e7fdfee79cfe33a4dd4d0d31d617bb02))
* **search:** 会话内容搜索同样跳过请求捕获行；判断提到 shared/utils ([2152d5d](https://github.com/yaleh/claudecodeui/commit/2152d5d03fe95354b5a6c74df947ec10617d05f2))
* **session-hosts:** import the mcp-gateway leaf in the close route to keep the providerRegistry eval cycle open ([b744651](https://github.com/yaleh/claudecodeui/commit/b7446510069c75c5fd90c4489d44865350332096))
* **session-hosts:** stop shipping every stored session on each hosts_changed ([ee75a08](https://github.com/yaleh/claudecodeui/commit/ee75a08eeff297ea8a3ce7e6c186bf77b1d0c113))
* **sessions:** record a session's launch selection when the gateway mints the row ([98a4fc6](https://github.com/yaleh/claudecodeui/commit/98a4fc6b119d0c980e7a935692cdddc47bd7103e))
* **sw:** pass a transient fetch failure through instead of fabricating a response ([e51be57](https://github.com/yaleh/claudecodeui/commit/e51be57a73b5e41b8e70bf6d6f7a8445c1f732ad))
* **tests:** repair two develop-side baseline reds blocking fan-in ([3e6198e](https://github.com/yaleh/claudecodeui/commit/3e6198ea761f8e7d2a0dcdfb663b67e3be5b3ba9))
* **voice-realtime:** accept a session_interrupt with no intent instead of refusing the whole stop ([cf1673f](https://github.com/yaleh/claudecodeui/commit/cf1673f6dc4e6339d913b82cec51be6b7464ad64))
* **voice-realtime:** accept numbers written as strings, report a doubled rejection once ([a63e615](https://github.com/yaleh/claudecodeui/commit/a63e61521baca108f583b180b073c3766c98e16f))
* **voice-realtime:** always send the tool-resume response.create, silence only the prompt ([4481c4d](https://github.com/yaleh/claudecodeui/commit/4481c4d81eab49d88667dfa5a87ed0fef0b33fa5))
* **voice-realtime:** an empty transcript must not invent a relayed message ([60159e8](https://github.com/yaleh/claudecodeui/commit/60159e81bb9b6222eff6db8e93d7cbd04ab5fdf5))
* **voice-realtime:** answer a duplicate session_send without a tool-resume ([59c2153](https://github.com/yaleh/claudecodeui/commit/59c215392bfc5f6414fc3a59f2b6c9f56309b5ae))
* **voice-realtime:** arm the segmented wire's watchdog from the browser's own segments ([38c5bc3](https://github.com/yaleh/claudecodeui/commit/38c5bc3b997eaf1eb1b60241115292c711f10faa))
* **voice-realtime:** arm the stall watchdog from the person's own speech, not the endpoint's ([80a586b](https://github.com/yaleh/claudecodeui/commit/80a586bfacc8bfef2e01749c0cc8a15cccfedf53))
* **voice-realtime:** attribute a delivery by its own message, not every unclaimed caption ([14b8e9e](https://github.com/yaleh/claudecodeui/commit/14b8e9edce0dd7f03618eb14b67d0926bd27c8d5))
* **voice-realtime:** attribute a transcript to its own segment by endpoint item id ([dcfea9c](https://github.com/yaleh/claudecodeui/commit/dcfea9c1831acb567bc2f70d3c0281ef545e8b59))
* **voice-realtime:** carry the session audience onto a superseding run ([fdb40fd](https://github.com/yaleh/claudecodeui/commit/fdb40fd7715af44f22a92ef16db1e8c3c2caba3c))
* **voice-realtime:** carry the whole spoken thought on a rewrite, and give the e2e fake its statechange API ([d526a5f](https://github.com/yaleh/claudecodeui/commit/d526a5ff0a704b41d5586cc7fdb5168c73ed6494))
* **voice-realtime:** clear the reconcile lint error and sync the suite pins ([cd4c0f1](https://github.com/yaleh/claudecodeui/commit/cd4c0f1a210c5f88765be81a7f762ba7e4be9c32))
* **voice-realtime:** deliver one spoken thought as one message ([5e5cbd7](https://github.com/yaleh/claudecodeui/commit/5e5cbd71010e435e0cbb37e0575e0ec4d6e72e63))
* **voice-realtime:** deliver queued-row lifecycle to idle subscribers + reconcile fallback ([7c03075](https://github.com/yaleh/claudecodeui/commit/7c03075469b2f5290a1f80fb884004a05efebece))
* **voice-realtime:** drop the stop-word table from the relay prompt ([057fd62](https://github.com/yaleh/claudecodeui/commit/057fd629bc6557f846b7a997fc689b939760e335))
* **voice-realtime:** epoch-scoped commit pairing, per-segment replay budget, ACK grading ([fd2cae2](https://github.com/yaleh/claudecodeui/commit/fd2cae2420abd494f1df839297802442e49e593e))
* **voice-realtime:** fold one spoken thought into ONE transcript row ([ec621a2](https://github.com/yaleh/claudecodeui/commit/ec621a2bd6821fcb4f051efad04fac91544efbb9))
* **voice-realtime:** give a spoken turn the endpoint never answers an explicit, non-error outcome ([af361c6](https://github.com/yaleh/claudecodeui/commit/af361c61e49c35fe642d3c5f633d1f7feed17932))
* **voice-realtime:** grant follow-up credit only when the synthesized create is actually sent ([e333b38](https://github.com/yaleh/claudecodeui/commit/e333b38582f9ca5c89f92f0787e32b5808448b6f))
* **voice-realtime:** hold a truncated function call until its response's outcome is known ([6d379a6](https://github.com/yaleh/claudecodeui/commit/6d379a69fbf8ec4037e4002bb7bada5f86779aea))
* **voice-realtime:** hold the uplink-VAD tail open until the upstream closes the turn ([33a398b](https://github.com/yaleh/claudecodeui/commit/33a398b8656c3f5026e1f9103184fbe95eccd10b))
* **voice-realtime:** judge the continuous empty guard over the relay's span, not its last item ([60dbfcd](https://github.com/yaleh/claudecodeui/commit/60dbfcd556701f3df42a824d8287b18e1d2a78d5))
* **voice-realtime:** keep 620 ms of uplink-VAD tail so the upstream closes the turn ([e6fc095](https://github.com/yaleh/claudecodeui/commit/e6fc0951b98705db4f3c81475fa880d2f2f37df9))
* **voice-realtime:** keep an in-flight caption row below the newest real user row ([85d31a4](https://github.com/yaleh/claudecodeui/commit/85d31a4835f735a09da42a38f240f236eef34688))
* **voice-realtime:** keep reading the transcript until a spoken instruction's run ends ([6bf719a](https://github.com/yaleh/claudecodeui/commit/6bf719a2ae099e4eae10c7fcfe6ea2bc49bcf678))
* **voice-realtime:** keep refused tool results off the browser with a call receipt ledger ([fe621da](https://github.com/yaleh/claudecodeui/commit/fe621dab211b9aa27ab3908b10fb9df77696bf06))
* **voice-realtime:** keep the AC-310 AC1 false form value-equal to the widened session_send payload ([6a3ab2a](https://github.com/yaleh/claudecodeui/commit/6a3ab2aafe3379e43f567350ba3e546371d575e5))
* **voice-realtime:** keep the manual detector switch out of every later session.update ([7a480ff](https://github.com/yaleh/claudecodeui/commit/7a480ffb10674817af420bcb6ede7c3667f13a9c))
* **voice-realtime:** land the settings file's turnDetection on the wire ([0119254](https://github.com/yaleh/claudecodeui/commit/01192548cfd95135372d19d37d69fe843ef8c627))
* **voice-realtime:** let the model's session_send run, and keep listening on a bad call ([29ebb93](https://github.com/yaleh/claudecodeui/commit/29ebb931179ad43ca09cb6ab7ee8af03abf07b39))
* **voice-realtime:** load the shipped params at module load to keep the AC-394 ratchet at 19 ([8311627](https://github.com/yaleh/claudecodeui/commit/83116275f330be232661af3b0cf8ef02fe1e97ab))
* **voice-realtime:** mirror the gateway's new correlationId field so AC-2 stops drifting ([f5580df](https://github.com/yaleh/claudecodeui/commit/f5580dfaa88cd12fc9a0f291ef4108ebb3a012dc))
* **voice-realtime:** no default cap on a connection's total spend ([fb0d7ae](https://github.com/yaleh/claudecodeui/commit/fb0d7ae4647beb18bb63cf2f7b05315769e14b8d))
* **voice-realtime:** one connection per entry into voice mode, ended on leaving ([ac1e7b7](https://github.com/yaleh/claudecodeui/commit/ac1e7b7fe6c0c2b30b49e462fb4253c8099175ff))
* **voice-realtime:** pin the voice origin and re-measure the suite count ([f4f6fe1](https://github.com/yaleh/claudecodeui/commit/f4f6fe1c5ab3e3d85f11245b55647b1a406377ef))
* **voice-realtime:** prewarm the microphone on the Live Voice tap ([b455586](https://github.com/yaleh/claudecodeui/commit/b455586c5f2fbafb7d534ee04f8cfe977de5ffec))
* **voice-realtime:** queue audio frames until the proxy reports open (AC-315) ([269debc](https://github.com/yaleh/claudecodeui/commit/269debc1869c03e1befd81bd49e1c2b27943bcbe))
* **voice-realtime:** recoverable errors go to the console, not the bar ([6518f8b](https://github.com/yaleh/claudecodeui/commit/6518f8b2c85a77ffebeb9680d7911d275c1ce6f6))
* **voice-realtime:** relay everything the user says instead of answering some of it ([fb84ef0](https://github.com/yaleh/claudecodeui/commit/fb84ef0ed0597115ad7bf8dfd1b67ccdc0f594b4))
* **voice-realtime:** remove the browser-sendable interrupt frame ([d03702b](https://github.com/yaleh/claudecodeui/commit/d03702bb961c4e9949a5d1174ee49e95a8e21b0f))
* **voice-realtime:** resync tool mirror to the gateway's pending-interaction fields ([820535a](https://github.com/yaleh/claudecodeui/commit/820535ab0cf669c3b773547d36ceaf472ba2998c))
* **voice-realtime:** ring the entry cue at captureReady, not at socket open ([abc2b5e](https://github.com/yaleh/claudecodeui/commit/abc2b5ed97ecff78eb82532bdc28c8ea97ff4a77))
* **voice-realtime:** send an explicit voice and drop audio before upstream open ([83840d3](https://github.com/yaleh/claudecodeui/commit/83840d33d2ff10eef6e5d0468941b640c35bf745))
* **voice-realtime:** separate the leave control from the stop, and carry the undelivered words into the composer ([fad808b](https://github.com/yaleh/claudecodeui/commit/fad808b0412d0f26f9bdd8a54f67e3211464d3c1))
* **voice-realtime:** show a segment as heard or not-recognized, never as delivering ([8a87620](https://github.com/yaleh/claudecodeui/commit/8a87620be59e44bf13e2a327812128acf2bb2f45))
* **voice-realtime:** show words once when they were relayed verbatim ([819cdd2](https://github.com/yaleh/claudecodeui/commit/819cdd2efc804e72b8779060a62b39103ce80e3e))
* **voice-realtime:** source the realtime endpoint host from the rule module ([b8e13c6](https://github.com/yaleh/claudecodeui/commit/b8e13c6088b40585f38e68f242266baaba5521a5))
* **voice-realtime:** stop losing set-aside sentences, Mute and the queue card across idle/reconnect ([3bca0f2](https://github.com/yaleh/claudecodeui/commit/3bca0f292bef945c8e39df2504730835aae68a83))
* **voice-realtime:** stop the tool-call loop, restore the closing turn, order captions by time ([43504ab](https://github.com/yaleh/claudecodeui/commit/43504ab9f6e5fcace090817d93e8804bc81b73ea))
* **voice-realtime:** stop the turn only through the model's session_interrupt ([bbca290](https://github.com/yaleh/claudecodeui/commit/bbca29014507a43b8f37ece59781cefbacf78d9a))
* **voice-realtime:** take caption words off screen only once the real message is shown ([6ec839c](https://github.com/yaleh/claudecodeui/commit/6ec839cb06253b8857081592e57175138d1c9bd0))
* **voice-realtime:** the uplink-VAD hold-open close commits only, no response.create ([7c5a23e](https://github.com/yaleh/claudecodeui/commit/7c5a23ee3dd94337c7e0f682d566d5277979b93c))
* **voice-realtime:** tolerate the endpoint's own protocol traffic ([4796bea](https://github.com/yaleh/claudecodeui/commit/4796beaaa008b8e0801546f045c85e77f9645900))
* **voice-realtime:** wait out a busy session and log the browser side ([3994635](https://github.com/yaleh/claudecodeui/commit/3994635967e1aea9d6bee32ef63198ea8e3ed188))
* **voice-realtime:** wire the interrupt fence's hostCommandLifecycle seam end to end ([c3cee24](https://github.com/yaleh/claudecodeui/commit/c3cee241ae55753c466a94b24a0039bec581b70a))
* **voice-realtime:** 报告里的总花费只留一个数（同一笔钱不再渲染成 ¥0.0070 与 ¥0.0067） ([6a20fbc](https://github.com/yaleh/claudecodeui/commit/6a20fbc81e5cee8525d9ebcf127b3cec3a663c34))
* **voice-turn-detection:** correct group-stratification note and add language stratification ([5b8b72a](https://github.com/yaleh/claudecodeui/commit/5b8b72a772f001a1bee436f0f01235a3a9f1bc20))
* **voice-turn-detection:** drop the unused argv parameter from emitManifest ([0c37d7d](https://github.com/yaleh/claudecodeui/commit/0c37d7dda47040ffd83ab10a37a256d703689470))
* **voice:** absorbed mid-turn messages get a user row; a call that drops a heard sentence carries it ([ce8a176](https://github.com/yaleh/claudecodeui/commit/ce8a17671a942c3ff09665a7ae778a44a4b505fb))
* **voice:** an interrupt's correction rides the closing turn and is delivered once ([bc6b933](https://github.com/yaleh/claudecodeui/commit/bc6b9335e69cf0f3b254d88a302aa235204d600a))
* **voice:** carry the held-message field in hand-built session stubs, move the count pins ([87918c2](https://github.com/yaleh/claudecodeui/commit/87918c258b6cfaa8318fe468a17f55e418ccc7f1))
* **voice:** count a final transcription as a new utterance in the duplicate guard ([500ba4a](https://github.com/yaleh/claudecodeui/commit/500ba4a457864c2e51757aa75594bc9279f6e9d0))
* **voice:** default the local Kokoro speaker to zf_001 (sid 3) ([01c1cab](https://github.com/yaleh/claudecodeui/commit/01c1cabab7790578953d09f880a0cc6cc1bbe5a4))
* **voice:** drop continuous-mode duplicate session_send with no new user audio ([fb2dca8](https://github.com/yaleh/claudecodeui/commit/fb2dca8c54b26aef640257fbf82349f425888fd2))
* **voice:** log and retry a failed TTS cache warm-up once ([1985ee5](https://github.com/yaleh/claudecodeui/commit/1985ee5c0a30e263d8db7ff14a947e951b446b65))
* **voice:** repoint four stale assertions at the per-user Live Voice credential ([c9b01d8](https://github.com/yaleh/claudecodeui/commit/c9b01d8a2c7daa056fe928ccb3ef594e0951ad74))
* **voice:** restore Live Voice Exit to a pure icon square and localize voice.realtime keys ([7bba8e3](https://github.com/yaleh/claudecodeui/commit/7bba8e3c72bbab7a5976d83c6ab054aab8acbd78))
* **voice:** settle only after the upstream turn closes; a stop consumes the span ([e602e17](https://github.com/yaleh/claudecodeui/commit/e602e17600c163c0f0e5769e4e84630d62e7497a))

### Performance

* **voice-realtime:** cut the per-response context and the responses a relay does not need ([7ad7306](https://github.com/yaleh/claudecodeui/commit/7ad730629bf5cd44ec0a9792d2a01808dc9be9d6))
* **voice:** no closing "OK" turn after a delivered message, and a slimmer session_send ([9b58613](https://github.com/yaleh/claudecodeui/commit/9b5861370b686d0aff55d36eee17092fadfb1570))

### Refactoring

* **providers:** share Claude transcript parsing between history and search ([b0a75ca](https://github.com/yaleh/claudecodeui/commit/b0a75cab937cccccabbd7f3f9a1f2129cc04a910))
* **session-hosts:** canonicalize session->live-host lookup on liveHostForSession ([a4f146f](https://github.com/yaleh/claudecodeui/commit/a4f146fb9ba7f2af7ec75a611cf43bdc9a884c2f))
* share HTTP error envelope helpers across mcp, skills and settings ([a895e15](https://github.com/yaleh/claudecodeui/commit/a895e15a176864fcfa5b41bf42ee1be4287417ff))
* **voice-realtime:** move the streaming uplink-VAD seam into its own file ([1e339d3](https://github.com/yaleh/claudecodeui/commit/1e339d31b6559b755761038bda0189730ee7e752))

### Documentation

* **AC-309:** carry the literal 'quality numbers ... NOT a criterion' in the record (AC9) ([17514b7](https://github.com/yaleh/claudecodeui/commit/17514b7acbbbfc425f3f72e8eb422e060856ef6e))
* add fleet-overview SPEC for cross-project progress visibility ([ea3cfae](https://github.com/yaleh/claudecodeui/commit/ea3cfae1abf36e87988a15045cb0c7e2483f517f))
* correct fleet-overview SPEC data-source claim after P1 implementation ([73ae878](https://github.com/yaleh/claudecodeui/commit/73ae878f41ed75561a938c3c7ef1d52269429b0f))
* emphasize PC/mobile dual-viewport adaptation and verification in fleet-overview SPEC ([609f360](https://github.com/yaleh/claudecodeui/commit/609f3608a2a7cea7461be65bcb75e9f0a39abc78))
* **experiments:** keep the AC9 reading-is-not-a-criterion literal on one line ([c7189b0](https://github.com/yaleh/claudecodeui/commit/c7189b0400348ded205c0fed57468775bc81ab23))
* **experiments:** voice-popup observability — mcp-sourced AskUserQuestion + approvals_list raw reading ([6fcf97b](https://github.com/yaleh/claudecodeui/commit/6fcf97b629bb91f8c03c2e1ee91ffd394caa1501))
* **goals:** add exit-conditions section to GOAL-034 ([291b8ae](https://github.com/yaleh/claudecodeui/commit/291b8ae9cb480bc93541b2c8b17ee44d57aab977))
* id relations and projection invariants review ([3774b54](https://github.com/yaleh/claudecodeui/commit/3774b5484249731991aa29fcc6ceae86ea0f162b))
* land server-side uplink VAD scheme (real prefix-a, user-triggered exit commit+response.create) and mark replay report superseded ([3ed5cdd](https://github.com/yaleh/claudecodeui/commit/3ed5cdd974bd471e3355585d13642543cc184307))
* **mcp-gateway:** correct AC-335 status — driver triage activated it mechanically ([27341d8](https://github.com/yaleh/claudecodeui/commit/27341d804fdbe4d1f40d233bee28a8f0c8e315cf))
* **mcp-gateway:** open CloudCLI MCP control/observability discussion ledger (2026-10) ([5c69e7d](https://github.com/yaleh/claudecodeui/commit/5c69e7d207f6ae670450bf09ef5bad6e477934dd))
* **mcp-gateway:** record AC-333 landing, independent verification and real-service DoD ([b591c53](https://github.com/yaleh/claudecodeui/commit/b591c536d95ac6b62007cf2b62a7a69430201d8b))
* **mcp-gateway:** record changes×Quay-cache analysis, E1-E4 rulings, E4 verification ([e8774c2](https://github.com/yaleh/claudecodeui/commit/e8774c25a1c3d55c957b23e3910b6ab5c1becff2))
* **mcp-gateway:** record GOAL-042 release build 1a08ec0d and restart plan ([2d56744](https://github.com/yaleh/claudecodeui/commit/2d56744d2c3c64c48551c310af8efd31c572f400))
* **mcp-gateway:** record GOAL-042 task ids, dependency chain and release-unit constraint ([2c2ec8b](https://github.com/yaleh/claudecodeui/commit/2c2ec8b1e25736bb2d50f825e4f45f6356e0a934))
* **mcp-gateway:** record path-layer and B1/B2/B4 verification, projectId regression ([5619613](https://github.com/yaleh/claudecodeui/commit/5619613fbade68be81abf588a9db550cb61eede5))
* **mcp-gateway:** record projectId fix verification and live-prod regression window ([1715e42](https://github.com/yaleh/claudecodeui/commit/1715e4283773da7886575e2c93a4d2eeb9292324))
* **mcp-gateway:** record round-2 rulings, audit baseline method, filings index ([f4eb780](https://github.com/yaleh/claudecodeui/commit/f4eb7806eb1a768d53d84fdb0a57969b73e63ac2))
* **mcp-gateway:** record second release build 75a072da ([c631195](https://github.com/yaleh/claudecodeui/commit/c6311958f1d7e423d2dfb467d1176725a9aebca8))
* **mcp-gateway:** round 4 — publish plan, deploy-race root cause, GOAL-040 dispatch ([1a1fb7e](https://github.com/yaleh/claudecodeui/commit/1a1fb7ed4789d6c46f0d6b10fd867f7f45d1380f))
* **proposals:** design the CloudCLI AI Manager as a persistent cross-project agent ([b823f72](https://github.com/yaleh/claudecodeui/commit/b823f726e440f6e06c01354cf3b525ddc9e9f539))
* **spec:** retire the per-utterance withdrawal stage in D-11 and §18.6 (gap-ac351-supersede) ([39fceba](https://github.com/yaleh/claudecodeui/commit/39fceba9b38b2ca8c1c4a502641d71de91fc9c54))
* **vad:** add the boundary columns AC2 names, and report cost as ranges ([9c98590](https://github.com/yaleh/claudecodeui/commit/9c98590ad62dabd66fdc4cc9ce0efe74d4fce98a))
* **vad:** tighten the STS baseline correction and cross-check it against the three-arm probe ([972dcbc](https://github.com/yaleh/claudecodeui/commit/972dcbca2c48562253ba300cc8436b1a0a4f75d5))
* **voice-realtime:** add Silence Tail Suppression to the experience-first decision ([1861692](https://github.com/yaleh/claudecodeui/commit/18616927fd2f7a1c23737e3cc90fc1a43c771786))
* **voice-realtime:** add the Draft-1 decision proposal to the architecture review ([ebf9aa3](https://github.com/yaleh/claudecodeui/commit/ebf9aa32ab14a3b4d0749c30d912b919163deaa4))
* **voice-realtime:** add the persistent-control SPEC ([a2335a9](https://github.com/yaleh/claudecodeui/commit/a2335a901f385b28a1f2c2d19f19a90a31581eb3))
* **voice-realtime:** align the A+ aggregation wording with the E10/U3 reading ([f56ae4d](https://github.com/yaleh/claudecodeui/commit/f56ae4db744153a0fe8b6b0655ed119609653394))
* **voice-realtime:** draft a whole-architecture review of Live Voice ([4b415b6](https://github.com/yaleh/claudecodeui/commit/4b415b679f20f6f8490992b353762f0066bfd150))
* **voice-realtime:** land idle-history disconnect probe artifacts ([72031bf](https://github.com/yaleh/claudecodeui/commit/72031bf8ee3a277a5dad292e6f566f30f1c0a4d5))
* **voice-realtime:** point D-11 rows at AC-350/AC-351 ([dcd8966](https://github.com/yaleh/claudecodeui/commit/dcd8966094ae050b344b26a7068f9207e1cce3c8))
* **voice-realtime:** point the architecture review at the experience-first ordering ([e8194d7](https://github.com/yaleh/claudecodeui/commit/e8194d72fa2974c8e0c83e5f2f83270bc75191f4))
* **voice-realtime:** record reconnect semantics from the double-drop session ([ea9597c](https://github.com/yaleh/claudecodeui/commit/ea9597ce1d4e33a6cf984c9cff5ead852914ec1b))
* **voice-realtime:** record the 64c08ec0 forensics and the continuous baseline decision ([31d1b8b](https://github.com/yaleh/claudecodeui/commit/31d1b8b2c1832ae55cb2949967ef05843a045bcd))
* **voice-realtime:** record the A+ intent-control rulings (SPEC Draft-3) ([0cbe53f](https://github.com/yaleh/claudecodeui/commit/0cbe53fceaf689288a657b83473845b9f2b56a4f))
* **voice-realtime:** record the D-1 and D-2 rulings in the persistent-control SPEC ([ac5c4de](https://github.com/yaleh/claudecodeui/commit/ac5c4de504a905ec40aa9b4f4b75472b67d16ffc))
* **voice-realtime:** record the experience-first decision for Live Voice ([038730f](https://github.com/yaleh/claudecodeui/commit/038730f0d0a935ef58bd8c0a717983ae936a948d))
* **voice-realtime:** record the worker-model and withdraw rulings (D-10, D-11) ([d09c4bc](https://github.com/yaleh/claudecodeui/commit/d09c4bc96c3e61cb8169868edced5f7045bea5d0))
* **voice-realtime:** revise the segmented relay spec after review ([75bd6a8](https://github.com/yaleh/claudecodeui/commit/75bd6a8980d7606a2a7b89f79321adabb80de8bc))
* **voice-realtime:** spec for segmented relay with a fixed text context ([b6f1e73](https://github.com/yaleh/claudecodeui/commit/b6f1e73d59087f415651ac1cc89b3ce2cdea5075))
* **voice-vad:** add new-form uplink replay section (real head-a + exit commit) ([2716bcf](https://github.com/yaleh/claudecodeui/commit/2716bcffc94b930d75f485bd7493e1450e83cad4))
* 常驻会话 Delivery/Turn 语义与执行账本 SPEC（GOAL-045） ([5ccee72](https://github.com/yaleh/claudecodeui/commit/5ccee728b787f15ca4faa0d532d9dc0d1540c291))
* 常驻会话账本 SPEC 的激活策略改为与实际一致 ([68191ac](https://github.com/yaleh/claudecodeui/commit/68191ac15f6bbe06607832fdd7a642325e6173fa))
* 语义中断抽样 F7 —— 单次真实 Realtime 运行读数（AC-346） ([badf5d0](https://github.com/yaleh/claudecodeui/commit/badf5d0fc0b4ef6c6fbc4700e55183afaf422693))

### Maintenance

* add Live Voice relay-drop investigation probes and traces ([7383b50](https://github.com/yaleh/claudecodeui/commit/7383b506c9c1da736e33e9390b48ec526a69d13c))
* **goals:** declare AC-317 gate timeoutMs 115000 ([c3db653](https://github.com/yaleh/claudecodeui/commit/c3db6533242252c602e33ed6f68f3abfa3c00658))
* **goals:** declare timeoutMs 115000 on AC-352/356/357/358/360 ([187eb3e](https://github.com/yaleh/claudecodeui/commit/187eb3e390598e3136837b7cdc331e21237f4586))
* **goals:** 拆分 AC-331 并给两条判据前置部署态 mode ([a202a85](https://github.com/yaleh/claudecodeui/commit/a202a858ea1786208b9ba5d9b731053eeaeab706))
* ignore session-written verification artifacts so they cannot wedge fan-in ([ecff2f9](https://github.com/yaleh/claudecodeui/commit/ecff2f9014ffdb2cfc0bd71dc1a94d62a45261c3))
* **quay:** enable arch_discovery + discovery_method (report-only, committed) ([df6181c](https://github.com/yaleh/claudecodeui/commit/df6181c76250c4dddcd8b994407f709823428085))
* **quay:** enable open_semantic_discovery (report-only trial) ([53a9450](https://github.com/yaleh/claudecodeui/commit/53a945088884790e14c94a5e9008dd1d02bf1d0f))
* **quay:** raise active GOAL cap to 5 ([e0af931](https://github.com/yaleh/claudecodeui/commit/e0af93105f8b051451c56d79f25d9979fbfed954))
* reword goal-047 人工验收门 heading off the 非 AC marker ([35763ca](https://github.com/yaleh/claudecodeui/commit/35763cab073fd2c71939ddae6260ce9524f0e14f))
* **tasks:** carry the task_write AC ticks onto the task branch ([10f28aa](https://github.com/yaleh/claudecodeui/commit/10f28aad552b974da62149cff5c36aaebd410ef1))
* **voice-realtime:** keep the suite counts and the duration baseline honest for one more server test file ([e21bb83](https://github.com/yaleh/claudecodeui/commit/e21bb833cb8036a3a60c08f20295a5c60fb35ace))
* **voice-realtime:** let the diagnose script set how long each turn waits ([78ed6fa](https://github.com/yaleh/claudecodeui/commit/78ed6fab6dc58447653ee23f08c4ea37ba2a867d))
* **voice-turn-detection:** refresh AC8 production-diff evidence after the pre-merge ([bc52880](https://github.com/yaleh/claudecodeui/commit/bc52880b7c9a987ca3d799123613e84cd990782b))

### Tests

* AC-397 composition-root wiring criterion ([6cf077f](https://github.com/yaleh/claudecodeui/commit/6cf077f75eba3bd574410d50e2819a4ce5f5d9e4))
* **auth:** prove the session-lapse policy in a real browser ([7867d96](https://github.com/yaleh/claudecodeui/commit/7867d96288a596383efa1b0659cb9325a1f0609d))
* **auth:** read a real /api SSE endpoint to pin streaming under the no-store policy ([91ebe8b](https://github.com/yaleh/claudecodeui/commit/91ebe8b74c31807dde16506b0b7b42fc96fa7cbc))
* **chat:** pin the activity dock's label to the live phase reading ([b21b4aa](https://github.com/yaleh/claudecodeui/commit/b21b4aa897c3349ee3fa7cd4f46274a43eeb901f))
* **cli:** rebuild the bootstrap fixture after the timestamped console landed ([ab329b7](https://github.com/yaleh/claudecodeui/commit/ab329b74aee9312d2ecaa7cf33de69a53ee880a6))
* **develop-regression:** absorb AC-315's two deterministic reds ([9a293d8](https://github.com/yaleh/claudecodeui/commit/9a293d80dd625f0c6aa6d6c9a4194af0c9872f69))
* **develop-regression:** absorb the two deterministic reds on this branch ([f19d08c](https://github.com/yaleh/claudecodeui/commit/f19d08cfd798fff67b2c72a6a42e3f607f40d82c))
* **e2e:** add the live-voice intent-control browser criterion (AC-345) ([c67db2b](https://github.com/yaleh/claudecodeui/commit/c67db2b6613e7702eefd56b4a6820a3acaac9f49))
* **e2e:** cover the embedded Live Voice bar in the browser ([aa8068d](https://github.com/yaleh/claudecodeui/commit/aa8068d5cf057d372222a7fb1cbdeffdedef9a71))
* **e2e:** double-drop browser acceptance for GOAL-043 / AC-368 ([89305e5](https://github.com/yaleh/claudecodeui/commit/89305e51066e0823ab41345950aee27d0415fbc1))
* **e2e:** fold the shared session timeline from a real browser ([26d39c7](https://github.com/yaleh/claudecodeui/commit/26d39c794f044ca2d583515a10a7f2a57dc0601e))
* **e2e:** give the connected-apps startup guard a replay that fits its deadline ([4048cce](https://github.com/yaleh/claudecodeui/commit/4048cce67c8711bf91d1566e2e82070a0683c224))
* **e2e:** guard the live voice replay against non-loopback egress ([17e46e1](https://github.com/yaleh/claudecodeui/commit/17e46e1ed7e7286b2968127d4336c76d952810cd))
* **e2e:** make the AC-327 stage shots prove the stage they are named for ([3d9da82](https://github.com/yaleh/claudecodeui/commit/3d9da8203c5d900076c97834175156889bdf99d9))
* **e2e:** make the composer-embedded spec speak so the default segmented path commits ([ec6b014](https://github.com/yaleh/claudecodeui/commit/ec6b01459e470f16f6258bec7b430975ed8f24dd))
* **e2e:** make the Live Voice send spec speak so the default segmented path commits ([d70968d](https://github.com/yaleh/claudecodeui/commit/d70968d8296e829f1700389a7b6906e2ff3bcac7))
* **e2e:** pin the interrupt fence's covered half in the scripted scenarios spec ([800ee2d](https://github.com/yaleh/claudecodeui/commit/800ee2dac7b483d9e83b8e6e9b655477d3ffb13d))
* **e2e:** poll the second upload's frame delta instead of asserting it bare ([3e856ef](https://github.com/yaleh/claudecodeui/commit/3e856ef788dd7b3f099271ffa4516edd8a3bda87))
* **e2e:** read the AC-326 gesture continuously, and leave the pictures behind ([739d5e7](https://github.com/yaleh/claudecodeui/commit/739d5e742c2cbae4f820129e560dff170432caef))
* **e2e:** read the resolved relay mode, not the env, in the send criterion ([77454e9](https://github.com/yaleh/claudecodeui/commit/77454e9848419f999c26e648c9dd64842dcc6bd7))
* **e2e:** read the submit's stop state only off a drawn composer ([20c5a07](https://github.com/yaleh/claudecodeui/commit/20c5a07f065f99a3ef92f46d419286f53106b123))
* **e2e:** realign the continuous-experience spec with the AC-355 projection ([e2be184](https://github.com/yaleh/claudecodeui/commit/e2be184323e3a0e97f3cd819486d029a48af2b0a))
* **e2e:** repoint the AC-315 upload criterion onto the Live Voice bar (AC-315) ([8070c21](https://github.com/yaleh/claudecodeui/commit/8070c21257875b83336c88728bde7a687953bcf5))
* **e2e:** shared scripted-upstream Live Voice harness ([8d5f5a5](https://github.com/yaleh/claudecodeui/commit/8d5f5a5879b74936ae4da0f35d1979c4bf2eab49))
* **e2e:** speak two sentences so the segmented relay delivers the 375px leg's turn ([2623445](https://github.com/yaleh/claudecodeui/commit/26234455dd60e9ad68897a60478ebbf9f98a78fb))
* **e2e:** sync the live-voice replay to events, not fixed waits ([299648d](https://github.com/yaleh/claudecodeui/commit/299648d3f625a4bcc27d315a62c15cf8be6dec97))
* **e2e:** variant R waits for the delivered row, not just the wire frame ([68fa570](https://github.com/yaleh/claudecodeui/commit/68fa57035b651a59863f329c0de55769d9320d19))
* **e2e:** walk a per-utterance voice withdrawal in a real browser ([0cd06ea](https://github.com/yaleh/claudecodeui/commit/0cd06ea0695e23e449d9b84631f9d8ab40b6006f))
* **e2e:** warm the client before the first navigation in the AC-315 upload spec ([f482f87](https://github.com/yaleh/claudecodeui/commit/f482f874ef5cbd4687b11532169459b78bbbc63d))
* **gate:** run the Scenario Runner browser arm as a merge-gate lane ([5412315](https://github.com/yaleh/claudecodeui/commit/5412315133cc4d648413cb3f036e24b91c29d7fc))
* **mcp-gateway:** cover the changes tool in the error-envelope probe table ([7318074](https://github.com/yaleh/claudecodeui/commit/731807496eab69adff2ad3347fc24129433b5092))
* **mcp-gateway:** tolerate transient sibling copies in the OAuth literal walk ([3d63fa2](https://github.com/yaleh/claudecodeui/commit/3d63fa2c210249c8d8d964b7293a2163da68be8d))
* **mcp:** pending-interaction visibility + idempotent-answer criteria, resident AC9 leg ([21f4fba](https://github.com/yaleh/claudecodeui/commit/21f4fba1ed8cc71396270e86489b38cb4b13943d))
* **mcp:** pin the v3 changes cursor in the sibling criteria and the suite data ([4d67222](https://github.com/yaleh/claudecodeui/commit/4d672220c609103970bc8bbef8b2e049964fa93f))
* **pins:** bump server dispatch count pins to 318/320 for the new resident test ([ea2cda5](https://github.com/yaleh/claudecodeui/commit/ea2cda5bd5e6d83d453a57ed1c3cdd1aa4982a6e))
* **pins:** bump the server dispatch count pins for the new static assets test ([a2374e6](https://github.com/yaleh/claudecodeui/commit/a2374e6829fd0359e1b46a609d6cbac655731ad0))
* **pins:** carry the server dispatch count pins to the merged union ([37c5c0c](https://github.com/yaleh/claudecodeui/commit/37c5c0cdea04dc5e4e42ebf19870b3ae772709cb))
* **quay-test-script:** re-measure server dispatch pins for the new terminal-state criterion file ([0d7ba26](https://github.com/yaleh/claudecodeui/commit/0d7ba2654066575d59bf19a2f694755fabf1c8f7))
* **quay-test-script:** re-measure the collected server test count 363 → 364 ([3076794](https://github.com/yaleh/claudecodeui/commit/3076794f8d37e5cf1b075ef35ebdc55a82726109))
* **quay-test-script:** re-measure the server unknown-count pins for the new voice-realtime criterion file ([bab81fc](https://github.com/yaleh/claudecodeui/commit/bab81fcc7916e95ff3b2632b2cfcab6fb4b65a99))
* **quay:** bump server test-count pins for the new unforwarded-disposition fixture ([6e16f46](https://github.com/yaleh/claudecodeui/commit/6e16f4664a40aae0ad54e10b768141c9483b52d7))
* **quay:** bump server test-count pins for the voice queue lifecycle fixture ([640e540](https://github.com/yaleh/claudecodeui/commit/640e540bf6cee299340bba3d38b527c878aec823))
* **quay:** bump the collected server-file count pins for the new interrupt test ([fcb07ea](https://github.com/yaleh/claudecodeui/commit/fcb07ea091ee0f63faa7798ff176b1dcdb78c3a8))
* **quay:** bump the server test-count pins and baseline for the new criterion ([d770665](https://github.com/yaleh/claudecodeui/commit/d77066599e0eef3fcc89b8b632dba27006b2fc34))
* **quay:** bump the server test-count pins for the uplink VAD test file ([9c5f498](https://github.com/yaleh/claudecodeui/commit/9c5f498403481e4afe1144cc56bdb83359fd7482))
* **quay:** carry the suite-count pins and duration baseline off the Red-A sibling branch ([a169eb6](https://github.com/yaleh/claudecodeui/commit/a169eb60b07ccbc71f72061b552e9a13d9c2692a))
* **quay:** carry the suite-count pins to 336 and refill the duration baseline ([5ade5c9](https://github.com/yaleh/claudecodeui/commit/5ade5c90f7328268e3299e5d5418265ed1852117))
* **quay:** count this task's new server test file in the dispatch pins ([fa80961](https://github.com/yaleh/claudecodeui/commit/fa80961c71389df2a06d920857a415fc35f89c7d))
* **quay:** count this task's new server test file in the dispatch pins ([ee1a62f](https://github.com/yaleh/claudecodeui/commit/ee1a62fa5f44283c83052c70ae3df232dacba805))
* **quay:** count this task's new server test file in the dispatch pins ([afb6fed](https://github.com/yaleh/claudecodeui/commit/afb6fedecc209e6875da1c1e4d8599e7c811c42f))
* **quay:** keep the deleted module's name out of the re-measure note ([eaba37d](https://github.com/yaleh/claudecodeui/commit/eaba37db90609c61dffdbf0f26664c375c86fe75))
* **quay:** list the new mcp-pending-interaction file in the duration baseline ([cf9c75f](https://github.com/yaleh/claudecodeui/commit/cf9c75f66e13ff97fa6b4564de7aafa38d0a33cc))
* **quay:** move the server-count pins and add the baseline row for this task's new test file ([3a8bba0](https://github.com/yaleh/claudecodeui/commit/3a8bba0dfa4bcc52e4daf41e8eea2751672c30cc))
* **quay:** re-measure the server test-count pins (340 -> 347 collected) ([1d104c9](https://github.com/yaleh/claudecodeui/commit/1d104c9f8cb39d400299f52fa2bb1fc3c8a50349))
* **quay:** re-measure the server test-count pins (347 -> 346 collected) ([1498ad5](https://github.com/yaleh/claudecodeui/commit/1498ad5f72b6c744e6ecfa8bc751be875da1c79d))
* **quay:** re-pin server test-file counts after the develop merge union ([6bd943f](https://github.com/yaleh/claudecodeui/commit/6bd943f58f64d08827078403deff79f358267028))
* **quay:** re-pin server test-file counts after the develop merge union ([e443a9a](https://github.com/yaleh/claudecodeui/commit/e443a9a1e5ba660d3fac2e5c37fd8f8f2945f3a8))
* **quay:** restore server test-count pins and duration baseline for voice-realtime ([e478541](https://github.com/yaleh/claudecodeui/commit/e47854131c52fec0410f1da79591f7e6ed1c9bf7))
* **quay:** resync the server file-count pin and duration baseline ([18ee69a](https://github.com/yaleh/claudecodeui/commit/18ee69ab2e3e6c6c70e72c6e0ae9e65394257a59))
* re-anchor continuous-experience spec to the post-2b7dfc17 projection ([e9c6683](https://github.com/yaleh/claudecodeui/commit/e9c668349c98c4992ed3bf97482147ada16f9fe7))
* re-anchor the continuous-experience spec to the AC-375 delivery watermark ([a43bc1e](https://github.com/yaleh/claudecodeui/commit/a43bc1e9f31109e9931555e6d9eca9aa03efeeef))
* re-measure the collected server-file pin after both criterion files merge (371) ([957161c](https://github.com/yaleh/claudecodeui/commit/957161c58e336005f5b56a7384ed89ca0b27941a))
* re-measure the collected server-file pin after the AC-404 criterion lands ([27f58f7](https://github.com/yaleh/claudecodeui/commit/27f58f7895f7df6bd560002b579b0474ffdd8779))
* re-measure the collected server-file pin to 372 ([11f6087](https://github.com/yaleh/claudecodeui/commit/11f608768a80eeb4d03f895b55455d669f99773d))
* realign continuous-experience spec silent legs to direct assertions ([9964c31](https://github.com/yaleh/claudecodeui/commit/9964c31e9cca0037204c1ced02b897461f3f396d))
* **resident:** AC-379 CLI contract sentinel — real claude + mock endpoint pins §2's four scenarios ([a67133f](https://github.com/yaleh/claudecodeui/commit/a67133f926d49fa5f2f2b49b6b2c96c2e56dee12))
* **resident:** harden the AC-379 CLI contract sentinel against three real flakes ([f5076d5](https://github.com/yaleh/claudecodeui/commit/f5076d568c5b9b8663181414535f0a1628819c31))
* **scripts:** annotate slice-name test helpers for checkJs ([fc0d8cf](https://github.com/yaleh/claudecodeui/commit/fc0d8cf927719bb4036d4131b2e312f6888889de))
* **scripts:** derive the ASR fixture shared/ closure and re-anchor the drifted controls ([d6f2d87](https://github.com/yaleh/claudecodeui/commit/d6f2d87ccaf8f102bbcb516a0b5fa23910fcbd1f))
* **scripts:** drop the retired slice literal from the slice-name test ([8f64a10](https://github.com/yaleh/claudecodeui/commit/8f64a10e68cc8397f811784980052a4d8b95c269))
* **session-hosts:** make the SIGKILL-residue reap reading host-wide-race proof ([3b40b39](https://github.com/yaleh/claudecodeui/commit/3b40b39b1642573a5f3d0f4afeaf3fb1ed9b2ca4))
* **shared:** bump the server-file dispatch pin for the AC-405 TTS criterion ([8cd7c24](https://github.com/yaleh/claudecodeui/commit/8cd7c24e6fe7d7baed6b2f4dc58c8499d800f361))
* **suite:** realign server count pins and Live Voice layout after 6ddb14b9d ([62eefb9](https://github.com/yaleh/claudecodeui/commit/62eefb955bc549a14d2cb45d13b663b9dcff6a25))
* **voice-realtime:** add a scripted fake upstream and the scenarios it makes sayable ([1b44502](https://github.com/yaleh/claudecodeui/commit/1b4450258f61828206a819e3de95fd2ecd49bd5b))
* **voice-realtime:** add a scripted offline endpoint for Live Voice scenarios ([5f36f3d](https://github.com/yaleh/claudecodeui/commit/5f36f3d2abe5b636f945e1cdb5fc781eb28ced99))
* **voice-realtime:** add deterministic segmented-session replay (AC-352) ([b822a04](https://github.com/yaleh/claudecodeui/commit/b822a0415bfc6235bb2fb9c0f65e078d1c14eda9))
* **voice-realtime:** add the continuous-experience e2e harness and its readings ([f316eaf](https://github.com/yaleh/claudecodeui/commit/f316eaf3d408e954a81faa34bb1d8cc6de9d3faf))
* **voice-realtime:** allow the idleMs reading its 1 ms of clock resolution ([7670225](https://github.com/yaleh/claudecodeui/commit/767022540783adb057d0a9c459a45c2b47cc2f01))
* **voice-realtime:** await the first item's receipt before speaking the second ([d3a36ca](https://github.com/yaleh/claudecodeui/commit/d3a36ca07fa468fbea096f1394060192cb0d84f3))
* **voice-realtime:** bump the suite's collected-file count for the interrupt criterion ([baba123](https://github.com/yaleh/claudecodeui/commit/baba123657958ebf3bc7fdb64880aeb69eea518f))
* **voice-realtime:** carry the actual readings in the double-drop known-defect signatures ([eb8ba9e](https://github.com/yaleh/claudecodeui/commit/eb8ba9e00887f0b6b16ba93d760b939d36d07b44))
* **voice-realtime:** continuous B-1..B-9 behaviour acceptance, local and offline ([fd02760](https://github.com/yaleh/claudecodeui/commit/fd0276097da0340b68084b4a2e48dddb34064916))
* **voice-realtime:** cover silence-tail suppression end to end (GOAL-044 / AC-364) ([e3a4e53](https://github.com/yaleh/claudecodeui/commit/e3a4e53342b8390d95766fcfe3f8d3091e2e12d2))
* **voice-realtime:** drive session_interrupt through the real executor/control/runtime chain ([f67ad5b](https://github.com/yaleh/claudecodeui/commit/f67ad5b305f6324d909ddbb318dd1448e0e1c693))
* **voice-realtime:** honour the arming phase and the mic seam in the AC-316 specs ([4760fb4](https://github.com/yaleh/claudecodeui/commit/4760fb4d18f62e1bf57ca31ef488bc55d263a347))
* **voice-realtime:** judge replay defect legs by error signature, not expected-fail annotation (AC-357) ([4d85cfc](https://github.com/yaleh/claudecodeui/commit/4d85cfc2cad59987b1bde72ffec53dd14c26a59a))
* **voice-realtime:** keep the duration-baseline coverage floor and count pins honest for the new span test ([d87945a](https://github.com/yaleh/claudecodeui/commit/d87945aca39eea621ca3da3d158b153895c90d95))
* **voice-realtime:** keep the shared stand-in's turn_detection read single ([e54f7ed](https://github.com/yaleh/claudecodeui/commit/e54f7ed678b5dd8c6d1bb88532df151141d6c9b2))
* **voice-realtime:** merge the node:fs import in the AC-402 source test ([9c0c3bb](https://github.com/yaleh/claudecodeui/commit/9c0c3bbc290360c955c64367c6b211aa19028c02))
* **voice-realtime:** pin the relay mode in the empty-transcript guard ([b06df09](https://github.com/yaleh/claudecodeui/commit/b06df09d9bec32482727a8d3813bf3e44fb469ac))
* **voice-realtime:** pin the voice tool surface at the three advertised tools ([0128d65](https://github.com/yaleh/claudecodeui/commit/0128d65df23cc838849feff928e346561354bd41))
* **voice-realtime:** push the first captured frame before waiting for listening ([bd9ac22](https://github.com/yaleh/claudecodeui/commit/bd9ac22c51ca2104777733c10f5b97d1a2112525))
* **voice-realtime:** re-anchor AC-326 arms on the per-utterance rows ([6f8f89c](https://github.com/yaleh/claudecodeui/commit/6f8f89c498c4ffc5a38d0fe76372581d50904be7))
* **voice-realtime:** real-upstream large-append vs 200ms chunked probe (RC-5 refuted) ([91be3ea](https://github.com/yaleh/claudecodeui/commit/91be3ea2b0a4610f975cea7a2aa92f9c8c9612c3))
* **voice-realtime:** record the drain-refresh DoD readings (AC-344) ([7eb18b9](https://github.com/yaleh/claudecodeui/commit/7eb18b99302fedd086683a3a2d3ffc617832a5a7))
* **voice-realtime:** record the real-upstream segmented confirmation run (AC-319) ([f59c0b2](https://github.com/yaleh/claudecodeui/commit/f59c0b291a3f4189cea9cf8cc68c5d9be36aea34))
* **voice-realtime:** replay the 2026-10-12 double drop as a fault-injected red-first ([5e483a8](https://github.com/yaleh/claudecodeui/commit/5e483a8a59843cc8212015d2903a1055b5bf0cfc))
* **voice-realtime:** repoint the seq-dedup anchor to the parameterized gate ([b622ed0](https://github.com/yaleh/claudecodeui/commit/b622ed0d19e1c338b27e6589d8cd041a5feaf60c))
* **voice-realtime:** staged streaming tests, stall notice, mute-while-connecting fix ([f0a95e2](https://github.com/yaleh/claudecodeui/commit/f0a95e23b1cf34a01ee8bd5dac1c46fe6be3a839))
* **voice-realtime:** variant R reads delivery and the endpoint's own frame log ([9a0977e](https://github.com/yaleh/claudecodeui/commit/9a0977eacd6a377b1e3aaba964832c2e055b375e))
* **voice:** align scripted-scenarios exit-label assertion with the pure icon square ([cfe5fa5](https://github.com/yaleh/claudecodeui/commit/cfe5fa544ebe1c72c6d63768216398ec3121de50))
* **voice:** extend voiceStopVsExit audioSource mock with the prewarm exports ([860f5f3](https://github.com/yaleh/claudecodeui/commit/860f5f33ee3efd4ae745fa9f1121fd99fdae48c5))
* **voice:** pin that the closing-turn prompt actually reaches the upstream session.update ([4beb06e](https://github.com/yaleh/claudecodeui/commit/4beb06e0650d4937d58894996cd9ab90e04a8739))
* **voice:** pin the Live Voice settings tab to its one-field minimal surface ([3c44157](https://github.com/yaleh/claudecodeui/commit/3c441578c10bd84e65934176ea76e981b691da76))
* **voice:** re-anchor AC-326/AC-327 chat-area readings around the delivered row ([79cdedc](https://github.com/yaleh/claudecodeui/commit/79cdedc8fbfba8d3b61844610f40208071998a51))
* **voice:** read arming before the fake mic's first frame ([763ca61](https://github.com/yaleh/claudecodeui/commit/763ca616e6f6eae9d3ad645aac611cb9ef2bf977))
* **voice:** read the permanent warm-failure leg's uncached state from the miss line ([8d03278](https://github.com/yaleh/claudecodeui/commit/8d032788cecc6520931ed0b60932fda93c6304d1))

## [1.39.0](https://github.com/yaleh/claudecodeui/compare/v1.38.2...v1.39.0) (2026-10-07)

### New Features

* **AC-234:** record a run's source from caller.via, add mcp to ChatRunSource ([6588622](https://github.com/yaleh/claudecodeui/commit/6588622c075aba8b073a504862d3bdf9e0715ac0))
* **AC-235:** address runs by runId — runsById summaries, aborted status, injectable retention/clock ([663ece7](https://github.com/yaleh/claudecodeui/commit/663ece7e3d203ed7148e75f19cf5c040d81e99bf))
* **activity-dock:** AC-190 人工关卡 —— 记录小节 + 只读取证脚本 + 护栏判据 ([ce37f20](https://github.com/yaleh/claudecodeui/commit/ce37f2089668c06315dc02ec1eace1c01e8ce5f0))
* **activity-dock:** stop a task and background a foreground tool from the dock (AC-199) ([d544ce2](https://github.com/yaleh/claudecodeui/commit/d544ce22944db120e4314bee5405ff9fe2b8cd7a))
* **chat:** chat.background-task control verb addressing the Turn Tracker (AC-197) ([cbc6e10](https://github.com/yaleh/claudecodeui/commit/cbc6e10d83c4ed563617c37570e8635dd07425ad))
* **chat:** chat.stop-task control verb with event-driven confirmation ([33771d5](https://github.com/yaleh/claudecodeui/commit/33771d5deb47d9db6b28093ff6253a8c2475635d))
* **chat:** collapse control-verb ownership onto one entry, rework cancel-queued ([6c5d766](https://github.com/yaleh/claudecodeui/commit/6c5d7663a4743d3b0d46e6f85702449d84c58cd0))
* **chat:** draw the turn's status in the message flow at every viewport ([7fd3598](https://github.com/yaleh/claudecodeui/commit/7fd3598b2af4eecb65c9736bac49df83b3a43ce3))
* **chat:** execute ui.navigate by this device's policy ([bd2170a](https://github.com/yaleh/claudecodeui/commit/bd2170a88f681860ab51c4c1bafc51089ca94cef))
* **chat:** join a streamed block by blockKey on the client ([9d0ac64](https://github.com/yaleh/claudecodeui/commit/9d0ac64ea504a77703c1fab1c4528fa497926931))
* **chat:** make the activity dock tell the truth when the server is unreachable ([75a06bf](https://github.com/yaleh/claudecodeui/commit/75a06bff6f947febf6603e2873bb165dc137916b))
* **chat:** move the resident process facts from the dock's arrow to a pill in the header ([f27f9a8](https://github.com/yaleh/claudecodeui/commit/f27f9a84de2fe1874a42fc7e1661356c0965908a))
* **chat:** read-only mode for sessions held by a Claude Code background job ([d81cbf4](https://github.com/yaleh/claudecodeui/commit/d81cbf4e2f9401ac70c91ef252b137ad9b15391f))
* **chat:** remove composer resident switch; intent applies only to new sessions ([8b944e6](https://github.com/yaleh/claudecodeui/commit/8b944e68bface2edc26ac368d8752b42b9d2c9a5))
* **chat:** replace the drawn scrollbar and turn rail with an input outline drawer ([bd39344](https://github.com/yaleh/claudecodeui/commit/bd393444cf5ba8d72a2096b5d0e7048fba457333))
* **chat:** session store absolute-index window model ([64bf293](https://github.com/yaleh/claudecodeui/commit/64bf293de58c505fd1b9e7ab2a23cbe16c6ad228))
* **chat:** show this session's background tasks in the transcript ([65bebd9](https://github.com/yaleh/claudecodeui/commit/65bebd995c425c2739aed70b022c5328b28c90af))
* **chat:** title the collapsed work segment with action, count and elapsed ([e18c57e](https://github.com/yaleh/claudecodeui/commit/e18c57e8b64762c6cedc7a4fd3014cb3e37f3371))
* **claude:** give live streaming frames a block-level identity ([03a8e9e](https://github.com/yaleh/claudecodeui/commit/03a8e9e52de262fd00f50365df9dbbdf4195f833))
* **claude:** hand each session its own Claude Code title at launch ([94f74a7](https://github.com/yaleh/claudecodeui/commit/94f74a75cb987b0ee2c65e9b0bb8c43e10fd110b))
* **claude:** refuse an occupied session on the per-run path too ([86aa952](https://github.com/yaleh/claudecodeui/commit/86aa952707117318e73b56a88a58364bb4ca4fbc))
* **debug-agent:** resident control queue — driver hands over the queued uuid ([51760ea](https://github.com/yaleh/claudecodeui/commit/51760ea24216b191bff0c32e3b087e20bb54eab4))
* **device-identity:** announce the browser's identity on every WS connection ([22db8cb](https://github.com/yaleh/claudecodeui/commit/22db8cb7a36d09e2959b1c394526c3785651ea59))
* **mcp-gateway:** AC-252 self-referential write guard ([980fe05](https://github.com/yaleh/claudecodeui/commit/980fe05cfc6dc293b826651f475320e53b14ffd6))
* **mcp-gateway:** add approvals_list / approval_answer tools (AC-274) ([44d3ede](https://github.com/yaleh/claudecodeui/commit/44d3ede1682ab731482e4d032b5ea0a2927212d9))
* **mcp-gateway:** add ui_clients_list read tool ([56cee44](https://github.com/yaleh/claudecodeui/commit/56cee44e310983c98453cbf7a68919dd6afd2a91))
* **mcp-gateway:** audit every tool call to mcp_audit_log with 90-day retention (AC-244) ([10c053c](https://github.com/yaleh/claudecodeui/commit/10c053c070ed1d3a5e41a9ba4f3245c52d645531))
* **mcp-gateway:** declare @modelcontextprotocol/sdk and zod as dependencies (AC-239) ([4a2d0ab](https://github.com/yaleh/claudecodeui/commit/4a2d0ab4ab2e40f7c9eaaa40666c1fec6a582771))
* **mcp-gateway:** declare accurate MCP tool annotations for every tool ([2eb4afa](https://github.com/yaleh/claudecodeui/commit/2eb4afa4d7e65aba4d7d5aa7e71c5f220a813e55))
* **mcp-gateway:** expose GET /api/settings/mcp-audit readback (AC-304) ([0659f40](https://github.com/yaleh/claudecodeui/commit/0659f40efd3eb0091eef0ef04341c64b194f0d90))
* **mcp-gateway:** implement session_cancel_queued (AC-271) ([25bf66c](https://github.com/yaleh/claudecodeui/commit/25bf66c62f79b1d714a8bb8c2e0805bbc8f6210c))
* **mcp-gateway:** implement session_create and session_interrupt (AC-250) ([061da3d](https://github.com/yaleh/claudecodeui/commit/061da3d2cd7782b5cf3bdd8044d2a89741ab375a))
* **mcp-gateway:** implement session_reconfigure (AC-272) ([6f3d6a1](https://github.com/yaleh/claudecodeui/commit/6f3d6a19b813f945734b228ade409d644b573bf3))
* **mcp-gateway:** implement session_start/session_close over resident host service (AC-251) ([7f73cd5](https://github.com/yaleh/claudecodeui/commit/7f73cd53ad40b5a67251b055c63ce471f4d5aa64))
* **mcp-gateway:** make a reference that names nothing an error (AC-287) ([15530fc](https://github.com/yaleh/claudecodeui/commit/15530fc0a970201f634475a110ccaf2adcd7636a))
* **mcp-gateway:** name the missing scopes in an INSUFFICIENT_SCOPE denial (AC-286) ([6eb734c](https://github.com/yaleh/claudecodeui/commit/6eb734c1402c3655a9e21711805eec5d172c99a3))
* **mcp-gateway:** OAuth-aware /mcp auth with discovery challenge (AC-263) ([30f45ad](https://github.com/yaleh/claudecodeui/commit/30f45ad49e161c02e3e6cd11aa74ff7af34cb029))
* **mcp-gateway:** session_send returns a runId at once (AC-249) ([224e864](https://github.com/yaleh/claudecodeui/commit/224e86468cd2130bd374ffc72a2b3017e710cd99))
* **mcp-gateway:** stage-3 read tools over the injected services (AC-245) ([85db940](https://github.com/yaleh/claudecodeui/commit/85db94022cdaf4114f79a355db802b6a14e0d96a))
* **mcp-gateway:** stateless /mcp endpoint gated by MCP_ENABLED, mounted before static (AC-240) ([4df2d93](https://github.com/yaleh/claudecodeui/commit/4df2d93a3cecaea49560c1df323a10147752b423))
* **mcp-smoke:** AC-256 嵌套冒烟取证通道 + --check-record 判据 ([6dd9de0](https://github.com/yaleh/claudecodeui/commit/6dd9de04727e0fbdf49491d5a48f35d617cfd098))
* **mcp:** AC-273 session_background lists and stops held background work ([1e9fcff](https://github.com/yaleh/claudecodeui/commit/1e9fcffebc5f910b227ceb76c395951266d95fdb))
* **mcp:** add ui_open_session — open a session in a chosen browser device ([7f54cf7](https://github.com/yaleh/claudecodeui/commit/7f54cf7b663575866e78c5366e2ba9b1a2c0cc0a))
* **oauth-consent:** re-confirm the password and rate limit it per source ([e9c60b3](https://github.com/yaleh/claudecodeui/commit/e9c60b30036b217db415a6bf9329b464647def45))
* **oauth-consent:** render the authorization screen as an SPA ([8bdfc15](https://github.com/yaleh/claudecodeui/commit/8bdfc1562612d1133f5e1003cddebf8aa254f36a))
* **oauth:** AC-259 authorization-server semantics ([49ba2a6](https://github.com/yaleh/claudecodeui/commit/49ba2a62302fc55de5b6409ae45402f9b9d8ba35))
* **oauth:** add access_tokens table and personal access token service ([ccb96e7](https://github.com/yaleh/claudecodeui/commit/ccb96e748c7f1ae33372b7d64a5989340bcf3a94))
* **oauth:** DCR registration policy and manual client creation (AC-264) ([0157c13](https://github.com/yaleh/claudecodeui/commit/0157c1304558ec38df7069444daf535ca06677b6))
* **oauth:** mount the authorization-server HTTP surface end to end (AC-268) ([714adb5](https://github.com/yaleh/claudecodeui/commit/714adb568f21b8a35482627873e0df55910fbc33))
* **oauth:** move the consent screen to the SPA behind a JSON contract ([cf9d805](https://github.com/yaleh/claudecodeui/commit/cf9d805579329de43f053bbb47017c371de7f38c))
* **oauth:** rate limit consent password submissions per source (AC-261) ([74f3e83](https://github.com/yaleh/claudecodeui/commit/74f3e833df38b4c93e1dd80ba7f454098d3e5e4b))
* **oauth:** settings routes for grants and clients (AC-265) ([ad80150](https://github.com/yaleh/claudecodeui/commit/ad80150729f4badb4a7897a3b89f39527d60976b))
* **oauth:** validate access-token scopes against a single vocabulary ([fb85d0b](https://github.com/yaleh/claudecodeui/commit/fb85d0b6da120efb795a701266ac70b3f03dbbb1))
* **oauth:** 每个 oauth/mcp 请求留下一条无密日志 ([f294161](https://github.com/yaleh/claudecodeui/commit/f294161689d85e6bf80d046bf8a12a2e8c8facea))
* **providers:** add Claude Schedule Tracker (AC-192) ([431b60d](https://github.com/yaleh/claudecodeui/commit/431b60d7c8f2fcc35657f8c64791a2c9cdbcf7a3))
* **providers:** add lease deriver and AC-195 frame-by-frame parity criterion ([78f1b30](https://github.com/yaleh/claudecodeui/commit/78f1b3026420d39230d4b0fb7da2eafdc2900e0b))
* **providers:** add per-session Claude Turn Tracker (AC-186) ([cea23b7](https://github.com/yaleh/claudecodeui/commit/cea23b7d74f5256162ccf539c7d9470d1308570b))
* **providers:** emit a transcript row on a background task's terminal transition ([bf7e44f](https://github.com/yaleh/claudecodeui/commit/bf7e44f772c5e237548d482109b0d4e6a1864314))
* **providers:** incremental session history cache parses only appended tail ([8f7a264](https://github.com/yaleh/claudecodeui/commit/8f7a26428d7f8736fd7c3f98b068423df756e174))
* **providers:** mirror a settled ai-title into the resident peer registry ([ce36452](https://github.com/yaleh/claudecodeui/commit/ce36452dd47a76bc0fad9af1c9d4a27b82b7b858))
* **providers:** read a message window around an id ([b8e0187](https://github.com/yaleh/claudecodeui/commit/b8e0187740c328d84f89552df1dbd5001b172091))
* **providers:** session turn outline endpoint (AC-209) ([f94161c](https://github.com/yaleh/claudecodeui/commit/f94161c58bf11f32d0db07329f7a8dd59454645e))
* **quay:** add Stage goals, Task ledger, Tests and Fan-in panel cards ([05f8afc](https://github.com/yaleh/claudecodeui/commit/05f8afcc293bd6e9963c540237a5ac480d2a3414))
* **quay:** add task/ADR detail lists and wire the dashboard link ([8a501dd](https://github.com/yaleh/claudecodeui/commit/8a501dd14ff018caa6be8128231fbc4c94d70439))
* **quay:** project quay status display (sidebar badge + read-only panel) ([df88baf](https://github.com/yaleh/claudecodeui/commit/df88baff95d989fdb9c656be6404aa3042fbe024))
* **resident:** start a resident session on demand instead of binding it ([3123e56](https://github.com/yaleh/claudecodeui/commit/3123e56390d80cabed9ba427354b2ca0ea478c3e))
* **server:** retire /api/agent and the plaintext api_keys mechanism (AC-226) ([c31eba8](https://github.com/yaleh/claudecodeui/commit/c31eba8a5e8c31fa1822ef864f778708daa2a1fc))
* **session-hosts:** extract resident host start/close into a reusable service ([b2cdbf6](https://github.com/yaleh/claudecodeui/commit/b2cdbf6404a9436e4418fd0d166774e36a4d6962))
* **settings:** /api/settings/access-tokens create/list/revoke routes ([7eb8bfc](https://github.com/yaleh/claudecodeui/commit/7eb8bfc96ad5afe878466858946b436ff1245f1b))
* **settings:** connected apps and OAuth clients sections (AC-266) ([4b7601b](https://github.com/yaleh/claudecodeui/commit/4b7601bf8e15f07734bee0eb97c8277347d622bc))
* **settings:** per-device MCP navigation policy and device name ([a8f8b5e](https://github.com/yaleh/claudecodeui/commit/a8f8b5ecac3321d606ce47c819a566e5524ce01a))
* **transcript:** terminal row only for real background tasks, one line, no segment break ([ce4da55](https://github.com/yaleh/claudecodeui/commit/ce4da55cac16b05a96b072ce45302957f1172fff))
* **voice:** capture pre-VAD raw audio for a passive corpus ([d34758a](https://github.com/yaleh/claudecodeui/commit/d34758a974287eba01669a04b1e8dbaff18bc637))
* **voice:** carry dashscope-omni usage counts into meta.usage and the transcribe log ([2d85084](https://github.com/yaleh/claudecodeui/commit/2d850842f27fa23bc83cc3b57540c2c8c2e349bd))
* **voice:** label what the user changed between the dictation and the send ([def6c58](https://github.com/yaleh/claudecodeui/commit/def6c58e6df22d646fb189e3a598b4612bb378aa))
* **voice:** ship the browser recogniser same-origin from a directory path ([d9a896d](https://github.com/yaleh/claudecodeui/commit/d9a896d7b53c2c8556d9d06782353ac274be448c))
* **voice:** stage-0 readout report and its criterion ([c67b34b](https://github.com/yaleh/claudecodeui/commit/c67b34b4ded8db8cdb8b15764458ee8bd8fa599b))
* **voice:** 客户端本地识别适配器接入同一 ASR 缝（locality 'local-client'） ([ec485c1](https://github.com/yaleh/claudecodeui/commit/ec485c1d9d01fec191c9959884141722fbcb6087))
* **websocket:** activity snapshot protocol with rev, REST + whole-snapshot WS upsert ([6695421](https://github.com/yaleh/claudecodeui/commit/6695421839a3121ea2765d1411ae007a21d044be))
* **websocket:** ChatControlService.send returns runId immediately (AC-230) ([4187dc2](https://github.com/yaleh/claudecodeui/commit/4187dc27e71af1879ed9a8b3ef628df693ab7fe9))
* **websocket:** five chat control verbs share one injectable access entry (AC-232) ([7d92177](https://github.com/yaleh/claudecodeui/commit/7d921771ee78f538a9c61c95caa5f1cb74927f3d))

### Bug Fixes

* **AC-233:** keep the chat.send refusal synchronous across the control-service seam ([5cc59b4](https://github.com/yaleh/claudecodeui/commit/5cc59b4ad46f2b88edaef1dcb755bf00f4d4d955))
* **activity-dock-human-gate:** unpin the guard test from the pre-acceptance state ([71645e0](https://github.com/yaleh/claudecodeui/commit/71645e03eb1350adaf309308ce6774c0751ed687))
* **activity-dock:** drop the dead backTask that red the repo lint stage ([4c0f4fe](https://github.com/yaleh/claudecodeui/commit/4c0f4fe2b2e1060ca7e91e5211cd8720db49802c))
* **activity:** attach the activity feed on activity.subscribe, not chat.subscribe ([dcafe32](https://github.com/yaleh/claudecodeui/commit/dcafe32cc566ae00230a85a9d2f0bbd694551063)), closes [#1](https://github.com/yaleh/claudecodeui/issues/1)
* **activity:** heartbeat carries run-in-flight bit so an idle phase no longer clears a live turn anchor ([b9b177d](https://github.com/yaleh/claudecodeui/commit/b9b177d1611f94a119035ea64f64800a339526a7))
* **chat:** activity dock with no session ignores other sessions' frames ([29298db](https://github.com/yaleh/claudecodeui/commit/29298dbda18ff7d4d947eb4966df522710cf79db))
* **chat:** address every transcript row, and make the active view readable on both layouts ([635d34d](https://github.com/yaleh/claudecodeui/commit/635d34dd74a69d32b2fa6f416aa0e0c6401d2028))
* **chat:** collapse Reasoning trigger-to-body gap with the body ([696ff8f](https://github.com/yaleh/claudecodeui/commit/696ff8fb21ffe17eacad9bc5d71ca16c8f08dff1))
* **chat:** give landscape phones a height tier so the transcript survives ([00a1f52](https://github.com/yaleh/claudecodeui/commit/00a1f526df67cc98555b292d9335472df930c22f))
* **chat:** guard ResizeObserver in the rail's new column and scrollbar ([4dddb4a](https://github.com/yaleh/claudecodeui/commit/4dddb4a37f7db1de7b5b208cb6e389e3e73d5e43))
* **chat:** ignore activity.heartbeat control frame; make merge immune to id-less rows ([6a5ba32](https://github.com/yaleh/claudecodeui/commit/6a5ba32d56b042e933294cc566b6ff1e61859879))
* **chat:** keep the outline handle clear of header and composer, show it on mobile ([357a43d](https://github.com/yaleh/claudecodeui/commit/357a43d184e7cc9d6c8c122dffb50b1255d44a21))
* **chat:** make the replay cursor run-aware so a reconnect can replay a new run ([c61e42b](https://github.com/yaleh/claudecodeui/commit/c61e42bc1669a74d13e0b5c20aa4764eb45a5bdc))
* **chat:** name the debug agent in a message header instead of Claude ([18b6924](https://github.com/yaleh/claudecodeui/commit/18b6924e7e40ef219994f6fbd8a105b1e77a03f2))
* **chat:** narrow the short tier to touch-only devices ([faba31e](https://github.com/yaleh/claudecodeui/commit/faba31e35842df4551060fcc891d293ac27117ea))
* **chat:** rebuild the resident host on edit-send instead of appending into it ([2ea22ce](https://github.com/yaleh/claudecodeui/commit/2ea22cec9914fa759066d0a8abc423d63cb479a0))
* **chat:** retire optimistic user echo when its persisted copy arrives over the socket ([08ceae5](https://github.com/yaleh/claudecodeui/commit/08ceae544652790a70b89484d3225f11fffd99ce))
* **chat:** retire the project draft a first resident send was typed in ([cc658ae](https://github.com/yaleh/claudecodeui/commit/cc658aec5d8edafd0a00906c1cf83658cf6d7a04))
* **chat:** wrap the AskUserQuestion "Other" answer and stop the hint covering it ([96ace60](https://github.com/yaleh/claudecodeui/commit/96ace60b1f345891c8e9e6cb59dc0f487dd1a8ad))
* **claude:** hand over only a title the session actually has ([db76a05](https://github.com/yaleh/claudecodeui/commit/db76a05b9dcd6fa9d22c16c80ae8ad0117b5afdf))
* **claude:** project real cross-session messages past the isMeta gate ([f51943d](https://github.com/yaleh/claudecodeui/commit/f51943ddc1ef4eb6c368ca9b26226102cc909881))
* **css:** stop global rules from overriding the elements they style ([5e0fbca](https://github.com/yaleh/claudecodeui/commit/5e0fbca5089656fe57098ae8c01866abe3671091))
* **debug-agent:** make a per-run scenario turn a run, so the merged activity sources see it ([915e92a](https://github.com/yaleh/claudecodeui/commit/915e92a0fc405d972561a6825edb8da27104ce83))
* **drivers:** cap the full-suite runner's own scope at 24G ([4cf98d8](https://github.com/yaleh/claudecodeui/commit/4cf98d8885913b143fe40bc4e7d6126501901310))
* **drivers:** pin PATH so the launcher starts the plugin it selected ([1f4353b](https://github.com/yaleh/claudecodeui/commit/1f4353b5c2d34ae4def67168865a808aea15a14a))
* **e2e:** stabilize AC-171 criterion under load and mid-run HMR ([5fee2e1](https://github.com/yaleh/claudecodeui/commit/5fee2e1ac414a89f50251a1305b58de4613a9e00))
* **i18n:** give the Quay tab a real label in all 12 locales ([e536fee](https://github.com/yaleh/claudecodeui/commit/e536feebc6bda090a1ea6241f957d04c6e091555))
* **mcp-gateway:** keep the OAuth switch literal out of index.ts prose (AC-263) ([34d1be2](https://github.com/yaleh/claudecodeui/commit/34d1be22a750268c50c20542c30bb438aa15e4bc))
* **mcp-gateway:** name the ui_open_session requester instead of null ([ff0568e](https://github.com/yaleh/claudecodeui/commit/ff0568ec30c79f550ef9956ad0fb3f4445cfdf37))
* **mcp-gateway:** run audit retention sweep after the database is initialized ([ba9eb2c](https://github.com/yaleh/claudecodeui/commit/ba9eb2c5eda7f770e5fb363d588b5fb510d11398))
* **mcp-gateway:** spell the debug-agent gate vars through constants (AC-249) ([1c4a85e](https://github.com/yaleh/claudecodeui/commit/1c4a85e2215d031189c0fae224e34d1f6b24c644))
* **mcp-smoke:** 补 JSDoc 注解让 scripts/tsconfig 的类型检查回绿 ([8997645](https://github.com/yaleh/claudecodeui/commit/8997645f8464ab19d73574fa39271fcc9ff1a7e9))
* **mcp-smoke:** 补齐 JSDoc 类型，scripts typecheck 回绿（AC-256 AC11） ([f04f689](https://github.com/yaleh/claudecodeui/commit/f04f689f9e280ac80e51e6d8a542e7b2dc8f3cab))
* **oauth:** let the consent form's redirect through CSP, refuse unregistered redirect_uri ([3ad2edf](https://github.com/yaleh/claudecodeui/commit/3ad2edf2f858f96c51a3dd02391dae111898358f))
* **oauth:** let the consent redirect chain through, and offer the whole scope vocabulary ([1bf3cd8](https://github.com/yaleh/claudecodeui/commit/1bf3cd8ecbbff50558b6d2f15687a9eec382ab3a))
* **providers:** key the resident turn phase by the app session id ([2d1c7f6](https://github.com/yaleh/claudecodeui/commit/2d1c7f6ec007de01863cad03668e467d6f6a742e))
* **providers:** refuse resident launch when a Claude Code bg job holds the session ([1943cf9](https://github.com/yaleh/claudecodeui/commit/1943cf9c540d24fddeb8149e81ac2bc76b1f9b0f))
* **quay:** give the panel's two responsive grids a base column count ([807b848](https://github.com/yaleh/claudecodeui/commit/807b848d4084a46ff2790539fbf27ca80685c78e))
* **quay:** resolve quay CLI per project root instead of the server PATH ([f4d7422](https://github.com/yaleh/claudecodeui/commit/f4d7422f1d5aae2dfe20528c8992071a2cc3ace2))
* **quay:** stop reading a healthy task store and a failed read as the same thing ([14d0a6b](https://github.com/yaleh/claudecodeui/commit/14d0a6b5990307c97ad694ca819bc0d70ba8268b))
* **resident:** re-read projected peer name after the title mirror moves the registry ([bf7c2f0](https://github.com/yaleh/claudecodeui/commit/bf7c2f0b12086a3fbeb6b4f7fb19d7adaec63f44))
* **scripts:** require ~/.local/bin on the server unit's PATH ([3c76d1c](https://github.com/yaleh/claudecodeui/commit/3c76d1c34950f3f68a52bce117fd9a8f673e3cec))
* **scripts:** run the :3001 server as a fixed systemd user unit, stop copying PATH ([76fdb28](https://github.com/yaleh/claudecodeui/commit/76fdb289af0eec208193211a7829da77bac0b84d))
* **server-test-lane:** hold undici's 18 bad ports for the whole per-file process ([15e021a](https://github.com/yaleh/claudecodeui/commit/15e021a887021238a89d3645260ba2667880df15))
* **sessions:** prune superseded prompt branches anchored on the turn's branch point ([8e0acb6](https://github.com/yaleh/claudecodeui/commit/8e0acb66ca0df931f5678ddd2ac6b06ec7e4dd7e))
* **sidebar:** apply session-name filter to sessions named after their first upsert ([e3a0855](https://github.com/yaleh/claudecodeui/commit/e3a085578b12b6d6460414d7ec09a716e8fa6456))
* **sidebar:** apply the project session filter to live Conversations upserts ([298f1af](https://github.com/yaleh/claudecodeui/commit/298f1af040c37b5d6628d856a6fe72f4aba56e3b))
* **sidebar:** keep Conversations list live on session upserts ([2d43736](https://github.com/yaleh/claudecodeui/commit/2d437364771a960241ffb94d03de3b5b90ede8ef))
* **sw:** leave the OAuth and MCP paths alone; never resolve respondWith with undefined ([b44b778](https://github.com/yaleh/claudecodeui/commit/b44b778733393b892eed9bae0a591b399a4a7572))
* **test:** AC-163 withdrawal client must send the required requestId ([bf19009](https://github.com/yaleh/claudecodeui/commit/bf190098df3fa0d5f9048d9f83655e33a3ea50b4))
* **voice-trim:** resolve the @/ alias in run-savings.mjs for plain node ([518b92b](https://github.com/yaleh/claudecodeui/commit/518b92bbb3df9a6d32570b493ae228562ec59e86))
* **voice:** attribute AC-148's real-db reading by /proc handle ownership, not timing ([686ce3f](https://github.com/yaleh/claudecodeui/commit/686ce3f9580bbe49ceaaf13a0c318966ed6584d9))
* **voice:** load the AudioWorklet from the bundler's build, not the raw .ts source ([a474797](https://github.com/yaleh/claudecodeui/commit/a4747974e9e0d07b8ffe8c6d37204dd95bb991ba))
* **voice:** mint attempt ids per process instance and never overwrite a recording ([55b63cf](https://github.com/yaleh/claudecodeui/commit/55b63cfdd7fb6c87de6640a9b5b711aee7c824f2))
* **voice:** scope the AC9 residue reading by pid in the capture-audio criterion ([e37f951](https://github.com/yaleh/claudecodeui/commit/e37f9512edaf4b8d23fc454b818be7b7d0537009))
* **voice:** the saved recogniser, not the shared backend, decides the route ([eefd3d4](https://github.com/yaleh/claudecodeui/commit/eefd3d40ff3e46cc3f8ece58c9baf248ed9c2bd1))
* **voice:** 客户端 ASR 缝的三处回归（registry-first id、脚本夹具、pause-cues 断言） ([6431d17](https://github.com/yaleh/claudecodeui/commit/6431d17c88f7e262112927534fdb9414abc38c1b))
* **websocket:** unref the activity beat and re-project the hello announcement ([9ffe827](https://github.com/yaleh/claudecodeui/commit/9ffe82766878b9e20250613f2b21c90cb9df9dff))
* **workspace-menu:** mount the dropdown's rows only while it is open ([3fcdbce](https://github.com/yaleh/claudecodeui/commit/3fcdbcec01e1427c583ffc60ad9704c4cd78e8e9))

### Refactoring

* **chat:** move the held-work lease helper to shared utils ([4b1c33a](https://github.com/yaleh/claudecodeui/commit/4b1c33a9bd8ef6456e996f04c9ef4950c119b473))
* **claude:** migrate claude-runtime.provider.js to TypeScript (no behavior change) ([76a2a06](https://github.com/yaleh/claudecodeui/commit/76a2a062cfa9bee3d201f40874ecfc7617e6fad1))

### Documentation

* **AC-172:** record the 2026-10-03 retirement of the status bar lease-count keys ([2c5abe6](https://github.com/yaleh/claudecodeui/commit/2c5abe6edcbbdfd283e334b786c9373977703be0))
* **activity-dock:** record the GOAL-014 human acceptance (AC-190) ([36cb2ec](https://github.com/yaleh/claudecodeui/commit/36cb2ec1ab3523d27395913150692a8ae4c99f91))
* **activity-dock:** record the GOAL-015 human acceptance (AC-201) ([351066f](https://github.com/yaleh/claudecodeui/commit/351066f6621f39d2bf5039f330d3af02fd3e4ffa))
* **activity-dock:** step 4 of the AC-201 gate reads the capability disposition ([6b98be4](https://github.com/yaleh/claudecodeui/commit/6b98be43165074373e49da4847f706adb3f1eb26))
* **chat:** analyse and design observability of Claude background work ([7903a5d](https://github.com/yaleh/claudecodeui/commit/7903a5d812c02c580f03663a5ed6f005a7e6e5e8))
* **chat:** analyse the doubled streamed segment and design block-keyed streaming ([9ed7134](https://github.com/yaleh/claudecodeui/commit/9ed71342e3cfa536e3a9b9b1def7a25a658ce081))
* **chat:** design one truthful activity dock for Claude sessions ([8188e5c](https://github.com/yaleh/claudecodeui/commit/8188e5c356de7d127083a452220f702eaf179e66))
* **chat:** mark the sequence/snapshot protocol design as deferred ([fac1213](https://github.com/yaleh/claudecodeui/commit/fac12131d93421e89e9d1f2f521cb044e8f3a78d))
* **chat:** record rulings and follow-up measurements for the activity dock ([ec73d2a](https://github.com/yaleh/claudecodeui/commit/ec73d2a852f92f4e7c2ef7493b9b5c918e325434))
* **chat:** record the e2e fixture design for the truthful activity dock ([0c4ee14](https://github.com/yaleh/claudecodeui/commit/0c4ee14ad985d544234b68e68f77c31a35b5a6d6))
* **claude:** record the title-guard DoD legs and the host's title behaviour ([fb73601](https://github.com/yaleh/claudecodeui/commit/fb7360178e01bd9de93548323a641816570a9b67))
* **experiments:** voice-draft E-A 引用重建的结果（机械与人读） ([0f6626d](https://github.com/yaleh/claudecodeui/commit/0f6626da07010ae0abc42bcde98c4361ba901dd1))
* **experiments:** voice-draft E-A 引用重建的预注册、抽取规则与运行脚本 ([849505c](https://github.com/yaleh/claudecodeui/commit/849505cbc11edb6662a3732e17a57587a801586e))
* **experiments:** voice-draft E-A2 抽取清洗更正与 TTS 失败处理 ([31ead77](https://github.com/yaleh/claudecodeui/commit/31ead77787ecea5aacd04a13cb5bf703d95179a8))
* **experiments:** voice-draft E-A2 用上一轮输出校正识别错误的预注册与脚本 ([013f9f8](https://github.com/yaleh/claudecodeui/commit/013f9f809dee3f66e99f27deb426b97265008e55))
* **experiments:** voice-draft E-A2 结果，用上一轮输出校正识别错误 ([f6be060](https://github.com/yaleh/claudecodeui/commit/f6be060818f34cf74dd75dcb8b24f44c352daa5c))
* **experiments:** voice-draft E-C 事后敏感性分析的标准答案（仅口述可推出的核心诉求） ([227c816](https://github.com/yaleh/claudecodeui/commit/227c816f517dcd55d79e459cd90b3bcdbd3e8ce2))
* **experiments:** voice-draft E-C 标准答案第二版（含独立标注比对）与口述脚本 ([800b0c9](https://github.com/yaleh/claudecodeui/commit/800b0c9faf19565023d2340443f7ff3076dd3451))
* **experiments:** voice-draft E-C 结果（预注册判定与事后敏感性分析） ([9b40c3c](https://github.com/yaleh/claudecodeui/commit/9b40c3cc0f41632f40ab2a18bc716ae618df07f8))
* **experiments:** voice-draft E-C 追问链的核心诉求标注（作者版，先于独立标注提交） ([230d7f1](https://github.com/yaleh/claudecodeui/commit/230d7f1bb998f6a43dceed72ea9a4d5277bc6728))
* **experiments:** voice-draft E-C 预注册与运行脚本 ([40695ce](https://github.com/yaleh/claudecodeui/commit/40695ceda6f9ad3a4a7e284649d9b7cc90e04bed))
* **experiments:** voice-draft E-C2 带认知类型的草稿——预注册、标准答案与运行脚本 ([01120a8](https://github.com/yaleh/claudecodeui/commit/01120a80344e1849ce752a680c7ebbb859c8cb89))
* **experiments:** voice-draft E-C2 结果（带认知类型的草稿：机械指标与盲评） ([35fe407](https://github.com/yaleh/claudecodeui/commit/35fe4079870ac9025b59c1199e3d891ee2e8bcd9))
* **experiments:** voice-draft E-C3 一次调用抽取加代码渲染——预注册、流水线与运行脚本 ([c57132d](https://github.com/yaleh/claudecodeui/commit/c57132dbea395353ff64a5e42581b6605ebaa048))
* **experiments:** voice-draft E-C3 结果（一次调用抽取加代码渲染：机械指标与盲评） ([7dea3b8](https://github.com/yaleh/claudecodeui/commit/7dea3b85ac96fc2fd397cf46598b242c27abb49e))
* **experiments:** voice-draft E-C4 修省略的回答——预注册、新案例脚本与流水线 v2 ([1868aa2](https://github.com/yaleh/claudecodeui/commit/1868aa2c68a08ce431666b5fde2b539c9c219640))
* **experiments:** voice-draft E-C4 新案例运行脚本 ([643fe36](https://github.com/yaleh/claudecodeui/commit/643fe36dde719eb23b47286e09f5b9ccbf27615a))
* **experiments:** voice-draft E-C4 第一批 hold-out 结果（v2：保留问加答） ([80ecf93](https://github.com/yaleh/claudecodeui/commit/80ecf938d221798c799f9bd613d400cae7363c7e))
* **experiments:** voice-draft E-C4b v3 修法的预注册、第二批新案例与流水线 v3 ([9b6f8d7](https://github.com/yaleh/claudecodeui/commit/9b6f8d7c1b7854298967bb2bd240c104bea1de5a))
* **experiments:** voice-draft E-C4b 分析脚本（v1/v2/v3 三版本渲染） ([c3afa92](https://github.com/yaleh/claudecodeui/commit/c3afa922f933f0088ddf0400e012795c502419f0))
* **experiments:** voice-draft E-C4b 第二批新案例的结果（v3 修好省略的回答） ([a9c2c06](https://github.com/yaleh/claudecodeui/commit/a9c2c064ef732149607b7aa20a3fad882f12298b))
* **experiments:** voice-draft S1 与 S2 结果、人读审计与偏差记录 ([09c06f6](https://github.com/yaleh/claudecodeui/commit/09c06f64b2adfbecaeed80ca450a95f6218bde22))
* **experiments:** voice-draft S1 与 S2 预注册及脚本标准答案 ([1b71096](https://github.com/yaleh/claudecodeui/commit/1b71096686d8924eb93329135de5208ea6831e33))
* **experiments:** voice-draft S1 分析脚本与 S2 识别、草稿运行脚本（提示词在取数前冻结） ([a85348f](https://github.com/yaleh/claudecodeui/commit/a85348f30d4c063eb53a79dfe95daf551e441feb))
* **experiments:** voice-draft S1 运行脚本（提示词在取数前冻结） ([23d0051](https://github.com/yaleh/claudecodeui/commit/23d0051eae59a5f3dcef0e7d8498c0dcaf9c0c9e))
* **experiments:** voice-draft S2 补充 1 与 2 结果，整份草稿重写（纯文本与 JSON）的机械指标与人读审计 ([0c72261](https://github.com/yaleh/claudecodeui/commit/0c72261f87f1c9a0e4d5508fd272eff413c0c564))
* **experiments:** voice-draft S2 补充 1，整份草稿重写的预注册与运行脚本 ([595a807](https://github.com/yaleh/claudecodeui/commit/595a8073074162c3974de35ed35e140ae3d1fd65))
* **experiments:** voice-draft S2 补充 2，整份重写加 JSON 输出的预注册与运行脚本 ([40cd8cf](https://github.com/yaleh/claudecodeui/commit/40cd8cfa1bc716c691a14ef64e6bb401451ed931))
* **experiments:** voice-draft S2 音频生成脚本 ([fd530c9](https://github.com/yaleh/claudecodeui/commit/fd530c9faffb023007ca96646260cd6784770309))
* **experiments:** voice-draft 结果文档补全一处未写完的句子 ([2795336](https://github.com/yaleh/claudecodeui/commit/27953365b32aa958b1e5d4631694c2510978059e))
* **mcp:** 人 yale 写入两条人工验收行 —— AC-257 与 AC-277 ([79003c9](https://github.com/yaleh/claudecodeui/commit/79003c929891f8d647cab5af380cad4b64c556fb))
* **mcp:** 人 yale 写入第三条人工验收行 —— AC-270 ([cea9151](https://github.com/yaleh/claudecodeui/commit/cea915137f851c8e1efed5304a07eeb5cebeef10))
* **ops:** correct the restart-kills-sessions claim to match SIGTERM shutdown ([0560bc1](https://github.com/yaleh/claudecodeui/commit/0560bc14eb1edae440d17cfe16cccc355dc3a687))
* proposal 的活动状态与 Stop 规则改为桌面与移动一致 ([0cafe92](https://github.com/yaleh/claudecodeui/commit/0cafe921579e235e62b6786cf198811f4bebe2de))
* **proposals:** mcp-gateway SPEC v3.1 — CloudCLI MCP over the session control plane ([92fdd25](https://github.com/yaleh/claudecodeui/commit/92fdd25da8887543fbdd75dbb9029459570f07e2))
* **proposals:** mcp-gateway SPEC v3.2 — map phases to GOAL-018..022, backfill two deviations ([49bb81b](https://github.com/yaleh/claudecodeui/commit/49bb81b4bb6f4d76a696e98b264f49c469267c26))
* **readme:** describe the fork's changes since v1.37.3, drop upstream promotion ([fc4aec8](https://github.com/yaleh/claudecodeui/commit/fc4aec81196bce98f17588b0dc981b5382491d97))
* **resident:** §12 随出路 (a) 改写——地址是读来的，不是自赋的 ([f3a9661](https://github.com/yaleh/claudecodeui/commit/f3a96618cd653da11ac4fc829d71106848576e12))
* **ui:** ui_visible_context 扩展范围规划 —— 四个维度的现状与落地范围 ([f557c4b](https://github.com/yaleh/claudecodeui/commit/f557c4b4ec58c4e18b5efb40c413caea86a390e4))
* **voice:** correction feedback-loop proposal + post-ASR disambiguation pilot ([d9ed637](https://github.com/yaleh/claudecodeui/commit/d9ed63727a7094f48fcfbff9f8b20de8bc8a7028))
* **voice:** drop the post-deploy verification scaffold ([cf0a6ba](https://github.com/yaleh/claudecodeui/commit/cf0a6ba0b9205b85b1b2e9c836b1b8b27534e4f3))
* **voice:** freeze the replay-stream extraction and the TTS+ASR runner before data ([7337f74](https://github.com/yaleh/claudecodeui/commit/7337f7497968001d83b773c9fb4f291c7f4145c8))
* **voice:** itn and language settings cannot improve segmentation (v8) ([2c7b336](https://github.com/yaleh/claudecodeui/commit/2c7b3366eb4cfad7f5843d51522f0082d2152cfa))
* **voice:** pre-register round 4 - harmful errors, close-set selection, long-message sources ([0df09b4](https://github.com/yaleh/claudecodeui/commit/0df09b41d99ffd822091dfe10741a5d372515aa7))
* **voice:** pre-register round 5 - local SenseVoice, confidence, CTC candidate scoring, versus Omni ([1bf5cf1](https://github.com/yaleh/claudecodeui/commit/1bf5cf1c61c308c45c671662ce9d0af2604f3221))
* **voice:** pre-register round 6 with the patched sherpa engine and its patch ([dcbe43f](https://github.com/yaleh/claudecodeui/commit/dcbe43f1aa8890f16e8b69c5e87d8967005045fc))
* **voice:** pre-register the replay of real session input before any data ([336fed4](https://github.com/yaleh/claudecodeui/commit/336fed4f76c04700fd48d9385c655bbe6264bd6d))
* **voice:** preregister the punctuation post-processing experiment (v7) ([fb38273](https://github.com/yaleh/claudecodeui/commit/fb3827387f38406a6a413f14166d25bf064f625a))
* **voice:** preregister the SenseVoice itn/language punctuation experiment (v8) ([ba0aa8a](https://github.com/yaleh/claudecodeui/commit/ba0aa8a50aacfad04c8f32384bec98b514b52992))
* **voice:** proposal for VAD segmentation of long and continuous voice input ([72dfc52](https://github.com/yaleh/claudecodeui/commit/72dfc52a418af58359964f4f7644ecddec91071e))
* **voice:** punctuation model does not beat SenseVoice's own punctuation (v7) ([7fe3a6a](https://github.com/yaleh/claudecodeui/commit/7fe3a6ac1d9e75325b97313857d04805a73d3373))
* **voice:** record the audio, local browser and phone engine, and rewrite-button decisions ([0d080a8](https://github.com/yaleh/claudecodeui/commit/0d080a826371a98168d6f49a0368faafc149bb27))
* **voice:** replay of real session input - flag, find, maintain, converge ([6b8ebff](https://github.com/yaleh/claudecodeui/commit/6b8ebfff8fee2d39286f5dfe21896024b528f086))
* **voice:** round 4 results - harmful errors, closed-set selection, long-message sources ([b1347bf](https://github.com/yaleh/claudecodeui/commit/b1347bf575b1b33b42fa286298d3d3a95339462b))
* **voice:** round 5 results - local SenseVoice versus Omni ([7ece83a](https://github.com/yaleh/claudecodeui/commit/7ece83acbbe14183e9deff2ebb155167fa1a80bf))
* **voice:** round 6 results - patched sherpa engine, provenance, scale rule, aliases ([945ed5a](https://github.com/yaleh/claudecodeui/commit/945ed5a58b3e88f6dcbd3c2380c517928a203998))
* **voice:** shrink VAD sweep sample sizes and cap recognition spend at 2 CNY ([8525516](https://github.com/yaleh/claudecodeui/commit/852551602f2c16c0bb028562919dcf262f46a995))
* **voice:** state the real-db handle match as the whole <db>-* sidecar family ([b922a26](https://github.com/yaleh/claudecodeui/commit/b922a26c72ab357c1f618302c8b251d8927906f4))
* **voice:** write round-4 conclusions into the proposal (section 5.8) ([34c8aae](https://github.com/yaleh/claudecodeui/commit/34c8aaef55d7609c9c9399e5ed7ab745806f3176))
* **voice:** write rounds 5-6 into the proposal - local engine, confidence, aliases, rewrite split ([55749e3](https://github.com/yaleh/claudecodeui/commit/55749e3b90a9c0f10948d2f1af1811c7bf44ab41))
* **voice:** write the replay results and the tolerable-error principle back into the proposal ([c826174](https://github.com/yaleh/claudecodeui/commit/c8261748be8fe1fd9e622b3c8f00606203527342))
* **voice:** 客户端 ASR 探针补真机读数；探针页加下载进度与批量上传 ([a71430b](https://github.com/yaleh/claudecodeui/commit/a71430b569cab77fdd92807e4ec696166e320c89))
* **voice:** 纠错反馈回路提案修订 —— 三档标记、点词弹层与借用边界 ([5e14496](https://github.com/yaleh/claudecodeui/commit/5e14496f0459f2ba987cc7a41128aa6ba33fb03c))
* 最终报告 + 三个滚存台账（L1 81/81、L2 11/11 收尾） ([ccb871b](https://github.com/yaleh/claudecodeui/commit/ccb871b5320514b49582c12ac8a7ed554af4305d))

### Styling

* **oauth:** order the shared consent-path import after the @/ group ([a9c3b91](https://github.com/yaleh/claudecodeui/commit/a9c3b917515ec878f70d923c0d14669f5a389949))

### Maintenance

* **claude:** make the criterion's types and import grouping clean ([2dc67d1](https://github.com/yaleh/claudecodeui/commit/2dc67d1ab343f2a648277fbc1815e45b2efdb064))
* **quay:** declare loop.suite_runner=quay-buckets so fan-in runs the lane-aware runner ([ee1b18d](https://github.com/yaleh/claudecodeui/commit/ee1b18d5de063e0662a9864ff1de4b2bf467bdff))
* **quay:** drop pinned 0.14.0 native provider path/mcp_entry after init reconcile ([e42cb7e](https://github.com/yaleh/claudecodeui/commit/e42cb7e4bf957d6cd3a4344b0b8c55e70358e1b1))
* **quay:** rebind native provider path/mcp_entry from plugin 0.10.0 to 0.14.0 ([7425fba](https://github.com/yaleh/claudecodeui/commit/7425fba44b4fecd4199937dd96d5fb26387ffd51))
* **tasks:** gap-ac175-criterion-red-is-uncommitted-composer-wip record AC state and completion record ([6007c05](https://github.com/yaleh/claudecodeui/commit/6007c059c88f3e8d7c44e8f4dbe1cc38ddaf7e20))
* **tasks:** gap-ac242-mcp-loopback-guard-before-auth record AC ticks ([99493fb](https://github.com/yaleh/claudecodeui/commit/99493fb470bf8f6b318a4bf992a1cdb2dfd306e3))
* **tasks:** gap-ac277-mcp-resident-human-gate 记录 AC1-5/7 与 ## Evidence（transport ABI tick） ([c3968b1](https://github.com/yaleh/claudecodeui/commit/c3968b117625cac28a2fc8dcb996e9ef333ed681))
* **tasks:** gap-chat-control-ownership-cancel-queued ABI tick (7/7) + evidence ([f6b497c](https://github.com/yaleh/claudecodeui/commit/f6b497c8667593cb6682fc6689e3c02356ab0f93))
* **tasks:** record peer-row exemption falsification readings ([94835d8](https://github.com/yaleh/claudecodeui/commit/94835d8d67cf9aa1cfeebf307896cbfeaf4675c7))
* **tasks:** transcript-long-session-e2e-seed AC ticks (transported ABI bytes) ([80e9ad8](https://github.com/yaleh/claudecodeui/commit/80e9ad82b3420e14e60780eb8a8500d75021280e))
* **voice-vad:** fill qwen3.8-omni-flash prices so the recognition budget guard can run ([aaca7a8](https://github.com/yaleh/claudecodeui/commit/aaca7a8a3909c7a0a63f3394c96ecb6187af39a1))
* **voice:** drop the committed python bytecode from the SenseVoice scripts ([61510b6](https://github.com/yaleh/claudecodeui/commit/61510b6150f687933077d30caf66ca44fc1c51e3))

### CI/CD

* **release:** publish to npm via trusted publishing (OIDC) instead of NPM_TOKEN ([c2fa2a6](https://github.com/yaleh/claudecodeui/commit/c2fa2a6b1b418e1fd431a68fa2dc01e513039f95))
* **release:** upgrade npm after npm ci so the lockfile's mirror URLs still install ([ed5c067](https://github.com/yaleh/claudecodeui/commit/ed5c067a19da4f0ec9c8df1f897e252b0be0fe17))

### Tests

* **AC-166:** give the resident (re)spawn wait measured lane-load headroom ([ddecc9d](https://github.com/yaleh/claudecodeui/commit/ddecc9df0ab0f92f19a6845eb3b70f844365e346))
* **ac286:** assert the stop payload's stopped/taskId fields in leg (d) ([d09a0fe](https://github.com/yaleh/claudecodeui/commit/d09a0fef1266d4b2a8b6cdadc17224ff1b24e14e))
* **ac287:** migrate AC-284's criterion's two exempt class probes ([a3a501e](https://github.com/yaleh/claudecodeui/commit/a3a501e6a7c002fbb9c4af4e0878cf453b1ad4f1))
* **ac287:** migrate AC-289's criterion and sync the count pin ([4be5076](https://github.com/yaleh/claudecodeui/commit/4be507671d32a5bfe1b5454be1c35b41ecc33b28))
* **chat:** assert DOM-node identity as booleans so a mutation fails instead of hanging ([ddfaca6](https://github.com/yaleh/claudecodeui/commit/ddfaca61ecc6eb8ccf458387d6c7d559fd098798))
* **chat:** assert the survivor identity in the straddled-tool-row shape ([460cb04](https://github.com/yaleh/claudecodeui/commit/460cb046db1b3e40afc892df23edc8925eb1d4e2))
* **chat:** cover the outline handle's pixel clamp ([c78526e](https://github.com/yaleh/claudecodeui/commit/c78526ea2d49ed794973457a410d0cb3ea867599))
* **chat:** model unmeasured rows with their real 100px placeholder height ([e2042ac](https://github.com/yaleh/claudecodeui/commit/e2042acc55ce5ec4dac70a59edb6cf4f592d4661))
* **chat:** pin the block-keyed join, its gaps, and the row key ([a06a1f4](https://github.com/yaleh/claudecodeui/commit/a06a1f4940d765fd9f55005837f8de60928329af))
* **chat:** place the turn-rail i18n completeness test in its owning module ([826ee6e](https://github.com/yaleh/claudecodeui/commit/826ee6eb0a1b67907b3e6fd0a0d0bbf2bf5305e1))
* **chat:** split the reasoning-spacing cases so they redden independently ([d15a7cf](https://github.com/yaleh/claudecodeui/commit/d15a7cfefc55d6840722b62deee53724f7f906b8))
* **claude-cli-path:** isolate CLAUDE_CLI_PATH for the default-path cases ([44d8a3c](https://github.com/yaleh/claudecodeui/commit/44d8a3c776c62e8b0cf7e1fa796ae58c56515c1c))
* **claude:** assert the freeze where it is, not where the design assumed it ([853ff24](https://github.com/yaleh/claudecodeui/commit/853ff24b89acf3b0aabc39603ef8d664d2c53923))
* **claude:** measure where the name freeze actually lives ([6cd3a23](https://github.com/yaleh/claudecodeui/commit/6cd3a235010689787200a911eeaef571d4436abe))
* **claude:** read the control's registry while the launch is still held ([3121b5b](https://github.com/yaleh/claudecodeui/commit/3121b5b0f82d8e983b2b99b053bd31bdec90b0df))
* **debug-agent:** derive the delivery-leg window from the observer's own measured latency ([25138f4](https://github.com/yaleh/claudecodeui/commit/25138f4ef82a7e685d07eebb21a13edafa453b59))
* **debug-agent:** read the withdrawn-no-round claim before the queue-emptiness claim ([b12202b](https://github.com/yaleh/claudecodeui/commit/b12202bbdd350d64172048bf0bb78b91b5ac8d0b))
* **debug-agent:** teach the vocabulary guard the dialect's peer origin kind ([c470fde](https://github.com/yaleh/claudecodeui/commit/c470fde0d5d6ad79631d5ecf3722b163d2f47497))
* **e2e:** assert the collapsed work-segment title in a real browser ([c0d6894](https://github.com/yaleh/claudecodeui/commit/c0d6894e286bd9543e87d9d3b15c6853a45db04f))
* **e2e:** bound the mcp-settings startup path with warm-up + replay guard ([1e995cd](https://github.com/yaleh/claudecodeui/commit/1e995cd15e6a47c040bd96b9388fe0969bb0ef0d)), closes [#username](https://github.com/yaleh/claudecodeui/issues/username)
* **e2e:** bound the resident-status-bar startup path ([b57428a](https://github.com/yaleh/claudecodeui/commit/b57428a13c8f5ad38ac48c5f921ad3d3823e2a01))
* **e2e:** composer draws no resident switch; AC2 silent-conversion regression leg ([876147f](https://github.com/yaleh/claudecodeui/commit/876147f43271a772ee08be78cff8c221d0059f98))
* **e2e:** drive ui.navigate end to end in a real browser ([309e257](https://github.com/yaleh/claudecodeui/commit/309e257ed8a03fd125d1c404796fcfd3c9a34040))
* **e2e:** make the turn-jump criterion discriminate id from timestamp, and detach ([37ae049](https://github.com/yaleh/claudecodeui/commit/37ae0492f034a5b13484b21bf95190ce90280922))
* **e2e:** pin MCP_ENABLED/PUBLIC_BASE_URL explicitly in mcp-settings criterion ([d560d72](https://github.com/yaleh/claudecodeui/commit/d560d7248af97540fe6eef1b2461008f5cc348b7))
* **e2e:** print the strip's row contents and the scenario row delta ([bc21e13](https://github.com/yaleh/claudecodeui/commit/bc21e13bdd2b182047062b11a0d1a862578739b2))
* **e2e:** real-browser DoD reading for the task-terminal-row criterion ([803ea8f](https://github.com/yaleh/claudecodeui/commit/803ea8fcc48ecbc1a970d409365f52246c4d81ff))
* **e2e:** share one budget across the first landing's two probes ([84ef903](https://github.com/yaleh/claudecodeui/commit/84ef903986b02c90668d3ed04fa61a231abdb230)), closes [#username](https://github.com/yaleh/claudecodeui/issues/username)
* **mcp-gateway:** make the mount-order leg measurable via GET/DELETE /mcp ([615cbf3](https://github.com/yaleh/claudecodeui/commit/615cbf32786bd4dcde4e489a88ab294806410c9e))
* **mcp-gateway:** sharpen AC-272 criterion readings ([59d6e47](https://github.com/yaleh/claudecodeui/commit/59d6e4774d1accd225eadd5e72549193bc3587b7))
* **mcp-gateway:** type the AC-287 fakes so typecheck passes ([39880d9](https://github.com/yaleh/claudecodeui/commit/39880d9922278affd2a9c73d090159d3b1d56d7f))
* **mcp:** cover ui_open_session in the AC-303 write-notification plan ([8253025](https://github.com/yaleh/claudecodeui/commit/8253025cc0365125ad96b06cc4a12bcb03d2da13))
* **names:** 修 claude-session-name-authority 的 typecheck 红（挡住落地的那条） ([7362011](https://github.com/yaleh/claudecodeui/commit/7362011c239ee81408cca309ae6be8474306c19a))
* **oauth-consent:** add the DoD visual-review legs to the consent criterion ([d791d09](https://github.com/yaleh/claudecodeui/commit/d791d09005b8037edeb8c2a0bd11a6be22a1179c))
* **oauth:** AC-226 criterion — read /api/agent + plaintext key retirement from the syntax tree ([3db8b21](https://github.com/yaleh/claudecodeui/commit/3db8b2160eeea3e5c07a327f7fee099d924e5a4e))
* **oauth:** red-first criterion for /api/settings/access-tokens routes ([5924ea0](https://github.com/yaleh/claudecodeui/commit/5924ea03279d8be459883cbbc860d41adfc7bdc1))
* **providers:** record AC-210 mutation-probe evidence in the criterion header ([368d3be](https://github.com/yaleh/claudecodeui/commit/368d3beadadd964240f05dae0fce94e6bfadc52f))
* **providers:** record the measured limit of the not-early criterion ([bb52e12](https://github.com/yaleh/claudecodeui/commit/bb52e12a00c8a5c9defaee2d4c3b4d88f97b956f))
* **providers:** strip the registry's runId in the unattended-turn frame projection ([bed8c58](https://github.com/yaleh/claudecodeui/commit/bed8c5897ea38dad860b798fb8836db723d51d0a))
* **quay:** pin the unpaged task-list read that the ledger counts aggregate ([af0f1ea](https://github.com/yaleh/claudecodeui/commit/af0f1eadaaadf3f91ced9fbacd42ab09f2cb275c))
* **resident-status-bar:** align test 3 key table with shipped badge keys ([276a9c8](https://github.com/yaleh/claudecodeui/commit/276a9c83d6b1f872a8bcc37986260e30fc14eb92))
* **resident-status-bar:** route both deliberate reloads through the bounded replay ([e4703a6](https://github.com/yaleh/claudecodeui/commit/e4703a6c69eaf873ce7b07e41e254d75f37c702f))
* **resident:** criteria for the on-demand start route and the refusal UI ([41b12fb](https://github.com/yaleh/claudecodeui/commit/41b12fb82fe1bc4742c81e691d1be19d15bdb576))
* **resident:** 占位名是过渡态、且永不当地址的判据 ([c2838b5](https://github.com/yaleh/claudecodeui/commit/c2838b54bf702a79f3cb587043f0bdfd8ba2795a))
* **resident:** 地址永不是 App 侧给会话的名字 ([d49a682](https://github.com/yaleh/claudecodeui/commit/d49a682b9c544d8012b1b6555556c47e6da2b1fe))
* **session-hosts:** budget covers the three boots it shelters (AC-166) ([fa07717](https://github.com/yaleh/claudecodeui/commit/fa07717e29729a2fe39cfbcf4fbf98ff7edd113d))
* **session-hosts:** pin the measured stopTask capability in the residentFeatures guard ([3a28c2b](https://github.com/yaleh/claudecodeui/commit/3a28c2b0f71405fcb97004b51f8c6cbd7670e1f4))
* **session-hosts:** re-project the hello's turn-phase fields in per-run parity ([fec466d](https://github.com/yaleh/claudecodeui/commit/fec466d50d5e370ab38052b95df58f2f97a1651b))
* **session-hosts:** widen claude residentFeatures guard to the ninth field (stopTask) ([12df4f4](https://github.com/yaleh/claudecodeui/commit/12df4f40e91f6cb7cb9e6cb15a90e9c70f5868d2))
* **settings:** AC-255 MCP block + token-scope i18n completeness criterion ([b470200](https://github.com/yaleh/claudecodeui/commit/b4702005821d15901f15d73be5ef55bfe3f046c4))
* **settings:** guard connectedApps/oauthClients i18n completeness across locales (AC-267) ([cef5aee](https://github.com/yaleh/claudecodeui/commit/cef5aee43ce540d67cf21446d49c831a6d24fe67))
* **suite:** 服务器测试文件数 232→233，修精确计数钉 ([2df26ad](https://github.com/yaleh/claudecodeui/commit/2df26ada1520e870a10ae1a5191bb6f0495ecfcf))
* **suite:** 服务端测试文件精确计数钉 230/232→233/235（本任务新增 3 个服务端测试文件） ([e9f0122](https://github.com/yaleh/claudecodeui/commit/e9f0122d531fa7ef6c150023e926b24a13f24bf0))
* **voice:** AC-152 residue guard excludes concurrent harness writers, keyed on size ([92664f8](https://github.com/yaleh/claudecodeui/commit/92664f8e20883a3df95a2ea0952847749e3e9901))
* **voice:** align raw falsify temp-copy prefix with the shared __criterion-falsify- convention ([20d925d](https://github.com/yaleh/claudecodeui/commit/20d925dfc05e685d8069f66dd07d6d02fa12c647))
* **voice:** complete the wholesale voiceDebug mocks for isVoiceVadEnabled ([678cb92](https://github.com/yaleh/claudecodeui/commit/678cb92f7fd8310e6a544e19cd8b3e1ffd37e903))
* **voice:** judge the shipped worklet by the artifact, with the defect as a false form ([6ee2845](https://github.com/yaleh/claudecodeui/commit/6ee2845a259b68ed2e78f4fa039bd3b9559d0f4d))
* **voice:** the error vocabulary is 14 members once ENGINE_UNAVAILABLE exists ([a89e19a](https://github.com/yaleh/claudecodeui/commit/a89e19a46ccdcf06ed2d4987857eac34cd6812fe))

## [1.38.2](https://github.com/yaleh/claudecodeui/compare/v1.38.1...v1.38.2) (2026-09-30)

### Bug Fixes

* **desktop:** point the local-server bundle default at the fork ([035e0bb](https://github.com/yaleh/claudecodeui/commit/035e0bb89c242535b3e47d0c7272e3cd63426931))
* point README and CLI help links at the fork ([cf19214](https://github.com/yaleh/claudecodeui/commit/cf192141116a23383db5df583642d1a992ca328c))

### Documentation

* **resident:** 写明 App 侧占位名是过渡显示值，永远不是 SendMessage 地址 ([447bc60](https://github.com/yaleh/claudecodeui/commit/447bc60027abdd5736848ad6daa4ab029fd7452a))
* **resident:** 常驻地址不再由 App 自造，改为读 Claude Code 的进程派生名 ([a6e0719](https://github.com/yaleh/claudecodeui/commit/a6e0719248bd6488c918a4951eb66b001b362749))

## [1.38.1](https://github.com/yaleh/claudecodeui/compare/v1.38.0...v1.38.1) (2026-09-30)

### New Features

* **release:** publish the fork as @yalehwang/cloudcli on npm ([e433af3](https://github.com/yaleh/claudecodeui/commit/e433af35fc8f8728ec6fe35d2c738f95e604c366))

### Bug Fixes

* **e2e:** drive the Enter criterion off the switch, not the retired consent tick ([b154753](https://github.com/yaleh/claudecodeui/commit/b1547537cfe55feda78ae260a121e2955ab26f7b))

### CI/CD

* drop Discord release notification (upstream webhook, not configured on fork) ([e3bdfa4](https://github.com/yaleh/claudecodeui/commit/e3bdfa48e18fd095d120893099c2a7d7bb3cdeb2))
* **release:** pass GITHUB_TOKEN to npm ci so @vscode/ripgrep's download is not rate-limited ([98cd614](https://github.com/yaleh/claudecodeui/commit/98cd6141239bfe8bb3baf63c3389aa2729a4ecd6))

### Tests

* **e2e:** anchor the AC-109 detach window at the gesture's own input moment ([d2f4445](https://github.com/yaleh/claudecodeui/commit/d2f44458fac40e32ed70954c891d570eac5f28c8))
* **e2e:** bound the resident-running-view startup path ([e963c86](https://github.com/yaleh/claudecodeui/commit/e963c8674b94d67b35c7103026a09d69e3596dca))
* **e2e:** cut the AC-109 window's frames at the gesture's own input moment ([ef6e511](https://github.com/yaleh/claudecodeui/commit/ef6e511177bf7410dbcde405f9754c3233ff7100))

## [1.38.0](https://github.com/yaleh/claudecodeui/compare/v1.37.3...v1.38.0) (2026-09-29)

### New Features

* add Playwright MCP directory to .gitignore ([5c11f44](https://github.com/yaleh/claudecodeui/commit/5c11f4483d7c2815de90180570eec120739277d9))
* **asr:** land the inline-only multimodal adapter as the second recogniser (AC-132) ([9a36a1c](https://github.com/yaleh/claudecodeui/commit/9a36a1c52c7adebdde7d818565c8621c8ede1195))
* **chat:** a resident status bar, its marks, and the turns nobody typed ([c10b834](https://github.com/yaleh/claudecodeui/commit/c10b8342fa6e63443484be2bf67f51a6a99df746))
* **chat:** decide the composer footer's tier from the box's own width ([cb15da7](https://github.com/yaleh/claudecodeui/commit/cb15da76cd713b93aa8d577938a6fd26194fc457))
* **chat:** disclose the resident-mode tradeoff before it is enabled ([e51569b](https://github.com/yaleh/claudecodeui/commit/e51569b12de0b74ed7e8c9870fe5f7c2e0055752))
* **chat:** draw the running turn inline below md ([b24128b](https://github.com/yaleh/claudecodeui/commit/b24128b5306d74f443235c131714bf4998a853c0))
* **chat:** identifier fidelity metric + voice fill-back reading (AC-114) ([a56e1a3](https://github.com/yaleh/claudecodeui/commit/a56e1a346a16046747ced38c1f9b7d0c9ef18041))
* **chat:** prototype a touch-scoped send key for the composer ([bb787bc](https://github.com/yaleh/claudecodeui/commit/bb787bcd8890577b6017629e0ff1cba56491d648))
* **chat:** render workspace image paths in markdown ([#1307](https://github.com/yaleh/claudecodeui/issues/1307)) ([4b98d2e](https://github.com/yaleh/claudecodeui/commit/4b98d2eaec077470b737790b32e896051c5ff5ba))
* **chat:** route a busy resident session's send to the process instead of the local queue ([df558ec](https://github.com/yaleh/claudecodeui/commit/df558ecc674d95457bd99fea1cd870bf0694b518))
* **chat:** say a compaction out loud, as one row with its summary folded in ([#1295](https://github.com/yaleh/claudecodeui/issues/1295)) ([d450ed8](https://github.com/yaleh/claudecodeui/commit/d450ed8521e71d731265021c75980656ab20c185)), closes [#1292](https://github.com/yaleh/claudecodeui/issues/1292)
* **chat:** scope the composer send key to the device's input capabilities ([7d842d4](https://github.com/yaleh/claudecodeui/commit/7d842d4cac6d935afa076e996bb3890def6fab0f))
* **chat:** 权限模式随发送落库，客户端不再持久化 ([5b61e03](https://github.com/yaleh/claudecodeui/commit/5b61e03ea63f85e921a3be828302fe4be7198d80))
* **claude-resident:** intercept the three human-facing permission entries ([4db6cae](https://github.com/yaleh/claudecodeui/commit/4db6caefadd926cb2abe409fa078af2b2457a7cd))
* **claude-resident:** reconcile held-work reasons from the Stop hook and the stream ([e64c0e3](https://github.com/yaleh/claudecodeui/commit/e64c0e3d4fc95143b887394184e4d6fcb021e71d))
* **claude-resident:** refuse a bypass launch when user settings enable Remote Control ([b5f2575](https://github.com/yaleh/claudecodeui/commit/b5f2575141c5023f4ab23092476474f62b2ab4f7))
* **claude:** busy input joins the CLI's own queue and stays withdrawable until it starts (AC-163) ([35e9401](https://github.com/yaleh/claudecodeui/commit/35e94019560239cd8ca73cb64e97df593dfbab14))
* **claude:** resident host driver — one CLI across turns (AC-161) ([8436c6f](https://github.com/yaleh/claudecodeui/commit/8436c6ff59c9dc2e0024a772bc05970f05dbd798))
* **cost:** show the session's Claude-generated ai-title in the /cost modal ([ad95447](https://github.com/yaleh/claudecodeui/commit/ad954473e35aeb36b5dde6f010d3e763be1f6eb1))
* **debug-agent:** an output engine that writes the transcript it forwards ([c05f4fd](https://github.com/yaleh/claudecodeui/commit/c05f4fd481cb616076f089387399de9f19d3ad35))
* **debug-agent:** drive resident host states, turn origins and the run seam ([003c009](https://github.com/yaleh/claudecodeui/commit/003c0090a6a189eaa649aeb4343773597d664e3a))
* **debug-agent:** gate the debug agent so "off" means structurally absent ([4b14dd8](https://github.com/yaleh/claudecodeui/commit/4b14dd8f556bae78fa1df17addce4bd9719a1ab3))
* **debug-agent:** hold resident debug sessions on a multiplexed host ([ecca928](https://github.com/yaleh/claudecodeui/commit/ecca9280e7d94e5043cbe4b72ea9829cf60a8035))
* **debug-agent:** seed a scenario's lifecycle mode and keep the host writer across turns ([5d9d1a1](https://github.com/yaleh/claudecodeui/commit/5d9d1a1c951f2340b79fa1d16b49db01679b46fc))
* **e2e:** Playwright toolchain + launch-profiles real-browser spec; profile create/edit UI with baseUrl/auth/contextWindow ([d882915](https://github.com/yaleh/claudecodeui/commit/d882915db2a37ea0740afb8e7b5d2ef1dbdcf8c5))
* **goals:** 激活 GOAL-007，并把激活记录改成实测的 ([a204fff](https://github.com/yaleh/claudecodeui/commit/a204fffd093a556e5d5369648bcc69c4c19e109d))
* **goals:** 立 GOAL-007 调试 Agent + 六条红先行判据（据 ADR-003 评审通过） ([acc1430](https://github.com/yaleh/claudecodeui/commit/acc1430ea3018dae190c1c7422cc809c2d49ad48))
* **i18n:** add Indonesian language support ([#1328](https://github.com/yaleh/claudecodeui/issues/1328)) ([b8e572b](https://github.com/yaleh/claudecodeui/commit/b8e572bdf919752aa17b521a2784341b7665beca))
* **launch-profiles:** Profiles settings tab + composer profile select sends launchProfileId (AC-010) ([803c71d](https://github.com/yaleh/claudecodeui/commit/803c71dcfc57f2fb7bbce656196e4894d048ec2b))
* **models:** explain every env row kind, including unset ([fe19d09](https://github.com/yaleh/claudecodeui/commit/fe19d098f8808fe2a55ef36934bac7de8f8e41bc))
* **plugins:** recommend GLM Usage plugin ([#1323](https://github.com/yaleh/claudecodeui/issues/1323)) ([f05ba1f](https://github.com/yaleh/claudecodeui/commit/f05ba1fd6c6fc8cd0da180cee079fec66531a9bf))
* **projects:** per-project session name filter (backend) ([507d405](https://github.com/yaleh/claudecodeui/commit/507d4059089eb855587b8f3b67217b615e4835eb))
* **providers:** cap each Claude session in its own systemd scope ([4e25271](https://github.com/yaleh/claudecodeui/commit/4e25271d331add7c73b5131ed112624804efc0df))
* **providers:** give a resident process a stable SendMessage address ([11b3370](https://github.com/yaleh/claudecodeui/commit/11b3370031426badaa9fc84b08d4ec6d42c94685))
* **providers:** make a resident process's unattended turn a run ([3fd1ecb](https://github.com/yaleh/claudecodeui/commit/3fd1ecb0a8a45e4ef50b4bb5105d40308bbb1e69))
* **providers:** pick the session watcher's mechanism per root, and back off when polling ([a07e7ae](https://github.com/yaleh/claudecodeui/commit/a07e7ae3d5cb3dee0f2ced98e8ee6f3346d4a8d3))
* **quay:** scripts/test.sh emits per-file results for the quay tests page ([e776459](https://github.com/yaleh/claudecodeui/commit/e776459ed370e0b5e79c2678f74ab489e7bce292))
* **resident-experiments:** 控制协议清单 E9 取数并定稿 proposal ([7d37fd6](https://github.com/yaleh/claudecodeui/commit/7d37fd6864675d9ef07528cd9afb2a9331f0e11d))
* **resident-smoke:** land AC-170 API-面真模型冒烟脚本、护栏判据与人证记录 ([e7ab6a4](https://github.com/yaleh/claudecodeui/commit/e7ab6a42c40533e61d92dc76a8a5c4d56e04af70))
* **resident:** collapse the status bar's per-kind lease chips into one count ([917916c](https://github.com/yaleh/claudecodeui/commit/917916c262ceb2870406c89ffe6436322afe43d9))
* **resident:** move the enable switch under the model card and retire the consent gate ([6814265](https://github.com/yaleh/claudecodeui/commit/6814265d9fd8ffd80f4be673b7baf848af19f609))
* **scripts:** add suite-concurrency-check.sh — AC-103 的并发判据读数 ([64e46f0](https://github.com/yaleh/claudecodeui/commit/64e46f0d264729f29129d4c4e7281ac9f24a0919))
* **scripts:** gate scripts/ with strict TS and run its tests ([e320cd0](https://github.com/yaleh/claudecodeui/commit/e320cd0d0e47ccda0b244618b9bac90333fb2c7a))
* **scripts:** restart the :3001 server unit on failure and cap its V8 heap ([66755b7](https://github.com/yaleh/claudecodeui/commit/66755b75c47368813e698c0673650f2e22e1306b))
* **scripts:** 新增 suite-scope-check 守卫（活跃任务的自测作用域），并在 test.sh 前置调用 ([ce34887](https://github.com/yaleh/claudecodeui/commit/ce3488765a88ce4ce3da2bdada04ca9baabb1416))
* **scripts:** 给 test.sh 加 max-runtime / silence 两条活性看门狗，阈值由实测推出 ([0fded85](https://github.com/yaleh/claudecodeui/commit/0fded8597fdff632dbe0eb5c68a383154fde94e8))
* **server:** resident caps from config, and an OOM fact a host can read ([5cbe85d](https://github.com/yaleh/claudecodeui/commit/5cbe85d652f376f40d464f29e89ad85a2c940f55))
* **session-hosts:** bind sessions 1:N, refuse a second binding, supersede before start ([5ea8711](https://github.com/yaleh/claudecodeui/commit/5ea8711d347120c67f14910fb5cc38c87cac5485))
* **session-hosts:** drive Claude per-run hosts from the session-host layer ([05db7d4](https://github.com/yaleh/claudecodeui/commit/05db7d4ad86d8bf7b6cbf1336075cc70b7f0172e))
* **session-hosts:** drive host lifecycle from leases, with two policies ([b071ac9](https://github.com/yaleh/claudecodeui/commit/b071ac94827ba63eb694fdb4f59de6de710fc659))
* **session-hosts:** lifecycle-mode preference write path and host start/close API ([30ce434](https://github.com/yaleh/claudecodeui/commit/30ce434096a9e79738e4022b029deed86c4f4764))
* **session-hosts:** make the resident idle ceiling configurable (AC-181) ([4a3cf0b](https://github.com/yaleh/claudecodeui/commit/4a3cf0b927e6ebdac82223405de41a6f95bba513))
* **session-hosts:** report dropped resident sessions and sweep restart residue ([0e14412](https://github.com/yaleh/claudecodeui/commit/0e14412d0f4adc320392ad0156092b9986a35d05))
* **session-hosts:** serve the host listing over GET /api/session-hosts ([ac0feb8](https://github.com/yaleh/claudecodeui/commit/ac0feb861ebd5623aa91cc19e6ce64bbfe4ea517))
* **session-title:** show the live session name on every display surface ([6fd914b](https://github.com/yaleh/claudecodeui/commit/6fd914be8269fe7acfad69181e349123a89fa303))
* **sessions:** track where a session name came from and honour ai-title ([9a80839](https://github.com/yaleh/claudecodeui/commit/9a808394eda7e83e6ffa8ac46610cb3dfa7c31e5))
* **settings:** close settings modal with escape and backdrop click ([#1164](https://github.com/yaleh/claudecodeui/issues/1164)) ([3ed3be5](https://github.com/yaleh/claudecodeui/commit/3ed3be5aa047b17ed1f6e591cfd3692eda2f1160))
* **sidebar:** a draggable splitter for the sidebar width ([293eb56](https://github.com/yaleh/claudecodeui/commit/293eb56bfefd50b41cc043c6797dc780a4e4b7e7))
* **sidebar:** group forked sessions by lineage and mark branches ([ed1df4d](https://github.com/yaleh/claudecodeui/commit/ed1df4d1b3e351bcbf578b2e6698bb761ab75404))
* **sidebar:** pin expanded project header while sessions scroll ([#1312](https://github.com/yaleh/claudecodeui/issues/1312)) ([b028e0d](https://github.com/yaleh/claudecodeui/commit/b028e0d886c059e6c4c21137e8dbe05068c8877f))
* **sidebar:** project session-name filter UI (hidden bar, rules editor, keepSessionIds, filtered mark) ([f24c041](https://github.com/yaleh/claudecodeui/commit/f24c0412c7fb625e3c2978431b985ba132a1fdb2))
* **sidebar:** resizable sidebar width (prototype, verified in a browser) ([6827804](https://github.com/yaleh/claudecodeui/commit/68278044d1783d833ad042413d463bcad6c2419b))
* **sidebar:** split running view into turns in flight and held-open residents ([8357e62](https://github.com/yaleh/claudecodeui/commit/8357e627341877949207a083d4d258bb66e9585f))
* **static-assets:** gzip/brotli the dist bundle and SPA entry ([8437e54](https://github.com/yaleh/claudecodeui/commit/8437e54870e7fd4d864148f001fef3ad45cc06e5))
* **voice:** an audio-file entry into the transcription chain, behind a debug switch ([57e044f](https://github.com/yaleh/claudecodeui/commit/57e044fff7415569233df4ac32ccb1be60b3dac6))
* **voice:** answer health from the user's effective config, refuse unknown provider ids ([187d98d](https://github.com/yaleh/claudecodeui/commit/187d98d2461740cf533b6bea7258c5f3be20093e))
* **voice:** dispatch the proxy path to the selected provider's adapter ([fd910f7](https://github.com/yaleh/claudecodeui/commit/fd910f7daa2d8b57b14a0fbc243566265a161963))
* **voice:** isolate a capture failure from the transcription (AC-147) ([f35f2a9](https://github.com/yaleh/claudecodeui/commit/f35f2a9f43d6a13581312f1e3609b500b64259a2))
* **voice:** let the recogniser's declared pause capability decide 裁不裁 ([488218c](https://github.com/yaleh/claudecodeui/commit/488218c7182e6b54024864709f042fbd32fef70d))
* **voice:** pure DSP silence trim module for voice input ([c537d60](https://github.com/yaleh/claudecodeui/commit/c537d60042cb8457b76b7105baa8e85c8e74e2d1))
* **voice:** register the shipped recogniser as the first adapter ([9c80995](https://github.com/yaleh/claudecodeui/commit/9c8099522385718670f7631d6ab64726733ab781))
* **voice:** store the per-user voice settings on the server ([c16be88](https://github.com/yaleh/claudecodeui/commit/c16be882e771f039646cc916369fa06381bf3c71))
* **workspace:** close the Shell tab for resident sessions ([387d684](https://github.com/yaleh/claudecodeui/commit/387d68424cc17d91775688158a1438f4938a7fa4))

### Bug Fixes

* allow zrok subdomains in dev, guard SW cache against transient failures ([eafd765](https://github.com/yaleh/claudecodeui/commit/eafd7659f24b3a03a9a97a6ea036c555f6f092bd))
* **asr:** align the multimodal adapter with the real Gemini wire ([9a81fb5](https://github.com/yaleh/claudecodeui/commit/9a81fb5c84afd2e1ea9b1ad300b683e22f0d5c03))
* **asr:** 补 AC-132/AC-133 判据的薄委托入口（capability / mime-allowlist） ([3c9de66](https://github.com/yaleh/claudecodeui/commit/3c9de663dcef54d5f557dadfb5d89991778da914))
* **chat:** a small gesture owns the transcript, by direction not distance ([90393b9](https://github.com/yaleh/claudecodeui/commit/90393b988706f3760c9af4cda5bcd0dbd31ef38b))
* **chat:** collapse a persisted echo that meets the row still streaming it ([6a5901a](https://github.com/yaleh/claudecodeui/commit/6a5901a70495e0ba167c7716d9a77fc2c5d9ba7e))
* **chat:** detach the transcript follow on an up scroll key, at the key ([185b886](https://github.com/yaleh/claudecodeui/commit/185b88660ff3ebffb33543a286828ca908da770f))
* **chat:** Enter that confirms an IME candidate must not send on Safari ([#1332](https://github.com/yaleh/claudecodeui/issues/1332)) ([fd424f3](https://github.com/yaleh/claudecodeui/commit/fd424f3fcd739371daeb6b173167e61f95270670))
* **chat:** fold a background session's stream deltas into one row ([411d903](https://github.com/yaleh/claudecodeui/commit/411d903ee09cda1c14ae2f18238af38d6ebc168e))
* **chat:** hide the resident switch once a session is already resident ([f8382b7](https://github.com/yaleh/claudecodeui/commit/f8382b783e9b0d84795eccea288d21e19607d6d0))
* **chat:** keep the resident status bar out of the transcript's scroll box ([e0a601b](https://github.com/yaleh/claudecodeui/commit/e0a601b82648dd419f4c388e714925b5d3929f61))
* **chat:** make in-chat file references land where they point ([#1256](https://github.com/yaleh/claudecodeui/issues/1256)) ([580be52](https://github.com/yaleh/claudecodeui/commit/580be52dacd3538f1b0ec6fee56aa02d793cd21a))
* **chat:** portal the resident popover out of the transcript clip (AC-177) ([7b0e553](https://github.com/yaleh/claudecodeui/commit/7b0e553d1fd55a204f38f70e26799eb8182073d6))
* **claude-resident:** name the websocket leaf so the root stops closing an eval cycle ([8b6e7d9](https://github.com/yaleh/claudecodeui/commit/8b6e7d98da6dc9732e4b66dd0d3044edcf641490))
* **claude:** hold the CLI open for backgrounded agents and workflows ([#1291](https://github.com/yaleh/claudecodeui/issues/1291)) ([208c715](https://github.com/yaleh/claudecodeui/commit/208c71560278f7f9607847c0595803a683de2864)), closes [#1113](https://github.com/yaleh/claudecodeui/issues/1113) [#1268](https://github.com/yaleh/claudecodeui/issues/1268)
* **claude:** identify a resident round by its conversation, not its model name ([6a4957b](https://github.com/yaleh/claudecodeui/commit/6a4957b508aa4f35bd225aeefe1d622d8a538906))
* **claude:** show session titles instead of prompts in the sidebar ([#1258](https://github.com/yaleh/claudecodeui/issues/1258)) ([7704a90](https://github.com/yaleh/claudecodeui/commit/7704a90523ec6fb9514b2d251db1b18046517f2e))
* **codex:** restore user prompts from canonical typed rollout rows ([#1277](https://github.com/yaleh/claudecodeui/issues/1277)) ([5ce8ed4](https://github.com/yaleh/claudecodeui/commit/5ce8ed4537eb71397885a8a180e1d5090aa3bc2d))
* **codex:** support image-only prompts ([#1346](https://github.com/yaleh/claudecodeui/issues/1346)) ([a6d50c8](https://github.com/yaleh/claudecodeui/commit/a6d50c84ca5f16872c4166fc4772af2dc8687e6b))
* **composer:** 桌面档位允许工具组自身换行，768 双回放不再横向溢出 ([74edd76](https://github.com/yaleh/claudecodeui/commit/74edd76677183decb66f43bf854ea1964e46dcad))
* **composer:** 触摸设备不再显示发送键提示行，任何宽度都不显示 ([c954770](https://github.com/yaleh/claudecodeui/commit/c954770e18f1282a2c3871adabe50bd36a9bab49))
* **criteria:** 两条 ASR 判据重指到 registry 架构，解开 GOAL-008 的达成死锁 ([beba8cc](https://github.com/yaleh/claudecodeui/commit/beba8ccdad192cbd64400063eb40edf2eabd9c6e))
* **debug-agent:** scope the AC10 providers/list assertion to its own branch ([b5d6c66](https://github.com/yaleh/claudecodeui/commit/b5d6c6632fe9d9fb7135b1e035380bcb4d987c14))
* derive session last activity from transcript content, not file mtime ([e7534bc](https://github.com/yaleh/claudecodeui/commit/e7534bcc71f48c2a9d26c4924f95a91e4daae782))
* **e2e:** bound the criterion run itself and make a crossed ceiling name its stage ([5fb9888](https://github.com/yaleh/claudecodeui/commit/5fb9888d9908b964ab8f971c01e3e160bb6e764b))
* **e2e:** drop the dead node:os imports that red the repo lint stage ([b429a07](https://github.com/yaleh/claudecodeui/commit/b429a07551ed2124bb67eb9657dc14e759cabbfd))
* **e2e:** give each run its own scratch root, prepared under a budget ([092857e](https://github.com/yaleh/claudecodeui/commit/092857e26fe9ae274535fe3546a69ccabd853d04))
* **e2e:** reclaim the run directories an earlier run left behind ([18c69a1](https://github.com/yaleh/claudecodeui/commit/18c69a1b1670ee6be8b9b3567ee6a304b9edb7e8))
* **e2e:** scope the session-filter editor entry to the project under test ([25dac48](https://github.com/yaleh/claudecodeui/commit/25dac48ed928aecf9455e57cf5dae1066235c5d9))
* **e2e:** 每个 run 用自己的 Vite dep cache，切断共享 node_modules/.vite 的重预构建作废 ([a7b4d41](https://github.com/yaleh/claudecodeui/commit/a7b4d411d26a3ce37b1c7ed56d84af85a3fea605))
* **goals:** AC-103 expect 要求冷路径在 60000ms 硬上限内判绿 ([1d9ec1d](https://github.com/yaleh/claudecodeui/commit/1d9ec1dc06e4408ce59b1b9619f39a40bbb9bec8))
* **goals:** 修 AC-126 frontmatter 的 ASCII 冒号致 YAML 解析失败 ([e17fc0d](https://github.com/yaleh/claudecodeui/commit/e17fc0dad9b54466e6e41fa46c9af748e7692ba9))
* **i18n:** merge duplicate top-level resident keys in en/zh-CN chat.json ([0f42f2b](https://github.com/yaleh/claudecodeui/commit/0f42f2b72281ffd9397a523ff089e92639bd9868))
* **i18n:** 补齐 7 个 locale 缺失的 input.queue.*（排队消息 6 键） ([7418671](https://github.com/yaleh/claudecodeui/commit/7418671643f22a942372f6e8d577ba6f81677ee4))
* **launch-profiles:** import provider and websocket helpers through module barrels ([fa6e459](https://github.com/yaleh/claudecodeui/commit/fa6e459784761de4d2d90ad8da9d8ac3fbb2e84a))
* **launch-profiles:** import websocket helpers through the module barrel ([37ea91c](https://github.com/yaleh/claudecodeui/commit/37ea91c82a0f8aef6e0b133cddf5eddeeae70745))
* **launch-profiles:** import websocket helpers through the module barrel ([461ed77](https://github.com/yaleh/claudecodeui/commit/461ed77fad5f9cbf760d6455ba61a354e1248624))
* **launch-profiles:** untrack accidentally committed node_modules symlink ([fa17a8f](https://github.com/yaleh/claudecodeui/commit/fa17a8f83a00b61d7b8e1b0b1f947cdf2ef523c9))
* **models:** gateway template merges rows and is a reversible aria-pressed toggle ([4fd2917](https://github.com/yaleh/claudecodeui/commit/4fd291774ce4d08fa98d464cda8561a96d9417ce))
* **opencode:** compose the provider prefix into session model ids ([#1333](https://github.com/yaleh/claudecodeui/issues/1333)) ([544baff](https://github.com/yaleh/claudecodeui/commit/544baffe3c02106abb443f5c5f0b2b3d2bdc7b6b))
* **opencode:** hide child sessions ([#1344](https://github.com/yaleh/claudecodeui/issues/1344)) ([ed3f0bf](https://github.com/yaleh/claudecodeui/commit/ed3f0bfc0a45ee0b3aaddfd04de241c29335ff42))
* **project-workspace:** keep the selected session's title in step with session_upserted ([6e5b6da](https://github.com/yaleh/claudecodeui/commit/6e5b6daae139599377bf18ca160e9a5fdd9b9849))
* **projects:** route session-filter test imports through module barrels ([1266d45](https://github.com/yaleh/claudecodeui/commit/1266d45ec90f5a4ae0ba538b8f04d0f46e858b0f))
* **providers:** export createProviderTokenUsageService via the module barrel ([59832bf](https://github.com/yaleh/claudecodeui/commit/59832bf1352a4296cdd12bea2dd267c628d3dd8d))
* **providers:** finish the address contract at the type boundary ([84b60df](https://github.com/yaleh/claudecodeui/commit/84b60df6caba2a044abf69a89c0626f3b68dbe77))
* **providers:** scope AC6's driver-in-delta assertion to its own branch ([d320ac5](https://github.com/yaleh/claudecodeui/commit/d320ac5b32682b51d6bb0f4ce74544bc6e6cff31))
* **providers:** strip ANSI escapes from OpenCode and Cursor stderr ([#1303](https://github.com/yaleh/claudecodeui/issues/1303)) ([f362080](https://github.com/yaleh/claudecodeui/commit/f36208036efd5aef8dbfd92d3f0db18986f45530))
* **quay:** point worker-default at the claude-fjdac gateway launcher ([79b4f52](https://github.com/yaleh/claudecodeui/commit/79b4f52c84e7af34b80981ae72db0d69b6349c61))
* **quay:** test.sh handles --for-task/--allow-thin/--static-checks-doc from the scoped gate ([b167e28](https://github.com/yaleh/claudecodeui/commit/b167e2897a5d22c82e959ed99748208023ed18c8))
* **resident-experiments:** 补齐 resident-experiment.mjs 的 6 处 tsc 错误 ([94bff35](https://github.com/yaleh/claudecodeui/commit/94bff35449e65059782e37fc8a7206d32c41776e))
* route Enter through the composer's single submit entry ([75f1630](https://github.com/yaleh/claudecodeui/commit/75f1630246094d67dc2a6d26960c3c28a2f14302))
* **scripts:** attribute every test.sh failure as infra or assert ([3fe400c](https://github.com/yaleh/claudecodeui/commit/3fe400c1bdc7eb89cd852c44cbd4a7f8919e4a73))
* **scripts:** normalise the client assertion tally before testing it ([be80f1e](https://github.com/yaleh/claudecodeui/commit/be80f1ee13c26d6863fe66aa6e22744e49232095))
* **scripts:** type scripts/resident-smoke.mjs(+test) so npm run typecheck is green again ([a05471a](https://github.com/yaleh/claudecodeui/commit/a05471a9bd258459fc87d081ffbb8d26a206cce3))
* **server/providers:** widen sessions-watcher-mode's poll-window slack under fleet load ([b0073b9](https://github.com/yaleh/claudecodeui/commit/b0073b99760d1f9d47611c0a421851640ceda4bf))
* **server/tsconfig:** exclude __criterion-falsify-* from the tsc program ([7e6d074](https://github.com/yaleh/claudecodeui/commit/7e6d0744d2fec4f10c7cf1f54e559c9f66f2d02d))
* **server/tsconfig:** exclude ./modules/voice/tmp from the tsc program ([cfd66ce](https://github.com/yaleh/claudecodeui/commit/cfd66cea64c0f04263131155a8c66a15040dc3ce))
* **server:** keep throwaway servers and host-wide tests off the operator's scopes ([49c2047](https://github.com/yaleh/claudecodeui/commit/49c204786082c1b499aeecabf12822cd382e28b9))
* **sessions:** keep the recent-sessions payload test in step with lineage ([74f5fc1](https://github.com/yaleh/claudecodeui/commit/74f5fc1fab73c493189913d1dcae98759c0fc62d))
* **settings:** empty env rows are reported before a model save drops them ([5dc4a34](https://github.com/yaleh/claudecodeui/commit/5dc4a34b146239c2cf603da61cb2a10db1f69752))
* **shared/ui:** close the late-arm window in ActionMenu's viewport dismissal ([ac1cd4c](https://github.com/yaleh/claudecodeui/commit/ac1cd4c883d5a41f19631106f11075187ab776fb))
* **sidebar-tests:** stub useResidentProviders in the two capability-module mocks ([9aa412f](https://github.com/yaleh/claudecodeui/commit/9aa412f842bcfea94a6344c32db858e03f520b8a))
* **sidebar:** arm ActionMenu viewport dismissal on the next frame ([35cd475](https://github.com/yaleh/claudecodeui/commit/35cd475c9a72d70af1349020b35b788c89fbff37))
* **sidebar:** let Running collapse project groups ([#1166](https://github.com/yaleh/claudecodeui/issues/1166)) ([7090a5d](https://github.com/yaleh/claudecodeui/commit/7090a5dbfdee7f0fae5fb17232300148c1963b94))
* **sidebar:** route cross-module import through project-workspace barrel ([cd48d11](https://github.com/yaleh/claudecodeui/commit/cd48d1165d6b1fa081799fa6aa2ab39546ba5ca0))
* **suite:** keep the per-file child logs when a run is red or aborted ([45884ca](https://github.com/yaleh/claudecodeui/commit/45884caaadc3c7994287f998245377efb33c718d))
* **test:** cap the vitest client worker pool adaptively ([e0ed491](https://github.com/yaleh/claudecodeui/commit/e0ed4913d084808897e10de3304c15c3348fea60))
* **tests:** move the resetModules cold compile out of the case budget ([73cecff](https://github.com/yaleh/claudecodeui/commit/73cecffb5ac177a109fd7cad8ecd84a0d080714c))
* **tests:** scope the timeout-margin criterion to its invariant, not the mechanism ([9dba1f9](https://github.com/yaleh/claudecodeui/commit/9dba1f9e1e131e809fd0323c222b70a7a10e24c2))
* **tests:** size hookTimeout from the measurement, report it in the criterion ([7b2d3f9](https://github.com/yaleh/claudecodeui/commit/7b2d3f9f9df23611e12e776cbef4cd4d7b322635))
* **tests:** 服务端阶段的并发改为上限夹取（上限 16，由实测坡度表推出） ([71bedc3](https://github.com/yaleh/claudecodeui/commit/71bedc31da4f295816da39fcf5f3d58f7b415c02))
* **transcript:** attribute scroll intent to its input source, not to the offset's delta ([16c1678](https://github.com/yaleh/claudecodeui/commit/16c16783c8a5659e6139b1d75023d7d5f88c8774))
* upstream electron build bug ([5e73a49](https://github.com/yaleh/claudecodeui/commit/5e73a49b89b4f13766fc2e22723297a36e7dcef2))
* **voice-trim:** let a harness import the shipping tree, not one named file ([f53524d](https://github.com/yaleh/claudecodeui/commit/f53524d433ff19674dda1a743a2993c7a983550f))
* **voice-trim:** scope the uniqueness scan to the harness, not to one file ([28daa7e](https://github.com/yaleh/claudecodeui/commit/28daa7e3723e8eab1b25707c09244c396b40d5a4))
* **voice:** a provider with its own model field ignores the shared x-voice-stt-model header ([87a2554](https://github.com/yaleh/claudecodeui/commit/87a2554622f690399b3b233c9726d7783c00ca66))
* **voice:** AC7 enumerates the asr contract spec instead of running a second vitest ([ed5da1f](https://github.com/yaleh/claudecodeui/commit/ed5da1f1bc33798a689410d6851c8d0e64f90847))
* **voice:** dashscope-omni resolves an unset model to its own default; repair AC-137/138 entry order ([406b0c9](https://github.com/yaleh/claudecodeui/commit/406b0c9d014a2542fbff5373b21794c2a4a910a0))
* **voice:** exempt quay's own runtime state from the AC-152 residue guard ([ecab901](https://github.com/yaleh/claudecodeui/commit/ecab9014fb8d44e667edc50af23c758c54b95527))
* **voice:** isolate capture failures at the call site, not in the capture module ([ee1b5fb](https://github.com/yaleh/claudecodeui/commit/ee1b5fbca0bf3dd850c5a95518115ac4ef3fff61))
* **voice:** proxy-only 闸的兄弟判据输入改白名单内主机；host-bearers 收窄为出货源 ([9161b88](https://github.com/yaleh/claudecodeui/commit/9161b888e9071b552e85efd0350af21f3fd5a2b1))
* **voice:** the trim asks the registry for 裁不裁, not a table of its own ([0ae696c](https://github.com/yaleh/claudecodeui/commit/0ae696cdd1bcff53a6e677b851c6ab4c15202ae8))
* **voice:** 让 AC6 的红点名失败子命令、退出码与它自己说的那句话 ([1fe9714](https://github.com/yaleh/claudecodeui/commit/1fe9714dc9a013671a1582a7b0f1624e61811573))
* **workspace:** stop showing the resident Shell notice as a persistent banner ([3b50a13](https://github.com/yaleh/claudecodeui/commit/3b50a13b4d7715987b62513e77e702d9855e1cc3))

### Performance

* cap the transcript tail window at 512 KiB and widen by the delta ([c4c843d](https://github.com/yaleh/claudecodeui/commit/c4c843dda531a71845eace18ccab07d48e76ac99))

### Refactoring

* **launch-profiles:** 拆除旧实体，AC-001 黄金基准移植到新入口 ([b34a662](https://github.com/yaleh/claudecodeui/commit/b34a662e8ee2563037b6e7d2e8ce04eb9a8c2a66))
* **launch-profiles:** 清数据库残留结构，并收拾 GOAL-001 记录 ([3ff33d4](https://github.com/yaleh/claudecodeui/commit/3ff33d42897d5dc1aae1ed85a12a4ec4032f4342))
* **providers:** keep the shared compile layer reachable without closing the eval cycle ([a76f151](https://github.com/yaleh/claudecodeui/commit/a76f151cb5a51306a7b51ad67697175d038d2f87))
* **providers:** relocate the shared launch-spec compile layer out of launch-profiles ([1d76cac](https://github.com/yaleh/claudecodeui/commit/1d76cac64afc41321cbf6e250dc194b75f800b90))
* **voice:** name the direct path's transcript parse ([a87ba53](https://github.com/yaleh/claudecodeui/commit/a87ba539d15989d9743e252dfc19accac8d66c6c))
* **voice:** one implementation of the transcription wire protocol ([9e7ee00](https://github.com/yaleh/claudecodeui/commit/9e7ee000c30f04c1fc91d9a0d56ca7a14417ddea))

### Documentation

* add Gemini voice input proposal ([a867913](https://github.com/yaleh/claudecodeui/commit/a86791343d661aad95cbb6f10a572d7bd1ad1697))
* add launch profile proposal ([6c900ce](https://github.com/yaleh/claudecodeui/commit/6c900cec2da4c376e064d34b827b6dc609bce7c1))
* **adr-003:** 现场验证记录拆成独立文件（评审裁决 E） ([691c83f](https://github.com/yaleh/claudecodeui/commit/691c83f6992a750a96933a2e9b3f2b2c52b65b92))
* **adr-003:** 评审通过（附 A–E 裁决）落到 canonical checkout ([dec53e4](https://github.com/yaleh/claudecodeui/commit/dec53e4ab53aa2bbb1dde6173d982f26df9f09ba))
* **adr:** ADR-003 可控制的调试 Agent —— 不跑真 CLI 也能产生输出 ([1e6df28](https://github.com/yaleh/claudecodeui/commit/1e6df28cd9d4489655b5d6b00f4601223fd6032d))
* **adr:** 记入七条开放问题的裁定，并记下决策 9 的已执行 ([62aea1b](https://github.com/yaleh/claudecodeui/commit/62aea1bf58e44b3f09cf454019ab1dfd344a1a0c))
* **adr:** 记入总判定「通过」，并保留两项不由通过消除的事项 ([9f86bca](https://github.com/yaleh/claudecodeui/commit/9f86bca32a7a012af92456e123a789bf37eb0751))
* **adr:** 语音识别 provider 缝的决策记录 第二版（评审修订） ([483b2c5](https://github.com/yaleh/claudecodeui/commit/483b2c5fb80c94adc0da2b1d15a7f20071443b7b))
* **adr:** 语音识别 provider 缝的决策记录（ADR-004） ([dc568d2](https://github.com/yaleh/claudecodeui/commit/dc568d240d805ca65a7a541a2ff02109c9820dbe))
* correct the scoped-gate reading — it starts and passes ([a1fea4e](https://github.com/yaleh/claudecodeui/commit/a1fea4e388930a3897d36f674d0f0dd99bc573e3))
* **experiments:** a1 本地会话记录中口述目标与上下文竞争者的基础比例 ([9ccb4aa](https://github.com/yaleh/claudecodeui/commit/9ccb4aad884f985ec6a0c4c28bc369d6c3f317c4))
* **experiments:** a2 结果修正更正说明的排版 ([4e04667](https://github.com/yaleh/claudecodeui/commit/4e04667dc30adebf5ea04e3164b57d14cff203b4))
* **experiments:** a2 结果写明超时次数与离线重算的音频依赖 ([ca5291c](https://github.com/yaleh/claudecodeui/commit/ca5291caa156ab9e4301b726bddcfd553983a9ed))
* **experiments:** a2 结果更正与现有 goal-010 的命名冲突 ([d0c5f48](https://github.com/yaleh/claudecodeui/commit/d0c5f486eb90b839d9563508fc18dacf4178f9e1))
* **experiments:** a2 结果未通过预注册规则，不进入 goal-010 ([a73c5c0](https://github.com/yaleh/claudecodeui/commit/a73c5c0d0e2d597202305664e55740fca0ac570e))
* **experiments:** a2 结果补上去掉 c1、c7 的敏感性检查读数 ([9675753](https://github.com/yaleh/claudecodeui/commit/967575327afb79b13b5d0f66d3044bdb6189d56c))
* **experiments:** a2 补充条件使用上下文的离线模拟，结论不变 ([346c1a1](https://github.com/yaleh/claudecodeui/commit/346c1a1350ea24ac00f807f88e01a8b1c2458d84))
* **experiments:** a2 语义核验，规则一致率 93.8%，结论更强 ([1280271](https://github.com/yaleh/claudecodeui/commit/1280271e72597d498c9447ed111cd016e4c09e92))
* **experiments:** a2 预注册判定规则与冻结的真实会话上下文 ([5f4b7a9](https://github.com/yaleh/claudecodeui/commit/5f4b7a90250d4549cc2f02f579ad9860d7ac1ebd))
* **experiments:** 保存 qwen3.8-omni-flash 书面化实验的原始读数与脚本 ([a298761](https://github.com/yaleh/claudecodeui/commit/a298761eed43b62e9b835bd1451a44f50677b904))
* **experiments:** 扩展集 5 条 webm 音频入库并登记理由 ([9f5910c](https://github.com/yaleh/claudecodeui/commit/9f5910cd13cf6d353b5ed698de822394ef5958fb))
* **experiments:** 语音链路实验记录入库（实验协议 + 标点实验） ([0faa2e0](https://github.com/yaleh/claudecodeui/commit/0faa2e0781930fe8999f3772456142a698c3c617))
* **goals:** add exit-conditions section to GOAL-001 ([e5117b7](https://github.com/yaleh/claudecodeui/commit/e5117b7577bdc82cf0aa4d225b6deab19bf6dd04))
* mark launch profile proposal as partially superseded by ADR-002 ([42809eb](https://github.com/yaleh/claudecodeui/commit/42809eb39d50bd2535b721c192ddff714c152b0e))
* **ops:** measure the heap ceiling's channel boundary and record why the incident replay is unfaithful ([cef20f4](https://github.com/yaleh/claudecodeui/commit/cef20f4061d2e5268fab59d961e7c1c7f70d0e37))
* proposal for pre-ASR silence trimming (GOAL-006), and split P2 in the old one ([20a3a9c](https://github.com/yaleh/claudecodeui/commit/20a3a9c00cf6d02dbfa5f5dfb84ec91bf8b4f5eb))
* proposal for unified session lifecycle and Claude resident sessions ([e88175c](https://github.com/yaleh/claudecodeui/commit/e88175cf76223034204b07317702af7ecf7c7763))
* **proposals:** record the measured cross-session arrival shape ([2600a9d](https://github.com/yaleh/claudecodeui/commit/2600a9d2ae5977ba2ffc2b765039e90d69fb4d08))
* **proposals:** 语音输入接入 DashScope Qwen3.8-Omni-Flash，口述直接产出书面化指令 ([8207f6d](https://github.com/yaleh/claudecodeui/commit/8207f6d23f799fcb7557c7036b8f0e31fe367e71))
* **proposal:** use control-protocol events for turns, leases and busy input; isolate remote control ([41bd6ab](https://github.com/yaleh/claudecodeui/commit/41bd6abf8155e26a03c962a4977ffbdf756c8a45))
* **resident-experiments:** 记录 E2/E3 基准的人工确认行（AC4） ([4438319](https://github.com/yaleh/claudecodeui/commit/4438319545e4ff654568159b60da0d61787d026e))
* resolve open questions in launch profile proposal ([7da6f45](https://github.com/yaleh/claudecodeui/commit/7da6f45c39027c19593dd97f1753d9e8da480264))
* **voice:** proposal for actionable speech-recognition error messages (GOAL-011) ([9fe6309](https://github.com/yaleh/claudecodeui/commit/9fe6309f71f4604d0940428c010630bbaf9ae64d))
* **voice:** proposal for server-side capture of speech-recognition attempts (GOAL-010) ([51f5cb5](https://github.com/yaleh/claudecodeui/commit/51f5cb5515f485f0595324ce5f61d16e8eb093ee))
* 语音识别 provider 缝 proposal 第二版（与 ADR 第二版对齐） ([566a445](https://github.com/yaleh/claudecodeui/commit/566a445e5200f2d7dd56b9b60b2d37af60e039ea))
* 语音识别 provider 缝 proposal（设计细节与实施顺序） ([caa3b62](https://github.com/yaleh/claudecodeui/commit/caa3b62b6e85520b17d75922106c4e7c6165facc))
* 语音输入标识符修复与时间轴压缩 proposal ([57b957f](https://github.com/yaleh/claudecodeui/commit/57b957f770a9d327426161741d43b3bd60b13731))

### Maintenance

* **adr:** 删除误建的 ADR-999 存根 ([f47561d](https://github.com/yaleh/claudecodeui/commit/f47561dade8fd494940247266188a115faf15362))
* **e2e:** tighten the resident-ui-layout gate comment to one line ([f1cf6d7](https://github.com/yaleh/claudecodeui/commit/f1cf6d71325667e99dd2442fc13ba8c897ab06f9))
* **lint:** ignore the voice criteria's transient scratch files ([5eb18a9](https://github.com/yaleh/claudecodeui/commit/5eb18a913d8ad0d57b519d6fe6c36e7a14232aff))
* **ops:** isolate tests and the :3001 server in their own cgroups ([ade2dfb](https://github.com/yaleh/claudecodeui/commit/ade2dfb42c7044cf8432b935c9c4ccca24e83948))
* **ops:** put the quay fleet under one shared memory ceiling ([8e49b82](https://github.com/yaleh/claudecodeui/commit/8e49b82bd837b42bf145243c06eacbf7f0575ee6))
* **quay:** supply plugin/scripts/runner-static-gate.ts so fan-in can classify its delta ([f7604c6](https://github.com/yaleh/claudecodeui/commit/f7604c68af98cc2bf90e6415660e88e736abef01))
* **quay:** track tasks/ and quay config; drop legacy tasks/ ignore ([4aacbef](https://github.com/yaleh/claudecodeui/commit/4aacbef1d0368c4c54b4035589cb216424c8a1d9))
* **scripts:** make server-phase-concurrency-check.sh executable (scripts/*.sh 约定 100755) ([362c9c0](https://github.com/yaleh/claudecodeui/commit/362c9c06241e5cb1daeb6a02b17e36d1edffdcf2))
* **scripts:** retire suite-concurrency-check.sh with AC-103 ([f974268](https://github.com/yaleh/claudecodeui/commit/f9742680a9c3b9f02aa8d8f7918de12acf5e50c3))
* **tasks:** carry the ABI-written AC tick onto the task branch ([30439b5](https://github.com/yaleh/claudecodeui/commit/30439b5bc58190420422ea7ec4adaeea03f5d942))
* **tasks:** gap-e2e-data-dir-has-no-reclaimer 勾选入任务分支 ([83a8132](https://github.com/yaleh/claudecodeui/commit/83a81326d23d81399a39efc7a804dde1be883d07))
* **tasks:** record AC-169 satisfied via task_write ([501c0f9](https://github.com/yaleh/claudecodeui/commit/501c0f920ed8c5fac614e29f57d889bf1414020e))
* **tasks:** record the load-induced false red in the round's notes ([fc476a6](https://github.com/yaleh/claudecodeui/commit/fc476a6804e939a383ba2b65c88bff878691fedb))
* **tasks:** space the Touches annotation so the scoped gate resolves the criterion ([8e2d794](https://github.com/yaleh/claudecodeui/commit/8e2d794215aba57a23b8f27951d12b00f1797f30))
* **tasks:** sync the ABI-written body into the worktree copy ([d76b9f6](https://github.com/yaleh/claudecodeui/commit/d76b9f62c735031541f551f3bdef46ed20b8000d))
* **tasks:** 立案 gap-launch-profiles-env-injection-closed-test（GOAL-001 AC-004 结构性缺口） ([f9aff6d](https://github.com/yaleh/claudecodeui/commit/f9aff6d7925908604f6f76915afe4af770729832))
* untrack accidentally committed node_modules symlink ([1289220](https://github.com/yaleh/claudecodeui/commit/1289220b86397aa0b774ae71f5a5e54815bca8b3))

### CI/CD

* **release:** fork release pipeline to yaleh — GitHub Release + Windows + local-server only ([5abf677](https://github.com/yaleh/claudecodeui/commit/5abf677dc63ed661524fd429774e53f77a4a8ddc))

### Tests

* **chat-edit-send:** await the turn instead of sleeping 30ms through it ([54e83c2](https://github.com/yaleh/claudecodeui/commit/54e83c23fc3bdf2e6b5c7c86a4659e48da4f8763))
* **chat:** read the running turn's stop entries across the composer and the pane ([8bc3226](https://github.com/yaleh/claudecodeui/commit/8bc3226129c6f6f6b67a96daa20d12d85dc6c709))
* **claude-resident:** criterion for the idle ceiling and its held work ([624a536](https://github.com/yaleh/claudecodeui/commit/624a536ca0b151a4354a121551b45dd91f8471cb))
* **claude-resident:** narrow the cron deadline before stepping the clock ([7deac21](https://github.com/yaleh/claudecodeui/commit/7deac216a7208d627f9a252023481219aecdf751))
* **claude-resident:** print the tokens the criteria name ([e44916e](https://github.com/yaleh/claudecodeui/commit/e44916e52a7a278e4a0da2cb98c3c993126f0181))
* **claude-resident:** read loop liveness directly in the unread-subtype leg ([1abc0c6](https://github.com/yaleh/claudecodeui/commit/1abc0c6458fa4027d2e25d86bcc895ce4741b42d))
* **composer:** 钉住触摸提示行省下的 20px，并记下改动前的对照读数 ([90f696d](https://github.com/yaleh/claudecodeui/commit/90f696d9cf1d274c78f5e7cdb143b91be8683860))
* **debug-agent:** cover the external-write path end to end ([e22e6ad](https://github.com/yaleh/claudecodeui/commit/e22e6ad44b53d3eec51052737086d574023864a5))
* **debug-agent:** make the closed arm carry the root it must not use ([f04e44b](https://github.com/yaleh/claudecodeui/commit/f04e44b6a5ab6a1587b662d3bca0db100747fae6))
* **debug-agent:** read the load event's readiness from the observer itself ([e356215](https://github.com/yaleh/claudecodeui/commit/e3562158acd46a50b983230f7d522e20ebbcaa63))
* **debug-agent:** the display-identity criterion AC-136 is judged by ([325a89f](https://github.com/yaleh/claudecodeui/commit/325a89f9d3a5adb568c203a624a4037bf4e1cfb4))
* **debug-agent:** the fixture-home isolation criterion AC-127 is judged by ([c8bb1ed](https://github.com/yaleh/claudecodeui/commit/c8bb1ed22819a9e754e2bf1abfac00697e03b140))
* **debug-agent:** 短窗口试次并入臂内终态等待，收掉最重文件的叠死等 ([a78b6db](https://github.com/yaleh/claudecodeui/commit/a78b6db9a026bd6c134d436def81ad8a9f3fbb2b))
* **e2e:** anchor post-onboarding waits on the app shell, not the empty state ([eb128a0](https://github.com/yaleh/claudecodeui/commit/eb128a0e92dc46030db35cbf9489e7fda3db72ba))
* **e2e:** anchor the env-kind spec on the main UI, not the project empty state ([a71596f](https://github.com/yaleh/claudecodeui/commit/a71596f784a2e31e939e582ccdab656f299dd87a))
* **e2e:** bound session-filter's startup path with the family's warm-up and navigation probe ([069c663](https://github.com/yaleh/claudecodeui/commit/069c663daf2cf940032179b30f66e43b78833088))
* **e2e:** make the close-reachability spec independent of the consent notice ([d678f36](https://github.com/yaleh/claudecodeui/commit/d678f368daaae93775031692c71b6af18182960f))
* **e2e:** pay the AC-115 preamble's client startup before the page, and bound it ([9274519](https://github.com/yaleh/claudecodeui/commit/927451937da70d53fa530d302b9c438c525f0da1))
* **e2e:** real-browser spec for the session name filter ([0a64846](https://github.com/yaleh/claudecodeui/commit/0a6484699f39fbc7acd23cbe71a22f3edcf2f56c))
* **e2e:** state plainly what the close-reachability reading no longer proves ([97bceba](https://github.com/yaleh/claudecodeui/commit/97bceba0295a68422ec24ec7be760f30520c711c))
* **e2e:** the resident busy-send criterion, and the debug-agent gate it needs ([21a9586](https://github.com/yaleh/claudecodeui/commit/21a95867bd2f881cd3045e8bbd8d3ff93bce70c3))
* gate the oom-cap hog tests behind RUN_OOM_CAP_TESTS=1 ([f5bd7d7](https://github.com/yaleh/claudecodeui/commit/f5bd7d752144c0b5cfe48351e0e9ca4a04e74d87))
* give AC-176's out-of-harness fake arms their own migrated database ([66d0271](https://github.com/yaleh/claudecodeui/commit/66d0271d5ef1a455b09150cc756efc54f66287a1))
* harden two fleet-concurrency flakes (voice AC8 probe, model-gateway teardown) ([5accfa1](https://github.com/yaleh/claudecodeui/commit/5accfa1a7390fe71511f6cab066b3c66cf2e6a3b))
* **launch-profiles:** fix event typing ([c96494e](https://github.com/yaleh/claudecodeui/commit/c96494eb3d9f4756fe9e2b32316cf82d3bb1b067))
* **launch-profiles:** model-library gateway end-to-end (AC-025) ([ede1b40](https://github.com/yaleh/claudecodeui/commit/ede1b4095e2321aa4afaa763f8cee38e193624d8))
* **projects:** real-data criterion for the session name filter ([95112dc](https://github.com/yaleh/claudecodeui/commit/95112dc0068e9cc5e0bc2c62e356519f79e9a1e0))
* **projects:** take the real-data filter criterion off this machine's clock ([196c249](https://github.com/yaleh/claudecodeui/commit/196c249572c484c413fa384ae8059b846bf75bd9))
* **providers:** AC-001 golden-baseline provenance banner on passthrough-parity ([f8d5152](https://github.com/yaleh/claudecodeui/commit/f8d5152bffb5da08df14f71b7bd0637f8974a92f))
* **providers:** attribute session-scope reads to this process ([421b66d](https://github.com/yaleh/claudecodeui/commit/421b66dd82200c881bf2028feb2e92ee51febcf5))
* **providers:** bound the unattended-turn criterion's waits below its budget ([a330009](https://github.com/yaleh/claudecodeui/commit/a3300094f0965c35c669cc6de907927b9c4698f7))
* **providers:** measure a resident session's address end to end ([b7fa4d0](https://github.com/yaleh/claudecodeui/commit/b7fa4d0edd4b18c4e01aca1d8e1f6975e788aa33))
* **providers:** pin the AC-028 provenance header on the context-window criterion file ([deacbf2](https://github.com/yaleh/claudecodeui/commit/deacbf214caa2a1d8d3533dd3a1eb2677b5b417d))
* **providers:** re-cover the compile-path allowlist re-validation on both final spawn envs ([37f1fcf](https://github.com/yaleh/claudecodeui/commit/37f1fcf02c16964a14a994ff0b6436627b30caa1))
* **providers:** 为 AC-025 网关端到端判据补溯源注释 ([f6d883b](https://github.com/yaleh/claudecodeui/commit/f6d883b0042198b4c2de46b60487136e4f3fa9a3))
* resident-server-restart cleanup stops only its own servers' scopes ([5d208d6](https://github.com/yaleh/claudecodeui/commit/5d208d63f8cfddc15d05885732fb38b38467b340))
* **resident-status-bar:** the clock as printed, and the count that must fall ([271eccc](https://github.com/yaleh/claudecodeui/commit/271eccc521c3f6ab2457ae0265d8087e28c475f7))
* retry the SIGKILL-then-reboot legs when a foreign boot reaped the orphan ([f2cd622](https://github.com/yaleh/claudecodeui/commit/f2cd622181c01f34f201e8e9b9f5772d2292ea44))
* seed the voice fixture before the repair, not after it ([d688294](https://github.com/yaleh/claudecodeui/commit/d688294cce304d0e81b963465031123449b61a28))
* **server:** read the over-limit reap before any control, and pin the literal slice ([adf651d](https://github.com/yaleh/claudecodeui/commit/adf651de4f0a59aac2f94cb5d5249b1d57d4fb74))
* **session-hosts:** assert the binding cardinality before its proxies ([384954b](https://github.com/yaleh/claudecodeui/commit/384954beee69427992591ac9c4e21df721af4c0e))
* **session-hosts:** declare peerName in the listing's binding contract ([8b1b02b](https://github.com/yaleh/claudecodeui/commit/8b1b02b213312b83077a334b9a94db04b6d5b9bc))
* **session-hosts:** name the frame that actually went missing ([7cc6c66](https://github.com/yaleh/claudecodeui/commit/7cc6c6633aa680c0dbf76c505a13328ce2f4b81f))
* **session-hosts:** per-run frame parity criterion for AC-155 ([d16f4a3](https://github.com/yaleh/claudecodeui/commit/d16f4a3c672d7a177af58ecb11ef38796453f915))
* **transcript-follow:** 整行追加的跟住判据（夹具 + 单测） ([bc66462](https://github.com/yaleh/claudecodeui/commit/bc664621f5c2bf223519c0e7a32e600843713c3b))
* **transcript:** name the AC-111 instruments as the criterion names them ([302fd36](https://github.com/yaleh/claudecodeui/commit/302fd3651f4d6260ca549e9a51c9f93dda21469b))
* **transcript:** print the AC-111 readings from the run itself ([795bf0e](https://github.com/yaleh/claudecodeui/commit/795bf0ec6cb6041c67389162f79b2c95a552965c))
* **voice:** drive the four fake shapes the parity criterion must go red on ([5cd753b](https://github.com/yaleh/claudecodeui/commit/5cd753b714d2bbd3d2dbb7ac8924a3bb4502adff))
* **voice:** judge the real service process's stdout for the capture line (AC-148) ([145aa1b](https://github.com/yaleh/claudecodeui/commit/145aa1b59ce9e7641ee63e9b533377441161d6c9))
* **voice:** list the seam in the two module doubles that drive the mic ([2506f8d](https://github.com/yaleh/claudecodeui/commit/2506f8d3a5d4f69ed648419c32da403a9a2ed58d))
* **voice:** name a commit the baseline can be reproduced from ([c4ca434](https://github.com/yaleh/claudecodeui/commit/c4ca434f5fd220131d5c7a42919f1db82a6f5dc2))
* **voice:** read the four parity groups off the shipped code ([f28578e](https://github.com/yaleh/claudecodeui/commit/f28578ecefbe278cedd0f1242872d9509b648380))
* **voice:** record the pre-extraction parity baseline ([8bff677](https://github.com/yaleh/claudecodeui/commit/8bff677398d1670f632e0ceee62a90e1e519aa9e))
* **voice:** spell the module type as the repo does ([8dbe90b](https://github.com/yaleh/claudecodeui/commit/8dbe90b3b025a188857bc5f983e93f3cd5fce985))
* **voice:** the three capture modes, and the four secrets that must not survive them ([c471f1a](https://github.com/yaleh/claudecodeui/commit/c471f1a65e9d99e1df35e69f8ccec5afe02138d8))
* **voice:** the two mic doubles follow the seam the trim now reads ([c828520](https://github.com/yaleh/claudecodeui/commit/c828520c7e0ceb19ebed5bad375b29cc288d8047))

## [1.37.3](https://github.com/siteboon/claudecodeui/compare/v1.37.2...v1.37.3) (2026-09-08)

### New Features

* **chat:** recall sent messages with arrow keys in the composer ([#1238](https://github.com/siteboon/claudecodeui/issues/1238)) ([8f9a2e4](https://github.com/siteboon/claudecodeui/commit/8f9a2e43859821e9c41e4d90b8d16707f47927de))
* **chat:** unify provider workflows and improve transcript performance ([#1206](https://github.com/siteboon/claudecodeui/issues/1206)) ([99ea052](https://github.com/siteboon/claudecodeui/commit/99ea05259554c166fccab9e20dcf902f435fa54d))
* **codex:** expose GPT-6 Astra model ([#1289](https://github.com/siteboon/claudecodeui/issues/1289)) ([4e1190c](https://github.com/siteboon/claudecodeui/commit/4e1190ccec899aebeac898409e5cbd32e0cde647))
* **i18n:** connect remaining hardcoded UI strings to translations ([#1192](https://github.com/siteboon/claudecodeui/issues/1192)) ([5af0990](https://github.com/siteboon/claudecodeui/commit/5af0990386953e00b71c72d326e25b874d30a800))
* **sidebar:** draw a Conversations row the way a Projects row is drawn ([#1157](https://github.com/siteboon/claudecodeui/issues/1157)) ([7015ffc](https://github.com/siteboon/claudecodeui/commit/7015ffc8447b2de228f3d942585d29f4a9aeb955)), closes [#1206](https://github.com/siteboon/claudecodeui/issues/1206)

### Bug Fixes

* **agent:** read the model catalog's own shape, not a wrapper ([#1159](https://github.com/siteboon/claudecodeui/issues/1159)) ([25ddd76](https://github.com/siteboon/claudecodeui/commit/25ddd76820b5147a46d5b08d53f5d1f31e14d35a))
* **chat:** keep an option label containing ", " as one answer ([#1249](https://github.com/siteboon/claudecodeui/issues/1249)) ([61af329](https://github.com/siteboon/claudecodeui/commit/61af3295441581ecc7be70579af95fc046931a68))
* **claude:** ignore <synthetic> model placeholder when resolving session model ([#1207](https://github.com/siteboon/claudecodeui/issues/1207)) ([7b52e3c](https://github.com/siteboon/claudecodeui/commit/7b52e3ce1c8f0069f3f501bf56ad73b55f9bc7da))
* **editor:** syntax highlighting for .mts, .cts, .mjs and .cjs ([#1223](https://github.com/siteboon/claudecodeui/issues/1223)) ([aa2755b](https://github.com/siteboon/claudecodeui/commit/aa2755b852965b27e764f42120062966f9916502))
* **i18n:** add missing delete-dialog archive keys to all locales ([#1162](https://github.com/siteboon/claudecodeui/issues/1162)) ([1c61dc3](https://github.com/siteboon/claudecodeui/commit/1c61dc302ed556b5455255e6e1726eb2ab12e853))
* npm release it and README ([d27062e](https://github.com/siteboon/claudecodeui/commit/d27062ed2927d048195b88fa5bf54dc520bba49c))
* npm release-it and README ([125a293](https://github.com/siteboon/claudecodeui/commit/125a293f2a9315e1e60cc8805fa4d007fee7f7d7))
* **opencode:** list OpenCode Go models with reasoning variants ([#1265](https://github.com/siteboon/claudecodeui/issues/1265)) ([b7320c9](https://github.com/siteboon/claudecodeui/commit/b7320c91d197ef64d505312797cd5f7b21f5d705)), closes [#840](https://github.com/siteboon/claudecodeui/issues/840)
* **release:** expose npm publish failures ([#1271](https://github.com/siteboon/claudecodeui/issues/1271)) ([46973fc](https://github.com/siteboon/claudecodeui/commit/46973fc962e63ed31983689e50fe75f921745cda))
* **scheduled-messages:** interrupt a busy run instead of failing to send ([#1239](https://github.com/siteboon/claudecodeui/issues/1239)) ([c1be241](https://github.com/siteboon/claudecodeui/commit/c1be241bc41586478f3d15f4dc6a5a6399d40aa1))
* **sessions:** keep an archived session archived across a rescan ([#1220](https://github.com/siteboon/claudecodeui/issues/1220)) ([bfe7c49](https://github.com/siteboon/claudecodeui/commit/bfe7c495792b21f027f057f555c39e2edb24d095))
* **skills:** a plugin that ships commands keeps its skills too ([#1274](https://github.com/siteboon/claudecodeui/issues/1274)) ([b6083e0](https://github.com/siteboon/claudecodeui/commit/b6083e0bc84ea5d8063191a057c52b0f4b0088c9)), closes [#1273](https://github.com/siteboon/claudecodeui/issues/1273)

## [1.37.2](https://github.com/siteboon/claudecodeui/compare/v1.37.1...v1.37.2) (2026-08-18)

### Bug Fixes

* improve chat view and resolve bandwidth issue ([#1153](https://github.com/siteboon/claudecodeui/issues/1153)) ([0a2ad34](https://github.com/siteboon/claudecodeui/commit/0a2ad34365b7f01dcd01b87fe3f856844c0dc531))
* introduce fallback for update build failures ([0d51774](https://github.com/siteboon/claudecodeui/commit/0d5177491215c1c2a53ad23a30f7deec8de2e1af))

## [1.37.1](https://github.com/siteboon/claudecodeui/compare/v1.37.0...v1.37.1) (2026-08-13)

### New Features

* add provider session ID copy actions ([#1040](https://github.com/siteboon/claudecodeui/issues/1040)) ([428b105](https://github.com/siteboon/claudecodeui/commit/428b1052be3bb28611d2ef3fcd29cec5a9ca1397))
* **i18n:** add complete Spanish (es) translation ([#1090](https://github.com/siteboon/claudecodeui/issues/1090)) ([5fa87dd](https://github.com/siteboon/claudecodeui/commit/5fa87ddaf7c1c06c33c34f48a462743aa3877edf))
* **i18n:** complete Korean (ko) translation ([#997](https://github.com/siteboon/claudecodeui/issues/997)) ([59472c0](https://github.com/siteboon/claudecodeui/commit/59472c075eb2f28a48df9d9eff659ad823d31bd2))
* **plugins:** recommend Codex Usage plugin ([#1114](https://github.com/siteboon/claudecodeui/issues/1114)) ([ca92373](https://github.com/siteboon/claudecodeui/commit/ca92373dfead92f7f777093e72e9a118a97ff97a))
* **sidebar:** add recent conversation feed ([#1041](https://github.com/siteboon/claudecodeui/issues/1041)) ([015e892](https://github.com/siteboon/claudecodeui/commit/015e892c75e29b1771399691dbca3c8b466fa0b1))

### Bug Fixes

* **claude:** remove dead CLAUDE_CODE_STREAM_CLOSE_TIMEOUT workaround ([#1115](https://github.com/siteboon/claudecodeui/issues/1115)) ([ef3f798](https://github.com/siteboon/claudecodeui/commit/ef3f7980db15c89761c3a1aad8b608fff33789ad))
* don't recurse into system directories when building file trees ([#1074](https://github.com/siteboon/claudecodeui/issues/1074)) ([753a8c0](https://github.com/siteboon/claudecodeui/commit/753a8c0422685bafd4e878c44726f727357a3fb5))
* resolve @/ path aliases so the server test suite can load ([#1084](https://github.com/siteboon/claudecodeui/issues/1084)) ([74d3f8f](https://github.com/siteboon/claudecodeui/commit/74d3f8ffff6f315d2f2ceb240512aeb2d8b40464))
* **search:** match Claude transcripts by provider_session_id ([#1078](https://github.com/siteboon/claudecodeui/issues/1078)) ([9507694](https://github.com/siteboon/claudecodeui/commit/95076941533dc14f04d83917e1e7c04229e664c1))
* tolerate client clock skew before treating an auth token as expired ([#1085](https://github.com/siteboon/claudecodeui/issues/1085)) ([f0dca2d](https://github.com/siteboon/claudecodeui/commit/f0dca2d5e79c225f599e697bf9b55e839b152b78))
* update stale Sonnet 4.6 labels to Sonnet 5 in the Claude model picker ([#1036](https://github.com/siteboon/claudecodeui/issues/1036)) ([c2408f0](https://github.com/siteboon/claudecodeui/commit/c2408f0fc331fb267fdc9def954e55f71d019302))

## [1.37.0](https://github.com/siteboon/claudecodeui/compare/v1.36.3...v1.37.0) (2026-07-29)

### New Features

* numerous bugfixes and features ([#1037](https://github.com/siteboon/claudecodeui/issues/1037)) ([06e7ee9](https://github.com/siteboon/claudecodeui/commit/06e7ee9fb8c6afd1066566e8dc0e2c0c853a4990))

### Bug Fixes

* check CLAUDE_CODE_OAUTH_TOKEN in checkCredentials() ([#979](https://github.com/siteboon/claudecodeui/issues/979)) ([75ff8a5](https://github.com/siteboon/claudecodeui/commit/75ff8a5dcd0d63dced4c662bbf9433d7515d09da))

## [1.36.3](https://github.com/siteboon/claudecodeui/compare/v1.36.2...v1.36.3) (2026-07-15)

### Bug Fixes

* codex subagents should not appear in the sidebar ([283b558](https://github.com/siteboon/claudecodeui/commit/283b5586d2a6704d93ab7d0627ee947f8fef9809))
* remove node_env from electron ([f2a95d6](https://github.com/siteboon/claudecodeui/commit/f2a95d64982c3372abfb9ff144244c2383476bd3))

### Maintenance

* refresh better-sqlite3 lock ([#1027](https://github.com/siteboon/claudecodeui/issues/1027)) ([31645e3](https://github.com/siteboon/claudecodeui/commit/31645e3fdc63857d9970eae8abef8ecbc5122796))

## [1.36.2](https://github.com/siteboon/claudecodeui/compare/v1.36.1...v1.36.2) (2026-07-14)

### Bug Fixes

* bump @openai/codex-sdk to ^0.144.0 to support newer Codex models ([#1001](https://github.com/siteboon/claudecodeui/issues/1001)) ([038d960](https://github.com/siteboon/claudecodeui/commit/038d960c75b547f111751a39f28689ac66fca76d))
* harden docker cloudcli install ([123d244](https://github.com/siteboon/claudecodeui/commit/123d244a5143c3954d2f1c54240a5e683ca74a4e))
* validate X-Refreshed-Token before storing it as the auth token ([#971](https://github.com/siteboon/claudecodeui/issues/971)) ([5884573](https://github.com/siteboon/claudecodeui/commit/5884573a6975f53381759a28280afd9c8bb332c4))

## [1.36.1](https://github.com/siteboon/claudecodeui/compare/v1.36.0...v1.36.1) (2026-07-08)

### New Features

* **redesign:** skills and MCP action controls in settings ([#942](https://github.com/siteboon/claudecodeui/issues/942)) ([41e0d30](https://github.com/siteboon/claudecodeui/commit/41e0d309e06edda14abc6912ade5c2f9d4a90984))

## [](https://github.com/siteboon/claudecodeui/compare/v1.35.1...vnull) (2026-07-03)

### New Features

* add Claude and Codex effort controls ([#943](https://github.com/siteboon/claudecodeui/issues/943)) ([d272922](https://github.com/siteboon/claudecodeui/commit/d272922d87e4ee74bf8b0fdeac83b2c1e77973f3))

## [1.35.1](https://github.com/siteboon/claudecodeui/compare/v1.35.0...v1.35.1) (2026-07-01)

### Bug Fixes

* preview video on new tab ([#933](https://github.com/siteboon/claudecodeui/issues/933)) ([2ebe64f](https://github.com/siteboon/claudecodeui/commit/2ebe64f21874f45f6c8747310be874ae7342c61c))
* remove obsolete semantic helper release jobs ([1e16f1f](https://github.com/siteboon/claudecodeui/commit/1e16f1f0854e347aa333434638d64f2b167d9a9d))
* resolve mobile shell issues ([#923](https://github.com/siteboon/claudecodeui/issues/923)) ([b6cf333](https://github.com/siteboon/claudecodeui/commit/b6cf33308da996f8169580a4b5b74e3c5f38e447))

### Maintenance

* remove computer use ([6761f31](https://github.com/siteboon/claudecodeui/commit/6761f31a56fe82d82c7e0c079b4891e7d5a81817))

## [1.35.0](https://github.com/siteboon/claudecodeui/compare/v1.34.0...v1.35.0) (2026-06-29)

### New Features

* add Electron desktop app ([97c9b67](https://github.com/siteboon/claudecodeui/commit/97c9b67bfc2d803560cd1559a4e79eea9731c7b5))
* **chat:** derive activity indicator from per-session state and unify provider lifecycle events ([afc717e](https://github.com/siteboon/claudecodeui/commit/afc717e69e67f53173c30d2230722236f9180d39))
* **chat:** unify session gateway with stable IDs and a single WS protocol ([f5eac2e](https://github.com/siteboon/claudecodeui/commit/f5eac2ec12c8575bf80202fafe807d9e04720105))
* **i18n:** add French (fr) locale ([#878](https://github.com/siteboon/claudecodeui/issues/878)) ([f319d2c](https://github.com/siteboon/claudecodeui/commit/f319d2cf8d61452deaf6adf345494dd3e6898284))
* play sound for pending tool requests ([#918](https://github.com/siteboon/claudecodeui/issues/918)) ([c947eaa](https://github.com/siteboon/claudecodeui/commit/c947eaaee5fbc959563efb917f4ec7c88847dd6b))
* render changelog as markdown in version upgrade modal ([6a53c31](https://github.com/siteboon/claudecodeui/commit/6a53c31e907fffa79320997c27f99660c946b4a6))
* **sidebar:** improve running session state tracking ([591b18e](https://github.com/siteboon/claudecodeui/commit/591b18e9e343fda23affe100a53911f76aaa8f57))
* **skills:** add provider skill management ([#909](https://github.com/siteboon/claudecodeui/issues/909)) ([c5fe127](https://github.com/siteboon/claudecodeui/commit/c5fe127958d830eee19d008d8634c0e7d77fe1b9))
* **version:** warn when the server was updated but not restarted ([#898](https://github.com/siteboon/claudecodeui/issues/898)) ([f6326c8](https://github.com/siteboon/claudecodeui/commit/f6326c8082dfbe8a65dcdb836d3e71c635594c26))

### Bug Fixes

* changes provider logos to svg for fast load ([7bed675](https://github.com/siteboon/claudecodeui/commit/7bed675ad5fd1ecf7912d1a04afe9db5b1032823))
* **chat:** prevent chat interface crash on malformed AskUserQuestion payload ([#920](https://github.com/siteboon/claudecodeui/issues/920)) ([ed4ae31](https://github.com/siteboon/claudecodeui/commit/ed4ae3114aafc1d4ecb0b621eaf9d3b26dbca5b1))
* **chat:** prevent normalizeInlineCodeFences from breaking adjacent fenced code blocks ([#903](https://github.com/siteboon/claudecodeui/issues/903)) ([4712431](https://github.com/siteboon/claudecodeui/commit/4712431be81718dfb559ef43d7d7d5315bf4e01a))
* **chat:** sort messages appropriately ([123ae31](https://github.com/siteboon/claudecodeui/commit/123ae310207fe5969c3b313f62b9dee27e5d7489))
* **claude-sync:** skip subagent transcripts to prevent main session corruption ([#854](https://github.com/siteboon/claudecodeui/issues/854)) ([a12ca8e](https://github.com/siteboon/claudecodeui/commit/a12ca8eed373ef56cd37fbdd097845eaab34dee9))
* correct notification session id ([881e72d](https://github.com/siteboon/claudecodeui/commit/881e72d4a00ec9c1a5e1ae4799bffa900f27c1f8))
* create one unified function for frontend session processing ([677d330](https://github.com/siteboon/claudecodeui/commit/677d330981ef29a856f09e62b9f69bac0fa580d4))
* **i18n:** add missing sidebar message keys to all locales ([#896](https://github.com/siteboon/claudecodeui/issues/896)) ([7ca3556](https://github.com/siteboon/claudecodeui/commit/7ca355651f0a805965bc27af3d75def626c5fb96))
* keep running-session polling active ([39b0473](https://github.com/siteboon/claudecodeui/commit/39b0473e38201c29ff1e5388946452d2eed44527))
* normalize project session payloads ([d0adddb](https://github.com/siteboon/claudecodeui/commit/d0adddbbdafecfd5713a8ac5b95c87a8f7fc54f8))
* **opencode:** bind watcher sessions to app rows early ([5b9adbb](https://github.com/siteboon/claudecodeui/commit/5b9adbbdee8561439a27ad90744388225823427b))
* **opencode:** pass workspace dir explicitly ([416a737](https://github.com/siteboon/claudecodeui/commit/416a737d76e654d2fc649206c2b921a7db150775))
* recover pending permission requests ([56b2e14](https://github.com/siteboon/claudecodeui/commit/56b2e1405967c50301d0c773567349763edc8560))
* remove provider specific token usage calculator ([2abb456](https://github.com/siteboon/claudecodeui/commit/2abb45636b5e1109733cfa58c8ab92fd4c812165))
* resolve session provider on backend reads ([9fb2d91](https://github.com/siteboon/claudecodeui/commit/9fb2d91b26bef9579337d953a29718802c466fed))
* **sessions:** canonicalize sidebar ids and timestamps ([3bbb42c](https://github.com/siteboon/claudecodeui/commit/3bbb42c23324c3cbb5587f2bcab09b1dc23086a8))
* **shell:** prioritize user npm binaries ([#913](https://github.com/siteboon/claudecodeui/issues/913)) ([4a503b1](https://github.com/siteboon/claudecodeui/commit/4a503b1dc87ff58821670c8bfb1d8a8c1dab2bcf))
* **shell:** use correct session id ([89f0524](https://github.com/siteboon/claudecodeui/commit/89f05247eddec4fe53bd1616c6a5563e3ae2427a))
* **sidebar:** align session status controls across layouts ([1b336e9](https://github.com/siteboon/claudecodeui/commit/1b336e9aa9d2cccf0676d852815d9ba613ac04d2))
* upgrade gemini logo ([9cb2afd](https://github.com/siteboon/claudecodeui/commit/9cb2afd67eb25a4f869b88abcf86f7748b2b6d71))
* voice tts format settings ([#919](https://github.com/siteboon/claudecodeui/issues/919)) ([591e8e7](https://github.com/siteboon/claudecodeui/commit/591e8e7642589b0584f9b29b46b881aaab54624e))

### Documentation

* update available plugin readmes ([f549bd9](https://github.com/siteboon/claudecodeui/commit/f549bd99e7106362a27cf4ccee6e9d434b8b5363))
* update session activity guard comment ([e23e6af](https://github.com/siteboon/claudecodeui/commit/e23e6af06a44cc4b016df5778984602d49e52629))

### Maintenance

* add github issues board plugin ([21b0f14](https://github.com/siteboon/claudecodeui/commit/21b0f14e7a86f257c65484742c43b9f85152b32c))
* add more plugins list ([bc34085](https://github.com/siteboon/claudecodeui/commit/bc34085af9912da8d8592881a5845cff84a53f7d))
* move tests to appropriate folder ([d7a38a5](https://github.com/siteboon/claudecodeui/commit/d7a38a567a5e9039935353a886310b3c32b25a79))
* move tests to appropriate folder ([c6c153e](https://github.com/siteboon/claudecodeui/commit/c6c153e7f2a60572b08d687b59f010b4ad4f5d72))
* remove a log ([00e526b](https://github.com/siteboon/claudecodeui/commit/00e526b6e90ee0baf09ebf48873bc10824ab80ba))
* remove unused modelConstants from the project ([92de0ed](https://github.com/siteboon/claudecodeui/commit/92de0ed6137bf4571056deb3b930cc9fd22e2a08))
* upgrade gemini models ([3d94821](https://github.com/siteboon/claudecodeui/commit/3d948217ef3084e764171ebc5dda55f663150b2c))

## [](https://github.com/siteboon/claudecodeui/compare/v1.33.3...vnull) (2026-06-09)

### New Features

* adding Fable 5 in claude code ([ce327b6](https://github.com/siteboon/claudecodeui/commit/ce327b6fa9329aa3e9a3a1da7225ca01d3b06ac5))

## [1.33.3](https://github.com/siteboon/claudecodeui/compare/v1.33.2...v1.33.3) (2026-06-09)

### New Features

* add file tree upload progress ([c235b05](https://github.com/siteboon/claudecodeui/commit/c235b05e1d3b626667dba4043b685512e3cd3d5d))
* signal when chat runs complete ([d70dc07](https://github.com/siteboon/claudecodeui/commit/d70dc077bfbbfcf2ff4fa5514fabf7b4485861fa))

### Bug Fixes

* address notification review feedback ([602e6ad](https://github.com/siteboon/claudecodeui/commit/602e6ad4acba612a7ea66fb3bc7485054f5675ee))
* align prism plugin name and id with manifest.json ([ca8fd0e](https://github.com/siteboon/claudecodeui/commit/ca8fd0ee235b6a3210157bd0d9af83024d4a2248))
* **chat:** re-anchor initial scroll across lazy content reflow ([33a4e72](https://github.com/siteboon/claudecodeui/commit/33a4e72ca4f84df60aadfc4ff3f3467d6f5ae948))
* keep editor toolbar in view on long unwrapped lines ([beae8c6](https://github.com/siteboon/claudecodeui/commit/beae8c6513daa7518b9de40d8bfde3bf08e7bc87))
* **sandbox:** prevent server SIGHUP on sbx exec exit ([#792](https://github.com/siteboon/claudecodeui/issues/792)) ([f4a1614](https://github.com/siteboon/claudecodeui/commit/f4a1614a0a4ab4b65e8368d5e4221f015cb7555d)), closes [#791](https://github.com/siteboon/claudecodeui/issues/791)
* slash command suggestions trigger at any / in input, not only at start ([#843](https://github.com/siteboon/claudecodeui/issues/843)) ([f7c0024](https://github.com/siteboon/claudecodeui/commit/f7c0024fe15057ad049c71e15e88adb482a4497f))
* update naming convention ([3cd8995](https://github.com/siteboon/claudecodeui/commit/3cd89956ba06f0fc3e17d349b0c50baab4012658))

### Maintenance

* add prism plugin ([01dbe2a](https://github.com/siteboon/claudecodeui/commit/01dbe2a8bfcb3b265995f01f905b218d5f576f7b))

## [1.33.2](https://github.com/siteboon/claudecodeui/compare/v1.33.1...v1.33.2) (2026-06-08)

### New Features

* **chat:** open cost modal from token usage ([f238050](https://github.com/siteboon/claudecodeui/commit/f238050b85c3b99a702a8635059735e1a3b3a4f4))
* **i18n:** add Traditional Chinese (zh-TW) locale ([#773](https://github.com/siteboon/claudecodeui/issues/773)) ([c21a9f4](https://github.com/siteboon/claudecodeui/commit/c21a9f45610eb1eeb650d8e6cf8650e798f77f6f))

### Bug Fixes

* do not show model description in chat view ([d638a89](https://github.com/siteboon/claudecodeui/commit/d638a8982c7f75b08fc7f65f01d6d54989c790d1))
* include Claude cache tokens in usage ([ed9cdf0](https://github.com/siteboon/claudecodeui/commit/ed9cdf01145fa0d063580bb76d30cfa7ee67af86))

## [1.33.1](https://github.com/siteboon/claudecodeui/compare/v1.33.0...v1.33.1) (2026-06-05)

### New Features

* **chat:** auto-detect text direction for RTL languages ([#729](https://github.com/siteboon/claudecodeui/issues/729)) ([fa9eaf5](https://github.com/siteboon/claudecodeui/commit/fa9eaf5573a6f870a19fb62ab430ffd87c466582))

### Bug Fixes

* file tree concurrency ([#828](https://github.com/siteboon/claudecodeui/issues/828)) ([ebb0e59](https://github.com/siteboon/claudecodeui/commit/ebb0e59e8023c0a8040d168a5adffb7102e80561))
* load claude models directly from provider ([cdcac18](https://github.com/siteboon/claudecodeui/commit/cdcac182d458a24908777568979c8e756f94428c))
* plugin svg icon sanitization ([#817](https://github.com/siteboon/claudecodeui/issues/817)) ([d9e9df1](https://github.com/siteboon/claudecodeui/commit/d9e9df183f462c88c3b60975eb8254faa9168717))
* recognize claude auth token env ([#818](https://github.com/siteboon/claudecodeui/issues/818)) ([43c33d5](https://github.com/siteboon/claudecodeui/commit/43c33d5cb1b41835dfe3bccd450c5a9c2441509b))
* redact websocket auth token in logs ([#827](https://github.com/siteboon/claudecodeui/issues/827)) ([14ddbc7](https://github.com/siteboon/claudecodeui/commit/14ddbc7c57a01da9fb65fd87d8588532b11833fa))
* remove thinking mode ([#835](https://github.com/siteboon/claudecodeui/issues/835)) ([2149b87](https://github.com/siteboon/claudecodeui/commit/2149b8776b7ebfec0eace413f4fc527ccb2324c0))
* **shell:** disconnect and restart buttons ([#831](https://github.com/siteboon/claudecodeui/issues/831)) ([ef2fd48](https://github.com/siteboon/claudecodeui/commit/ef2fd48b46452d4b9e2bf1f5e3c30fafe19f27f2))
* show Claude tool result errors ([bb8db58](https://github.com/siteboon/claudecodeui/commit/bb8db5815c2d20ee4fbfa02d14c886a56ef352e0))
* **vite:** proxy /plugin-ws WebSocket requests to the backend in dev ([#757](https://github.com/siteboon/claudecodeui/issues/757)) ([96b16b4](https://github.com/siteboon/claudecodeui/commit/96b16b42e4f807d04ec743a5a4117a37a3f5e0d9))
* **websocket:** add 30s server-side heartbeat to prevent proxy idle disconnects ([#770](https://github.com/siteboon/claudecodeui/issues/770)) ([2edfef2](https://github.com/siteboon/claudecodeui/commit/2edfef2e3f4271c29ae8670df9dd382a9eef7c3c)), closes [#769](https://github.com/siteboon/claudecodeui/issues/769)
* **websocket:** reset unmountedRef on each effect re-run so token refresh reconnects ([#721](https://github.com/siteboon/claudecodeui/issues/721)) ([f082cdc](https://github.com/siteboon/claudecodeui/commit/f082cdc63bd0de90f8b3da1df6071e91ab545831))

### Documentation

* add nginx subpath deployment template ([#820](https://github.com/siteboon/claudecodeui/issues/820)) ([3ec76b5](https://github.com/siteboon/claudecodeui/commit/3ec76b5bb15a13cec41056f4c9b9c425195022fa))

### Maintenance

* update Claude fallback models ([94785bf](https://github.com/siteboon/claudecodeui/commit/94785bfa579d1f39a2bee0f9dd0f09fd0243bc79))
* update package-lock.json ([c90b341](https://github.com/siteboon/claudecodeui/commit/c90b34108e86a3effdb5c6979ea7b1692d2b9da0))

## [](https://github.com/siteboon/claudecodeui/compare/v1.32.0...vnull) (2026-06-01)

### New Features

* add opencode support ([#762](https://github.com/siteboon/claudecodeui/issues/762)) ([374e9de](https://github.com/siteboon/claudecodeui/commit/374e9de71934c41ce2c19c796e35a19234b240ec))
* **sidebar:** tooltip for the active-session indicator dot ([#782](https://github.com/siteboon/claudecodeui/issues/782)) ([27e509a](https://github.com/siteboon/claudecodeui/commit/27e509a9b8bb25c35ae0abbda44c536e15c332c8))

### Bug Fixes

* **chat:** prevent double send on mobile by removing redundant submit handlers ([#719](https://github.com/siteboon/claudecodeui/issues/719)) ([dbc41dc](https://github.com/siteboon/claudecodeui/commit/dbc41dc91dbf1fb54f92f5536d64646b4e924f31))
* preserve WebSocket frame type in plugin proxy ([#594](https://github.com/siteboon/claudecodeui/issues/594)) ([36b860e](https://github.com/siteboon/claudecodeui/commit/36b860e322454df62ebf5309018590b596e6b913)), closes [CoderLuii/HolyClaude#11](https://github.com/CoderLuii/HolyClaude/issues/11)
* refine token usage reporting ([#807](https://github.com/siteboon/claudecodeui/issues/807)) ([38bf21d](https://github.com/siteboon/claudecodeui/commit/38bf21ddf554ed28676d86b5221c25adf6f07afd))
* refresh Claude auth status after login flow ([#617](https://github.com/siteboon/claudecodeui/issues/617)) ([1e125f3](https://github.com/siteboon/claudecodeui/commit/1e125f3db5248399cd50dc3d40b1f8f44cf7ccb6))
* **sidebar:** keep session rename input visible while editing ([#781](https://github.com/siteboon/claudecodeui/issues/781)) ([951f587](https://github.com/siteboon/claudecodeui/commit/951f58751c152fbbb3f8b3ce3c814c06c061de18))

### Styling

* fix project star button location by replacing folder icon ([#793](https://github.com/siteboon/claudecodeui/issues/793)) ([295bad9](https://github.com/siteboon/claudecodeui/commit/295bad9c006b669878cbf52940794f29f7370178))

## [1.32.0](https://github.com/siteboon/claudecodeui/compare/v1.31.5...v1.32.0) (2026-05-13)

### Bug Fixes

* add clarification on auto mode ([392c73b](https://github.com/siteboon/claudecodeui/commit/392c73b6933600ea8a589c5d4eff5f7b830f99c5))
* enhance regex to correctly parse wrapper file paths for claude.exe ([#741](https://github.com/siteboon/claudecodeui/issues/741)) ([beb0a50](https://github.com/siteboon/claudecodeui/commit/beb0a50413beddfb16f6b49103e1b6b80567cb90))

## [1.31.5](https://github.com/siteboon/claudecodeui/compare/v1.31.4...v1.31.5) (2026-04-30)

### New Features

* add auto mode to claude code ([3f71d49](https://github.com/siteboon/claudecodeui/commit/3f71d4932b05dfedcdf816e2a3d7d0cd69c4f566))

## [1.31.4](https://github.com/siteboon/claudecodeui/compare/v1.31.3...v1.31.4) (2026-04-30)

### Bug Fixes

* bump codex sdk to latest version ([658421c](https://github.com/siteboon/claudecodeui/commit/658421c1c44ec4eb58b69ec7b1844a9fba11a3f3))

## [1.31.3](https://github.com/siteboon/claudecodeui/compare/v1.31.2...v1.31.3) (2026-04-30)

## [1.31.2](https://github.com/siteboon/claudecodeui/compare/v1.31.0...v1.31.2) (2026-04-30)

### Bug Fixes

* migrations for new sqlite schema ([0753c04](https://github.com/siteboon/claudecodeui/commit/0753c047837dab17b86ae4453027e30b465870f8))

## [1.31.0](https://github.com/siteboon/claudecodeui/compare/v1.30.0...v1.31.0) (2026-04-30)

### Bug Fixes

* **/status:** use CLAUDE_MODELS.DEFAULT instead of stale 'claude-sonnet-4.5' fallback ([#723](https://github.com/siteboon/claudecodeui/issues/723)) ([b4a39c7](https://github.com/siteboon/claudecodeui/commit/b4a39c729710a6294c62eb742e99e05f3e3914e9))

## [1.30.0](https://github.com/siteboon/claudecodeui/compare/v1.29.5...v1.30.0) (2026-04-21)

### New Features

* **i18n:** add Italian language support ([#677](https://github.com/siteboon/claudecodeui/issues/677)) ([86b6545](https://github.com/siteboon/claudecodeui/commit/86b6545c3505475ac2de0cec75cc8f86ab22aceb))
* **i18n:** add Turkish (tr) language support ([#678](https://github.com/siteboon/claudecodeui/issues/678)) ([89b754d](https://github.com/siteboon/claudecodeui/commit/89b754d186b68f3df8aa439a2d535644406066f0)), closes [#384](https://github.com/siteboon/claudecodeui/issues/384) [#514](https://github.com/siteboon/claudecodeui/issues/514) [#525](https://github.com/siteboon/claudecodeui/issues/525) [#534](https://github.com/siteboon/claudecodeui/issues/534)
* introduce opus 4.7 ([#682](https://github.com/siteboon/claudecodeui/issues/682)) ([c5e55ad](https://github.com/siteboon/claudecodeui/commit/c5e55adc89d0316675f90a927aa40d115958ae9f))

### Bug Fixes

* iOS scrolling main chat area ([3969135](https://github.com/siteboon/claudecodeui/commit/3969135bd427fbf48f29bb3dbfedb47791ca78dc))
* migrate PlanDisplay raw params from native details to Collapsible primitive ([fc3504e](https://github.com/siteboon/claudecodeui/commit/fc3504eaed8ca7ed9214838d148ea385b8352c31))
* precise Claude SDK denial message detection in deriveToolStatus ([09dcea0](https://github.com/siteboon/claudecodeui/commit/09dcea05fbc8c208d931aa1f08618f0e8087392f))
* reduce size of permission mode button tap target and provider selector on  mobile ([457ca0d](https://github.com/siteboon/claudecodeui/commit/457ca0daabcaa8397f4375ee8aa2671336b648ff))
* small mobile respnosive fixes ([25820ed](https://github.com/siteboon/claudecodeui/commit/25820ed995c1b813b1f9ed073097b08eb1d902ec))
* small mobile respnosive fixes ([c471b5d](https://github.com/siteboon/claudecodeui/commit/c471b5d3fa6ce1968adb4cf87a15ac0e18febd20))

### Refactoring

* add primitives, plan mode display, and new session model selector ([7763e60](https://github.com/siteboon/claudecodeui/commit/7763e60fb32e34742058c055c57664a503a34d1d))
* chat composer new design ([5758bee](https://github.com/siteboon/claudecodeui/commit/5758bee8a038ed50073dba882108617959dda82c))
* queue primitive, tool status badges, and tool display cleanup ([ec0ff97](https://github.com/siteboon/claudecodeui/commit/ec0ff974cba213a1100b2a071b8ba533e812fe82))

### Maintenance

* add docker sandbox action ([fa5a238](https://github.com/siteboon/claudecodeui/commit/fa5a23897c086bcacf1cf5d926c650f98a0f2222))

## [1.29.5](https://github.com/siteboon/claudecodeui/compare/v1.29.4...v1.29.5) (2026-04-16)

### Bug Fixes

* update node-pty to latest version ([6a13e17](https://github.com/siteboon/claudecodeui/commit/6a13e1773b145049ade512aa6e5cac21c2e5c4de))

## [1.29.4](https://github.com/siteboon/claudecodeui/compare/v1.29.3...v1.29.4) (2026-04-16)

### New Features

* deleting from sidebar will now ask whether to remove all data as well ([e9c7a50](https://github.com/siteboon/claudecodeui/commit/e9c7a5041c31a6f7b2032f06abe19c52d3d4cd8c))

### Bug Fixes

* pass pathToClaudeCodeExecutable to SDK when CLAUDE_CLI_PATH is set ([4c106a5](https://github.com/siteboon/claudecodeui/commit/4c106a5083d90989bbeedaefdbb68f5b3fa6fd58)), closes [#468](https://github.com/siteboon/claudecodeui/issues/468)

### Refactoring

* remove the sqlite3 dependency ([2895208](https://github.com/siteboon/claudecodeui/commit/289520814cf3ca36403056739ef22021f78c6033))
* **server:** extract URL detection and color utils from index.js ([#657](https://github.com/siteboon/claudecodeui/issues/657)) ([63e996b](https://github.com/siteboon/claudecodeui/commit/63e996bb77cfa97b1f55f6bdccc50161a75a3eee))

### Maintenance

* upgrade commit lint to 20.5.0 ([0948601](https://github.com/siteboon/claudecodeui/commit/09486016e67d97358c228ebc6eb4502ccb0012e4))

## [1.29.3](https://github.com/siteboon/claudecodeui/compare/v1.29.2...v1.29.3) (2026-04-15)

### Bug Fixes

* **version-upgrade-modal:** implement reload countdown and update UI messages ([#655](https://github.com/siteboon/claudecodeui/issues/655)) ([6413042](https://github.com/siteboon/claudecodeui/commit/641304242d7705b54aab65faa4a7673438c92c60))

### Maintenance

* remove unused route (migrated to providers already) ([31f28a2](https://github.com/siteboon/claudecodeui/commit/31f28a2c183f6ead50941027632d7ab64b7bb2d4))

## [1.29.2](https://github.com/siteboon/claudecodeui/compare/v1.29.1...v1.29.2) (2026-04-14)

### Bug Fixes

* **sandbox:** use backgrounded sbx run to keep sandbox  alive ([9b11c03](https://github.com/siteboon/claudecodeui/commit/9b11c034d9a19710a23b56c62dcf07c21a17bd97))

## [1.29.1](https://github.com/siteboon/claudecodeui/compare/v1.29.0...v1.29.1) (2026-04-14)

### Bug Fixes

* add latest tag to docker npx command and change the detach mode to work without spawn ([4a56972](https://github.com/siteboon/claudecodeui/commit/4a569725dae320a505753359d8edfd8ca79f0fd7))

## [1.29.0](https://github.com/siteboon/claudecodeui/compare/v1.28.1...v1.29.0) (2026-04-14)

### New Features

* adding docker sandbox environments ([13e97e2](https://github.com/siteboon/claudecodeui/commit/13e97e2c71254de7a60afb5495b21064c4bc4241))

### Bug Fixes

* **thinking-mode:** fix dropdown positioning ([#646](https://github.com/siteboon/claudecodeui/issues/646)) ([c7a5baf](https://github.com/siteboon/claudecodeui/commit/c7a5baf1479404bd40e23aa58bd9f677df9a04c6))

### Maintenance

* update release flow node version ([e2459cb](https://github.com/siteboon/claudecodeui/commit/e2459cb0f8b35f54827778a7b444e6c3ca326506))

## [1.28.1](https://github.com/siteboon/claudecodeui/compare/v1.28.0...v1.28.1) (2026-04-10)

### New Features

* add branding, community links, GitHub star badge, and About settings tab ([2207d05](https://github.com/siteboon/claudecodeui/commit/2207d05c1ca229214aa9c2e2c9f4d0827d421574))

### Bug Fixes

* corrupted binary downloads ([#634](https://github.com/siteboon/claudecodeui/issues/634)) ([e61f8a5](https://github.com/siteboon/claudecodeui/commit/e61f8a543d63fe7c24a04b3d2186085a06dcbcdb))
* **ui:** remove mobile bottom nav, unify processing indicator, and improve tooltip behavior on mobile ([#632](https://github.com/siteboon/claudecodeui/issues/632)) ([a8dab0e](https://github.com/siteboon/claudecodeui/commit/a8dab0edcf949ae610820bae9500c433781f7c73))

### Refactoring

* remove unused whispher transcribe logic ([#637](https://github.com/siteboon/claudecodeui/issues/637)) ([590dd42](https://github.com/siteboon/claudecodeui/commit/590dd42649424ab990353fcf59ce0965036d3d25))

## [1.28.0](https://github.com/siteboon/claudecodeui/compare/v1.27.1...v1.28.0) (2026-04-03)

### New Features

* adding session resume in the api ([8f1042c](https://github.com/siteboon/claudecodeui/commit/8f1042cf256be282f009adcceeb55ab2dddf3fba))
* moving new session button higher ([1628868](https://github.com/siteboon/claudecodeui/commit/16288684702dec894cf054291ca3d545ddb8214b))

### Maintenance

* changing package name to @cloudcli-ai/cloudcli ([ef51de2](https://github.com/siteboon/claudecodeui/commit/ef51de259ea2b963bc15f058b084e11220bc216a))

## [1.27.1](https://github.com/siteboon/claudecodeui/compare/v1.26.3...v1.27.1) (2026-03-29)

### Bug Fixes

* prevent split on undefined（[#491](https://github.com/siteboon/claudecodeui/issues/491)） ([#563](https://github.com/siteboon/claudecodeui/issues/563)) ([b54cdf8](https://github.com/siteboon/claudecodeui/commit/b54cdf8168fc224e9907796e4229ae8ed34e6885))

### Maintenance

* add release-it github action ([42a1313](https://github.com/siteboon/claudecodeui/commit/42a131389a6954df0d2c3bedd2cb6d3406c5ebc1))
* add terminal plugin in the plugins list ([004135e](https://github.com/siteboon/claudecodeui/commit/004135ef0187023e1da29c4a7137a28a42ebf9af))
* release tokens ([f1063fd](https://github.com/siteboon/claudecodeui/commit/f1063fd33964ccb517f5ebcdd14526ed162e1138))
* relicense to AGPL-3.0-or-later ([27cd124](https://github.com/siteboon/claudecodeui/commit/27cd12432b7d3237981f86acd9cc99532d843d4a))

## [1.26.3](https://github.com/siteboon/claudecodeui/compare/v1.26.2...v1.26.3) (2026-03-22)

## [1.26.2](https://github.com/siteboon/claudecodeui/compare/v1.26.0...v1.26.2) (2026-03-21)

### Bug Fixes

* change SW cache mechanism ([17d6ec5](https://github.com/siteboon/claudecodeui/commit/17d6ec54af18d333c8b04d2ffc64793e688d996e))
* claude auth changes and adding copy on mobile ([a41d2c7](https://github.com/siteboon/claudecodeui/commit/a41d2c713e87d56f23d5884585b4bb43c43a250a))

## [1.26.0](https://github.com/siteboon/claudecodeui/compare/v1.25.2...v1.26.0) (2026-03-20)

### New Features

* add German (Deutsch) language support ([#525](https://github.com/siteboon/claudecodeui/issues/525)) ([a7299c6](https://github.com/siteboon/claudecodeui/commit/a7299c68237908c752d504c2e8eea91570a30203))
* add WebSocket proxy for plugin backends ([#553](https://github.com/siteboon/claudecodeui/issues/553)) ([88c60b7](https://github.com/siteboon/claudecodeui/commit/88c60b70b031798d51ce26c8f080a0f64d824b05))
* Browser autofill support for login form ([#521](https://github.com/siteboon/claudecodeui/issues/521)) ([72ff134](https://github.com/siteboon/claudecodeui/commit/72ff134b315b7a1d602f3cc7dd60d47c1c1c34af))
* git panel redesign ([#535](https://github.com/siteboon/claudecodeui/issues/535)) ([adb3a06](https://github.com/siteboon/claudecodeui/commit/adb3a06d7e66a6d2dbcdfb501615e617178314af))
* introduce notification system and claude notifications ([#450](https://github.com/siteboon/claudecodeui/issues/450)) ([45e71a0](https://github.com/siteboon/claudecodeui/commit/45e71a0e73b368309544165e4dcf8b7fd014e8dd))
* **refactor:** move plugins to typescript ([#557](https://github.com/siteboon/claudecodeui/issues/557)) ([612390d](https://github.com/siteboon/claudecodeui/commit/612390db536417e2f68c501329bfccf5c6795e45))
* unified message architecture with provider adapters and session store ([#558](https://github.com/siteboon/claudecodeui/issues/558)) ([a4632dc](https://github.com/siteboon/claudecodeui/commit/a4632dc4cec228a8febb7c5bae4807c358963678))

### Bug Fixes

* detect Claude auth from settings env ([#527](https://github.com/siteboon/claudecodeui/issues/527)) ([95bcee0](https://github.com/siteboon/claudecodeui/commit/95bcee0ec459f186d52aeffe100ac1a024e92909))
* remove /exit command from claude login flow during onboarding ([#552](https://github.com/siteboon/claudecodeui/issues/552)) ([4de8b78](https://github.com/siteboon/claudecodeui/commit/4de8b78c6db5d8c2c402afce0f0b4cc16d5b6496))

### Documentation

* add German language link to all README files ([#534](https://github.com/siteboon/claudecodeui/issues/534)) ([1d31c3e](https://github.com/siteboon/claudecodeui/commit/1d31c3ec8309b433a041f3099955addc8c136c35))
* **readme:** hotfix and improve for README.jp.md ([#550](https://github.com/siteboon/claudecodeui/issues/550)) ([7413c2c](https://github.com/siteboon/claudecodeui/commit/7413c2c78422c308ac949e6a83c3e9216b24b649))
* **README:** update translations with CloudCLI branding and feature restructuring ([#544](https://github.com/siteboon/claudecodeui/issues/544)) ([14aef73](https://github.com/siteboon/claudecodeui/commit/14aef73cc6085fbb519fe64aea7cac80b7d51285))

## [1.25.2](https://github.com/siteboon/claudecodeui/compare/v1.25.0...v1.25.2) (2026-03-11)

### New Features

* **i18n:** localize plugin settings for all languages ([#515](https://github.com/siteboon/claudecodeui/issues/515)) ([621853c](https://github.com/siteboon/claudecodeui/commit/621853cbfb4233b34cb8cc2e1ed10917ba424352))

### Bug Fixes

* codeql user value provided path validation ([aaa14b9](https://github.com/siteboon/claudecodeui/commit/aaa14b9fc0b9b51c4fb9d1dba40fada7cbbe0356))
* numerous bugs ([#528](https://github.com/siteboon/claudecodeui/issues/528)) ([a77f213](https://github.com/siteboon/claudecodeui/commit/a77f213dd5d0b2538dea091ab8da6e55d2002f2f))
* **security:** disable executable gray-matter frontmatter in commands ([b9c902b](https://github.com/siteboon/claudecodeui/commit/b9c902b016f411a942c8707dd07d32b60bad087c))
* session reconnect catch-up, always-on input, frozen session recovery ([#524](https://github.com/siteboon/claudecodeui/issues/524)) ([4d8fb6e](https://github.com/siteboon/claudecodeui/commit/4d8fb6e30aa03d7cdb92bd62b7709422f9d08e32))

### Refactoring

* new settings page design and new pill component ([8ddeeb0](https://github.com/siteboon/claudecodeui/commit/8ddeeb0ce8d0642560bd3fa149236011dc6e3707))

## [1.25.0](https://github.com/siteboon/claudecodeui/compare/v1.24.0...v1.25.0) (2026-03-10)

### New Features

* add copy as text or markdown feature for assistant messages ([#519](https://github.com/siteboon/claudecodeui/issues/519)) ([1dc2a20](https://github.com/siteboon/claudecodeui/commit/1dc2a205dc2a3cbf960625d7669c7c63a2b6905f))
* add full Russian language support; update Readme.md files, and .gitignore update ([#514](https://github.com/siteboon/claudecodeui/issues/514)) ([c7dcba8](https://github.com/siteboon/claudecodeui/commit/c7dcba8d9117e84db8aac7d8a7bf6a3aa683e115))
* new plugin system ([#489](https://github.com/siteboon/claudecodeui/issues/489)) ([8afb46a](https://github.com/siteboon/claudecodeui/commit/8afb46af2e5514c9284030367281793fbb014e4f))

### Bug Fixes

* resolve duplicate key issue when rendering model options ([#520](https://github.com/siteboon/claudecodeui/issues/520)) ([9bceab9](https://github.com/siteboon/claudecodeui/commit/9bceab9e1a6e063b0b4f934ed2d9f854fcc9c6a4))

### Maintenance

* add plugins section in readme ([e581a0e](https://github.com/siteboon/claudecodeui/commit/e581a0e1ccd59fd7ec7306ca76a13e73d7c674c1))

## [1.24.0](https://github.com/siteboon/claudecodeui/compare/v1.23.2...v1.24.0) (2026-03-09)

### New Features

* add full-text search across conversations ([#482](https://github.com/siteboon/claudecodeui/issues/482)) ([3950c0e](https://github.com/siteboon/claudecodeui/commit/3950c0e47f41e93227af31494690818d45c8bc7a))

### Bug Fixes

* **git:** prevent shell injection in git routes ([86c33c1](https://github.com/siteboon/claudecodeui/commit/86c33c1c0cb34176725a38f46960213714fc3e04))
* replace getDatabase with better-sqlite3 db in getGithubTokenById ([#501](https://github.com/siteboon/claudecodeui/issues/501)) ([cb4fd79](https://github.com/siteboon/claudecodeui/commit/cb4fd795c938b1cc86d47f401973bfccdd68fdee))

## [1.23.2](https://github.com/siteboon/claudecodeui/compare/v1.22.1...v1.23.2) (2026-03-06)

### New Features

* add clickable overlay buttons for CLI prompts in Shell terminal ([#480](https://github.com/siteboon/claudecodeui/issues/480)) ([2444209](https://github.com/siteboon/claudecodeui/commit/2444209723701dda2b881cea2501b239e64e51c1)), closes [#427](https://github.com/siteboon/claudecodeui/issues/427)
* add terminal shortcuts panel for mobile ([#411](https://github.com/siteboon/claudecodeui/issues/411)) ([b0a3fdf](https://github.com/siteboon/claudecodeui/commit/b0a3fdf95ffdb961261194d10400267251e42f17))
* implement session rename with SQLite storage ([#413](https://github.com/siteboon/claudecodeui/issues/413)) ([198e3da](https://github.com/siteboon/claudecodeui/commit/198e3da89b353780f53a91888384da9118995e81)), closes [#72](https://github.com/siteboon/claudecodeui/issues/72) [#358](https://github.com/siteboon/claudecodeui/issues/358)

### Bug Fixes

* **chat:** finalize terminal lifecycle to prevent stuck processing/thinking UI ([#483](https://github.com/siteboon/claudecodeui/issues/483)) ([0590c5c](https://github.com/siteboon/claudecodeui/commit/0590c5c178f4791e2b039d525ecca4d220c3dcae))
* **codex-history:** prevent AGENTS.md/internal prompt leakage when reloading Codex sessions ([#488](https://github.com/siteboon/claudecodeui/issues/488)) ([64a96b2](https://github.com/siteboon/claudecodeui/commit/64a96b24f853acb802f700810b302f0f5cf00898))
* preserve pending permission requests across WebSocket reconnections ([#462](https://github.com/siteboon/claudecodeui/issues/462)) ([4ee88f0](https://github.com/siteboon/claudecodeui/commit/4ee88f0eb0c648b54b05f006c6796fb7b09b0fae))
* prevent React 18 batching from losing messages during session sync ([#461](https://github.com/siteboon/claudecodeui/issues/461)) ([688d734](https://github.com/siteboon/claudecodeui/commit/688d73477a50773e43c85addc96212aa6290aea5))
* release it script ([dcea8a3](https://github.com/siteboon/claudecodeui/commit/dcea8a329c7d68437e1e72c8c766cf33c74637e9))

### Styling

* improve UI for processing banner ([#477](https://github.com/siteboon/claudecodeui/issues/477)) ([2320e1d](https://github.com/siteboon/claudecodeui/commit/2320e1d74b59c65b5b7fc4fa8b05fd9208f4898c))

### Maintenance

* remove logging of received WebSocket messages in production ([#487](https://github.com/siteboon/claudecodeui/issues/487)) ([9193feb](https://github.com/siteboon/claudecodeui/commit/9193feb6dc83041f3c365204648a88468bdc001b))

## [1.22.0](https://github.com/siteboon/claudecodeui/compare/v1.21.0...v1.22.0) (2026-03-03)

### New Features

* add community button in the app ([84d4634](https://github.com/siteboon/claudecodeui/commit/84d4634735f9ee13ac1c20faa0e7e31f1b77cae8))
* Advanced file editor and file tree improvements ([#444](https://github.com/siteboon/claudecodeui/issues/444)) ([9768958](https://github.com/siteboon/claudecodeui/commit/97689588aa2e8240ba4373da5f42ab444c772e72))
* update document title based on selected project ([#448](https://github.com/siteboon/claudecodeui/issues/448)) ([9e22f42](https://github.com/siteboon/claudecodeui/commit/9e22f42a3d3a781f448ddac9d133292fe103bb8c))

### Bug Fixes

* **claude:** correct project encoded path ([#451](https://github.com/siteboon/claudecodeui/issues/451)) ([9c0e864](https://github.com/siteboon/claudecodeui/commit/9c0e864532dcc5ce7ee890d3b4db722872db2b54)), closes [#447](https://github.com/siteboon/claudecodeui/issues/447)
* **claude:** move model usage log to result message only ([#454](https://github.com/siteboon/claudecodeui/issues/454)) ([506d431](https://github.com/siteboon/claudecodeui/commit/506d43144b3ec3155c3e589e7e803862c4a8f83a))
* missing translation label ([855e22f](https://github.com/siteboon/claudecodeui/commit/855e22f9176a71daa51de716370af7f19d55bfb4))

### Maintenance

* add Gemini-CLI support to README ([#453](https://github.com/siteboon/claudecodeui/issues/453)) ([503c384](https://github.com/siteboon/claudecodeui/commit/503c3846850fb843781979b0c0e10a24b07e1a4b))

## [1.21.0](https://github.com/siteboon/claudecodeui/compare/v1.20.1...v1.21.0) (2026-02-27)

### New Features

* add copy icon for user messages ([#449](https://github.com/siteboon/claudecodeui/issues/449)) ([b359c51](https://github.com/siteboon/claudecodeui/commit/b359c515277b4266fde2fb9a29b5356949c07c4f))
* Google's gemini-cli integration ([#422](https://github.com/siteboon/claudecodeui/issues/422)) ([a367edd](https://github.com/siteboon/claudecodeui/commit/a367edd51578608b3281373cb4a95169dbf17f89))
* persist active tab across reloads via localStorage ([#414](https://github.com/siteboon/claudecodeui/issues/414)) ([e3b6892](https://github.com/siteboon/claudecodeui/commit/e3b689214f11d549ffe1b3a347476d58f25c5aca)), closes [#387](https://github.com/siteboon/claudecodeui/issues/387)

### Bug Fixes

* add support for Codex in the shell ([#424](https://github.com/siteboon/claudecodeui/issues/424)) ([23801e9](https://github.com/siteboon/claudecodeui/commit/23801e9cc15d2b8d1bfc6e39aee2fae93226d1ad))

### Maintenance

* upgrade @anthropic-ai/claude-agent-sdk to version 0.2.59 and add model usage logging ([#446](https://github.com/siteboon/claudecodeui/issues/446)) ([917c353](https://github.com/siteboon/claudecodeui/commit/917c353115653ee288bf97be01f62fad24123cbc))
* upgrade better-sqlite to latest version to support node 25 ([#445](https://github.com/siteboon/claudecodeui/issues/445)) ([4ab94fc](https://github.com/siteboon/claudecodeui/commit/4ab94fce4257e1e20370fa83fa4c0f6fadbb8a2b))

## [1.20.1](https://github.com/siteboon/claudecodeui/compare/v1.19.1...v1.20.1) (2026-02-23)

### New Features

* implement install mode detection and update commands in version upgrade process ([f986004](https://github.com/siteboon/claudecodeui/commit/f986004319207b068431f9f6adf338a8ce8decfc))
* migrate legacy database to new location and improve last login update handling ([50e097d](https://github.com/siteboon/claudecodeui/commit/50e097d4ac498aa9f1803ef3564843721833dc19))

## [1.19.1](https://github.com/siteboon/claudecodeui/compare/v1.19.0...v1.19.1) (2026-02-23)

### Bug Fixes

* add prepublishOnly script to build before publishing ([82efac4](https://github.com/siteboon/claudecodeui/commit/82efac4704cab11ed8d1a05fe84f41312140b223))

## [1.19.0](https://github.com/siteboon/claudecodeui/compare/v1.18.2...v1.19.0) (2026-02-23)

### New Features

* add HOST environment variable for configurable bind address ([#360](https://github.com/siteboon/claudecodeui/issues/360)) ([cccd915](https://github.com/siteboon/claudecodeui/commit/cccd915c336192216b6e6f68e2b5f3ece0ccf966))
* subagent tool grouping ([#398](https://github.com/siteboon/claudecodeui/issues/398)) ([0207a1f](https://github.com/siteboon/claudecodeui/commit/0207a1f3a3c87f1c6c1aee8213be999b23289386))

### Bug Fixes

* **macos:** fix node-pty posix_spawnp error with postinstall script ([#347](https://github.com/siteboon/claudecodeui/issues/347)) ([38a593c](https://github.com/siteboon/claudecodeui/commit/38a593c97fdb2bb7f051e09e8e99c16035448655)), closes [#284](https://github.com/siteboon/claudecodeui/issues/284)
* slash commands with arguments bypass command execution ([#392](https://github.com/siteboon/claudecodeui/issues/392)) ([597e9c5](https://github.com/siteboon/claudecodeui/commit/597e9c54b76e7c6cd1947299c668c78d24019cab))

### Refactoring

* **releases:** Create a contributing guide and proper release notes using a release-it plugin ([fc369d0](https://github.com/siteboon/claudecodeui/commit/fc369d047e13cba9443fe36c0b6bb2ce3beaf61c))

### Maintenance

* update @anthropic-ai/claude-agent-sdk to version 0.1.77 in package-lock.json ([#410](https://github.com/siteboon/claudecodeui/issues/410)) ([7ccbc8d](https://github.com/siteboon/claudecodeui/commit/7ccbc8d92d440e18c157b656c9ea2635044a64f6))
