import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts', 'src/main/{library,imports,import-file,cindy,cindy-local,newmax-local,claude-code,deepseek,codex,codex-zstd,zip,window-options,app-icon,local-import,source-browser,source-discovery,source-sqlite}.ts', 'src/renderer/src/**/*.tsx'],
      exclude: ['src/core/types.ts'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
})
