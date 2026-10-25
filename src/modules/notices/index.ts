// The notices module's public surface. `NoticeSlot` is no longer mounted above the chat
// transcript: that mount is paused (gap-chat-banners-paused-pending-signal-redesign) until the
// chat page's signal design is settled. `NoticeInbox` is rendered by the slot when its fold line
// is expanded, and is also exported so a criterion can drive it without the whole slot.
export { default as NoticeSlot } from '@/modules/notices/NoticeSlot';
export { default as NoticeInbox } from '@/modules/notices/NoticeInbox';
export { NOTICES_POLL_INTERVAL_MS, useNotices } from '@/modules/notices/useNotices';
export type {
  Notice,
  NoticeDismissPort,
  NoticeLifecycle,
  NoticeList,
  NoticeListPort,
  NoticePrimaryAction,
  NoticesController,
  NoticesView,
  NoticeSeverity,
} from '@/modules/notices/useNotices';
