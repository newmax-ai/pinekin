import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts', 'src/main/{library,imports,import-file,cindy,cindy-local,newmax-local,newmax-application,claude-code,deepseek,codex,codex-zstd,zip,window-options,app-icon,local-import,source-browser,source-actions,source-transfer,codex-target,codex-target-format,codex-target-runtime,codex-target-ipc,codex-target-setup,codex-project,codex-project-catalog,source-discovery,source-sqlite,cindy-source-query,source-conversation,source-reader,source-read-window,source-log-file,source-log-index,source-log-reader,source-log-inspect,source-activity,source-origin,qwen-source,workbuddy-source,workbuddy-metadata}.ts', 'src/renderer/src/**/*.tsx'],
      exclude: ['src/core/types.ts'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
})
