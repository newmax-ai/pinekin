import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExportFormat, ImportPreview, Session, Source, Target } from '../../core/types'
import { adapters, filterSessions, makeDeepLink, makeHandoff } from '../../core/session'
import { DsButton, DsDialog, DesignIcon } from './components/ui'
import { MessageContent } from './components/MessageContent'
import { SourceIcon } from './components/SourceIcon'
import { Sidebar } from './components/Sidebar'
import { FadeText } from './components/FadeText'
import { ScrollArea } from './components/ScrollArea'
import localStorageIllustration from './assets/pinekin-local-storage.svg'

const names: Record<Source, string> = { newmax: 'NewMax', 'claude-code': 'Claude Code', codex: 'Codex', cindy: 'Cindy', deepseek: 'DeepSeek', other: '其他来源' }
const roles = { user: '你', assistant: '助手', system: '系统记录', tool: '工具记录' }
type LibraryView = { query: string; source: Source | 'all'; selectedId: string }

function resolveView(view: LibraryView, sessions: Session[]): LibraryView {
  const visible = filterSessions(sessions, view.query, view.source)
  return { ...view, selectedId: visible.find(s => s.id === view.selectedId)?.id ?? visible[0]?.id ?? '' }
}

function sameView(a: LibraryView, b: LibraryView) {
  return a.query === b.query && a.source === b.source && a.selectedId === b.selectedId
}

export function App() {
  const [librarySessions, setSessions] = useState<Session[]>([])
  // 兼容仍在运行的旧主进程；演示记录不能重新进入列表、计数或搜索。
  const sessions = useMemo(() => librarySessions.filter(session => !session.demo), [librarySessions])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  // 每个窗口只在内存保留最近 100 个浏览位置，不修改 URL 或持久化搜索词。
  const [navigation, setNavigation] = useState<{ entries: LibraryView[]; index: number; editingSearch: boolean }>({
    entries: [{ query: '', source: 'all', selectedId: '' }], index: 0, editingSearch: false,
  })
  const { query, source, selectedId } = navigation.entries[navigation.index]
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchTrigger = useRef<HTMLElement | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [handoff, setHandoff] = useState(false)
  const [target, setTarget] = useState<Target>('通用')
  const search = useRef<HTMLInputElement>(null)
  const importTrigger = useRef<HTMLElement | null>(null)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const visible = filterSessions(sessions, query, source)
  const selected = visible.find(s => s.id === selectedId) ?? visible[0]

  useEffect(() => {
    let active = true
    setLoadError('')
    window.staithe.list().then(data => { if (active) { setSessions(data); setLoaded(true) } })
      .catch(error => { if (active) setLoadError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [loadAttempt])
  useEffect(() => {
    if (!loaded || busy || handoff || importPreview) return
    // 仅回读 Pinekin 档案，接收显式批次的入库结果；不访问外部客户端目录。
    function refreshLocalArchives() { setLoadAttempt(value => value + 1) }
    window.addEventListener('focus', refreshLocalArchives)
    return () => window.removeEventListener('focus', refreshLocalArchives)
  }, [loaded, busy, handoff, importPreview])
  useEffect(() => {
    if (!loaded) return
    return window.staithe.onOpenSession(id => {
      if (!sessions.some(s => s.id === id)) { setStatus('本机没有这段会话，请先导入对应的 Pinekin 包。'); return }
      navigate({ query: '', source: 'all', selectedId: id }); setHandoff(false); setSearchOpen(false)
    })
  }, [sessions, loaded])
  useEffect(() => {
    if (searchOpen) { search.current?.focus(); search.current?.select() }
  }, [searchOpen])
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && loaded && !busy && !handoff && !importPreview) {
        event.preventDefault()
        if (searchOpen) { search.current?.focus(); search.current?.select() }
        else openSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [loaded, busy, handoff, importPreview, searchOpen])

  async function perform(action: () => Promise<void>) {
    setBusy(true); setStatus('')
    try { await action() } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  function navigate(update: Partial<LibraryView>, editingSearch = false, available = sessions) {
    setNavigation(previous => {
      const current = resolveView(previous.entries[previous.index], sessions)
      const next = resolveView({ ...current, ...update }, available)
      if (sameView(current, next)) return previous
      const entries = previous.entries.slice(0, previous.index + 1)
      entries[previous.index] = current
      // 连续输入只形成一个搜索位置，避免返回时逐字撤销。
      if (editingSearch && previous.editingSearch) entries[previous.index] = next
      else entries.push(next)
      const bounded = entries.slice(-100)
      return { entries: bounded, index: bounded.length - 1, editingSearch }
    })
  }
  function travel(direction: -1 | 1) {
    setNavigation(previous => {
      const index = previous.index + direction
      if (index < 0 || index >= previous.entries.length) return previous
      return { ...previous, index, editingSearch: false }
    })
  }
  function resetFilters() { navigate({ query: '', source: 'all' }) }
  function openSearch() {
    searchTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSearchOpen(true)
  }
  function previewImport() {
    // 在禁用触发按钮和打开系统文件框前记录焦点，不能等 modal 挂载后再读取。
    importTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void perform(async () => { setImportPreview(await window.staithe.previewImport()) })
  }
  function cancelImport() {
    if (busy || !importPreview) return
    const token = importPreview.token
    void perform(async () => { await window.staithe.cancelImport(token); setImportPreview(null) })
  }
  function confirmImport() {
    if (!importPreview) return
    void perform(async () => {
      const result = await window.staithe.confirmImport(importPreview.token)
      setImportPreview(null)
      const data = await window.staithe.list()
      setSessions(data)
      navigate({ query: '', source: 'all', selectedId: result.session.id }, false, data)
      setStatus(result.duplicate ? '已打开相同文件的已有档案，未创建副本' : '已导入本地档案并保留原件，未修改来源客户端')
    })
  }
  function exportSession(format: ExportFormat) {
    void perform(async () => {
      const saved = await window.staithe.exportSession(selected.id, format, target)
      setStatus(saved ? '已导出到你选择的位置' : '已取消导出')
    })
  }
  function copy(text: string, message: string) {
    void perform(async () => { await window.staithe.copy(text); setStatus(message) })
  }

  const navigationButtons = <nav className="header-navigation" aria-label="浏览导航">
    <DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="返回" disabled={!loaded || busy || navigation.index === 0} onClick={() => travel(-1)}><DesignIcon name="back" /></DsButton>
    <DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="前进" disabled={!loaded || busy || navigation.index === navigation.entries.length - 1} onClick={() => travel(1)}><DesignIcon name="arrow" /></DsButton>
    <DsButton variant="ghost" size="small" iconOnly iconRelaxed className="sidebar-toggle" aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-controls="archive-sidebar" aria-expanded={sidebarOpen}
      onClick={() => setSidebarOpen(value => !value)}><DesignIcon name={sidebarOpen ? 'panel-open' : 'panel-closed'} /></DsButton>
  </nav>

  const separateNavigation = window.staithe.platform === 'darwin' || window.staithe.platform === 'win32'
  return <div className="shell" data-platform={window.staithe.platform}>
    {separateNavigation && <div className="window-toolbar">{window.staithe.platform === 'darwin' && <div className="window-controls-space" aria-hidden="true" />}{navigationButtons}</div>}
    <div className="app-body">
    <Sidebar open={sidebarOpen}>
      <div className="brand"><span className="brand-logo">pinekin<span className="brand-dot">.</span></span>
        <DsButton variant="ghost" size="small" iconOnly iconRelaxed className="search-trigger" aria-label="搜索" aria-haspopup="dialog" aria-expanded={searchOpen} aria-keyshortcuts="Meta+K Control+K"
          data-active={Boolean(query)} disabled={!loaded || busy} onClick={openSearch}><DesignIcon name="search" /></DsButton>
      </div>
      <ScrollArea className="sidebar-section">
        <button type="button" className="nav-item" aria-label="导入会话文件" aria-haspopup="dialog" disabled={busy || !loaded} onClick={previewImport}>
          <span><DesignIcon name="plus" /><FadeText text="导入会话" /></span>
        </button>
        <div className="nav-label sources-label">会话来源</div>
        <button className={`nav-item ${source === 'all' ? 'active' : ''}`} aria-pressed={source === 'all'} onClick={() => navigate({ source: 'all' })}>
          <span><DesignIcon name="archive" /><FadeText text="所有会话" /></span><span className="count">{sessions.length}</span>
        </button>
        {[...adapters.map(a => ({ id: a.id, name: a.name })), { id: 'other' as const, name: '其他来源' }].map(adapter =>
          <button key={adapter.id} className={`nav-item ${source === adapter.id ? 'active' : ''}`} aria-pressed={source === adapter.id}
            onClick={() => navigate({ source: adapter.id })}><span><SourceIcon source={adapter.id} /><FadeText text={adapter.name} /></span>
            <span className="count">{sessions.filter(s => s.source === adapter.id).length}</span></button>)}
      </ScrollArea>
      <div className="sidebar-bottom">
        <section className="storage-note" aria-label="本地存储与隐私">
          <div className="storage-copy">
            <div className="local-info">仅保存在本机</div>
            <p className="storage-description">仅导入你选择的文件</p>
            <div className="storage-boundaries"><span>不自动扫描</span><span aria-hidden="true">·</span><span>不上传</span></div>
          </div>
          <img className="storage-illustration" src={localStorageIllustration} alt="" aria-hidden="true" draggable={false} />
        </section>
      </div>
    </Sidebar>
    <main className="workspace-card">
      <div className="workspace">
        <section className="session-pane" aria-label="会话列表">
          {!separateNavigation && <header className="topbar">{navigationButtons}</header>}
          <div className="list-heading"><h2>{source === 'all' ? '所有会话' : names[source]}</h2><span>{visible.length} 段会话</span></div>
          <ScrollArea className="session-list" aria-busy={!loaded && !loadError}>
            {!loaded && !loadError && <div className="empty" role="status"><DesignIcon name="archive" size={24} /><p>正在读取本地档案…</p></div>}
            {loadError && <div className="empty"><DesignIcon name="info" size={24} /><h3>暂时无法读取档案</h3><p role="alert">{loadError}</p><DsButton onClick={() => setLoadAttempt(value => value + 1)}>重新加载</DsButton></div>}
            {visible.map(s => <button key={s.id} className={`session-card ${selected?.id === s.id ? 'selected' : ''}`} aria-pressed={selected?.id === s.id} onClick={() => navigate({ selectedId: s.id })}>
              <div className="card-meta"><span><SourceIcon source={s.source} size={14} />{names[s.source]}</span><time dateTime={s.updatedAt}>{s.updatedAt.slice(5, 10).replace('-', '.')}</time></div>
              <h3>{s.title}</h3>
            </button>)}
            {loaded && !visible.length && <div className="empty"><DesignIcon name="search" size={24} /><h3>{sessions.length ? '没有找到匹配的会话' : '还没有会话档案'}</h3><p>{sessions.length ? '试试其他关键词，或清空当前筛选。' : '导入后，你的会话会出现在这里。'}</p>{sessions.length > 0 && <DsButton onClick={resetFilters}>清空筛选</DsButton>}</div>}
          </ScrollArea>
        </section>
        <section className="detail" aria-label="会话详情" key={selected?.id ?? 'empty'}>
          {selected ? <>
            <div className="detail-header">
              <div className="detail-title-row"><h2>{selected.title}</h2><div className="reader-state"><span className="archive-badge">本地档案</span><span className="read-only"><DesignIcon name="lock" size={13} />只读</span></div></div>
              <div className="detail-meta"><span><SourceIcon source={selected.source} size={14} />{names[selected.source]}</span><span>{selected.messages.length} 条消息</span><time dateTime={selected.updatedAt}>{selected.updatedAt.slice(0, 10)}</time><span>仅文本 · 非原生会话</span></div>
            </div>
            {selected.archive && <details className="archive-report"><summary><DesignIcon name="info" size={16} /><span>导入报告 · 仅文本档案</span><span className="report-count">{selected.archive.warnings.length} 项说明</span><DesignIcon name="chevron" size={14} /></summary>
              <ScrollArea className="report-body"><p>适配器：{selected.archive.adapterId} · {selected.archive.adapterVersion}。原始文件不随交接导出。</p>
                <ul>{selected.archive.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></ScrollArea>
            </details>}
            <ScrollArea className="messages" role="region" aria-label="会话消息" tabIndex={0}><div className="message-column">{selected.messages.length ? selected.messages.map((message, index) => <article key={index} className={`message ${message.role}`} aria-label={`第 ${index + 1} 条消息 · ${roles[message.role]}`}>
              <div className={`message-body ${message.role === 'user' ? 'message-bubble' : message.role === 'assistant' ? 'chat-assistant-content' : 'message-record'}`}>
                {(message.role === 'system' || message.role === 'tool') && <div className="record-label"><DesignIcon name="code" size={14} />{roles[message.role]}</div>}
                <MessageContent content={message.content} />
              </div>
            </article>) : <div className="empty"><p>这段会话暂时没有消息</p></div>}<div className="conversation-end"><span />档案到这里，思考可以继续<span /></div></div></ScrollArea>
            <footer className="detail-footer"><DsButton variant="ghost" disabled={busy} onClick={() => copy(makeDeepLink(selected.id), '已复制本地链接；跨设备需先导入会话包')}><DesignIcon name="link" />复制本地链接</DsButton>
              <DsButton variant="primary" disabled={busy} onClick={() => { setStatus(''); setHandoff(true) }}>Pin 走这段对话<DesignIcon name="arrow" /></DsButton></footer>
          </> : <div className="empty detail-empty"><div className="empty-mark"><DesignIcon name="dock" size={32} /></div><h2>{loaded && !sessions.length ? '让第一段思考，在这里停靠' : '换个地方，继续思考。'}</h2><p>{loaded && !sessions.length ? '选择一份会话文件，预览后保存到本机。' : '收好散落的对话，把上下文留给下一步。'}</p>{loaded && !sessions.length && <DsButton variant="primary" disabled={busy} onClick={previewImport}><DesignIcon name="plus" />选择会话文件</DsButton>}<span className="empty-footnote">本地归档 · 只读浏览 · 文本交接</span></div>}
        </section>
      </div>
      {!searchOpen && !handoff && !importPreview && status && <div className="toast" role="status"><DesignIcon name="info" /><span>{status}</span><DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="关闭提示" onClick={() => setStatus('')}><DesignIcon name="close" /></DsButton></div>}
    </main>
    </div>
    {searchOpen && <DsDialog titleId="search-title" onDismiss={() => setSearchOpen(false)} busy={false} returnFocus={searchTrigger.current} dismissOnBackdrop>
      <h2 id="search-title" className="visually-hidden">搜索会话</h2>
      <div className="search-header">
        <div className="search"><DesignIcon name="search" /><input ref={search} aria-label="搜索会话" value={query}
          onChange={event => navigate({ query: event.target.value }, true)} placeholder="搜索标题、正文或标签" />
          {query && <DsButton variant="ghost" size="small" className="search-clear" aria-label="清空搜索" onClick={() => { navigate({ query: '' }); search.current?.focus() }}>清空</DsButton>}
          <DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="关闭搜索" onClick={() => setSearchOpen(false)}><DesignIcon name="close" /></DsButton>
        </div>
      </div>
      <ScrollArea className="dialog-content search-content">
        <p className="search-context">当前来源内 · {visible.length} 段会话</p>
        <ScrollArea className="search-results">{visible.map(session => <button key={session.id} className="search-result" aria-label={`打开档案：${session.title}`}
          onClick={() => { navigate({ selectedId: session.id }); setSearchOpen(false) }}>
          <SourceIcon source={session.source} /><span><strong>{session.title}</strong><small>{names[session.source]}</small></span><DesignIcon name="chevron" size={14} />
        </button>)}</ScrollArea>
        {!visible.length && <p className="search-empty">没有匹配的档案</p>}
      </ScrollArea>
    </DsDialog>}
    {importPreview && <DsDialog titleId="import-title" onDismiss={cancelImport} busy={busy} returnFocus={importTrigger.current}>
      <div className="dialog-header"><div className="dialog-icon"><DesignIcon name="archive" size={22} /></div><div><div className="eyebrow">只读导入</div><h2 id="import-title">确认导入档案</h2></div><DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="关闭导入预览" disabled={busy} onClick={cancelImport}><DesignIcon name="close" /></DsButton></div>
      <ScrollArea className="dialog-content"><div className="import-file"><strong>{importPreview.title}</strong><p>{importPreview.sourceName} · {importPreview.messageCount} 条消息 · {importPreview.byteLength.toLocaleString('zh-CN')} 字节</p></div>
        <div className="notice"><DesignIcon name="info" /><div><strong>兼容范围有限</strong><p>验证状态：合成夹具通过，未经第三方客户端实机验证。</p></div></div>
        {importPreview.warnings.length > 0 && <div className="import-report"><h3>导入说明与缺失项 <span>{importPreview.warnings.length}</span></h3><ul className="import-warnings">{importPreview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        <p className="privacy-note">确认后在本机明文保存原始文件和文本档案，原件可能包含附件、工作区路径及敏感信息。不会上传、执行历史指令或修改来源客户端。原件不随交接导出。</p>
        <details className="format-help"><summary>支持格式与能力边界</summary><p>支持 Pinekin（沿用 Staithe 格式）/ Ember 包、Pinekin NewMax 1.1.22 普通主会话白名单快照、Claude Code 完整单根 JSONL 的末条消息父链文本投影、未加密 Cindy v1 分享包及 Pinekin Cindy 本地快照、Codex 独立主会话 JSONL / JSONL.ZST、DeepSeek Harness v4 独立主会话 JSONL / JSONL.ZSTD。Claude Code 其他分支和压缩/逻辑父链不在支持范围；DeepSeek 网页聊天导出仍未支持；不支持自动扫描或原生恢复。</p></details>
        {importPreview.duplicate && <p className="duplicate-note">这个文件已导入，将打开已有档案，不新增副本。</p>}
        {status && <div className="dialog-status" role="status">{status}</div>}
      </ScrollArea>
      <div className="dialog-footer"><span className="footer-note"><DesignIcon name="shield" size={14} />仅保存在本机</span><div className="export-actions"><DsButton disabled={busy} onClick={cancelImport}>取消导入</DsButton><DsButton variant="primary" disabled={busy} onClick={confirmImport}>{busy ? '正在处理…' : importPreview.duplicate ? '打开已有档案' : '确认保存到本地'}</DsButton></div></div>
    </DsDialog>}
    {handoff && selected && <DsDialog titleId="handoff-title" onDismiss={() => setHandoff(false)} busy={busy}>
      <div className="dialog-header"><div className="dialog-icon"><DesignIcon name="arrow" size={22} /></div><div><div className="eyebrow">上下文交接</div><h2 id="handoff-title">让这段思考，有下文。</h2></div><DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="关闭交接面板" disabled={busy} onClick={() => setHandoff(false)}><DesignIcon name="close" /></DsButton></div>
      <ScrollArea className="dialog-content"><p className="dialog-description">带走完整文本，交给下一个工具继续。<br />这不是原生恢复，不会迁移工具状态、附件或权限。</p>
        <label className="target-label">接续目标<select aria-label="接续目标" value={target} disabled={busy} onChange={event => setTarget(event.target.value as Target)}>{(['通用', 'NewMax', 'Claude Code', 'Codex'] as const).map(t => <option key={t}>{t}</option>)}</select></label>
        <div className="preview-label">交接文本预览<span>只生成文本，不自动执行</span></div>
        <ScrollArea as="pre" className="handoff-preview" tabIndex={0}>{makeHandoff(selected, target)}</ScrollArea>
        <p className="privacy-note">导出前请检查敏感信息。当前不会自动脱敏，也不会上传或发送给目标客户端。</p>
        {status && <div className="dialog-status" role="status">{status}</div>}
      </ScrollArea>
      <div className="dialog-footer"><div className="export-actions"><DsButton disabled={busy} onClick={() => exportSession('bundle')}>导出 Pinekin 包</DsButton><DsButton disabled={busy} onClick={() => exportSession('markdown')}>导出 Markdown</DsButton><DsButton variant="primary" disabled={busy} onClick={() => copy(makeHandoff(selected, target), '已复制交接文本，粘贴到目标客户端后继续')}><DesignIcon name="copy" />复制交接文本</DsButton></div></div>
    </DsDialog>}
  </div>
}
