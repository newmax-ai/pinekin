import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DsButton, DesignIcon } from './ui'

export type ToastMessage = {
  text: string
  state?: string
  error?: boolean
  busy?: boolean
  actionLabel?: string
  dismissLabel?: string
  onClick?(): void
  onDismiss?(): void
  retry?: { label: string; onClick(): void }
}

// 更新入口与操作反馈共用一个浮层；业务层负责持续时间和优先级。
export function Toast({ message, className = '' }: { message?: ToastMessage; className?: string }) {
  const [retained, setRetained] = useState(message)
  const pill = useRef<HTMLDivElement>(null)
  const visible = message ?? retained
  const closing = !message

  useLayoutEffect(() => { if (message) setRetained(message) }, [message])
  useEffect(() => {
    if (message || !retained) return
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const finish = () => setRetained(undefined)
    if (motion?.matches) { finish(); return }
    const timer = window.setTimeout(finish, 180)
    const reduce = () => { if (motion?.matches) finish() }
    const element = pill.current
    const ended = (event: AnimationEvent) => { if (event.target === element && event.animationName === 'source-update-exit') finish() }
    element?.addEventListener('animationend', ended)
    motion?.addEventListener('change', reduce)
    return () => {
      window.clearTimeout(timer)
      element?.removeEventListener('animationend', ended)
      motion?.removeEventListener('change', reduce)
    }
  }, [message, retained])

  if (!visible) return null
  // 文字随卡片整体运动；内容变化交给同一帧的自然布局，不叠加内层动画。
  const text = <span className="source-update-labels">
    <span className="source-update-label">{visible.text}</span>
  </span>
  return <div ref={pill} className={`source-content-update ds-toast ${className}`} data-toast="true" role={visible.error ? 'alert' : 'status'}
    data-state={closing ? 'closing' : 'open'} data-update-state={visible.state} inert={closing} aria-hidden={closing || undefined}>
    <div className="ds-toast-surface">
      {visible.onClick ? <DsButton variant="tertiary" className="ds-toast-action" aria-label={visible.actionLabel} aria-busy={!!visible.busy} disabled={closing || visible.busy}
        onClick={() => { if (!closing && !visible.busy) visible.onClick?.() }}>{text}</DsButton> : text}
      {visible.retry && <DsButton size="small" disabled={closing} onClick={() => { if (!closing) visible.retry?.onClick() }}>{visible.retry.label}</DsButton>}
      {visible.onDismiss && <DsButton variant="ghost" size="small" iconOnly aria-label={visible.dismissLabel ?? '关闭操作提示'} disabled={closing || visible.busy}
        onClick={() => { if (!closing && !visible.busy) visible.onDismiss?.() }}><DesignIcon name="close" size={14} /></DsButton>}
    </div>
  </div>
}
