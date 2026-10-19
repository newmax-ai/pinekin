import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { z } from 'zod'
import { entryIdSchema } from '../core/sources'
import type { CodexProjectList, CodexProjectPreview } from '../core/source-actions'

export interface CodexProject { path: string; dev: number; ino: number }
export interface CodexCatalogItem { key: string; name: string; path: string; reason?: string }
export interface CodexProjectCatalog { source: string; projects: CodexCatalogItem[]; warning?: string }

/** 只检查用户选择的目录属性，不扫描项目、读取 AGENTS 或执行项目代码。 */
export async function checkCodexProject(project: CodexProject): Promise<void> {
  const current = await lstat(project.path)
  if (!current.isDirectory() || current.isSymbolicLink() || await realpath(project.path) !== project.path ||
    current.dev !== project.dev || current.ino !== project.ino) throw new Error('项目目录已变化，请重新选择项目。')
}

/** 路径来自系统选择器或主进程核验的项目列表；renderer 不提供任意路径。 */
export class CodexProjectSelection {
  private selecting = false
  private listing = false
  private listed?: { entryId: string; source: string; expires: number; entries: Map<string, CodexCatalogItem> }
  private candidate?: { entryId: string; token: string; project: CodexProject; expires: number }
  constructor(private readonly selectDirectory: () => Promise<string | null>, private readonly now = Date.now,
    private readonly readCatalog?: () => Promise<CodexProjectCatalog>) {}

  async list(rawId: string, assertAllowed: () => void): Promise<CodexProjectList> {
    const entryId = entryIdSchema.parse(rawId)
    assertAllowed()
    if (this.listing || this.selecting) throw new Error('正在读取或选择项目，请稍候。')
    if (!this.readCatalog) throw new Error('当前目标未提供项目列表。')
    this.listing = true; this.listed = undefined
    try {
      const catalog = await this.readCatalog()
      assertAllowed()
      const entries = new Map<string, CodexCatalogItem>()
      const projects = catalog.projects.map(project => {
        const id = randomUUID(); entries.set(id, { ...project })
        return { id, name: project.name, path: project.path, ...(project.reason ? { reason: project.reason } : {}) }
      })
      this.listed = { entryId, source: catalog.source, expires: this.now() + 5 * 60_000, entries }
      return { projects, ...(catalog.warning ? { warning: catalog.warning } : {}) }
    } finally { this.listing = false }
  }

  async choose(rawId: string, assertAllowed: () => void, rawProjectId?: string): Promise<CodexProjectPreview | null> {
    const entryId = entryIdSchema.parse(rawId)
    assertAllowed()
    if (this.selecting) throw new Error('正在选择项目，请稍候。')
    this.selecting = true
    this.candidate = undefined
    try {
      let selected: string | null, name: string | undefined
      if (rawProjectId !== undefined) {
        const projectId = z.uuid().parse(rawProjectId), list = this.listed, item = list?.entries.get(projectId)
        if (!this.readCatalog || !list || list.entryId !== entryId || this.now() >= list.expires || !item) {
          throw new Error('项目列表已失效，请刷新项目列表后重选。')
        }
        const current = await this.readCatalog()
        assertAllowed()
        const match = current.projects.find(project => project.key === item.key && project.path === item.path)
        if (current.source !== list.source || !match || this.listed !== list) throw new Error('项目列表已变化，请刷新项目列表后重选。')
        if (match.reason) throw new Error(match.reason)
        selected = match.path; name = match.name
      } else selected = await this.selectDirectory()
      assertAllowed()
      if (selected === null) return null
      if (!isAbsolute(selected) || selected.includes('\0') || selected.length > 4096) throw new Error('项目目录无效，请重新选择。')
      const before = await lstat(selected)
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('请选择真实项目目录，不使用文件或符号链接。')
      const path = await realpath(selected)
      const project = { path, dev: before.dev, ino: before.ino }
      await checkCodexProject(project)
      assertAllowed()
      const token = randomUUID()
      this.candidate = { entryId, token, project, expires: this.now() + 5 * 60_000 }
      return { token, path, name: name ?? (basename(path) || path) }
    } finally { this.selecting = false }
  }

  async resolve(rawId: string, rawToken: string): Promise<CodexProject> {
    const entryId = entryIdSchema.parse(rawId), token = z.uuid().parse(rawToken), candidate = this.candidate
    if (!candidate || candidate.token !== token || candidate.entryId !== entryId || this.now() >= candidate.expires) {
      throw new Error('项目选择已失效或过期，请重新选择项目。')
    }
    await checkCodexProject(candidate.project)
    return { ...candidate.project }
  }
}
