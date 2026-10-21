import { useEffect, useRef, type RefObject } from 'react'
import { LoadingMark } from './LoadingMark'
import { DsButton } from './ui'
import './SourceList.css'

/** 一个列表只观察一个尾部节点，不在每次 scroll 事件中测量或更新 React。 */
export function SourceListLoadMore({ viewport, progress, disabled, loading, error, onLoadMore }: {
  viewport: RefObject<HTMLDivElement | null>; progress: number; disabled: boolean
  loading: boolean; error: string; onLoadMore: () => void
}) {
  const sentinel = useRef<HTMLDivElement>(null)
  const load = useRef(onLoadMore)
  load.current = onLoadMore
  useEffect(() => {
    const root = viewport.current, target = sentinel.current
    if (!root || !target || disabled || loading || error || typeof IntersectionObserver === 'undefined') return
    let active = true, triggered = false
    const observer = new IntersectionObserver(entries => {
      if (!active || triggered || root.clientHeight <= 0 || !entries.some(entry => entry.target === target && entry.isIntersecting)) return
      triggered = true
      load.current()
    }, { root, rootMargin: '0px 0px 240px 0px', threshold: 0 })
    observer.observe(target)
    // 页追加后重新观察；不足一屏时继续补齐，足够高后由浏览器等待下一次接近底部。
    return () => { active = false; observer.disconnect() }
  }, [viewport, progress, disabled, loading, error])

  return <div ref={sentinel} className="session-list-load" aria-live="polite" aria-busy={loading}>
    {loading && <LoadingMark label="正在加载更多会话" />}
    {error && <><p role="alert">{error}</p><DsButton size="small" disabled={disabled || loading} onClick={onLoadMore}>重试加载会话</DsButton></>}
  </div>
}
