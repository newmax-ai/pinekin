import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readImportFile } from '../src/main/import-file'
import { MAX_BYTES } from '../src/core/session'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'staithe-file-test-')); directories.push(path); return path
}
describe('只读取选择的普通文件', () => {
  it('返回精确字节快照，允许空文件及边界大小，拒绝超限', async () => {
    const path = join(await directory(), 'synthetic.json')
    for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 1]), Buffer.alloc(MAX_BYTES)]) {
      await writeFile(path, bytes)
      expect((await readImportFile(path)).equals(bytes)).toBe(true)
    }
    await writeFile(path, Buffer.alloc(MAX_BYTES + 1))
    await expect(readImportFile(path)).rejects.toThrow(/过大/)
  })
  it('拒绝目录与不存在的文件', async () => {
    const path = await directory()
    await expect(readImportFile(path)).rejects.toThrow(/普通文件/)
    await expect(readImportFile(join(path, 'absent'))).rejects.toThrow()
  })
  if (process.platform !== 'win32') {
    it('命名管道没有写端时也立即拒绝，后续普通文件可以读取', async () => {
      const root = await directory(), pipe = join(root, 'blocked.json'), file = join(root, 'normal.json')
      execFileSync('mkfifo', [pipe])
      await expect(readImportFile(pipe)).rejects.toThrow(/普通文件/)
      await writeFile(file, 'synthetic')
      expect((await readImportFile(file)).toString()).toBe('synthetic')
    }, 2000)
  }
})
