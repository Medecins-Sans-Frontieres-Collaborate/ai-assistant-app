import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    globals: true,
    include: [
      '__tests__/app/**/*.test.ts',
      '__tests__/lib/**/*.test.ts',
      '__tests__/config/**/*.test.ts',
      '__tests__/types/**/*.test.ts',
      '__tests__/client/**/*.test.ts',
      // Source-text design guards. Without this line the file is matched by
      // NEITHER config (jsdom only picks up *.test.tsx under __tests__/components)
      // and would report green by never running at all.
      '__tests__/design/**/*.test.ts',
      // Pure-data tests for components/Limits modules (no DOM) — same
      // matched-by-neither-config trap as the design guards above. Scoped
      // to limits/ because __tests__/components/Chat has a stale .test.ts
      // that predates both configs and does not pass.
      '__tests__/components/limits/**/*.test.ts',
    ],
    environment: 'node',
    setupFiles: ['./vitest.setup.node.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'lib/**/*.ts',
        'app/**/*.ts',
        'client/**/*.ts',
        'config/**/*.ts',
      ],
      exclude: ['node_modules', '__tests__', '**/*.test.ts', '**/*.spec.ts'],
    },
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
