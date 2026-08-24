6import path from 'path';
import { defineConfig } from 'vite';

/**
 * Runner config for the model-parity eval harness (evals/). Vitest is used
 * only as a TS executor with the repo path aliases; there are no assertions
 * worth gating CI on. Never add this to `npm test`.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['evals/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60 * 1000,
    fileParallelism: false,
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      '@/lib': path.resolve(__dirname, './lib'),
      '@/components': path.resolve(__dirname, './components'),
      '@/app': path.resolve(__dirname, './app'),
      '@/types': path.resolve(__dirname, './types'),
    },
  },
});
