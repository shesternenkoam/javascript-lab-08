import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    __GIT_SHA__: JSON.stringify(process.env.GIT_SHA || process.env.GITHUB_SHA || 'v1.0.0-ship'),
    __APP_VERSION__: JSON.stringify('v1.0.0'),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
