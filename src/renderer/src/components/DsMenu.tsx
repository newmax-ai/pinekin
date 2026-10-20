import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentPropsWithRef } from 'react'

// 业务关闭立即生效，原节点仅保留到设计系统退场完成，不延迟焦点恢复或菜单操作。
export function DsMenu({ open, ref, className = '', onClickCapture, children, ...props }:
  Omit<ComponentPropsWithRef<'div'>, 'role'> & { open: boolean }) {
  const element = useRef<HTMLDivElement>(null)
  const [retained, setRetained] = useState(open)
  useImperativeHandle(ref, () => element.current!, [open, retained])
  useLayoutEffect(() => { if (open) setRetained(true) }, [open])
  useEffect(() => {
    if (open || !retained) return
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (motion?.matches) { setRetained(false); return }
    const popup = element.current
    const finish = () => setRetained(false)
    const ended = (event: AnimationEvent) => {
      if (event.target === popup && !event.pseudoElement && event.animationName === 'ds-dialog-exit') finish()
    }
    // 复用 DS 的 140ms 退场；动画被覆盖或事件丢失时仍能释放节点。
    const timer = window.setTimeout(finish, 180)
    const reduce = () => { if (motion?.matches) finish() }
    popup?.addEventListener('animationend', ended)
    motion?.addEventListener('change', reduce)
    return () => {
      window.clearTimeout(timer)
      popup?.removeEventListener('animationend', ended)
      motion?.removeEventListener('change', reduce)
    }
  }, [open, retained])
  if (!open && !retained) return null
  return <div {...props} ref={element} role="menu" className={`ds-menu ${className}`} data-state={open ? 'open' : 'closing'}
    inert={!open} aria-hidden={!open || undefined}
    onClickCapture={event => {
      if (!open) { event.preventDefault(); event.stopPropagation(); return }
      onClickCapture?.(event)
    }}>{children}</div>
}
