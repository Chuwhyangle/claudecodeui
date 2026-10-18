import { useEffect, useState } from 'react';

/**
 * A clock that advances once a second while a row is drawing elapsed time.
 *
 * The sidebar's shared `currentTime` moves once a minute — enough for session
 * ages, too coarse for a running turn's elapsed label. A running row is the
 * only consumer here, so the tick lives with the row and stops the moment the
 * session stops processing (the returned value is then the mount-time reading,
 * which nothing draws).
 */
export function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);

    return () => window.clearInterval(timer);
  }, [active]);

  return now;
}
