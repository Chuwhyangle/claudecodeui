/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { ChatMessage,NormalizedMessage,SubagentActivity } from '@/shared/types';
import { formatUsageLimitText } from '@/modules/chat/utils/transcript/chatFormatting';
import { isLiveRowId } from '@/modules/chat/utils/transcript/liveRowIdentity';

/**
 * The `ChatMessage.type` of the divider that introduces a turn nobody typed.
 *
 * Declared beside the projection that mints the row, because the row exists only
 * as this projection's output: the renderer reads the type to know what it is
 * drawing, and a second spelling of it anywhere would be a second vocabulary for
 * a row neither file could then agree about.
 */
export const UNATTENDED_DIVIDER_MESSAGE_TYPE = 'unattended-divider';

/** The `ChatMessage.type` of a turn nobody typed — see {@link UNATTENDED_DIVIDER_MESSAGE_TYPE}. */
export const UNATTENDED_TURN_MESSAGE_TYPE = 'unattended';

/**
 * The `ChatMessage.type` of a message a resident process has taken but not
 * started.
 *
 * Its own type rather than a `user` row with a flag, for the reason the two
 * constants above are: this row is drawn by a different component, carries the
 * host's own account of where the command is, and offers an action no other row
 * has — and a renderer that had to narrow a `user` row first would be reading
 * two facts to decide one thing.
 */
export const RESIDENT_PENDING_MESSAGE_TYPE = 'resident_pending';

function formatToolResultContent(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const toolUseErrorMatch = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return toolUseErrorMatch ? toolUseErrorMatch[1] : text;
}

type ParsedTaskNotification = {
  status: string;
  summary: string;
  result: string;
  /** The `<task-id>` a Monitor event reports on, or `''` when the block carries none. */
  taskId: string;
  /**
   * The `<event>` body when the block is a Monitor event, or `undefined` for a
   * background-agent notification. Its presence — not the text — is what marks
   * the row as a Monitor event; an empty `<event></event>` is still one.
   */
  event: string | undefined;
};

type ToolResultSource = NormalizedMessage['toolResult'] | NormalizedMessage | null;

type CachedMessageProjection = {
  /** A tool-use row also depends on a separately received tool-result row. */
  toolResultSource: ToolResultSource;
  /** A live subagent container also depends on the newest row folded into its timeline. */
  subagentActivitySource: NormalizedMessage | null;
  messages: ChatMessage[];
};

// Normalized messages are immutable store records. Reuse the UI objects made
// from records that survived a store update so memoized message rows can skip
// work while only the active streaming record changes. Weak keys let entries
// disappear automatically after their source records are no longer retained.
const projectionCache = new WeakMap<NormalizedMessage, CachedMessageProjection>();

/**
 * Reads the trimmed body of the first `<tag>…</tag>` in a notification block,
 * or `null` when the block carries no such tag.
 *
 * A distinct `null` (rather than an empty string) is load-bearing: whether a
 * Monitor event block has an `<event>` at all is what makes it a Monitor event,
 * and an empty event body must not read the same as no event body.
 */
function readTaggedValue(content: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(content);
  return match ? match[1].trim() : null;
}

/**
 * Parses a background-agent `<task-notification>` block.
 *
 * The harness injects these as user-role messages when a background task stops.
 * Newer notifications carry extra fields (`<tool-use-id>`, `<note>`, `<usage>`,
 * and a `<result>` markdown payload) that the previous single-shot regex could
 * not match, so the whole raw XML block leaked through as plain user text.
 * Fields are extracted independently so the block renders as an assistant
 * notification plus, when present, the agent's markdown result.
 *
 * A Monitor event is the same envelope with an `<event>` where a background
 * agent's `<result>` would be; its `<task-id>` and `<event>` are read here so
 * the projection can group and draw it, while the raw rows stay untouched.
 */
function parseTaskNotification(content: string): ParsedTaskNotification | null {
  if (!content.trimStart().startsWith('<task-notification>')) {
    return null;
  }

  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(content);
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(content);

  let result = '';
  const resultOpen = content.indexOf('<result>');
  if (resultOpen !== -1) {
    const afterOpen = content.slice(resultOpen + '<result>'.length);
    const closeIndex = afterOpen.indexOf('</result>');
    result =
      closeIndex === -1
        ? afterOpen.replace(/<\/task-notification>\s*$/, '').trim()
        : afterOpen.slice(0, closeIndex).trim();
  }

  return {
    status: statusMatch?.[1]?.trim() || 'completed',
    summary: summaryMatch?.[1]?.trim() || 'Background task finished',
    result,
    taskId: readTaggedValue(content, 'task-id') ?? '',
    event: readTaggedValue(content, 'event') ?? undefined,
  };
}

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Truly internal/system content is already filtered server-side. Some Claude
 * transcript artifacts such as local slash commands and compact summaries are
 * intentionally preserved and annotated so they can render like normal chat.
 */
/** The CLI acknowledges a compaction in the stream with the bare word. */
const COMPACTION_NOTICE = /^Compacted\.?$/;

/**
 * Draws a compaction as one row, whichever order its parts arrive in.
 *
 * A compaction reaches the client as three separate rows: the boundary (which
 * carries the numbers), the summary it produced (flagged `isCompactSummary`),
 * and the CLI's own one-word acknowledgement. On disk the boundary comes first;
 * live, the summary does. Either way the reader wants one row — the numbers,
 * with the summary folded into it.
 *
 * Returns true when the row was handled here and the caller should move on.
 */
function appendCompactionRow(
  msg: NormalizedMessage,
  converted: ChatMessage[],
  sharedMetadata: Partial<ChatMessage>,
  state: { hasCompactionRow: boolean; foldedSummaries: Set<string> },
): boolean {
  const content = msg.content || '';
  const text = content.trim();

  // The second copy of a summary already folded into a row above.
  if (text && state.foldedSummaries.has(text)) {
    return true;
  }

  // The acknowledgement, but only where a real compaction row exists to replace
  // it: against a server that reports none it is the only trace there is.
  if (
    state.hasCompactionRow
    && msg.kind === 'text'
    && msg.role === 'assistant'
    && COMPACTION_NOTICE.test(text)
  ) {
    return true;
  }

  if (msg.isCompactSummary) {
    state.foldedSummaries.add(text);

    // The unflagged copy is wherever the stream put it, not necessarily the row
    // directly above, so it is searched for — newest first, ordinary rows only.
    for (let index = converted.length - 1; index >= 0; index -= 1) {
      const row = converted[index];
      // Assistant rows only: a user who pastes the same text is not a duplicate.
      if (row.type === 'assistant' && !row.compact && (row.content || '').trim() === text) {
        converted.splice(index, 1);
        break;
      }
    }

    const previous = converted[converted.length - 1];
    if (previous?.compact && !previous.compactSummary) {
      // Replaced rather than mutated: that row can be one the projection cache
      // handed back, which is shared across renders, and a memoized row that
      // keeps its identity while its content changes does not redraw.
      converted[converted.length - 1] = { ...previous, compactSummary: content };
      return true;
    }

    // A summary with no boundary of its own — a session compacted before the
    // CLI recorded boundaries — still gets a row to fold into.
    converted.push({
      type: 'assistant',
      content: '',
      timestamp: msg.timestamp,
      ...sharedMetadata,
      compact: { phase: 'done' },
      compactSummary: content,
    });
    return true;
  }

  if (!msg.compact) {
    return false;
  }

  // This row supersedes the one directly above it in two cases, and only when it
  // is directly above — a compaction further back belongs to itself:
  //
  //   - a `running` row, now that the compaction has finished or failed;
  //   - the summary-only row a summary makes when it arrives before its
  //     boundary, which is the live order. Its summary comes along, since this
  //     row says what that one could not.
  const previous = converted[converted.length - 1];
  const supersedes = Boolean(previous?.compact)
    && (previous.compact?.phase === 'running' || !previous.content);
  const summary = supersedes ? previous.compactSummary : undefined;
  if (supersedes) {
    converted.pop();
  }

  converted.push({
    type: 'assistant',
    content,
    timestamp: msg.timestamp,
    ...sharedMetadata,
    compactSummary: summary,
  });
  return true;
}

export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment, and fold live subagent
  // rows into their spawning tool call's timeline. A running subagent's rows
  // stream in stamped with `parentToolUseId`; rendered top-level they read as
  // the session's own tool calls, only to jump inside the container on the
  // next history load, which ships the same timeline as `subagentTools`.
  const toolResultMap = new Map<string, NormalizedMessage>();
  const toolUseIds = new Set<string>();
  const liveSubagentActivity = new Map<string, SubagentActivity[]>();
  const liveSubagentToolsById = new Map<string, SubagentActivity>();
  /** Newest folded row per container, so its cached projection knows to rebuild. */
  const lastSubagentSourceByParent = new Map<string, NormalizedMessage>();
  for (const msg of messages) {
    if (msg.parentToolUseId) {
      const parentId = msg.parentToolUseId;
      let activity = liveSubagentActivity.get(parentId);
      if (!activity) {
        activity = [];
        liveSubagentActivity.set(parentId, activity);
      }

      switch (msg.kind) {
        case 'tool_use': {
          const tool: SubagentActivity = {
            kind: 'tool',
            toolId: msg.toolId,
            toolName: msg.toolName || 'Tool',
            toolInput: msg.toolInput,
            timestamp: msg.timestamp,
          };
          activity.push(tool);
          if (msg.toolId) {
            liveSubagentToolsById.set(msg.toolId, tool);
          }
          lastSubagentSourceByParent.set(parentId, msg);
          break;
        }
        case 'tool_result': {
          const tool = msg.toolId ? liveSubagentToolsById.get(msg.toolId) : undefined;
          if (tool) {
            tool.toolResult = {
              content: formatToolResultContent(msg.content ?? ''),
              isError: Boolean(msg.isError),
            };
            lastSubagentSourceByParent.set(parentId, msg);
          }
          break;
        }
        case 'text':
        case 'thinking': {
          // Assistant prose and reasoning only, matching the timeline the
          // server builds from the subagent's transcript — user-role rows
          // there are tool results and the echoed task prompt.
          if ((msg.kind === 'thinking' || msg.role === 'assistant') && msg.content?.trim()) {
            activity.push({
              kind: msg.kind === 'thinking' ? 'thinking' : 'text',
              content: msg.content,
              timestamp: msg.timestamp,
            });
            lastSubagentSourceByParent.set(parentId, msg);
          }
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (msg.kind === 'tool_use' && msg.toolId) {
      toolUseIds.add(msg.toolId);
    }

    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  // Whether any row describes a compaction at all. Used only to suppress the
  // CLI's own one-word acknowledgement, which says strictly less than the row
  // beside it — but is all there is when no such row exists.
  const hasCompactionRow = messages.some((msg) => msg.compact);
  // Summary text already folded into a compaction row: the CLI writes the
  // summary twice, once as the flagged row that carries it into the next turn
  // and once into the live stream, and only one copy is flagged.
  const foldedSummaries = new Set<string>();

  for (const msg of messages) {
    // Subagent rows were folded into their container's timeline above.
    if (msg.parentToolUseId) {
      continue;
    }

    const toolResultSource: ToolResultSource = msg.kind === 'tool_use'
      ? msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null) || null
      : null;
    const subagentActivitySource = msg.kind === 'tool_use' && msg.toolId
      ? lastSubagentSourceByParent.get(msg.toolId) ?? null
      : null;
    const cachedProjection = projectionCache.get(msg);

    // A tool-use projection must be rebuilt when a matching result arrives,
    // even though the original tool-use record itself is unchanged. The same
    // holds for a subagent container when its live timeline grows.
    if (
      cachedProjection?.toolResultSource === toolResultSource
      && cachedProjection.subagentActivitySource === subagentActivitySource
    ) {
      converted.push(...cachedProjection.messages);
      continue;
    }

    const convertedStart = converted.length;
    const sharedMetadata = {
      // The store row's identity, for the rows this client streams itself. A
      // streaming row is re-projected on every delta with fresh text and a fresh
      // timestamp, so this is the only field of it that does not change under
      // the transcript — and the only one it can key the row by. Server rows are
      // left without one deliberately: several providers mint their row ids
      // afresh on every read, which would make the key *less* stable than the
      // content-derived one below, not more.
      ...(isLiveRowId(msg.id) ? { id: msg.id } : {}),
      // The block this row is one state of, when it has one. It outlives both
      // the live id above and the settled id a replaced row takes, so it — not
      // the row id — is what the transcript's key is derived from.
      blockKey: msg.blockKey,
      displayText: msg.displayText,
      commandName: msg.commandName,
      commandMessage: msg.commandMessage,
      commandArgs: msg.commandArgs,
      isLocalCommand: msg.isLocalCommand,
      isLocalCommandStdout: msg.isLocalCommandStdout,
      isCompactSummary: msg.isCompactSummary,
      // Carried through so a rendered user bubble can address its own
      // transcript row when the user edits or forks from it.
      transcriptAnchorId: msg.transcriptAnchorId,
      // The read row's own id, under a name that says what it is for: addressing
      // the row back to the server, which resolves `session_read mode=around`
      // against exactly this value. It is *not* carried as `id` — see the
      // comment on that field above; a React key and an address have opposite
      // stability requirements, so they are two fields. A live row's id is this
      // client's (`live:…`) and names nothing on the server, so it is not
      // carried here; such a row is addressed by `id` alone.
      ...(!isLiveRowId(msg.id) && typeof msg.id === 'string' && msg.id.length > 0
        ? { transcriptRowId: msg.id }
        : {}),
      // The turn-ending reply's fork anchor, carried so a rendered assistant
      // bubble can offer "fork from this answer".
      forkAnchorId: msg.forkAnchorId,
      compact: msg.compact,
    };

    if (appendCompactionRow(msg, converted, sharedMetadata, {
      hasCompactionRow,
      foldedSummaries,
    })) {
      continue;
    }

    switch (msg.kind) {
      case 'command_lifecycle': {
        // The process's account of a message it is holding. Only this client's
        // own row is drawn: a `command_lifecycle` row served over REST is the
        // process talking about a command, not a turn in the conversation, and
        // the store already keeps those out of the transcript. What is left is
        // the row the composer wrote when the user's send went into a live
        // process — the message itself, plus whatever the host has said about it
        // since (`queued`, then `started`, or gone once it was withdrawn).
        if (!isLiveRowId(msg.id)) break;

        converted.push({
          type: RESIDENT_PENDING_MESSAGE_TYPE,
          content: msg.content || '',
          timestamp: msg.timestamp,
          residentCommandUuid: msg.commandUuid ?? null,
          residentCommandState: msg.commandState ?? 'queued',
          // The row's identity, as the activity channel named it. Null while the
          // send has no delivery yet — the window the row draws "not yet
          // acknowledged" from — and the same `deliveryId` the snapshot's
          // `deliveries[]` is folded by, so the drawn row and the withdrawn
          // command address one delivery rather than two.
          residentDeliveryId: msg.deliveryId ?? null,
          ...sharedMetadata,
        });
        break;
      }

      case 'text': {
        const content = msg.content || '';
        const images = Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined;
        const files = Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined;
        if (!content.trim() && !images && !files) break;

        if (msg.role === 'user') {
          // Parse task notifications FIRST, before the origin branch. A
          // background task's `<task-notification>` row carries an origin
          // (`background-task`) like any other turn nobody typed, but it is not
          // drawn as one: it stays a compact notification line. Running the
          // origin branch first would route it into the unattended turn whose
          // `content` is the raw XML, so the whole `<task-notification>…` block
          // would be painted as the body.
          const taskNotif = parseTaskNotification(content);
          if (taskNotif) {
            // A Monitor event is a notification that carries an `<event>`
            // body. It is annotated rather than collapsed here: this
            // projection stays lossless (one row per source row), and the
            // folding into one row is `collapseMonitorEventRows`'s job so
            // that search and export, which read this projection raw, still
            // see every event.
            const isMonitorEvent = taskNotif.event !== undefined;
            converted.push({
              type: 'assistant',
              content: taskNotif.summary,
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskStatus: taskNotif.status,
              ...(isMonitorEvent
                ? {
                    isMonitorEvent: true,
                    monitorTaskId: taskNotif.taskId,
                    monitorEvent: taskNotif.event,
                    monitorDescription: taskNotif.summary,
                  }
                : {}),
              ...sharedMetadata,
            });
            // Render the agent's result as a normal assistant message so its
            // markdown displays correctly instead of leaking raw XML.
            if (taskNotif.result) {
              converted.push({
                type: 'assistant',
                content: formatUsageLimitText(taskNotif.result),
                timestamp: msg.timestamp,
                ...sharedMetadata,
              });
            }
          } else if (msg.origin) {
            // A turn nobody typed is drawn as two rows: a divider naming what
            // started it, and the turn itself in a style that is not a person's.
            // They are minted here, side by side, because the divider is a
            // transcript row in its own right — it has a position, it scrolls,
            // and deriving it at render time from the row below would make it
            // depend on where the row below happened to be grouped.
            //
            // The alternative this replaces is the reason the two types exist:
            // pushed as a plain `user` row, an unattended turn would render in
            // the user's own bubble and be indistinguishable from something the
            // reader typed.
            converted.push({
              type: UNATTENDED_DIVIDER_MESSAGE_TYPE,
              content: '',
              timestamp: msg.timestamp,
              origin: msg.origin,
            });
            converted.push({
              type: UNATTENDED_TURN_MESSAGE_TYPE,
              content,
              timestamp: msg.timestamp,
              images,
              files,
              origin: msg.origin,
              ...sharedMetadata,
            });
          } else {
            converted.push({
              type: 'user',
              content,
              timestamp: msg.timestamp,
              images,
              files,
              ...sharedMetadata,
            });
          }
        } else {
          const text = formatUsageLimitText(content);
          converted.push({
            type: 'assistant',
            content: text,
            timestamp: msg.timestamp,
            memoryCitations: msg.memoryCitations,
            ...sharedMetadata,
          });
        }
        break;
      }

      case 'tool_use': {
        const tr = toolResultSource;
        // A row is a subagent container when the backend attached agent
        // metadata to it. Both providers normalize to that, so no provider or
        // tool-name special-casing is needed here; the name check only covers
        // a live spawn whose metadata has not been indexed yet.
        const isSubagentContainer = Boolean(msg.subagent)
          || msg.toolName === 'Task'
          || msg.toolName === 'Agent';

        const toolResult = tr
          ? {
              content: formatToolResultContent(tr.content),
              isError: Boolean(tr.isError),
              toolUseResult: (tr as any).toolUseResult,
            }
          : null;

        // The server-indexed timeline arrives on a history load; the live fold
        // covers the run in progress. A mid-run refresh can attach a partial
        // server timeline while newer live rows keep streaming, so the longer
        // list is the fresher one.
        const serverActivity = Array.isArray(msg.subagentTools) ? msg.subagentTools : undefined;
        const liveActivity = msg.toolId ? liveSubagentActivity.get(msg.toolId) : undefined;
        const subagentActivity = liveActivity && liveActivity.length > (serverActivity?.length ?? 0)
          ? liveActivity
          : serverActivity;

        converted.push({
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          toolStatus: typeof msg.status === 'string' ? msg.status : undefined,
          isSubagentContainer,
          subagent: msg.subagent,
          subagentActivity,
          memoryCitations: msg.memoryCitations,
          ...sharedMetadata,
        });
        break;
      }

      case 'thinking':
        if (msg.content?.trim()) {
          converted.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isThinking: true,
            ...sharedMetadata,
          });
        }
        break;

      case 'error':
        converted.push({
          type: 'error',
          content: msg.content || 'Unknown error',
          timestamp: msg.timestamp,
          ...sharedMetadata,
        });
        break;

      case 'task_notification':
        // A normalized `task_notification` carries only a status and a summary
        // (Codex's `status_note`), never the raw `<event>` of a Monitor event,
        // so it has no Monitor fields to add here.
        converted.push({
          type: 'assistant',
          content: msg.summary || 'Background task update',
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: msg.status || 'completed',
          ...sharedMetadata,
        });
        break;

      case 'stream_delta':
        // A `stream_delta` is drawn only when it carries a live row id — the
        // identity this client minted for the reply it is streaming. Rendering
        // any other one would splice a fragment into the transcript that
        // nothing can ever supersede: both pruning passes match on full-text
        // equality, and a fragment never equals the finished reply, so it would
        // sit there until a reload. Refusing it here degrades such a delta to
        // "this session does not animate" instead of poisoning the transcript.
        if (!isLiveRowId(msg.id)) break;
        if (msg.content) {
          converted.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
            ...sharedMetadata,
          });
        }
        break;

      // stream_end, complete, status, permission_*, session_created
      // are control events — not rendered as messages
      case 'stream_end':
      case 'complete':
      case 'status':
      case 'permission_request':
      case 'permission_resolved':
      case 'permission_cancelled':
      case 'session_created':
        // Skip — these are handled by useChatRealtimeHandlers
        break;

      // tool_result is handled via attachment to tool_use above
      case 'tool_result': {
        if (msg.toolId && toolUseIds.has(msg.toolId)) {
          break;
        }

        // A result with a toolId but no matching tool_use in the loaded set is
        // almost always a tool_use/tool_result pair split across a pagination
        // boundary (older page not loaded yet). Rendering its raw content here
        // produces an unstyled dump that "fixes itself" once the older page
        // loads; skip it and let it attach to its tool_use when that arrives.
        if (msg.toolId) {
          break;
        }

        const content = formatToolResultContent(msg.content || '');
        if (!content.trim()) {
          break;
        }

        converted.push({
          type: msg.isError ? 'error' : 'assistant',
          content,
          timestamp: msg.timestamp,
          toolId: msg.toolId,
          ...sharedMetadata,
        });
        break;
      }

      default:
        break;
    }

    projectionCache.set(msg, {
      toolResultSource,
      subagentActivitySource,
      // One source record can produce zero, one, or two UI messages (task
      // notifications with a result produce two), so cache the whole slice.
      messages: converted.slice(convertedStart),
    });
  }

  return converted;
}

/** The one event body the run's status is read from. */
const MONITOR_TIMEOUT = /Monitor timed out/;

/**
 * Whether a row is a member of a foldable Monitor run — a projected Monitor
 * event that names the task it reports on. The task id is the grouping key and
 * nothing else is consulted: text equality is deliberately not one, because two
 * different tasks can publish byte-identical events.
 */
function isFoldableMonitorRow(row: ChatMessage): boolean {
  return row.isMonitorEvent === true && typeof row.monitorTaskId === 'string' && row.monitorTaskId !== '';
}

/**
 * Folds the maximal runs of adjacent Monitor events for one task into a single
 * row each, leaving every other row where it was.
 *
 * Used by `useChatSessionState` to build both the rendered transcript and the
 * search target's projection, so an index into one is an index into the other;
 * it is applied there and nowhere else, because every other caller of
 * {@link normalizedToChatMessages} needs the raw, unfolded rows.
 *
 * A run is a longest consecutive stretch of rows that are Monitor events and
 * share one non-empty `monitorTaskId`. Anything else ends it: an ordinary row,
 * a Monitor event with no task id, and a Monitor event for a different task are
 * all boundaries — so events never merge across a gap and never merge across
 * task ids. The single row a run becomes carries the description, the count and
 * the events themselves, and is marked `'stopped'` when any event reports a
 * monitor timeout.
 *
 * This is a projection of the rows it is given, so it never mutates them or the
 * array: a caller that needs the raw, unfolded rows keeps the
 * {@link normalizedToChatMessages} output instead.
 */
export function collapseMonitorEventRows(rows: ChatMessage[]): ChatMessage[] {
  const collapsed: ChatMessage[] = [];
  let run: ChatMessage[] = [];
  let runTaskId = '';

  const flushRun = () => {
    if (run.length === 0) return;
    const first = run[0];
    const events = run.map((row) => String(row.monitorEvent ?? ''));
    collapsed.push({
      // The run's first row supplies the shared metadata — id, blockKey,
      // timestamp, and the description — while the collapse fields below say
      // what the row now stands for.
      ...first,
      type: 'assistant',
      isTaskNotification: true,
      isMonitorCollapse: true,
      monitorTaskId: runTaskId,
      monitorDescription: first.monitorDescription,
      monitorEventCount: events.length,
      monitorEvents: events,
      monitorStatus: events.some((event) => MONITOR_TIMEOUT.test(event))
        ? 'stopped'
        : 'completed',
    });
    run = [];
    runTaskId = '';
  };

  for (const row of rows) {
    if (isFoldableMonitorRow(row)) {
      if (run.length > 0 && row.monitorTaskId === runTaskId) {
        run.push(row);
      } else {
        flushRun();
        runTaskId = String(row.monitorTaskId);
        run = [row];
      }
    } else {
      flushRun();
      collapsed.push(row);
    }
  }
  flushRun();

  return collapsed;
}
