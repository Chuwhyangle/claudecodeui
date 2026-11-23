/**
 * The MCP gateway's tool annotations (AC1–AC7): the ONE place a
 * `tools/list` annotation is written down.
 *
 * MCP annotations are DECLARATIVE METADATA. They are not authorization: the
 * scopes on a tool's registration are the only thing that decides whether a call
 * runs. A host (ChatGPT's custom-MCP / developer mode, Claude Code, …) reads
 * these hints to decide whether to ask the user for per-call confirmation, and
 * the whole point of auditing them is to remove UNNECESSARY confirmations by
 * making the hints accurate — never by labelling a write as read-only or
 * non-destructive. A wrong `readOnlyHint: true` on a mutating tool would be a
 * correctness bug that silences a confirmation prompt, so the rules below lean
 * conservative on every hint whose meaning is "this can go wrong".
 *
 * ## The four hints, and the rule each is read by here
 *
 *  - `readOnlyHint` (spec default `false`): true only when the handler mutates
 *    no stored/domain state.
 *  - `destructiveHint` (spec default `true`, meaningful only when
 *    `readOnlyHint === false`): true when the call can discard or terminate
 *    work that already exists. An ambiguous write is marked destructive rather
 *    than non-destructive — over-labelling costs an extra confirmation, under-
 *    labelling is the bug this task exists to prevent.
 *  - `idempotentHint` (spec default `false`): true when a repeat of the call
 *    with the same arguments, against the same state, has no further effect.
 *    Set true only where that reading is pinned by the handler's own documented
 *    behaviour; otherwise left false (the spec default).
 *  - `openWorldHint` (spec default `true`): true when the tool's effect is
 *    delivered OUTSIDE this server's own store — it drives, starts, stops or
 *    authorizes a provider agent/process. False for tools confined to Cloudpit's
 *    stored state (its database, its lease table, its queue, its cached
 *    snapshot).
 *
 * ## AC1 — the audit table
 *
 * Every tool reachable on `tools/list`, its annotations before this task (there
 * were none — the gateway passed no `annotations` at all), and the annotations
 * declared now, with the handler fact each value rests on:
 *
 * | tool                  | before | readOnly | destructive | idempotent | openWorld | why |
 * |-----------------------|--------|----------|-------------|------------|-----------|-----|
 * | `overview`            | none   | true     | false       | true       | false     | reads the local overview + cached snapshot |
 * | `projects_list`       | none   | true     | false       | true       | false     | reads the project table |
 * | `sessions_list`       | none   | true     | false       | true       | false     | reads the session table |
 * | `session_get`         | none   | true     | false       | true       | false     | reads one session + its host snapshot |
 * | `session_read`        | none   | true     | false       | true       | false     | reads a transcript |
 * | `run_get`             | none   | true     | false       | true       | false     | reads the run registry; waiting does not mutate |
 * | `quay_snapshot`       | none   | true     | false       | true       | false     | reads the quay store; `refresh` only repopulates a derived cache |
 * | `ui_last_opened_session`| none | true     | false       | true       | false     | reads the browser's last-opened pointer; the write is the browser's own route |
 * | `ui_visible_context`  | none   | true     | false       | true       | false     | asks the browsers what they show; nothing stored, no state mutated |
 * | `ui_clients_list`     | none   | true     | false       | true       | false     | lists the connected browsers and their status; nothing stored, no state mutated |
 * | `session_search`      | none   | true     | false       | true       | false     | scans stored transcripts and titles; nothing stored, no state mutated |
 * | `ui_selected_text`    | none   | true     | false       | true       | false     | reads the transcript selection the browsers report; nothing stored, no state mutated |
 * | `session_send`        | none   | false    | false       | false      | true      | additive: queues/sends a message, starts a run; two sends are two turns |
 * | `session_create`      | none   | false    | false       | false      | true      | additive: mints a session (and may start its first run); two creates are two sessions |
 * | `session_interrupt`   | none   | false    | true        | false      | true      | terminates the run in flight; the work it held is lost |
 * | `session_start`       | none   | false    | false       | true       | true      | launches the resident host; "already running is a success" |
 * | `session_close`       | none   | false    | true        | false      | true      | terminates the resident host; its leases are gone and are not recovered |
 * | `ui_open_session`     | none   | false    | false       | true       | false     | asks ONE browser to open a session; discards nothing and drives no provider agent |
 * | `session_cancel_queued`| none  | false    | true        | true       | false     | withdraws a queued message irreversibly; a repeat finds it gone |
 * | `session_reconfigure` | none   | false    | false       | true       | false     | writes a stored preference; repeating the same value is a no-op |
 * | `session_background`  | none   | false    | true        | false      | true      | its `stopTaskId` branch stops a held task (the list branch alone is a read) |
 * | `approvals_list`      | none   | true     | false       | true       | false     | reads the pending-approval set |
 * | `approval_answer`     | none   | false    | false       | false      | true      | authorizes a pending agent action; a re-answer finds nothing pending |
 * | `draft_get`           | none   | true     | false       | true       | false     | reads the caller's unsent composer text; nothing stored, no state mutated |
 * | `draft_set`           | none   | false    | true        | true       | false     | replaces the unsent composer text, discarding what was there; same text twice is one state |
 * | `draft_submit`        | none   | false    | false       | false      | true      | sends the draft as a real turn through the composer's own path; the text is delivered, not discarded |
 * | `session_steer`       | none   | false    | true        | false      | true      | rewrites the turn in flight; its original input is superseded |
 * | `project_create`      | none   | false    | false       | true       | false     | additive: registers a directory as a project; a repeat answers the same id |
 *
 * AC6 (metadata only, enforcement untouched) is discharged by the shape of the
 * change: the only edits are this table, the optional `annotations` field the
 * audit wrapper forwards to `registerTool`, and the one call site that reads a
 * name off this table. No scope, no `requiredScopes`, no principal check and no
 * handler body is touched — `withMcpAudit` still decides `denied`/`ok`/`error`
 * from `requiredScopes` alone.
 *
 * Consumers: `mcp-gateway.transport.ts` (whose one `audited` seam attaches
 * {@link readMcpToolAnnotations} to every registration) and this module's
 * criterion, which drives a real mount and compares `tools/list` against
 * {@link MCP_TOOL_ANNOTATIONS}.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import type { McpStage3ReadToolName } from './tools/read/mcp-gateway.read-tools.js';
import type { McpStage6ResidentToolName } from './mcp-gateway.resident-tools.js';
import type { McpStage4WriteToolName } from './mcp-gateway.write-tools.js';
import type { McpCockpitToolName } from './tools/cockpit/mcp-cockpit-tools.js';
import type { McpGoalToolName } from './tools/goals/mcp-goal-tools.js';

/**
 * Every tool name the gateway can register, derived from the three tables so a
 * name can never exist in a table but be missing here (a miss is a compile
 * error on the {@link MCP_TOOL_ANNOTATIONS} record), plus the tools that register
 * alongside their table rather than in it: `session_reconfigure` (AC-272),
 * `session_background` (AC-273), `approvals_list` / `approval_answer` (AC-274)
 * and `ui_open_session` (gap-mcp-ui-open-session, registered next to
 * `MCP_STAGE4_WRITE_TOOLS`).
 */
export type McpGatewayToolName =
  | McpStage3ReadToolName
  | McpStage4WriteToolName
  | McpStage6ResidentToolName
  | 'session_reconfigure'
  | 'session_background'
  | 'approvals_list'
  | 'approval_answer'
  // gap-mcp-ui-open-session: registered alongside `MCP_STAGE4_WRITE_TOOLS` (it
  // is the sixth write tool but not one of AC-249's five), so it is named here.
  | 'ui_open_session'
  // gap-mcp-ui-focus-turn-show-diff-open-task: three more navigation tools with
  // the SAME annotation profile as `ui_open_session` — each asks one browser to
  // reveal a turn / a diff / a task, discards nothing, drives no provider agent,
  // and is idempotent (repeating it reaches the same screen state).
  | 'ui_focus_turn'
  | 'ui_show_diff'
  | 'ui_open_task'
  // gap-mcp-draft-get-set-submit: the three composer-draft tools, registered
  // alongside the read/write tables rather than in them (the read verb and the
  // two write verbs carry different scopes, so they cannot share one row of
  // either table).
  | 'draft_get'
  | 'draft_set'
  | 'draft_submit'
  // knowledge-application-fact-contract: `knowledge_facts` is registered
  // alongside the stage-3 read table through its own deps bag (the table is the
  // frozen AC-245 read set), so it is named here. It READS stored session rows,
  // the process host table, the chat-run registry and the context-event stream —
  // it mutates nothing, drives no provider agent, and a repeat reads the same
  // fact.
  | 'knowledge_facts'
  // gap-mcp-session-steer-tool: `session_steer`, registered alongside the five
  // AC-249 write tools (it is not one of them) under the write table's
  // `cloudcli:session:control` scope, so it is named here.
  | 'session_steer'
  // gap-mcp-project-create-tool: `project_create`, registered alongside the five
  // AC-249 write tools (it is not one of them) under `cloudcli:session:create`,
  // so it is named here.
  | 'project_create'
  // gap-mcp-cockpit-card-tools: the cockpit's four tools, registered through
  // their own deps bag (`McpGatewayDeps.cockpitTools`) rather than by growing a
  // tool table — the three reads share `cloudcli:read` while the confirm carries
  // its own scope, so they cannot share a table row either.
  | McpCockpitToolName
  // Cloudpit's OWN goal loop (distinct from the read-only `QuayGoal*`). The nine
  // `goal_*` tools register through their own deps bag (`McpGatewayDeps.goalTools`)
  // rather than by growing a tool table, so their names are derived here.
  | McpGoalToolName;

/**
 * The annotation every registered tool declares, keyed by tool name.
 *
 * All four hints are stated on every row — an absent hint falls back to the
 * spec default (`destructiveHint: true`, `openWorldHint: true`, everything else
 * false), and leaving a hint absent would make a read tool inherit the
 * write-leaning defaults. The record is TOTAL over {@link McpGatewayToolName},
 * so a tool added to any of the three tables without a row here fails to
 * compile rather than shipping with no annotations.
 */
export const MCP_TOOL_ANNOTATIONS: Record<McpGatewayToolName, ToolAnnotations> = {
  // -- stage-3 read tools: no mutation, closed world ------------------------
  overview: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  projects_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  sessions_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  session_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  session_read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  quay_snapshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // reads the browser's last-opened-session pointer; the pointer's WRITE is the
  // browser's own route, so an MCP call mutates nothing.
  ui_last_opened_session: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // asks the connected browsers what they are showing and reads their answers:
  // nothing is stored, and a repeat with no browser state change reads the same
  // fact. The question reaches the browsers, but it drives no provider agent and
  // mutates no Cloudpit state, so the world stays closed.
  ui_visible_context: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // lists the connected browsers and status, reading their answers to one
  // round-trip question: nothing is stored, and a repeat with no browser state
  // change reads the same roster. The question reaches the browsers, but it
  // drives no provider agent and mutates no Cloudpit state, so the world stays
  // closed — the same reading `ui_visible_context` above carries.
  ui_clients_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // scans the stored provider transcripts and titles and reads nothing else:
  // nothing is stored, and a repeat over an unchanged store reads the same
  // matches. The scan touches files on disk, but it drives no provider agent and
  // mutates no Cloudpit state, so the world stays closed.
  session_search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // reads the user's transcript SELECTION through the same browser round trip as
  // `ui_visible_context`: nothing is stored, and a repeat with no browser state
  // change reads the same text. Reading is not mutating, so the hints read the
  // same as its non-content sibling — the registration's `cloudcli:selection`
  // gate is what limits WHO may read it, not this annotation.
  ui_selected_text: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // gap-mcp-usage-stats: aggregates the caller's OWN audit rows with a SQL read
  // and stores nothing; a repeat over an unchanged log reads the same counters,
  // so the world stays closed and the reading is idempotent.
  mcp_usage_stats: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // gap-mcp-changes-on-demand-event-stream (AC-335): reads the watcher database,
  // the in-memory run/approval state and the Quay CACHE, and mutates nothing —
  // not even the cache (a cold cache is reported as a gap, never filled). It is
  // idempotent for the same cursor: the same read repeats the same events and
  // stores nothing, so the world stays closed.
  changes: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  // -- stage-4 write tools ---------------------------------------------------
  // additive: a message is queued/sent and a run starts; nothing is discarded.
  session_send: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // additive: a new session row; a repeat is a second session, never a no-op.
  session_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // terminates the run in flight — the work it was doing is lost.
  session_interrupt: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // launches the resident host; already-running is a documented success, so a
  // repeat adds nothing.
  session_start: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // terminates the resident host; the manager clears its leases on teardown and
  // they are not recovered, so the close is irreversible.
  session_close: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // asks ONE browser to open a session. It discards nothing (a declined or
  // ignored prompt leaves the world as it was) and drives no provider agent: the
  // effect is confined to THIS server's own connected clients, so the world stays
  // closed. Idempotent: asking twice for the same session reaches the same screen
  // state, and the log's second record supersedes the first rather than
  // accumulating a second effect.
  ui_open_session: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // gap-mcp-ui-focus-turn-show-diff-open-task: the same profile as
  // `ui_open_session` — a reveal discards nothing, drives no provider agent, and
  // asking twice for the same target reaches the same screen state.
  ui_focus_turn: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ui_show_diff: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ui_open_task: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  // -- stage-6 resident tools ------------------------------------------------
  // withdraws a queued message; the text is gone and cannot be restored, while a
  // repeat finds the uuid absent — irreversible, but no further effect.
  session_cancel_queued: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // writes a stored preference; the same value written twice is one state, and
  // the live-apply pass only reaches an already-running local process.
  session_reconfigure: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // lists held work without a `stopTaskId`, but STOPS one with it — the tool is
  // marked for what it can do, so the stop branch makes it destructive.
  session_background: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // reads the pending-approval set.
  approvals_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // authorizes a pending agent action; a second answer finds nothing pending.
  approval_answer: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

  // -- composer-draft tools (gap-mcp-draft-get-set-submit) --------------------
  // reads the caller's own unsent composer text out of the session_drafts store;
  // nothing is stored and a repeat over an unchanged store reads the same text.
  draft_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // knowledge-application-fact-contract: reads stored session rows, the live
  // host table, the run registry and the context-event stream; it writes none of
  // them, asks no browser and starts no provider process, and a repeat over an
  // unchanged store reads the same fact.
  knowledge_facts: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // replaces that stored text. It discards the user's unsent draft — text they
  // produced and nothing can restore — so it is marked destructive (the
  // conservative side: an extra confirmation costs a prompt, a missing one loses
  // text). A repeat with the same text reaches the same state, so idempotent.
  draft_set: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // hands the draft to the session as a real turn through the same send path a
  // human uses: additive (the text is delivered, not discarded) and the world
  // opens — a provider agent starts. A repeat finds the draft cleared and is
  // refused rather than adding a second turn, so it is not idempotent.
  draft_submit: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

  // -- resident steer tool (gap-mcp-session-steer-tool) -----------------------
  // Rewrites the turn a session already has in flight: the input that turn was
  // running on is superseded and the provider agent's current work is redirected,
  // so the reading is destructive (the conservative side — an extra confirmation
  // costs a prompt, a missing one discards direction the caller may not have
  // meant to drop). It opens the world: the steered turn runs in a provider
  // process. Not idempotent: a second steer is a second rewrite of whatever is
  // in flight at that moment, not a no-op.
  session_steer: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },

  // -- project registration tool (gap-mcp-project-create-tool) ---------------
  // Registers a directory as a project: a new row (or a reactivated archived
  // one) is ADDITIVE — nothing existing is discarded, and it drives no provider
  // agent, so the world stays closed (the effect is this server's own store plus
  // `mkdir -p` of the directory the caller named). Idempotent: the same path
  // answers the same projectId with `created: false` / `outcome: 'existing'`
  // rather than a second row, which is the handler's documented reading.
  project_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  // -- cockpit card tools (gap-mcp-cockpit-card-tools) ------------------------
  // The three reads answer from the card registry (and, for the brief, the card
  // brief service): nothing is stored by the call itself, and a repeat over an
  // unchanged registry reads the same cards. `cockpit_card_brief` may run the
  // brief service, whose cache/ledger are the service's own derived state — the
  // same reading `quay_snapshot`'s refresh carries, so it stays a read.
  cockpit_cards: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cockpit_card: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cockpit_card_brief: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Confirming runs the option's DECLARED executor, a generic dispatcher that
  // can send into a session, start one, or apply a fleet disposal (which can
  // park/hold work) — so the world opens and the call is marked destructive:
  // the conservative side, where an extra confirmation costs a prompt and a
  // missing one loses work. A repeat of the same (card, revision) finds the
  // accepted ledger and executes nothing further, so it is idempotent.
  cockpit_card_confirm: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },

  // -- goal tools (Cloudpit's own goal loop) ---------------------------------
  // The two reads answer from the goals store; nothing is mutated, and a repeat
  // over an unchanged store reads the same rows, so the world stays closed.
  goal_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  goal_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Additive: a new draft goal row; a repeat is a second goal, never a no-op. It
  // drives no provider agent — the effect is this server's own store.
  goal_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // Additive: appends one acceptance criterion to a draft goal; a repeat adds a
  // second AC. Stored state only.
  goal_add_ac: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // Activation creates the goal worktree and the bound session and RUNS every
  // criterion once (red-first): the criteria are arbitrary shell commands and a
  // session is started for a provider agent, so the world opens. Nothing existing
  // is discarded — the goal was a draft — so it is not destructive.
  goal_activate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // Flips a running goal to paused; a repeat finds it paused (the driver opens no
  // further round), so the second call has no further effect. Works on this
  // server's store alone.
  goal_pause: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Flips a paused/stalled goal back to active AND restarts its wall clock, so
  // repeating it against a goal it already resumed is refused rather than a
  // no-op. Stored state only.
  goal_resume: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // Ends a goal that is not already achieved/abandoned: the loop's remaining work
  // is discarded (the worktree is left in place), so it is destructive. A repeat
  // is refused, not a no-op. Stored state only.
  goal_abandon: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // Runs one round: every active criterion executes as an arbitrary shell command
  // in the goal worktree, and an all-green round MERGES the goal branch into the
  // project checkout. The world opens (processes run, a branch lands) and the
  // merge can rewrite the main worktree, so it is marked destructive — the
  // conservative side.
  goal_run_round: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

/**
 * The annotations one tool declares, by name.
 *
 * THROWS on a name with no row rather than answering `undefined`: the transport's
 * one registration seam calls this for every tool, so a tool registered without
 * annotations is a wiring bug that must surface at mount time, not a silent
 * omission on the wire. The record is total over {@link McpGatewayToolName}, so
 * the only way to reach the throw is a name that is not a gateway tool at all.
 *
 * Consumers: `mcp-gateway.transport.ts`'s `audited` helper (the single call
 * site), and this module's criterion, which reads a name back to prove the
 * lookup and the table agree.
 */
export function readMcpToolAnnotations(tool: string): ToolAnnotations {
  const annotations = MCP_TOOL_ANNOTATIONS[tool as McpGatewayToolName];
  if (annotations === undefined) {
    throw new Error(`No MCP tool annotations are declared for tool "${tool}".`);
  }
  return annotations;
}
