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
    ],
    environment: 'node',
    setupFiles: ['./vitest.setup.node.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['lib/**/*.ts', 'app/**/*.ts', 'client/**/*.ts', 'config/**/*.ts'],
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
