import { vi } from 'vitest'

const observers = new Set<{ callback: IntersectionObserverCallback; root: Element | Document | null; target?: Element }>()

/** 只模拟可见性，不读取真实客户端；由测试明确决定何时接近列表底部。 */
export function installListIntersectionObserver() {
  observers.clear()
  vi.stubGlobal('IntersectionObserver', class {
    root: Element | Document | null
    target?: Element
    constructor(public callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.root = options?.root ?? null
      observers.add(this)
    }
    observe(target: Element) { this.target = target }
    disconnect() { observers.delete(this) }
  })
}

export function intersectSessionList(isIntersecting = true) {
  for (const observer of [...observers]) {
    if (!(observer.root instanceof HTMLElement) || !observer.root.matches('.session-list') || !observer.target) continue
    Object.defineProperty(observer.root, 'clientHeight', { configurable: true, value: 600 })
    observer.callback([{ isIntersecting, target: observer.target } as IntersectionObserverEntry], observer as unknown as IntersectionObserver)
  }
}
