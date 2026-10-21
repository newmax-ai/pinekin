import { memo } from 'react'
import { sourceKindNames, sourceNames, type SourceEntry } from '../../../core/sources'
import { FadeText } from './FadeText'
import { SourceIcon } from './SourceIcon'
import { SessionTime } from './SessionTime'
import './SourceList.css'

// 分页／读取状态变化不重新执行所有已加载卡片的渲染；选择和相对时间仍正常更新。
export const SourceSessionCard = memo(function SourceSessionCard({ entry, selected, now, onSelect }: {
  entry: SourceEntry; selected: boolean; now: number; onSelect: (update: { selected: SourceEntry }) => void
}) {
  return <button className={`session-card source-session-card ${selected ? 'selected' : ''}`} aria-label={`${entry.title} ${entry.project}`} aria-pressed={selected} onClick={() => onSelect({ selected: entry })}>
    <div className="card-meta"><span><SourceIcon source={entry.source} size={14} />{sourceNames[entry.source]}</span><SessionTime dateTime={entry.updatedAt} now={now} /></div>
    <FadeText as="h3" text={entry.title} lines={2} />
    {entry.kind && entry.kind !== 'conversation' && <span className="source-kind">{sourceKindNames[entry.kind]}</span>}
  </button>
})
