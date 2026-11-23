import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { NcBuildState, NcLeaseInstance } from '@/shared/ncLeaseType';
import { useNcLease } from '@/modules/nclease/hooks/useNcLease';

type SlotTone = 'busy' | 'free' | 'down';

/** Mirrors the server's RELEASE_GRACE_SECONDS: below this the holder is presumed alive. */
const RELEASE_GRACE_SECONDS = 30 * 60;

/**
 * A panel release is always forced (the browser has no ncres owner identity), so
 * the button is only offered for leases that look abandoned: stale, past the
 * grace window, or on a container that is no longer running.
 */
function canRelease(instance: NcLeaseInstance): boolean {
  const lease = instance.lease;
  if (!lease) return false;
  if (instance.probe.state !== 'running') return true;
  return lease.stale || lease.heartbeat_age_s >= RELEASE_GRACE_SECONDS;
}

function slotTone(instance: NcLeaseInstance): SlotTone {
  if (instance.lease) return 'busy';
  return instance.probe.state === 'running' ? 'free' : 'down';
}

const TONE_DOT: Record<SlotTone, string> = {
  busy: 'bg-amber-500',
  free: 'bg-emerald-500',
  down: 'bg-slate-400 dark:bg-slate-600',
};

const TONE_TEXT: Record<SlotTone, string> = {
  busy: 'text-amber-600 dark:text-amber-400',
  free: 'text-emerald-600 dark:text-emerald-400',
  down: 'text-muted-foreground',
};

function toneLabel(instance: NcLeaseInstance, t: TFunction): string {
  const tone = slotTone(instance);
  if (tone === 'busy') return t('ncLease.busy');
  if (tone === 'free') return t('ncLease.free');
  return instance.probe.state === 'exited' ? t('ncLease.exited') : t('ncLease.unknown');
}

/** How the slot's stamped build compares with the newest pre commit. */
function codeLabel(state: NcBuildState | undefined, t: TFunction): string {
  if (!state) return t('ncLease.codeUnmarked');
  if (state.state === 'aligned') return t('ncLease.codeAligned', { sha: state.sha });
  if (state.state === 'behind') return t('ncLease.codeBehind', { sha: state.sha, behind: state.behind });
  if (state.state === 'diverged') return t('ncLease.codeDiverged', { sha: state.sha });
  if (state.state === 'no-pre-head') return t('ncLease.codeNoPreHead', { sha: state.sha });
  return t('ncLease.codeUnmarked');
}

const CODE_TONE: Record<string, string> = {
  aligned: 'text-emerald-600 dark:text-emerald-400',
  behind: 'text-amber-600 dark:text-amber-400',
  diverged: 'text-red-600 dark:text-red-400',
  'no-pre-head': 'text-muted-foreground',
  unmarked: 'text-muted-foreground/70',
};

/**
 * The sidebar's NC-slot row: three dots, a click-to-open panel and a release
 * button per busy slot.
 *
 * Rendered by `SidebarFooter`. Acquiring is deliberately absent — that stays
 * with the AI doing the work; a human only needs to see and release.
 */
export function NcLeaseIndicator() {
  const { t } = useTranslation('common');
  const { status, error, isLoading, releasing, release, reload } = useNcLease();
  // Whether the click-to-open panel is showing; purely local presentation state.
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocumentMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentMouseDown);
    return () => document.removeEventListener('mousedown', onDocumentMouseDown);
  }, [open]);

  const instances = status?.instances ?? [];
  const busyCount = instances.filter((instance) => instance.lease).length;

  return (
    <div ref={rootRef} className="relative px-2 py-1.5">
      <button
        type="button"
        data-testid="nclease-indicator"
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-muted/60"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={error || (status?.degraded ? status.errors.join('; ') : t('ncLease.triggerLabel'))}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">NC</span>
        <span className="flex items-center gap-1.5">
          {instances.map((instance) => (
            <span key={instance.id} className="flex items-center gap-1">
              <span className={cn('h-2 w-2 rounded-full', TONE_DOT[slotTone(instance)])} />
              <span className={cn('text-xs', TONE_TEXT[slotTone(instance)])}>
                {instance.id.slice(-1)}
              </span>
            </span>
          ))}
          {instances.length === 0 && (
            <span className="text-xs text-muted-foreground">{isLoading ? '…' : '?'}</span>
          )}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {busyCount}/{instances.length || 3}
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full left-2 z-50 mb-1 w-72 rounded-xl border border-border bg-card p-2 shadow-lg">
          <div className="flex items-center justify-between px-1 pb-1.5">
            <span className="text-xs font-medium">{t('ncLease.header')}</span>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-muted"
              onClick={(event) => {
                event.stopPropagation();
                void reload();
              }}
              aria-label={t('ncLease.refresh')}
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>

          {(error || status?.degraded) && (
            <div className="mb-1.5 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
              <span className="min-w-0 break-words">{error || status?.errors.join('; ')}</span>
            </div>
          )}

          <div className="space-y-1">
            {instances.map((instance) => (
              <div key={instance.id} className="rounded-lg px-2 py-1.5 hover:bg-muted/50">
                <div className="flex items-center gap-1.5">
                  <span className={cn('h-2 w-2 rounded-full', TONE_DOT[slotTone(instance)])} />
                  <span className="text-xs font-medium">
                    {instance.id.toUpperCase()} · {instance.port}
                  </span>
                  <span className={cn('text-[10px]', TONE_TEXT[slotTone(instance)])}>
                    {toneLabel(instance, t)}
                  </span>
                  {instance.lease && canRelease(instance) && (
                    <button
                      type="button"
                      className="ml-auto rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      disabled={releasing === instance.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void release(instance.id);
                      }}
                    >
                      {releasing === instance.id ? t('ncLease.releasing') : t('ncLease.release')}
                    </button>
                  )}
                  {instance.lease && !canRelease(instance) && (
                    <span
                      className="ml-auto text-[10px] text-muted-foreground"
                      title={t('ncLease.heartbeatOkHint')}
                    >
                      {t('ncLease.heartbeatOk')}
                    </span>
                  )}
                </div>
                {instance.lease ? (
                  <>
                    <div className="mt-0.5 truncate text-[11px]" title={instance.lease.purpose}>
                      {instance.lease.purpose}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {instance.lease.who} · {t('ncLease.heartbeatAge', { seconds: instance.lease.heartbeat_age_s })}
                    </div>
                  </>
                ) : (
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {instance.container}
                  </div>
                )}
                <div
                  className={cn('mt-0.5 truncate text-[10px]',
                    CODE_TONE[instance.build_state?.state ?? 'unmarked'])}
                  title={
                    instance.build?.note
                    || (instance.build?.built_at ? t('ncLease.builtAt', { at: instance.build.built_at }) : undefined)
                  }
                >
                  {codeLabel(instance.build_state, t)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
