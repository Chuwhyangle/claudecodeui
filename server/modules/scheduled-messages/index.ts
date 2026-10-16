// The HTTP surface for scheduling a message to a session, mounted by the app.
export { default as scheduledMessagesRoutes } from './scheduled-messages.routes.js';

// The timer that sends them, started and stopped with the server.
export {
  initializeScheduledMessageDispatcher,
  closeScheduledMessageDispatcher,
  // dispatchDueScheduledMessages: the single dispatch pass. Re-exported for the
  // websocket module's wiring criterion
  // (`server/modules/websocket/tests/chat-control-wiring.test.ts`), which drives
  // one pass with the shared control service spy and reads that the timer
  // reaches the *same* instance the chat gateway does — an assertion that needs
  // the pass, not the interval.
  dispatchDueScheduledMessages,
  // dispatchQueuedMessages: the drain of the per-session queues, the one place a
  // busy run's queued sends go out. Re-exported for the websocket module's
  // single-writer criterion
  // (`server/modules/websocket/tests/processing-single-writer.test.ts`), which
  // drives the drain directly on a scripted clock and reads which readers see
  // 「处理中」 while it runs. The import is the barrel rather than the service
  // file because a cross-module reader must come through here (`boundaries/
  // dependencies`, `.oxlintrc.json`).
  dispatchQueuedMessages,
} from './services/scheduled-message-dispatcher.service.js';
