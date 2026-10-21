import { useLayoutEffect, useState } from 'react'
import { sourceKindNames, sourceNames, type SourceContent, type SourceEntry } from '../../../core/sources'
import { SourceIcon } from './SourceIcon'

// 仅保留字段结构；数字按自然宽度排版，不缓存上一会话的计数或位宽。
export function SourceDetailMeta({ entry, content, reading = false }: {
  entry: SourceEntry; content?: SourceContent; reading?: boolean
}) {
  const [layout, setLayout] = useState({ windowed: true, tools: false })
  const toolCount = content?.presentation ? content.presentation.toolCalls + content.presentation.toolResults : 0
  const windowed = content ? !!content.window : layout.windowed
  const hasTools = content ? toolCount > 0 : layout.tools
  const total = content ? content.window?.totalMessages ?? content.session.messages.length : undefined
  const current = content?.session.messages.length
  useLayoutEffect(() => {
    if (!content) return
    setLayout(previous => previous.windowed === windowed && previous.tools === hasTools
      ? previous : { windowed, tools: hasTools })
  }, [content, windowed, hasTools])

  const kind = content?.presentation?.kind ?? entry.kind
  const kindLabel = kind && kind !== 'conversation' ? sourceKindNames[kind] : undefined
  const countLabel = windowed ? `${total ?? '—'} 条来源消息 · 当前片段 ${current ?? '—'} 条文本` : `${total ?? '—'} 条消息`
  const toolLabel = hasTools ? `${content ? toolCount : '—'} 项工具活动` : undefined
  const description = [kindLabel, countLabel, toolLabel].filter(Boolean).join(' · ')
  const number = (value?: number) => <span className="source-detail-number">{value ?? '—'}</span>

  return <div className="detail-meta source-detail-meta">
    <span><SourceIcon source={entry.source} size={14} />{sourceNames[entry.source]}</span>
    <span className="source-detail-summary" title={description} aria-busy={reading || undefined}>
      <span className="source-detail-summary-text">
        {kindLabel && <><span>{kindLabel}</span><span aria-hidden="true"> · </span></>}
        <span className="detail-message-count" aria-label={content ? countLabel : reading ? '消息数正在读取' : '消息数暂不可用'}>
          {windowed ? <>{number(total)}{' 条来源消息 · 当前片段 '}{number(current)}{' 条文本'}</> : <>{number(total)}{' 条消息'}</>}
        </span>
        {hasTools && <><span aria-hidden="true"> · </span><span>{number(content ? toolCount : undefined)}{' 项工具活动'}</span></>}
      </span>
    </span>
    <time dateTime={entry.updatedAt}>{entry.updatedAt.slice(0, 10)}</time>
  </div>
}
