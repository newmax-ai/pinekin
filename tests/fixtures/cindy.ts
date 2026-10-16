import { createHash } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'

// 完全合成的数据，不读取客户端，不复用生产解析器生成期望结果。
export interface ZipFixtureEntry { name: string; content: Buffer; attributes?: number; stored?: boolean }
export function zipFixture(entries: ZipFixtureEntry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const compressed = entry.stored ? entry.content : deflateRawSync(entry.content)
    const method = entry.stored ? 0 : 8
    const checksum = crc32(entry.content)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(method, 8); header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(entry.content.length, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, compressed)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(checksum, 16)
    record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(entry.content.length, 24)
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(entry.attributes ?? 0, 38); record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += header.length + name.length + compressed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
export function sharedEmptyZipFixture(): Buffer {
  // 多个中央目录项引用同一段有效的空 DEFLATE 块，不靠展开体积触发限制。
  const names = ['shared-a', 'shared-b', 'shared-c']
  const base = zipFixture(names.map(name => ({ name, content: Buffer.alloc(0), stored: true })))
  const end = Buffer.from(base.subarray(-22))
  const central = Buffer.from(base.subarray(end.readUInt32LE(16), -22))
  const compressed = Buffer.alloc(3 * 1024 * 1024 - (3 * 1024 * 1024) % 5)
  for (let i = 0; i < compressed.length; i += 5) {
    compressed[i + 3] = 0xff; compressed[i + 4] = 0xff
  }
  compressed[compressed.length - 5] = 1
  const local = Buffer.from(base.subarray(0, 30 + Buffer.byteLength(names[0])))
  local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18)
  let offset = 0
  for (const name of names) {
    central.writeUInt16LE(8, offset + 10); central.writeUInt32LE(compressed.length, offset + 20)
    central.writeUInt32LE(0, offset + 42)
    offset += 46 + Buffer.byteLength(name)
  }
  end.writeUInt32LE(local.length + compressed.length, 16)
  return Buffer.concat([local, compressed, central, end])
}
export const cindyMessage = (patch: Record<string, unknown> = {}) => ({
  id: 'synthetic-message-1', clientId: 'synthetic-client-1', role: 'user',
  content: JSON.stringify([{ type: 'text', text: '<script>不执行</script> 合成的 Cindy 会话' }]),
  toolUseId: null, agentMeta: null, agentKind: 'cc', createdAt: 1792108800000, rewindAt: null, ...patch,
})
export function cindyEntries(options: {
  manifest?: Record<string, unknown>; session?: Record<string, unknown>; messages?: unknown[];
  media?: unknown[]; extra?: ZipFixtureEntry[];
} = {}): ZipFixtureEntry[] {
  const messages = options.messages ?? [cindyMessage(), cindyMessage({ id: 'synthetic-message-2', clientId: 'synthetic-client-2', role: 'assistant', content: JSON.stringify('可以从这里继续。') })]
  const entries: ZipFixtureEntry[] = [
    { name: 'session.json', content: Buffer.from(JSON.stringify({ title: 'Cindy 合成档案', workspaceKind: 'dialogue', model: 'synthetic-model',
      effort: 'medium', permissionMode: 'default', sdkSessionId: null, totalTokenUsage: 0, totalCostUsd: 0,
      contextTokens: 0, contextWindow: 0, fastMode: false, planModeEnabled: false, agentKind: 'cc',
      clearedAt: null, userSendAt: null, createdAt: 1792108800000, updatedAt: 1792108800000, ...options.session })) },
    { name: 'messages.jsonl', content: Buffer.from(messages.map(message => JSON.stringify(message)).join('\n')) },
    { name: 'media-map.json', content: Buffer.from(JSON.stringify({ entries: options.media ?? [] })) },
    ...(options.extra ?? []),
  ]
  const manifest = { formatVersion: 1, minReaderVersion: 1, appVersion: 'synthetic-fixture', platform: 'darwin',
    exportedAt: '2026-10-16T00:00:00.000Z', agentKind: 'cc', title: 'Cindy 合成档案', workspaceKind: 'dialogue',
    originalWorkingDir: null, activeSdkSessionId: null, sdkSessionIds: [], exportFidelity: 'db-only',
    counts: { messages: messages.length, media: 0 }, transcripts: [],
    entries: entries.filter(entry => !entry.name.endsWith('/')).map(entry => ({ path: entry.name, bytes: entry.content.length,
      sha256: createHash('sha256').update(entry.content).digest('hex') })), ...options.manifest }
  return [...entries, { name: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) }]
}
export function cindyFixture(entries = cindyEntries()): Buffer {
  const header = Buffer.alloc(12)
  header.write('XDTSHARE'); header[8] = 1
  return Buffer.concat([header, zipFixture(entries)])
}
