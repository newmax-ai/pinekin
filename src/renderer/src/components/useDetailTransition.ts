import { useCallback, useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import './DetailTransition.css'

// 只保留浏览器绘制快照，不保留可交互的旧会话子树或推迟到动画结束才导航。
export function useDetailTransition() {
  const active = useRef<ViewTransition | undefined>(undefined)
  const sequence = useRef(0)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const reduce = () => { if (media?.matches) active.current?.skipTransition() }
    media?.addEventListener('change', reduce)
    return () => {
      sequence.current += 1
      active.current?.skipTransition()
      active.current = undefined
      document.documentElement.removeAttribute('data-detail-transition')
      media?.removeEventListener('change', reduce)
    }
  }, [])

  return useCallback((update: () => void, animate = true) => {
    const request = ++sequence.current
    active.current?.skipTransition()
    active.current = undefined
    const root = document.documentElement
    root.removeAttribute('data-detail-transition')
    if (!animate || !document.startViewTransition || document.visibilityState === 'hidden'
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      update()
      return
    }
    let committed = false
    const commit = () => {
      if (request !== sequence.current || committed) return
      committed = true
      // 原生 API 采集新画面前，确保 React 已提交标题、按钮能力和正文隔离状态。
      flushSync(update)
    }
    root.setAttribute('data-detail-transition', '')
    try {
      const transition = document.startViewTransition(commit)
      active.current = transition
      const finish = () => {
        if (active.current !== transition) return
        active.current = undefined
        root.removeAttribute('data-detail-transition')
      }
      // 被新切换、后台窗口或系统减少动画跳过时，ready 会拒绝；导航不能因此丢失。
      void transition.ready.catch(() => {})
      void transition.updateCallbackDone.catch(commit)
      void transition.finished.then(finish, finish)
    } catch {
      root.removeAttribute('data-detail-transition')
      commit()
    }
  }, [])
}
