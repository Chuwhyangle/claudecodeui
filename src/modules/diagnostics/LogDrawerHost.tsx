import { useEffect, useMemo } from 'react';

import { installLogDrawerPort, type LogDrawerOpenFilter } from '@/shared/ports/log-drawer.port';

import LogDrawer, { type LogDrawerActions } from '@/modules/diagnostics/LogDrawer';
import { useLogDrawer, type UseLogDrawerOptions } from '@/modules/diagnostics/useLogDrawer';

/**
 * The one mount point of the global log drawer.
 *
 * It owns no rule: `useLogDrawer` supplies the controller snapshot, this file
 * installs the drawer opener into the shared port on mount (and disposes it on
 * unmount, which makes `isLogDrawerAvailable` false again), and renders the
 * presentational drawer only while it is open.
 *
 * Consumers: `src/App.tsx` and the drawer criterion.
 */
export type LogDrawerHostProps = UseLogDrawerOptions;

export default function LogDrawerHost({ api, writeClipboard, pollIntervalMs }: LogDrawerHostProps) {
  const { snapshot, controller } = useLogDrawer({
    ...(api === undefined ? {} : { api }),
    ...(writeClipboard === undefined ? {} : { writeClipboard }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  });

  // The port is installed for as long as this host is mounted. Returning the
  // disposer from the effect is what makes an unmounted page fail closed.
  useEffect(() => installLogDrawerPort((filter: LogDrawerOpenFilter) => {
    controller.open(filter);
    return true;
  }), [controller]);

  const actions = useMemo<LogDrawerActions>(() => ({
    onClose: () => controller.close(),
    onSource: (source) => controller.setSource(source),
    onLevel: (level) => controller.setLevel(level),
    onSearch: (search) => controller.setSearch(search),
    onFollow: (follow) => controller.setFollow(follow),
    onLoadEarlier: () => controller.loadEarlier(),
    onCopy: () => controller.copyBundle(),
    onRefresh: () => controller.refresh(),
  }), [controller]);

  if (!snapshot.open) return null;
  return <LogDrawer snapshot={snapshot} actions={actions} />;
}
