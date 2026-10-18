import { useEffect, useState, type ReactNode } from 'react'
import { useResizableWidth } from './useResizableWidth'

export function Sidebar({ open, children }: { open: boolean; children: ReactNode }) {
  const [viewport, setViewport] = useState(window.innerWidth)
  const narrow = viewport <= 1150
  // 为会话列表、至少 400px 的阅读区和 8px 工作区外边距保留空间。
  const max = Math.max(240, Math.min(360, viewport - (narrow ? 280 : 310) - 408))
  const { width, dragging, cancel, handleProps } = useResizableWidth({
    storageKey: 'pinekin.sidebar-width', min: 240, max, defaultWidth: 240, disabled: !open,
  })
  useEffect(() => {
    const resize = () => { cancel(); setViewport(window.innerWidth) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [cancel])

  return <aside id="archive-sidebar" className="sidebar" aria-label="档案导航" hidden={!open} style={{ width }} data-resizing={dragging}>
    {children}
    <div className="sidebar-resize-handle" role="separator" aria-label="调整侧栏宽度" aria-controls="archive-sidebar"
      title="拖动调整侧栏宽度，双击恢复默认" {...handleProps} />
  </aside>
}
