# Process isolation and memory caps

*Why a runaway process used to look like "the :3001 server died", and the guards that stop it.*

## Incident (2026-09-25)

The :3001 server stopped with no crash line: `server.log` simply ended. The cause was the
kernel OOM killer, not the server.

- The server had been started with `setsid nohup npm run server &` from a tmux pane. `setsid`
  changes the session, **not the cgroup**, so the server stayed in the pane's
  `tmux-spawn-<uuid>.scope`.
- A session in another worktree ran `npx vitest run chatComposerResponsive.test.tsx` from the same
  scope. The test grew without bound (scope peak 218.8G of ~252G; no `MemoryMax`).
- The OOM killer reaps a whole scope, so the server went with it.
- Reproduced with a cap: the test hit 12G in ~14s in a worktree carrying an uncommitted one-line
  edit to `ChatComposer.tsx`; the same test on a clean checkout passes in ~300ms. The server never
  loads that file — it only serves the built `dist/` — so the server was a bystander, not a cause.

**Correction (same day, after the second OOM below):** the reproduction only proves that test can
run away; it does not prove the 218G peaks were it. Earlier OOM scopes the same day (60G, 217.8G,
31.9G) were never individually root-caused, and the 217.8G peak followed a run of the AC-103
concurrency criterion by about ten minutes. Treat the attribution of those peaks as open.

## The guards

| Subject | Guard | Why |
|---|---|---|
| Tests (vitest), layer 1 | per-worker V8 heap ceiling in `vitest.config.ts` | a runaway **dies in seconds**, wherever vitest was started from |
| Tests (vitest), layer 2 | hard `MemoryMax` in their own scope — `scripts/with-memory-cap.sh` | whatever layer 1 cannot see (Buffer/native/external) still dies alone |
| Claude sessions | hard `MemoryMax` in one scope each — `claude-session-scope.service.ts` | a runaway session or MCP dies alone, in its own cgroup |
| The :3001 server | its own systemd user service, with a restart policy and a V8 heap ceiling — `scripts/serve-scoped.sh` | other processes' OOM cannot reach it, and its own leak ends as a restart rather than as a swap storm |

Layer 1 and layer 2 are **additive, not alternatives**: they bound different channels and cover
different entry points. Neither one replaces the other — see
[the per-worker heap ceiling](#the-per-worker-v8-heap-ceiling-vitestconfigts) below.

The server deliberately gets **isolation and a process-level ceiling, not a cgroup cap**. It has no
leak history — but "no leak history" was, until 2026-09-25, an absence of observation rather than a
positive reading (the only measurement was ~224MB RSS just after boot). A cap that kills the whole
cgroup would make the server the OOM victim instead of a bystander, which is the opposite of what
the second incident needed. So the server is bounded with a **V8 heap ceiling and a restart policy**
instead: a leak ends as a non-zero exit at a predictable point and systemd starts the server again,
rather than the process growing until the *host* thrashes. See below for the numbers.

The two halves of that sentence are now doing different work, and it is worth being precise about
which one protects the server. A systemd user service is not a cgroup boundary against the
processes its own `ExecStart` goes on to spawn: `claudecodeui-server.service` owns everything the
server forks, so with the server's unit at `memory.max=max` the kernel would reap server *and*
sessions together. Isolation only began to hold when the sessions stopped being in that unit's
cgroup — which is what the session scopes below do. The server still has no cap, on purpose; it
now shares its cgroup with nothing that can run away.

### `scripts/with-memory-cap.sh <cmd…>`

Runs `<cmd>` via `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0` and `exec`s it,
so stdio and PID are unchanged. `QUAY_MEMORY_MAX` (default `24G`) sets the cap; `off` disables it.
Where there is no usable systemd user manager (macOS, CI, containers) it runs the command
uncapped and says so on stderr.

Wired in at:

- `npm run test:client` (`vitest run`);
- the client phase of `scripts/test.sh`, which is what quay's fan-in runs;
- `npm run test:server` (a `tsx --test` run over the server glob);
- `npm run test:scripts` (a `node --test` run over `scripts/**/*.test.mjs`).

The first two are **opt-in call sites**, which is exactly how the 2026-09-25 incident got past it:
the pane ran a bare `npx vitest run`, and nothing in that command line reaches this script.

The server phase (`node --test`) used to be **uncapped** — many short processes under a
concurrency clamp, with no memory incident on record — but the two npm entry points above now
wrap it too, after a session OOM'd at 8G on 2026-10-06 (see "Running tests from a Claude
session"). `scripts/test.sh`'s own server phase is still uncapped on purpose; that section's
"Not done" subsection says why.

### The per-worker V8 heap ceiling (`vitest.config.ts`)

```ts
pool: 'forks',
poolOptions: { forks: { execArgv: ['--max-old-space-size=4352'] } },
```

Where the wrapper has to be *invoked*, this one is *in the config*, so it applies to every entry
point at once: `npx vitest run`, `npm run test:client`, `scripts/test.sh`, an editor's test
runner — including the bare `npx vitest run` shape of the incident, which the wrapper never sees.
The pool is pinned to `forks` because `poolOptions.forks` is only reachable on that pool; if a
future vitest default changes, the pin makes the ceiling fail loudly instead of quietly becoming
a no-op.

**4352 MB is measured, not guessed.** `npx vitest run --logHeapUsage` over the whole client suite
(103 files, 725 cases) reads a per-file maximum of **1401 MB**
(`src/shared/asr/tests/asrContractInvariants.test.ts`); the next file is 561 MB. 4352 is **3.11×**
that maximum: above the 3× floor the ceiling was specified with, and the tightest value above it.
Re-derive it after a suite change with:

```bash
npx vitest run --logHeapUsage 2>&1 | grep -oE '[0-9]+ MB heap used' | sort -n | tail -5
```

What it does **not** bound: `--max-old-space-size` is a V8 **JS heap** limit. A runaway that
retains objects dies in seconds inside its worker (a worker that exhausts it prints
`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`, and the main
process exits non-zero with `ERR_IPC_CHANNEL_CLOSED`); a runaway that grows `Buffer`/`external`/
native memory instead is **invisible** to it and still needs layer 2. That is why the two are
described as additive, and why `scripts/with-memory-cap.sh` must not be deleted or loosened on the
strength of this ceiling.

That boundary is **measured**, not asserted. Two probes, same `node`, same
`--max-old-space-size=300`, each contained by a 2 G cgroup as a safety net:

| Probe | Channel | Result |
|---|---|---|
| `for(;;) h.push(new Array(1e6).fill(1.5))` | JS old space | aborted in **266 ms**, rc 134, `Reached heap limit` — layer 1 alone |
| `for(;;) b.push(Buffer.alloc(32<<20))` | `Buffer`/external | sailed **past** the 300 MB old-space limit, killed by the 2 G cgroup after **52.2 s**, rc 137, **no** heap evidence — layer 1 blind |

So the ceiling's guarantee is precisely "a **JS-heap** runaway dies fast and attributably". It
does **not** shorten the life of a non-JS-heap runaway; that one still runs until layer 2 takes it.

A runaway of the first kind, injected into the real component under test (not a synthetic fixture
file) and run through the test named in the 2026-09-25 incident,
`chatComposerResponsive.test.tsx`, dies the same way: whole `npx vitest run` wall clock **3.8 s**,
tree RSS peak **5162 MB** (≤ 1.5 × 4352), `FATAL ERROR: Reached heap limit` plus
`ERR_IPC_CHANNEL_CLOSED`. The synthetic fixture and the real test behave alike on that channel.

**What this does not settle.** The incident's own reproduction input is *unrecoverable*: the
one-line edit is described as "remove the tab's `!hasPendingPermissions` guard", and on the tree
that carries that guard removal the rendered output is **byte-identical** — `chatComposerResponsive`
renders with `activity: null` and `pendingPermissionRequests: []`, so both `!hasPendingPermissions`
and `activity && !hasPendingPermissions` are already `true`/`false` respectively and the guard
short-circuits nothing. Measured: that mutation leaves the test at rc 0, 945 MB tree peak. And a
single JS heap on this host tops out at 4288 MB by default, so a one-process **12 GB** reading
cannot be explained by the old-space channel alone. **Which channel the original runaway used is
therefore undetermined, and this ceiling must not be claimed to have "plugged" that incident** —
layer 2 is still the guard that covers it, exactly as before.

It is also **not** a cap on the machine: 4352 MB sits just under Node's own default
`heap_size_limit` on this host (4288 MB), so it changes *how fast and how attributably* a runaway
fails, not how large it gets.

The criterion for "the ceiling is really in force" is `scripts/vitest-heap-limit-check.sh`, run
**without** the wrapper and without `QUAY_MEMORY_MAX` on purpose: it must be the config layer that
stops the fixture.

```bash
bash scripts/vitest-heap-limit-check.sh            # expect exit 0 (受限) — runaway dies, benign control passes
bash scripts/vitest-heap-limit-check.sh --falsify  # expect exit 1 (未受限) — with no ceiling, the same fixture crosses 3× it
node --test scripts/vitest-heap-limit-check.test.mjs  # one case per verdict branch
```

Readings it asserts on one verdict line: the runaway's vitest exit code, heap-exhaustion or
worker-abnormal-exit evidence, the **whole process tree's** RSS peak (sampled from `/proc`, must
be ≤ 1.5× the ceiling — ≈5.1 G against 6528 M in practice), and the wall clock (≤ 30 s; ≈4 s in
practice). Its positive control is a benign fixture holding ~30 % of the ceiling, which must exit
0 — without it the criterion could be satisfied by a ceiling that kills everything.

### `scripts/serve-scoped.sh start|stop|restart|status`

> **Fixed unit (2026-10-05).** In production this script no longer creates a transient unit and no
> longer passes any `PATH`. It drives the installed `claudecodeui-server.service`
> (`scripts/systemd/claudecodeui-server.service`, installed by `scripts/install-server-unit.sh`,
> which adds a per-host drop-in with `WorkingDirectory=` and the log path). `node` and `claude` come
> from the *user manager's* environment, set by the user in
> `~/.config/environment.d/995-nvm-node.conf` (the file name must sort after `99-environment.conf`,
> which resets `PATH`; after editing it run `systemctl --user daemon-reload`). The old
> `--setenv=PATH="$PATH"` copied the starting shell's PATH into the unit and froze old plugin bin dirs
> (quay 0.11.0, archguard 0.1.33) into the server and every session under it. The text below
> describes the properties, which now live in the unit file; the transient mode survives only as the
> `QUAY_SERVER_CMD` test seam. To switch or restart from inside a session the server hosts, use
> `scripts/restart-server-detached.sh` (runs as its own transient unit, writes a VERDICT to
> `~/.ccui-restart/restart-unit.log`, and checks that the new server's PATH carries no plugin bin
> dirs and resolves the nvm node).

Runs `npm run server` as the transient unit `claudecodeui-server.service` with the repo as working
directory, `HOST` (default `0.0.0.0`) and `SERVER_PORT` (default `3001`), and stdout/stderr appended
to `server.log`. Refuses to `start` when already active, and refuses to run at all — exit 3, with
the reason on stderr — when there is no *usable* systemd user manager, rather than starting an
unscoped server.

**Restart policy.** The unit carries `Restart=on-failure`, `RestartSec=5`, `StartLimitBurst=5`,
`StartLimitIntervalSec=60`. Isolation alone still left a dead server dead: on 2026-09-25
`server.log` simply ended and the only detector was a person happening to look. A crash, a `kill -9`
or an abort now brings the server back within ~5s. A *clean* `stop` is not a failure and is never
restarted — the burst limit is the asymmetry that matters in the other direction: five restarts
inside 60s means something is genuinely wrong, and the unit is left visibly failed instead of
spinning forever.

**Heap ceiling.** The server starts with `NODE_OPTIONS=--max-old-space-size=<MB>`, default **2048**,
`QUAY_SERVER_HEAP_MB` overriding it and `off` (or `0`) omitting it. A caller's own `NODE_OPTIONS` is
appended to, never replaced. When V8 hits the ceiling the process aborts non-zero, which the restart
policy above picks up: a leak becomes a visible restart loop rather than unbounded growth. The host
has 252G and 14.7G of its 16G swap already in use, so an uncapped server on a leak path is a
host-wide problem, not a server problem.

**2048 is a conservative default, not a measurement.** It was chosen before any long soak reading
existed, precisely so that the failure mode is a restart rather than a swap storm. Tighten it once
there is a real soak reading — the point of the ceiling is to be lower than the point where the host
suffers, and nobody knows where that is yet. This is also why there is still no `MemoryMax` here:
the heap ceiling is a *process* limit only the server can trip, and it leaves the cgroup cap — the
thing that would make the server an OOM victim — off the table.

`status` prints the unit's own counters (`NRestarts`, `MemoryCurrent`, `MemoryPeak`, `MainPID`,
`LoadState`, `ActiveState`) after the usual `systemctl status`, because those two readings are what
tell "quietly crash-looping" apart from "up the whole time". `Restart=` doing its job is invisible
otherwise.

Test seams (defaults are the production behaviour; used by `scripts/serve-scoped-check.sh`, so a
check never touches :3001): `QUAY_SERVER_UNIT`, `QUAY_SERVER_CMD`, `QUAY_SERVER_LOG`,
`QUAY_SERVER_HEAP_MB`.

Run it from a tmux pane, **not** from a session the server hosts: sessions are the server's child
processes, so `stop`/`restart` stops the caller's own cgroup.

### Before restarting the shared server

A graceful stop or restart ends **every** session this server hosts (see `### Resident scopes` below
for why), and nothing comes back afterwards except what a client re-`--resume`s. Three checks before
you restart:

- **Count what you are about to stop.** `systemctl --user list-units 'claudecodeui-session-*'` lists
  every live session scope; that count is how many sessions the restart will end. A number you cannot
  explain is a reason to look before stopping, not after.
- **Batch the deploy.** Fold the changes of one deployment into a single restart instead of
  restarting once per small fix — on 2026-10-06 a single session restarted the server four times, and
  each restart ended every session on the host.
- **Never restart from a session the server hosts.** `stop`/`restart` stops the caller's own scope
  too, so the request would kill the very command that issued it. Use
  `scripts/restart-server-detached.sh` (also recommended in the `serve-scoped.sh` section above): it
  runs as its own transient unit, writes a VERDICT to `~/.ccui-restart/restart-unit.log`, and checks
  that the new server's PATH carries no plugin bin dirs.

### Resident scopes: `claude-session-scope.service.ts`

A resident session is not one process. It is the provider CLI plus the MCP servers it starts (pdf,
playwright, …), and when the CLI is launched through an npm shim, a wrapper process on top. On this
host that is roughly 1 GB of RSS per idle session. All of it used to land in
`claudecodeui-server.service`'s cgroup, where `memory.max` is `max` — so a single runaway session,
or one MCP it launched, was enough for the kernel to reap the whole unit with the server in it. The
2026-09-25 fix separated *tests* from the server; this separates *sessions* from the server.

`server/modules/providers/services/claude-session-scope.service.ts` exports a factory that returns
the SDK's `spawnClaudeCodeProcess` hook. `mapCliOptionsToSDK` installs it, so every session spawns
as:

```
systemd-run --user --scope --quiet --unit=claudecodeui-session-<serverPid>-<rand> \
  --slice=cloudcli-resident.slice -p MemoryMax=<cap> -p MemorySwapMax=0 -- <command> <args…>
```

`--scope` registers a transient scope and then `exec`s the target on the same PID, so stdio, PID and
exit status are unchanged (the same property `with-memory-cap.sh` relies on). `cwd`, `env` and the
abort `signal` are passed straight through.

**Both caps come from configuration, and both are injectable.** The per-session `MemoryMax` is what
decides *whether* one runaway session dies. The slice's `MemoryMax` is the level at which "all the
resident processes together" is expressible, and it is what confines the kernel's *choice of victim*
to the residents rather than to whatever else shares the machine — a cgroup's own limit is enforced
before its parent's, so a session over its own cap is the one reaped and its siblings under the same
slice are not touched. Neither number is settled here: the values are a soak question (how much a
set of residents really holds over 24 hours), so the task pinned the mechanism and its
configurability and left the numbers to that reading.

| Piece | Value |
|---|---|
| per-session cap | `CLAUDE_SESSION_MEMORY_MAX`, default `8G`; `off` (or `0`) disables wrapping |
| slice | `CLAUDE_RESIDENT_SLICE`, default `cloudcli-resident.slice`; `off` (or `0`) places the scope in no slice (the pre-slice behaviour) |
| slice total cap | `CLAUDE_RESIDENT_SLICE_MEMORY_MAX`, default unset — no cap is imposed and the slice keeps whatever the operator set; `off`, `0` and `infinity` all mean the same, because `infinity` is what `systemctl` reports for an uncapped unit |
| unit name | `claudecodeui-session-<serverPid>-<8 hex>` — the owner PID is in the name so a later process can tell whether the server that made the scope still exists |
| degradation | no usable systemd user manager (macOS, CI, containers) → the factory returns `undefined`, the option is **not set**, and the SDK spawns the CLI exactly as before; one log line says so |

The slice cap is applied with `systemctl --user set-property <slice> MemoryMax=<value>` — the slice
itself is created by the first `--slice=` spawn, and systemd does not accept `MemoryMax` on
`systemd-run --user --scope` for a *slice* — once per distinct (slice, value) pair. It is read back
with `systemctl --user show <slice> -p MemoryMax --value`, which answers in bytes (`268435456` for
`256M`) or the literal `infinity`; a criterion compares against bytes for that reason. A slice whose
cap cannot be applied is logged and does not stop the sessions: the per-session caps still apply.

The per-session cap is checked once per process by really running `true` inside a capped scope, and
the verdict is cached. `systemd-run` failing (no user manager) and the command failing (a cap too
small to even fork) are indistinguishable by exit status, so nothing weaker than a real capped run
can answer it.

**The kernel's victim is the session, not the server.** When a session exceeds its cap, the OOM
killer reaps that scope's own processes; systemd records it on the scope unit (`Failed with result
'oom-kill'`) even though the scope sits in a slice, and nothing outside the unit is signaled. The
resident slice exists so that the *other* residents — and the server, which is not in the slice at
all — are never the ones chosen. A child that is merely `Buffer.alloc`ed and never written is **not**
charged to the cgroup: the pages are `calloc`ed and stay unmapped, so no cap fires. Anything that
measures this has to touch its pages.

**The consequence that has to be handled: a scope is not in the server's cgroup**, which is exactly
what confines the kill — and also means nothing collects it when the server goes away.

- `shutdownRuntimeServices` (`server/index.ts`) stops every scope owned by its own PID, so
  `serve-scoped.sh stop` and `restart` still take their sessions with them.
- `server/index.ts` sweeps *orphaned* scopes at start-up: a scope whose encoded owner PID is gone.
  The shutdown path cannot run when the server is `SIGKILL`ed or reaped, so this is what reaps
  those sessions — on the **next** start, not immediately.
- **A graceful stop or restart ends every session this server hosts.** `server/index.ts` installs
  `SIGTERM` and `SIGINT` handlers, and both call `shutdownRuntimeServices`, which stops every
  `claudecodeui-session-*` scope whose encoded owner PID is this server's. So `systemctl --user
  restart`, `serve-scoped.sh restart`, and `scripts/restart-server-detached.sh` all take **every**
  hosted session with them, at roughly one scope per second — measured on 2026-10-06, when five
  restarts between 08:30 and 10:21 each stopped 2–8 scopes (the largest, eight scopes, took about five
  seconds). The one case that leaves a session running is a server with no chance to run its
  handler: it is collected by the next start's orphan sweep, not the shutdown path — so a `SIGKILL`ed
  server's sessions still die shortly after the kill. "My sessions are still alive" is therefore
  never a safe assumption to act on.
- A scope that died on its own (cap kill, abort, crash) stays listed as `failed` until it is
  explicitly reset — `systemctl stop` alone does not clear it. Both stop and sweep therefore
  `reset-failed` as well, or a server that loses sessions to its cap would pile up dead units
  forever.

Attributing a kill to the cap uses the same witness as the test path: the exit code cannot say
(whether the cap did it, look at `journalctl --user -u <unit>.scope | grep 'OOM killer'`), and the
journal write trails the exit, so the lookup retries briefly. On a hit it logs one line naming the
cap; an unreadable journal is silent, which is the known gap described below.

`detectResidentScopeOomKill(unitName)` is that same read exposed as a boolean, for a caller that
needs the *fact* rather than a log line — a host driver whose process exited can report
`closeDetail: 'oom'` on its host record only when the journal says the cap did it, which keeps a
cap kill distinguishable from an ordinary non-zero exit. It is deliberately a separate function from
the logging path: `attributeResidentScopeOom` writes prose, and prose is not something a state
machine can branch on.

Re-runnable proof of the containment claims, as readings rather than as source text:
`server/modules/session-hosts/tests/process-containment.test.ts` (criterion AC-167) injects a 96M
per-session cap and a slice cap, drives real scopes inside `cloudcli-resident.slice`, and reads four
things — the argv and the two caps systemd actually holds on the created unit; a bounded 384 MiB hog
being reaped with its host reading `closeReason: 'exited'`, `closeDetail: 'oom'`, alongside a third
child that merely exits non-zero and must read `error`; the sibling under the same slice and the test
process itself still alive afterwards; and the scope listing naming each live scope before it is
required to be empty. It exits 3 (unevaluated) rather than 0 on a host with no usable systemd user
manager; on this host it really runs. The slice cap it injects is restored on the way out, because
the slice outlives the test.

**Not done here — `server.log`.** The file is 4,729 multi-line synchronous log lines with no
rotation, and the restart policy now makes restarts *more* likely to be the thing that grows it. Log
rotation and de-noising are out of scope for this change and are not covered by any criterion; they
are their own problem, and the append target should be revisited once it is solved.

### `scripts/serve-scoped-check.sh [all|fake|restart|stop|heap]`

Re-runnable proof of the two promises above, as readings rather than as source text — grepping the
script for `Restart=on-failure` would pass for a unit that never comes back.

| Section | What it reads |
|---|---|
| `fake` | a fake `systemd-run` first on PATH records the argv of each `start`; asserts the restart properties, the burst limit, the 2048 ceiling (and its absence under `off`), the append-not-replace rule for a caller's `NODE_OPTIONS`, the `QUAY_SERVER_CMD` seam, and that a missing user manager is a refusal (exit 3) and not a silent success |
| `restart` | a throwaway unit runs a liveness stub; `kill -9` its main process; the unit must be active again inside 15s with a different `MainPID` and `NRestarts=1` |
| `stop` | a second throwaway unit is stopped through `serve-scoped.sh stop`; `NRestarts` must be 0 beforehand and the unit unloaded afterwards (`LoadState=not-found`) — which is what proves a clean stop is not a failure path |
| `heap` | a third unit runs a stub that retains objects; with the default ceiling it must abort (node's heap-limit line in its log) and come back restarted, with `MemoryPeak` under 2x the ceiling |

`all` (the default) runs `fake` then the three real sections **in parallel**, so the whole thing
finishes in ~15s — inside the 60s criterion gate. Every unit is named with the run's own suffix and
stopped by the EXIT trap, failure paths included. Without a usable systemd user manager the real
sections print `SKIP`; a skip is loud and is not a pass.

`scripts/serve-scoped-check.test.mjs` (`npm run test:scripts`) covers the verdict machinery: for
each branch, the pristine tree must exit 0 and a mutated copy of `serve-scoped.sh` must go red with
the verdict naming the missing item and carrying the actual argv on the same line.

## Coverage variables

| Variable | Default | What it changes |
|---|---|---|
| `QUAY_VITEST_HEAP_MB` | `4352` | layer 1 — the per-worker V8 heap ceiling in `vitest.config.ts`; `off` (or `0`) adds no `--max-old-space-size` at all, which is the unguarded control `--falsify` needs |
| `QUAY_MEMORY_MAX` | `24G` | layer 2 — the cgroup `MemoryMax` applied by `scripts/with-memory-cap.sh`; `off` runs uncapped |
| `QUAY_MEMORY_UNIT` | per-run name | the scope name `scripts/test.sh` gives that cap, so an OOM can be found in the user journal |
| `QUAY_TEST_SYSTEMD_RUN_LIMITS` | `24G` (set by `start-drivers-scoped.sh`; the **plugin's** own default is `6G`) | the cap the **full-suite runner** puts on its own scope — see [the full-suite runner's own scope](#the-full-suite-runners-own-scope-the-6g-default) |
| `QUAY_MEMORY_SLICE` | `<basename of the repo root>.slice` (set by `start-drivers-scoped.sh`) | the slice `scripts/with-memory-cap.sh` places a scope under; an explicit value overrides the project-derived name verbatim |
| `QUAY_SLICE_MEMORY_HIGH` / `QUAY_SLICE_MEMORY_MAX` | `48G` / `64G` | the `MemoryHigh` / `MemoryMax` `start-drivers-scoped.sh` writes when it has to create the slice's unit file |
| `QUAY_SLICE_UNIT_DIR` | `$HOME/.config/systemd/user` | directory the slice unit files are read from and written to; a test seam for the creation path |
| `QUAY_ENSURE_SLICE_ONLY` | unset | `1`: `start-drivers-scoped.sh` creates the slice if missing, prints its `MemoryMax`, and exits without starting the drivers |
| `START_DRIVERS_SCOPED_DRY_RUN` | unset | `1`: resolve and print the slice name and the unit text that would be written, call no systemd, exit — a test seam |
| `QUAY_HEAP_CHECK_SKIP_CLEANUP` | unset | test-only: leaves the check script's fixtures on disk so its `夹具残留` verdict branch is reachable. Not a production knob |

An unusable `QUAY_VITEST_HEAP_MB` (neither a positive number nor `off`) warns on stderr and falls
back to the ceiling: a mistyped override must not silently become "no ceiling", which is the exact
failure this layer exists to prevent. The wrapper's own failure mode is the same shape — with no
usable systemd user manager it says so on stderr rather than silently pretending to cap.

## Classification: OOM is an `assert`, not `infra`

`scripts/test.sh` marks each failing file `kind=infra|assert`, and an `infra` red is exempt from
blocking a fan-in. A capped OOM must not be exempt: exceeding the budget is a defect in the code
under test.

Two things make that non-obvious:

1. **The exit code is unreliable.** The OOM killer picks a *worker* inside the scope; vitest's main
   process survives and exits `1` with `ERR_IPC_CHANNEL_CLOSED` and no JSON report — the "worker
   died before asserting" shape, which `classify_failure_kind` reads as `infra`.
2. **The journal is the only witness.** So `test.sh` names the scope (`QUAY_MEMORY_UNIT`), and when
   vitest exits non-zero it asks `journalctl --user -u <unit>.scope` for `OOM killer`. On a hit it
   appends `client vitest OOM-killed at the memory cap (…)` to the vitest log, and
   `classify_failure_kind` maps that line to `assert`.

If the journal is unreadable the check is silent and the failure falls back to today's
classification (`infra`). That is a known gap, not a silent success.

## Diagnosing "the server died"

```bash
journalctl --user --since "2 hours ago" | grep -E 'OOM killer|memory peak'
```

`dmesg` needs the `adm` group and is denied here; the user journal is enough. Look for a
`tmux-spawn-*.scope` with a large `memory peak`, then find what ran in that pane at that time.

## The soak harness: a long run as a reading

`bash scripts/soak.sh --duration <seconds> [--report <file>] [--keep] [--burst-mb <n>] [--slow-client-drains]`
— the manual entry point of
`gap-server-soak-harness`, exposed as `npm run soak`. It answers the question the section above
could only answer by absence: **does the real server grow under sustained load?** Nothing in this
repo calls it — not `scripts/test.sh`, not `npm test`, not a quay routine, and `package.json`'s
`soak` entry is the only reference to it in the tree (its own AC greps for that). A soak starts a
real server and runs for minutes, which is something an operator asks for.

| File | Role |
|---|---|
| `scripts/soak.sh` | the driver of drivers: temp HOME/DB/port, mock gateway, the server's own unit, the trap that cleans all of it up, exit code = verdict |
| `scripts/soak-driver.mjs` | the agitator (sessions, ws clients, transcript writes, searches, shell PTYs) and the sampler; also `stub` (the two self-test processes) and `mock-gateway` |
| `scripts/soak-analyze.mjs` | the pure judge: report in, verdict out. No I/O, no clock, no /proc |
| `scripts/soak-analyze.test.mjs` | the analyzer's controls, in `npm run test:scripts` |

**Isolation, by construction.** `HOME` and `DATABASE_PATH` are redirected into a per-run work
directory, the port is a fresh one that refuses to be 3001, and the server runs in its own transient
unit (`claudecodeui-soak-<pid>`). The real `~/.claude` and the real `auth.db` are never read or
written, and the :3001 server and its cgroup are not touched at any point.

**The `systemd-run` PATH trap — read this before debugging a soak whose sessions all fail.**
`systemd-run --user` does *not* inherit the caller shell's `PATH`. On this host the systemd user
manager's `PATH` has no nvm bin directory and therefore no `claude`, and every session then ends with
`Claude Code process exited with code 1` in `server.log`. That message is `systemd-run` failing to
find the executable, **not** the CLI failing, so it reads like a broken server rather than a broken
launch. The unit is therefore given both `--setenv=PATH=<claude dir>:<node dir>:/usr/local/bin:/usr/bin:/bin`
(the CLI is a `#!/usr/bin/env node` script, so `node` has to resolve on that same PATH) and
`--setenv=CLAUDE_CLI_PATH=<abs path>`, which the server forwards to the SDK.

**Sessions come from the real `claude` binary** behind a local mock Anthropic endpoint
(`soak-driver.mjs mock-gateway`), so the readings are of the shipped path — the spec's preferred
source. The token is minted into the temp DB with `JWT_SECRET` removed from the environment (a token
minted under a different secret cannot be verified), and the driver adopts the server's
`X-Refreshed-Token` re-issue so a run longer than the token's TTL stays authenticated.

### Reading it: two kinds of criterion, and why the raw slopes are not the sharp one

The sampler takes one tick every 5s and reads `/proc/<pid>` (RSS, `VmHWM`), the server's own
`/status` command (V8 heap), `fd`/thread/child counts, the cgroup's `memory.current`, and the number
of `claudecodeui-session-*` scopes. Then:

| Criterion | Shape | What it can and cannot see |
|---|---|---|
| `rssBytes`, `heapUsedBytes` | least-squares slope over the drive window, bytes/s | a **gross backstop** only. The series is dominated by uncollected garbage: V8 collects lazily, and the spec'd agitation (transcript lines appended at ~2000/s into a jsonl that reached 105.1MB, re-read by the sessions watcher on every change) leaves hundreds of MB of reclaimable heap on the books. Measured live set 41–77MiB against a heap counter reading up to 824MiB — the raw series is ~11x the live set |
| `probe=live-set` | the heap-snapshot FILES taken at 30s intervals: byte size and `node_count`/`edge_count`, first probe → last probe, against `floor + allowance × sessionsAdded` | the sharp rule. A snapshot is built by walking the **reachable** graph, so garbage is excluded whether or not a collection ran. This is what separates "the live set grew with the workload" from "the live set grew with time" — the second has no per-session number |
| `fdCount`, `childCount`, `sessionScopeCount` | residual after the cool-down vs the pre-agitation baseline, in count units | a leak here is a failure to come back down, not a slope: these are step functions, so a regression slope would be dominated by when the last scope happened to start |
| target lifetime | consecutive unreadable ticks | a server that exited mid-window otherwise reads as "too few samples", which sends the reader after the sampler |

The heap counter read *after* a snapshot signal is **not** a settled reading: measured 92MB at one
probe and 291MB at the next on the same run, because the churn refills hundreds of MB before the
HTTP round trip returns. It is carried in the report as context; the snapshot file is the reading.
(`--heapsnapshot-signal=SIGUSR1` also writes the file progressively — it exists before it is
complete, so a copy taken on existence is truncated. The driver waits for the size to settle twice
and verifies the copy before it keeps it.)

### Thresholds are only meaningful under a pinned load

The workload's memory scale is the **number of sessions driven**: measured ~5.2MB of peak RSS and
~148KiB of live set per session. The first version of the session leg started the next session as
soon as any in-flight one settled, which made that number a function of the *host*:

| Run | Sessions in 120s | Peak RSS | RSS slope | Verdict |
|---|---|---|---|---|
| `baseline-a` (unpinned) | 227 | 1247MiB | 6.42MB/s | green |
| `baseline-b` (unpinned) | 227 | 1285MiB | 6.51MB/s | green |
| a run on a faster host (unpinned) | **582** | **3024MiB** | **24.3MB/s** | red — on the RSS backstop, with a live set that was still workload-proportional (152.7MiB over 573 sessions = 260KiB/session) |
| `baseline-c` (pinned, 500ms) | 240 | 1321MiB | 7.43MB/s | green |

So the leg now starts sessions on a fixed 500ms interval with an 8-session concurrency cap, and
counts the ticks the cap swallows (`sessionStartsDeferred`). The offered load is the same number on
a fast host and a slow one, which is what makes a threshold derived from a baseline mean anything.

### Where the numbers come from

`node scripts/soak-analyze.mjs --calibrate --report <file>` reprints every observed slope, drift and
probe reading of any report, so the table can be re-derived from a fresh measurement instead of
re-guessed. The published thresholds and their multiples:

| Threshold | Value | Measured floor | Multiple |
|---|---|---|---|
| `rssBytesPerSecond` | 12582912 (12MiB/s) | 6.42 / 6.51 / 7.43MB/s (r² 0.90–0.91) | 1.69x the highest |
| `heapUsedBytesPerSecond` | 12582912 | 5.30 / 5.30 / 6.32MB/s (r² 0.95–0.98) | 1.99x the highest |
| `liveSetGrowthBytes` | 138412032 (132MiB) | +31.45 / +30.54 / +32.76MiB | 4.03x the largest |
| `liveSetBytesPerSession` | 524288 (512KiB) | 144.8 / 147.8KiB per session | 3.46x the measured |
| `fdCountResidual` | 16 | drift 7–12 | — |
| `childCountResidual` | 4 | drift 1–4 (unpinned: 10–12) | — |

The self-test is the control that keeps the whole table honest: `bash scripts/soak.sh --self-test`
runs the same sampler and the same analyzer against a stub that retains 32MiB/s (must read **red**,
naming RSS) and a steady stub (must read green). Without that pair, a harness that is green whatever
happens would pass every real run.

### Cleanup, and failure evidence

Every exit path — green, red, harness error, `Ctrl-C` — runs the same trap: session scopes owned by
**this** server's pid are stopped (they are transient units in the same slice, *not* children of the
server's unit, so stopping the unit would leave them behind), the soak unit is stopped and reset, and
the mock gateway is killed. Scopes are matched by the owner pid embedded in their name
(`claudecodeui-session-<ownerPid>-<suffix>`), so a scope belonging to the operator's own session is
never a candidate. The run's last line reports what it did:
`cleanup: stopped N session scope(s); unit=gone; scopes-of-this-server-left=0`.

A red run keeps its whole work directory (`--keep` does the same for a green one). The report at
`--report` carries the samples, the probes, the action counts and the verdict lines; a red run also
copies the last heap snapshot beside it and the tail of `server.log`, so the evidence for a failure
survives the cleanup.

### The slow-client hypothesis: a pair of runs, and where the instrument stops

The harness exists partly to answer one hypothesis: **does a websocket slow client make the server's
send buffer grow without bound?** The mechanism it names is real and unguarded — this path has no
`bufferedAmount` cap and no reaper — so the question is not whether the guard is missing but whether
*unread bytes* accumulate observably. One arm cannot answer it: "the wedged arm did not grow" is
equally consistent with "the server never wrote anything". So `--slow-client-drains` runs the
**control arm**: same socket, same hand-written handshake, same `chat.subscribe`, same window — the
only difference is that the bytes are read (the leg itself lives in `soak-driver.mjs`).

```bash
bash scripts/soak.sh --duration 120 --burst-mb 256 --report hyp.json
bash scripts/soak.sh --duration 120 --burst-mb 256 --slow-client-drains --report ctl.json
```

**Read the positive control first.** The control arm recorded `slowClientDrainedBytes=551,322,627`
(525.8MiB) against `slowClientBurstBytes=268,435,456` (256MiB): the server really did push the burst
to a subscriber. Without that number the pair proves nothing.

| Reading (whole run, 120s) | wedge arm (`drains=false`) | control arm (`drains=true`) |
|---|---|---|
| sessions created | 240 | 240 |
| samples / in-window | 34 / 23 | 34 / 23 |
| peak RSS / VmHWM | 2717.90 / 2717.90 MiB | 1846.51 / 1846.51 MiB |
| peak `heapUsed` | 2118.00 MiB | 584.00 MiB |
| peak cgroup `memory.current` | 2763.78 MiB | 1855.48 MiB |
| live set first→last | 58.56→46.58 MiB (−11.98) | 43.77→46.38 MiB (+2.61) |
| live nodes | 713,243→577,027 | 547,021→576,745 |
| slow-client window peak RSS | 2717.90 MiB | 1846.51 MiB |
| window RSS before → settled after | 276.47→818.18 MiB | 293.19→815.97 MiB |
| `slowClientDrainedBytes` | 0 | 551,322,627 |
| `closedBeforeDeadline` | false | false |
| verdict | green | green |

**The wedged arm is the higher one**, by **871.39MiB of peak RSS and 1534.00MiB of peak `heapUsed`**,
in a pair whose workload is identical: 240 sessions in both arms, same 500ms interval, same legs, same
`--burst-mb`, and 525.8MiB of drained bytes in the control proving the stream really moved. At this
scale the reading is **证实: unread bytes are retained while the subscriber is wedged.** It is also not
a leak — the settled live set 40s after the window is 818.18 vs 815.97MiB, and the wedge arm's live set
*shrank* (−11.98MiB) against a ~205MiB budget for the sessions added. The residency is the wedged
client's own backlog, released when the socket goes away.

That **reverses** the 48MiB reading this section used to carry (wedge 4348.63MiB, control
4727.91MiB — the wedged arm *lower*, i.e. indistinguishable above the churn), and the reversal has a
cause worth recording. With the burst marked onto **every third session** the burst *is* the workload:
both arms' peaks were then set by the same relay volume and the differential drowned in it — note that
those two arms managed only 156 and 174 sessions against a 500ms interval that allows 240, because the
multi-minute burst relays sat on the concurrency cap (`sessionStartsDeferred=150` at 512MiB). The burst
is the differential's subject and belongs on one session; `soak-driver.mjs` now says so, and the same
policy is what lets the run drive its full workload at a payload five times the old ceiling: 240
sessions at 256MiB with `sessionStartsDeferred=0`.

**Why the old verdict was bounded, and not "false, period".** The mock gateway **materialized** the
burst — one 4KiB string per delta event — before writing it, so the gateway was the first casualty of
a large `--burst-mb`. At `--burst-mb 512` it died of its own heap (`FATAL ERROR: Reached heap limit
Allocation failed - JavaScript heap out of memory`, 4095MiB), the server saw `ECONNREFUSED`, only 27
sessions ran, and the arm's residuals read red for scopes still in flight — a contaminated reading,
discarded. The largest drivable burst was therefore ~48MiB, and at 48MiB the raw RSS/heap series
already red on churn. The "unbounded" branch was **未能驱动** by the harness as it stood, for a cause
in the harness's burst materialization rather than in the server; that cause is now removed (next
paragraph), and the hypothesis is answered **证实** above.

**What the instrument's ceiling was, and what replaced it.** The mock gateway used to **materialize**
the burst, so the gateway itself was the first casualty of a large `--burst-mb`. It now produces the
reply frame by frame under the socket's backpressure (`replyFrames` + `streamReply` in
`soak-driver.mjs`), and its peak RSS no longer tracks the payload at all: **110MiB at `--burst-mb 256`
and 135MiB at `--burst-mb 512`**, both gateways alive for the whole run, with `<workdir>/mock.log` free
of both `Reached heap limit` and `out of memory`. The wire bytes are unchanged — same event names, same
order, same `JSON.stringify`, the same 4KiB text block, the same count — verified by diffing the
streamed reply against the develop build.

What stops the instrument now sits one layer down, at a **hard V8 limit in the server's protocol
path**. `--burst-mb 512` is 536,870,912 characters of reply text, and V8's maximum string length is
`2**29 − 24` = **536,870,888**: the payload overshoots it by 24 characters. The `claude` CLI aggregates
each assistant message into a single `stream-json` line on its stdout, and the server's `readline` over
that socket cannot hold the line —

```
RangeError: Invalid string length
    at [_normalWrite] [as _normalWrite] (node:internal/readline/interface:665:34)
    at Socket.ondata (node:internal/streams/readable:268:23)
```

— which is fatal to the server process and hits **both** arms at t≈42s (wedge `targetGoneAt=42.083`,
control `41.772`) after 43 sessions, so the 512MiB pair is reported on peaks and never on verdicts. No
harness change can lift this one: the bytes have to exist as one string somewhere between the CLI and
the server. **The largest drivable burst is therefore no longer ~48MiB — it is bounded by the protocol
rather than by the instrument, and it is bracketed to `(500MiB, 512MiB]`:** `--burst-mb 500` is
measured green end-to-end (240 sessions, 23 in-window samples, `ok: true`, gateway peak 139MiB, server
peak RSS 3946.80MiB), `--burst-mb 256` likewise (240 sessions, gateway peak 110MiB), and
`--burst-mb 512` is not drivable at all.

The same pair at `--burst-mb 512`, for corroboration: wedge peak RSS 1363.86MiB against control
778.17MiB (**+585.69MiB**), peak `heapUsed` 759.00 vs 267.00MiB (+492.00MiB), control
`slowClientDrainedBytes=565,651,542` (539.4MiB), `closedBeforeDeadline` false (wedge) vs true
(control). Same direction and same order of magnitude as the 256MiB pair, in runs cut short at t≈42s —
consistent with the mechanism: at 512MiB the wedged subscriber's backlog alone exceeds half a gigabyte.

Two things this pair *does* establish, independently of the differential:

- `closedBeforeDeadline=false` in every arm (4MiB / 48MiB / 256MiB / 512MiB, and the 30-minute run):
  within a 40–60s window the server never closes a subscriber that has stopped reading. No cap, no
  reaper — the mechanism the hypothesis names is present and unguarded. Its amplification is no longer
  undemonstrated: at 256MiB the wedged arm peaks 871.39MiB above the arm that read the same 525.8MiB,
  and at 512MiB it is 585.69MiB above before the protocol ceiling — not the server — ends the run.
- `--burst-mb` must exceed the kernel's absorption, or the leg tests nothing: this host's
  `net.ipv4.tcp_wmem` max is 4194304 and `net.core.wmem_max` is 212992, so a default 4MiB burst need
  never reach the server's user-space send queue at all. That is why the flag exists and why the
  script header says to raise it.

### The 30-minute reading, and what it says about the 2048MB heap default

`gap-server-unit-restart-heap-limit` gave the server unit `Restart=on-failure` plus a provisional
`--max-old-space-size=2048`, explicitly "待 soak 读数收紧". The reading has now arrived (one run,
`bash scripts/soak.sh --duration 1800`, real server, real CLI behind the mock gateway; log kept as
`dod-1800.log`, report `dod-1800-report.json`):

| Reading | Value |
|---|---|
| workload | 3371 sessions, 908,000 transcript lines, 178 searches, 651 normal ws closes / 658 half-open, 258 PTY opens+closes |
| peak RSS = peak VmHWM | 3270.01 MiB |
| peak `heapUsed` (uncapped) | **2146.00 MiB** |
| peak cgroup `memory.current` | 3498.60 MiB |
| live set first→last | 42.91→180.54 MiB (live nodes 533,220→2,273,082), 42.0 KiB/session against a 512 KiB/session allowance |
| slope readings | rss 0.91 MB/s (r² 0.63), heap 0.43 MB/s (r² 0.28), threads 0 |
| residuals after cooldown | fds 1/16, children 0/4, session scopes 0/1 |
| verdict | green |

**Conclusion: 2048MB is too tight for the workload this repo generates; suggested value 4096MB**
(`QUAY_SERVER_HEAP_MB` override and `off` unchanged). Uncapped, the 30-minute `heapUsed` high-water
was 2146.00MiB — 4.8% *above* the default. A cap below legitimate churn does not keep a leak from
growing the heap; it only converts the margin into GC pressure, so the server burns CPU collecting
and then restarts anyway. The cap's job is to make a runaway end in a restart rather than in host
swap (host RAM 246GB, swap already 14.7/16GB used), so the value belongs above real churn and far
below the host: 4096MB is 1.9x the measured high-water, 22.7x the measured live set (180.54MiB),
and ~1/60 of host RAM.

Three caveats, so the number is not over-read:

1. It is **one 1800s run of a synthetic workload** (the transcript leg writes a 105.1MB jsonl and
   re-reads it on every change, which is heavier than an operator session). A longer run could raise
   the high-water; treat 4096 as a floor with margin, not a derived optimum.
2. The reading is of an **uncapped** instance, so it is an upper bound on what a capped instance
   would allocate, not the amount it needs.
3. The decision belongs to that task, which is `done`; nothing here changes `scripts/serve-scoped.sh`
   (that task's Touches), and this section is where its DoD asked for the stance to be recorded.

By the same logic, the 30-minute run's *slopes* (0.91 and 0.43 MB/s, r² 0.63/0.28) are the wrong
instrument for choosing this value: a cap needs the high-water, and a trend cannot see a peak that
uncollected garbage already sets. The series are reported here for completeness, not as the basis.

## Second incident (2026-09-25 10:38–10:53) and what was retired

The machine thrashed for ~15 minutes (load average 4309) and the operator killed the node processes
by hand. Reconstructed from the user journal, because the processes were gone:

- Every OOM kill (36) landed in `quay-drivers-claudecodeui-*.scope`, the scope the quay drivers and
  all their workers ran in. It was started ad hoc with `systemd-run --user --scope … -p
  OOMPolicy=continue` and **no `MemoryMax`**, and it had no memory accounting, so there is no peak
  reading for it.
- The vitest scopes made by `with-memory-cap.sh` all finished normally before 10:38:31 (CPU 7–95 s).
  The cap was not the problem this time, and it had nothing to catch.
- Four workers were running heavy jobs at 10:35, one of them `scripts/suite-concurrency-check.sh`
  (the AC-103 criterion). That script oversubscribes by design — 2 full client vitest pools plus 2
  server-phase readouts — and called `npx vitest run` directly, bypassing the wrapper. Its own log
  recorded `load=3312` and readouts killed with `rc=137`.
- **Not proven:** which process held the memory. Nothing was left to measure. AC-103 is the strongest
  suspect, not a finding.

Decisions taken (human, 2026-09-25):

1. AC-103 is `superseded`, `GOAL-003`'s exit conditions no longer list it, and
   `scripts/suite-concurrency-check.sh` and its test are deleted (history keeps them).
   claudecodeui has no need to prove oversubscription tolerance; that capability belongs to quay's
   own concurrency tests. The criterion was also evaluated 24–61 times a day by the goal sweep.
2. The task `gap-ac103-worktree-state-drag-and-unbudgeted-confirm` is `superseded`. Its branch
   `task/gap-ac103-worktree-state-drag-and-unbudgeted-confirm` still carries 20 unmerged commits
   (voice false-forms readings narrowed to the run's own files, `__criterion-falsify-*` excluded from
   oxlint and tsc). They are independent of AC-103 and may be worth cherry-picking; nothing was deleted.
3. The quay loop gets a parent slice with a memory ceiling (next section).

## The per-project ceiling: `<project>.slice`

One ceiling over everything one project's quay loop starts. `systemd-run --scope` does **not** nest
under the caller's cgroup (a capped test scope lands in `app.slice`, not inside the driver's scope),
so a limit on the drivers' own scope would not count the tests they spawn. The shared parent has to
be a slice.

**The slice is named after the project, and is not shared across projects.** The default is
`<basename of the repo root>.slice` — `claudecodeui.slice` for this repo — so two projects get two
slices and two independent `memory.peak` readings. This replaced the old literal default (2026-10-10),
a name inherited from another, paused project. A slice name is global to the systemd
user manager, so a literal default made every checkout that ran this script share one ceiling *and*
one peak; that peak was measured at 54.99G once (past `MemoryHigh=48G`) with no way to say which
project caused it. An explicit `QUAY_MEMORY_SLICE` still overrides the derived name verbatim, so
pointing several projects at one ceiling stays possible — it just has to be asked for.

**A slice name is also a position in the cgroup tree.** systemd reads `a-b.slice` as a child of
`a.slice`, so a default that merely *began* with another project's prefix (e.g.
`<other>-<project>.slice`) would nest **inside** that project's slice instead of standing alone:
the outer slice's ceiling would apply and the inner one would be a child, not a peer.
`<basename of the repo root>.slice` cannot do that.

The unit file is created by the script on first use, from a template it carries: when
`~/.config/systemd/user/<project>.slice` is missing, `start-drivers-scoped.sh` writes it and runs
`systemctl --user daemon-reload`; systemd then loads the fragment and applies its limits — also when
the slice had already appeared as a runtime-only unit. A fresh machine therefore needs no hand-made
unit file. The numbers below are provisional: re-read the slice's own `memory.peak` after a day of
real use and re-set them.

| Piece | Where | What |
|---|---|---|
| `<project>.slice` | `~/.config/systemd/user/<project>.slice` (outside the repo; created by the script) | `MemoryHigh=48G` throttles first, `MemoryMax=64G` kills, `MemorySwapMax=0`; overridable with `QUAY_SLICE_MEMORY_HIGH` / `QUAY_SLICE_MEMORY_MAX` |
| `scripts/start-drivers-scoped.sh` | this repo | derives `--slice=<basename of the repo root>.slice`, creates the slice's unit file when it is missing, exports `QUAY_MEMORY_SLICE` and `QUAY_TEST_SYSTEMD_RUN_LIMITS`; refuses to start if the slice has no `MemoryMax` or drivers already run for this root |
| `scripts/with-memory-cap.sh` | this repo | honours `QUAY_MEMORY_SLICE`: each per-test scope keeps its own 24G cap **and** counts toward the project's ceiling |

### The full-suite runner's own scope: the 6G default

The ceiling above does **not** cover the full-suite runner, and the reason is the same non-nesting
rule that made a slice necessary in the first place. The runner (`plugin/scripts/full-suite-runner.*`)
wraps the whole suite in its own `systemd-run --user --scope`, created from inside the driver's
cgroup, so it lands in `app.slice` rather than in `<project>.slice` — that ceiling never backs
it, and the only thing bounding it is its own cap:

```js
var DEFAULT_SYSTEMD_RUN_LIMITS = { memoryMax: "6G", cpuQuota: "", tasksMax: "" };
```

6G is below what the suite needs, and the failure is silent in the way that matters. The server phase
runs **163** per-file `node --test` processes, **16** at a time (the clamp above), and several of the
heaviest spawn a real `claude` CLI — measured **306–433MB** RSS each on this host, against a
`6GiB / 16 = 384MiB` per-slot budget. When the scope is exhausted the kernel kills it, `test.sh`
prints `not ok - suite-watchdog: terminated by an external signal before the suite finished`, and
**no failing test file is named** — so the driver's attribution step reports "suite red could not be
attributed to any failing test file" and parks the task at `needs-human`. Since fan-in is the only
path by which a task can land, one cap stalls the whole board.

Read the witness, which is not the exit code: the scope unit reports `Result=oom-kill`, and the
runner writes its own cap to `.quay/suite-cgroup-evidence.txt`
(`limits_applied=1 memoryMax=6G`). Also check the run's `watchdog-trace.txt` — a real guard fire
leaves a `suite-watchdog: ABORT …` line, this kill does not.

`start-drivers-scoped.sh` therefore exports `QUAY_TEST_SYSTEMD_RUN_LIMITS` (default
`MemoryMax=24G`) beside `QUAY_MEMORY_SLICE`, so **both wrappers around the one suite agree**: 24G is
already what `scripts/with-memory-cap.sh` budgets for it (`QUAY_MEMORY_MAX`). It must be in the
**anchor's** environment, because the suite is spawned from the driver that inherits it — changing it
requires restarting the drivers, not just re-running a test.

The numbers are provisional. Read `memory.peak` of the slice after a day of real use and re-set them;
the largest single pane peak seen before this was 26G. The host is shared (kai, tom, vince, zhengji
run their own drivers), so lean low. Note the general rule about dashes: systemd reads a dash in a
slice name as a parent/child boundary, so a dashed name (the old one did) gets an implicit,
unlimited parent slice and its cgroup path reads `<parent>.slice/<slice>`. The derived name
introduces no dash for this repo, so `claudecodeui.slice` sits directly under `app.slice`.

The unit file lives in the user's home, not the repo, but the script creates it on first use (the
template in `start-drivers-scoped.sh` is the whole content), so a fresh machine needs nothing
hand-made. The script only writes when the file is missing, so an operator's hand-tuned file is
never overwritten. The script still fails loudly rather than starting uncapped when the slice has
no `MemoryMax`.

Verified (2026-09-25): the wrapper's scope lands under the slice; a scope whose own cap was 10G was
killed at a 300M ceiling set on a throwaway slice, so the parent ceiling binds children; the start
script refuses on a slice with no limit and on a missing plugin. Re-verified (2026-10-10, per-project
naming): the script itself created `claudecodeui.slice` with no hand-made file, a real
`with-memory-cap.sh` scope landed under it, and `systemctl --user show claudecodeui.slice -p MemoryMax
--value` read `68719476736`. **Still not verified:** a real driver run — that `start-drivers.js` and
the workers it spawns inherit `QUAY_MEMORY_SLICE` (workers are `claude` sessions, and env inheritance
through them was not checked). Confirm after the next start that `test.sh` scopes appear under
`claudecodeui.slice`.

## Running tests from a Claude session

A Claude session runs under its own cgroup with `MemoryMax=8GiB`
(`### Resident scopes: claude-session-scope.service.ts` above). `node --test` defaults its file
concurrency to `availableParallelism() - 1` — 127 on a 128-core host — so a bare multi-file
`--test` fan-out can exceed 8G and the kernel OOM-kills the **whole session**: 2026-10-06, a
34-file `tsx --test` invocation returned `Exit code 137` about 1.5s in, killing session
`db94ee35-…`. Pick the shape by how much you are about to run:

| What you are running | How |
|---|---|
| One or a few files | `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test <file…>` — a couple of processes stay inside 8G |
| Many files, a directory, or a glob | `bash scripts/with-memory-cap.sh … --test --test-concurrency=<N>` — the memory cap **and** the concurrency clamp are both required; either alone is not enough |
| This task's own acceptance | `bash scripts/test.sh --for-task <id>` |
| The full suite | Do **not** run it from a session — leave it to quay's fan-in. If you must, wrap it in `with-memory-cap.sh` |
| Experiments that launch Chromium/Playwright or a real server | Always `bash scripts/with-memory-cap.sh` |
| A long measurement that must outlive the session | A separate `systemd-run --user` service — and **pass the environment explicitly**: a service with no `DATABASE_PATH` makes two environment-dependent server tests fail spuriously |

`npm run test:server` and `npm run test:scripts` both follow the second row — each wraps its
runner in `with-memory-cap.sh` with `--test-concurrency=16` (the ceiling `scripts/test.sh` also
clamps to, and the only value with a measured wall-clock knee behind it).

### Not done: scripts/test.sh scopes its own server phase

Evaluated 2026-10-06 and deliberately not done; the reasoning is recorded so it is not re-litigated:

1. The fan-in path is already inside the runner's own scope **and** the project slice
   (`QUAY_TEST_SYSTEMD_RUN_LIMITS`, `MemoryMax=24G`) — it does not need another one.
2. Running `bash scripts/test.sh` in full **from a session** still hits the 8G session cap — that is
   a real risk, not a hypothetical one.
3. But wrapping `test.sh`'s server phase in another `systemd-run --scope` would let the fan-in suite
   escape the project slice's ceiling: `with-memory-cap.sh`'s own header notes a scope does **not** nest
   under the caller's cgroup, so the limit has to travel via `QUAY_MEMORY_SLICE`. It would also stack a
   second layer on top of the client phase's existing `QUAY_MEMORY_UNIT` + journal OOM attribution.
4. `scripts/test.sh` is being changed by
   `gap-suite-server-dispatch-longest-first-and-parallel-static-stages`; this task does not touch it.

**Re-evaluation trigger:** once (1) and (2) above have landed, if the journal shows another
`claudecodeui-session-*.scope … oom-kill` whose killed session's last command contains
`scripts/test.sh`, file a new task (direction: wrap once at the entry point only, thread
`QUAY_MEMORY_SLICE` through, and skip when already inside a limited scope).

