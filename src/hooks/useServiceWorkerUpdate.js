import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * §10.3 — a home-screen install only ever sees a new build if something asks
 * it to. A service worker that installs quietly in the background sits
 * "waiting" until every open tab closes, which on an installed PWA means the
 * coach force-quitting the app — not something anyone discovers on their own.
 * This surfaces that a build is ready and leaves applying it (a reload) to an
 * explicit tap, never automatic, so it can't cut off a live game.
 */
export function useServiceWorkerUpdate() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const updateRef = useRef(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    updateRef.current = registerSW({
      onNeedRefresh: () => setNeedRefresh(true),
      onRegisteredSW(_url, registration) {
        if (!registration) return;
        // The browser already checks on load; this catches a phone left open
        // and idle through a whole tournament weekend.
        setInterval(() => registration.update(), 60 * 60 * 1000);
      },
    });
  }, []);

  return {
    needRefresh,
    applyUpdate: () => updateRef.current?.(true),
  };
}
