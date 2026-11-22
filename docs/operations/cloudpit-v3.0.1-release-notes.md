# Cloudpit v3.0.1 — release notes

v3.0.1 is a patch release on top of [v3.0.0](./cloudpit-v3.0-release-notes.md).
It carries **no breaking changes and no data migration**: the identity contract
(`CLOUDPIT_*`, `~/.cloudpit`, `cloudpit://`, `cloudpit` MCP server name) is
unchanged, and an existing 3.0.0 install upgrades in place.

## Highlights

### Codex providers

- The model menus now offer **model × provider identities** — a `(provider)`
  variant per bound provider — in the composer model menu, the new-session
  model selector and the model library (AC-468/AC-469/AC-470). The explicit
  `modelProviderId` travels with the session write path.
- A provider's variants are expanded from **that provider's own model list**;
  the Codex settings page explains the suffix semantics and reports
  `built-in · N provider variants` from the live registry reading.
- The advanced Codex provider form gained a **connection-test button**.
- Pressing **Bind** on an imported Codex profile now also selects that
  provider in the model editor, so the same provider no longer has to be
  chosen twice before saving a model.
- Resident sessions: `model_provider` is injected on a cold start, attachments
  are retained in resident input, and edit-rewind / session-fork follow the
  session's recorded provider instead of the process default.

### Cockpit

- Molten short-loop decisions are rendered as a dedicated
  **`molten-decision`** card: its own badge/tone/label, and exactly three
  contract decisions (`crystallize-task`, `decline`, `modify`) routed to the
  `fleet.molten-decide` executor.
- A provider whose usable batch is incomplete is warned about, and a failed
  provider renders as a **degraded wall** rather than an empty one.

### MCP

- New **`project_create`** tool: register a directory as a Cloudpit project
  from any MCP client, reusing the same project-management service as the UI's
  create-project route (path validation, `mkdir -p`, persistence). It is
  idempotent — a repeat with the same path answers the same `projectId` with
  `created:false` — and is registered alongside the existing write tools
  through optional deps, so a gateway mount without it keeps its exact
  `tools/list`.

### UI

- Transcript selection now uses a **floating action**; the inline quote chip is
  retired, and the live selection stays out of the composer strip.
- The composer **token chip** shows the latest request for every provider, not
  only the default one.
- Markdown blocks stay mounted across `replyItems` identity changes, so a
  streaming reply no longer remounts rendered blocks.
- A sidebar project row now **collapses on the first click**.

### Voice

- A **user VAD switch** in the menu and settings, with a capped no-VAD
  splitter.
- A transient upstream refusal is retried instead of dropping the dictation,
  and a named refusal code outranks a generic gateway status in the reported
  error.

### Architecture view

- Semantic arrowheads are rigid and pinned to their own end, so an edge keeps
  its direction while the layout moves.

### Quay integration

- The snapshot task read is compact and no longer caches partial reads; the
  driver-status ceiling is wider. Contract home-guard checks exempt the
  resident service log and atomic-write temporaries.

## Internal maintenance

Nothing below changes a public API or a user-facing file format.

- God-package splits: observation (`core` / `session-digest` / `session-ask` /
  `producers`), Claude resident host (`lifecycle/`), cockpit (`brief` /
  `cards` / `fleet`), Codex provider (`app-server` / `host` / `sessions`),
  provider services (`runtime` / `sessions` / `claude-activity`), `src/shared`
  (`api` / `settings` / `voice` / `voice-asr`), `server/shared` domain
  subpackages, architecture (`render` / `layout` / `dom`), MCP gateway tools
  (`tools/<family>`), voice-realtime WS proxy (`frames` / `transport`).
- One URI grammar for observation links lives in `shared/` and is re-exported
  on both sides.
- Test harness: O(n+m) server dispatch in `scripts/test.sh`, and the suite's
  concurrency is capped to a host share.

## Upgrade

- npm: `npm install -g @yalehwang/cloudpit@3.0.1`, or
  `npx @yalehwang/cloudpit@3.0.1`.
- Desktop: install the v3.0.1 Windows package. It has the same
  `ai.cloudpit.desktop` identity as 3.0.0, so it upgrades the existing
  installation; no identity migration runs again.
- Local runtime: the desktop app downloads
  `cloudpit-local-server-v3.0.1-*` on demand.
- Data: no migration and no cleanup. `~/.cloudpit`, the settings file and the
  attachment roots are read exactly as 3.0.0 left them. The 3.0.0 upgrade path
  (2.x pass, service-worker caches, token ageing) is unchanged and documented in
  [the v3.0 notes](./cloudpit-v3.0-release-notes.md#upgrade-path-2x-is-mandatory-data-is-never-deleted).

## Distribution

- npm: `@yalehwang/cloudpit@3.0.1`, dist-tag `latest`.
- GitHub Release `v3.0.1` / **Cloudpit v3.0.1**, with the Windows installer
  (`cloudpit-desktop-3.0.1-win-x64.exe`), its checksum
  (`SHASUMS256-windows.txt`) and the local-server runtime
  (`cloudpit-local-server-v3.0.1-win-x64.tar.gz` + `.sha256`).
- Only Windows desktop builds are published; there is no macOS or Linux
  package.
- Verification: `GITHUB_TOKEN="$(gh auth token)" node
  scripts/cloudpit-distribution-check.mjs --release --version 3.0.1 --json`
  must exit 0 with `violations: []`; the checker's default version is now
  3.0.1, and historical releases remain readable via an explicit `--version`.
- Verification evidence: the post-release reading is retained in
  [`docs/evidence/cloudpit-v3.0.1-distribution-check.txt`](../evidence/cloudpit-v3.0.1-distribution-check.txt)
  (command, capture time, exit code and the exact `--json` output).
