// 仅供开发期显式授权的本地批次入口；不接入 Electron IPC 或启动扫描。
import { DatabaseSync } from 'node:sqlite'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MAX_BYTES } from '../core/session'
import { readImportFile } from './import-file'
import { Library } from './library'
import { ImportCoordinator, parseArchive } from './imports'

type LocalSource = 'newmax' | 'claude-code' | 'codex'
export type LocalImportOptions = { source: LocalSource; input: string; destination: string; sourceVersion?: string; limit?: number; confirm?: boolean }
type Candidate = { bytes?: Buffer; reason?: string }

function overlaps(a: string, b: string): boolean {
  const rel = relative(a, b)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
async function canonical(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonical(parent), relative(parent, path))
  }
}

function* newmaxCandidates(path: string, sourceVersion: string): Generator<Candidate> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; BEGIN')
    // 只访问会话/消息两张表，不实例化上游 Store（其构造器会迁移、checkpoint 或写库）。
    const rows = db.prepare(`SELECT id, title, source, created_at, updated_at, forked_from_id, is_private
      FROM conversations WHERE source = 'app' AND COALESCE(is_private, 0) = 0 AND forked_from_id IS NULL
      AND message_count > 0 AND updated_at < ? ORDER BY updated_at DESC, id LIMIT 50`).all(Date.now() - 60_000)
    const size = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(data AS BLOB))), 0) AS bytes FROM messages WHERE conversation_id = ?')
    const messages = db.prepare(`SELECT seq, id, role, content, timestamp,
      json_extract(data, '$.displayContent') AS displayContent,
      CASE WHEN json_extract(data, '$.taskContinuationTurn') = 1 OR json_extract(data, '$.goalMeta.type') IS NOT NULL THEN 1 ELSE 0 END AS internal,
      CASE WHEN json_extract(data, '$.id') = id AND json_extract(data, '$.role') = role
        AND json_extract(data, '$.content') = content AND json_extract(data, '$.timestamp') = timestamp THEN 1 ELSE 0 END AS consistent
      FROM messages WHERE conversation_id = ? ORDER BY seq ASC`)
    for (const row of rows) {
      const budget = size.get(row.id!)!
      if (Number(budget.count) === 0) { yield { reason: 'no-sqlite-messages' }; continue }
      if (Number(budget.count) > 10_000 || Number(budget.bytes) > 32 * 1024 * 1024) { yield { reason: 'resource-budget' }; continue }
      const current = messages.all(row.id!)
      if (current.some(message => message.consistent !== 1)) { yield { reason: 'inconsistent-message-columns' }; continue }
      const snapshot = { format: 'pinekin.newmax-local-snapshot', version: 1, sourceVersion,
        session: { id: row.id, title: row.title, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
          forkedFromConversationId: row.forked_from_id, isPrivate: false, messageCount: current.length },
        messages: current.map(message => ({ seq: message.seq, id: message.id, role: message.role, content: message.content,
          ...(message.displayContent != null ? { displayContent: message.displayContent } : {}), timestamp: message.timestamp, internal: message.internal === 1 })) }
      const bytes = Buffer.from(JSON.stringify(snapshot))
      yield bytes.length <= MAX_BYTES ? { bytes } : { reason: 'oversize' }
    }
  } finally { db.close() }
}

async function discoverLogs(input: string, source: LocalSource) {
  const initial = await lstat(input)
  if (initial.isFile()) return { paths: [input], bounded: false }
  if (!initial.isDirectory()) throw new Error('来源必须是普通文件或约定日志目录')
  const queue = [{ path: input, depth: 0 }], found: { path: string; mtime: number }[] = []
  let entries = 0, directories = 0, bounded = false
  const depth = source === 'claude-code' ? 1 : 3
  while (queue.length) {
    if (directories >= 64 || entries >= 4096) { bounded = true; break }
    const current = queue.shift()!; directories += 1
    for await (const entry of await opendir(current.path)) {
      entries += 1
      if (entries > 4096 || found.length >= 512) { bounded = true; break }
      const path = join(current.path, entry.name)
      if (entry.isDirectory() && current.depth < depth &&
        (source === 'claude-code' || /^\d{2,4}$/.test(entry.name))) queue.push({ path, depth: current.depth + 1 })
      if (!entry.isFile()) continue // 不跟随符号链接、不进入 subagents 或未知目录。
      if (extname(entry.name) !== '.jsonl' && !(source === 'codex' && /\.jsonl\.(?:zst|zstd)$/.test(entry.name))) continue
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      found.push({ path, mtime: stat.mtimeMs })
    }
    if (bounded) break
  }
  found.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
  return { paths: found.slice(0, 50).map(file => file.path), bounded: bounded || found.length > 50 }
}

export async function importLocal(options: LocalImportOptions) {
  const limit = options.limit ?? 10
  if (!['newmax', 'claude-code', 'codex'].includes(options.source) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('来源无效或批次数量不在 1–20 范围')
  }
  const sourcePath = resolve(options.input), destination = resolve(options.destination)
  const initial = await lstat(sourcePath)
  if (initial.isSymbolicLink()) throw new Error('不接受符号链接来源')
  const sourceRoot = await canonical(initial.isFile() ? dirname(sourcePath) : sourcePath)
  const targetRoot = await canonical(destination)
  if (overlaps(sourceRoot, targetRoot) || overlaps(targetRoot, sourceRoot)) throw new Error('来源与 Pinekin 目标目录不能重叠')
  if (options.source === 'newmax') {
    if (options.sourceVersion !== '1.1.22') throw new Error('NewMax 本地读取仅核验版本 1.1.22；拒绝未知版本')
    if (!initial.isFile()) throw new Error('NewMax 来源必须是普通文件；不自动查找数据库')
  }
  const library = new Library(destination)
  const before = await library.list() // 库损坏或原有记录无效时中止，不能作为源文件不兼容跳过。
  const importer = new ImportCoordinator(library)
  const report = { source: options.source, confirmed: options.confirm === true, inspected: 0, eligible: 0, imported: 0,
    duplicates: 0, skipped: 0, reasons: {} as Record<string, number>, bounded: false,
    sourceCountBefore: before.filter(session => session.source === options.source).length, sourceCountAfter: 0 }
  let candidates: AsyncIterable<Candidate> | Iterable<Candidate>
  if (options.source === 'newmax') candidates = newmaxCandidates(sourcePath, options.sourceVersion!)
  else {
    const found = await discoverLogs(sourcePath, options.source)
    report.bounded = found.bounded
    candidates = (async function* () {
      for (const path of found.paths) {
        try {
          if (!(await lstat(path)).isFile()) { yield { reason: 'not-regular-file' }; continue }
          const bytes = await readImportFile(path)
          yield { bytes }
        } catch { yield { reason: 'unreadable-or-oversize' } }
      }
    })()
  }
  for await (const candidate of candidates) {
    report.inspected += 1
    let reason = candidate.reason
    if (candidate.bytes) {
      try {
        const parsed = await parseArchive(candidate.bytes)
        if (parsed.session.source !== options.source) reason = 'source-mismatch'
      } catch { reason = 'unsupported-format-or-budget' }
    }
    if (reason || !candidate.bytes) {
      const key = reason ?? 'empty-candidate'
      report.skipped += 1; report.reasons[key] = (report.reasons[key] ?? 0) + 1
      continue
    }
    // prepare 校验已有原件和库完整性；任何存储错误都向上传播，不作为来源格式错误隐藏。
    const preview = await importer.prepare(candidate.bytes)
    report.eligible += 1
    if (options.confirm === true) {
      const result = await importer.commit(preview.token)
      if (result.duplicate) report.duplicates += 1
      else report.imported += 1
    } else {
      if (preview.duplicate) report.duplicates += 1
      importer.cancel(preview.token)
    }
    if (report.eligible >= limit) { report.bounded = true; break }
  }
  const after = await library.list()
  report.sourceCountAfter = after.filter(session => session.source === options.source).length
  return report
}
