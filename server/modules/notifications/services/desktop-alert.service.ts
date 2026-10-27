import { spawn } from 'node:child_process';

/**
 * The away-from-the-page alert channel: hands one awaiting-reply event to an
 * external command, so a wait can reach a desktop the browser is not on.
 *
 * Why not Web Push: this deployment is served over plain HTTP, where
 * `isSecureContext` is false and the browser refuses both Notifications and
 * service workers. The websocket already reaches every open page; this channel
 * exists for the user who closed it, or who is in another window with the
 * browser minimized behind it.
 *
 * The command is deployment-specific and comes from `CLOUDCLI_DESKTOP_NOTIFY_CMD`
 * (unset or blank means the channel is off). The payload is one JSON object on
 * stdin, so the command never has to quote it — on this machine it is an SSH
 * call into the Windows workstation, whose script reads stdin and raises a toast.
 */

/** Environment variable naming the command that delivers one alert; blank disables the channel. */
const NOTIFY_COMMAND_ENV = 'CLOUDCLI_DESKTOP_NOTIFY_CMD';

/**
 * How long the external command may run before it is killed.
 *
 * Generous enough for an SSH handshake on a slow link, short enough that a hung
 * link cannot pile children up for the life of the server: alerts fire while
 * runs are finishing, and a wedged one must not outlive the event it reports.
 */
const NOTIFY_TIMEOUT_MS = 10_000;

/** What one desktop alert says. Assembled by the caller, which alone can name the session. */
export type AwaitingReplyDesktopAlert = {
  /** The session the wait belongs to; carried so the receiver can dedupe or link back. */
  sessionId: string;
  /** First line of the toast. Kept short because Windows truncates it in the action center. */
  title: string;
  /** Second line of the toast: what the user is being asked to do. */
  body: string;
};

/** Reads the configured command, treating a whitespace-only value as unset. */
function readNotifyCommand(): string | null {
  const command = process.env[NOTIFY_COMMAND_ENV]?.trim();
  return command ? command : null;
}

/**
 * Reports whether a desktop alert channel is configured.
 *
 * Read by startup so the log can say the channel is off rather than leaving a
 * user to infer it from notifications that never arrive.
 */
export function isDesktopAlertEnabled(): boolean {
  return readNotifyCommand() !== null;
}

/**
 * Sends one awaiting-reply alert through the configured command.
 *
 * Fire-and-forget by contract: the caller has already written the row and
 * pushed the websocket snapshot, so a missing or failing command must never turn
 * a recorded wait into a failed turn. Every failure is logged together with the
 * command's own stderr, because a channel that is silently broken is worse than
 * one that is plainly off.
 */
export function sendAwaitingReplyDesktopAlert(alert: AwaitingReplyDesktopAlert): void {
  const command = readNotifyCommand();
  if (!command) {
    return;
  }

  const child = spawn(command, {
    shell: true,
    stdio: ['pipe', 'ignore', 'pipe'],
    timeout: NOTIFY_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });

  let stderr = '';
  let reported = false;
  const reportFailure = (reason: string): void => {
    if (reported) {
      return;
    }
    reported = true;
    const detail = stderr.trim();
    console.warn(
      `[notifications] desktop alert for session ${alert.sessionId} failed: ${reason}${detail ? ` (${detail})` : ''}`,
    );
  };

  child.stderr?.on('data', (chunk: Buffer) => {
    // Keep the tail: a failing SSH or PowerShell session is chatty, and the last
    // lines are the ones that name the actual refusal.
    stderr = `${stderr}${chunk.toString()}`.slice(-2000);
  });
  child.on('error', (error: Error) => reportFailure(error.message));
  child.on('close', (code: number | null) => {
    if (code !== 0) {
      reportFailure(`exit code ${code}`);
    }
  });

  // A command that exits before reading its input closes the pipe early; that is
  // its own failure and is already reported above, so the EPIPE it raises here
  // must not surface as an unhandled stream error.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(JSON.stringify(alert));
}
