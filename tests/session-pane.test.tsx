// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const storageKey = 'pinekin.session-pane-width'
const originalWidth = window.innerWidth
let available = 1132
let resized: () => void
const disconnect = vi.fn()
const handle = () => screen.getByRole('separator', { name: '调整会话栏宽度' })
const width = () => Number(handle().getAttribute('aria-valuenow'))
function viewport(value: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value })
  fireEvent(window, new Event('resize'))
}
function pointer(target: HTMLElement | Window, type: string, x = 0, pointerId = 1, buttons = 1, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, buttons, button })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  fireEvent(target, event)
}
function pane() {
  return render(<div className="workspace"><SessionPane label="来源会话列表"><button>合成会话</button></SessionPane></div>)
}
beforeEach(() => {
  localStorage.clear(); available = 1132; viewport(1380)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { width: this.classList.contains('workspace') ? available : 0 } as DOMRect
  })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe() {}
    disconnect = disconnect
  })
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); disconnect.mockClear()
  localStorage.clear(); viewport(originalWidth)
})

describe('可调宽会话栏', () => {
  it('沿用默认 310px / 窄窗 280px，具备独立且可访问的分隔手柄', () => {
    pane()
    expect(width()).toBe(310)
    expect(handle().getAttribute('aria-valuemin')).toBe('240')
    expect(handle().getAttribute('aria-valuemax')).toBe('560')
    expect(handle().getAttribute('aria-controls')).toBe(screen.getByRole('region', { name: '来源会话列表' }).id)
    expect(handle().getAttribute('aria-orientation')).toBe('vertical')
    expect(handle().getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('button', { name: '合成会话' })).toBeTruthy()
    available = 752; viewport(1000)
    expect(width()).toBe(280)
  })
  it('键盘每次调整 10px、Home/End 到边界，双击恢复响应式默认值', () => {
    pane()
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(width()).toBe(320)
    expect(localStorage.getItem(storageKey)).toBe('320')
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    expect(width()).toBe(310)
    fireEvent.keyDown(handle(), { key: 'Home' })
    expect(width()).toBe(240)
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    expect(width()).toBe(240)
    fireEvent.keyDown(handle(), { key: 'End' })
    expect(width()).toBe(560)
    fireEvent.keyDown(handle(), { key: 'a' })
    expect(width()).toBe(560)
    fireEvent.doubleClick(handle())
    expect(width()).toBe(310)
    expect(localStorage.getItem(storageKey)).toBeNull()
    available = 752; viewport(1000)
    expect(width()).toBe(280)
  })
  it('缩窗或加宽侧栏时至少保留 400px 阅读区，临时限宽不覆盖偏好', () => {
    localStorage.setItem(storageKey, '520')
    const view = pane()
    expect(width()).toBe(520)
    available = 752; viewport(1000)
    expect(width()).toBe(352)
    expect(localStorage.getItem(storageKey)).toBe('520')
    available = 680; act(() => resized())
    expect(width()).toBe(280)
    available = 1132; viewport(1380)
    expect(width()).toBe(520)
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
    pane()
    expect(width()).toBe(520)
  })
  it.each(['NaN', 'Infinity', 'broken', ''])('无效保存值 %s 使用默认宽度', value => {
    localStorage.setItem(storageKey, value); pane(); expect(width()).toBe(310)
  })
  it.each([['-1', 240], ['200', 240], ['9999', 560]] as const)('保存值 %s 超出范围时限制为 %s', (value, expected) => {
    localStorage.setItem(storageKey, value); pane(); expect(width()).toBe(expected)
  })
  it('拖拽限制范围，只在释放时保存，不改侧栏设置并恢复光标与选择状态', () => {
    localStorage.setItem('pinekin.sidebar-width', '320')
    pane()
    document.body.style.cursor = 'default'; document.body.style.userSelect = 'text'
    pointer(handle(), 'pointerdown', 310, 1, 1, 2)
    pointer(window, 'pointermove', 400)
    expect(width()).toBe(310)
    pointer(handle(), 'pointerdown', 310)
    expect(screen.getByRole('region', { name: '来源会话列表' }).dataset.resizing).toBe('true')
    pointer(window, 'pointermove', 400, 2)
    expect(width()).toBe(310)
    pointer(window, 'pointermove', 400)
    expect(width()).toBe(400)
    expect(localStorage.getItem(storageKey)).toBeNull()
    pointer(window, 'pointermove', 2000)
    expect(width()).toBe(560)
    pointer(window, 'pointermove', -2000)
    expect(width()).toBe(240)
    pointer(window, 'pointermove', 440)
    pointer(window, 'pointerup', 440, 2, 0)
    expect(document.body.style.cursor).toBe('col-resize')
    pointer(window, 'pointerup', 440, 1, 0)
    expect(localStorage.getItem(storageKey)).toBe('440')
    expect(localStorage.getItem('pinekin.sidebar-width')).toBe('320')
    expect(document.body.style.cursor).toBe('default')
    expect(document.body.style.userSelect).toBe('text')
  })
  it.each(['escape', 'cancel', 'capture', 'resize', 'unmount'])('%s 中断时恢复原宽度、不保存并清理全局状态', action => {
    const view = pane()
    pointer(handle(), 'pointerdown', 310)
    pointer(window, 'pointermove', 420)
    if (action === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
    if (action === 'cancel') pointer(window, 'pointercancel', 420)
    if (action === 'capture') pointer(handle(), 'lostpointercapture', 420)
    if (action === 'resize') viewport(1300)
    if (action === 'unmount') view.unmount()
    else expect(width()).toBe(310)
    expect(localStorage.getItem(storageKey)).toBeNull()
    expect(document.body.style.cursor).not.toBe('col-resize')
    expect(document.body.style.userSelect).not.toBe('none')
  })
  it('窗口失焦或发现鼠标已松开时提交当前宽度', () => {
    pane()
    pointer(handle(), 'pointerdown', 310); pointer(window, 'pointermove', 400)
    fireEvent(window, new Event('blur'))
    expect(localStorage.getItem(storageKey)).toBe('400')
    pointer(handle(), 'pointerdown', 400); pointer(window, 'pointermove', 450)
    pointer(window, 'pointermove', 460, 1, 0)
    expect(localStorage.getItem(storageKey)).toBe('450')
  })
  it('存储不可用仍可调宽和复位', () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('拒绝存储') })
    }
    pane()
    fireEvent.keyDown(handle(), { key: 'ArrowRight' }); expect(width()).toBe(320)
    fireEvent.doubleClick(handle()); expect(width()).toBe(310)
  })
})
