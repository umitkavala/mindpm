import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
  server: {
    // Dev only: start mindpm with MINDPM_UI_TOKEN set and the same value
    // here. The proxy presents the server's own origin and the token, since
    // the Vite-served page doesn't carry the token meta tag.
    proxy: {
      '/api': {
        target: 'http://localhost:3131',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            req.setHeader('origin', 'http://localhost:3131');
            if (process.env.MINDPM_UI_TOKEN) req.setHeader('x-mindpm-token', process.env.MINDPM_UI_TOKEN);
          });
        },
      },
    },
  },
});
