import { memo, useState } from 'react'
import { sourceKindNames, sourceNames, workspaceName, type SourceEntry } from '../../../core/sources'
import { FadeText } from './FadeText'
import { SourceIcon } from './SourceIcon'
import { SessionTime } from './SessionTime'
import { Tooltip } from './Tooltip'
import './SourceList.css'

// 分页／读取状态变化不重新执行所有已加载卡片的渲染；选择和相对时间仍正常更新。
export const SourceSessionCard = memo(function SourceSessionCard({ entry, selected, now, onSelect }: {
  entry: SourceEntry; selected: boolean; now: number; onSelect: (update: { selected: SourceEntry }) => void
}) {
  // 种类、工作目录与子会话数同为文字标签，多个时以小圆点分隔。
  const labels = [
    ...(entry.kind && entry.kind !== 'conversation' ? [<span key="kind" className="source-kind">{sourceKindNames[entry.kind]}</span>] : []),
    ...(entry.workspace ? [<span key="workspace" className="source-workspace" title={entry.workspace}>{workspaceName(entry.workspace)}</span>] : []),
    ...(entry.subagentCount ? [<span key="subagents" className="source-subagent-count">{entry.subagentCount} 个子会话</span>] : []),
  ]
  // 标题单行渐隐；仅在实际被截断时用 Tooltip 展示完整标题。
  const [truncated, setTruncated] = useState(false)
  return <Tooltip content={entry.title} disabled={!truncated} side="right"><button className={`session-card source-session-card ${selected ? 'selected' : ''}`} aria-label={`${entry.title} ${entry.project}`} aria-pressed={selected} onClick={() => onSelect({ selected: entry })}>
    <div className="card-meta"><span><SourceIcon source={entry.source} size={14} />{sourceNames[entry.source]}</span><SessionTime dateTime={entry.updatedAt} now={now} /></div>
    <FadeText as="h3" text={entry.title} nativeTitle={false} onOverflowChange={setTruncated} />
    {labels.length > 0 && <div className="source-card-context">
      {labels.flatMap((label, index) => index ? [<span key={`dot-${index}`} className="source-card-dot" aria-hidden="true">·</span>, label] : [label])}
    </div>}
  </button></Tooltip>
})
