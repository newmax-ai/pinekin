import { describe, expect, it, vi } from 'vitest'
import { getBackgroundTestMode, getTestWindowOptions, getWindowChrome, presentWindow } from '../src/main/window-options'

describe('原生窗口标题栏', () => {
  it('macOS 隐藏独立标题栏并保留原生红绿灯位置', () => {
    expect(getWindowChrome('darwin')).toEqual({
      titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 12 },
      vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000',
    })
    expect(getWindowChrome('darwin')).not.toHaveProperty('frame', false)
    expect(getWindowChrome('darwin')).not.toHaveProperty('transparent', true)
  })
  it.each(['win32', 'linux', 'freebsd'])('%s 保留系统标题栏与原生控制按钮', platform => {
    expect(getWindowChrome(platform)).toEqual({})
  })
})

describe('后台桌面验收', () => {
  it('只有未打包应用的显式测试标记启用后台模式', () => {
    expect(getBackgroundTestMode(false, '1')).toBe(true)
    for (const flag of [undefined, '', '0', 'true']) expect(getBackgroundTestMode(false, flag)).toBe(false)
    expect(getBackgroundTestMode(true, '1')).toBe(false)
  })
  it('测试窗口从创建时就隐藏且不可抢焦点，而不是显示后再隐藏', () => {
    expect(getTestWindowOptions(true)).toEqual({ show: false, focusable: false, skipTaskbar: true, paintWhenInitiallyHidden: true })
    expect(getTestWindowOptions(false)).toEqual({})
  })
  it('后台模式阻止深链和第二实例路径恢复、显示或聚焦窗口', () => {
    const window = { isMinimized: vi.fn(() => true), restore: vi.fn(), show: vi.fn(), focus: vi.fn() }
    presentWindow(window, true)
    expect(window.isMinimized).not.toHaveBeenCalled()
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    expect(() => presentWindow(null, true)).not.toThrow()
  })
  it.each([false, true])('正常启动保留展示与聚焦行为，最小化状态为 %s', minimized => {
    const window = { isMinimized: vi.fn(() => minimized), restore: vi.fn(), show: vi.fn(), focus: vi.fn() }
    presentWindow(window, false)
    expect(window.restore).toHaveBeenCalledTimes(minimized ? 1 : 0)
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(() => presentWindow(null, false)).not.toThrow()
  })
})
