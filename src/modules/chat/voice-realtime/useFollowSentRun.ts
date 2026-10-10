import { useCallback, useEffect, useRef } from 'react';

/** How often the transcript is re-read while a delivered voice instruction is being worked on. */
const FOLLOW_INTERVAL_MS = 1_500;
/** How long to wait for the session to START working before concluding the instruction produced no run. */
const START_GRACE_MS = 20_000;
/** Hard stop: a run that is still going after this is no longer followed by polling. */
const MAX_FOLLOW_MS = 15 * 60_000;

/**
 * Keeps the transcript following the run a spoken instruction opened, until that run ends.
 *
 * WHY THIS EXISTS. A voice `session_send` opens its run on the server; no socket of this page is
 * bound to it, so none of the run's streamed frames reach the pane. The pane used to re-read the
 * transcript ONCE, on the `sent` frame — which is the instant the reply has only just begun, so
 * the user saw the first few words of Claude's answer and then nothing, as if it had been cut off.
 * This re-reads on a short interval from the delivery until the session stops working (or never
 * starts), then once more so the finished tail is what stays on screen.
 *
 * `follow()` is called when the server confirms a delivery. `isWorking` is the pane's own reading
 * of "the session is mid-turn"; it is read through a ref so a changing value never restarts the
 * loop. Consumed by `ChatInterface`.
 */
export function useFollowSentRun({
  sessionId,
  isWorking,
  refresh,
}: {
  sessionId: string | null;
  isWorking: boolean;
  refresh: (sessionId: string) => void;
}): { follow: () => void } {
  const workingRef = useRef(isWorking);
  const refreshRef = useRef(refresh);
  const sessionRef = useRef(sessionId);
  // Refs are refreshed after every commit, never during render.
  useEffect(() => {
    workingRef.current = isWorking;
    refreshRef.current = refresh;
    sessionRef.current = sessionId;
  });

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const follow = useCallback(() => {
    const target = sessionRef.current;
    if (!target) {
      return;
    }
    // Deliveries can overlap (a second instruction while the first run is still going):
    // one loop follows them all.
    stop();
    refreshRef.current(target);
    const startedAt = Date.now();
    let sawWorking = false;
    timerRef.current = setInterval(() => {
      // The pane moved to another session: nothing here is worth reading any more.
      if (sessionRef.current !== target) {
        stop();
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (workingRef.current) {
        sawWorking = true;
      }
      refreshRef.current(target);
      const finished = sawWorking && !workingRef.current;
      const neverStarted = !sawWorking && elapsed > START_GRACE_MS;
      if (finished || neverStarted || elapsed > MAX_FOLLOW_MS) {
        // That refresh just issued is the final one: it reads the finished tail.
        stop();
      }
    }, FOLLOW_INTERVAL_MS);
  }, [stop]);

  // Leaving the pane (or switching its session) must not leave a poller behind.
  useEffect(() => {
    stop();
  }, [sessionId, stop]);
  useEffect(() => stop, [stop]);

  return { follow };
}
