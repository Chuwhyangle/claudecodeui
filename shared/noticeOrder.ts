/**
 * The notice ordering contract — the ONE declaration of the severity ranks and of the comparator
 * that puts a `blocking` notice ahead of an `attention` one.
 *
 * Both ends order notices: the registry sorts `GET /api/notices` before answering, and the chat
 * slot sorts again so it never depends on the server's ordering. Those were two copies of
 * `SEVERITY_RANK` + `compareNotices` (archguard duplicate group `83bd173111f40177`, 6 statements /
 * 89 tokens / 6 savable lines), which is the drift this module prevents: a rank added on one side
 * only would silently disagree about which notice interrupts.
 *
 * It lives in the repository-root `shared/` tree because BOTH compiler configurations compile that
 * tree (ADR-004 decision 2): the backend reaches it as `@shared/noticeOrder.js` and the frontend as
 * `@shared/noticeOrder`. The notice model itself stays declared on each side — it is the wire
 * contract, and the client/server union agreement is pinned separately by
 * `src/shared/tests/wireContractTypeSync.test.ts`.
 *
 * Consumers: `server/modules/notices/notice-registry.service.ts` and
 * `src/modules/notices/NoticeSlot.tsx`.
 */

/** Lowest number wins the slot. */
export const SEVERITY_RANK = {
  blocking: 0,
  attention: 1,
  info: 2,
} as const;

/** The fields ordering reads. Both ends' `Notice` types satisfy this structurally. */
export type NoticeOrdering = {
  severity: keyof typeof SEVERITY_RANK;
  raisedAt: string;
  id: string;
};

/**
 * The slot's order: severity first (blocking > attention > info), then the newest `raisedAt`,
 * then the id so two notices raised in the same millisecond still order deterministically.
 */
export function compareNotices(left: NoticeOrdering, right: NoticeOrdering): number {
  const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (bySeverity !== 0) return bySeverity;
  if (left.raisedAt !== right.raisedAt) return right.raisedAt.localeCompare(left.raisedAt);
  return left.id.localeCompare(right.id);
}
