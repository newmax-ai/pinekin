import { useEffect, useRef, useState } from 'react'
import { browsableSources, sourceLocations, sourceNames, type BrowsableSource, type SourceConnection, type SourceContent, type SourceEntry, type SourcePage } from '../../core/sources'
import { Sidebar } from './components/Sidebar'
import { ScrollArea } from './components/ScrollArea'
import { SourceIcon } from './components/SourceIcon'
import { FadeText } from './components/FadeText'
import { DsButton, DsDialog, DsDialogClose, DsDialogHeader, DesignIcon } from './components/ui'
import { DsSelect } from './components/DsSelect'
import { MessageContent } from './components/MessageContent'
import localStorageIllustration from './assets/pinekin-local-storage.svg'

const emptyPage: SourcePage = { items: [], total: 0, offset: 0, hasMore: false, connections: [] }
const statusNames = { idle: '待刷新', scanning: '统计中', ready: '已连接', partial: '部分可读', cancelled: '已暂停', error: '读取失败' }
const displaySources: BrowsableSource[] = ['newmax', 'claude-code', 'codex', 'cindy', 'deepseek']
const roles = { user: '你', assistant: '助手', system: '系统记录', tool: '工具记录' }
type BrowserView = { source: BrowsableSource | 'all'; query: string; selected?: SourceEntry }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }
function countLabel(connections: SourceConnection[]) {
  if (!connections.length) return '未连接'
  if (connections.some(item => item.status === 'scanning')) return '统计中'
  if (connections.some(item => item.status === 'error')) return '读取失败'
  if (connections.some(item => item.status === 'partial' || item.status === 'cancelled')) return '部分'
  if (connections.some(item => item.status === 'idle')) return '待刷新'
  return String(connections.reduce((total, item) => total + (item.total ?? 0), 0))
}

export function SourceApp({ onArchives }: { onArchives: () => void }) {
  const [navigation, setNavigation] = useState<{ entries: BrowserView[]; index: number; editingSearch: boolean }>({
    entries: [{ source: 'all', query: '' }], index: 0, editingSearch: false,
  })
  const { source, query, selected } = navigation.entries[navigation.index]
  const [page, setPage] = useState<SourcePage>(emptyPage)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [readAttempt, setReadAttempt] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectSource, setConnectSource] = useState<BrowsableSource>('newmax')
  const [connectionNotice, setConnectionNotice] = useState('')
  const [manualFallback, setManualFallback] = useState(false)
  const [partialSource, setPartialSource] = useState<BrowsableSource>()
  const [choosingLocation, setChoosingLocation] = useState(false)
  const [managing, setManaging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [content, setContent] = useState<SourceContent>()
  const [readError, setReadError] = useState('')
  const [reading, setReading] = useState(false)
  const [handoff, setHandoff] = useState(false)
  const [target, setTarget] = useState<BrowsableSource>('newmax')
  const readRequest = useRef(0)
  const listRequest = useRef(0)
  const search = useRef<HTMLInputElement>(null)
  const searchTrigger = useRef<HTMLElement | null>(null)
  const connectionTrigger = useRef<HTMLElement | null>(null)
  const relevant = page.connections.filter(item => source === 'all' || item.source === source)
  const scanning = page.connections.some(item => item.status === 'scanning')
  const complete = relevant.length > 0 && relevant.every(item => item.status === 'ready')
  const discovered = relevant.reduce((sum, item) => sum + item.discovered, 0)
  const count = !loaded ? '正在读取…' : relevant.length ? complete ? `${page.items.length} / ${page.total} 条已加载` : `发现 ${discovered} 条，统计未完成` : '未连接'

  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const request = ++listRequest.current
    setLoaded(false); setError(''); setLoadingMore(false)
    setPage(previous => ({ ...emptyPage, connections: previous.connections }))
    async function load() {
      try {
        const result = await window.staithe.sources.page({ ...(source === 'all' ? {} : { source }), query, offset: 0, limit: 50 })
        if (!active || request !== listRequest.current) return
        setPage(result); setLoaded(true)
        if (result.connections.some(item => item.status === 'scanning')) timer = setTimeout(() => void load(), 400)
      } catch (reason) { if (active) { setError(errorText(reason)); setLoaded(true) } }
    }
    void load()
    return () => { active = false; clearTimeout(timer) }
  }, [source, query, reload])
  useEffect(() => {
    const request = ++readRequest.current
    setContent(undefined); setReadError(''); setHandoff(false); setReading(false)
    if (!selected) return
    if (selected.availability === 'unsupported') { setReadError(selected.reason ?? '正文暂未支持'); return }
    setReading(true)
    window.staithe.sources.read(selected.id).then(result => {
      if (request === readRequest.current) setContent(result)
    }).catch(reason => {
      if (request === readRequest.current) setReadError(errorText(reason))
    }).finally(() => { if (request === readRequest.current) setReading(false) })
    return () => { readRequest.current += 1 }
  }, [selected, readAttempt])
  useEffect(() => { if (searchOpen) { search.current?.focus(); search.current?.select() } }, [searchOpen])
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || !loaded || busy || connecting || managing || handoff) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (searchOpen) { search.current?.focus(); search.current?.select() }
        else openSearch()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [loaded, busy, connecting, managing, handoff, searchOpen])

  function navigate(update: Partial<BrowserView>, editingSearch = false) {
    setNavigation(previous => {
      const current = previous.entries[previous.index], next = { ...current, ...update }
      if (current.source === next.source && current.query === next.query && current.selected?.id === next.selected?.id) return previous
      const entries = previous.entries.slice(0, previous.index + 1)
      if (editingSearch && previous.editingSearch) entries[previous.index] = next
      else entries.push(next)
      const bounded = entries.slice(-100)
      return { entries: bounded, index: bounded.length - 1, editingSearch }
    })
  }
  function travel(direction: -1 | 1) {
    setNavigation(previous => {
      const index = previous.index + direction
      return index < 0 || index >= previous.entries.length ? previous : { ...previous, index, editingSearch: false }
    })
  }
  function clearSelection() {
    readRequest.current += 1; setContent(undefined); setReadError(''); setReading(false); setHandoff(false)
    // 刷新／撤销授权同时清掉历史中的旧选择，不保留正文副本或过期对象。
    setNavigation(previous => ({ ...previous, entries: previous.entries.map(view => ({ ...view, selected: undefined })) }))
  }
  function openSearch() {
    searchTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSearchOpen(true)
  }
  function openConnections() {
    connectionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (source !== 'all') setConnectSource(source)
    setConnectionNotice(''); setManualFallback(false); setPartialSource(undefined); setError('')
    setConnecting(true)
  }
  async function action(run: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await run(); setReload(value => value + 1) }
    catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  function connected(source: BrowsableSource) {
    clearSelection(); navigate({ source, query: '', selected: undefined }); setConnecting(false)
  }
  function connect() {
    if (busy) return
    setConnectionNotice(''); setManualFallback(false); setPartialSource(undefined)
    void action(async () => {
      const result = await window.staithe.sources.autoConnect(connectSource)
      setConnectionNotice(result.warnings.join('；'))
      if (result.connections.length) {
        if (result.warnings.length) setPartialSource(result.connections[0].source)
        else connected(result.connections[0].source)
      } else setManualFallback(true)
    })
  }
  function connectManually() {
    if (busy) return
    // 取消系统选择框不应清掉原来的连接结果与恢复指引。
    setBusy(true); setChoosingLocation(true)
    window.staithe.sources.connect(connectSource).then(result => {
      if (result) { setError(''); setConnectionNotice(''); connected(result.source); setReload(value => value + 1) }
    }).catch(reason => setError(errorText(reason)))
      .finally(() => { setBusy(false); setChoosingLocation(false) })
  }
  function refresh(ids = relevant.map(item => item.id)) {
    clearSelection()
    void action(async () => { for (const id of ids) await window.staithe.sources.refresh(id) })
  }
  async function more() {
    const request = listRequest.current
    setLoadingMore(true)
    try {
      const result = await window.staithe.sources.page({ ...(source === 'all' ? {} : { source }), query, offset: page.items.length, limit: 50 })
      if (request !== listRequest.current) return
      setPage(previous => ({ ...result, items: [...new Map([...previous.items, ...result.items].map(item => [item.id, item])).values()] }))
    } catch (reason) { if (request === listRequest.current) setError(errorText(reason)) }
    finally { if (request === listRequest.current) setLoadingMore(false) }
  }
  const toolbar = <nav className="header-navigation" aria-label="浏览导航">
    <DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="返回" disabled={!loaded || busy || navigation.index === 0} onClick={() => travel(-1)}><DesignIcon name="back" /></DsButton>
    <DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="前进" disabled={!loaded || busy || navigation.index === navigation.entries.length - 1} onClick={() => travel(1)}><DesignIcon name="arrow" /></DsButton>
    <DsButton variant="ghost" size="small" iconOnly iconRelaxed className="sidebar-toggle" aria-controls="archive-sidebar" aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-expanded={sidebarOpen}
      onClick={() => setSidebarOpen(value => !value)}><DesignIcon name={sidebarOpen ? 'panel-open' : 'panel-closed'} /></DsButton>
  </nav>
  const separateNavigation = window.staithe.platform === 'darwin' || window.staithe.platform === 'win32'
  const connectionProblem = error || connectionNotice
  const firstConnectionUnsupported = connectSource === 'newmax' && manualFallback && !error
  const connectionFeedback = Boolean(connectionProblem || manualFallback || partialSource)
  const connectionHeading = busy ? choosingLocation ? '等待选择位置' : `正在连接 ${sourceNames[connectSource]}…`
    : partialSource ? '部分位置已连接' : firstConnectionUnsupported ? 'NewMax 暂不支持首次自动连接'
      : connectionFeedback ? '连接未完成' : '连接后，直接浏览会话'
  const connectionDescription = busy ? choosingLocation ? '在系统窗口中选择位置；取消后可返回这里。' : '正在查找本机会话或复用已有连接，请稍候。'
    : partialSource ? '部分位置未能连接。你可以先查看已连接位置的会话，其他原因见详情。'
      : firstConnectionUnsupported ? '可以先连接其他 App；已有连接可在「管理连接」中查看。'
        : connectionFeedback ? '请确认该 App 已有本机会话且允许读取，然后重试；也可以选择其他 App。'
          : connectSource === 'newmax' ? '将尝试复用已有连接；首次自动定位暂未支持。'
            : connectSource === 'cindy' ? '自动查找本机会话；目前仅支持部分数据库的列表，正文暂不可读。'
              : 'Pinekin 自动查找本机会话，无需导出或导入。'
  const connectionAction = busy ? choosingLocation ? '等待选择…' : '正在连接…' : partialSource ? '查看已连接会话'
    : firstConnectionUnsupported ? '选择其他 App' : connectionFeedback ? '重试连接' : '连接'

  return <div className="shell" data-platform={window.staithe.platform}>
    {separateNavigation && <div className="window-toolbar">{window.staithe.platform === 'darwin' && <div className="window-controls-space" aria-hidden="true" />}{toolbar}</div>}
    <div className="app-body">
      <Sidebar open={sidebarOpen}>
        <div className="brand"><span className="brand-logo">pinekin<span className="brand-dot">.</span></span>
          <DsButton variant="ghost" size="small" iconOnly iconRelaxed className="search-trigger" aria-label="搜索" aria-haspopup="dialog" aria-expanded={searchOpen} aria-keyshortcuts="Meta+K Control+K"
            data-active={Boolean(query)} disabled={!loaded || busy} onClick={openSearch}><DesignIcon name="search" /></DsButton>
        </div>
        <ScrollArea className="sidebar-section">
          <button className="nav-item" aria-haspopup="dialog" disabled={busy || !loaded} onClick={openConnections}><span><DesignIcon name="plus" /><FadeText text="连接 App" /></span></button>
          <div className="nav-label sources-label">会话来源</div>
          <button className={`nav-item ${source === 'all' ? 'active' : ''}`} aria-pressed={source === 'all'} onClick={() => navigate({ source: 'all', selected: undefined })}><span><DesignIcon name="archive" /><FadeText text="所有会话" /></span><span className="count">{countLabel(page.connections)}</span></button>
          {displaySources.map(id => <button key={id} className={`nav-item ${source === id ? 'active' : ''}`} aria-pressed={source === id} onClick={() => navigate({ source: id, selected: undefined })}>
            <span><SourceIcon source={id} /><FadeText text={sourceNames[id]} /></span><span className="count">{countLabel(page.connections.filter(item => item.source === id))}</span></button>)}
        </ScrollArea>
        <div className="sidebar-bottom"><section className="storage-note" aria-label="本地存储与隐私">
          <div className="storage-copy"><div className="local-info">仅在本机读取</div><p className="storage-description">仅浏览你授权的会话</p><div className="storage-boundaries"><span>授权后读取</span><span aria-hidden="true">·</span><span>不上传</span></div></div>
          <img className="storage-illustration" src={localStorageIllustration} alt="" aria-hidden="true" draggable={false} />
        </section></div>
      </Sidebar>
      <main className="workspace-card"><div className="workspace">
        <section className="session-pane" aria-label="来源会话列表">
          {!separateNavigation && <header className="topbar">{toolbar}</header>}
          <div className="list-heading"><h2>{source === 'all' ? '所有会话' : sourceNames[source]}</h2><span role="status">{count}</span></div>
          <ScrollArea className="session-list" aria-busy={!loaded || scanning}>
            {!loaded && !error && <div className="empty" role="status"><DesignIcon name="archive" size={24} /><p>正在读取来源目录…</p></div>}
            {page.items.map(entry => <button key={entry.id} className={`session-card ${selected?.id === entry.id ? 'selected' : ''}`} aria-label={`${entry.title} ${entry.project}`} aria-pressed={selected?.id === entry.id} onClick={() => navigate({ selected: entry })}>
              <div className="card-meta"><span><SourceIcon source={entry.source} size={14} />{sourceNames[entry.source]}</span><time dateTime={entry.updatedAt}>{entry.updatedAt.slice(5, 10).replace('-', '.')}</time></div><h3>{entry.title}</h3>
            </button>)}
            {loaded && !page.items.length && <div className="empty"><DesignIcon name="search" size={24} /><h3>{scanning ? '正在发现会话…' : relevant.length ? '当前没有可列出的会话' : '尚未连接此来源'}</h3><p>{relevant.length ? '检查连接状态，或调整搜索条件。' : '连接后，你的会话会出现在这里。'}</p>
              {relevant.length > 0 && <DsButton disabled={busy} onClick={() => refresh()}>刷新</DsButton>}
            </div>}
            {page.hasMore && <DsButton disabled={scanning || loadingMore || !loaded} onClick={() => void more()}>{loadingMore ? '正在加载…' : '加载更多'}</DsButton>}
          </ScrollArea>
        </section>
        <section className="detail" aria-label="来源会话详情" key={selected?.id ?? 'empty'}>
          {selected ? <>
            <div className="detail-header">
              <div className="detail-title-row"><h2>{content?.session.title ?? selected.title}</h2><div className="reader-state"><span className="archive-badge">来源直读</span><span className="read-only"><DesignIcon name="lock" size={13} />只读</span></div></div>
              <div className="detail-meta"><span><SourceIcon source={selected.source} size={14} />{sourceNames[selected.source]}</span><span>{content ? `${content.session.messages.length} 条消息` : '正文按需读取'}</span><time dateTime={selected.updatedAt}>{selected.updatedAt.slice(0, 10)}</time><span>未导入 Pinekin</span></div>
            </div>
            {reading && <div className="empty" role="status">正在读取来源正文…</div>}
            {readError && <div className="empty"><DesignIcon name="info" size={24} /><h3>会话已发现，正文暂不可用</h3><p role="alert">{readError}</p>{selected.availability !== 'unsupported' && <DsButton onClick={() => setReadAttempt(value => value + 1)}>重试读取</DsButton>}</div>}
            {content && <>
              <details className="archive-report"><summary><DesignIcon name="info" size={16} /><span>读取报告 · 仅文本投影</span><span className="report-count">{content.warnings.length} 项说明</span><DesignIcon name="chevron" size={14} /></summary><ScrollArea className="report-body"><ul>{content.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></ScrollArea></details>
              <ScrollArea className="messages" role="region" aria-label="会话消息" tabIndex={0}><div className="message-column">{content.session.messages.map((message, index) => <article key={index} className={`message ${message.role}`} aria-label={`第 ${index + 1} 条消息 · ${roles[message.role]}`}>
                <div className={`message-body ${message.role === 'user' ? 'message-bubble' : message.role === 'assistant' ? 'chat-assistant-content' : 'message-record'}`}>
                  {(message.role === 'system' || message.role === 'tool') && <div className="record-label"><DesignIcon name="code" size={14} />{roles[message.role]}</div>}
                  <MessageContent content={message.content} />
                </div>
              </article>)}<div className="conversation-end"><span />对话到这里，思考可以继续<span /></div></div></ScrollArea>
              <footer className="detail-footer"><DsButton variant="ghost" disabled={busy} onClick={() => refresh()}>刷新来源</DsButton><DsButton variant="primary" disabled={busy} onClick={() => setHandoff(true)}>Pin 走这段对话<DesignIcon name="arrow" /></DsButton></footer>
            </>}
          </> : <div className="empty detail-empty"><div className="empty-mark"><DesignIcon name="dock" size={32} /></div><h2>{loaded && !page.connections.length ? '让第一段思考，在这里停靠' : '换个地方，继续思考。'}</h2><p>{loaded && !page.connections.length ? '选择一个来源 App，授权后直接浏览会话。' : '选中一段对话，从来源按需读取正文。'}</p><span className="empty-footnote">本地读取 · 只读浏览 · 按需接续</span></div>}
        </section>
      </div>
      {(error || connectionNotice) && !searchOpen && !connecting && !managing && <div className="toast" role="alert"><DesignIcon name="info" /><span>{error || connectionNotice}</span><DsButton onClick={openConnections}>检查连接</DsButton><DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="关闭提示" onClick={() => { setError(''); setConnectionNotice('') }}><DesignIcon name="close" /></DsButton></div>}
      </main>
    </div>
    {searchOpen && <DsDialog titleId="search-title" busy={false} onDismiss={() => setSearchOpen(false)} returnFocus={searchTrigger.current} dismissOnBackdrop>
      <h2 id="search-title" className="visually-hidden">搜索会话</h2>
      <div className="search-header"><div className="search"><DesignIcon name="search" /><input ref={search} aria-label="搜索会话" value={query} placeholder="搜索标题、项目或会话 ID" onChange={event => navigate({ query: event.target.value, selected: undefined }, true)} />
        {query && <DsButton variant="ghost" size="small" className="search-clear" aria-label="清空搜索" onClick={() => { navigate({ query: '', selected: undefined }); search.current?.focus() }}>清空</DsButton>}
        <DsDialogClose aria-label="关闭搜索" onClick={() => setSearchOpen(false)} />
      </div></div>
      <ScrollArea className="dialog-content search-content"><p className="search-context">当前来源内 · {count} · 仅搜索元数据</p>
        <ScrollArea className="search-results">{page.items.map(entry => <button key={entry.id} className="search-result" aria-label={`打开会话：${entry.title}`} onClick={() => { navigate({ selected: entry }); setSearchOpen(false) }}>
          <SourceIcon source={entry.source} /><span><strong>{entry.title}</strong><small>{sourceNames[entry.source]}{entry.project && ` · ${entry.project}`}</small></span><DesignIcon name="chevron" size={14} />
        </button>)}</ScrollArea>
        {page.hasMore && <DsButton disabled={scanning || loadingMore || !loaded} onClick={() => void more()}>加载更多结果</DsButton>}
        {loaded && !page.items.length && <p className="search-empty">没有匹配的会话</p>}{error && <p role="alert" className="dialog-status">{error}</p>}
      </ScrollArea>
    </DsDialog>}
    {connecting && <DsDialog titleId="connect-title" busy={busy} onDismiss={() => setConnecting(false)} returnFocus={connectionTrigger.current}>
      <DsDialogHeader titleId="connect-title" title="连接来源 App" className="connection-header" closeLabel="关闭连接面板" busy={busy} onDismiss={() => setConnecting(false)} />
      <ScrollArea className="dialog-content connection-content">
        <div className="connection-field">
          <label htmlFor="connect-source">来源 App</label>
          <DsSelect id="connect-source" aria-label="来源 App" aria-describedby="connect-source-description" value={connectSource} disabled={busy}
            options={browsableSources.map(id => ({ value: id, label: sourceNames[id] }))}
            onChange={value => { setConnectSource(value as BrowsableSource); setError(''); setConnectionNotice(''); setManualFallback(false); setPartialSource(undefined) }} />
        </div>
        <section className="connection-card" aria-label="连接说明" data-state={busy ? 'connecting' : connectionFeedback ? 'attention' : 'idle'}>
          <div className="connection-card-message" role={busy ? 'status' : connectionFeedback ? 'alert' : undefined} aria-atomic="true">
            <h3>{connectionHeading}</h3><p id="connect-source-description">{connectionDescription}</p>
          </div>
          <p className="connection-card-privacy"><DesignIcon name="shield" size={14} />只读访问 · 不保存正文 · 不修改来源</p>
          <details key={connectSource} className="format-help connection-help">
            <summary><DesignIcon name="chevron" size={14} />{connectionFeedback ? '查看详情与其他方式' : '支持范围与隐私说明'}</summary>
            {connectionProblem && <p className="connection-card-reason">{connectionProblem}</p>}
            <p>仅访问此 App 的默认或已授权位置，包含隐私会话标题；不搜索整盘、不读取凭据。只保存连接位置，重启后需刷新。{connectSource === 'codex' && '当前会话与历史归档会一并连接。'}</p>
            <p>{sourceLocations[connectSource]}</p>
            <DsButton variant="tertiary" size="small" disabled={busy} onClick={connectManually}>使用自定义位置…</DsButton>
          </details>
        </section>
      </ScrollArea><div className="dialog-footer"><div className="export-actions"><DsButton variant="ghost" disabled={busy} onClick={() => { setConnecting(false); setManaging(true) }}>管理连接</DsButton><DsButton variant="ghost" disabled={busy} onClick={onArchives}>已有档案</DsButton></div><DsButton variant="primary" disabled={busy} onClick={() => {
        if (partialSource) connected(partialSource)
        else if (firstConnectionUnsupported) document.getElementById('connect-source')?.focus()
        else connect()
      }}>{connectionAction}</DsButton></div>
    </DsDialog>}
    {managing && <DsDialog titleId="connections-title" busy={busy} onDismiss={() => setManaging(false)} returnFocus={connectionTrigger.current}>
      <DsDialogHeader titleId="connections-title" title="管理连接" eyebrow="位置授权" closeLabel="关闭连接管理" busy={busy} onDismiss={() => setManaging(false)} />
      <ScrollArea className="dialog-content"><p className="dialog-description">断开只撤销 Pinekin 的读取入口，不删除来源会话或已有档案。</p>{page.connections.map(connection => <section key={connection.id} className="import-report">
        <h3><SourceIcon source={connection.source} /> {sourceNames[connection.source]} · {connection.label}</h3><p className="privacy-note">{statusNames[connection.status]} · 已发现 {connection.discovered} 条{connection.total === null ? ' · 总数未确定' : ` · 共 ${connection.total} 条`}</p>
        {connection.error && <p role="alert" className="dialog-status">{connection.error}</p>}<p className="privacy-note">不可访问目录 {connection.issues} · 跳过符号链接 {connection.ignoredLinks}</p>
        <div className="export-actions">{connection.status === 'scanning' ? <DsButton disabled={busy} onClick={() => void action(() => window.staithe.sources.cancel(connection.id))}>暂停统计</DsButton> : <DsButton disabled={busy} onClick={() => refresh([connection.id])}>刷新连接</DsButton>}
          <DsButton variant="ghost" disabled={busy} onClick={() => { clearSelection(); void action(() => window.staithe.sources.disconnect(connection.id)) }}>断开连接</DsButton></div>
      </section>)}{!page.connections.length && <div className="empty">尚未保存连接</div>}{error && <p role="alert" className="dialog-status">{error}</p>}</ScrollArea>
    </DsDialog>}
    {handoff && content && <DsDialog titleId="target-title" busy={false} onDismiss={() => setHandoff(false)}>
      <DsDialogHeader titleId="target-title" title="选择接续目标" eyebrow="上下文交接" closeLabel="关闭接续面板" onDismiss={() => setHandoff(false)} />
      <ScrollArea className="dialog-content"><label className="target-label">目标 App<select aria-label="目标 App" value={target} onChange={event => setTarget(event.target.value as BrowsableSource)}>{browsableSources.map(id => <option key={id} value={id}>{sourceNames[id]}</option>)}</select></label>
        <div className="notice"><DesignIcon name="info" /><div><strong>自动接续暂未支持</strong><p>尚未完成目标客户端的创建、打开与接续验证。当前不写入目标，不自动发送历史，也不把复制文本当作同步成功。</p></div></div>
        <p className="privacy-note">{target === 'codex' ? '已发现官方历史注入接口，但仍需验证版本、持久化回读、打开链路、冲突与回滚，尚未启用。' : '此目标尚无经过 Pinekin 验证的外部历史创建与打开链路。'}</p>
        <p className="privacy-note">来源文本的读取成功，不代表工具、附件、分支或运行状态可以迁移。</p>
      </ScrollArea><div className="dialog-footer"><DsButton onClick={() => setHandoff(false)}>返回会话</DsButton><DsButton variant="primary" disabled>自动接续暂未支持</DsButton></div>
    </DsDialog>}
  </div>
}
