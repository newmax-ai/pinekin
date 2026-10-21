import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/renderer/src/styles.css', 'utf8')
const tokens = readFileSync('src/renderer/src/tokens.css', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
function rule(selector: string) {
  const start = styles.indexOf(`${selector} {`)
  expect(start, `缺少样式规则 ${selector}`).toBeGreaterThanOrEqual(0)
  return styles.slice(start, styles.indexOf('}', start) + 1)
}

describe('窗口磨砂与不透明内容边界', () => {
  it('平台窗口材质不会被主进程默认实色背景覆盖，安全选项保持启用', () => {
    const start = main.indexOf('new BrowserWindow({')
    const options = main.slice(start, main.indexOf('window.webContents', start))
    expect(options.indexOf("backgroundColor: '#f5f2eb'")).toBeGreaterThan(0)
    expect(options.indexOf("backgroundColor: '#f5f2eb'")).toBeLessThan(options.indexOf('...getWindowChrome(process.platform)'))
    expect(options).toContain('contextIsolation: true, nodeIntegration: false, sandbox: true')
  })

  it('仅 macOS 放开页面底色，外壳只绘制一层轻微半透明底色', () => {
    expect(rule(":root:has(.shell[data-platform='darwin'])")).toContain('background: transparent;')
    expect(rule('.shell')).toContain('background: var(--ds-surface-300);')
    expect(rule(".shell[data-platform='darwin']")).toContain('background: color-mix(in srgb, var(--ds-surface-300) 55%, transparent);')
    for (const selector of ['.sidebar', '.window-toolbar']) {
      expect(rule(selector)).toContain('background: transparent;')
      expect(rule(selector)).not.toMatch(/(?:opacity|backdrop-filter):/)
    }
  })

  it('浅深主题的列表、正文与工具栏保持不透明，不降低子内容透明度', () => {
    for (const selector of ['.workspace-card', '.session-pane', '.detail', '.topbar']) {
      expect(rule(selector)).toContain('background: var(--ds-surface-200);')
      expect(rule(selector)).not.toMatch(/(?:opacity|backdrop-filter):/)
    }
    const surfaces = [...tokens.matchAll(/--ds-surface-200:\s*([^;]+);/g)].map(match => match[1])
    expect(surfaces).toHaveLength(2)
    expect(surfaces.every(value => /^#[0-9a-f]{6}$/i.test(value))).toBe(true)
  })

  it('减少透明效果时外壳恢复实色，不影响内容区布局', () => {
    expect(styles).toMatch(/@media \(prefers-reduced-transparency: reduce\)\s*\{\s*\.shell\[data-platform='darwin'\] \{ background: var\(--ds-surface-300\); \}/)
  })
})
