import { useCallback, useState } from 'react';
import { Check, Copy, Play, Power, RotateCcw, Zap } from 'lucide-react';
import type { TFunction } from 'i18next';

import {
  findBinding,
  findSessionHost,
  findSessionHostState,
  findSessionOccupancy,
  useSessionHosts,
} from '@/shared/hooks/useSessionHosts';

/** How long the copy control says so before returning to its resting label. */
const COPIED_NOTICE_MS = 1500;

/**
 * Formats an elapsed span the way the uptime line reads it.
 *
 * Coarse on purpose: this is a "since when" hint beside a pid, not a stopwatch.
 */
function formatUptime(startedAt: number | undefined, now: number): string {
  if (!startedAt) {
    return '';
  }

  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  return `${Math.floor(minutes / 60)}h`;
}

/**
 * The resident process's own facts, as the activity dock's expanded panel.
 *
 * This used to be a status bar with a life of its own above the transcript. It
 * drew three things: a busy/idle word for the process, a count of the leases the
 * host was holding, and the process's identity and lifecycle controls. The first
 * two were a *second* answer to "is this session working" — read off a one-second
 * `/api/session-hosts` poll while the activity dock read the server's own frames —
 * and two answers to one question is how a page comes to say "idle" in one place
 * and "busy" in another. They are gone. What the session is doing is the dock's
 * collapsed row, from the dock's one source, and this panel carries only the part
 * the dock cannot know: the address of the process holding the conversation, its
 * pid, and the controls that start, restart and close it.
 *
 * Every fact here comes from `GET /api/session-hosts` — the address, the pid and
 * the close reason included. There is no local mirror of any of them, which is
 * deliberate: this panel's whole subject is a process it does not own, and a
 * cached copy would be able to disagree with the process. The two controls that
 * change that process (`start`, `close`) go through the same hook, so their
 * effect arrives the same way.
 *
 * Nothing is rendered for a session that is not stored `resident`, so a
 * non-resident session's dock has no panel body to show even if it asked for one.
 */
export default function ResidentPanel({
  sessionId,
  t,
}: {
  sessionId: string | null;
  t: TFunction;
}) {
  const { snapshot, error, start, close, forceClose } = useSessionHosts();
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * True while a [start] request is in flight.
   *
   * Opening a resident process spawns a CLI, and a control that looks identical
   * before and during that wait is how a slow start and a refused one both read
   * as "nothing happened". It is published as `data-resident-start-pending` on
   * the control itself rather than folded into anything else, so a client-side
   * wait can never be mistaken for a host state a reader is entitled to trust.
   */
  const [startPending, setStartPending] = useState(false);

  const copyAddress = useCallback(async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const runAction = useCallback(async (action: (id: string) => Promise<void>, id: string): Promise<boolean> => {
    setActionError(null);
    try {
      await action(id);
      return true;
    } catch (error) {
      // The server's refusals are specific (`LIFECYCLE_MODE_NOT_RESIDENT`, a
      // session that does not exist, a host that cannot be reached) and the
      // user's next move differs per case, so the message is shown verbatim
      // rather than replaced with a generic failure.
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  const stateView = sessionId ? findSessionHostState(snapshot, sessionId) : null;

  if (!sessionId || stateView?.lifecycleMode !== 'resident') {
    return null;
  }

  const host = findSessionHost(snapshot, sessionId);
  const binding = findBinding(snapshot, sessionId);
  const address = binding?.peerName ?? '';

  // A background job holds this session, so the resident process is not ours to
  // start: the launch is refused server-side, and a control that can only fail
  // is worse than no control. The refusal's reason and its release command are
  // shown in the composer, on the surface the user is actually typing into.
  const occupied = findSessionOccupancy(snapshot, sessionId) !== null;

  // The process is gone (or was never started), so there is something to start.
  // Read off the record rather than off a busy/idle word: the panel no longer has
  // one, and the control's own condition is the only thing it needs.
  const hostAlive = host !== null && host.state !== 'closed';
  const lastReadFailed = error !== null;

  return (
    <div
      data-resident-panel="true"
      className="w-72 max-w-full rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="mb-2">
        <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
          {t('resident.statusBar.address')}
        </span>
        <span data-resident-address="true" className="block break-all font-mono text-xs">
          {address}
        </span>
      </div>

      {/*
        The pid, and nothing about what the process is *doing*.

        A state word stood here too — the host's own `busy` / `idle` / `exited` —
        and it is exactly what this consolidation took off the page. It was the
        second answer to "is this session working", it was read off the same
        one-second poll as the lease counts, and the answer a reader needs is the
        dock's, from the server's own frames. The pid is the part only this panel
        can give: which process, not what it is up to.
      */}
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span data-resident-pid-text="true">pid {host?.pid ?? '—'}</span>
        <span aria-hidden="true">·</span>
        <span data-resident-uptime="true">{formatUptime(host?.startedAt, Date.now())}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-resident-copy="true"
          disabled={!address}
          onClick={() => void copyAddress(address)}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-40"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t('resident.statusBar.copied') : t('resident.statusBar.copyAddress')}
        </button>

        {!occupied && (!hostAlive || lastReadFailed) ? (
          <button
            type="button"
            data-resident-start="true"
            data-resident-start-pending={startPending ? 'true' : 'false'}
            disabled={startPending}
            onClick={() => {
              setStartPending(true);
              void runAction(start, sessionId).finally(() => setStartPending(false));
            }}
            className="flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 font-medium transition-colors hover:bg-accent/60 disabled:opacity-50"
          >
            {host?.closeReason === 'exited' ? <RotateCcw className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {host?.closeReason === 'exited' ? t('resident.statusBar.restart') : t('resident.statusBar.start')}
          </button>
        ) : null}

        <button
          type="button"
          data-resident-close="true"
          onClick={() => {
            void runAction(close, sessionId);
          }}
          className="flex items-center gap-1 rounded-md border border-red-500/40 px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
        >
          <Power className="h-3 w-3" />
          {t('resident.statusBar.close')}
        </button>

        {/*
          The same close, past the lease gate.

          Two operations, not one with a modifier: the plain close is refused
          (409, `SESSION_HAS_ACTIVE_LEASES`) while the host holds a cron or
          background-task lease, and this one sends `force: true` to close anyway.
          There is deliberately no confirmation step between the two — the plain
          control is the safe one and the server is the thing that refuses, so its
          refusal (shown verbatim below) is the notice, and a dialog here would be
          a second gate in front of a gate. Kept visually distinct (the same red
          family as close, with its own icon and its own label) because it is the
          one control on the panel that discards work the server is unwilling to
          discard on its own.
        */}
        <button
          type="button"
          data-resident-force-close="true"
          onClick={() => {
            void runAction(forceClose, sessionId);
          }}
          className="flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/5 px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
        >
          <Zap className="h-3 w-3" />
          {t('resident.statusBar.forceClose', { defaultValue: 'Force close' })}
        </button>
      </div>

      {/*
        The refusal is drawn under the controls rather than inside a popover that
        only exists while it is open: a start refused with the panel shut is the
        normal case, and a message rendered into a node that was never mounted is
        a message the user never reads.
      */}
      {actionError ? (
        <p
          data-resident-action-error="true"
          className="mt-2 max-w-prose rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 dark:text-red-300"
        >
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
