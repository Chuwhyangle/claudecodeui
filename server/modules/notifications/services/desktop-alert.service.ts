import { spawn } from 'node:child_process';

/**
 * The away-from-the-page alert channel: hands one awaiting-reply event to an
 * external command, so a wait can reach a desktop the browser is not on.
 *
 * Why not Web Push: this deployment is typically served over plain HTTP, where
 * `isSecureContext` is false and the browser refuses both Notifications and
 * service workers. The websocket already reaches every open page; this channel
 * exists for the user who closed it, or who is in another window with the
 * browser minimized behind it. It is deliberately NOT the module's `desktop`
 * notification channel: that one is a browser websocket client the Electron app
 * registers, and it can only deliver to a running client.
 *
 * The command is deployment-specific and comes from
 * `CLOUDPIT_DESKTOP_NOTIFY_CMD` (unset or blank means the channel is off).
 * `CLOUDCLI_DESKTOP_NOTIFY_CMD` is still read as a fallback so an existing
 * deployment keeps alerting without editing its unit. The payload is one JSON
 * object on stdin, so the command never has to quote it — the shipped script is
 * an SSH call into a Windows workstation whose PowerShell reads stdin and
 * raises a toast (see `scripts/windows-notify/`).
 */

/** Environment variable naming the command that delivers one alert; blank disables the channel. */
const NOTIFY_COMMAND_ENV = 'CLOUDPIT_DESKTOP_NOTIFY_CMD';

/** The pre-rename spelling, still honoured so an existing deployment keeps alerting. */
const LEGACY_NOTIFY_COMMAND_ENV = 'CLOUDCLI_DESKTOP_NOTIFY_CMD';

/**
 * How long the external command may run before it is killed.
 *
 * Generous enough for an SSH handshake on a slow link, short enough that a hung
 * link cannot pile children up for the life of the server: alerts fire while
 * runs are finishing, and a wedged one must not outlive the event it reports.
 */
const NOTIFY_TIMEOUT_MS = 10_000;

/**
 * The floor between two spawned alerts, in milliseconds.
 *
 * A permission prompt raises the app's own in-page notification (with its
 * chime) and then marks the session as waiting, whose desktop alert would fire
 * at the same instant — two sounds for one event. It also keeps a burst of
 * sessions finishing together from spawning a child per session. The wait the
 * user owes is unchanged; only the alert is coalesced.
 */
const ALERT_MIN_INTERVAL_MS = 3_000;

/** What one desktop alert says. Assembled by the caller, which alone can name the subject. */
export type DesktopAlert = {
  /**
   * The session the alert relates to, when there is one; carried so the receiver
   * can dedupe or link back.
   */
  sessionId?: string;
  /** First line of the toast. Kept short because Windows truncates it in the action center. */
  title: string;
  /** Second line of the toast: what happened / what the user is being asked to do. */
  body: string;
};

/** An awaiting-reply alert: a desktop alert that always names its session. */
export type AwaitingReplyDesktopAlert = DesktopAlert & { sessionId: string };

/** The seams a channel is built from; injected so the channel is testable without spawning. */
export type DesktopAlertChannelDeps = {
  /** The environment to read the command from (defaults to `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Starts the command (defaults to `node:child_process.spawn`). */
  spawnImpl?: typeof spawn;
  /** The clock behind the throttle (defaults to `Date.now`). */
  now?: () => number;
};

/** The stateful alert channel: one throttle window, read by `send`. */
export type DesktopAlertChannel = {
  /** Reports whether a command is configured, so startup can log an off channel. */
  isEnabled(): boolean;
  /**
   * Spawns one alert. Fire-and-forget by contract: every failure is logged with
   * the command's own stderr and never thrown at the caller, which has already
   * recorded the event. Returns whether an alert was actually spawned (false
   * when the channel is off or the throttle window is still open).
   */
  send(alert: DesktopAlert): boolean;
};

/** Reads the configured command, treating a whitespace-only value as unset. */
function readNotifyCommand(env: Readonly<Record<string, string | undefined>>): string | null {
  const canonical = env[NOTIFY_COMMAND_ENV]?.trim();
  if (canonical) {
    return canonical;
  }
  const legacy = env[LEGACY_NOTIFY_COMMAND_ENV]?.trim();
  return legacy ? legacy : null;
}

/**
 * Builds one alert channel.
 *
 * The only mutable state is `lastSpawnAt`, and it lives in this closure for the
 * reason the backend standards give: a throttle is a lifecycle, so it is owned
 * by a factory object with its own command, never a module-scope binding read by
 * free functions. Production builds exactly one channel below; a test builds its
 * own, with its own clock and spawn seam, so the cases cannot throttle each
 * other.
 */
export function createDesktopAlertChannel(deps: DesktopAlertChannelDeps = {}): DesktopAlertChannel {
  const env = deps.env ?? process.env;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const now = deps.now ?? Date.now;
  let lastSpawnAt: number | null = null;

  return {
    isEnabled(): boolean {
      return readNotifyCommand(env) !== null;
    },

    send(alert: DesktopAlert): boolean {
      const command = readNotifyCommand(env);
      if (!command) {
        return false;
      }

      const startedAt = now();
      if (lastSpawnAt !== null && startedAt - lastSpawnAt < ALERT_MIN_INTERVAL_MS) {
        console.log(
          `[notifications] desktop alert for ${alert.sessionId ?? alert.title} coalesced (within ${ALERT_MIN_INTERVAL_MS}ms of the previous one)`,
        );
        return false;
      }
      lastSpawnAt = startedAt;

      const child = spawnImpl(command, {
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
        const subject = alert.sessionId ?? alert.title;
        console.warn(
          `[notifications] desktop alert for ${subject} failed: ${reason}${detail ? ` (${detail})` : ''}`,
        );
      };

      child.stderr?.on('data', (chunk: Buffer) => {
        // Keep the tail: a failing SSH or PowerShell session is chatty, and the
        // last lines are the ones that name the actual refusal.
        stderr = `${stderr}${chunk.toString()}`.slice(-2000);
      });
      child.on('error', (error: Error) => reportFailure(error.message));
      child.on('close', (code: number | null) => {
        if (code !== 0) {
          reportFailure(`exit code ${code}`);
        }
      });

      // A command that exits before reading its input closes the pipe early;
      // that is its own failure and is already reported above, so the EPIPE it
      // raises here must not surface as an unhandled stream error.
      child.stdin?.on('error', () => undefined);
      // `sessionId` is always present in the wire payload (empty when the alert
      // has no session) so the receiving script keeps one stable shape.
      child.stdin?.end(JSON.stringify({ sessionId: alert.sessionId ?? '', title: alert.title, body: alert.body }));
      return true;
    },
  };
}

/**
 * The process-wide channel, built once so every caller shares one throttle window.
 *
 * Disabled inside a `node --test` child: a developer machine (and this deployment's
 * own unit) may export the notify command, and every criterion that drives a run to
 * completion would then raise real toasts, spawn real children and hold the event
 * loop open for the command's timeout. A test child is not a person at a desktop.
 * The guard is here, on the production instance alone, rather than in the factory —
 * so the channel's own tests still build working channels from their own seams.
 */
const desktopAlertChannel = process.env.NODE_TEST_CONTEXT
  ? createDesktopAlertChannel({ env: {} })
  : createDesktopAlertChannel();

/**
 * Reports whether a desktop alert channel is configured.
 *
 * Read by startup so the log can say the channel is off rather than leaving a
 * user to infer it from notifications that never arrive.
 */
export function isDesktopAlertEnabled(): boolean {
  return desktopAlertChannel.isEnabled();
}

/**
 * Sends one alert through the process channel; see {@link DesktopAlertChannel.send}.
 *
 * Consumers: `sendAwaitingReplyDesktopAlert` below and the goals module's
 * resident driver (through the module barrel), which reports a goal's terminal
 * transition so a loop that finishes while nobody is looking is not silent.
 */
export function sendDesktopAlert(alert: DesktopAlert): boolean {
  return desktopAlertChannel.send(alert);
}

/**
 * Sends one awaiting-reply alert through the process channel.
 *
 * The named call site the providers module uses; it goes through the same
 * single channel (and therefore the same throttle window) as any other alert.
 */
export function sendAwaitingReplyDesktopAlert(alert: AwaitingReplyDesktopAlert): boolean {
  return sendDesktopAlert(alert);
}
