import { useRef, useState } from 'react'
import { browsableSources, sourceNames, type BrowsableSource, type SourceConnection, type SourceConnectResult } from '../../../core/sources'
import { ScrollArea } from './ScrollArea'
import { useContentSizedDialog } from './useContentSizedDialog'
import { SourceIcon } from './SourceIcon'
import { DsSwitch } from './DsSwitch'
import { DesignIcon, DsButton, DsDialog, DsDialogHeader } from './ui'

const sources = browsableSources
const statusNames = { idle: '待刷新', scanning: '加载中', ready: '统计未完成', partial: '部分可读', cancelled: '已暂停', error: '读取失败' }
interface Props {
  connections: SourceConnection[]
  returnFocus?: HTMLElement | null
  onConnected: (sources: BrowsableSource[], warnings: string[]) => void
  onChanged: (connections: SourceConnection[]) => void
  onBusyChange: (busy: boolean) => void
  onDismiss: () => void
  busy?: boolean
  error?: string
  onDisconnect: (connections: SourceConnection[]) => Promise<boolean>
}
export function ConnectSourcesDialog({ connections, returnFocus, onConnected, onChanged, onBusyChange, onDismiss, busy: operationBusy = false, error, onDisconnect }: Props) {
  const { viewportRef, contentRef } = useContentSizedDialog()
  const [warnings, setWarnings] = useState<Partial<Record<BrowsableSource, string[]>>>({})
  const [notices, setNotices] = useState<Partial<Record<BrowsableSource, string[]>>>({})
  const [added, setAdded] = useState<BrowsableSource[]>([])
  const [active, setActive] = useState<{ source: BrowsableSource; mode: 'connect' | 'disconnect' | 'manual' }>()
  const running = useRef(false)
  // 父层负责批量断开，错误仍显示在发起该操作的卡片，不能随其他 App 的操作迁移。
  const disconnectSource = useRef<BrowsableSource | undefined>(undefined)
  const busy = !!active || operationBusy
  function accept(source: BrowsableSource, result: SourceConnectResult) {
    setWarnings(previous => ({ ...previous, [source]: result.warnings }))
    setNotices(previous => ({ ...previous, [source]: result.notices ?? (!result.connections.length && !result.warnings.length ? ['未找到本机会话，可能尚未安装或尚未创建会话，也可使用自定义位置。'] : []) }))
    onChanged(result.connections)
    if (result.connections.some(item => item.status === 'ready' || item.status === 'partial')) setAdded(previous => [...new Set([...previous, source])])
  }
  async function change(source: BrowsableSource, mode: 'connect' | 'disconnect' | 'manual') {
    if (busy || running.current) return
    running.current = true; setActive({ source, mode })
    // 断开由父层统一串行处理并维护 busy，避免多位置逐项回调捕获旧页面状态。
    if (mode !== 'disconnect') onBusyChange(true)
    try {
      if (mode === 'disconnect') {
        disconnectSource.current = source
        const ok = await onDisconnect(connections.filter(item => item.source === source))
        setWarnings(previous => ({ ...previous, [source]: ok ? [] : ['断开未完成，仍有位置保留连接，请重试。'] }))
        if (ok) setNotices(previous => ({ ...previous, [source]: [] }))
      } else if (mode === 'manual') {
        const connection = await window.staithe.sources.connect(source)
        // 取消保留原提示与授权状态。
        if (connection) accept(source, { connections: [connection], warnings: [] })
      } else accept(source, await window.staithe.sources.autoConnect(source))
    } catch (reason) {
      setNotices(previous => ({ ...previous, [source]: [] }))
      setWarnings(previous => ({ ...previous, [source]: [reason instanceof Error ? reason.message : String(reason)] }))
    } finally {
      running.current = false; setActive(undefined)
      if (mode !== 'disconnect') onBusyChange(false)
    }
  }
  function finish() {
    const readable = sources.filter(source => added.includes(source) && connections.some(item => item.source === source && (item.status === 'ready' || item.status === 'partial')))
    if (readable.length) onConnected(readable, sources.flatMap(source => [...new Set([...(warnings[source] ?? []), ...connections.filter(item => item.source === source).flatMap(item => item.error ? [item.error] : [])])].map(message => `${sourceNames[source]}：${message}`)))
    else onDismiss()
  }

  return <DsDialog titleId="connect-title" busy={busy} onDismiss={onDismiss} returnFocus={returnFocus}>
    <DsDialogHeader titleId="connect-title" title="连接来源 App" className="connection-header" closeLabel="关闭连接面板" busy={busy} onDismiss={onDismiss}
      description={<p className="connection-intro connection-description">连接 App，集中浏览本机会话；断开不会删除原会话。</p>} />
    <ScrollArea ref={viewportRef} className="dialog-content connection-content">
      <div ref={contentRef} className="connection-content-inner">
      <ul className="connection-app-list" aria-label="来源 App">{sources.map(source => {
        const saved = connections.filter(item => item.source === source), enabled = saved.length > 0
        const messages = [...new Set([...(warnings[source] ?? []), ...saved.flatMap(item => item.error ? [item.error] : []),
          ...(disconnectSource.current === source && error ? [error] : [])])]
        const hints = [...new Set(notices[source] ?? [])]
        const complete = enabled && saved.every(item => item.status === 'ready' && item.total !== null)
        const count = saved.reduce((total, item) => total + (complete ? item.total! : item.discovered), 0)
        const mode = active?.source === source ? active.mode : undefined
        const statistics = enabled ? complete ? `${count} 条会话` : `已发现 ${count} 条 · 统计未完成` : '自动查找本机会话'
        const progress = mode ? mode === 'manual' ? '等待选择位置…' : mode === 'disconnect' ? '正在断开…' : '正在连接…' : undefined
        // 重试期间保留原描述及换行，不能临时缩成一行后再撑回整个网格。
        const notice = hints.length > 0 ? hints.join('；') : undefined
        const description = notice ?? statistics
        const diagnostic = `${sourceNames[source]}：${messages.join('；')}`
        return <li key={source}><section className="connection-source-card" aria-label={`${sourceNames[source]} 来源`} data-connected={enabled}>
          <div className="connection-app"><SourceIcon source={source} /><h3>{sourceNames[source]}</h3>
            <DsSwitch size="small" data-dialog-initial-focus="true" aria-label={`连接 ${sourceNames[source]}`} checked={enabled} disabled={busy}
              onChange={checked => void change(source, checked ? 'connect' : 'disconnect')} />
          </div>
          <div className="connection-summary" data-notice={!!notice} data-pending={!!mode}>
            <p className={`connection-intro${notice ? ' connection-notice' : ''}`} title={description} aria-hidden={!!mode || undefined} role={!mode && notice ? 'status' : undefined} aria-live={!mode && notice ? 'polite' : undefined}>{description}</p>
            {progress && <span className="connection-summary-progress" role="status" aria-live="polite">{progress}</span>}
          </div>
          <div className="connection-inline-info" hidden={!saved.length && !messages.length && !hints.length}>
            {messages.length > 0 && <p className="connection-error" role="alert">{diagnostic}</p>}
            <div className="connection-source-positions">{saved.map(item => <section key={item.id} className="connection-location" aria-label={`${sourceNames[source]} · ${item.label}`}>
              <span className="connection-location-name" title={item.label}>{source === 'codex' && item.label === 'sessions' ? '普通会话' : source === 'codex' && item.label === 'archived_sessions' ? '归档会话' : item.label}</span>
              <span className="connection-location-count">{item.status === 'ready' && item.total !== null ? `${item.total} 条` : `${statusNames[item.status]} · 已发现 ${item.discovered} 条`}</span>
              {(item.issues > 0 || item.ignoredLinks > 0) && <p className="connection-location-note">不可访问目录 {item.issues} · 跳过符号链接 {item.ignoredLinks}</p>}
            </section>)}</div>
            {(messages.length > 0 || hints.length > 0) && <DsButton className="connection-manual" size="small" disabled={busy} onClick={() => void change(source, 'manual')}>使用自定义位置…</DsButton>}
          </div>
        </section></li>
      })}</ul>
      <p className="connection-card-privacy"><DesignIcon name="shield" size={14} />只读访问 · 不保存正文 · 不修改来源</p>
      </div>
    </ScrollArea>
    <div className="dialog-footer">
      <DsButton variant="primary" disabled={busy} onClick={finish}>完成</DsButton>
    </div>
  </DsDialog>
}
