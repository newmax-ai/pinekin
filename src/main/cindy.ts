import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sessionSchema } from '../core/session'
import type { ParsedArchive } from '../core/types'
import { readBoundedZip, safeArchivePath } from './zip'

export const CINDY_SOURCE_COMMIT = 'e532ef3d8fe8271a3decf7f478d09d8ce959f824'
const shortString = z.string().max(512)
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
const pathSchema = shortString.min(1).refine(safeArchivePath)
const manifestSchema = z.object({
  formatVersion: z.literal(1), minReaderVersion: z.literal(1), appVersion: shortString,
  platform: shortString, exportedAt: z.iso.datetime(), title: z.string().min(1).max(200),
  agentKind: z.enum(['cc', 'codex', 'pi']), workspaceKind: z.enum(['project', 'dialogue']),
  originalWorkingDir: z.string().nullable(), activeSdkSessionId: shortString.nullable(), sdkSessionIds: z.array(shortString).max(1024),
  exportFidelity: z.enum(['full', 'partial', 'db-only']), counts: z.object({ messages: z.number().int().min(0).max(10_000), media: z.number().int().min(0).max(1024) }),
  entries: z.array(z.object({ path: pathSchema, bytes: z.number().int().min(0), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(1024),
  transcripts: z.array(z.object({ sdkSessionId: shortString, path: pathSchema.nullable() })).max(1024),
  orca: z.never().optional(),
})
const sourceSessionSchema = z.object({ title: z.string().min(1).max(200), createdAt: timestamp, updatedAt: timestamp })
const messageSchema = z.object({
  id: shortString.min(1), clientId: shortString.min(1), role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().max(200_000), toolUseId: shortString.nullable(), agentMeta: z.string().nullable(),
  agentKind: shortString.nullable(), createdAt: timestamp, rewindAt: timestamp.nullable(),
})
const mediaSchema = z.object({ entries: z.array(z.object({ url: z.string(), scheme: shortString, kind: shortString, zipPath: pathSchema.nullable() })).max(1024) })
const decode = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
function projectContent(content: string, warnings: Set<string>): string {
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch {
    warnings.add('部分正文不是 JSON 编码，按原始文本保留。')
    return content
  }
  if (typeof parsed === 'string') return parsed
  if (!Array.isArray(parsed)) {
    warnings.add('存在未映射的结构化内容；原始字段仅保存在原件中。')
    return '[未映射结构化内容，保留在原件中]'
  }
  return parsed.map((block: unknown) => {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') return block.text
    warnings.add('存在未映射的内容块（工具、图片或其他结构）；未执行、未联网加载，原始字段仅保存在原件中。')
    return '[未映射内容块，保留在原件中]'
  }).join('\n')
}

export async function parseCindy(bytes: Buffer): Promise<ParsedArchive> {
  if (bytes.length < 12) throw new Error('Cindy 文件头被截断')
  if (bytes[8] !== 1 || bytes[10] !== 0 || bytes[11] !== 0) throw new Error('不支持此 Cindy 文件头版本或保留位')
  if (bytes[9] === 1) throw new Error('暂不支持加密 Cindy 分享包，请从来源客户端导出未加密包')
  if (bytes[9] !== 0) throw new Error('不支持此 Cindy 加密算法')
  const files = await readBoundedZip(bytes.subarray(12))
  const get = (path: string): Buffer => {
    const value = files.get(path)
    if (!value) throw new Error(`Cindy 包缺少文件：${path}`)
    return value
  }
  const rawManifest = JSON.parse(decode(get('manifest.json')))
  if (rawManifest?.orca !== undefined || rawManifest?.formatVersion !== 1 || rawManifest?.minReaderVersion !== 1) {
    throw new Error('仅支持 Cindy 普通单会话 v1 包；协同 Orca 或其他版本未支持')
  }
  const manifest = manifestSchema.parse(rawManifest)
  const declared = new Set<string>()
  for (const entry of manifest.entries) {
    if (entry.path === 'manifest.json' || declared.has(entry.path)) throw new Error('Cindy 清单存在重复或无效条目')
    declared.add(entry.path)
    const content = get(entry.path)
    if (content.length !== entry.bytes || createHash('sha256').update(content).digest('hex') !== entry.sha256) {
      throw new Error('Cindy 清单 SHA-256 或字节数校验失败')
    }
  }
  if (files.size !== declared.size + 1) throw new Error('Cindy 包包含未列入清单的文件')
  const source = sourceSessionSchema.parse(JSON.parse(decode(get('session.json'))))
  const media = mediaSchema.parse(JSON.parse(decode(get('media-map.json'))))
  for (const reference of [...media.entries.map(item => item.zipPath), ...manifest.transcripts.map(item => item.path)]) {
    if (reference !== null) get(reference)
  }
  const mediaFiles = [...files.keys()].filter(path => path.startsWith('media/'))
  if (mediaFiles.length !== manifest.counts.media) throw new Error('Cindy 媒体数量与清单不一致')
  const warnings = new Set<string>([
    '仅合成夹具验证；不是原生恢复，未验证来源客户端实机兼容。',
    '文本投影不保留消息 ID、分支、工具关联、权限和运行状态；不执行任何历史指令。',
    '底层 harness 转录、模型配置与未映射字段仅保存在本地原件中，不随文本包或交接导出。',
    `来源导出完整度声明为 ${manifest.exportFidelity}；这不证明附件齐全或可恢复。`,
  ])
  if (media.entries.length || manifest.counts.media) warnings.add('媒体不映射到当前档案；缺失媒体不自动下载，包内已有媒体仅保存在原件中。')
  const lines = decode(get('messages.jsonl')).split('\n').filter(line => line.trim())
  if (lines.length !== manifest.counts.messages) throw new Error('Cindy 消息数量与清单不一致')
  const ids = new Set<string>()
  const messages = lines.map(line => {
    const message = messageSchema.parse(JSON.parse(line))
    if (ids.has(message.id)) throw new Error('Cindy 消息 ID 重复')
    ids.add(message.id)
    if (message.rewindAt !== null) warnings.add('包含已回退消息；本版按导出顺序显示，不重建有效分支或执行顺序。')
    if (message.toolUseId !== null || message.agentMeta !== null) warnings.add('工具关联和 Agent 元数据未映射；其中的授权描述不作为当前用户授权。')
    return { role: message.role, content: projectContent(message.content, warnings) }
  })
  return { adapterId: 'cindy-cshare', adapterVersion: '0.1.0', sourceName: 'Cindy',
    sourceVersion: manifest.appVersion, originalSessionId: null,
    session: sessionSchema.parse({ id: 'cindy-preview', title: source.title, source: 'cindy',
      updatedAt: new Date(source.updatedAt).toISOString(), tags: ['Cindy', '文本投影'], messages, demo: false }),
    warnings: [...warnings],
  }
}
