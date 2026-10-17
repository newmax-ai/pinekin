// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DesignIcon, DsButton } from '../src/renderer/src/components/ui'

afterEach(cleanup)
const themes = readFileSync(resolve('src/renderer/src/tokens.css'), 'utf8').split('@media (prefers-color-scheme: dark)')
function color(theme: string, name: string) {
  const match = new RegExp(`--ds-${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(theme)
  expect(match, `${name} 应有明确的六位颜色值`).not.toBeNull()
  return match![1].toLowerCase()
}
function luminance(hex: string) {
  const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('Staithe 中性主题与图标契约', () => {
  it.each(themes.map((css, index) => ({ css, name: index ? '深色' : '浅色' })))('$name 的表面和常规文字均为中性灰', ({ css }) => {
    for (const token of ['surface-100', 'surface-200', 'surface-300', 'surface-400', 'text-primary', 'text-secondary', 'text-tertiary', 'icon']) {
      const value = color(css, token)
      expect(value.slice(1, 3), token).toBe(value.slice(3, 5))
      expect(value.slice(3, 5), token).toBe(value.slice(5, 7))
    }
  })
  it('主按钮浅色黑底白字、深色白底黑字，不改变品牌强调色', () => {
    expect(color(themes[0], 'action-primary')).toBe('#171717')
    expect(color(themes[0], 'action-primary-text')).toBe('#ffffff')
    expect(color(themes[1], 'action-primary')).toBe('#ffffff')
    expect(color(themes[1], 'action-primary-text')).toBe('#171717')
    expect(color(themes[0], 'brand-primary')).toBe('#315fca')
    expect(color(themes[1], 'brand-primary')).toBe('#86a8f8')
  })
  it.each(themes.map((css, index) => ({ css, name: index ? '深色' : '浅色' })))('$name 的主按钮及小字保持可读对比度', ({ css }) => {
    expect(contrast(color(css, 'action-primary'), color(css, 'action-primary-text'))).toBeGreaterThanOrEqual(4.5)
    for (const token of ['text-primary', 'text-secondary', 'text-tertiary']) {
      expect(contrast(color(css, token), color(css, 'surface-300')), token).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('操作按钮显式标记胶囊，不依赖 iconOnly 推断是否为圆', () => {
    const { container } = render(<><DsButton>普通操作</DsButton><DsButton iconOnly aria-label="图标操作"><DesignIcon name="search" /></DsButton></>)
    for (const button of container.querySelectorAll('button')) {
      expect(button.getAttribute('data-ds-pill-control')).toBe('true')
      expect(button.hasAttribute('data-ds-round-control')).toBe(false)
    }
  })
  it('mini 按钮由基础组件提供统一尺寸契约，不泄漏原生 size 属性', () => {
    const { container } = render(<><DsButton size="mini" variant="ghost" iconOnly aria-label="mini 搜索"><DesignIcon name="search" /></DsButton><DsButton>普通操作</DsButton></>)
    const mini = screen.getByRole('button', { name: 'mini 搜索' })
    expect(mini.classList.contains('ds-button-mini')).toBe(true)
    expect(mini.classList.contains('ds-button-icon')).toBe(true)
    expect(mini.getAttribute('data-ds-pill-control')).toBe('true')
    expect(mini.hasAttribute('size')).toBe(false)
    expect(container.querySelectorAll('.ds-button-mini')).toHaveLength(1)
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.ds-button-mini\s*\{[^}]*height: 24px;[^}]*padding: 0 8px;/)
    expect(styles).toMatch(/\.ds-button-mini\s*\{[^}]*width: auto;/)
    expect(styles).toMatch(/\.ds-button-mini \.design-icon\s*\{[^}]*width: 14px;[^}]*height: 14px;/)
    expect(styles).not.toMatch(/\.(?:brand \.search-trigger|header-navigation \.ds-button|topbar-actions \.ds-button|search \.ds-button)\s*\{/)
  })
  it('small relaxed 复用 small 规格，纯图标保留文字按钮内边距且不泄漏组件属性', () => {
    const { container } = render(<><DsButton size="small" variant="ghost" iconOnly iconRelaxed aria-label="small 搜索"><DesignIcon name="search" /></DsButton><DsButton size="small" iconOnly aria-label="紧凑图标"><DesignIcon name="close" /></DsButton><DsButton size="small">小号文字</DsButton></>)
    const relaxed = screen.getByRole('button', { name: 'small 搜索' })
    expect(relaxed.classList.contains('ds-button-small')).toBe(true)
    expect(relaxed.classList.contains('ds-button-icon-relaxed')).toBe(true)
    expect(relaxed.classList.contains('ds-button-icon')).toBe(true)
    expect(relaxed.hasAttribute('size')).toBe(false)
    expect(relaxed.hasAttribute('iconRelaxed')).toBe(false)
    expect(container.querySelectorAll('.ds-button-small')).toHaveLength(3)
    expect(container.querySelectorAll('.ds-button-icon-relaxed')).toHaveLength(1)
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.ds-button-small\s*\{[^}]*height: 28px;[^}]*padding: 0 10px;/)
    expect(styles).toMatch(/\.ds-button-icon-relaxed\s*\{[^}]*width: auto;/)
    expect(styles).toMatch(/\.ds-button-small \.design-icon\s*\{[^}]*width: 15px;[^}]*height: 15px;/)
    expect(styles).toMatch(/\.ds-button-small\.ds-button-icon:not\(\.ds-button-icon-relaxed\)\s*\{[^}]*width: 28px;[^}]*padding: 0;/)
  })
  it('顶部三个导航按钮间距统一为 1px，不再给侧栏按钮单独加留白', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.header-navigation\s*\{[^}]*gap: 1px;/)
    expect(styles).not.toMatch(/\.header-navigation \.sidebar-toggle\s*\{[^}]*margin-left:/)
  })
  it('顶部导航由容器垂直居中，不靠单边偏移，macOS 与 Windows 各自保持等距留白', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.window-toolbar\s*\{[^}]*height: 38px;[^}]*align-items: center;/)
    expect(styles).toMatch(/\.window-controls-space\s*\{[^}]*height: 100%;/)
    expect(styles).toMatch(/\.shell\[data-platform='win32'\] \.window-toolbar\s*\{[^}]*height: 32px;/)
    expect(styles).not.toMatch(/\.window-toolbar \.header-navigation\s*\{[^}]*margin-top:/)
  })
  it('会话栏标题与列表正文共用对齐线，无演示筛选留白，两处列表间距均为 1px', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.topbar\s*\{[^}]*padding-left: 20px;/)
    expect(styles).toMatch(/\.list-heading\s*\{[^}]*padding: 16px 20px 12px;/)
    expect(styles).not.toContain('.scope-filter')
    expect(styles).not.toContain('.archive-badge.demo')
    expect(styles).toMatch(/\.session-list\s*\{[^}]*padding: 4px 8px 12px;/)
    expect(styles).toMatch(/\.session-card\s*\{[^}]*padding: 8px 12px;[^}]*margin: 0 0 1px;/)
    expect(styles).toMatch(/\.nav-item\s*\{[^}]*margin-bottom: 1px;/)
  })
  it('会话卡片纵向紧凑，标题字重 400 且最多两行', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.card-meta\s*\{[^}]*line-height: 16px;[^}]*margin-bottom: 4px;/)
    expect(styles).toMatch(/\.session-card h3\s*\{[^}]*font-weight: 400;[^}]*line-height: 1\.5;[^}]*-webkit-line-clamp: 2;/)
    expect(styles).not.toMatch(/\.session-card\.selected h3\s*\{[^}]*font-weight:/)
  })
  it('标题下不显示横向分割线，保留列表与阅读区的竖向边界', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    for (const selector of ['.topbar', '.list-heading', '.detail-header']) {
      const rule = styles.slice(styles.indexOf(`${selector} {`)).split('}')[0]
      expect(rule).not.toMatch(/box-shadow:|border(?:-bottom)?:/)
    }
    expect(styles).not.toContain('.topbar h1')
    expect(styles).toMatch(/\.session-pane\s*\{[^}]*border-right: 1px solid var\(--ds-divider\);/)
  })
  it('右侧底部操作栏不显示分割线，保留按钮间距与其他区域边界', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const footer = /\.detail-footer\s*\{([^}]*)\}/.exec(styles)![1]
    expect(footer).not.toMatch(/border(?:-top)?:|box-shadow:/)
    expect(footer).toContain('padding: 12px 24px;')
    expect(footer).toContain('gap: 12px;')
    expect(styles).toMatch(/\.dialog-footer\s*\{[^}]*border-top: 1px solid var\(--ds-divider\);/)
    expect(styles).toMatch(/\.session-pane\s*\{[^}]*border-right: 1px solid var\(--ds-divider\);/)
  })
  it('档案末尾文字和短线共用淡化至 60% 的 tertiary，不改变间距或全局颜色', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const marker = /\.conversation-end\s*\{([^}]*)\}/.exec(styles)![1]
    expect(marker).toContain('color: color-mix(in srgb, var(--ds-text-tertiary) 60%, transparent);')
    expect(marker).toContain('gap: 12px;')
    expect(marker).toContain('margin: 32px 0 0;')
    expect(marker).not.toContain('--ds-text-tertiary:')
    expect(styles).toMatch(/\.conversation-end span\s*\{[^}]*width: 32px;[^}]*border-top: 1px solid currentColor;/)
  })
  it('会话来源选中不加粗，仅保留背景与文字颜色反馈', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).not.toMatch(/\.nav-item\.active\s*\{[^}]*font-weight:/)
    expect(styles).toMatch(/\.nav-item\.active\s*\{[^}]*background: var\(--ds-on-surface\);[^}]*color: var\(--ds-text-primary\);/)
  })
  it('来源名称单行裁切且仅溢出文字渐隐，数量固定且拖拽边界不参与窗口拖动', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.ds-fade-text\s*\{[^}]*white-space: nowrap;[^}]*text-overflow: clip;/)
    expect(styles).toMatch(/\.ds-fade-text\[data-overflow='true'\]\s*\{[^}]*mask-image:/)
    expect(styles).toContain('var(--fade-overflow-width, 16px)')
    expect(styles).toMatch(/\.count\s*\{[^}]*flex-shrink: 0;/)
    expect(styles).toMatch(/\.sidebar-resize-handle\s*\{[^}]*width: 6px;[^}]*touch-action: none;[^}]*-webkit-app-region: no-drag;/)
  })
  it('统一使用 Lucide 图标并保留尺寸与按钮可访问名称', () => {
    const { container } = render(<DsButton aria-label="搜索档案" iconOnly><DesignIcon name="search" size={20} /></DsButton>)
    const icon = container.querySelector('svg')!
    expect(icon.classList.contains('lucide')).toBe(true)
    expect(icon.getAttribute('width')).toBe('20')
    expect(icon.getAttribute('stroke-width')).toBe('1.75')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('button', { name: '搜索档案' })).toBeTruthy()
  })
})
