import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-report.json' }]],
  timeout: 30_000,
  // 先由 Playwright 结束并写报告，再由 step / job 的更大预算兜底；不放宽单用例超时。
  globalTimeout: process.env.CI ? 25 * 60_000 : undefined,
})
