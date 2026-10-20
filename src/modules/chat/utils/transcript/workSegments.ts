import type { ChatMessage, WorkSegment, WorkSegmentListItem } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/transcript/messageKeys';

/**
 * Whether a row belongs to a work run.
 *
 * Membership is decided by the row's TYPE fields alone — `isThinking`,
 * `isToolUse`, `isSubagentContainer`, `isTaskNotification`. A row's text is
 * deliberately not consulted: a tool row whose prose has not arrived yet is
 * already a member, and an assistant body row is already a boundary, so a run's
 * edges are the same before and after the tail streams in.
 *
 * A task-notification row is a member for the same reason the others are: it is
 * a row *about* the work around it, not a thing said. A background shell's
 * terminal line lands directly behind the tool card that launched it, and while
 * it was a boundary it cut that run into two one-member fragments — the reader
 * saw the card's own header float free of its command. Absorbing it keeps the
 * run whole and still draws the line, because a run of one member is emitted as
 * that member itself.
 *
 * Exported because it is the ONE rule for "this row is work, not something said",
 * and the voice context pack reads it rather than restating it — see
 * `src/modules/chat/utils/voiceContextPack.ts`, which leaves the same rows out of
 * what it hands the voice model. A second definition of this boundary would drift
 * the first time either side changed.
 */
export function isWorkSegmentMember(message: ChatMessage): boolean {
  return Boolean(
    message.isThinking
      || message.isToolUse
      || message.isSubagentContainer
      || message.isTaskNotification,
  );
}

/** Narrows a selected transcript entry to the {@link WorkSegment} standing in for a run of work rows. */
export function isWorkSegment(item: WorkSegmentListItem): item is WorkSegment {
  return '_isWorkSegment' in item && (item as WorkSegment)._isWorkSegment === true;
}

/**
 * Selects the transcript's work segments: every maximal run of adjacent
 * thinking / tool-call / subagent-container rows becomes one `WorkSegment`, and
 * every other row is emitted untouched.
 *
 * Consumed by the chat transcript's message list (`src/modules/chat/transcript`),
 * which runs it before rendering so a run of work rows can be drawn as one
 * segment. The selection is a pure function of the rows' types, which is what
 * makes it stable across the streaming tail, and it keeps the run's rows
 * verbatim — unlike `groupConsecutiveTools` it never folds same-name calls into
 * an xN layer, so a run of N calls has N members. A run of exactly one member is
 * emitted as that member itself rather than wrapped, which keeps a lone tool row
 * rendering exactly as it does today.
 *
 * The segment's `key` is its first member's intrinsic key, so the segment has an
 * identity the tail cannot re-mint.
 */
export function groupWorkSegments(messages: ChatMessage[]): WorkSegmentListItem[] {
  const items: WorkSegmentListItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (!isWorkSegmentMember(message)) {
      items.push(message);
      index += 1;
      continue;
    }

    const members: ChatMessage[] = [message];
    let nextIndex = index + 1;

    while (nextIndex < messages.length && isWorkSegmentMember(messages[nextIndex])) {
      members.push(messages[nextIndex]);
      nextIndex += 1;
    }

    if (members.length === 1) {
      items.push(message);
    } else {
      items.push({
        _isWorkSegment: true,
        key: getIntrinsicMessageKey(message),
        messages: members,
      });
    }

    index = nextIndex;
  }

  return items;
}
