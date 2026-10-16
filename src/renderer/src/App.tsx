import { useEffect, useRef, useState } from 'react'
import type { ExportFormat, Session, Source, Target } from '../../core/types'
import { adapters, filterSessions, makeDeepLink, makeHandoff } from '../../core/session'

const names: Record<Source, string> = { newmax: 'NewMax', 'claude-code': 'Claude Code', codex: 'Codex', other: '其他来源' }
const roles = { user: '你', assistant: '助手', system: '系统记录', tool: '工具记录' }

export function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<Source | 'all'>('all')
  const [selectedId, setSelectedId] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [handoff, setHandoff] = useState(false)
  const [target, setTarget] = useState<Target>('通用')
  const modal = useRef<HTMLDialogElement>(null)
  const visible = filterSessions(sessions, query, source)
  const selected = visible.find(s => s.id === selectedId) ?? visible[0]

  useEffect(() => {
    let active = true
    window.staithe.list().then(data => { if (active) { setSessions(data); setLoaded(true) } })
      .catch(error => { if (active) setStatus(String(error.message)) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!loaded) return
    return window.staithe.onOpenSession(id => {
      if (!sessions.some(s => s.id === id)) { setStatus('本机没有这段会话，请先导入对应的 Staithe 包。'); return }
      setQuery(''); setSource('all'); setSelectedId(id); setHandoff(false)
    })
  }, [sessions, loaded])
  useEffect(() => { if (handoff) modal.current?.showModal() }, [handoff])

  async function perform(action: () => Promise<void>) {
    setBusy(true); setStatus('')
    try { await action() } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  function importBundle() {
    void perform(async () => {
      const imported = await window.staithe.importBundle()
      if (!imported) return
      setSessions(await window.staithe.list()); setSelectedId(imported.id); setQuery(''); setSource('all')
      setStatus('已导入本地档案，未修改来源客户端')
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

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="flame" aria-hidden="true">✦</span><span>staithe<span className="brand-dot">.</span></span></div>
      <div className="sidebar-tagline">让每一次思考，都有下文。</div>
      <div className="nav-label">你的档案馆</div>
      <button className={`nav-item ${source === 'all' ? 'active' : ''}`} onClick={() => setSource('all')}>
        <span>▤ &nbsp; 所有会话</span><span className="count">{sessions.length}</span>
      </button>
      <div className="nav-label sources-label">按来源浏览 <span>演示 / 导入</span></div>
      {adapters.map(adapter => <button key={adapter.id} className={`nav-item ${source === adapter.id ? 'active' : ''}`}
        onClick={() => setSource(adapter.id)}><span><i className={`source-dot ${adapter.id}`} />{adapter.name}</span>
        <span className="count">{sessions.filter(s => s.source === adapter.id).length}</span></button>)}
      <button className={`nav-item ${source === 'other' ? 'active' : ''}`} onClick={() => setSource('other')}>
        <span><i className="source-dot other" />其他来源</span><span className="count">{sessions.filter(s => s.source === 'other').length}</span>
      </button>
      <div className="connection-note"><span className="tiny-dot" /> 尚未连接真实客户端<br /><span>不会自动扫描或读取本地会话</span></div>
      <div className="sidebar-bottom"><div className="orbit" aria-hidden="true"><span>✦</span></div>
        <p>工具可以换。<br /><em>思考，不必重来。</em></p>
        <div className="local-label">● &nbsp; 本地优先 <span>0.1 · 预览版</span></div>
      </div>
    </aside>
    <main>
      <header className="topbar"><span>个人档案 <span className="slash">/</span> 会话</span>
        <button className="button small" disabled={busy} onClick={importBundle}><span aria-hidden="true">＋</span> 导入 Staithe 包</button>
      </header>
      <section className="intro"><div><div className="eyebrow">A HOME FOR YOUR THOUGHTS</div>
        <h1>换个地方，<span>继续思考。</span></h1><p>收好散落的对话，把下一步留给可能性。</p></div>
        <div className="archive-number"><strong>{String(sessions.length).padStart(2, '0')}</strong><span>段思考，在这里相遇</span></div>
      </section>
      <div className="workspace">
        <section className="session-pane" aria-label="会话列表">
          <div className="list-heading"><h2>{source === 'all' ? '所有会话' : names[source]}</h2><span>{visible.length} 段</span></div>
          <label className="search"><span aria-hidden="true">⌕</span><input aria-label="搜索会话" value={query}
            onChange={event => setQuery(event.target.value)} placeholder="搜索标题、正文或标签" /></label>
          <div className="session-list">
            {visible.map(s => <button key={s.id} className={`session-card ${selected?.id === s.id ? 'selected' : ''}`} onClick={() => setSelectedId(s.id)}>
              <div className="card-meta"><span><i className={`source-dot ${s.source}`} />{names[s.source]}</span><span>{s.updatedAt.slice(5, 10).replace('-', '.')}</span></div>
              <h3>{s.title}</h3><p>{s.messages[0]?.content || '这段会话暂时没有消息'}</p>
              <div className="card-footer"><span>{s.tags.map(tag => <span className="tag" key={tag}>{tag}</span>)}</span><span className="demo-label">{s.demo ? '演示' : '已导入'}</span></div>
            </button>)}
            {loaded && !visible.length && <div className="empty">没有找到匹配的会话</div>}
          </div>
          <div className="list-footnote">原始会话留在原处，思考在这里相连。</div>
        </section>
        <section className="detail" aria-label="会话详情">
          {selected ? <>
            <div className="detail-header"><div className="eyebrow">{selected.demo ? 'DEMO CONVERSATION · 演示数据' : 'IMPORTED ARCHIVE · 本地档案'}</div>
              <h2>{selected.title}</h2><div className="detail-meta"><span>{names[selected.source]}</span><span>{selected.messages.length} 条消息</span><span>{selected.updatedAt.slice(0, 10)}</span></div>
            </div>
            <div className="messages">{selected.messages.map((message, index) => <article key={index} className={`message ${message.role}`}>
              <div className="avatar" aria-hidden="true">{message.role === 'user' ? 'J' : '✦'}</div><div className="message-body"><div className="message-role">{roles[message.role]} <span>{String(index + 1).padStart(2, '0')}</span></div><p>{message.content}</p></div>
            </article>)}</div>
            <footer className="detail-footer"><button className="text-button" disabled={busy} onClick={() => copy(makeDeepLink(selected.id), '已复制本地链接；跨设备需先导入会话包')}>复制本地链接 <span aria-hidden="true">↗</span></button>
              <button className="button primary" onClick={() => setHandoff(true)}>带走这段对话 <span aria-hidden="true">↗</span></button></footer>
          </> : <div className="empty detail-empty">选一段对话，让思考继续。</div>}
        </section>
      </div>
      {!handoff && status && <div className="toast" role="status">{status}</div>}
    </main>
    {handoff && selected && <dialog ref={modal} className="handoff" aria-labelledby="handoff-title" onCancel={event => { event.preventDefault(); setHandoff(false) }}>
      <div className="dialog-top"><span className="eyebrow">CONTINUE ELSEWHERE</span><button className="close" aria-label="关闭交接面板" onClick={() => setHandoff(false)}>×</button></div>
      <h2 id="handoff-title">让这段思考，有下文。</h2><p className="dialog-description">带走完整文本，交给下一个工具继续。<br />这不是原生恢复，不会迁移工具状态、附件或权限。</p>
      <label className="target-label">接续目标<select aria-label="接续目标" value={target} onChange={event => setTarget(event.target.value as Target)}>
        {(['通用', 'NewMax', 'Claude Code', 'Codex'] as const).map(t => <option key={t}>{t}</option>)}</select></label>
      <div className="preview-label">交接文本预览 <span>只生成文本，不自动执行</span></div>
      <pre className="handoff-preview">{makeHandoff(selected, target)}</pre>
      <p className="privacy-note">导出前请检查敏感信息。当前不会自动脱敏，也不会上传或发送给目标客户端。</p>
      <div className="export-actions"><button className="button" disabled={busy} onClick={() => exportSession('bundle')}>导出 Staithe 包</button>
        <button className="button" disabled={busy} onClick={() => exportSession('markdown')}>导出 Markdown</button>
        <button className="button primary" disabled={busy} onClick={() => copy(makeHandoff(selected, target), '已复制交接文本，粘贴到目标客户端后继续')}>复制交接文本</button></div>
      {status && <div className="dialog-status" role="status">{status}</div>}
    </dialog>}
  </div>
}
