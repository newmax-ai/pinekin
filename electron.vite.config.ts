import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  // CSP 只允许同源字体：字体始终输出为文件，不内联成 data: URL；其他资源沿用 Vite 默认阈值。
  renderer: { plugins: [react()], build: { assetsInlineLimit: file => file.endsWith('.woff2') ? false : undefined } },
})
