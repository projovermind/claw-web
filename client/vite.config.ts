/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3838',
      '/ws': { target: 'ws://localhost:3838', ws: true }
    }
  },
  build: {
    // Route-level splits (React.lazy in App.tsx) produce per-page chunks.
    // manualChunks below groups heavy shared libs that would otherwise
    // inflate every page chunk they're imported from.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          icons: ['lucide-react'],
          query: ['@tanstack/react-query'],
          dnd: ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          terminal: ['@xterm/xterm', '@xterm/addon-fit'],
          markdown: ['react-markdown', 'rehype-highlight', 'remark-gfm'],
          diff: ['diff'],
          state: ['zustand']
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true
  }
});
