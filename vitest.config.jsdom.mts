import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: {
    jsxInject: `import React from 'react'`,
  },
  test: {
    globals: true,
    include: [
      '__tests__/components/**/*.test.tsx',
      '__tests__/client/**/*.test.{ts,tsx}',
    ],
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.dom.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['components/**/*.tsx', 'client/**/*.tsx', 'lib/**/*.tsx'],
      exclude: ['node_modules', '__tests__', '**/*.test.tsx', '**/*.spec.tsx'],
    },
    css: {
      modules: {
        classNameStrategy: 'non-scoped',
      },
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
  css: {
    // Mock CSS imports in tests
    modules: {
      classNameStrategy: 'non-scoped',
    },
  },
});
