import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    'process.env.GOOSE_TUNNEL': JSON.stringify(
      process.env.OPENDUCK_TUNNEL !== 'no' &&
        process.env.OPENDUCK_TUNNEL !== 'none' &&
        process.env.GOOSE_TUNNEL !== 'no' &&
        process.env.GOOSE_TUNNEL !== 'none'
    ),
  },

  plugins: [tailwindcss()],

  // Vite caches a copy of @openduck/sdk and doesn't notice when we rebuild it
  // locally, so it serves stale code until you clear node_modules/.vite by hand.
  // Excluding it makes Vite always read the latest ui/sdk/dist build.
  // Dev-server only — release builds ignore optimizeDeps.
  optimizeDeps: {
    exclude: ['@openduck/sdk'],
  },

  build: {
    target: 'esnext'
  },
});
