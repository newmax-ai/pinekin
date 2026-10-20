import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DsButton } from './ui'

type UpdateState = 'updated' | 'reading' | 'jump'
const labels: Record<UpdateState, string> = { updated: '此对话有更新', reading: '读取中…', jump: '跳到新增消息' }

export function SourceUpdatePill({ state, onRead, onJump }: { state?: UpdateState; onRead(): void; onJump(): void }) {
  const [retained, setRetained] = useState(state)
  const [width, setWidth] = useState<number>()
  const label = useRef<HTMLSpanElement>(null)
  const pill = useRef<HTMLDivElement>(null)
  const visible = state ?? retained
  const closing = !state

  // 业务状态立即切换，仅保留最后的胶囊节点完成退场。
  useLayoutEffect(() => { if (state) setRetained(state) }, [state])
  useLayoutEffect(() => {
    const element = label.current
    if (!visible || !element) return
    const measure = () => { if (element.offsetWidth > 0) setWidth(element.offsetWidth) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [visible])
  useEffect(() => {
    if (state || !retained) return
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const finish = () => setRetained(undefined)
    if (motion?.matches) { finish(); return }
    // CSS 退场为 140ms，避免动画事件遗漏后留下不可交互的胶囊。
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
  }, [state, retained])

  if (!visible) return null
  return <div ref={pill} className="source-content-update" role="status" data-state={closing ? 'closing' : 'open'} data-update-state={visible}
    inert={closing} aria-hidden={closing || undefined}>
    <DsButton variant="tertiary" aria-label={visible === 'jump' ? labels.jump : '查看更新'} aria-busy={visible === 'reading'} disabled={closing || visible === 'reading'}
      onClick={() => { if (state === 'jump') onJump(); else if (state === 'updated') onRead() }}>
      <span className="source-update-labels" style={width ? { width } : undefined}>
        <span key={visible} ref={label} className="source-update-label">{labels[visible]}</span>
      </span>
    </DsButton>
  </div>
}
