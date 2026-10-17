import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { getAppIconFilename, setDevelopmentDockIcon } from '../src/main/app-icon'

const bytes = (path: string) => readFileSync(new URL(path, import.meta.url))

describe('Pinekin 应用图标', () => {
  it('三个平台显式指定图标，运行时 PNG 随应用打包', () => {
    const pkg = JSON.parse(bytes('../package.json').toString())
    expect(pkg.build.mac.icon).toBe('resources/pinekin.icns')
    expect(pkg.build.win.icon).toBe('resources/pinekin.ico')
    expect(pkg.build.linux.icon).toBe('resources/pinekin.png')
    expect(pkg.build.files).toContain('resources/pinekin.png')
    expect(pkg.build.files).toContain('resources/pinekin-macos.png')
  })
  it.each([['darwin', 'pinekin-macos.png'], ['win32', 'pinekin.png'], ['linux', 'pinekin.png']])(
    '%s 使用对应平台的运行时图标，不把 iOS 满幅图直接用于 Mac Dock', (platform, expected) => {
      expect(getAppIconFilename(platform)).toBe(expected)
    },
  )
  it('macOS 使用独立 1024px RGBA 资产，不覆盖用户定稿', () => {
    const mac = bytes('../resources/pinekin-macos.png')
    expect(mac.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(mac.readUInt32BE(16)).toBe(1024)
    expect(mac.readUInt32BE(20)).toBe(1024)
    expect(mac[24]).toBe(8)
    expect(mac[25]).toBe(6)
    expect(createHash('sha256').update(mac).digest('hex')).not.toBe('e166d2402a1afaff62470d26c9e63c89d580d40cdc0970e8fc4128ca3253daed')
  })
  it('母图保持用户上传的 1024px、16-bit RGBA PNG，不重绘或降低位深', () => {
    const png = bytes('../resources/pinekin.png')
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.toString('ascii', 12, 16)).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(1024)
    expect(png.readUInt32BE(20)).toBe(1024)
    expect(png[24]).toBe(16)
    expect(png[25]).toBe(6)
    expect(createHash('sha256').update(png).digest('hex')).toBe('e166d2402a1afaff62470d26c9e63c89d580d40cdc0970e8fc4128ca3253daed')
  })
  it('生成资源与仓库内保存的用户定稿逐字节一致，不依赖会话附件路径', () => {
    expect(bytes('../resources/pinekin.png')).toEqual(bytes('../design/brand/pinekin-icon-approved.png'))
  })
  it('macOS 容器包含从小尺寸到 1024px 的图标表示', () => {
    const icns = bytes('../resources/pinekin.icns')
    expect(icns.toString('ascii', 0, 4)).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    const types: string[] = []
    let offset = 8
    while (offset < icns.length) {
      const length = icns.readUInt32BE(offset + 4)
      expect(length).toBeGreaterThan(8)
      expect(offset + length).toBeLessThanOrEqual(icns.length)
      types.push(icns.toString('ascii', offset, offset + 4))
      offset += length
    }
    expect(offset).toBe(icns.length)
    // iconutil 可使用不同编码块保存同一尺寸；当前系统输出 ic04 / ic05。
    expect(types.some(type => ['ic04', 'icp4', 'is32'].includes(type))).toBe(true)
    expect(types.some(type => ['ic05', 'icp5', 'il32'].includes(type))).toBe(true)
    expect(types).toEqual(expect.arrayContaining(['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12']))
  })
  it('Windows ICO 包含 16–256px 的多尺寸图层', () => {
    const ico = bytes('../resources/pinekin.ico')
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    const count = ico.readUInt16LE(4)
    const sizes: number[] = []
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16
      sizes.push(ico[entry] || 256)
      expect(ico[entry + 1]).toBe(ico[entry])
      const length = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      expect(offset).toBeGreaterThanOrEqual(6 + count * 16)
      expect(length).toBeGreaterThan(0)
      expect(offset + length).toBeLessThanOrEqual(ico.length)
    }
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 64, 128, 256]))
  })
  it('正常 macOS 开发启动设置 Dock 图标', () => {
    const dock = { setIcon: vi.fn() }
    setDevelopmentDockIcon(dock, '/synthetic/pinekin.png', { platform: 'darwin', isPackaged: false, backgroundTesting: false })
    expect(dock.setIcon).toHaveBeenCalledExactlyOnceWith('/synthetic/pinekin.png')
  })
  it.each([
    { platform: 'darwin', isPackaged: false, backgroundTesting: true },
    { platform: 'darwin', isPackaged: true, backgroundTesting: false },
    { platform: 'win32', isPackaged: false, backgroundTesting: false },
    { platform: 'linux', isPackaged: false, backgroundTesting: false },
  ])('不在后台测试、打包应用或其他平台调用 Dock：%j', options => {
    const dock = { setIcon: vi.fn() }
    setDevelopmentDockIcon(dock, '/synthetic/pinekin.png', options)
    expect(dock.setIcon).not.toHaveBeenCalled()
  })
  it('没有 Dock API 时保持安全', () => {
    expect(() => setDevelopmentDockIcon(undefined, '/synthetic/pinekin.png', {
      platform: 'darwin', isPackaged: false, backgroundTesting: false,
    })).not.toThrow()
  })
})
