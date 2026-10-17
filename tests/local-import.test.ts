import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { importLocal } from '../src/main/local-import'
import { Library } from '../src/main/library'
import { claudeFixture } from './fixtures/claude-code'
import { codexFixture } from './fixtures/codex'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pinekin-local-test-')); directories.push(dir)
  const input = join(dir, 'source'), destination = join(dir, 'pinekin')
  await mkdir(input); return { dir, input, destination }
}
function seedNewMax(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, source TEXT, created_at INTEGER, updated_at INTEGER,
    forked_from_id TEXT, is_private INTEGER, message_count INTEGER);
    CREATE TABLE messages (seq INTEGER PRIMARY KEY, id TEXT, conversation_id TEXT, role TEXT, content TEXT, timestamp INTEGER, data TEXT);
    CREATE TABLE settings (secret TEXT); INSERT INTO settings VALUES ('PRIVATE_SETTINGS_SENTINEL');`)
  const time = 1_790_000_000_000
  db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?)').run('synthetic', 'NewMax 合成会话', 'app', time, time + 1000, null, 0, 2)
  db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?)').run('private', '不得导入隐私会话', 'app', time, time + 1000, null, 1, 1)
  db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?)').run('fork', '不得导入分叉', 'app', time, time + 1000, 'parent', 0, 1)
  const insert = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)')
  for (const [seq, role, content] of [[1, 'user', '合成问题'], [2, 'assistant', '合成答复']] as const) {
    insert.run(seq, `m${seq}`, 'synthetic', role, content, time + seq, JSON.stringify({ id: `m${seq}`, role, content, timestamp: time + seq,
      ...(role === 'user' ? { displayContent: '/synthetic' } : {}), toolCalls: [{ output: 'PRIVATE_TOOL_SENTINEL' }], variants: [{ content: 'PRIVATE_VARIANT_SENTINEL' }] }))
  }
  db.close()
}

describe('显式授权的本地批次入口', () => {
  it('NewMax 默认预演不创建档案，确认后保留白名单快照，不复制数据库或设置', async () => {
    const { input, destination } = await setup(), file = join(input, 'synthetic.db')
    seedNewMax(file)
    const before = await readFile(file)
    const options = { source: 'newmax' as const, input: file, destination, sourceVersion: '1.1.22', limit: 3 }
    expect(await importLocal(options)).toMatchObject({ source: 'newmax', eligible: 1, imported: 0, confirmed: false })
    await expect(readdir(destination)).rejects.toThrow()
    expect(await importLocal({ ...options, confirm: true })).toMatchObject({ eligible: 1, imported: 1, duplicates: 0 })
    const sessions = await new Library(destination).list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].messages[0].content).toBe('/synthetic')
    const original = await readFile(join(destination, 'imports', sessions[0].archive!.sha256, 'original.bin'), 'utf8')
    expect(original).not.toMatch(/PRIVATE_|toolCalls|variants|settings/)
    expect(await readFile(file)).toEqual(before)
    expect(await importLocal({ ...options, confirm: true })).toMatchObject({ imported: 0, duplicates: 1 })
  })
  it.each(['claude-code', 'codex'] as const)('%s 仅遍历约定层级，跳过链接与不支持内容，重复确认不新增', async source => {
    const { input, destination, dir } = await setup()
    const folder = source === 'claude-code' ? join(input, 'project') : join(input, '2026', '10', '17')
    await mkdir(folder, { recursive: true })
    const bytes = source === 'claude-code' ? claudeFixture() : codexFixture()
    await writeFile(join(folder, 'supported.jsonl'), bytes)
    await writeFile(join(folder, 'broken.jsonl'), 'PRIVATE_SENTINEL')
    const outside = join(dir, 'outside.jsonl'); await writeFile(outside, bytes)
    await symlink(outside, join(folder, 'linked.jsonl'))
    await mkdir(join(folder, 'subagents')); await writeFile(join(folder, 'subagents', 'ignored.jsonl'), bytes)
    const options = { source, input, destination, limit: 3 }
    const dry = await importLocal(options)
    expect(dry).toMatchObject({ eligible: 1, imported: 0, skipped: 1 })
    expect(JSON.stringify(dry)).not.toMatch(/PRIVATE_|supported.jsonl|outside/)
    expect(await importLocal({ ...options, confirm: true })).toMatchObject({ imported: 1, skipped: 1 })
    expect(await importLocal({ ...options, confirm: true })).toMatchObject({ duplicates: 1, imported: 0 })
    expect((await new Library(destination).list())[0].source).toBe(source)
  })
  it('数量上限可控，不把缺省预演变成静默保存', async () => {
    const { input, destination } = await setup(); await mkdir(join(input, 'project'))
    for (let i = 0; i < 4; i++) await writeFile(join(input, 'project', `${i}.jsonl`), claudeFixture())
    expect(await importLocal({ source: 'claude-code', input, destination, limit: 2 })).toMatchObject({ eligible: 2, imported: 0 })
    await expect(readdir(destination)).rejects.toThrow()
  })
  it('单个源文件也可显式导入，超限源不截断，目标库损坏时中止而不覆盖', async () => {
    const { input, destination } = await setup(), file = join(input, 'one.jsonl')
    await writeFile(file, claudeFixture())
    await mkdir(destination); await writeFile(join(destination, 'library.json'), 'broken')
    await expect(importLocal({ source: 'claude-code', input: file, destination, confirm: true })).rejects.toThrow(/档案/)
    expect(await readFile(join(destination, 'library.json'), 'utf8')).toBe('broken')
    await rm(join(destination, 'library.json'))
    await writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1))
    expect(await importLocal({ source: 'claude-code', input: file, destination })).toMatchObject({ eligible: 0, skipped: 1 })
  })
  it('不支持的版本、非普通文件、重叠目录和异常参数在写入前拒绝', async () => {
    const { input, destination, dir } = await setup(), file = join(input, 'synthetic.db')
    seedNewMax(file)
    for (const limit of [0, 21, 1.5]) await expect(importLocal({ source: 'codex', input, destination, limit })).rejects.toThrow()
    await expect(importLocal({ source: 'newmax', input: file, destination, sourceVersion: 'future' })).rejects.toThrow(/版本/)
    await expect(importLocal({ source: 'newmax', input, destination, sourceVersion: '1.1.22' })).rejects.toThrow(/普通文件/)
    await expect(importLocal({ source: 'codex', input, destination: input })).rejects.toThrow(/重叠/)
    await expect(importLocal({ source: 'codex', input, destination: join(input, '..nested') })).rejects.toThrow(/重叠/)
    const linked = join(dir, 'linked'); await symlink(input, linked)
    await expect(importLocal({ source: 'codex', input: linked, destination })).rejects.toThrow(/链接/)
  })
})
