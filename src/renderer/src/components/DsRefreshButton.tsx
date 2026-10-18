import { useState } from 'react'
import { DesignIcon, DsButton } from './ui'

// 本地适配 NewMax 钱包的 DsRefreshButton；不依赖宿主 i18n、store 或 CSS。
export function DsRefreshButton({ onClick, loading = false, disabled = false, 'aria-label': label = '刷新', className = '' }: {
  onClick: () => void; loading?: boolean; disabled?: boolean; 'aria-label'?: string; className?: string
}) {
  const [turns, setTurns] = useState(0)
  return <DsButton variant="ghost" size="small" iconOnly className={`ds-refresh-button ${className}`}
    aria-label={label} aria-busy={loading} disabled={disabled || loading} data-unavailable={disabled}
    onClick={() => { setTurns(value => value + 1); onClick() }}>
    <span className="ds-refresh-progress" aria-hidden="true">
      {/* 每次点击只重启动画节点，快速请求结束也会完整播放；不依赖动画事件解锁操作。 */}
      <span key={turns} className="ds-refresh-turn" data-active={turns > 0}><DesignIcon name="refresh" /></span>
    </span>
  </DsButton>
}
