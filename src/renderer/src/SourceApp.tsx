import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { browsableSources, sameSourceSnapshot, sourceNames, type BrowsableSource, type SourceConnection, type SourceContent, type SourceEntry, type SourcePage, type SourceReadCursor } from '../../core/sources'
import { ConnectSourcesDialog } from './components/ConnectSourcesDialog'
import { SourceSearchDialog } from './components/SourceSearchDialog'
import { SourceActions } from './components/SourceActions'
import { Sidebar } from './components/Sidebar'
import { SessionPane } from './components/SessionPane'
import { ScrollArea } from './components/ScrollArea'
import { SourceIcon } from './components/SourceIcon'
import { SessionTime, useCurrentTime } from './components/SessionTime'
import { FadeText } from './components/FadeText'
import { DsButton, DsDialogPresence, DesignIcon } from './components/ui'
import { DsRefreshButton } from './components/DsRefreshButton'
import { LoadingMark } from './components/LoadingMark'
import { SourceMessage, SourceActivity } from './components/SourceMessage'
import { sourceKindNames } from '../../core/sources'
import localStorageIllustration from './assets/pinekin-local-storage.svg'
import { EmptyState, resolveSourceEmptyState, type EmptyStateAction, type EmptyStateKind } from './components/EmptyState'

const emptyPage: SourcePage = { items: [], total: 0, offset: 0, hasMore: false, connections: [] }
const displaySources = browsableSources
const roles = { user: '你', assistant: '助手', system: '系统记录', tool: '工具记录' }
type BrowserView = { source: BrowsableSource | 'all'; selected?: SourceEntry }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }
function countLabel(connections: SourceConnection[]) {
  if (!connections.length) return ''
  if (connections.some(item => item.status === 'scanning')) return <LoadingMark />
  if (connections.some(item => item.status === 'error')) return '读取失败'
  if (connections.some(item => item.status === 'partial' || item.status === 'cancelled')) return '部分'
  if (connections.some(item => item.status === 'idle')) return '待刷新'
  return String(connections.reduce((total, item) => total + (item.total ?? 0), 0))
}

export function SourceApp() {
  const now = useCurrentTime()
  const [navigation, setNavigation] = useState<{ entries: BrowserView[]; index: number }>({
    entries: [{ source: 'all' }], index: 0,
  })
  const { source, selected } = navigation.entries[navigation.index]
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<SourcePage>(emptyPage)
  const [loaded, setLoaded] = useState(false)
  const [listError, setListError] = useState('')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [readAttempt, setReadAttempt] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectionNotice, setConnectionNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [readContent, setContent] = useState<{ entryId: string; value: SourceContent }>()
  // 会话切换的首次渲染就隔离旧结果，不等待 effect 清理后再隐藏上一条正文。
  const content = readContent?.entryId === selected?.id ? readContent?.value : undefined
  const [readError, setReadError] = useState('')
  const [reading, setReading] = useState(false)
  const [windowHistory, setWindowHistory] = useState<SourceReadCursor[]>([])
  const [windowError, setWindowError] = useState('')
  const [checking, setChecking] = useState(false)
  const [pendingList, setPendingList] = useState(false)
  const [catalogVersion, setCatalogVersion] = useState(0)
  const [latestEntry, setLatestEntry] = useState<SourceEntry | null>()
  const [newMessageIndex, setNewMessageIndex] = useState<number>()
  const listViewport = useRef<HTMLDivElement>(null)
  const messagesViewport = useRef<HTMLDivElement>(null)
  const restoreScroll = useRef<number | undefined>(undefined)
  const displayedId = useRef<string | undefined>(undefined)
  const checkingRef = useRef(false)
  const mounted = useRef(true)
  const lastAutomaticCheck = useRef(0)
  const readRequest = useRef(0)
  const listRequest = useRef(0)
  const current = useRef({ source, selected, page, content, loaded, busy, connecting, loadingMore, pendingList })
  current.current = { source, selected, page, content, loaded, busy, connecting, loadingMore, pendingList }
  const contentChanged = !!content && !!latestEntry && latestEntry.revision !== (content.revision ?? selected?.revision)
  const search = useRef<HTMLInputElement>(null)
  const searchTrigger = useRef<HTMLElement | null>(null)
  const connectionTrigger = useRef<HTMLElement | null>(null)
  const connectedSources = displaySources.filter(id => page.connections.some(item => item.source === id))
  const relevant = page.connections.filter(item => source === 'all' || item.source === source)
  const scanning = relevant.some(item => item.status === 'scanning')
  const complete = relevant.length > 0 && relevant.every(item => item.status === 'ready')
  const discovered = relevant.reduce((sum, item) => sum + item.discovered, 0)
  const count = listError ? '读取失败' : !loaded ? '正在读取…' : !relevant.length ? '未连接'
    : complete ? `${page.items.length} / ${page.total} 条已加载`
      : relevant.some(item => item.status === 'scanning') ? `发现 ${discovered} 条，加载中`
        : relevant.some(item => item.status === 'error') ? '读取失败'
          : relevant.every(item => item.status === 'idle') ? '等待刷新'
            : relevant.some(item => item.status === 'cancelled') ? `发现 ${discovered} 条，统计已暂停`
              : `发现 ${discovered} 条，统计未完成`
  const emptyKind = resolveSourceEmptyState({ loaded, error: listError, count: page.items.length, connections: relevant, query: '' })

  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const request = ++listRequest.current
    setLoaded(false); setListError(''); setError(''); setLoadingMore(false); setPendingList(false)
    setPage(previous => ({ ...emptyPage, connections: previous.connections }))
    async function load() {
      try {
        const result = await window.staithe.sources.page({ ...(source === 'all' ? {} : { source }), query: '', offset: 0, limit: 50 })
        if (!active || request !== listRequest.current) return
        setPage(result); setListError(''); setLoaded(true)
        if (result.connections.some(item => item.status === 'scanning' && (source === 'all' || item.source === source))) timer = setTimeout(() => void load(), 400)
      } catch (reason) { if (active) { setListError(errorText(reason)); setLoaded(true) } }
    }
    void load()
    return () => { active = false; clearTimeout(timer) }
  }, [source, reload])
  useEffect(() => {
    const request = ++readRequest.current
    const sameConversation = displayedId.current === selected?.id
    const previous = sameConversation ? current.current.content : undefined
    displayedId.current = selected?.id
    setReadError(''); setReading(false); setNewMessageIndex(undefined); setWindowError('')
    if (!sameConversation) { setContent(undefined); setLatestEntry(undefined); setWindowHistory([]); restoreScroll.current = undefined }
    if (!selected) return
    if (selected.availability === 'unsupported') { setReadError(selected.reason ?? '正文暂未支持'); return }
    void readSelected(selected, request, previous)
    return () => { readRequest.current += 1 }
  }, [selected?.id, readAttempt])
  async function readSelected(entry: SourceEntry, request: number, previous?: SourceContent) {
    setReading(true); setReadError(''); setNewMessageIndex(undefined)
    return window.staithe.sources.read(entry.id).then(result => {
      if (request === readRequest.current) {
        if (previous) {
          restoreScroll.current = previous.window?.offset || previous.window?.textOffset ? 0 : messagesViewport.current?.scrollTop
          const before = previous.session.messages, after = result.session.messages
          // 只有完整旧消息逐条保持不变才称为追加；窗口切换不能冒充新增消息。
          if (!previous.window?.hasMore && !previous.window?.offset && !previous.window?.textOffset && !result.window?.hasMore && after.length > before.length && before.every((message, index) => JSON.stringify(message) === JSON.stringify(after[index]))) setNewMessageIndex(before.length)
        }
        setWindowHistory([]); setWindowError('')
        setContent({ entryId: entry.id, value: result })
        setPage(previous => ({ ...previous, items: previous.items.map(item => item.id === entry.id
          ? { ...item, title: result.session.title, availability: 'readable', reason: undefined } : item) }))
      }
    }).catch(async reason => {
      if (request === readRequest.current) {
        // 正文读取已经结束，不能让后续来源检查延长加载态并与失败占位叠加。
        setReading(false); setReadError(errorText(reason))
        // 用主进程的能力状态区分不支持与暂时失败，不靠错误文案猜测或删除条目。
        await checkSources('manual', [entry.connectionId])
      }
    }).finally(() => { if (request === readRequest.current) setReading(false) })
  }
  async function readWindow(direction: 'previous' | 'next') {
    if (reading || !selected || !content?.window) return
    const window = content.window
    const cursor = direction === 'next' ? window.next : windowHistory.at(-1)
    if (!cursor) return
    const entryId = selected.id, request = ++readRequest.current
    setReading(true); setWindowError(''); setReadError(''); setNewMessageIndex(undefined)
    try {
      const result = await globalThis.window.staithe.sources.read(entryId, cursor)
      if (request !== readRequest.current || !mounted.current || current.current.selected?.id !== entryId) return
      restoreScroll.current = 0
      setWindowHistory(previous => direction === 'next'
        ? [...previous, { offset: window.offset, textOffset: window.textOffset, snapshot: window.snapshot }]
        : previous.slice(0, -1))
      setContent({ entryId, value: result })
    } catch (reason) {
      if (request === readRequest.current && mounted.current) setWindowError(errorText(reason))
    } finally { if (request === readRequest.current && mounted.current) setReading(false) }
  }
  useLayoutEffect(() => {
    if (restoreScroll.current !== undefined && messagesViewport.current) {
      messagesViewport.current.scrollTop = restoreScroll.current
      restoreScroll.current = undefined
    }
  }, [content])
  const automaticCheck = useRef<() => void>(() => {})
  automaticCheck.current = () => { void checkSources('automatic') }
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let debounce: ReturnType<typeof setTimeout> | undefined
    function schedule() {
      clearTimeout(timer)
      if (document.visibilityState !== 'visible') return
      timer = setTimeout(() => { automaticCheck.current(); schedule() }, 60_000)
    }
    function resume() {
      clearTimeout(debounce)
      if (document.visibilityState === 'visible') debounce = setTimeout(() => automaticCheck.current(), 600)
      schedule()
    }
    schedule()
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      mounted.current = false; listRequest.current += 1
      clearTimeout(timer); clearTimeout(debounce)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [])
  useEffect(() => { if (searchOpen) { search.current?.focus(); search.current?.select() } }, [searchOpen])
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || !loaded || busy || connecting) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (searchOpen) { search.current?.focus(); search.current?.select() }
        else openSearch()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [loaded, busy, connecting, searchOpen])

  function navigate(update: Partial<BrowserView>) {
    setNavigation(previous => {
      const current = previous.entries[previous.index], next = { ...current, ...update }
      if (current.source === next.source && current.selected?.id === next.selected?.id) return previous
      const entries = [...previous.entries.slice(0, previous.index + 1), next].slice(-100)
      return { entries, index: entries.length - 1 }
    })
  }
  function travel(direction: -1 | 1) {
    setNavigation(previous => {
      const index = previous.index + direction
      return index < 0 || index >= previous.entries.length ? previous : { ...previous, index }
    })
  }
  function clearSelection(unsupportedId?: string) {
    readRequest.current += 1; setContent(undefined); setReadError(''); setReading(false); setLatestEntry(undefined)
    // 新增／撤销授权清空旧选择；能力变更只清理被过滤会话，不影响其他浏览历史。
    setNavigation(previous => ({ ...previous, entries: previous.entries.map(view => !unsupportedId || view.selected?.id === unsupportedId
      ? { ...view, selected: undefined } : view) }))
  }
  function openSearch() {
    searchTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSearchOpen(true)
  }
  function openConnections() {
    connectionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setConnectionNotice(''); setError('')
    setConnecting(true)
  }
  async function action(run: () => Promise<void>) {
    if (busy) return false
    setBusy(true); setError('')
    try { await run(); setReload(value => value + 1); return true }
    catch (reason) { setError(errorText(reason)); return false }
    finally { setBusy(false) }
  }
  function connected(sources: BrowsableSource[], warnings: string[]) {
    clearSelection(); navigate({ source: sources.length === 1 ? sources[0] : 'all', selected: undefined })
    setConnectionNotice(warnings.join('；')); setConnecting(false); setReload(value => value + 1)
  }
  function disconnect(connections: SourceConnection[]) {
    return action(async () => {
      let remaining = page.connections
      for (const connection of connections) {
        await window.staithe.sources.disconnect(connection.id)
        clearSelection()
        remaining = remaining.filter(item => item.id !== connection.id)
        setPage(previous => ({ ...previous, connections: previous.connections.filter(item => item.id !== connection.id), items: previous.items.filter(item => item.connectionId !== connection.id) }))
        if (!remaining.some(item => item.source === connection.source)) {
          // 仅成功撤销最后一个位置后清理筛选；中途失败保留剩余位置和开启状态。
          setNavigation(previous => ({ ...previous, entries: previous.entries.map(view => view.source === connection.source
            ? { source: 'all' } : view) }))
        }
      }
    })
  }
  function refresh(ids = relevant.map(item => item.id)) { void checkSources('manual', ids, true) }
  async function replaceLoadedList(request: number, resetPosition = false) {
    const view = current.current
    const limit = Math.max(50, view.page.items.length)
    // 重建已加载范围而非重置到第一页；跨页版本变化最多重试一次，绝不混合两份目录。
    for (let attempt = 0; attempt < 2; attempt++) {
      let result: SourcePage | undefined
      const items: SourceEntry[] = []
      for (let offset = 0; offset < limit; offset += 100) {
        const next = await window.staithe.sources.page({ ...(view.source === 'all' ? {} : { source: view.source }), query: '', offset, limit: Math.min(100, limit - offset) })
        if (!mounted.current || request !== listRequest.current) return
        if (result && !sameSourceSnapshot(result, next)) { result = undefined; break }
        result = next; items.push(...next.items)
        if (!next.hasMore || !next.items.length) break
      }
      if (result) {
        setPage({ ...result, items, offset: 0 }); setPendingList(false); setListError('')
        if (resetPosition && listViewport.current) listViewport.current.scrollTop = 0
        return
      }
    }
    throw new Error('来源仍在更新，请稍后重试；已保留当前列表')
  }
  async function checkSources(mode: 'automatic' | 'manual', ids?: string[], refreshContent = false) {
    const view = current.current
    if (checkingRef.current || view.busy || !view.loaded || view.loadingMore || !view.page.connections.length) return
    // 管理连接期间暂停自动目录检查，不因定时器或窗口聚焦反复刷新弹窗。
    if (mode === 'automatic' && (view.connecting || document.visibilityState !== 'visible' || Date.now() - lastAutomaticCheck.current < 15_000)) return
    if (mode === 'automatic') lastAutomaticCheck.current = Date.now()
    const request = listRequest.current, selectedId = view.selected?.id, selectionRead = readRequest.current
    checkingRef.current = true; setChecking(true)
    if (mode === 'manual') setError('')
    try {
      const result = await window.staithe.sources.check({ mode, ...(ids ? { connectionIds: ids } : {}), ...(selectedId ? { selectedId } : {}) })
      if (!mounted.current || request !== listRequest.current || mode === 'automatic' && current.current.connecting) return
      setPage(previous => ({ ...previous, connections: result.connections }))
      if (result.version !== current.current.page.version) setCatalogVersion(value => value + 1)
      const sameRead = selectedId === current.current.selected?.id && selectionRead === readRequest.current
      if (sameRead && result.selected?.availability === 'unsupported') {
        clearSelection(selectedId)
        setError(`“${result.selected.title}”已从列表过滤：${result.selected.reason ?? '正文暂未支持'}。原始文件未删除。`)
        setPage(previous => ({ ...previous, items: previous.items.filter(item => item.id !== selectedId) }))
        await replaceLoadedList(request)
        return
      }
      if (sameRead && result.selected !== undefined) setLatestEntry(result.selected)
      const failures = result.connections.filter(item => item.error && (!ids || ids.includes(item.id)))
      if (failures.length) setError(`更新未完成，已保留上次内容：${failures.map(item => `${sourceNames[item.source]} · ${item.error}`).join('；')}`)
      if (result.version !== current.current.page.version) {
        // 全局变化只触发核对，用一条元数据取得当前来源的完整筛选结果指纹。
        const probe = await window.staithe.sources.page({ ...(view.source === 'all' ? {} : { source: view.source }), query: '', offset: 0, limit: 1 })
        if (!mounted.current || request !== listRequest.current) return
        if (sameSourceSnapshot(current.current.page, probe)) {
          setPage(previous => ({ ...previous, version: probe.version, snapshot: probe.snapshot, connections: probe.connections })); setPendingList(false)
        } else {
          const viewport = listViewport.current
          if (current.current.pendingList || (viewport && (viewport.scrollTop > 4 || viewport.contains(document.activeElement)))) setPendingList(true)
          else await replaceLoadedList(request)
        }
      }
      // 仅显式刷新重读本次范围内的选中会话；后台／失败后的能力检查仍只检查目录。
      // 导航或新的读取已经发生时，迟到检查不得重读、更不得覆盖当前会话。
      if (refreshContent && view.selected && result.selected !== null &&
        (!ids || ids.includes(view.selected.connectionId)) && mounted.current && request === listRequest.current &&
        selectedId === current.current.selected?.id && selectionRead === readRequest.current) {
        await readSelected(result.selected ?? view.selected, ++readRequest.current, current.current.content)
      }
    } catch (reason) {
      if (mounted.current && request === listRequest.current && (mode !== 'automatic' || !current.current.connecting)) setError(errorText(reason))
    } finally { checkingRef.current = false; if (mounted.current) setChecking(false) }
  }
  async function showListUpdates() {
    if (checkingRef.current) return
    checkingRef.current = true; setChecking(true)
    const request = listRequest.current
    try { await replaceLoadedList(request, true) }
    catch (reason) { if (mounted.current && request === listRequest.current) setError(errorText(reason)) }
    finally { checkingRef.current = false; if (mounted.current) setChecking(false) }
  }
  async function more() {
    const request = listRequest.current
    setLoadingMore(true)
    try {
      const result = await window.staithe.sources.page({ ...(source === 'all' ? {} : { source }), query: '', offset: page.items.length, limit: 50 })
      if (request !== listRequest.current) return
      if (!sameSourceSnapshot(page, result)) { setPendingList(true); return }
      setPage(previous => ({ ...result, items: [...new Map([...previous.items, ...result.items].map(item => [item.id, item])).values()] }))
    } catch (reason) { if (request === listRequest.current) setError(errorText(reason)) }
    finally { if (request === listRequest.current) setLoadingMore(false) }
  }
  function emptyAction(kind: EmptyStateKind): EmptyStateAction | undefined {
    if (kind === 'disconnected' || kind === 'connections-empty') return { label: '连接来源 App', disabled: busy, onClick: () => { setSearchOpen(false); openConnections() } }
    if (kind === 'list-error') return { label: '重新加载', disabled: busy, onClick: () => setReload(value => value + 1) }
    if (kind === 'connection-error') return { label: '管理连接', disabled: busy, onClick: () => { setSearchOpen(false); openConnections() } }
    if (kind === 'needs-refresh' || kind === 'paused' || kind === 'partial' || kind === 'empty') return { label: '刷新', disabled: busy, onClick: () => refresh() }
  }
  const toolbar = <nav className="header-navigation" aria-label="浏览导航">
    <DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="返回" disabled={!loaded || busy || navigation.index === 0} onClick={() => travel(-1)}><DesignIcon name="back" /></DsButton>
    <DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="前进" disabled={!loaded || busy || navigation.index === navigation.entries.length - 1} onClick={() => travel(1)}><DesignIcon name="arrow" /></DsButton>
    <DsButton variant="ghost" size="small" iconOnly iconRelaxed className="sidebar-toggle" aria-controls="archive-sidebar" aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-expanded={sidebarOpen}
      onClick={() => setSidebarOpen(value => !value)}><DesignIcon name={sidebarOpen ? 'panel-open' : 'panel-closed'} /></DsButton>
  </nav>
  const separateNavigation = window.staithe.platform === 'darwin' || window.staithe.platform === 'win32'

  return <div className="shell" data-platform={window.staithe.platform}>
    {separateNavigation && <div className="window-toolbar">{window.staithe.platform === 'darwin' && <div className="window-controls-space" aria-hidden="true" />}{toolbar}</div>}
    <div className="app-body">
      <Sidebar open={sidebarOpen}>
        <div className="brand"><span className="brand-logo">pinekin<span className="brand-dot">.</span></span>
          <DsButton variant="ghost" size="small" iconOnly iconRelaxed className="search-trigger" aria-label="搜索" aria-haspopup="dialog" aria-expanded={searchOpen} aria-keyshortcuts="Meta+K Control+K"
            data-active={searchOpen} disabled={!loaded || busy} onClick={openSearch}><DesignIcon name="search" /></DsButton>
        </div>
        <ScrollArea className="sidebar-section">
          <button className="nav-item" aria-haspopup="dialog" disabled={busy || !loaded} onClick={openConnections}><span><DesignIcon name="plus" /><FadeText text="连接 App" /></span></button>
          <div className="nav-label sources-label">会话来源</div>
          <button className={`nav-item ${source === 'all' ? 'active' : ''}`} aria-pressed={source === 'all'} onClick={() => navigate({ source: 'all', selected: undefined })}><span><DesignIcon name="archive" /><FadeText text="所有会话" /></span><span className="count">{countLabel(page.connections)}</span></button>
          {connectedSources.map(id => <button key={id} className={`nav-item ${source === id ? 'active' : ''}`} aria-pressed={source === id} onClick={() => navigate({ source: id, selected: undefined })}>
            <span><SourceIcon source={id} /><FadeText text={sourceNames[id]} /></span><span className="count">{countLabel(page.connections.filter(item => item.source === id))}</span></button>)}
        </ScrollArea>
        <div className="sidebar-bottom"><section className="storage-note" aria-label="本地存储与隐私">
          <div className="storage-copy"><div className="local-info">仅在本机读取</div><p className="storage-description">仅浏览你授权的会话</p><div className="storage-boundaries"><span>授权后读取</span><span aria-hidden="true">·</span><span>不上传</span></div></div>
          <img className="storage-illustration" src={localStorageIllustration} alt="" aria-hidden="true" draggable={false} />
        </section></div>
      </Sidebar>
      <main className="workspace-card"><div className="workspace">
        <SessionPane label="来源会话列表">
          {!separateNavigation && <header className="topbar">{toolbar}</header>}
          <div className="list-heading source-list-heading">
            <div className="list-heading-copy"><h2>{source === 'all' ? '所有会话' : sourceNames[source]}</h2><span role="status" aria-label={!listError && (!loaded || scanning) ? count : undefined}>{!listError && (!loaded || scanning) ? <span className="source-loading-count">{scanning ? `发现 ${discovered} 条` : <LoadingMark label="正在读取" />}</span> : count}</span></div>
            <DsRefreshButton className="source-refresh-button" aria-label="刷新当前来源" loading={checking || scanning} disabled={!loaded || busy || !relevant.length} onClick={() => refresh()} />
          </div>
          <ScrollArea ref={listViewport} className="session-list" revealSelector=".session-card[aria-pressed='true']" bottomOverlayHeight={pendingList ? 96 : 0} style={pendingList ? { paddingBottom: 108 } : undefined} aria-busy={!loaded || scanning}>
            {page.items.map(entry => <button key={entry.id} className={`session-card ${selected?.id === entry.id ? 'selected' : ''}`} aria-label={`${entry.title} ${entry.project}`} aria-pressed={selected?.id === entry.id} onClick={() => navigate({ selected: entry })}>
              <div className="card-meta"><span><SourceIcon source={entry.source} size={14} />{sourceNames[entry.source]}</span><SessionTime dateTime={entry.updatedAt} now={now} /></div><FadeText as="h3" text={entry.title} lines={2} />{entry.kind && entry.kind !== 'conversation' && <span className="source-kind">{sourceKindNames[entry.kind]}</span>}
            </button>)}
            {listError && page.items.length > 0 && <EmptyState kind="list-error" layout="quiet" description={listError} action={emptyAction('list-error')} />}
            {emptyKind && <EmptyState kind={emptyKind} layout="quiet" action={selected ? emptyAction(emptyKind) : undefined} />}
            {page.hasMore && <DsButton disabled={scanning || loadingMore || checking || pendingList || !loaded} onClick={() => void more()}>{loadingMore ? <LoadingMark label="正在加载更多会话" /> : '加载更多'}</DsButton>}
          </ScrollArea>
          {pendingList && <DsButton className="source-list-update" size="small" aria-label="列表有更新，点击查看" disabled={checking || loadingMore} onClick={() => void showListUpdates()}>列表有更新，点击查看</DsButton>}
        </SessionPane>
        <section className="detail" aria-label="来源会话详情">
          {selected ? <>
            <div className="detail-header source-detail-header">
              <div className="detail-title-row">
                <div className="detail-title-group"><h2>{content?.session.title ?? selected.title}</h2></div>
                <SourceActions entryId={selected.id} content={content} disabled={busy || reading}
                  snapshotNotice={latestEntry === null ? '来源会话已删除，当前为上次读取的快照。'
                    : contentChanged ? '来源已有更新，当前为旧快照。'
                      : readError || windowError ? '最近一次读取未完成，当前为保留的快照。' : undefined} />
              </div>
              <div className="detail-meta"><span><SourceIcon source={selected.source} size={14} />{sourceNames[selected.source]}</span>{(content?.presentation?.kind ?? selected.kind) && (content?.presentation?.kind ?? selected.kind) !== 'conversation' && <span>{sourceKindNames[content?.presentation?.kind ?? selected.kind!]}</span>}<span className="detail-message-count" aria-label={content ? undefined : reading ? '消息数正在读取' : '消息数暂不可用'}>{content ? content.window ? `${content.window.totalMessages} 条来源消息 · 当前片段 ${content.session.messages.length} 条文本` : `${content.session.messages.length} 条消息` : '— 条消息'}</span>{content?.presentation && (content.presentation.toolCalls + content.presentation.toolResults > 0) && <span>{content.presentation.toolCalls + content.presentation.toolResults} 项工具活动</span>}<time dateTime={selected.updatedAt}>{selected.updatedAt.slice(0, 10)}</time></div>
            </div>
            {content && latestEntry === null && <div className="source-update-notice" role="status">来源会话已删除，当前显示的是上次读取的内容</div>}
            {newMessageIndex !== undefined && <div className="source-update-notice"><DsButton size="small" onClick={() => {
              messagesViewport.current?.querySelectorAll('article')[newMessageIndex]?.scrollIntoView({ block: 'start' }); setNewMessageIndex(undefined)
            }}>跳到新增消息</DsButton></div>}
            {reading && !content && <EmptyState kind="loading" title="正在读取来源正文…" />}
            {readError && (content ? <div className="source-update-notice" role="alert"><span>{readError}</span>{latestEntry !== null && <DsButton size="small" disabled={reading} onClick={() => setReadAttempt(value => value + 1)}>重试读取</DsButton>}</div> : <EmptyState kind={selected.availability === 'unsupported' ? 'unsupported' : 'read-error'} description={readError} action={selected.availability === 'unsupported' ? undefined : { label: '重试读取', onClick: () => setReadAttempt(value => value + 1) }} />)}
            {content && <>
              <details className="archive-report"><summary><DesignIcon name="info" size={16} /><span>读取报告 · 仅文本投影</span><span className="report-count">{content.warnings.length} 项说明</span><DesignIcon name="chevron" size={14} /></summary><ScrollArea className="report-body"><ul>{content.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></ScrollArea></details>
              {windowError && <div className="source-update-notice" role="alert"><span>{windowError}</span><DsButton size="small" disabled={reading} onClick={() => setReadAttempt(value => value + 1)}>从头重新读取</DsButton></div>}
              {content.window && (content.window.hasMore || content.window.offset > 0 || content.window.textOffset > 0) && <nav className="source-update-notice" aria-label="正文分段导航">
                {windowHistory.length > 0 && <DsButton size="small" disabled={reading} onClick={() => void readWindow('previous')}>上一段</DsButton>}
                <span role="status">从第 {content.window.offset + 1} 条来源消息{content.window.textOffset ? `第 ${content.window.textOffset + 1} 个字符` : ''}开始的片段</span>
                {content.window.next && <DsButton size="small" disabled={reading} onClick={() => void readWindow('next')}>下一段</DsButton>}
              </nav>}
              <div className="source-messages-region">
              {contentChanged && <div className="source-content-update" role="status"><DsButton size="small" aria-label="查看更新" aria-busy={reading} disabled={reading} onClick={() => setReadAttempt(value => value + 1)}>{reading ? '读取中…' : '此对话有更新'}</DsButton></div>}
              <ScrollArea ref={messagesViewport} className="messages" role="region" aria-label="会话消息" tabIndex={0}><div className="message-column" key={`${selected.id}:${content.window?.offset ?? 0}:${content.window?.textOffset ?? 0}:${content.window?.snapshot ?? ''}`}>
                {!content.session.messages.length && !content.presentation && (content.window?.hasMore ? <p className="privacy-note">当前片段没有可显示的问答文本，可以继续读取下一段。</p> : <EmptyState kind="messages" />)}
                {content.session.messages.map((message, index) => <article key={index} className={`message ${message.role}`} aria-label={`${content.window ? '当前片段' : ''}第 ${index + 1} 条消息 · ${roles[message.role]}`}>
                <div className={`message-body ${message.role === 'user' ? 'message-bubble' : message.role === 'assistant' ? 'chat-assistant-content' : 'message-record'}`}>
                  {(message.role === 'system' || message.role === 'tool') && <div className="record-label"><DesignIcon name="code" size={14} />{roles[message.role]}</div>}
                  <SourceMessage message={message} source={content.session.source} fragment={!!(content.window?.textOffset || content.window?.next?.textOffset)} />
                </div>
              </article>)}{content.presentation && <SourceActivity presentation={content.presentation} />}{content.session.messages.length > 0 && !content.window?.hasMore && <div className="conversation-end"><span />对话到这里，思考可以继续<span /></div>}</div></ScrollArea>
              </div>
            </>}
          </> : <EmptyState kind={emptyKind ?? 'selection'} layout="hero"
            description={emptyKind === 'list-error' ? listError : undefined}
            action={emptyKind ? emptyAction(emptyKind) : undefined} />}
        </section>
      </div>
      {(error || connectionNotice) && !searchOpen && !connecting && <div className="toast" role="alert"><DesignIcon name="info" /><span>{error || connectionNotice}</span><DsButton onClick={openConnections}>检查连接</DsButton><DsButton variant="ghost" size="small" iconOnly iconRelaxed aria-label="关闭提示" onClick={() => { setError(''); setConnectionNotice('') }}><DesignIcon name="close" /></DsButton></div>}
      </main>
    </div>
    <DsDialogPresence>{searchOpen && <SourceSearchDialog source={source} query={query} revision={reload + catalogVersion} onQueryChange={setQuery} inputRef={search} returnFocus={searchTrigger.current}
      onDismiss={() => setSearchOpen(false)} onSelect={entry => { navigate({ selected: entry }); setSearchOpen(false) }} getEmptyAction={emptyAction} />}</DsDialogPresence>
    <DsDialogPresence>{connecting && <ConnectSourcesDialog connections={page.connections} returnFocus={connectionTrigger.current}
      onConnected={connected} onChanged={connections => {
        setPage(previous => ({ ...previous, connections: [...previous.connections.filter(item => !connections.some(next => next.id === item.id)), ...connections] }))
        setReload(value => value + 1)
      }} onBusyChange={setBusy}
      busy={busy} error={error} onDisconnect={disconnect}
      onDismiss={() => setConnecting(false)} />}</DsDialogPresence>
  </div>
}
