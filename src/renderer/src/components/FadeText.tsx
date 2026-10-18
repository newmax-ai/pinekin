import { useLayoutEffect, useRef } from 'react'

// 复用 16px 末端 mask；两行模式只淡出最后一行，不遮挡首行。
export function FadeText({ text, as: Element = 'span', lines = 1 }: { text: string; as?: 'span' | 'h3'; lines?: 1 | 2 }) {
  const ref = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const element = ref.current!
    let active = true
    const measure = () => {
      if (!active) return
      const visible = element.clientWidth > 0 && (lines === 1 || element.clientHeight > 0)
      const overflow = element.scrollWidth > element.clientWidth || (lines === 2 && element.scrollHeight > element.clientHeight)
      element.dataset.overflow = String(visible && overflow)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    void document.fonts?.ready.then(measure)
    return () => { active = false; observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [text, Element, lines])
  return <Element ref={element => { ref.current = element }} className="ds-fade-text" data-lines={lines === 2 ? '2' : undefined} title={text}>{text}</Element>
}
