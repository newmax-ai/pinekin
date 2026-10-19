import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SourceContent } from '../../../core/sources'
import type { SourceActionCapabilities } from '../../../core/source-actions'
import { buildSourceTranscript } from '../../../core/source-transcript'
import { DsButton, DesignIcon, DsDialogPresence } from './ui'
import { SourceTargetDialog } from './SourceTargetDialog'
import './SourceActions.css'

export function SourceActions({ entryId, content, disabled = false, snapshotNotice }: {
  entryId: string; content?: SourceContent; disabled?: boolean; snapshotNotice?: string
}) {
  const [capabilities, setCapabilities] = useState<{ id: string; value?: SourceActionCapabilities; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [targetMode, setTargetMode] = useState<'continue' | 'configure'>()
  const targetTrigger = useRef<HTMLButtonElement>(null)
  const targetEpoch = useRef(0), currentDisabled = useRef(disabled)
  currentDisabled.current = disabled
  const epoch = targetEpoch.current
  const [busyId, setBusyId] = useState('')
  const [feedback, setFeedback] = useState<{ id: string; text: string; error?: boolean; receipt?: string }>()
  const pending = useRef(new Set<string>())
  const currentId = useRef(entryId)
  currentId.current = entryId
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const api = window.staithe.sourceActions
  const capability = capabilities?.id === entryId ? capabilities : undefined
  const transcript = useMemo(() => content ? buildSourceTranscript(content, snapshotNotice) : undefined, [content, snapshotNotice])
  const busy = busyId === entryId
  const status = feedback?.id === entryId ? feedback : undefined
  const originalReason = capability?.value?.original.reason ?? (capability?.error ? '打开方式检查失败，请重试。' : '正在检查打开方式…')

  useEffect(() => {
    let active = true
    setCapabilities(undefined); setFeedback(undefined); setMenuOpen(false)
    if (!api) {
      setCapabilities({ id: entryId, value: { original: { available: false, app: '', reason: '当前版本尚未提供原会话打开能力。' }, targets: [] } })
      return
    }
    void api.inspect(entryId).then(value => { if (active) setCapabilities({ id: entryId, value }) })
      .catch(error => { if (active) setCapabilities({ id: entryId, error: error instanceof Error ? error.message : String(error) }) })
    return () => { active = false }
  }, [entryId, api, attempt])
  useEffect(() => {
    if (!menuOpen) return
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menuOpen])
  useEffect(() => { closeTarget() }, [entryId])
  useEffect(() => { if (disabled) { setMenuOpen(false); closeTarget() } }, [disabled])
  function closeTarget() { targetEpoch.current += 1; setTargetMode(undefined) }
  function chooseTarget(mode: 'continue' | 'configure') { targetEpoch.current += 1; setMenuOpen(false); setFeedback(undefined); setTargetMode(mode) }
  function closeMenu() { setMenuOpen(false); trigger.current?.focus() }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); return }
    if (event.key === 'Tab') { setMenuOpen(false); return }
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : undefined
    if (next !== undefined) { event.preventDefault(); items[next]?.focus() }
  }
  async function run(kind: 'open' | 'copy' | 'export' | 'rollback') {
    if (pending.current.has(entryId) || disabled) return
    const id = entryId
    pending.current.add(id); setBusyId(id); setFeedback(undefined); closeMenu()
    try {
      let text: string | undefined
      if (kind === 'rollback') {
        if (!status?.receipt || !api?.rollbackTransfer) return
        await api.rollbackTransfer(status.receipt)
        text = '已撤销接续，来源未修改，备份仍保留。'
      } else if (kind === 'open') {
        if (!api || !capability?.value?.original.available) return
        const result = await api.openOriginal(id)
        text = `已请求 ${result.app} 打开原会话，请在原 App 查看。`
      } else {
        if (!transcript?.text || transcript.error) throw new Error(transcript?.error ?? '当前没有可复制的文本。')
        if (kind === 'copy') { await window.staithe.copy(transcript.text); text = transcript.partial ? '已复制当前片段。' : '已复制会话文本。' }
        else if (api && await api.exportText(transcript.text)) text = transcript.partial ? '已导出当前片段。' : '已导出 Markdown。'
      }
      if (text && currentId.current === id) setFeedback({ id, text })
    } catch (error) {
      if (currentId.current === id) setFeedback({ id, text: error instanceof Error ? error.message : String(error), error: true })
    } finally { pending.current.delete(id); if (currentId.current === id) setBusyId('') }
  }
  return <div className="source-actions" ref={container}>
    <div className="source-actions-buttons">
      {api?.continueInCodex && <DsButton ref={targetTrigger} size="small" title="选择目标 App，创建承接历史的新会话"
        disabled={disabled || busy} onClick={() => chooseTarget('continue')}>在其他 App 继续<DesignIcon name="arrow" size={14} /></DsButton>}
      {capability?.value?.original.available && <DsButton size="small" title="定位原 App 中的这条会话，不创建副本"
        disabled={disabled || busy} onClick={() => void run('open')}>在原 App 打开<DesignIcon name="arrow" size={14} /></DsButton>}
      <DsButton ref={trigger} aria-label="更多会话操作" aria-haspopup="menu" aria-expanded={menuOpen} disabled={disabled || busy || !content?.session.messages.length}
        size="small" variant="ghost" onClick={() => setMenuOpen(value => !value)}>更多<DesignIcon name="chevron-down" size={14} /></DsButton>
    </div>
    {menuOpen && <div ref={menu} className="source-actions-menu" role="menu" aria-label="更多会话操作" onKeyDown={menuKeys}
      onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) setMenuOpen(false) }}>
      <button role="menuitem" onClick={() => void run('copy')}>{transcript?.partial ? '复制当前片段' : '复制会话文本'}</button>
      <button role="menuitem" disabled={!api} onClick={() => void run('export')}>{transcript?.partial ? '导出当前片段' : '导出 Markdown'}</button>
      {api?.configureCodex && <button role="menuitem" onClick={() => chooseTarget('configure')}>接续目标设置</button>}
      {!capability?.value?.original.available && <div className="source-actions-note" role="note"><span>原会话打开方式</span><p>{originalReason}</p></div>}
    </div>}
    <DsDialogPresence>{targetMode && api && <SourceTargetDialog key={`${entryId}-${targetMode}-${epoch}`} entryId={entryId} api={api}
      targets={capability?.value?.targets ?? []} loadingTargets={!capability?.value && !capability?.error} mode={targetMode}
      isActive={() => currentId.current === entryId && !currentDisabled.current && targetEpoch.current === epoch}
      returnFocus={targetMode === 'configure' ? trigger.current : targetTrigger.current} onDismiss={closeTarget} onSettings={() => chooseTarget('configure')}
      onConfigured={() => { if (currentId.current === entryId && targetEpoch.current === epoch) { closeTarget(); setFeedback({ id: entryId, text: '已更新接续目标位置。' }) } }}
      onComplete={result => {
        if (currentId.current === entryId && targetEpoch.current === epoch) {
          closeTarget()
          setFeedback({ id: entryId, receipt: result.receipt, error: !result.opened,
            text: result.opened ? `${result.status === 'existing' ? '已复用' : '已创建并核验'} ${result.messageCount} 条文本历史，已请求 ${result.app} 打开。`
              : `已创建 ${result.messageCount} 条文本历史，但未能打开 ${result.app}：${result.error}。再次接续可重试，不会重复创建。` })
        }
      }} />}</DsDialogPresence>
    {(status || capability?.error) && <div className="source-actions-feedback" role={status?.error || !status ? 'alert' : 'status'}>
      <span>{status?.text ?? capability?.error}</span>
      {status?.receipt && api?.rollbackTransfer && <DsButton size="small" disabled={busy || disabled} onClick={() => void run('rollback')}>撤销接续</DsButton>}
      {!status && <DsButton size="small" onClick={() => setAttempt(value => value + 1)}>重试检查</DsButton>}
      {status && <DsButton variant="ghost" size="small" iconOnly aria-label="关闭操作提示" onClick={() => setFeedback(undefined)}><DesignIcon name="close" size={14} /></DsButton>}
    </div>}
  </div>
}
