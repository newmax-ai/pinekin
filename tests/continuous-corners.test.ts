import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(resolve(path), 'utf8')
const tokens = read('src/renderer/src/tokens.css')
const styles = read('src/renderer/src/styles.css')
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`).exec(styles)
  expect(match, selector).not.toBeNull()
  return match![1]
}

describe('NewMax 连续圆角规则的独立适配', () => {
  it('默认使用普通圆角和倍率 1，非 full 半径仅补偿一次', () => {
    expect(tokens).toContain('--ds-corner-shape: round;')
    expect(tokens).toContain('--ds-corner-radius-scale: 1;')
    for (const [name, radius] of [['sm', 8], ['md', 12], ['lg', 18], ['tooltip', 10]]) {
      expect(tokens).toContain(`--ds-radius-${name}: calc(${radius}px * var(--ds-corner-radius-scale, 1));`)
    }
    expect(tokens).toContain('--ds-radius-pill: 9999px;')
    for (const [, value] of styles.matchAll(/border-radius:\s*([^;]+);/g)) {
      expect(value).toMatch(/^(?:var\(--ds-radius-(?:sm|md|lg|pill|tooltip)\)|50%)$/)
    }
  })
  it('只在原生支持时启用 1.5 曲率和 1.348 倍率，不沿用旧 squircle 倍率', () => {
    const corners = read('src/renderer/src/corners.css')
    expect(styles).toContain("@import './corners.css';")
    expect(corners).toMatch(/@supports\s*\(corner-shape:\s*superellipse\(1\.5\)\)\s*\{/)
    expect(corners).toContain('--ds-corner-shape: superellipse(1.5);')
    expect(corners).toContain('--ds-corner-radius-scale: 1.348;')
    expect(corners).not.toMatch(/1\.84|corner-shape:\s*squircle/)
    expect(corners).not.toMatch(/clip-path:|mask:|overflow:|box-shadow:/)
  })
  it('伪元素继承实际曲线，胶囊和圆形只豁免本体而非后代', () => {
    const corners = read('src/renderer/src/corners.css')
    expect(corners).toMatch(/::before,\s*::after\s*\{\s*corner-shape:\s*inherit;/)
    expect(corners).toContain('[data-ds-pill-control]')
    expect(corners).toContain('[data-ds-round-control]')
    expect(corners).not.toContain('.local-state i')
    expect(corners).toContain('corner-shape: round;')
    expect(corners).not.toMatch(/\[data-ds-(?:pill|round)-control\]\s+\*/)
    expect(corners).not.toMatch(/--ds-corner-shape:\s*round/)
  })
  it('侧栏无竖线，整个右侧工作区使用 18px 逻辑圆角卡片', () => {
    expect(rule('.sidebar')).not.toMatch(/border-right|box-shadow/)
    expect(rule('.shell')).toContain('background: var(--ds-surface-300);')
    const card = rule('.workspace-card')
    expect(card).toContain('border-radius: var(--ds-radius-lg);')
    expect(card).toContain('overflow: hidden;')
    expect(card).toContain('min-height: 0;')
    expect(card).toContain('margin: 0 8px 8px 0;')
    expect(rule('.sidebar[hidden] + .workspace-card')).toContain('margin-left: 8px;')
    expect(rule('.topbar')).toContain('background: var(--ds-surface-200);')
  })
  it('卡片叠加无偏移无模糊的 0.5px 半透明扩展阴影，并保留原有柔影', () => {
    const shadows = [...tokens.matchAll(/--ds-workspace-shadow:\s*([^;]+);/g)].map(match => match[1])
    expect(shadows).toEqual([
      '0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 0.5px 1px rgba(0, 0, 0, 0.1)',
      '0 0 0 0.5px rgba(255, 255, 255, 0.08), 0 0.5px 1px rgba(0, 0, 0, 0.28)',
    ])
    expect(rule('.workspace-card')).toContain('box-shadow: var(--ds-workspace-shadow);')
  })
  it('工作区卡片独立绘制在侧栏背景上方，保留内容裁切与拖拽手柄层级', () => {
    const card = rule('.workspace-card')
    expect(card).toContain('position: relative;')
    expect(card).toContain('z-index: 1;')
    expect(card).toContain('overflow: hidden;')
    expect(rule('.sidebar-resize-handle')).toContain('z-index: 5;')
  })
  it('操作按钮使用胶囊，导航和档案列表仍使用连续列表圆角', () => {
    expect(rule('.ds-button')).toContain('border-radius: var(--ds-radius-pill);')
    expect(rule('.nav-item')).toContain('border-radius: var(--ds-radius-md);')
    expect(rule('.session-card')).toContain('border-radius: var(--ds-radius-md);')
    expect(rule('.search-result')).toContain('border-radius: var(--ds-radius-sm);')
    expect(styles).not.toContain('.local-state')
  })
})
