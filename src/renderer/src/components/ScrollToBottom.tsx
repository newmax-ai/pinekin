import { useLayoutEffect, useState, type RefObject } from 'react'
import { ArrowDown } from 'lucide-react'
import { DsButton } from './ui'

export function ScrollToBottom({ viewport, contentKey }: { viewport: RefObject<HTMLDivElement | null>; contentKey: unknown }) {
  const [visible, setVisible] = useState(false)
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) { setVisible(false); return }
    // 与 ScrollArea 的边界容差一致；不足一屏或已经到底时不占用阅读空间。
    const update = () => setVisible(element.clientHeight > 0 && element.scrollHeight - element.clientHeight - element.scrollTop > 4)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(element)
    for (const child of element.children) observer?.observe(child)
    element.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    update()
    return () => {
      observer?.disconnect()
      element.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [viewport, contentKey])

  function scrollToBottom() {
    const element = viewport.current
    if (!element) return
    const top = Math.max(0, element.scrollHeight - element.clientHeight)
    if (typeof element.scrollTo === 'function') {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      const smoothDistanceLimit = Math.min(element.clientHeight * 3, 1200)
      if (!reduceMotion && top - element.scrollTop > smoothDistanceLimit) {
        // 长对话不逐屏掠过历史；先定位末段，再平滑滚完至多一屏（600 px）。
        const tailDistance = Math.min(element.clientHeight, 600)
        element.scrollTo({ top: top - tailDistance, behavior: 'instant' })
      }
      element.scrollTo({ top, behavior: reduceMotion ? 'instant' : 'smooth' })
    } else {
      element.scrollTop = top
      setVisible(false)
    }
  }

  return visible ? <DsButton className="scroll-to-bottom" iconOnly tooltipSide="top" aria-label="滚动到底部" onClick={scrollToBottom}>
    <ArrowDown className="design-icon" size={18} strokeWidth={1.75} aria-hidden="true" focusable="false" />
  </DsButton> : null
}
