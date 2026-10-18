// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DesignIcon, DsButton } from '../src/renderer/src/components/ui'

afterEach(cleanup)
const themes = readFileSync(resolve('src/renderer/src/tokens.css'), 'utf8').split('@media (prefers-color-scheme: dark)')
function declaration(theme: string, name: string) {
  const pattern = new RegExp(`--ds-${name}:\\s*([^;]+);`, 'i')
  const match = pattern.exec(theme) ?? pattern.exec(themes[0])
  expect(match, `${name} 应有明确的主题定义`).not.toBeNull()
  return match![1].trim()
}
function color(theme: string, name: string) {
  return declaration(theme, name).replace(/var\(--ds-text-rgb\)/g, () => declaration(theme, 'text-rgb')).toLowerCase()
}
function channels(value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return [...[1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16)), 1]
  expect(value).toMatch(/^rgba\([\d.,\s]+\)$/)
  return value.match(/[\d.]+/g)!.map(Number)
}
function luminance(channels: number[]) {
  const rgb = channels.slice(0, 3).map(value => value / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}
function contrast(a: string, b: string) {
  const foreground = channels(a), background = channels(b)
  const composite = foreground.slice(0, 3).map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3]))
  const values = [luminance(composite), luminance(background)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('Staithe 中性主题与图标契约', () => {
  it('全局禁用 focus 与 focus-visible 外轮廓，覆盖浏览器和组件规则但不重置选中态或阴影', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const rule = /:focus\s*,\s*:focus-visible\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(rule).toBeDefined()
    expect(rule).toMatch(/outline:\s*none\s*!important;/)
    expect(rule).not.toMatch(/background:|box-shadow:|border:|pointer-events:/)
    expect(styles).toMatch(/\.session-card\.selected\s*\{[^}]*background: var\(--ds-on-surface-active\);/)
  })
  it('搜索列表项使用 12px 圆角，不改变搜索框及主列表圆角', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.search-result\s*\{[^}]*border-radius: var\(--ds-radius-md\);/)
    expect(declaration(themes[0], 'radius-md')).toBe('calc(12px * var(--ds-corner-radius-scale, 1))')
    expect(styles).toMatch(/\.search\s*\{[^}]*border-radius: var\(--ds-radius-md\);/)
    expect(styles).toMatch(/\.session-card\s*\{[^}]*border-radius: var\(--ds-radius-md\);/)
  })
  it.each(themes.map((css, index) => ({ css, name: index ? '深色' : '浅色' })))('$name 的表面和常规文字均为中性灰', ({ css }) => {
    for (const token of ['surface-100', 'surface-200', 'surface-300', 'surface-400', 'text-primary', 'text-secondary', 'text-tertiary', 'icon']) {
      const value = channels(color(css, token))
      expect(value[0], token).toBe(value[1])
      expect(value[1], token).toBe(value[2])
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
    for (const token of ['text-primary', 'text-secondary']) {
      expect(contrast(color(css, token), color(css, 'surface-300')), token).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('三档文字共用主题基色，仅以 88%／65%／40% 的 alpha 区分，不改按钮与语义颜色', () => {
    for (const [index, theme] of themes.entries()) {
      const base = index ? '255, 255, 255' : '0, 0, 0'
      expect(declaration(theme, 'text-rgb')).toBe(base)
      for (const [level, alpha] of [['primary', 0.88], ['secondary', 0.65], ['tertiary', 0.4]] as const) {
        expect(declaration(theme, `text-${level}`)).toBe(`rgba(var(--ds-text-rgb), ${alpha})`)
        expect(color(theme, `text-${level}`)).toBe(`rgba(${base}, ${alpha})`)
      }
    }
    expect(themes[1]).not.toMatch(/--ds-text-(?:primary|secondary|tertiary):/)
    expect(color(themes[0], 'danger')).toBe('#b64a34')
    expect(color(themes[1], 'danger')).toBe('#e56555')
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
  it('空占位直接使用全局 tertiary，不叠加局部透明度或场景色阶', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const base = /\.empty-state\s*\{([^}]*)\}/.exec(styles)![1]
    expect(base).toContain('color: var(--ds-text-tertiary);')
    expect(base).toContain('font-weight: 400;')
    expect(base).not.toMatch(/opacity:|filter:/)
    expect(styles).not.toMatch(/--empty-(?:title|description)-color|data-empty-tone/)
    for (const selector of ['.empty-state h3', '.empty-state-hero h2']) {
      const rule = styles.slice(styles.indexOf(`${selector} {`)).split('}')[0]
      expect(rule).toContain('color: var(--ds-text-tertiary);')
      expect(rule).toContain('font-weight: 400;')
      expect(rule).not.toContain('var(--ds-text-primary)')
    }
    const description = /\.empty-description\s*\{([^}]*)\}/.exec(styles)![1]
    expect(description).toContain('color: var(--ds-text-tertiary);')
    const action = /\.empty-state > \.ds-button\s*\{([^}]*)\}/.exec(styles)![1]
    expect(action).not.toMatch(/color:|background:/)
    expect(action).toContain('font-weight: 400;')
    expect(action).not.toMatch(/opacity:|filter:|outline:/)
  })
  it('空占位在所属区域居中，仅空容器参与弹性布局并保留溢出滚动', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.empty-state\s*\{[^}]*flex-shrink: 0;/)
    expect(styles).toContain('.detail > .empty-state { margin: auto; }')
    expect(styles).toContain('.detail:has(> .empty-state) { overflow-y: auto; }')
    expect(styles).toContain('.session-list:has(> .empty-state:only-child)')
    expect(styles).toContain('.messages:has(> .message-column > .empty-state:only-child)')
    expect(styles).toMatch(/\.session-list > \.empty-state:only-child,[^{]*\.message-column:has\(> \.empty-state:only-child\)\s*\{[^}]*margin-block: auto;/)
    expect(styles).toContain('.dialog-content:has(> .empty-state:only-child)')
    expect(styles).toContain('.ds-dialog:has(> .search-header) { height: min(500px, calc(100dvh - 64px)); }')
    expect(styles).toMatch(/\.search-content\s*\{[^}]*flex: 1;[^}]*min-height: 0;/)
    expect(styles).toMatch(/\.search-results\s*\{[^}]*flex: 1;[^}]*min-height: 0;[^}]*overflow: auto;/)
    expect(styles).toContain('.search-results:empty { display: none; }')
    expect(styles).not.toContain('.search-content:has(> .empty-state)')
    expect(styles).toContain('.dialog-content > .empty-state { margin: auto; }')
    expect(styles).not.toMatch(/\.empty-state(?:-hero|-quiet)?\s*\{[^}]*(?:position: absolute|height: 100vh|justify-content: center)/)
  })
  it('大占位插画与标题小幅缩小，保留弱对比度、描述及其他插画尺寸', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const illustration = /\.empty-illustration\s*\{([^}]*)\}/.exec(styles)![1]
    expect(illustration).toContain('opacity: 0.5;')
    expect(illustration).toContain('filter: saturate(0.4);')
    expect(illustration).toContain('width: 120px;')
    expect(styles).toMatch(/\.empty-state-hero \.empty-illustration\s*\{[^}]*width: 184px;/)
    expect(styles).toMatch(/@media \(max-height: 700px\)\s*\{\s*\.empty-state-hero \.empty-illustration\s*\{[^}]*width: 144px;/)
    expect(styles).toMatch(/\.empty-state-hero h2\s*\{[^}]*font-size: 16px;/)
    expect(styles).toMatch(/\.empty-description\s*\{[^}]*font-size: var\(--ds-text-sm\);/)
    expect(styles).not.toMatch(/\.empty-state[^}]*pointer-events: none;/)
  })
  it('空占位标题与描述紧凑为 4px，不改变插画和行动间距', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.empty-state\s*\{[^}]*gap: 10px;/)
    expect(styles).toMatch(/\.empty-state-hero\s*\{[^}]*gap: 12px;/)
    expect(styles).toMatch(/\.empty-state h3 \+ \.empty-description\s*\{[^}]*margin-top: -6px;/)
    expect(styles).toMatch(/\.empty-state-hero h2 \+ \.empty-description\s*\{[^}]*margin-top: -8px;/)
    expect(styles).toMatch(/\.empty-state > \.ds-button\s*\{[^}]*margin-top: 6px;/)
  })
  it.each(themes.map((css, index) => ({ css, name: index ? '深色' : '浅色' })))('$name 全局 tertiary 作为弱辅助色，与正文和次要文字明确分级', ({ css }) => {
    for (const surface of ['surface-100', 'surface-200', 'surface-300']) {
      const background = color(css, surface)
      const muted = contrast(color(css, 'text-tertiary'), background)
      expect(muted, surface).toBeGreaterThanOrEqual(2.5)
      expect(muted, surface).toBeLessThan(4.5)
      expect(muted, surface).toBeLessThan(contrast(color(css, 'text-secondary'), background))
      expect(muted, surface).toBeLessThan(contrast(color(css, 'text-primary'), background))
    }
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
  it('侧栏拖拽高亮上下透明渐隐，避开工作区圆角且保留完整命中区域', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const handle = /\.sidebar-resize-handle\s*\{([^}]*)\}/.exec(styles)![1]
    const highlight = /\.sidebar-resize-handle::after\s*\{([^}]*)\}/.exec(styles)![1]
    expect(handle).toContain('top: 0;')
    expect(handle).toContain('bottom: 0;')
    expect(handle).toContain('width: 6px;')
    expect(highlight).toContain('top: var(--ds-radius-lg);')
    expect(highlight).toContain('bottom: calc(8px + var(--ds-radius-lg));')
    expect(highlight).toContain('width: 2px;')
    expect(highlight).toContain('background: linear-gradient(to bottom, transparent, var(--ds-text-tertiary) 16px, var(--ds-text-tertiary) calc(100% - 16px), transparent);')
    expect(highlight).toContain('opacity: 0;')
    expect(styles).toMatch(/\.sidebar-resize-handle:hover::after, \.sidebar-resize-handle:focus-visible::after, \.sidebar\[data-resizing='true'\] \.sidebar-resize-handle::after\s*\{[^}]*opacity: 1;/)
  })
  it('会话栏有独立的全高拖拽区域，渐隐高亮避开圆角且拖拽时持续显示', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const handle = /\.session-resize-handle\s*\{([^}]*)\}/.exec(styles)?.[1]
    const highlight = /\.session-resize-handle::after\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(handle).toContain('width: 6px;')
    expect(handle).toContain('touch-action: none;')
    expect(handle).toContain('-webkit-app-region: no-drag;')
    expect(highlight).toContain('top: var(--ds-radius-lg);')
    expect(highlight).toContain('bottom: var(--ds-radius-lg);')
    expect(highlight).toContain('linear-gradient(to bottom, transparent, var(--ds-text-tertiary) 16px, var(--ds-text-tertiary) calc(100% - 16px), transparent)')
    expect(styles).toMatch(/\.session-pane\[data-resizing='true'\] \.session-resize-handle::after\s*\{[^}]*opacity: 1;/)
  })
  it('UI 文案默认不可选中，仅正文、代码、交接预览及编辑区域允许选择', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/body\s*\{[^}]*-webkit-user-select: none;[^}]*user-select: none;/)
    expect(styles).toMatch(/body \*\s*\{[^}]*-webkit-user-select: inherit;[^}]*user-select: inherit;/)
    for (const selector of ['.message-body p', '.code-block pre', '.handoff-preview', 'input', 'textarea', '[contenteditable="true"]', '[contenteditable="plaintext-only"]']) {
      const rule = styles.split('}').find(rule => rule.split('{')[0].split(',').some(value => value.trim() === selector) && rule.includes('user-select: text;'))
      expect(rule, selector).toBeDefined()
      expect(rule).toContain('-webkit-user-select: text;')
    }
  })
  it.each([
    { file: 'App.tsx', titles: ['import-title', 'handoff-title'] },
    { file: 'SourceApp.tsx', titles: ['connections-title', 'target-title'] },
    { file: 'components/ConnectSourcesDialog.tsx', titles: ['connect-title'] },
  ])('$file 的全部常规弹窗使用共享标题组件，不再自行拼装标题图标', ({ file, titles }) => {
    const source = readFileSync(resolve('src/renderer/src', file), 'utf8')
    expect(source).not.toContain('className="dialog-header')
    expect(source).not.toContain('dialog-icon')
    expect(source.match(/<DsDialogHeader\b/g)).toHaveLength(titles.length)
    for (const title of titles) expect(source).toContain(`<DsDialogHeader titleId="${title}"`)
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).not.toMatch(/\.dialog-icon\s*\{/)
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
