import { getConnection } from '@/modules/database/core/index.js';

/**
 * The browser's last-opened session, as the reader returns it.
 *
 * `openedAt` is epoch milliseconds — the same numeric instant every relative-time
 * boundary in the codebase moves through, so the MCP tool can render it with the
 * injected clock rather than re-parsing a formatted string.
 */
export type UiLastOpenedRecord = {
  sessionId: string;
  openedAt: number;
};

type UiLastOpenedRow = {
  session_id: string;
  opened_at: number;
};

/**
 * Reads and writes the one row of the browser's last-opened session.
 *
 * WRITE SIDE IS BROWSER-ONLY. This repository has no notion of who is calling,
 * so the guard that "an MCP token's read must not move the pointer" lives one
 * layer up: only the provider's browser session-read routes call
 * `record` (through `uiLastOpenedSessionService`), while the MCP gateway's
 * `session_read` reaches the transcript through the sessions service and never
 * touches this table.
 *
 * ONE ROW AT A TIME. `record` first drops every other session's row and then
 * upserts the opened one, inside a transaction so a reader can never observe two
 * rows mid-replace. That makes "the last-opened session" a single reading rather
 * than a `max(opened_at)` query whose answer would change meaning if a clock
 * went backwards.
 *
 * Consumers: `uiLastOpenedSessionService` (the providers module's write/read
 * seam, called by the browser session-read routes and assembled into the MCP
 * gateway's `ui_last_opened_session` tool by `server/index.ts`).
 */
export const uiLastOpenedDb = {
  /** Records `sessionId` as the one session the UI has open, replacing any other. */
  record(sessionId: string, openedAt: number): void {
    const db = getConnection();
    const replace = db.transaction((id: string, at: number) => {
      db.prepare('DELETE FROM ui_last_opened WHERE session_id <> ?').run(id);
      db.prepare(
        `INSERT INTO ui_last_opened (session_id, opened_at) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET opened_at = excluded.opened_at`,
      ).run(id, at);
    });
    replace(sessionId, openedAt);
  },

  /** The last-opened session, or `null` when the UI has opened none. */
  read(): UiLastOpenedRecord | null {
    const row = getConnection()
      .prepare('SELECT session_id, opened_at FROM ui_last_opened LIMIT 1')
      .get() as UiLastOpenedRow | undefined;
    return row === undefined ? null : { sessionId: row.session_id, openedAt: row.opened_at };
  },
};
