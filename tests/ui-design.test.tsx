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
  it('文字 Logo 使用本地打包的品牌字体子集，去掉末尾圆点且不发起在线字体请求', async () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const face = /@font-face\s*\{[^}]*font-family:\s*'Pinekin Wordmark'[^}]*\}/.exec(styles)?.[0]
    expect(face).toContain("url('./assets/fonts/pinekin-wordmark.woff2') format('woff2')")
    expect(face).toContain('font-display: swap')
    expect(styles).toMatch(/\.brand-logo \{[^}]*font-family: 'Pinekin Wordmark', var\(--ds-font-ui\);/)
    expect(styles).not.toMatch(/\.brand-dot|https?:\/\/[^)'"]*\.(?:woff2?|ttf|otf)/)
    for (const file of ['src/renderer/src/App.tsx', 'src/renderer/src/SourceApp.tsx']) {
      expect(readFileSync(resolve(file), 'utf8')).toContain('<span className="brand-logo">pinekin</span>')
    }
    expect(readFileSync(resolve('src/renderer/src/assets/fonts/OFL.txt'), 'utf8')).toContain('SIL Open Font License, Version 1.1')
    // CSP 只允许同源字体，小字体也不能被 Vite 内联成 data: URL。
    const { default: config } = await import('../electron.vite.config')
    const limit = (config as { renderer: { build: { assetsInlineLimit: (file: string, content: Buffer) => boolean | undefined } } }).renderer.build.assetsInlineLimit
    expect(limit('/x/assets/fonts/pinekin-wordmark.woff2', Buffer.alloc(1488))).toBe(false)
    expect(limit('/x/assets/icon.svg', Buffer.alloc(100))).toBeUndefined()
  })
  it('来源和档案详情仅将下沿渐隐加高至 160px，不启用常驻遮挡', () => {
    for (const file of ['src/renderer/src/App.tsx', 'src/renderer/src/SourceApp.tsx']) {
      const source = readFileSync(resolve(file), 'utf8')
      const viewport = /<ScrollArea ref=\{messagesViewport\}[^>]*>/.exec(source)?.[0]
      expect(viewport).toContain('bottomFadeSize={160}')
      expect(viewport).not.toContain('bottomOverlayHeight')
    }
  })
  it('滚动到底部按钮保持居中，并与详情底边留出 48 px 空间', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const button = /\.scroll-to-bottom\.ds-button\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(button).toContain('bottom: 48px;')
    expect(button).toContain('left: 50%;')
    expect(button).toContain('transform: translateX(-50%);')
  })
  it('滚动到底部按钮交互保持不透明，仅箭头播放一次轻微下移动画', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const interaction = /\.ds-button\.scroll-to-bottom:not\(:disabled\):is\(:hover, :active, :focus-visible\)\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(interaction).toContain('opacity: 1;')
    const motion = /\.scroll-to-bottom:not\(:disabled\):is\(:hover, :focus-visible\) > \.design-icon\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(motion).toContain('animation: scroll-to-bottom-nudge 420ms var(--ds-ease-swift) 1;')
    expect(motion).not.toContain('infinite')
    expect(styles).toMatch(/@keyframes scroll-to-bottom-nudge\s*\{\s*0%, 100%\s*\{\s*transform: translateY\(0\);\s*\}\s*50%\s*\{\s*transform: translateY\(3px\);/)
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^]*?animation: none !important;/)
  })
  it('详情长标题仅在悬停或键盘聚焦时慢滚一次，延迟启动并尊重减少动态效果', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const track = /\.ds-fade-text\[data-scroll-on-hover='true'\] > \.ds-fade-text-content\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(track).toContain('display: inline-block;')
    expect(track).toContain('width: max-content;')
    expect(track).not.toContain('animation:')
    const motion = /\.ds-fade-text\[data-scroll-on-hover='true'\]\[data-overflow='true'\]:is\(:hover, :focus-visible\) > \.ds-fade-text-content\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(motion).toContain('animation: ds-fade-text-scroll var(--fade-scroll-duration) linear 200ms 1 both;')
    expect(motion).not.toContain('infinite')
    expect(styles).toMatch(/@keyframes ds-fade-text-scroll\s*\{[^]*?transform: translateX\(calc\(-1 \* var\(--fade-scroll-distance\)\)\)/)
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion: reduce\)\s*\{[^]*?animation: none !important;/)
  })
  it('详情标题仅显示一行并复用溢出渐隐 mask，不绘制省略号或强制遮住短标题', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const title = /\.detail-header h2\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(title).toContain('display: block;')
    expect(title).toContain('white-space: nowrap;')
    expect(title).toContain('overflow: hidden;')
    expect(title).toContain('text-overflow: clip;')
    expect(title).toContain('--fade-overflow-width: 32px;')
    expect(title).not.toMatch(/line-clamp|text-overflow:\s*ellipsis|mask-image:/)
    expect(styles).toMatch(/\.ds-fade-text\[data-overflow='true'\]\s*\{[^}]*mask-image: linear-gradient/)
  })
  it('详情全部消息角色共用中文断行和尾行优化，而非只作用于助手', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const body = /\.message-body\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(body).toContain('line-break: strict;')
    expect(body).toContain('word-break: auto-phrase;')
    expect(body).toContain('text-wrap: pretty;')
    expect(styles).toMatch(/\.message-body p\s*\{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: break-word;/)
    expect(styles).toMatch(/@supports not \(word-break: auto-phrase\)\s*\{\s*\.detail-header h2, \.message-body\s*\{\s*word-break: keep-all;/)
    expect(readFileSync(resolve('src/renderer/index.html'), 'utf8')).toContain('<html lang="zh-CN">')
  })
  it('Markdown 标题及正文沿用中文排版，但代码明确退出短语断行和尾行重排', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/MessageContent.css'), 'utf8')
    const prose = /\.message-markdown\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(prose).toContain('overflow-wrap: break-word;')
    expect(styles).toMatch(/\.message-markdown :is\(h1, h2, h3, h4, h5, h6\)\s*\{[^}]*text-wrap: balance;/)
    const inline = /\.message-markdown \.markdown-inline-code\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(inline).toContain('line-break: auto;')
    expect(inline).toContain('word-break: normal;')
    expect(inline).toContain('text-wrap: wrap;')
    expect(inline).toContain('overflow-wrap: anywhere;')
    const code = /\.message-markdown \.code-block :is\(pre, code\)\s*\{([^}]*)\}/.exec(styles)?.[1]
    for (const rule of ['white-space: pre;', 'overflow-wrap: normal;', 'word-break: normal;', 'line-break: auto;', 'text-wrap: nowrap;']) expect(code).toContain(rule)
  })
  it('读取说明段落使用严格中文断行和尾行优化，长路径仍可应急换行', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/SourceReadNotes.css'), 'utf8')
    const paragraph = /\.source-read-notes p\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(paragraph).toContain('line-break: strict;')
    expect(paragraph).toContain('word-break: normal;')
    expect(paragraph).toContain('text-wrap: pretty;')
    expect(styles).toMatch(/\.source-read-notes\s*\{[^}]*overflow-wrap: anywhere;/)
    expect(styles).toMatch(/\.source-read-notes-raw\s*\{[^}]*white-space: pre-wrap;/)
    expect(paragraph).not.toMatch(/word-break:\s*(break-all|keep-all)|white-space:\s*nowrap/)
  })
  it('读取说明折叠入口使用普通圆角列表行，向外扩展背景并以等量内边距保持文字对齐', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/SourceReadNotes.css'), 'utf8')
    const row = /\.source-read-notes-details > \.source-read-notes-toggle\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(row).toContain('border-radius: var(--ds-radius-md);')
    expect(row).toContain('corner-shape: var(--ds-corner-shape);')
    expect(row).toContain('padding: 8px 12px;')
    expect(row).toContain('margin-inline: -12px;')
    expect(row).toContain('width: calc(100% + 24px);')
    expect(row).toContain('height: auto;')
    expect(row).toContain('min-height: 36px;')
    expect(row).toContain('justify-content: space-between;')
    expect(row).not.toMatch(/radius-pill|padding-inline:\s*0|position:\s*absolute/)
    expect(styles).not.toMatch(/\.source-read-notes-raw\s*\{[^}]*margin-inline:/)
  })
  it('更换 App 保持卡片体量和等高圆角，改用无边框 tertiary 表面及交互反馈', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/SourceActions.css'), 'utf8')
    const shared = /\.source-target-card, \.source-target-change\s*\{([^}]*)\}/.exec(styles)?.[1]
    for (const rule of ['padding: 12px 14px;', 'border-radius: var(--ds-radius-md);']) expect(shared).toContain(rule)
    const selected = /\.source-target-list\[data-selected='true'\]\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(selected).toContain('align-items: stretch;')
    const change = /(?:^|\n)\.source-target-change\s*\{([^}]*)\}/.exec(styles)?.[1]
    for (const rule of ['height: 100%;', 'width: auto;', 'justify-content: center;', 'white-space: nowrap;', 'border: 0;', 'background: var(--ds-action-subtle-surface);', 'color: var(--ds-action-subtle-text);']) expect(change).toContain(rule)
    expect(change).not.toMatch(/radius-pill|font-size:|font-weight:/)
    expect(styles).toMatch(/\.source-target-change:is\(:hover, :focus-visible\):not\(:disabled\)\s*\{\s*opacity: 0\.8;/)
    expect(styles).toMatch(/\.source-target-change:active:not\(:disabled\)\s*\{\s*opacity: 0\.7;/)
    expect(styles).not.toMatch(/, \.source-target-change(?::disabled|:is\([^\n]+\))[^\n]*\{[^}]*background:/)
  })
  it('接续设置路径复用中性表面与等宽字体，可选择复制且长路径自然换行', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/SourceActions.css'), 'utf8')
    const path = /\.source-target-setting-path\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(path).toContain('background: var(--ds-surface-300);')
    expect(path).toContain('border-radius: var(--ds-radius-sm);')
    expect(path).toContain('color: var(--ds-text-primary);')
    expect(path).toContain('font-family: var(--ds-font-mono);')
    expect(path).toContain('overflow-wrap: anywhere;')
    expect(path).toContain('white-space: pre-wrap;')
    expect(path).toContain('user-select: text;')
    expect(path).not.toMatch(/#[0-9a-f]|text-overflow: ellipsis|(?:^|[;\s])(?:min-|max-)?height:/i)
    expect(styles).toMatch(/\.source-target-setting-path\[hidden\]\s*\{\s*display: none;/)
    const heading = /\.source-target-setting-heading\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(heading).toContain('display: flex;')
    expect(heading).toContain('flex-wrap: wrap;')
    expect(heading).toContain('justify-content: space-between;')
    expect(heading).toContain('align-items: center;')
  })
  it('应用折叠图标复用 DS Chevron 和动效令牌，键盘聚焦可见且减少动态效果覆盖过渡', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/SourceActions.css'), 'utf8')
    expect(styles).toMatch(/\.source-target-program-toggle > \.design-icon\s*\{[^}]*transition: transform var\(--ds-motion-swift\);/)
    expect(styles).toMatch(/\.source-target-program-toggle\[aria-expanded='true'\] > \.design-icon\s*\{[^}]*transform: rotate\(90deg\);/)
    expect(styles).toMatch(/\.source-target-program-toggle:focus-visible:not\(:disabled\)\s*\{[^}]*background: var\(--ds-on-surface\);/)
    expect(styles).not.toContain('.source-target-program code')
    expect(readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^]*?transition: none !important;/)
  })
  it('列表更新浮层悬停及按下时保持不透明，不覆盖其他按钮的交互反馈', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const floating = /\.ds-button\.source-list-update:not\(:disabled\):is\(:hover, :active, :focus-visible\)\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(floating).toBeDefined()
    expect(floating).toContain('opacity: 1;')
    expect(floating).toContain('background: var(--ds-surface-300);')
    expect(styles).toContain('.ds-button:not(.ds-button-ghost):hover:not(:disabled) { opacity: 0.8; }')
  })
  it('会话切换加载期间禁用操作但保持按钮不透明，避免明暗闪烁且不改全局禁用样式', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/SourceActions.css'), 'utf8')
    const pending = /\.source-actions-buttons\[aria-busy='true'\] > \.ds-button:disabled\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(pending).toContain('opacity: 1;')
    expect(pending).not.toMatch(/pointer-events:|cursor:|display:|visibility:/)
    expect(styles).not.toMatch(/(?:^|\n)\.ds-button:disabled\s*\{/)
  })
  it('文件交接复用右对齐操作栏，不保留已移除的目标弹窗布局', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/SourceActions.css'), 'utf8')
    const actions = /\.source-actions-buttons\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(actions).toContain('justify-content: flex-end;')
    expect(actions).toContain('gap: 6px;')
    expect(styles).not.toContain('source-handoff-footer')
    expect(styles).not.toContain('source-handoff-body')
  })
  it('菜单复用设计系统的轻微缩放淡入淡出，退场期间不接收鼠标交互', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const enter = /\.ds-menu\s*\{([^}]*)\}/.exec(styles)?.[1]
    const exit = /\.ds-menu\[data-state='closing'\]\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(enter).toContain('animation: ds-dialog-enter 180ms cubic-bezier(0.16, 1, 0.3, 1) both;')
    expect(enter).toContain('transform-origin: top left;')
    expect(exit).toContain('animation: ds-dialog-exit 140ms cubic-bezier(0.4, 0, 1, 1) both;')
    expect(exit).toContain('pointer-events: none;')
  })
  it('会话操作菜单的图标与文字垂直居中，使用统一的 8px 间距与图标色', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/SourceActions.css'), 'utf8')
    const item = /\.source-actions-menu button\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(item).toContain('display: flex;')
    expect(item).toContain('align-items: center;')
    expect(item).toContain('gap: 8px;')
    const icon = /\.source-actions-menu button > \.design-icon\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(icon).toContain('color: var(--ds-icon);')
    expect(icon).toContain('flex-shrink: 0;')
  })
  it('复制按钮使用原文案占位锁定宽高，操作通知与更新提示共用居中白底胶囊', () => {
    const actions = readFileSync(resolve('src/renderer/src/components/SourceActions.css'), 'utf8')
    expect(actions).toMatch(/\.source-copy-label\s*\{[^}]*display: grid;[^}]*place-items: center;/)
    expect(actions).toMatch(/\.source-copy-label > span\s*\{[^}]*grid-area: 1 \/ 1;/)
    expect(actions).toMatch(/\.source-copy-size\s*\{[^}]*visibility: hidden;/)
    expect(actions).not.toMatch(/\.source-actions-feedback\s*\{/)
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const feedback = /\.source-content-update > \.ds-toast-surface\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(feedback).toContain('border: 0;')
    expect(feedback).toContain('background: var(--ds-surface-100);')
    expect(feedback).toContain('box-shadow: var(--ds-floating-card-shadow);')
    expect(styles).toMatch(/\.ds-toast-surface \.source-update-label\s*\{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/)
    for (const theme of themes) {
      const shadow = declaration(theme, 'floating-card-shadow')
      expect(shadow).toContain('0.5px')
      expect(shadow.split(/,(?![^()]*\))/).length).toBeGreaterThan(1)
    }
  })
  it('带关闭图标的 Toast 单独收紧右侧留白，不改变文字间距或关闭按钮点击区域', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const compact = /\.source-content-update > \.ds-toast-surface:has\(> \.ds-button-icon\)\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(compact).toBeDefined()
    expect(compact).toContain('padding-right: 6px;')
    expect(compact).not.toMatch(/(?:width|height|gap|padding-left|padding-top|padding-bottom|transform|animation):/)
    const surface = /(?:^|\n)\.ds-toast-surface\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(surface).toContain('gap: 8px;')
  })
  it('正文更新胶囊相对消息区域绝对定位，顶部居中并保留边距，不随正文滚动或撑开布局', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const region = /\.source-messages-region\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(region).toContain('position: relative;')
    expect(region).toContain('display: flex;')
    expect(region).toContain('flex-direction: column;')
    expect(region).toContain('flex: 1;')
    expect(region).toContain('min-height: 0;')
    expect(region).toContain('min-width: 0;')
    const overlay = /\.source-content-update\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(overlay).toContain('position: absolute;')
    expect(overlay).toContain('z-index: 2;')
    expect(overlay).toContain('top: 16px;')
    expect(overlay).toContain('left: 50%;')
    expect(overlay).toContain('transform: translateX(-50%);')
    expect(overlay).toContain('width: max-content;')
    expect(overlay).toContain('max-width: calc(100% - 48px);')
    const button = /\.source-content-update > \.ds-toast-surface\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(button).toContain('max-width: 100%;')
    expect(button).toContain('height: auto;')
    expect(button).toContain('min-height: 32px;')
    expect(button).toContain('padding: 8px 14px;')
    expect(button).toContain('white-space: normal;')
    expect(button).toContain('border: 0;')
    expect(button).toContain('background: var(--ds-surface-100);')
    expect(button).toContain('color: var(--ds-text-primary);')
    expect(button).toContain('box-shadow: var(--ds-floating-card-shadow);')
    expect(button).not.toMatch(/var\(--ds-(?:action-primary|surface-300)/)
    expect(color(themes[0], 'surface-100')).toBe('#ffffff')
    const interaction = /\.ds-toast-surface > \.ds-toast-action:not\(:disabled\):is\(:hover, :active, :focus-visible\)\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(interaction).toContain('opacity: 1;')
    expect(interaction).toContain('background: transparent;')
    for (const theme of themes) {
      expect(contrast(color(theme, 'text-primary'), color(theme, 'surface-100'))).toBeGreaterThanOrEqual(7)
      const shadow = declaration(theme, 'floating-card-shadow')
      expect(shadow).toContain('0.5px')
      expect(shadow.split(/,(?![^()]*\))/).length).toBeGreaterThanOrEqual(3)
    }
    expect(declaration(themes[0], 'floating-card-shadow')).toContain('0 24px 15px')
  })
  it('Toast 文字与卡片共用整体进退场，文字层没有独立位移、淡入或宽度过渡', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const labels = /\.source-update-labels\s*\{([^}]*)\}/.exec(styles)?.[1]
    const label = /\.source-update-label\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(labels).toBeDefined()
    expect(label).toBeDefined()
    for (const layer of [labels, label]) expect(layer).not.toMatch(/(?:animation|transition|transform):/)
    expect(styles).not.toContain('source-update-label-enter')
    expect(styles).toMatch(/\.source-content-update\s*\{[^}]*animation: source-update-enter var\(--ds-motion-swift\);/)
    expect(styles).toMatch(/\.source-content-update\[data-state='closing'\]\s*\{[^}]*animation: source-update-exit 140ms/)
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion: reduce\)\s*\{[^]*?animation: none !important; transition: none !important;/)
  })
  it('更多菜单与更新胶囊共用白色表面和浮层阴影，以单层 0.5px 半透明轮廓增强边缘而非 border', () => {
    const menuStyles = readFileSync(resolve('src/renderer/src/components/SourceActions.css'), 'utf8')
    const contentStyles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const menu = /\.source-actions-menu\s*\{([^}]*)\}/.exec(menuStyles)?.[1]
    const capsule = /\.source-content-update > \.ds-toast-surface\s*\{([^}]*)\}/.exec(contentStyles)?.[1]
    for (const card of [menu, capsule]) {
      expect(card).toContain('border: 0;')
      expect(card).toContain('background: var(--ds-surface-100);')
      expect(card).toContain('box-shadow: var(--ds-floating-card-shadow);')
      expect(card).not.toMatch(/border:\s*1px|background:\s*var\(--ds-surface-200\)/)
    }
    expect(color(themes[0], 'surface-100')).toBe('#ffffff')
    for (const theme of themes) {
      const shadow = declaration(theme, 'floating-card-shadow')
      expect(shadow).toMatch(/^0 0 0 0\.5px rgba\(var\(--ds-text-rgb\), 0\.12\), /)
      expect(shadow.match(/0 0 0 0\.5px/g)).toHaveLength(1)
      expect(shadow).not.toContain('inset')
    }
  })
  it('详情标签紧跟标题 8px，右上角主操作不收缩且窄阅读区允许换行', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.detail-title-group\s*\{[^}]*display: flex;[^}]*align-items: center;[^}]*gap: 8px;[^}]*min-width: 0;/)
    expect(styles).toMatch(/\.detail-title-row\s*\{[^}]*flex-wrap: wrap;/)
    expect(styles).toMatch(/\.detail-title-row > \.ds-button\s*\{[^}]*flex-shrink: 0;[^}]*margin-left: auto;[^}]*padding: 0 16px;/)
    expect(styles).not.toContain('.detail-footer .ds-button-primary')
  })
  it('来源描述和日期保持紧凑相邻，数字使用自然宽度且不靠拉伸描述把日期推到右端', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const row = /\.source-detail-meta\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(row).toContain('display: grid;')
    expect(row).toContain('grid-template-columns: max-content minmax(0, max-content) max-content;')
    expect(row).not.toContain('1fr')
    expect(row).toContain('min-height: 18px;')
    const number = /\.source-detail-number\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(styles).not.toContain('--source-meta-number-width')
    expect(number ?? '').not.toMatch(/(?:width|min-width|max-width|inline-size|display|text-align):/)
    const summary = /\.source-detail-summary\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(summary).toContain('min-width: 0;')
    const text = /\.source-detail-summary-text\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(text).toContain('overflow: hidden;')
    expect(text).toContain('text-overflow: ellipsis;')
    expect(text).toContain('white-space: nowrap;')
    expect(styles).toMatch(/\.source-detail-meta > time\s*\{[^}]*font-variant-numeric: tabular-nums;[^}]*white-space: nowrap;/)
  })
  it('来源标题按单行预留紧凑操作高度，不再保留两行标题空白', () => {
    const styles = readFileSync(resolve('src/renderer/src/components/SourceActions.css'), 'utf8')
    const group = /\.source-detail-header \.detail-title-group\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(group).toContain('min-height: 32px;')
    expect(group).toContain('align-items: center;')
    expect(group).toContain('padding-top: 0;')
    expect(group).not.toContain('50px')
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
  it('记录末尾不再保留提示文字或两侧装饰线样式', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    expect(/^\.conversation-end\s*\{/m.test(styles)).toBe(false)
    expect(/\.conversation-ending > \.conversation-end\s*\{/.test(styles)).toBe(false)
    expect(/\.conversation-end::(?:before|after)/.test(styles)).toBe(false)
  })
  it('底部保持紧凑，完整松林向上溢出作为正文背后的背景，不裁切树梢', () => {
    const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const ending = /\.conversation-ending\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(ending).toContain('position: relative;')
    expect(ending).toContain('height: clamp(200px, 22vw, 260px);')
    expect(ending).toContain('width: calc(100% + 48px);')
    expect(ending).toContain('margin: 24px -24px -24px;')
    expect(ending).toContain('place-items: start center;')
    expect(ending).toContain('padding: 20px 0 0;')
    expect(ending).toContain('overflow: visible;')
    expect(ending).toContain('isolation: isolate;')
    expect(ending).not.toMatch(/min-height:|gap:/)
    const content = /\.messages > \.message-column\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(content).toContain('position: relative;')
    expect(content).toContain('z-index: 1;')
    const illustration = /\.conversation-end-illustration\s*\{([^}]*)\}/.exec(styles)?.[1]
    expect(illustration).toContain('width: 100%;')
    expect(illustration).toContain('position: absolute;')
    expect(illustration).toContain('left: 0;')
    expect(illustration).toContain('bottom: 0;')
    expect(illustration).toContain('height: auto;')
    expect(illustration).toContain('aspect-ratio: 5 / 2;')
    expect(illustration).toContain('z-index: -1;')
    expect(illustration).not.toMatch(/object-fit: cover|height: 100%|inset: 0/)
    expect(illustration).toContain('opacity: 0.28;')
    expect(illustration).toContain('mask-image: linear-gradient(to right, transparent, black 8%, black 92%, transparent), linear-gradient(to bottom, transparent, black 14%, black 78%, transparent);')
    expect(illustration).toContain('mask-composite: intersect;')
    expect(illustration).toContain('pointer-events: none;')
    expect(illustration).not.toMatch(/animation:|transition:|mix-blend-mode:|max-width: 320px/)
    expect(styles).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*\.conversation-end-illustration\s*\{[^}]*filter: invert\(1\);[^}]*opacity: 0.22;/)
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
