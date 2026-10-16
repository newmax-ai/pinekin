import { createHash, randomUUID } from 'node:crypto'
import { MAX_BYTES, parseBundle } from '../core/session'
import type { ImportPreview, ParsedArchive, Session } from '../core/types'
import type { Library } from './library'
import { parseCindy } from './cindy'

export async function parseArchive(input: Uint8Array): Promise<ParsedArchive> {
  if (input.byteLength > MAX_BYTES) throw new Error('文件过大，最大支持 5 MB')
  const bytes = Buffer.from(input)
  if (bytes.subarray(0, 8).equals(Buffer.from('XDTSHARE'))) return parseCindy(bytes)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let bundle
  try { bundle = parseBundle(text) }
  catch (error) {
    throw new Error('文件格式不支持或已损坏。支持 Staithe / Ember 文本包与未加密 Cindy v1 包；DeepSeek 导出格式尚待样本验证。', { cause: error })
  }
  const session: Session = bundle.session
  return { session, adapterId: 'staithe-bundle', adapterVersion: '0.1.0',
    sourceName: bundle.format === 'ember.session' ? 'Ember 会话包' : 'Staithe 会话包',
    warnings: session.archive?.warnings ?? ['仅导入文本档案，不恢复客户端运行状态。'],
  }
}

export class ImportCoordinator {
  private generation = 0
  private pending?: { token: string; bytes: Buffer; parsed: ParsedArchive; sha256: string; expiresAt: number }
  constructor(private readonly library: Library, private readonly now = Date.now) {}
  clear() { this.generation += 1; this.pending = undefined }
  async prepare(input: Uint8Array): Promise<ImportPreview> {
    this.clear()
    const generation = this.generation
    if (input.byteLength > MAX_BYTES) throw new Error('文件过大，最大支持 5 MB')
    const bytes = Buffer.from(input)
    const parsed = await parseArchive(bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const duplicate = !!await this.library.findImport(sha256)
    if (generation !== this.generation) throw new Error('预览已被新的选择替代')
    const token = randomUUID()
    this.pending = { token, bytes, parsed, sha256, expiresAt: this.now() + 10 * 60_000 }
    return { token, sourceName: parsed.sourceName, evidence: 'fixture-tested', title: parsed.session.title,
      messageCount: parsed.session.messages.length, byteLength: bytes.length, sha256,
      warnings: [...parsed.warnings], duplicate }
  }
  cancel(token: string) {
    if (this.pending?.token === token) this.clear()
  }
  async commit(token: string) {
    const pending = this.pending
    if (!pending || pending.token !== token) throw new Error('导入预览无效，请重新选择文件')
    this.clear()
    const generation = this.generation
    if (this.now() >= pending.expiresAt) throw new Error('导入预览已过期，请重新选择文件')
    try { return await this.library.importArchive(pending.bytes, pending.parsed, pending.sha256) }
    catch (error) {
      // 写入失败仍可重试同一快照；新的选择、刷新和关闭都使旧快照失效。
      if (generation === this.generation && this.now() < pending.expiresAt) this.pending = pending
      throw error
    }
  }
}
