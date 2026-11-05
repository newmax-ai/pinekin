import { useEffect, useState } from 'react'
import type { SourceEntry } from '../../../core/sources'
import { SessionTime } from './SessionTime'

/** 主会话详情中的子会话入口；子会话由主进程按父会话 ID 筛选，只读取目录元数据。 */
export function SourceSubagents({ entry, now, onSelect }: { entry: SourceEntry; now: number; onSelect: (update: { selected: SourceEntry }) => void }) {
  const [state, setState] = useState<{ entryId: string; items?: SourceEntry[]; error?: string }>()
  const expected = entry.kind !== 'subagent' && !!entry.subagentCount && !!entry.sourceSessionId
  useEffect(() => {
    if (!expected) return
    let active = true
    window.staithe.sources.page({ connectionId: entry.connectionId, parentSessionId: entry.sourceSessionId, query: '', offset: 0, limit: 100 })
      .then(page => { if (active) setState({ entryId: entry.id, items: page.items }) },
        reason => { if (active) setState({ entryId: entry.id, error: reason instanceof Error ? reason.message : String(reason) }) })
    return () => { active = false }
  }, [expected, entry.id, entry.connectionId, entry.sourceSessionId, entry.subagentCount])
  if (!expected) return null
  const current = state?.entryId === entry.id ? state : undefined
  return <details className="source-subagents" role="group" aria-label="子会话">
    <summary>子会话 · {entry.subagentCount}</summary>
    {current?.error && <p className="source-subagents-note" role="note">{current.error}</p>}
    {!current && <p className="source-subagents-note" role="status">正在读取子会话…</p>}
    {current?.items?.map(child => <button key={child.id} type="button" className="source-subagent-item" onClick={() => onSelect({ selected: child })}>
      <span className="source-subagent-title">{child.title}</span><SessionTime dateTime={child.updatedAt} now={now} />
    </button>)}
  </details>
}
