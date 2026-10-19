import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['verification/codex-target.contract.ts',
  ...(process.env.PINEKIN_CODEX_TEST_APP ? ['verification/codex-installed-app.contract.ts'] : []),
] } })
