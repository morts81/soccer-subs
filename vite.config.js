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
      includeAssets: ['icon.svg'],
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
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
