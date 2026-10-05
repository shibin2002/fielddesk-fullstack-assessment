import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: path.resolve(__dirname, '..'),
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: './tests/global-setup.ts',
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 40_000,
    hookTimeout: 180_000,
    environment: 'node',
  },
})
