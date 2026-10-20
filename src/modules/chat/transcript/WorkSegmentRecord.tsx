import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import type { ChatMessage, WorkSegment } from '@/shared/types';
import { buildWorkSegmentTitle, formatElapsedMs } from '@/modules/chat/utils/transcript/workSegmentTitle';

type WorkSegmentRecordProps = {
  segment: WorkSegment;
  /** Whether the run's members are on screen. The only thing that decides between the record's two visible states. */
  expanded: boolean;
  /** Asks the owner to move between the collapsed and expanded states; the record itself holds no state. */
  onToggle?: (next: boolean) => void;
  /**
   * Draws one member row. The record injects it rather than importing a row
   * component, so the caller decides how a member draws while the record decides
   * only whether the run is on screen.
   */
  renderMember: (message: ChatMessage, index: number) => ReactNode;
};

/**
 * Used by chat's transcript message list to draw one run of work rows — the
 * thinking, tool-call and subagent-container rows `groupWorkSegments` absorbed —
 * as a single record that is collapsed by default and expands in place.
 *
 * The record never drops a member and never reads one's prose: its title derives
 * the run's current action, count and elapsed span from the segment (see
 * `buildWorkSegmentTitle`), which is the one thing it does look at its members
 * for. Collapsed, it renders the header alone and calls `renderMember` zero
 * times; expanded, it calls `renderMember` exactly once per member, in order.
 * Because collapsing only withholds the members from the mount and never touches
 * `segment.messages`, a collapse → expand round trip restores the exact same set
 * of rows — losing rows, thinking blocks, tool calls or subagent containers is not
 * a state this record can be in.
 *
 * The expanded state is owned by the caller, not by the record: the record holds
 * no state, so a run that stops growing never changes which state it is in.
 */
function WorkSegmentRecord({ segment, expanded, onToggle, renderMember }: WorkSegmentRecordProps) {
  const title = buildWorkSegmentTitle(segment);

  return (
    <div
      className="chat-message work-segment px-3 sm:px-0"
      data-work-segment-count={title.count}
      data-work-segment-elapsed-ms={title.elapsedMs}
    >
      <button
        type="button"
        className="group flex w-full items-center gap-2 rounded-r-md border-l-2 border-border bg-muted/25 px-3 py-2 text-left transition-colors hover:bg-muted/40 dark:bg-muted/10 dark:hover:bg-muted/20"
        onClick={() => onToggle?.(!expanded)}
        aria-expanded={expanded}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
        <span
          className="min-w-0 flex-shrink-0 truncate text-xs font-medium text-foreground"
          data-work-segment-action
        >
          {title.action}
        </span>
        <span
          className="flex-shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          aria-label={`${title.count} rows`}
        >
          {title.count}
        </span>
        <span
          className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-muted-foreground"
          data-work-segment-elapsed
        >
          {formatElapsedMs(title.elapsedMs)}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-3 sm:space-y-4">
          {segment.messages.map((message, index) => (
            <Fragment key={index}>{renderMember(message, index)}</Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export default WorkSegmentRecord;
