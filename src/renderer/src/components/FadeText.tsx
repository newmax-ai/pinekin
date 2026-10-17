import { useLayoutEffect, useRef } from 'react'

// 复用 NewMax FadeOverflow 的溢出测量与 16px 末端 mask 规则，不依赖其宿主工具库。
export function FadeText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = ref.current!
    let active = true
    const measure = () => {
      if (active) element.dataset.overflow = String(element.clientWidth > 0 && element.scrollWidth > element.clientWidth)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    void document.fonts?.ready.then(measure)
    return () => { active = false; observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [text])
  return <span ref={ref} className="ds-fade-text" title={text}>{text}</span>
}
