import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { ClaudeProviderAuth } from '@/modules/providers/list/claude/claude-auth.provider.js';
import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeForkProvider } from '@/modules/providers/list/claude/claude-fork.provider.js';
import {
  ClaudeResidentHostDriver,
  type ClaudeResidentRunStoppedEvent,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { ClaudeMcpProvider } from '@/modules/providers/list/claude/claude-mcp.provider.js';
import { ClaudeRenameProvider } from '@/modules/providers/list/claude/claude-rename.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { ClaudeSkillsProvider } from '@/modules/providers/list/claude/claude-skills.provider.js';
import {
  notifyBackgroundWorkCompleted,
  notifyRunStopped,
} from '@/modules/notifications/index.js';
import { sessionHostManager } from '@/modules/session-hosts/index.js';
// eslint-disable-next-line boundaries/dependencies -- the websocket barrel would close the eval cycle above; this leaf re-enters nothing.
import { readConnectedClientCount } from '@/shared/ports/connected-clients.port.js';
import type {
  IProviderAuth,
  IProviderFork,
  IProviderHostDriver,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionRename,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';
import type { BackgroundWorkTrigger, LLMProvider } from '@/shared/types.js';

/**
 * The background-work notification, viewed with the argument shape its module
 * really takes.
 *
 * `notifyBackgroundWorkCompleted` lives in a `.js` module and `checkJs` is off,
 * so TypeScript infers its destructured parameters from their defaults alone:
 * it presents `sessionId` and `sessionName` as `null | undefined`, even though
 * its own body hands both to a `createNotificationEvent` that takes a string and
 * the runtime's callers pass a session id on every run. The assertion is that
 * true contract, made once here instead of at every call site — and because it
 * is only a widening, a record built from the driver's event still reaches the
 * notification unchanged.
 *
 * `trigger` is widened in for the same reason and is the one field that is
 * genuinely new: the runtime's own call site has no trigger to give (it reports
 * a held background task whose turn it already knew about), so it stays absent
 * there and the notification records `null`. Only the resident driver, which has
 * to work out *what* opened a turn nobody pushed, fills it.
 */
const reportBackgroundWorkCompleted = notifyBackgroundWorkCompleted as (event: {
  userId: string | number | null;
  provider: LLMProvider;
  sessionId: string | null;
  sessionName: string | null;
  trigger?: BackgroundWorkTrigger | null;
}) => void;

/**
 * The stop notification, viewed the same way.
 *
 * Same widening as above, and stated against the resident driver's own event
 * type so the two cannot drift: the driver reports the ending of a turn it
 * drove, and this is the assertion that the notification layer takes exactly
 * that record — including the `aborted` reason a stopped resident turn reports.
 */
const reportRunStopped = notifyRunStopped as (event: ClaudeResidentRunStoppedEvent) => void;

export class ClaudeProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = claudeRuntime;
  readonly models: IProviderModels = new ClaudeProviderModels();
  readonly mcp = new ClaudeMcpProvider();
  readonly auth: IProviderAuth = new ClaudeProviderAuth();
  readonly skills: IProviderSkills = new ClaudeSkillsProvider();
  readonly sessions: IProviderSessions = new ClaudeSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new ClaudeSessionSynchronizer();
  readonly fork: IProviderFork = new ClaudeForkProvider();
  readonly rename: IProviderSessionRename = new ClaudeRenameProvider();
  /**
   * Process ownership: the per-run host, and the resident one.
   *
   * Claude is the only provider that mounts this facet, and the mounted driver
   * serves both of the modes its capabilities declare. `per-run` is the
   * held-input protocol (`createHeldPromptStream` plus the print background-work
   * behavior it enables) that lets a process survive its turn's `result`, which
   * is why Claude's hosts are the ones whose lifetime the session-host layer
   * tracks rather than infers. `resident` is the same protocol held across turns:
   * one CLI reading a never-ending stdin, owned by `ClaudeResidentHostDriver` and
   * reached by the dispatch in `provider-runtime.service`, which routes a turn
   * here only for a session whose stored mode says so.
   *
   * The resident driver composes the per-run one, so the per-run verbs this slot
   * has always served are the same implementation, unchanged — a per-run host
   * opened by anyone still gets that driver's rules.
   *
   * Both drivers' reports go to the notifications the runtime's own run makes, so
   * a held background task and a completed resident turn notify identically
   * however the turn was driven. The event's `userId` is null for a background
   * work report because neither a bind nor a turn carries a connection: the
   * driver reports *what* completed, and the notification layer already treats a
   * missing user as "no per-user preferences to consult".
   */
  readonly residentHostDriver: ClaudeResidentHostDriver = new ClaudeResidentHostDriver({
    host: sessionHostManager,
    notifyBackgroundWork: (event) =>
      reportBackgroundWorkCompleted({
        userId: event.userId,
        provider: event.provider,
        sessionId: event.sessionId,
        sessionName: event.sessionName,
      }),
    notifyRunStopped: (event) =>
      reportRunStopped({
        userId: event.userId,
        provider: event.provider,
        sessionId: event.sessionId,
        sessionName: event.sessionName,
        stopReason: event.stopReason,
      }),
    /**
     * The same notification, from the turn the resident process opened by
     * itself — the one path that can say *what* opened it.
     *
     * Kept as its own seam rather than widened onto `notifyBackgroundWork`
     * because the two are not the same report: the per-run one describes work
     * that finished after a turn this dispatch already knew about, and this one
     * describes a turn nobody asked for. Sharing `notifyBackgroundWorkCompleted`
     * is what makes them arrive at the client identically, which is the
     * behaviour a user watching the session wants; carrying the trigger through
     * is what keeps them distinguishable on the wire.
     */
    notifyUnattendedWork: (event) =>
      reportBackgroundWorkCompleted({
        userId: event.userId,
        provider: event.provider,
        sessionId: event.sessionId,
        sessionName: event.sessionName,
        trigger: event.trigger,
      }),
    /**
     * Whether a browser is connected, read from the registry that owns the set.
     *
     * This is the port shape the driver already takes, fed from the shared
     * `connected-clients` accessor. The websocket state module installs its own
     * `Set.size` as that accessor's implementation, and `server/index.ts` names
     * the installation in the composition root; this module never imports the
     * websocket module. The alternative — a leaf import of
     * `websocket-state.service.js` — worked only because that leaf imports
     * almost nothing, but it still held the `providers/list/claude -> websocket`
     * edge that kept the two modules' initialization order coupled. The shared
     * accessor removes the edge outright: neither module can constrain the
     * other's evaluation.
     *
     * Read at call time rather than captured, so the answer is the connection
     * count when a human-facing request actually arrives — a resident turn can
     * outlive the page that opened it, and the whole point of the reading is that
     * nobody is watching *now*.
     */
    connectedClientCount: () => readConnectedClientCount(),
  });

  /**
   * The same instance, held under its own type.
   *
   * `hostDriver` is the shared facet every provider mounts, so it is typed as
   * `IProviderHostDriver` and the driver's own verbs — the busy-input readings
   * and the withdrawal entry — are not on it. The dispatch reaches those
   * through a structural check on the instance, which is the right reading at
   * that layer (it must work for a provider that has no such verb) but the
   * wrong one here: at the mount site the concrete class is known, and a second
   * field is what says so without a cast back from the interface. Both fields
   * are the one object, so a verb added to the class is reachable both ways.
   */
  readonly hostDriver: IProviderHostDriver = this.residentHostDriver;

  constructor() {
    super('claude');
  }
}
