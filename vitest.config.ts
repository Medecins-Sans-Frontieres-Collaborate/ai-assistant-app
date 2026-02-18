import path from 'path';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'app/**',
        'components/**',
        'context/**',
        'hooks/**',
        'pages/**',
        'services/**',
        'types/**',
        'utils/**',
      ],
      exclude: [
        'node_modules/**',
        'dist/**',
        'docs/**',
        'k8s/**',
        'public/**',
        'scripts/**',
        'styles/**',
        '__tests__/**',
        '*.config.js',
        '*.config.ts',
        '*.json',
        '.*rc.json',
        'coverage/**',
        '**/__tests__/**',
      ],
    },
  },
});
