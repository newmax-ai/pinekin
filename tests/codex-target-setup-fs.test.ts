import { expect, it } from 'vitest'
import { mkdtemp, realpath, rm, mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkCodexDirectory } from '../src/main/codex-target-setup'
it('自动位置检查只接受真实目录，拒绝文件、符号链接和不存在的位置', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-target-location-')))
  try {
    await mkdir(join(root, 'data')); await writeFile(join(root, 'file'), 'synthetic')
    await symlink(join(root, 'data'), join(root, 'alias'))
    await expect(checkCodexDirectory(join(root, 'data'))).resolves.toBeUndefined()
    await expect(checkCodexDirectory(join(root, 'file'))).rejects.toThrow()
    await expect(checkCodexDirectory(join(root, 'alias'))).rejects.toThrow()
    await expect(checkCodexDirectory(join(root, 'missing'))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
