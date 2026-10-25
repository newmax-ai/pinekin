import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const rule = (selector: string) => styles.slice(styles.indexOf(`${selector} {`)).split('}')[0]

describe('隐私卡片的跨平台文案预算', () => {
  const note = rule('.storage-note')
  const responsive = /--storage-illustration-size: clamp\((\d+)px, calc\(100cqi - (\d+)px\), (\d+)px\)/.exec(note)!
  const imageSize = (sidebar: number) => Math.min(Number(responsive[3]), Math.max(Number(responsive[1]), sidebar - Number(responsive[2])))

  it('240px 侧栏给九字描述保留至少 108px，不靠裁切或缩字号', () => {
    expect(responsive).not.toBeNull()
    expect(rule('.sidebar-bottom')).toContain('padding: 12px 12px 16px;')
    expect(note).toContain('padding: 6px 0 6px 12px;')
    expect(note).toContain('gap: 4px;')
    expect(240 - 24 - 12 - 4 - imageSize(240)).toBeGreaterThanOrEqual(108)
    expect(rule('.storage-description')).toContain('font-size: var(--ds-text-xs);')
    expect(rule('.storage-description')).not.toMatch(/nowrap|overflow:\s*hidden|ellipsis/)
  })
  it.each([280, 360])('%ipx 侧栏仍保留 100px 完整插画', width => {
    expect(imageSize(width)).toBe(100)
  })
  it.each([180, 200, 240])('%ipx 侧栏插画仍有独立的至少 56px 空间', width => {
    expect(imageSize(width)).toBeGreaterThanOrEqual(56)
    expect(note).toContain('grid-template-columns: minmax(0, 1fr) var(--storage-illustration-size);')
  })
})
