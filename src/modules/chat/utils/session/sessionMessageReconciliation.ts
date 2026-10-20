import type { NormalizedMessage } from '@/shared/types';
import { isLiveRowId } from '@/modules/chat/utils/transcript/liveRowIdentity';

const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;
const LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS = 30_000;

type UserTurnFingerprint = {
  text: string;
  imageCount: number;
  fileCount: number;
};

function userTurnFingerprint(message: NormalizedMessage): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const text = (message.content || '').trim();
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  if (!text && imageCount === 0 && fileCount === 0) return null;

  return { text, imageCount, fileCount };
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
): boolean {
  return (
    local.text === server.text
    && local.imageCount === server.imageCount
    && local.fileCount === server.fileCount
  );
}

function readMessageTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

/**
 * True for a row this client minted as an optimistic echo — the `local_…` id
 * `addMessage` hands back. A row with no string id is not one of them: it cannot
 * be this client's optimistic row, and reading `startsWith` off an absent id
 * would throw out of the merge.
 */
function isLocalOptimisticRow(message: NormalizedMessage): boolean {
  return typeof message.id === 'string' && message.id.startsWith('local_');
}

/**
 * True for a row the server wrote (a persisted turn), as opposed to one this
 * client minted optimistically (`local_…`) or streams live (`live:…`). Those are
 * the only rows that can retire an optimistic echo — one local row must never be
 * paired with another.
 */
function isPersistedRow(message: NormalizedMessage): boolean {
  return typeof message.id === 'string'
    && !message.id.startsWith('local_')
    && !isLiveRowId(message.id);
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  candidates: NormalizedMessage[],
  claimedServerIds: Set<string>,
  firstEligibleIndex: number,
): NormalizedMessage | null {
  const localFingerprint = userTurnFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localFingerprint || localTime === null) {
    return null;
  }

  const dedupeWindow = localFingerprint.text
    ? LOCAL_USER_DEDUPE_WINDOW_MS
    : LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS;
  let closestMatch: NormalizedMessage | null = null;
  let closestTimeDifference = Number.POSITIVE_INFINITY;

  for (let index = firstEligibleIndex; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (claimedServerIds.has(candidate.id)) {
      continue;
    }

    const candidateFingerprint = userTurnFingerprint(candidate);
    if (!candidateFingerprint || !userTurnFingerprintsMatch(localFingerprint, candidateFingerprint)) {
      continue;
    }

    const candidateTime = readMessageTime(candidate);
    if (
      candidateTime === null
      || candidateTime < localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      || candidateTime - localTime > dedupeWindow
    ) {
      continue;
    }

    const timeDifference = Math.abs(candidateTime - localTime);
    if (timeDifference < closestTimeDifference) {
      closestMatch = candidate;
      closestTimeDifference = timeDifference;
    }
  }

  return closestMatch;
}

/**
 * Removes local optimistic user rows once a corresponding persisted turn is
 * available. Matches are one-to-one so repeated sends cannot claim one row.
 *
 * The persisted copy can reach this client two ways, and either is enough. The
 * REST history page puts it in `serverMessages`; the server also pushes the
 * user's own persisted turn over the socket, where it lands in
 * `realtimeMessages` as a row the client did not mint. A send whose echo arrives
 * on the socket before the next history refresh would otherwise be drawn twice —
 * the optimistic row beside its own persisted copy — which is exactly the
 * duplicate a retried send must never produce.
 */
export function removeOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const claimedServerIds = new Set<string>();

  // Persisted rows that are already in the realtime list are echo candidates
  // too. Only persisted rows qualify: an optimistic (`local_…`) row must never
  // retire another, or two real sends of the same words would collapse.
  const realtimeEchoCandidates = realtimeMessages.filter(isPersistedRow);

  return realtimeMessages.filter((message) => {
    // A row that is not one of this client's optimistic echoes is passed through
    // untouched. The guard is also what keeps a malformed realtime row (a control
    // frame that reached the store, a partial frame) from aborting the whole
    // merge: `id.startsWith` on an absent id throws, and the throw escapes
    // `computeMerged`, so one bad row would freeze every later refresh.
    if (!isLocalOptimisticRow(message)) {
      return true;
    }

    // The echo of an edited message may only be retired by a row that was not in
    // the transcript when the cut was made. Text and a time window are not enough
    // for it: a rewind that branches re-stamps every surviving turn to the moment
    // of the copy, so an earlier turn with the same words — "yes", "continue",
    // the typo being corrected — lands inside the window and would retire the
    // message the user just sent. The floor is a count of server rows, so it
    // applies only to the history-page candidate list.
    const firstEligibleIndex = message.replacesAfterRowCount ?? 0;
    const serverEcho = findServerEchoForLocalUser(
      message,
      serverMessages,
      claimedServerIds,
      firstEligibleIndex,
    );
    if (serverEcho) {
      claimedServerIds.add(serverEcho.id);
      return false;
    }

    const realtimeEcho = findServerEchoForLocalUser(
      message,
      realtimeEchoCandidates,
      claimedServerIds,
      0,
    );
    if (realtimeEcho) {
      claimedServerIds.add(realtimeEcho.id);
      return false;
    }

    return true;
  });
}
