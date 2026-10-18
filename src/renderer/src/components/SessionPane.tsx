import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useResizableWidth } from './useResizableWidth'

export function SessionPane({ label, children }: { label: string; children: ReactNode }) {
  const pane = useRef<HTMLElement>(null)
  const [viewport, setViewport] = useState(window.innerWidth)
  const [available, setAvailable] = useState(window.innerWidth)
  // 按工作区实际宽度限制，侧栏展开、收起或调宽时均为阅读区保留 400px。
  const max = Math.max(240, Math.min(560, Math.floor(available - 400)))
  const { width, dragging, cancel, handleProps } = useResizableWidth({
    storageKey: 'pinekin.session-pane-width', min: 240, max, defaultWidth: viewport <= 1150 ? 280 : 310,
  })
  useLayoutEffect(() => {
    const workspace = pane.current!.parentElement!
    const measure = () => {
      const availableWidth = workspace.getBoundingClientRect().width
      if (availableWidth > 0) setAvailable(availableWidth)
    }
    const resize = () => { cancel(); setViewport(window.innerWidth); measure() }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(workspace)
    window.addEventListener('resize', resize)
    measure()
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize) }
  }, [cancel])

  return <section ref={pane} id="session-pane" className="session-pane" aria-label={label} style={{ width }} data-resizing={dragging}>
    {children}
    <div className="session-resize-handle" role="separator" aria-label="调整会话栏宽度" aria-controls="session-pane"
      title="拖动调整会话栏宽度，双击恢复默认" {...handleProps} />
  </section>
}
