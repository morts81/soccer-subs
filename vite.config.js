import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt', never 'autoUpdate'. A service worker that calls skipWaiting
      // and reloads would destroy a live game mid-match (§10.3). injectRegister
      // is off because the default injected script has no callback surface —
      // useServiceWorkerUpdate registers itself via virtual:pwa-register so the
      // app can show its own "update ready" banner and apply it on request.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Soccer Subs',
        short_name: 'Subs',
        description: 'Fair substitutions and playing time for junior soccer.',
        theme_color: '#16181c',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Separate from the 'any' icons on purpose: the source art bleeds
          // close to the edges (dragon horn, arrow tip), so an Android
          // circular crop needs its own padded version rather than sharing
          // one image for both — see scripts/gen-icons.mjs.
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,woff2}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
