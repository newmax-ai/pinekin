import { useEffect, useRef, useState } from 'react'
import type { CodexProjectList, SourceActionsAPI } from '../../../core/source-actions'
import { DsButton } from './ui'
import { ScrollArea } from './ScrollArea'

/** 只列目标客户端保存的项目，不用历史 cwd 猜测；手动文件夹入口由父面板保留。 */
export function SourceProjectList({ entryId, api, disabled, isActive, onChoose }: {
  entryId: string; api: SourceActionsAPI; disabled: boolean; isActive(): boolean; onChoose(id: string): void
}) {
  const [result, setResult] = useState<CodexProjectList>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const epoch = useRef(0)
  async function load() {
    const request = ++epoch.current
    setLoading(true); setError(undefined); setResult(undefined); setQuery('')
    try {
      if (!api.listCodexProjects) throw new Error('项目列表接口已更新，请重启当前 Pinekin 主实例；也可先选择其他文件夹。')
      const next = await api.listCodexProjects(entryId)
      if (epoch.current === request && isActive()) setResult(next)
    } catch (cause) {
      if (epoch.current === request && isActive()) {
        const message = (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
        setError(message.includes('No handler registered') ? '项目列表接口已更新，请重启当前 Pinekin 主实例；也可先选择其他文件夹。' : message)
      }
    } finally { if (epoch.current === request && isActive()) setLoading(false) }
  }
  useEffect(() => { void load(); return () => { epoch.current += 1 } }, [entryId, api])
  const search = query.trim().toLocaleLowerCase()
  const projects = result?.projects.filter(project => `${project.name}\n${project.path}`.toLocaleLowerCase().includes(search)) ?? []
  return <section className="source-project-section" aria-label="已有项目">
    <div className="source-project-heading">
      <span>已有项目</span>
      <DsButton variant="ghost" size="small" aria-label="刷新项目列表" disabled={disabled || loading} onClick={() => void load()}>刷新</DsButton>
    </div>
    {(result?.projects.length ?? 0) > 5 && <input className="source-project-search" type="search" aria-label="搜索已有项目"
      placeholder="搜索项目名称或路径" value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} />}
    {loading && <p className="source-target-description" role="status">正在读取已有项目…</p>}
    {error && <p className="source-target-error" role="note">{error}</p>}
    {result?.warning && <p className="source-target-description" role="note">{result.warning}</p>}
    {!loading && !error && !projects.length && <p className="source-target-description">{result?.projects.length ? '没有匹配的项目' : '暂无已保存的本地项目'}</p>}
    {!!projects.length && <ScrollArea className="source-project-list">
      {projects.map(project => <button key={project.id} type="button" className="source-project-item" disabled={disabled || !!project.reason}
        aria-label={`在 ${project.name} 继续：${project.path}`} onClick={() => onChoose(project.id)}>
        <span className="source-project-name">{project.name}</span>
        <span className="source-project-path">{project.path || '未设置本地目录'}</span>
        {project.reason && <span className="source-project-reason">{project.reason}</span>}
      </button>)}
    </ScrollArea>}
  </section>
}
