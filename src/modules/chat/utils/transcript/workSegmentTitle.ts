import type { ChatMessage, WorkSegment } from '@/shared/types';
import { formatToolDisplayName, getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';

/**
 * The three readings the collapsed work-segment header carries, every one of them
 * derived from the segment itself: what the run is doing right now, how many rows
 * it holds, and how long it has been running.
 */
export type WorkSegmentTitle = {
  /** The last member's action, named the way that member's own row names it. */
  action: string;
  /** How many rows the run absorbed. */
  count: number;
  /** Milliseconds from the run's first member to its last; never negative. */
  elapsedMs: number;
};

/** Epoch milliseconds for a `ChatMessage` timestamp; an unparseable one reads as 0. */
function toEpochMs(timestamp: ChatMessage['timestamp']): number {
  if (timestamp instanceof Date) {
    return timestamp.getTime();
  }
  if (typeof timestamp === 'number') {
    return timestamp;
  }
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Names a member's action the way the member's own row does.
 *
 * Deliberately sourced from the same place the row's renderer sources it, never
 * from the member's prose: a tool member is named by its tool config's label —
 * falling back to the friendly, MCP-aware display name, exactly as
 * `OneLineDisplay` renders it — a subagent container by the agent type its panel
 * titles itself with, and a thinking member by the action word its reasoning
 * trigger uses. `content` and `displayText` are never consulted, so the header
 * cannot guess an action from a row's text.
 *
 * Used by chat's transcript to title the collapsed work-segment record; exported
 * so the criterion can pin each member kind against its own row's convention.
 */
export function getMemberActionLabel(message: ChatMessage): string {
  if (message.isSubagentContainer) {
    return message.subagent?.type || 'Agent';
  }

  if (message.isToolUse) {
    const toolName = message.toolName || 'UnknownTool';
    return getToolConfig(toolName).input.label || formatToolDisplayName(toolName);
  }

  if (message.isThinking) {
    return 'Thinking';
  }

  return 'Work';
}

/**
 * Derives the collapsed header's title from the segment, as a pure function of
 * its members: the action comes from the last member, the count from the run's
 * length, and the elapsed span from the first member's timestamp to the last
 * member's.
 *
 * Nothing here reads the clock. A streaming member's timestamp is re-minted with
 * each delta, so the span grows while the run streams and settles when the last
 * member settles — which is also what freezes the title at the end of a run with
 * no effect to stop it, and what keeps the three readings a function of the
 * segment rather than of when the header happened to mount.
 *
 * Used by chat's transcript to render the collapsed work-segment record;
 * `WorkSegmentRecord` is its only consumer.
 */
export function buildWorkSegmentTitle(segment: WorkSegment): WorkSegmentTitle {
  const { messages } = segment;

  if (messages.length === 0) {
    return { action: '', count: 0, elapsedMs: 0 };
  }

  const last = messages[messages.length - 1];
  const elapsedMs = Math.max(0, toEpochMs(last.timestamp) - toEpochMs(messages[0].timestamp));

  return { action: getMemberActionLabel(last), count: messages.length, elapsedMs };
}

/** Compact elapsed label for the collapsed header — `0ms`, `450ms`, `1.5s`. */
export function formatElapsedMs(elapsedMs: number): string {
  if (elapsedMs < 1000) {
    return `${Math.max(0, Math.round(elapsedMs))}ms`;
  }

  return `${(elapsedMs / 1000).toFixed(1)}s`;
}
