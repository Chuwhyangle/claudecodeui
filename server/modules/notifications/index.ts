export {
  // Used by notification tests and delivery workflows to create channel payloads.
  buildNotificationPayload,
  // Used by provider runtimes and Settings to create normalized notification events.
  createNotificationEvent,
  // Used by provider runtimes and Settings to deliver events through enabled channels.
  notifyUserIfEnabled,
  // Used by provider runtimes to report failed agent runs.
  notifyRunFailed,
  // Used by provider runtimes to report stopped or completed agent runs.
  notifyRunStopped,
  // Used by provider runtimes to report background work that finished after its turn ended.
  notifyBackgroundWorkCompleted,
} from '@/modules/notifications/services/notification-orchestrator.service.js';
export {
  registerDesktopNotificationClient,
  sendDesktopNotification,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/services/desktop-notification-clients.service.js';
// isDesktopAlertEnabled: used by the server entrypoint to log whether the
// off-browser alert channel is wired, so an unwired deployment is not mistaken
// for a silent one.
export { isDesktopAlertEnabled } from '@/modules/notifications/services/desktop-alert.service.js';
// sendAwaitingReplyDesktopAlert: used by the providers module when a session
// newly starts waiting on the user, to raise a desktop alert on the machine the
// browser is not on.
export { sendAwaitingReplyDesktopAlert } from '@/modules/notifications/services/desktop-alert.service.js';
export type { AwaitingReplyDesktopAlert } from '@/modules/notifications/services/desktop-alert.service.js';
export { handleDesktopNotificationsConnection } from '@/modules/notifications/websocket/desktop-notifications-websocket.service.js';
// getPublicKey: used by Settings to expose the Web Push subscription key.
export { getPublicKey } from './vapid-keys.service.js';
// configureWebPush: used by the server entrypoint during notification startup.
export { configureWebPush } from './vapid-keys.service.js';
