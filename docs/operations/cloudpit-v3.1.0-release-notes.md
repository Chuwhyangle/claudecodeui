# Cloudpit v3.1.0 — release notes

v3.1.0 is a minor release on top of [v3.0.1](./cloudpit-v3.0.1-release-notes.md).
It carries **no breaking changes and no data migration**: the identity contract
(`CLOUDPIT_*`, `~/.cloudpit`, `cloudpit://`, `cloudpit` MCP server name) is
unchanged, and an existing 3.0.1 install upgrades in place.

## Highlights

### Reply suggestions

- The composer's draft rewrite now receives the **last assistant turn and the
  user turn before it** (role-labeled, tail-bounded to 4,000 characters), so
  pronouns, omitted objects and homophones can be resolved without inventing
  facts. A missing session, an unbound reader, or a reader failure degrades to
  a draft-only rewrite.
- Rewrites now target a **self-contained technical request** rather than a
  faithful cleanup: deictic references to the conversation are forbidden, the
  concrete object must come from context, and a clause that cannot be resolved
  without guessing is dropped instead of being replaced by an invented action.
- **Fact preservation (prompt v5b.2)**: the rewrite inventories the user's
  factual claims (measurements, observations, symptoms, reproduction steps,
  numbers, units, paths, versions, error messages, IDs, names) and verifies the
  rewrite still contains each one; code, expressions, numbers, IDs and paths
  are copied verbatim.
- An **opt-in local debug ledger** writes one JSONL line per attempt to
  `~/.cloudpit/reply-suggestions-debug.jsonl` (0600, 2 MB with `.1`/`.2`/`.3`
  rotation). It records the draft and candidate, never the key, base URL or
  prompt text.
- Automatic draw failures and misconfigured settings no longer render an inline
  composer notice; a manual Suggest failure keeps the existing three-second
  control state. The controller's failure reading, ledger and
  **Settings → Diagnostics** card remain unchanged.

### Diagnostics and logs

- A bounded, append-time-redacted **process-local log ring** is fed by a
  console tee and exposed through two read-only `/api/diagnostics/logs` routes
  and a shared log-drawer port.
- The **global log drawer** (desktop panel / phone sheet) supports source,
  level and requestId filters, follow/load-earlier, and copy-bundle. The
  composer failure notice, diagnostics health cards and Settings tab open it
  through the same port and hide the entry when no host is mounted.
- **Settings → Diagnostics & logs** adds feature health, recent failures and a
  redacted bundle (`/api/diagnostics/features`, `/recent-failures`,
  `/bundle`). Every string is redacted server-side (keys, bearer headers,
  API-key assignments).
- A console line that reports a failed outcome is escalated for the drawer's
  error filter; warn/error lines are untouched.

### Performance

- Non-resident routes and heavy side entries were split out of the first
  chunk: the client entry went from **4,563.55 kB / 1,353.00 kB gzip** to
  **3,434.75 kB / 1,058.84 kB gzip** (−24.7% raw, −21.7% gzip). Prism, Mermaid,
  math plugins, the architecture page, settings and workspace side tabs now
  load as separate chunks.
- Persistent timers in the app shell are paused while the tab is hidden through
  one shared `usePageVisibility` reading (elapsed clock, schedule countdown,
  session-task poll, lifecycle-mode poll, queued-draft reconcile, local clock,
  fleet landing poll).
- The sidebar project list mounts a **bounded 50-row window** (selected and
  expanded rows pinned) with a “Show all projects” control; an active name
  filter still bypasses the window.
- Live-turn animations no longer re-blur the sidebar on every frame: measured
  on a running session, CPU went from 55–60% of one core to ~15%, and the GPU
  process from 31–36% to ~8%.

### Other fixes

- The MCP `initialize` handshake now advertises **`cloudpit-mcp-gateway`** and
  the package version instead of `claudecodeui-mcp-gateway` / `0.1.0`.
- A resident pending row is now retired by the **persisted turn's prefix**, so
  a capped live delivery no longer leaves a truncated duplicate user bubble
  beside the full persisted row.
- Voice TTS and the browser narrator share one byte-merge helper; the
  architecture minimap is repointed at the split layout/engine package.

## Internal maintenance

- God-package splits: websocket services (`transport` / `dispatch` / `ui`),
  quay (`cli` / `fleet` / `read` / `service` / `task`), database repositories
  (`sessions` / `auth` / `notifications` / `observation` / `providers`),
  architecture (`render` / `dom` / `layout` / `engine`), voice-realtime
  connection/TTS leaves, and providers / chat-composer / settings / notices /
  ASR leaves.
- Reply-suggestions logging and failure mapping were deduplicated; the notices
  severity rank table and comparator are shared.
- Test fixtures and locale digests were re-pinned after the split.

## Upgrade

- npm: `npm install -g @yalehwang/cloudpit@3.1.0`, or
  `npx @yalehwang/cloudpit@3.1.0`.
- Desktop: install the v3.1.0 Windows package. It has the same
  `ai.cloudpit.desktop` identity as 3.0.x, so it upgrades the existing
  installation; no identity migration runs again.
- Local runtime: the desktop app downloads
  `cloudpit-local-server-v3.1.0-*` on demand.
- Data: no migration and no cleanup. `~/.cloudpit`, the settings file and the
  attachment roots are read exactly as 3.0.1 left them. The 3.0 upgrade path
  (2.x pass, service-worker caches, token ageing) is unchanged and documented
  in [the v3.0 notes](./cloudpit-v3.0-release-notes.md#upgrade-path-2x-is-mandatory-data-is-never-deleted).
- Only Windows desktop builds are published; there is no macOS or Linux
  package.

## Distribution

- npm: `@yalehwang/cloudpit@3.1.0`, dist-tag `latest`.
- GitHub Release `v3.1.0` / **Cloudpit v3.1.0**, with the Windows installer
  (`cloudpit-desktop-3.1.0-win-x64.exe`), its checksum
  (`SHASUMS256-windows.txt`) and the local-server runtime
  (`cloudpit-local-server-v3.1.0-win-x64.tar.gz` + `.sha256`).
- Verification: `GITHUB_TOKEN="$(gh auth token)" node
  scripts/cloudpit-distribution-check.mjs --release --version 3.1.0 --json`
  must exit 0 with `violations: []`; the checker's default version is now
  3.1.0, and historical releases remain readable via an explicit `--version`.
- Verification evidence: the post-release reading is retained at
  [`docs/evidence/cloudpit-v3.1.0-distribution-check.txt`](../evidence/cloudpit-v3.1.0-distribution-check.txt)
  (command, capture time, exit code and the exact `--json` output); the file is
  committed after the release run.
