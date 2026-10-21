import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SourceContent } from '../../../core/sources'
import type { SourceActionCapabilities } from '../../../core/source-actions'
import { buildSourceTranscript } from '../../../core/source-transcript'
import { DsButton, DesignIcon, DsDialogPresence } from './ui'
import { SourceTargetDialog } from './SourceTargetDialog'
import { SourceReadNotesDialog } from './SourceReadNotes'
import { DsMenu } from './DsMenu'
import { Toast, type ToastMessage } from './Toast'
import { restoreFocusWithoutTooltip } from './Tooltip'
import './SourceActions.css'

const handoffUnavailable = '文件交接接口尚未加载，请在方便时更新或重启当前 Pinekin 主实例。'
export type SourceActionFeedback = { id: string; message: ToastMessage }

export function SourceActions({ entryId, content, disabled = false, snapshotNotice, onFeedbackChange }: {
  entryId: string; content?: SourceContent; disabled?: boolean; snapshotNotice?: string
  onFeedbackChange?(feedback?: SourceActionFeedback): void
}) {
  const [capabilities, setCapabilities] = useState<{ id: string; value?: SourceActionCapabilities; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [readingNotesId, setReadingNotesId] = useState<string>()
  const [targetMode, setTargetMode] = useState<'continue' | 'configure'>()
  const targetEpoch = useRef(0), currentDisabled = useRef(disabled)
  currentDisabled.current = disabled
  const epoch = targetEpoch.current
  const [busyId, setBusyId] = useState('')
  const [feedback, setFeedback] = useState<{ id: string; text: string; error?: boolean }>()
  const [copied, setCopied] = useState<{ id: string }>()
  const pending = useRef(new Set<string>())
  const currentId = useRef(entryId)
  currentId.current = entryId
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const alive = useRef(true), fileEpoch = useRef(0), fileToken = useRef<string | undefined>(undefined)
  const api = window.staithe.sourceActions
  const capability = capabilities?.id === entryId ? capabilities : undefined
  const transcript = useMemo(() => content ? buildSourceTranscript(content, snapshotNotice) : undefined, [content, snapshotNotice])
  const busy = busyId === entryId
  const hasMessages = !!content?.session.messages.length
  const status = feedback?.id === entryId ? feedback : undefined
  const originalReason = capability?.value?.original.reason ?? (capability?.error ? '打开方式检查失败，请重试。' : '正在检查打开方式…')

  function releaseFile() {
    const token = fileToken.current
    fileToken.current = undefined
    if (token) void api?.discardHandoffFile?.(token).catch(() => {})
  }
  useLayoutEffect(() => { fileEpoch.current++; releaseFile() }, [entryId, disabled])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; fileEpoch.current++; releaseFile() }
  }, [api])
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
    if (!status || status.error) return
    const timer = setTimeout(() => setFeedback(current => current === status ? undefined : current), 3000)
    return () => clearTimeout(timer)
  }, [status])
  useEffect(() => { setCopied(undefined) }, [entryId, content, disabled])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(current => current === copied ? undefined : current), 3000)
    return () => clearTimeout(timer)
  }, [copied])
  const toast = useMemo<ToastMessage | undefined>(() => status || capability?.error ? {
    text: status?.text ?? capability!.error!, error: status?.error || !status,
    ...(status ? { onDismiss: () => setFeedback(undefined) } : { retry: { label: '重试检查', onClick: () => setAttempt(value => value + 1) } }),
  } : undefined, [status, capability?.error])
  useEffect(() => { onFeedbackChange?.(toast ? { id: entryId, message: toast } : undefined) }, [entryId, toast, onFeedbackChange])
  useEffect(() => () => onFeedbackChange?.(undefined), [onFeedbackChange])
  useLayoutEffect(() => {
    if (!menuOpen) return
    const anchor = trigger.current, root = container.current, popup = menu.current
    if (!anchor || !root || !popup) return
    const position = () => {
      const button = anchor.getBoundingClientRect(), parent = root.getBoundingClientRect()
      // 使用布局宽度，避免进场 scale 让右侧避让少算几像素。
      const width = popup.offsetWidth || popup.getBoundingClientRect().width
      const left = Math.max(8, Math.min(button.left, window.innerWidth - width - 8))
      // 相对操作容器定位，但锚点始终取 more 本身，避免按钮换行后落到整组底部。
      popup.style.left = `${left - parent.left}px`
      popup.style.top = `${button.bottom + 6 - parent.top}px`
    }
    position()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position)
    observer?.observe(root); observer?.observe(anchor); observer?.observe(popup)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
    }
  }, [menuOpen])
  useEffect(() => {
    if (!menuOpen) return
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menuOpen])
  useEffect(() => { closeTarget() }, [entryId])
  useEffect(() => { setReadingNotesId(undefined) }, [entryId, disabled, !!content])
  useEffect(() => { if (disabled) { setMenuOpen(false); closeTarget() } }, [disabled])
  function closeTarget() { targetEpoch.current += 1; setTargetMode(undefined) }
  function chooseTarget(mode: 'continue' | 'configure') { targetEpoch.current += 1; setMenuOpen(false); setFeedback(undefined); setTargetMode(mode) }
  function closeMenu() { setMenuOpen(false); if (trigger.current) restoreFocusWithoutTooltip(trigger.current) }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); return }
    if (event.key === 'Tab') { setMenuOpen(false); return }
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : undefined
    if (next !== undefined) { event.preventDefault(); items[next]?.focus() }
  }
  async function run(kind: 'open' | 'copy' | 'export' | 'handoff-copy' | 'handoff-save') {
    if (pending.current.has(entryId) || disabled) return
    const id = entryId, requestEpoch = fileEpoch.current
    const active = () => alive.current && currentId.current === id && !currentDisabled.current && requestEpoch === fileEpoch.current
    pending.current.add(id); setBusyId(id); setFeedback(undefined); closeMenu()
    if (kind === 'handoff-copy') setCopied(undefined)
    let token: string | undefined
    try {
      let text: string | undefined
      if (kind === 'handoff-copy' || kind === 'handoff-save') {
        if (!api?.prepareHandoffFile || !api.deliverHandoffFile || !api.discardHandoffFile) throw new Error(handoffUnavailable)
        const prepared = await api.prepareHandoffFile(id)
        token = prepared.token
        if (!active()) return
        fileToken.current = token
        const result = await api.deliverHandoffFile(token, kind === 'handoff-copy' ? 'copy-file' : 'export')
        if (result.status === 'file-copied') {
          text = '文件已复制'
          if (active() && kind === 'handoff-copy') setCopied({ id })
        } else if (result.status === 'exported') text = '文件已保存'
      } else if (kind === 'open') {
        if (!api || !capability?.value?.original.available) return
        const result = await api.openOriginal(id)
        text = `已请求 ${result.app} 打开原会话`
      } else {
        if (!transcript?.text || transcript.error) throw new Error(transcript?.error ?? '当前没有可复制的文本。')
        if (kind === 'copy') { await window.staithe.copy(transcript.text); text = transcript.partial ? '已复制当前片段' : '已复制会话文本' }
        else if (api && await api.exportText(transcript.text)) text = transcript.partial ? '已导出当前片段' : '已导出 Markdown'
      }
      if (text && active()) setFeedback({ id, text })
    } catch (error) {
      const text = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
      if (active()) setFeedback({ id, text: text.includes('No handler registered') ? handoffUnavailable : text, error: true })
    } finally {
      if (fileToken.current === token) fileToken.current = undefined
      if (token) void api?.discardHandoffFile?.(token).catch(() => {})
      pending.current.delete(id)
      if (alive.current && currentId.current === id) setBusyId('')
    }
  }
  return <div className="source-actions" ref={container}>
    <div className="source-actions-buttons" aria-busy={disabled || busy || (!!api && !capability)}>
      <DsButton ref={trigger} aria-label="更多会话操作" aria-haspopup="menu" aria-expanded={menuOpen} disabled={disabled || busy || !content}
        variant="tertiary" iconOnly iconRelaxed onClick={() => setMenuOpen(value => !value)}><DesignIcon name="more" /></DsButton>
      {api && <DsButton title={capability?.value?.original.available ? '定位原 App 中的这条会话，不创建副本' : originalReason}
        disabled={disabled || busy || !capability?.value?.original.available} onClick={() => void run('open')}>在原 App 打开</DsButton>}
      {api && <DsButton variant="primary" aria-label={copied?.id === entryId ? '已复制' : '复制接续文件'} title="复制包含完整可读历史的通用 Markdown 文件；原附件需另行添加"
        disabled={disabled || busy} onClick={() => void run('handoff-copy')}>
        <span className="source-copy-label"><span className="source-copy-size" aria-hidden="true">复制接续文件</span>
          <span className="source-copy-text">{copied?.id === entryId ? '已复制' : '复制接续文件'}</span></span>
      </DsButton>}
    </div>
    <DsMenu open={menuOpen} ref={menu} className="source-actions-menu" aria-label="更多会话操作" onKeyDown={menuKeys}
      onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) setMenuOpen(false) }}>
      <button role="menuitem" disabled={!hasMessages} onClick={() => void run('copy')}><DesignIcon name="copy" size={16} />{transcript?.partial ? '复制当前片段' : '复制会话文本'}</button>
      <button role="menuitem" disabled={!api || !hasMessages} onClick={() => void run('export')}><DesignIcon name="download" size={16} />{transcript?.partial ? '导出当前片段' : '导出 Markdown'}</button>
      <button role="menuitem" disabled={!api || !hasMessages} onClick={() => void run('handoff-save')}><DesignIcon name="download" size={16} />保存接续文件</button>
      {(api?.continueInTarget || api?.continueInCodex) && <button role="menuitem" disabled={!hasMessages} onClick={() => chooseTarget('continue')}>原生历史迁移（高级）</button>}
      {(api?.configureTarget || api?.configureCodex) && <button role="menuitem" disabled={!hasMessages} onClick={() => chooseTarget('configure')}><DesignIcon name="settings" size={16} />接续目标设置</button>}
      <button role="menuitem" aria-haspopup="dialog" onClick={() => { setMenuOpen(false); setReadingNotesId(entryId) }}><DesignIcon name="info" size={16} />读取说明</button>
      {!capability?.value?.original.available && <div className="source-actions-note" role="note"><span>原会话打开方式</span><p>{originalReason}</p></div>}
    </DsMenu>
    <DsDialogPresence>{readingNotesId === entryId && content && !disabled && <SourceReadNotesDialog warnings={content.warnings}
      returnFocus={trigger.current} onDismiss={() => setReadingNotesId(undefined)} />}</DsDialogPresence>
    <DsDialogPresence>{targetMode && api && <SourceTargetDialog key={`${entryId}-${targetMode}-${epoch}`} entryId={entryId} api={api}
      targets={capability?.value?.targets ?? []} loadingTargets={!capability?.value && !capability?.error} mode={targetMode}
      isActive={() => currentId.current === entryId && !currentDisabled.current && targetEpoch.current === epoch}
      returnFocus={trigger.current} onDismiss={closeTarget} onSettings={() => chooseTarget('configure')}
      onConfigured={() => { if (currentId.current === entryId && targetEpoch.current === epoch) { closeTarget(); setFeedback({ id: entryId, text: '已更新接续目标位置。' }) } }}
      onComplete={result => {
        if (currentId.current === entryId && targetEpoch.current === epoch) {
          closeTarget()
          setFeedback({ id: entryId, error: !result.opened,
            text: result.opened ? `${result.status === 'existing' ? '已复用' : '已创建并核验'} ${result.messageCount} 条文本历史，已请求 ${result.app} 打开。`
              : `已创建 ${result.messageCount} 条文本历史，但未能打开 ${result.app}：${result.error}。再次接续可重试，不会重复创建。` })
        }
      }} />}</DsDialogPresence>
    {!onFeedbackChange && <Toast message={toast} className="source-actions-feedback" />}
  </div>
}
