import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { CodexSetupMode, CodexTargetPreview } from '../core/source-actions'

export const codexSetupModeSchema = z.enum(['automatic', 'directory', 'application'])
export async function checkCodexDirectory(path: string) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('数据目录不是可用的实际目录，请选择实际位置。')
}
interface Selection { binary: string; home: string }
interface Dependencies {
  platform: string; defaultHome: string; locationSource: 'default' | 'environment'
  saved(): Promise<Selection | undefined>
  application(): Promise<{ name: string; path: string }>
  resolveBinary(path: string): Promise<string>
  checkDirectory(path: string): Promise<void>
  chooseApplication(): Promise<string | null>
  chooseDirectory(): Promise<string | null>
  configure(binary: string, home: string, assertAllowed?: () => void): Promise<void>
  now?(): number
}

/** 自动识别只读系统应用关联及目录属性；授权令牌绑定主进程候选，renderer 不提供路径。 */
export class CodexTargetSetup {
  private busy = false
  private last?: { applicationPath?: string; home: string; locationSource: CodexTargetPreview['locationSource'] }
  private pending?: Selection & { token: string; expires: number }
  constructor(private readonly deps: Dependencies) {}
  async inspect(rawMode: CodexSetupMode = 'automatic', assertAllowed = () => {}): Promise<CodexTargetPreview | null> {
    const mode = codexSetupModeSchema.parse(rawMode)
    if (this.busy) throw new Error('正在识别或配置目标，请稍候。')
    this.busy = true
    try {
      assertAllowed()
      if (this.deps.platform !== 'darwin') return { app: 'Codex', configured: false, dataPath: '', locationSource: 'default', canChooseApplication: false, reason: '当前 Codex 接续需要 macOS 隔离验证环境。' }
      const saved = await this.deps.saved()
      let home = mode !== 'automatic' && this.last ? this.last.home : saved?.home ?? this.deps.defaultHome
      let locationSource = mode !== 'automatic' && this.last ? this.last.locationSource : saved ? 'saved' as const : this.deps.locationSource
      let applicationPath: string | undefined
      if (mode === 'directory') {
        const selected = await this.deps.chooseDirectory()
        assertAllowed()
        if (selected === null) return null
        home = selected; locationSource = 'custom'
      }
      if (mode === 'application') {
        const selected = await this.deps.chooseApplication()
        assertAllowed()
        if (selected === null) return null
        applicationPath = selected
      }
      this.pending = undefined
      const preview: CodexTargetPreview = { app: 'Codex', dataPath: home, locationSource, configured: false, canChooseApplication: false }
      let binary: string
      try {
        if (!applicationPath) {
          const application = await this.deps.application()
          // 显示名可能是 ChatGPT；身份由主进程的包标识与协议声明校验，不按名字猜测。
          preview.applicationName = application.name
          applicationPath = application.path
        }
        preview.applicationPath = applicationPath
        binary = await this.deps.resolveBinary(applicationPath)
      } catch (cause) {
        assertAllowed()
        this.last = { home, locationSource }
        const detail = cause instanceof Error ? cause.message.slice(0, 500) : '无法读取系统关联或内置程序位置。'
        return { ...preview, canChooseApplication: true, reason: `无法识别 Codex 应用：${detail}` }
      }
      this.last = { applicationPath, home, locationSource }
      try {
        if (!isAbsolute(home) || /[\x00-\x1f]/.test(home) || home.length > 4096) throw new Error('数据目录必须是有效的绝对路径。')
        await this.deps.checkDirectory(home)
      } catch {
        assertAllowed()
        return { ...preview, reason: '数据目录不可用。请先启动 Codex，或选择它实际使用的数据目录；不会自动创建或回退到其他位置。' }
      }
      assertAllowed()
      const token = randomUUID()
      this.pending = { token, binary, home, expires: (this.deps.now?.() ?? Date.now()) + 5 * 60_000 }
      return { ...preview, token, configured: saved?.binary === binary && saved.home === home }
    } finally { this.busy = false }
  }
  async confirm(rawToken: string, assertAllowed = () => {}) {
    const token = z.uuid().parse(rawToken)
    if (this.busy) throw new Error('正在识别或配置目标，请稍候。')
    const selection = this.pending
    if (!selection || token !== selection.token || selection.expires <= (this.deps.now?.() ?? Date.now())) throw new Error('目标识别结果已失效，请重新识别后确认。')
    this.busy = true
    try {
      assertAllowed()
      await this.deps.configure(selection.binary, selection.home, assertAllowed)
      assertAllowed()
      this.pending = undefined
      return true
    } finally { this.busy = false }
  }
}
