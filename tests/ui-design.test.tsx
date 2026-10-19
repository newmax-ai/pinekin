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
  it('列表更新浮层悬停及按下时保持不透明，不覆盖其他按钮的交互反馈', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const floating = /\.ds-button\.source-list-update:not\(:disabled\):is\(:hover, :active, :focus-visible\)\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(floating).toBeDefined()
    expect(floating).toContain('opacity: 1;')
    expect(floating).toContain('background: var(--ds-surface-300);')
    expect(styles).toContain('.ds-button:not(.ds-button-ghost):hover:not(:disabled) { opacity: 0.8; }')
  })
  it('详情标签紧跟标题 8px，右上角主操作不收缩且窄阅读区允许换行', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.detail-title-group\s*\{[^}]*display: flex;[^}]*align-items: center;[^}]*gap: 8px;[^}]*min-width: 0;/)
    expect(styles).toMatch(/\.detail-title-row\s*\{[^}]*flex-wrap: wrap;/)
    expect(styles).toMatch(/\.detail-title-row > \.ds-button\s*\{[^}]*flex-shrink: 0;[^}]*margin-left: auto;[^}]*padding: 0 16px;/)
    expect(styles).not.toContain('.detail-footer .ds-button-primary')
  })
  it('详情元信息以居中的小圆点分隔，首项无分隔符且不再使用竖线', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const item = /\.detail-meta > :not\(:first-child\)\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(item).toBeDefined()
    expect(item).not.toMatch(/border-left:|padding-left:/)
    expect(item).toMatch(/display: inline-flex;[^}]*align-items: center;[^}]*gap: 8px;/)
    expect(styles).toMatch(/\.detail-meta\s*\{[^}]*gap: 4px 8px;/)
    const dot = /\.detail-meta > :not\(:first-child\)::before\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(dot).toBeDefined()
    expect(dot).toMatch(/content: '';[^}]*width: 2px;[^}]*height: 2px;/)
    expect(styles).toMatch(/\.detail-meta\s*\{[^}]*margin-top: 2px;/)
    const count = /\.detail-message-count\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(count).toMatch(/flex-shrink: 0;[^}]*font-variant-numeric: tabular-nums;/)
    expect(count).not.toMatch(/(?:^|[;\s])(?:width|min-width|flex-basis):/)
    expect(dot).toContain('flex-shrink: 0;')
    expect(dot).toContain('border-radius: 50%;')
    expect(dot).toContain('background: currentColor;')
  })
  it('所有来源共用固定 App 卡片网格，位置仅在卡片内部排列而不另起一组', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.ds-dialog:has\(> \.connection-header\)\s*\{[^}]*width: 920px;/)
    expect(styles).toMatch(/\.connection-app-list\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 240px\), 1fr\)\);[^}]*gap: 12px;/)
    expect(styles).not.toContain('.connection-saved-list')
    expect(styles).not.toContain('.connection-section-title')
    const card = /\.connection-source-card\s*\{([^}]*)\}/.exec(styles)![1]
    expect(card).not.toMatch(/(?:min-|max-)?height:/)
    expect(card).toContain('flex: 1;')
    expect(card).toContain('border: 1px solid var(--ds-divider);')
    expect(styles).toMatch(/\.connection-app-list > li\s*\{[^}]*display: flex;/)
    // 所有隐式网格行共用最大内容高度，而非仅在各行内拉伸。
    expect(styles).toMatch(/\.connection-app-list\s*\{[^}]*grid-auto-rows: 1fr;/)
    expect(styles).toMatch(/\.connection-app-list\s*\{[^}]*align-items: stretch;/)
    expect(styles).toMatch(/\.connection-location\s*\{[^}]*gap: 8px;/)
    expect(styles).toMatch(/\.connection-location-name\s*\{[^}]*text-overflow: ellipsis;/)
  })
  it('连接描述贴近标题，不保留地区工具栏，标题和关闭按钮顶部对齐', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.dialog-heading\s*\{[^}]*min-width: 0;/)
    expect(styles).toMatch(/\.connection-description\s*\{[^}]*margin-top: 4px;/)
    expect(styles).toMatch(/\.connection-header > \.ds-button\s*\{[^}]*align-self: flex-start;/)
    expect(styles).not.toContain('.connection-toolbar')
  })
  it('连接弹窗以自然内容决定高度，不预设 760px 或最小高度，仅溢出时内部滚动', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const dialog = /\.ds-dialog:has\(> \.connection-header\)\s*\{([^}]*)\}/.exec(styles)![1]
    expect(dialog).not.toMatch(/(?:^|[;\s])(?:min-)?height:/)
    expect(dialog).not.toContain('760px')
    const content = /\.connection-content\s*\{([^}]*)\}/.exec(styles)![1]
    expect(content).toContain('flex: 1;')
    expect(content).toContain('scrollbar-gutter: stable;')
    const item = /\.connection-app-list > li\s*\{([^}]*)\}/.exec(styles)![1]
    expect(item).not.toMatch(/(?:min-|max-)?height:/)
  })
  it('移除列表上方反馈及留白，尺寸过渡仅作用于连接弹窗且尊重减少动态效果', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).not.toContain('.connection-feedback')
    const dialog = /\.ds-dialog:has\(> \.connection-header\)\s*\{([^}]*)\}/.exec(styles)![1]
    expect(dialog).toMatch(/transition:[^;]*height 180ms[^;]*max-width 180ms[^;]*max-height 180ms/)
    expect(dialog).not.toContain('transition: all')
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?transition: none !important;/)
  })
  it('重试进度不参与布局，旧描述仅隐形保留自然高度，不设固定大占位', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const summary = /\.connection-summary\s*\{([^}]*)\}/.exec(styles)![1]
    expect(summary).toContain('position: relative;')
    const pending = /\.connection-summary\[data-pending='true'\] > \.connection-intro\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(pending).toContain('visibility: hidden;')
    expect(pending).not.toMatch(/display: none|height:|position: absolute/)
    const progress = /\.connection-summary-progress\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(progress).toMatch(/position: absolute;[^}]*inset: 0;/)
    expect(progress).not.toMatch(/(?:^|[;\s])(?:min-|max-)?height:/)
  })
  it('位置和错误撑开卡片，由弹窗内容区滚动，small 开关规格不变', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const switches = readFileSync(resolve('src/renderer/src/components/DsSwitch.css'), 'utf8')
    const summary = /\.connection-summary\s*\{([^}]*)\}/.exec(styles)![1]
    expect(summary).toContain('min-height: 22px;')
    expect(summary).not.toMatch(/(?:^|[;\s])height:/)
    expect(styles).toMatch(/\.connection-summary\[data-notice='true'\] > \.connection-intro\s*\{[^}]*line-height: 18px;[^}]*white-space: pre-wrap;[^}]*overflow: visible;/)
    expect(styles).toMatch(/\.connection-summary > \.connection-intro\s*\{[^}]*line-height: 22px;/)
    expect(styles).not.toContain('.connection-state')
    expect(styles).not.toContain('.connection-feedback')
    const info = /\.connection-inline-info\s*\{([^}]*)\}/.exec(styles)![1]
    expect(info).not.toMatch(/(?:^|[;\s])(?:(?:min-|max-)?height|overflow|flex):/)
    expect(styles).toMatch(/\.dialog-content\s*\{[^}]*overflow: auto;/)
    expect(styles).not.toContain('.connection-details')
    expect(styles).not.toMatch(/\.connection-progress\s*\{/)
    expect(switches).toMatch(/\.ds-switch-small\s*\{[^}]*width: 28px;[^}]*height: 16px;[^}]*padding: 2px;/)
    expect(switches).toMatch(/\.ds-switch-small \.ds-switch-thumb\s*\{[^}]*width: 12px;[^}]*height: 12px;/)
    expect(switches).toMatch(/\.ds-switch-small\[aria-checked='true'\] \.ds-switch-thumb\s*\{[^}]*translateX\(12px\)/)
  })
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
    expect(styles).toMatch(/\.session-card h3\s*\{[^}]*font-weight: 400;[^}]*line-height: 1\.5;/)
    expect(styles).toMatch(/\.ds-fade-text\[data-lines='2'\]\s*\{[^}]*white-space: normal;[^}]*max-height: 3em;/)
    expect(styles).not.toMatch(/\.session-card h3\s*\{[^}]*-webkit-line-clamp:/)
    expect(styles).not.toMatch(/\.session-card\.selected h3\s*\{[^}]*font-weight:/)
  })
  it('两行标题末行右侧以 64px 明显渐隐，首行不受遮罩且不影响单行名称', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const mask = /\.ds-fade-text\[data-lines='2'\]\[data-overflow='true'\]\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(mask).toContain('linear-gradient(black, black) top / 100% calc(100% - 1.5em) no-repeat')
    expect(mask).toContain('linear-gradient(to right, black calc(100% - var(--fade-overflow-width, 64px)), transparent) bottom / 100% 1.5em no-repeat')
    expect(styles).toMatch(/\.ds-fade-text\[data-overflow='true'\]\s*\{[^}]*var\(--fade-overflow-width, 16px\)/)
    expect(mask).toContain('-webkit-mask:')
    expect(mask).toContain('mask:')
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
    const dialogFooter = /\.dialog-footer\s*\{([^}]*)\}/.exec(styles)![1]
    expect(dialogFooter).not.toMatch(/border(?:-top)?:|box-shadow:/)
    expect(dialogFooter).toContain('justify-content: flex-end;')
    expect(dialogFooter).toContain('padding: 18px 24px 24px;')
    expect(styles).not.toContain('.dialog-footer.connection-footer')
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
    { file: 'SourceApp.tsx', titles: ['target-title'] },
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
