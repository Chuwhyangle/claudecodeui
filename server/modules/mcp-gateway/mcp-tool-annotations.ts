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
 *    authorizes a provider agent/process. False for tools confined to CloudCLI's
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

import type { McpStage3ReadToolName } from './mcp-gateway.read-tools.js';
import type { McpStage6ResidentToolName } from './mcp-gateway.resident-tools.js';
import type { McpStage4WriteToolName } from './mcp-gateway.write-tools.js';

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
  | 'ui_open_session';

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
  // mutates no CloudCLI state, so the world stays closed.
  ui_visible_context: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // lists the connected browsers and status, reading their answers to one
  // round-trip question: nothing is stored, and a repeat with no browser state
  // change reads the same roster. The question reaches the browsers, but it
  // drives no provider agent and mutates no CloudCLI state, so the world stays
  // closed — the same reading `ui_visible_context` above carries.
  ui_clients_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // scans the stored provider transcripts and titles and reads nothing else:
  // nothing is stored, and a repeat over an unchanged store reads the same
  // matches. The scan touches files on disk, but it drives no provider agent and
  // mutates no CloudCLI state, so the world stays closed.
  session_search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // reads the user's transcript SELECTION through the same browser round trip as
  // `ui_visible_context`: nothing is stored, and a repeat with no browser state
  // change reads the same text. Reading is not mutating, so the hints read the
  // same as its non-content sibling — the registration's `cloudcli:selection`
  // gate is what limits WHO may read it, not this annotation.
  ui_selected_text: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

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
