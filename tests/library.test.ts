import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Library } from '../src/main/library'
import { makeBundle } from '../src/core/session'
import { fixtureSessions as demoSessions } from './fixtures/sessions'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'staithe-test-')); dirs.push(dir)
  return { dir, library: new Library(dir) }
}
describe('本地档案存储', () => {
  it('空库不追加任何演示数据，重新读取仍为空', async () => {
    const { library, dir } = await setup()
    expect(await library.list()).toEqual([])
    expect(await new Library(dir).list()).toEqual([])
  })
  it('旧库演示标记不进入列表，真实档案保留且不重写原库', async () => {
    const { library, dir } = await setup()
    const content = JSON.stringify([{ ...demoSessions[0], demo: true }, demoSessions[1]])
    await writeFile(join(dir, 'library.json'), content)
    expect(await library.list()).toEqual([demoSessions[1]])
    expect(await readFile(join(dir, 'library.json'), 'utf8')).toBe(content)
  })
  it('导入经过验证的包，分配新 ID 并持久化；并发导入不会丢失', async () => {
    const { library, dir } = await setup()
    const text = JSON.stringify(makeBundle(demoSessions[0]))
    const [a, b] = await Promise.all([library.importText(text), library.importText(text)])
    expect(a.id).not.toBe(b.id)
    expect(a.demo).toBe(false)
    expect(a.id).not.toBe(demoSessions[0].id)
    expect((await new Library(dir).list()).filter(s => !s.demo)).toHaveLength(2)
    expect(JSON.parse(await readFile(join(dir, 'library.json'), 'utf8'))).toHaveLength(2)
  })
  it('坏输入不更改档案，坏存储不被静默覆盖', async () => {
    const { library, dir } = await setup()
    await expect(library.importText('{}')).rejects.toThrow()
    await writeFile(join(dir, 'library.json'), 'broken')
    await expect(library.list()).rejects.toThrow(/档案/)
    await expect(library.importText(JSON.stringify(makeBundle(demoSessions[0])))).rejects.toThrow()
    expect(await readFile(join(dir, 'library.json'), 'utf8')).toBe('broken')
  })
})
