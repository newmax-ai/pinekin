// @vitest-environment jsdom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceListLoadMore } from '../src/renderer/src/components/SourceListLoadMore'

const observers: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); disconnect = vi.fn()
    constructor(public callback: IntersectionObserverCallback, public options?: IntersectionObserverInit) { observers.push(this) }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function setup() {
  const viewport = createRef<HTMLDivElement>(), onLoadMore = vi.fn()
  const props = { viewport, onLoadMore, progress: 50, disabled: false, loading: false, error: '' }
  const view = render(<div ref={viewport}><SourceListLoadMore {...props} /></div>)
  Object.defineProperty(viewport.current, 'clientHeight', { configurable: true, value: 500 })
  const update = (next: Partial<typeof props>) => view.rerender(<div ref={viewport}><SourceListLoadMore {...props} {...next} /></div>)
  const emit = (observer = observers.at(-1)!, intersecting = true, target = viewport.current!.firstElementChild!) => {
    act(() => observer.callback([{ isIntersecting: intersecting, target } as IntersectionObserverEntry], observer as unknown as IntersectionObserver))
  }
  return { ...view, viewport, onLoadMore, update, emit }
}

describe('单节点滚动加载观察器', () => {
  it('以列表自身为 root，底部提前 240px 观察，普通重渲染不反复创建观察器', () => {
    const { viewport, update } = setup()
    expect(observers).toHaveLength(1)
    expect(observers[0].options).toEqual({ root: viewport.current, rootMargin: '0px 0px 240px 0px', threshold: 0 })
    expect(observers[0].observe).toHaveBeenCalledExactlyOnceWith(viewport.current!.firstElementChild)
    update({ onLoadMore: vi.fn() })
    expect(observers).toHaveLength(1)
  })
  it('只响应自身交叉，隐藏视口不触发，同页多次可见通知只执行一次', () => {
    const { viewport, emit, onLoadMore } = setup()
    emit(observers[0], true, document.createElement('div'))
    emit(observers[0], false)
    Object.defineProperty(viewport.current, 'clientHeight', { configurable: true, value: 0 })
    emit()
    expect(onLoadMore).not.toHaveBeenCalled()
    Object.defineProperty(viewport.current, 'clientHeight', { configurable: true, value: 500 })
    emit(); emit()
    expect(onLoadMore).toHaveBeenCalledOnce()
  })
  it('读取最新回调，下一页提交后重新观察，清理后的迟到回调失效', () => {
    const { update, emit, onLoadMore, unmount } = setup(), next = vi.fn()
    const old = observers[0]
    update({ onLoadMore: next })
    emit()
    expect(next).toHaveBeenCalledOnce()
    expect(onLoadMore).not.toHaveBeenCalled()
    update({ progress: 100, onLoadMore: next })
    expect(old.disconnect).toHaveBeenCalledOnce()
    emit(old)
    expect(next).toHaveBeenCalledOnce()
    const current = observers.at(-1)!
    emit(current)
    expect(next).toHaveBeenCalledTimes(2)
    unmount(); emit(current, true, document.createElement('div'))
    expect(current.disconnect).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledTimes(2)
  })
  it.each([{ disabled: true }, { loading: true }, { error: '合成错误' }])('暂停条件 %j 不创建新观察器', next => {
    const { update, emit, onLoadMore } = setup()
    update(next)
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
    emit(observers[0])
    expect(observers).toHaveLength(1)
    expect(onLoadMore).not.toHaveBeenCalled()
  })
  it('分页失败保留重试入口，暂停时不可重试，恢复后才执行', () => {
    const { update, onLoadMore } = setup()
    update({ error: '合成错误', disabled: true })
    expect(screen.getByRole('alert').textContent).toBe('合成错误')
    fireEvent.click(screen.getByRole('button', { name: '重试加载会话' }))
    expect(onLoadMore).not.toHaveBeenCalled()
    update({ error: '合成错误' })
    fireEvent.click(screen.getByRole('button', { name: '重试加载会话' }))
    expect(onLoadMore).toHaveBeenCalledOnce()
  })
  it('没有观察器 API 时安全跳过，不在 effect 中报错', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    setup()
    expect(observers).toHaveLength(0)
  })
})
