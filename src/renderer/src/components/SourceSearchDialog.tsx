import { useEffect, useRef, useState, type RefObject } from 'react'
import { sameSourceSnapshot, sourceNames, type BrowsableSource, type SourceEntry, type SourcePage } from '../../../core/sources'
import { EmptyState, resolveSourceEmptyState, type EmptyStateAction, type EmptyStateKind } from './EmptyState'
import { FadeText } from './FadeText'
import { LoadingMark } from './LoadingMark'
import { ScrollArea } from './ScrollArea'
import { SourceIcon } from './SourceIcon'
import { DsButton, DsDialog, DsDialogClose, DesignIcon } from './ui'

const emptyPage: SourcePage = { items: [], total: 0, offset: 0, hasMore: false, connections: [] }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }

/** 搜索只维护弹层状态，确认结果前不修改主列表、正文或浏览历史。 */
export function SourceSearchDialog({ source, query, revision, onQueryChange, inputRef, returnFocus, onDismiss, onSelect, getEmptyAction }: {
  source: BrowsableSource | 'all'; query: string; revision: number; onQueryChange: (query: string) => void
  inputRef: RefObject<HTMLInputElement | null>; returnFocus: HTMLElement | null
  onDismiss: () => void; onSelect: (entry: SourceEntry) => void
  getEmptyAction: (kind: EmptyStateKind) => EmptyStateAction | undefined
}) {
  const [page, setPage] = useState<SourcePage>(emptyPage)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [moreError, setMoreError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [reload, setReload] = useState(0)
  const requestId = useRef(0)
  const [pending, setPending] = useState(false)
  const seenRevision = useRef(revision)
  const range = useRef(50)
  const scope = useRef({ source, query })
  const preserve = useRef(false)
  const viewport = useRef<HTMLDivElement>(null)
  const relevant = page.connections.filter(item => source === 'all' || item.source === source)
  const scanning = relevant.some(item => item.status === 'scanning')
  const discovered = relevant.reduce((sum, item) => sum + item.discovered, 0)
  // 总数是估计值且大于已读取数时，说明还有旧会话尚未读取，搜索不会覆盖它们。
  const unloaded = relevant.some(item => item.total !== null && item.total > item.discovered)
  const count = error ? '读取失败' : !loaded ? '正在读取…' : !relevant.length ? '未连接'
    : relevant.every(item => item.status === 'ready') ? `${page.items.length} / ${page.total} 条已加载`
      : relevant.some(item => item.status === 'scanning') ? `发现 ${discovered} 条，加载中`
        : relevant.some(item => item.status === 'error') ? '读取失败'
          : relevant.every(item => item.status === 'idle') ? '等待刷新'
            : relevant.some(item => item.status === 'cancelled') ? `发现 ${discovered} 条，统计已暂停`
              : `发现 ${discovered} 条，统计未完成`
  const emptyKind = resolveSourceEmptyState({ loaded, error, count: page.items.length, connections: relevant, query })

  useEffect(() => {
    if (seenRevision.current === revision) return
    seenRevision.current = revision
    // 全局变化不代表当前关键词命中变化；只核对完整结果指纹，不重载已加载范围。
    let active = true
    const request = requestId.current
    void window.staithe.sources.page({ ...(source === 'all' ? {} : { source }), query, offset: 0, limit: 1 }).then(result => {
      if (!active || request !== requestId.current) return
      if (sameSourceSnapshot(page, result)) {
        setPage(previous => ({ ...previous, version: result.version, snapshot: result.snapshot, connections: result.connections })); setPending(false)
      } else if (page.items.length) setPending(true)
      else setReload(value => value + 1)
    }).catch(reason => { if (active && request === requestId.current) setMoreError(errorText(reason)) })
    return () => { active = false }
  }, [revision, source, query])
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const request = ++requestId.current
    if (scope.current.source !== source || scope.current.query !== query) { range.current = 50; preserve.current = false }
    scope.current = { source, query }
    if (!preserve.current) { setPage(emptyPage); setLoaded(false) }
    preserve.current = false
    setError(''); setMoreError(''); setLoadingMore(false)
    async function load() {
      try {
        let result: SourcePage | undefined
        const items: SourceEntry[] = []
        for (let offset = 0; offset < range.current; offset += 50) {
          const next = await window.staithe.sources.page({ ...(source === 'all' ? {} : { source }), query, offset, limit: Math.min(50, range.current - offset) })
          if (!active || request !== requestId.current) return
          if (result && !sameSourceSnapshot(result, next)) throw new Error('来源仍在更新，请稍后重试')
          result = next; items.push(...next.items)
          if (!next.hasMore || !next.items.length) break
        }
        setPage({ ...result!, items, offset: 0 }); setError(''); setLoaded(true); setPending(false)
        if (result!.connections.some(item => item.status === 'scanning' && (source === 'all' || item.source === source))) timer = setTimeout(() => void load(), 400)
      } catch (reason) {
        if (active && request === requestId.current) { setError(errorText(reason)); setLoaded(true) }
      }
    }
    void load()
    return () => { active = false; clearTimeout(timer); requestId.current += 1 }
  }, [source, query, reload])

  async function more() {
    if (!loaded || loadingMore || scanning || !page.hasMore) return
    const request = requestId.current
    setLoadingMore(true); setMoreError('')
    try {
      const result = await window.staithe.sources.page({ ...(source === 'all' ? {} : { source }), query, offset: page.items.length, limit: 50 })
      if (request !== requestId.current) return
      if (!sameSourceSnapshot(result, page)) { setPending(true); return }
      setPage(previous => ({ ...result, items: [...new Map([...previous.items, ...result.items].map(item => [item.id, item])).values()] }))
    } catch (reason) { if (request === requestId.current) setMoreError(errorText(reason)) }
    finally { if (request === requestId.current) setLoadingMore(false) }
  }
  function clear() { onQueryChange(''); inputRef.current?.focus() }
  function emptyAction(kind: EmptyStateKind): EmptyStateAction | undefined {
    if (kind === 'no-results') return { label: '清空关键词', onClick: clear }
    if (kind === 'list-error') return { label: '重新加载', onClick: () => setReload(value => value + 1) }
    return getEmptyAction(kind)
  }

  return <DsDialog titleId="search-title" busy={false} onDismiss={onDismiss} returnFocus={returnFocus} dismissOnBackdrop>
    <h2 id="search-title" className="visually-hidden">搜索会话</h2>
    <div className="search-header"><div className="search"><DesignIcon name="search" /><input ref={inputRef} aria-label="搜索会话" value={query} placeholder="搜索标题、项目或会话 ID" onChange={event => onQueryChange(event.target.value)} />
      {query && <DsButton variant="ghost" size="small" className="search-clear" aria-label="清空搜索" onClick={clear}>清空</DsButton>}
      <DsDialogClose aria-label="关闭搜索" onClick={onDismiss} />
    </div></div>
    <ScrollArea className="dialog-content search-content"><p className="search-context">当前来源内 · {!error && (!loaded || scanning) ? <span className="source-loading-count">{scanning && `发现 ${discovered} 条`}<LoadingMark label={count} /></span> : count} · 仅搜索元数据{unloaded && '，仅搜索已加载的会话；向下翻页可加载更早的'}</p>
      <ScrollArea ref={viewport} className="search-results" aria-busy={!loaded || scanning}>{page.items.map(entry => <button key={entry.id} className="search-result" aria-label={`打开会话：${entry.title}`} onClick={() => onSelect(entry)}>
        <SourceIcon source={entry.source} /><span><strong>{entry.title}</strong><small><FadeText text={`${sourceNames[entry.source]}${entry.project ? ` · ${entry.project}` : ''}`} /></small></span><DesignIcon name="chevron" size={14} />
      </button>)}</ScrollArea>
      {pending && <DsButton disabled={loadingMore} onClick={() => {
        range.current = Math.max(50, page.items.length); preserve.current = true
        if (viewport.current) viewport.current.scrollTop = 0
        setReload(value => value + 1)
      }}>搜索结果有更新，点击查看</DsButton>}
      {page.hasMore && <DsButton disabled={scanning || loadingMore || pending || !loaded} onClick={() => void more()}>{loadingMore ? <LoadingMark label="正在加载更多结果" /> : '加载更多结果'}</DsButton>}
      {emptyKind && <EmptyState kind={emptyKind} title={emptyKind === 'no-results' ? '没有匹配的会话' : undefined} description={emptyKind === 'list-error' ? error : undefined} action={emptyAction(emptyKind)} />}
      {((error && !emptyKind) || moreError) && <p role="alert" className="dialog-status">{error || moreError}</p>}
    </ScrollArea>
  </DsDialog>
}
