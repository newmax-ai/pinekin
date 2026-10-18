// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const states = ['disconnected', 'empty', 'search', 'selection', 'unavailable', 'messages'] as const
const tones = ['paper', 'apricot', 'terracotta', 'ink']
const source = 'design/illustrations/empty-states/source/pinekin-empty-states.png'
const sourceSha256 = createHash('sha256').update(readFileSync(resolve(root, source))).digest('hex')
const readSvg = (state: string) => readFileSync(resolve(root, `src/renderer/src/assets/empty-states/${state}.svg`), 'utf8')
const parse = (text: string) => {
  const document = new DOMParser().parseFromString(text, 'image/svg+xml')
  expect(document.querySelector('parsererror')).toBeNull()
  return document.documentElement
}

interface Provenance {
  source: string
  sourceSha256: string
  sourceDimensions: [number, number]
  state: string
  cell: { index: number; column: number; row: number; columns: number; rows: number; bounds: number[] }
  sourceBounds: number[]
  contentBounds: number[]
  vectorNormalization: { transform: string; tracedBounds: number[] }
  background: { method: string; exteriorPixels: number; interiorPaperPixels: number }
  tracer: string
  parameters: Record<string, string | number>
  preprocessing: { medianFilter: number; targetSize: number; maxContentSize: number }
}

function metadata(svg: Element): Provenance {
  return JSON.parse(svg.querySelector('metadata')!.textContent!) as Provenance
}

describe('Pinekin 空状态插画素材契约', () => {
  it.each(states)('%s 是可追溯、安全、分层的透明曲线 SVG', (state) => {
    const text = readSvg(state)
    const svg = parse(text)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(100 * 1024)
    expect(svg.localName).toBe('svg')
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(svg.getAttribute('viewBox')).toBe('0 0 512 512')
    expect(svg.getAttribute('width')).toBe('512')
    expect(svg.getAttribute('height')).toBe('512')
    expect(svg.querySelector('title')?.textContent).toContain('Pinekin')
    expect(svg.querySelector('desc')?.textContent).toBeTruthy()

    // 重新生成时同样只允许本地、不可执行的矢量内容。
    const allowedElements = new Set(['svg', 'title', 'desc', 'metadata', 'style', 'g', 'path'])
    const allowedAttributes = new Set(['xmlns', 'width', 'height', 'viewBox', 'data-tone', 'fill', 'fill-rule', 'd', 'transform'])
    for (const element of [svg, ...svg.querySelectorAll('*')]) {
      expect(allowedElements.has(element.localName), element.localName).toBe(true)
      expect(element.namespaceURI).toBe(svg.namespaceURI)
      for (const attribute of [...element.attributes]) {
        expect(allowedAttributes.has(attribute.name), attribute.name).toBe(true)
        expect(attribute.name).not.toMatch(/^on/i)
        if (attribute.name !== 'xmlns') expect(attribute.value).not.toMatch(/(?:https?:|file:|data:|javascript:|url\s*\()/i)
      }
    }
    expect(text).not.toMatch(/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<\s*(?:script|foreignObject|image|use|a)\b|\b(?:href|src)\s*=|base64/i)
    const style = svg.querySelector('style')!.textContent!
    expect(style).not.toMatch(/@import|url\s*\(|expression\s*\(/i)
    const dark = style.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/)?.[1]
    expect(dark).toBeTruthy()
    const light = style.match(/:root\s*\{([^}]+)\}/)![1]
    for (const tone of tones) {
      const color = new RegExp(`--${tone}:\\s*(#[0-9a-f]{6})`, 'i')
      expect(light).toMatch(color)
      expect(dark).toMatch(color)
      expect(light.match(color)![1]).not.toBe(dark!.match(color)![1])
    }

    const groups = [...svg.querySelectorAll('g')]
    expect(groups.map((group) => group.getAttribute('data-tone'))).toEqual(tones)
    for (const group of groups) {
      const tone = group.getAttribute('data-tone')!
      expect(group.getAttribute('fill')).toBe(`var(--${tone})`)
      expect(group.getAttribute('fill-rule')).toBe('evenodd')
      const paths = [...group.querySelectorAll('path')]
      // 原稿主要是纸白与线描，不为凑齐四层而编造新的强调色形状。
      if (tone === 'paper' || tone === 'ink') expect(paths.length, tone).toBeGreaterThan(0)
      if (paths.length) expect(paths.some((path) => /[Cc]/.test(path.getAttribute('d')!)), tone).toBe(true)
      expect(group.getAttribute('transform')).toBe(metadata(svg).vectorNormalization.transform)
      expect(group.getAttribute('transform')).toMatch(/^translate\([-\d.]+ [-\d.]+\) scale\([\d.]+\)$/)
      for (const path of paths) {
        expect(path.getAttribute('d')).toMatch(/^M/)
        expect(path.getAttribute('d')).toMatch(/[Zz]/)
        expect(path.getAttribute('d')).not.toMatch(/NaN|Infinity/)
        expect(path.hasAttribute('fill')).toBe(false)
      }
    }

    const provenance = metadata(svg)
    expect(provenance.source).toBe(source)
    expect(provenance.sourceSha256).toBe(sourceSha256)
    expect(provenance.state).toBe(state)
    const index = states.indexOf(state)
    expect(provenance.cell).toMatchObject({ index, column: index % 3, row: Math.floor(index / 3), columns: 3, rows: 2 })
    const [width, height] = provenance.sourceDimensions
    expect(provenance.cell.bounds).toEqual([
      Math.floor(width * (index % 3) / 3), Math.floor(height * Math.floor(index / 3) / 2),
      Math.floor(width * ((index % 3) + 1) / 3), Math.floor(height * (Math.floor(index / 3) + 1) / 2),
    ])
    const [left, top, right, bottom] = provenance.contentBounds
    expect(Math.max(right - left, bottom - top)).toBeGreaterThanOrEqual(396)
    expect(Math.max(right - left, bottom - top)).toBeLessThanOrEqual(404)
    expect(Math.min(left, top)).toBeGreaterThanOrEqual(52)
    expect(Math.max(right, bottom)).toBeLessThanOrEqual(460)
    expect((left + right) / 2).toBeCloseTo(256, 0)
    expect((top + bottom) / 2).toBeCloseTo(256, 0)
    expect(provenance.background.method).toBe('edge-connected-paper-flood-fill')
    expect(provenance.background.exteriorPixels).toBeGreaterThan(0)
    expect(provenance.background.interiorPaperPixels).toBeGreaterThan(0)
    expect(provenance.tracer).toBe('vtracer 0.6.15')
    expect(provenance.parameters).toMatchObject({
      colormode: 'binary', mode: 'spline', filter_speckle: 12, corner_threshold: 90,
      length_threshold: 3.5, max_iterations: 10, splice_threshold: 45, path_precision: 2,
    })
    expect(provenance.preprocessing).toMatchObject({ medianFilter: 3, targetSize: 512, maxContentSize: 400 })
  })

  it('六个状态具有独立的原稿格子和不同的真实描摹曲线', () => {
    const illustrations = states.map((state) => parse(readSvg(state)))
    const fingerprints = illustrations.map((svg) => createHash('sha256').update(
      [...svg.querySelectorAll('path')].map((path) => `${path.getAttribute('d')}|${path.getAttribute('transform')}`).join('\n'),
    ).digest('hex'))
    expect(new Set(fingerprints).size).toBe(states.length)
    const inkFingerprints = illustrations.map((svg) => createHash('sha256').update(
      [...svg.querySelectorAll('g[data-tone="ink"] path')].map((path) => `${path.getAttribute('d')}|${path.getAttribute('transform')}`).join('\n'),
    ).digest('hex'))
    expect(new Set(inkFingerprints).size).toBe(states.length)
    expect(new Set(illustrations.map((svg) => metadata(svg).cell.bounds.join(','))).size).toBe(states.length)
  })
})
