import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeBundle } from '../src/core/session'
import { demoSessions } from '../src/core/demo'
import { Library } from '../src/main/library'
import { ImportCoordinator } from '../src/main/imports'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'staithe-import-test-'))
  directories.push(directory)
  const library = new Library(directory)
  return { directory, library, importer: new ImportCoordinator(library) }
}
const input = () => Buffer.from(JSON.stringify(makeBundle(demoSessions[0])))

describe('用户确认的只读导入', () => {
  it('预览不落盘，确认后保存原件、来源摘要及纯文本档案', async () => {
    const { directory, library, importer } = await setup()
    const bytes = input()
    const preview = await importer.prepare(bytes)
    expect(preview).toMatchObject({ title: demoSessions[0].title, messageCount: demoSessions[0].messages.length, byteLength: bytes.length, duplicate: false })
    expect(preview.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await readdir(directory)).toEqual([])
    const result = await importer.commit(preview.token)
    expect(result.duplicate).toBe(false)
    expect(result.session.demo).toBe(false)
    expect(result.session.id).not.toBe(demoSessions[0].id)
    expect(result.session.archive?.sha256).toBe(preview.sha256)
    expect(await readFile(join(directory, 'imports', preview.sha256, 'original.bin'))).toEqual(bytes)
    expect(await new Library(directory).list()).toEqual(await library.list())
  })
  it('取消、错误 token、过期及已使用 token 都不会产生档案', async () => {
    const { directory, importer } = await setup()
    const preview = await importer.prepare(input())
    await expect(importer.commit('not-a-token')).rejects.toThrow(/预览/)
    importer.cancel(preview.token)
    await expect(importer.commit(preview.token)).rejects.toThrow(/预览/)
    expect(await readdir(directory)).toEqual([])
    let now = 0
    const expiring = new ImportCoordinator(new Library(directory), () => now)
    const old = await expiring.prepare(input())
    now = 11 * 60_000
    await expect(expiring.commit(old.token)).rejects.toThrow(/过期/)
    const next = await importer.prepare(input())
    await importer.commit(next.token)
    await expect(importer.commit(next.token)).rejects.toThrow(/预览/)
  })
  it('新预览取代旧预览，确认使用内存快照而非之后被修改的输入', async () => {
    const { importer } = await setup()
    const previous = await importer.prepare(input())
    const bytes = input()
    const current = await importer.prepare(bytes)
    bytes.fill(0)
    await expect(importer.commit(previous.token)).rejects.toThrow(/预览/)
    expect((await importer.commit(current.token)).session.title).toBe(demoSessions[0].title)
  })
  it('并发确认同一文件只保存一次，并报告完全重复', async () => {
    const { library, importer } = await setup()
    const other = new ImportCoordinator(library)
    const a = await importer.prepare(input())
    const b = await other.prepare(input())
    const results = await Promise.all([importer.commit(a.token), other.commit(b.token)])
    expect(results[0].session.id).toBe(results[1].session.id)
    expect(results.map(result => result.duplicate)).toEqual([false, true])
    expect((await library.list()).filter(session => !session.demo)).toHaveLength(1)
    expect((await importer.prepare(input())).duplicate).toBe(true)
  })
  it('写入失败可重试，但关闭或刷新后不复活失败的预览', async () => {
    const { library, importer } = await setup()
    const preview = await importer.prepare(input())
    const save = vi.spyOn(library, 'importArchive').mockRejectedValueOnce(new Error('写入失败'))
    await expect(importer.commit(preview.token)).rejects.toThrow('写入失败')
    expect((await importer.commit(preview.token)).duplicate).toBe(false)
    const next = await importer.prepare(input())
    let fail!: (error: Error) => void
    save.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const pending = importer.commit(next.token)
    importer.clear()
    fail(new Error('写入中断'))
    await expect(pending).rejects.toThrow('写入中断')
    await expect(importer.commit(next.token)).rejects.toThrow(/预览/)
  })
  it('并发预览只保留最新请求，旧异步结果不能覆盖', async () => {
    const { library, importer } = await setup()
    let finish!: () => void
    vi.spyOn(library, 'findImport').mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined) }))
    const older = importer.prepare(input())
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const latest = await importer.prepare(input())
    finish()
    await expect(older).rejects.toThrow(/替代/)
    expect((await importer.commit(latest.token)).session.title).toBe(demoSessions[0].title)
  })
  it('达到报告上限的 v2 包可以重新导入，不因附加警告超限失败', async () => {
    const { importer } = await setup()
    const session = { ...demoSessions[0], archive: {
      adapterId: 'synthetic', adapterVersion: '1', sha256: 'a'.repeat(64), importedAt: '2026-10-16T00:00:00.000Z',
      originalSessionId: null, fidelity: 'text-only' as const, warnings: Array.from({ length: 100 }, (_, i) => `合成缺失项 ${i}`),
    } }
    const preview = await importer.prepare(Buffer.from(JSON.stringify(makeBundle(session))))
    expect((await importer.commit(preview.token)).session.archive?.warnings).toHaveLength(100)
  })
  it('归档原件被破坏时拒绝假定重复并保留损坏数据', async () => {
    const { directory, importer } = await setup()
    const preview = await importer.prepare(input())
    await importer.commit(preview.token)
    const original = join(directory, 'imports', preview.sha256, 'original.bin')
    await writeFile(original, 'broken')
    await expect(importer.prepare(input())).rejects.toThrow(/校验失败/)
    expect(await readFile(original, 'utf8')).toBe('broken')
  })
  it('未知格式、截断内容、坏 UTF-8 和超预算输入都不落盘', async () => {
    const { directory, importer } = await setup()
    for (const bytes of [Buffer.from('{}'), Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(5 * 1024 * 1024 + 1)]) {
      await expect(importer.prepare(bytes)).rejects.toThrow()
    }
    expect(await readdir(directory)).toEqual([])
  })
  it('旧库损坏时不创建新档案；损坏的归档元数据不被覆盖', async () => {
    const { directory, importer, library } = await setup()
    await writeFile(join(directory, 'library.json'), 'broken')
    await expect(importer.prepare(input())).rejects.toThrow(/档案/)
    expect(await readdir(directory)).toEqual(['library.json'])
    await rm(join(directory, 'library.json'))
    const preview = await importer.prepare(input())
    await importer.commit(preview.token)
    const record = join(directory, 'imports', preview.sha256, 'record.json')
    await writeFile(record, '{}')
    await expect(library.list()).rejects.toThrow(/档案/)
    await expect(importer.prepare(input())).rejects.toThrow(/档案/)
    expect(await readFile(record, 'utf8')).toBe('{}')
  })
})
