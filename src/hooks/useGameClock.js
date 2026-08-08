import { useEffect, useRef, useState } from 'react';

/**
 * §10.6 — never trust setInterval for elapsed time. A backgrounded tab has its
 * timers throttled or suspended, so counting ticks silently loses minutes. The
 * interval only drives repaints; elapsed time always comes from Date.now().
 */
export function useGameClock(running, baseMs, onTick) {
  const [, force] = useState(0);
  const startedAt = useRef(null);
  const cb = useRef(onTick);
  cb.current = onTick;

  useEffect(() => {
    startedAt.current = running ? Date.now() : null;
    force((n) => n + 1);
  }, [running, baseMs]);

  useEffect(() => {
    if (!running) return undefined;
    const tick = () => {
      force((n) => n + 1);
      cb.current?.(baseMs + (Date.now() - (startedAt.current ?? Date.now())));
    };
    const id = setInterval(tick, 250);
    // Recompute immediately on resume rather than waiting for the next tick.
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [running, baseMs]);

  return running && startedAt.current !== null
    ? baseMs + (Date.now() - startedAt.current)
    : baseMs;
}

/** Keep the screen awake while a game is running, and re-acquire on resume. */
export function useWakeLock(active) {
  const lock = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const acquire = async () => {
      if (!active || !('wakeLock' in navigator)) return;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) {
          sentinel.release();
          return;
        }
        lock.current = sentinel;
      } catch {
        /* denied or unsupported — not worth interrupting the coach over */
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible' && active && !lock.current) acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock.current?.release?.().catch(() => {});
      lock.current = null;
    };
  }, [active]);
}
