import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    setupFiles: ['test/setup.js'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js', 'public/overlay-core.js'],
      exclude: ['src/main.js'],
      thresholds: { lines: 80, branches: 80 },
      reporter: ['text', 'html'],
    },
  },
});
