import { useEffect, useId, useRef, useState } from 'react'
import type { CodexProjectPreview, CodexSetupMode, CodexTargetPreview, CodexTransferResult, SourceActionCapabilities, SourceActionsAPI } from '../../../core/source-actions'
import { SourceIcon } from './SourceIcon'
import { SourceProjectList } from './SourceProjectList'
import { DesignIcon, DsButton, DsDialog, DsDialogHeader } from './ui'

const sourceChangedMessage = '来源会话在读取期间有更新，请重试；不会混合不同版本的内容。'

export function SourceTargetDialog({ entryId, api, targets, loadingTargets, mode, isActive, onDismiss, onComplete, onConfigured, onSettings, returnFocus }: {
  entryId: string; api: SourceActionsAPI; targets: SourceActionCapabilities['targets']; loadingTargets: boolean
  mode: 'continue' | 'configure'; isActive(): boolean; onDismiss(): void; onComplete(result: CodexTransferResult): void
  onConfigured(): void; onSettings(): void; returnFocus?: HTMLElement | null
}) {
  const settings = mode === 'configure'
  const [selected, setSelected] = useState(false)
  const [preview, setPreview] = useState<CodexTargetPreview>()
  const [applicationExpanded, setApplicationExpanded] = useState(false)
  const applicationPathId = useId()
  const [project, setProject] = useState<CodexProjectPreview>()
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const pending = useRef(false), alive = useRef(true), destinations = useRef<HTMLDivElement>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (selected && !settings) destinations.current?.querySelector('button')?.focus() }, [selected, settings])
  const active = () => alive.current && isActive()
  function fail(cause: unknown) {
    if (!active()) return
    const message = (cause instanceof Error ? cause.message : String(cause))
      .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    if (/项目选择已失效或过期|项目目录已变化/.test(message)) setProject(undefined)
    setError(message.includes('No handler registered') ? '接续接口已更新，请重启当前 Pinekin 主实例后使用。'
      : /来源正文已变化|来源已变化或片段不连续|数据库在读取期间变化/.test(message) ? sourceChangedMessage : message)
  }
  async function inspect(kind: CodexSetupMode) {
    if (pending.current || !active()) return
    pending.current = true; setSelected(true); setChecking(true); setError(undefined)
    if (kind === 'automatic') setPreview(undefined)
    try {
      if (!api.inspectCodexTarget) throw new Error('接续接口已更新，请重启当前 Pinekin 主实例后使用。')
      const result = await api.inspectCodexTarget(kind)
      if (active() && result) setPreview(result)
    } catch (cause) { if (active()) setPreview(undefined); fail(cause) }
    finally { pending.current = false; if (active()) setChecking(false) }
  }
  /** App 卡片只选目标；明确选择独立会话或项目后，自动识别、配置并创建。 */
  async function continueHere(destination: 'standalone' | 'choose' | 'saved' | CodexProjectPreview, savedId?: string) {
    if (pending.current || !active()) return
    pending.current = true; setChecking(true); setPreview(undefined); setError(undefined)
    try {
      // 新桥必须可用，避免旧 preload 丢弃项目参数后静默创建独立会话。
      if (!api.inspectCodexTarget || !api.continueInCodex || !api.chooseCodexProject) throw new Error('接续接口已更新，请重启当前 Pinekin 主实例后使用。')
      let chosen = typeof destination === 'object' ? destination : undefined
      if (destination === 'standalone') setProject(undefined)
      if (destination === 'choose' || destination === 'saved') {
        setProject(undefined)
        if (destination === 'saved' && !savedId) throw new Error('项目列表已失效，请刷新后重选。')
        const result = destination === 'saved' ? await api.chooseCodexProject(entryId, savedId) : await api.chooseCodexProject(entryId)
        if (!active() || !result) return
        chosen = result; setProject(result)
      }
      const target = await api.inspectCodexTarget('automatic')
      if (!active()) return
      if (!target?.token) throw new Error(target?.reason ?? '未能识别可用目标，请在接续设置中处理。')
      setChecking(false); setSaving(true)
      if (!target.configured) {
        if (!api.configureCodex) throw new Error('接续接口已更新，请重启当前 Pinekin 主实例后使用。')
        if (!await api.configureCodex(target.token)) throw new Error('目标连接未完成，请重试。')
      }
      if (!active()) return
      const result = await api.continueInCodex(entryId, chosen ? { kind: 'project', token: chosen.token } : { kind: 'standalone' })
      if (active()) onComplete(result)
    } catch (cause) { fail(cause) }
    finally { pending.current = false; if (active()) { setChecking(false); setSaving(false) } }
  }
  async function saveSettings() {
    if (pending.current || !preview?.token || !active()) return
    pending.current = true; setSaving(true); setError(undefined)
    try {
      if (!api.configureCodex || !await api.configureCodex(preview.token)) return
      if (active()) onConfigured()
    } catch (cause) { fail(cause) }
    finally { pending.current = false; if (active()) setSaving(false) }
  }
  const problem = error ?? preview?.reason
  const working = checking || saving
  const busy = settings ? saving : working
  const locationNames = { saved: '已授权位置', default: '默认位置', environment: '环境指定位置', custom: '自定义位置' }
  return <DsDialog titleId="target-dialog-title" busy={busy} onDismiss={onDismiss} returnFocus={returnFocus} animateHeight>
    <DsDialogHeader titleId="target-dialog-title" title={settings ? '接续目标设置' : '在其他 App 继续'}
      closeLabel="关闭接续面板" busy={busy} onDismiss={onDismiss} />
    <div className="source-target-body" data-mode={mode}>
      <p className="source-target-description">{settings ? '通常无需修改。使用自定义数据目录时，可在这里调整。' : '选择 App，再决定在哪里继续。只承接对话文字，不会自动发送。'}</p>
      <div className="source-target-list" aria-label="接续目标">
        {targets.filter(target => target.id === 'codex').map(target => <button key={target.id} type="button" className="source-target-card"
          aria-label={settings ? `选择 ${target.name}` : `在 ${target.name} 继续`} aria-pressed={selected}
          title={settings ? '查看目标设置' : '选择继续位置，不迁移附件和工具状态'} disabled={working} data-dialog-initial-focus="true"
          onClick={() => { if (settings) void inspect('automatic'); else setSelected(true) }}>
          <SourceIcon source={target.id} /><span>{target.name}</span><span className="source-target-card-detail" role={working && selected ? 'status' : undefined}>
            {working && selected ? checking ? '正在准备…' : '正在接续…' : settings ? '设置' : selected ? '已选择' : '选择'}
          </span>
        </button>)}
        {!targets.length && <p className="source-target-description">{loadingTargets ? '正在读取可用目标…' : '当前没有可用目标，请重新检查客户端与平台支持。'}</p>}
      </div>
      {!settings && selected && <div className="source-target-location source-target-destination" role="group" aria-label="在哪里继续？" ref={destinations}>
        <p className="source-target-destination-title">在哪里继续？</p>
        <p className="source-target-description">点选已有项目，使用其本地主目录继续；也可以选择独立会话或其他文件夹。</p>
        <SourceProjectList entryId={entryId} api={api} disabled={working} isActive={active} onChoose={id => void continueHere('saved', id)} />
        {project && <code className="source-target-path">{project.path}</code>}
        <div className="source-target-options">
          <DsButton disabled={working} onClick={() => void continueHere('standalone')}>独立会话继续</DsButton>
          {project && <DsButton variant="primary" disabled={working} onClick={() => void continueHere(project)}>在 {project.name} 重试</DsButton>}
          <DsButton variant="ghost" disabled={working} onClick={() => void continueHere('choose')}>选择其他文件夹</DsButton>
        </div>
      </div>}
      {!settings && problem && <div className="source-target-location">
        <p className="source-target-error" role="alert">{problem}</p>
        {problem !== sourceChangedMessage && !/项目目录|项目选择|项目列表/.test(problem) && <div className="source-target-options"><DsButton variant="ghost" size="small" disabled={working} onClick={onSettings}>接续设置</DsButton></div>}
      </div>}
      {settings && selected && !checking && <div className="source-target-location source-target-settings">
        <div className="source-target-setting">
          <div className="source-target-setting-heading">
            <span className="source-target-location-label">{preview ? locationNames[preview.locationSource] : '数据位置'}</span>
            <DsButton size="small" disabled={saving} onClick={() => void inspect('directory')}>使用自定义位置</DsButton>
          </div>
          {preview && <code className="source-target-path source-target-setting-path" title={preview.dataPath}>{preview.dataPath}</code>}
        </div>
        {preview?.applicationPath && <div className="source-target-program">
          <DsButton variant="ghost" size="small" className="source-target-program-toggle" disabled={saving}
            aria-expanded={applicationExpanded} aria-controls={applicationPathId} onClick={() => setApplicationExpanded(value => !value)}>
            <span>{preview.applicationName ? `应用：${preview.applicationName}` : '应用位置'}</span><DesignIcon name="chevron" size={15} />
          </DsButton>
          <code id={applicationPathId} className="source-target-setting-path" hidden={!applicationExpanded} title={preview.applicationPath}>{preview.applicationPath}</code>
        </div>}
        {problem && <p className="source-target-error" role="alert">{problem}</p>}
        {(preview?.canChooseApplication || problem) && <div className="source-target-options">
          {preview?.canChooseApplication && <DsButton variant="ghost" size="small" disabled={saving} onClick={() => void inspect('application')}>手动选择程序</DsButton>}
          {problem && <DsButton variant="ghost" size="small" disabled={saving} onClick={() => void inspect('automatic')}>重新识别</DsButton>}
        </div>}
      </div>}
    </div>
    {settings && <div className="dialog-footer">
      <DsButton disabled={saving} onClick={onDismiss}>取消</DsButton>
      {selected && <DsButton variant="primary" disabled={working || !preview?.token} onClick={() => void saveSettings()}>{saving ? '正在保存…' : '保存位置'}</DsButton>}
    </div>}
  </DsDialog>
}
