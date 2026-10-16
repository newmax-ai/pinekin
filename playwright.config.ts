import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1,
  reporter: 'list', timeout: 30_000,
})
