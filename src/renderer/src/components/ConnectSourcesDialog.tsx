import { useRef, useState } from 'react'
import { sourceLocations, sourceNames, type BrowsableSource, type SourceConnection, type SourceConnectResult } from '../../../core/sources'
import { ScrollArea } from './ScrollArea'
import { SourceIcon } from './SourceIcon'
import { DsCheckbox } from './DsCheckbox'
import { DesignIcon, DsButton, DsDialog, DsDialogHeader } from './ui'

const sources: BrowsableSource[] = ['newmax', 'claude-code', 'codex', 'cindy', 'deepseek']
type Outcome = { state: 'success' | 'partial' | 'error'; readable: boolean; warnings: string[] }
type Outcomes = Partial<Record<BrowsableSource, Outcome>>
interface Props {
  connections: SourceConnection[]
  returnFocus?: HTMLElement | null
  onConnected: (sources: BrowsableSource[], warnings: string[]) => void
  onChanged: () => void
  onBusyChange: (busy: boolean) => void
  onDismiss: () => void
  onManage: () => void
  onArchives: () => void
}
function outcome(result: SourceConnectResult): Outcome {
  const readable = result.connections.some(item => item.status === 'ready' || item.status === 'partial')
  const warnings = [...new Set([...result.warnings, ...result.connections.flatMap(item => item.error ? [item.error] : [])])]
  const complete = result.connections.length > 0 && result.connections.every(item => item.status === 'ready') && !warnings.length
  if (!complete && !warnings.length) warnings.push(result.connections.length ? '会话列表尚未就绪，请刷新连接。' : '未找到本机会话，可以重试或指定自定义位置。')
  return { state: complete ? 'success' : readable ? 'partial' : 'error', readable, warnings }
}
function failed(reason: unknown): Outcome { return { state: 'error', readable: false, warnings: [reason instanceof Error ? reason.message : String(reason)] } }

export function ConnectSourcesDialog({ connections, returnFocus, onConnected, onChanged, onBusyChange, onDismiss, onManage, onArchives }: Props) {
  const [selected, setSelected] = useState<BrowsableSource[]>([])
  const [results, setResults] = useState<Outcomes>({})
  const [active, setActive] = useState<BrowsableSource>()
  const [manual, setManual] = useState(false)
  const running = useRef(false)
  const busy = active !== undefined
  const available = sources.filter(source => results[source] || !connections.some(item => item.source === source))
  const readable = sources.filter(source => results[source]?.readable)
  const retrying = selected.some(source => results[source]?.state === 'error' || results[source]?.state === 'partial')
  function view(outcomes = results) {
    const readable = sources.filter(source => outcomes[source]?.readable)
    const warnings = sources.flatMap(source => (outcomes[source]?.warnings ?? []).map(warning => `${sourceNames[source]}：${warning}`))
    onConnected(readable, warnings)
  }
  function update(next: Outcomes) {
    setResults(next)
    setSelected(previous => previous.filter(source => next[source]?.state !== 'success'))
    onChanged()
  }
  async function connectSelected() {
    const requested = sources.filter(source => selected.includes(source) && results[source]?.state !== 'success')
    if (running.current || !requested.length) return
    running.current = true; onBusyChange(true)
    const next = { ...results }
    try {
      // 主进程连接入口串行化；失败只影响该 App，不中止本批其他选择。
      for (const source of requested) {
        setActive(source)
        try { next[source] = outcome(await window.staithe.sources.autoConnect(source)) }
        catch (reason) { next[source] = failed(reason) }
        update({ ...next })
      }
      if (Object.values(next).every(result => result.state === 'success')) view(next)
    } finally { running.current = false; setActive(undefined); onBusyChange(false) }
  }
  async function connectManually(source: BrowsableSource) {
    if (running.current) return
    running.current = true; setActive(source); setManual(true); onBusyChange(true)
    try {
      const connection = await window.staithe.sources.connect(source)
      // 用户取消时保留本批连接结果与失败原因。
      if (!connection) return
      const next = { ...results, [source]: outcome({ connections: [connection], warnings: [] }) }
      update(next)
      if (Object.values(next).every(result => result.state === 'success')) view(next)
    } catch (reason) { update({ ...results, [source]: failed(reason) }) }
    finally { running.current = false; setActive(undefined); setManual(false); onBusyChange(false) }
  }

  return <DsDialog titleId="connect-title" busy={busy} onDismiss={onDismiss} returnFocus={returnFocus}>
    <DsDialogHeader titleId="connect-title" title="连接来源 App" className="connection-header" closeLabel="关闭连接面板" busy={busy} onDismiss={onDismiss} />
    <ScrollArea className="dialog-content connection-content">
      <p className="connection-intro">选择需要连接的 App，一次添加多个。</p>
      {available.length ? <ul className="connection-app-list" aria-label="可连接的 App">{available.map(source => {
        const result = results[source], complete = result?.state === 'success'
        return <li key={source}>
          <label className="connection-app" data-disabled={busy || complete}>
            <SourceIcon source={source} /><span className="connection-app-copy"><span>{sourceNames[source]}</span>
              <small>{active === source ? manual ? '等待选择位置…' : '正在查找和读取…' : complete ? '已连接' : result?.state === 'partial' ? '部分位置已连接' : result?.state === 'error' ? '连接未完成' : source === 'cindy' ? '自动查找 · 正文直读暂未支持' : '自动查找本机会话'}</small>
            </span>
            <DsCheckbox data-dialog-initial-focus="true" aria-label={`选择 ${sourceNames[source]}`} checked={complete || selected.includes(source)} disabled={busy || complete}
              onChange={checked => setSelected(previous => checked ? [...previous, source] : previous.filter(item => item !== source))} />
          </label>
          {result && !complete && (active !== source || manual) && <section className="connection-card" aria-label={`${sourceNames[source]} 连接结果`} data-state="attention">
            <div className="connection-card-message" role="alert"><h3>{sourceNames[source]} · {result.state === 'partial' ? '部分位置已连接' : '连接未完成'}</h3><p>{result.warnings.join('；')}</p></div>
            <details className="format-help connection-help"><summary><DesignIcon name="chevron" size={14} />查看详情与其他方式</summary>
              <p>仅访问默认或已授权位置，不搜索整盘、不读取凭据。连接位置会保留，重启后可刷新。</p><p>{sourceLocations[source]}</p>
              <DsButton variant="tertiary" size="small" disabled={busy} onClick={() => void connectManually(source)}>使用自定义位置…</DsButton>
            </details>
          </section>}
        </li>
      })}</ul> : <p className="connection-intro">所有支持的 App 均已连接</p>}
      {active && <p className="connection-progress" role="status" aria-live="polite">{manual ? `等待选择 ${sourceNames[active]} 的位置…` : `正在连接 ${sourceNames[active]}…`}</p>}
      <p className="connection-card-privacy"><DesignIcon name="shield" size={14} />只读访问 · 不保存正文 · 不修改来源</p>
    </ScrollArea>
    <div className="dialog-footer connection-footer">
      <div className="export-actions"><DsButton variant="ghost" disabled={busy} data-dialog-initial-focus={!available.length ? true : undefined} onClick={onManage}>管理连接</DsButton><DsButton variant="ghost" disabled={busy} onClick={onArchives}>已有档案</DsButton></div>
      <div className="export-actions">{readable.length > 0 && <DsButton disabled={busy} onClick={() => view()}>查看已连接会话</DsButton>}
        {available.length > 0 && <DsButton variant="primary" disabled={busy || !selected.length} onClick={() => void connectSelected()}>{busy ? '正在连接…' : retrying ? '重试所选 App' : '连接所选 App'}</DsButton>}
      </div>
    </div>
  </DsDialog>
}
