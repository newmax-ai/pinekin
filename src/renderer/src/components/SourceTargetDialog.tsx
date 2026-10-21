import { useEffect, useId, useRef, useState } from 'react'
import type { BrowsableSource } from '../../../core/sources'
import type { CodexProjectPreview, CodexSetupMode, NativeTargetPreview, NativeTransferResult, SourceActionCapabilities, SourceActionsAPI } from '../../../core/source-actions'
import { SourceIcon } from './SourceIcon'
import { SourceProjectList } from './SourceProjectList'
import { DesignIcon, DsButton, DsDialog, DsDialogHeader } from './ui'

const sourceChangedMessage = '来源会话在读取期间有更新，请重试；不会混合不同版本的内容。'
const restartMessage = '接续接口已更新，请重启当前 Pinekin 主实例后使用。'

/** 新桥存在时不混用旧桥；旧 preload 仅保留 Codex 原有路径，不能让其他目标误写 Codex。 */
function actionsFor(api: SourceActionsAPI, target: BrowsableSource) {
  if (api.inspectTarget || api.continueInTarget || api.configureTarget || api.chooseTargetProject || api.listTargetProjects) return {
    inspect: api.inspectTarget ? (mode: CodexSetupMode) => api.inspectTarget!(target, mode) : undefined,
    configure: api.configureTarget ? (token: string) => api.configureTarget!(target, token) : undefined,
    chooseProject: api.chooseTargetProject ? (id: string, projectId?: string) => api.chooseTargetProject!(target, id, projectId) : undefined,
    continue: api.continueInTarget ? (id: string, destination: Parameters<NonNullable<SourceActionsAPI['continueInTarget']>>[2]) => api.continueInTarget!(id, target, destination) : undefined,
  }
  return target === 'codex' ? { inspect: api.inspectCodexTarget, configure: api.configureCodex, chooseProject: api.chooseCodexProject, continue: api.continueInCodex } : {}
}

export function SourceTargetDialog({ entryId, api, targets, loadingTargets, mode, isActive, onDismiss, onComplete, onConfigured, onSettings, returnFocus }: {
  entryId: string; api: SourceActionsAPI; targets: SourceActionCapabilities['targets']; loadingTargets: boolean
  mode: 'continue' | 'configure'; isActive(): boolean; onDismiss(): void; onComplete(result: NativeTransferResult): void
  onConfigured(): void; onSettings(): void; returnFocus?: HTMLElement | null
}) {
  const settings = mode === 'configure'
  // 热更新兼容旧主进程的占位列表；保留既有适配的故障提示，但不据此启用写入。
  const implementedTargets = targets.filter(target => target.implemented
    ?? (target.available === true || target.id === 'codex' || target.id === 'newmax'))
  const [selected, setSelected] = useState<BrowsableSource>()
  const [preview, setPreview] = useState<NativeTargetPreview>()
  const [applicationExpanded, setApplicationExpanded] = useState(false)
  const applicationPathId = useId(), targetReasonId = useId()
  const [project, setProject] = useState<CodexProjectPreview>()
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const pending = useRef(false), alive = useRef(true), destinations = useRef<HTMLDivElement>(null), targetList = useRef<HTMLDivElement>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const focusArea = selected ? settings ? undefined : destinations.current : targetList.current
    focusArea?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [selected, settings])
  const active = () => alive.current && isActive()
  function fail(cause: unknown) {
    if (!active()) return
    const message = (cause instanceof Error ? cause.message : String(cause))
      .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    if (/项目选择已失效或过期|项目目录已变化/.test(message)) setProject(undefined)
    setError(message.includes('No handler registered') ? restartMessage
      : /来源正文已变化|来源已变化或片段不连续|数据库在读取期间变化/.test(message) ? sourceChangedMessage : message)
  }
  function select(target?: BrowsableSource) {
    if (pending.current || !active()) return
    setSelected(target); setPreview(undefined); setProject(undefined); setError(undefined); setApplicationExpanded(false)
    if (settings && target) void inspect('automatic', target)
  }
  async function inspect(kind: CodexSetupMode, target = selected) {
    if (pending.current || !active() || !target) return
    pending.current = true; setChecking(true); setError(undefined)
    if (kind === 'automatic') setPreview(undefined)
    try {
      const actions = actionsFor(api, target)
      if (!actions.inspect) throw new Error(restartMessage)
      const result = await actions.inspect(kind)
      if (active() && result) setPreview(result)
    } catch (cause) { if (active()) setPreview(undefined); fail(cause) }
    finally { pending.current = false; if (active()) setChecking(false) }
  }
  /** App 卡片只选目标；明确选择独立会话或项目后，才识别、配置并创建。 */
  async function continueHere(destination: 'standalone' | 'choose' | 'saved' | CodexProjectPreview, savedId?: string) {
    if (pending.current || !active() || !selected) return
    pending.current = true; setChecking(true); setPreview(undefined); setError(undefined)
    try {
      const actions = actionsFor(api, selected)
      // 完整项目桥必须可用，防止旧 preload 忽略参数后静默创建独立会话。
      if (!actions.inspect || !actions.continue || !actions.chooseProject) throw new Error(restartMessage)
      let chosen = typeof destination === 'object' ? destination : undefined
      if (destination === 'standalone') setProject(undefined)
      if (destination === 'choose' || destination === 'saved') {
        setProject(undefined)
        if (destination === 'saved' && !savedId) throw new Error('项目列表已失效，请刷新后重选。')
        const result = destination === 'saved' ? await actions.chooseProject(entryId, savedId) : await actions.chooseProject(entryId)
        if (!active() || !result) return
        chosen = result; setProject(result)
      }
      const target = await actions.inspect('automatic')
      if (!active()) return
      if (!target?.token) throw new Error(target?.reason ?? '未能识别可用目标，请在接续设置中处理。')
      setChecking(false); setSaving(true)
      if (!target.configured) {
        if (!actions.configure) throw new Error(restartMessage)
        if (!await actions.configure(target.token)) throw new Error('目标连接未完成，请重试。')
      }
      if (!active()) return
      const result = await actions.continue(entryId, chosen ? { kind: 'project', token: chosen.token } : { kind: 'standalone' })
      if (active()) onComplete(result)
    } catch (cause) { fail(cause) }
    finally { pending.current = false; if (active()) { setChecking(false); setSaving(false) } }
  }
  async function saveSettings() {
    if (pending.current || !preview?.token || !active() || !selected) return
    pending.current = true; setSaving(true); setError(undefined)
    try {
      const actions = actionsFor(api, selected)
      if (!actions.configure) throw new Error(restartMessage)
      if (!await actions.configure(preview.token)) return
      if (active()) onConfigured()
    } catch (cause) { fail(cause) }
    finally { pending.current = false; if (active()) setSaving(false) }
  }
  const problem = error ?? preview?.reason
  const working = checking || saving
  const busy = settings ? saving : working
  const locationNames = { saved: '已授权位置', default: '默认位置', environment: '环境指定位置', custom: '自定义位置' }
  return <DsDialog titleId="target-dialog-title" busy={busy} onDismiss={onDismiss} returnFocus={returnFocus} animateHeight>
    <DsDialogHeader titleId="target-dialog-title" title={settings ? '接续目标设置' : '原生历史迁移（高级）'}
      closeLabel="关闭接续面板" busy={busy} onDismiss={onDismiss} />
    <div className="source-target-body" data-mode={mode}>
      <p className="source-target-description">{settings ? '通常无需修改。使用自定义数据目录时，可在这里调整。' : '选择 App，再决定在哪里继续。只承接对话文字，不会自动发送，不迁移附件和工具状态。'}</p>
      <div className="source-target-list" aria-label="接续目标" ref={targetList} data-selected={!!selected}>
        {implementedTargets.filter(target => !selected || target.id === selected).map(target => {
          const supported = target.available ?? target.id === 'codex'
          const reason = target.reason ?? `${target.name} 当前不可用，请检查客户端与平台支持。`
          const chosen = selected === target.id
          return <div key={target.id} className="source-target-option">
            <button type="button" className="source-target-card"
              aria-label={settings ? `选择 ${target.name}` : `在 ${target.name} 继续`} aria-pressed={chosen}
              aria-describedby={supported ? undefined : `${targetReasonId}-${target.id}`}
              title={supported ? settings ? '查看目标设置' : '选择继续位置，不迁移附件和工具状态' : reason}
              disabled={working || !supported} data-dialog-initial-focus={supported ? 'true' : undefined}
              onClick={() => select(target.id)}>
              <SourceIcon source={target.id} /><span>{target.name}</span><span className="source-target-card-detail" role={working && chosen ? 'status' : undefined}>
                {!supported ? '暂不可用' : working && chosen ? checking ? '正在准备…' : '正在接续…' : settings ? '设置' : chosen ? '已选择' : '选择'}
              </span>
            </button>
            {!supported && <p id={`${targetReasonId}-${target.id}`} className="source-target-unavailable" role="note">{reason}</p>}
          </div>
        })}
        {selected && <button type="button" className="source-target-change" disabled={working} onClick={() => select()}>更换 App</button>}
        {!implementedTargets.length && <p className="source-target-description">{loadingTargets ? '正在读取可用目标…' : '当前平台没有已接入的原生迁移目标，可使用复制或保存完整接续文件。'}</p>}
      </div>
      {!settings && selected && <div className="source-target-location source-target-destination" role="group" aria-label="在哪里继续？" ref={destinations}>
        <p className="source-target-destination-title">在哪里继续？</p>
        <p className="source-target-description">{targets.find(target => target.id === selected)?.destinationKind === 'workspace'
          ? '选择 NewMax 已有工作区；独立会话会放入其默认工作区。不会新建文件夹或自动发送。'
          : '点选已有项目，使用其本地主目录继续；也可以选择独立会话或其他文件夹。'}</p>
        <SourceProjectList key={selected} entryId={entryId} target={selected} api={api} disabled={working} isActive={active} onChoose={id => void continueHere('saved', id)} />
        {project && <code className="source-target-path">{project.path}</code>}
        <div className="source-target-options">
          <DsButton disabled={working} onClick={() => void continueHere('standalone')}>独立会话继续</DsButton>
          {project && <DsButton variant="primary" disabled={working} onClick={() => void continueHere(project)}>在 {project.name} 重试</DsButton>}
          {targets.find(target => target.id === selected)?.destinationKind !== 'workspace'
            && <DsButton variant="ghost" disabled={working} onClick={() => void continueHere('choose')}>选择其他文件夹</DsButton>}
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
