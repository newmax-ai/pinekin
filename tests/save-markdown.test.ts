import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveMarkdownFile } from '../src/main/save-markdown'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open), rename: vi.fn(original.rename), link: vi.fn(original.link) }
})
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let root: string, destination: string
beforeEach(async () => {
  vi.clearAllMocks()
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pinekin-safe-save-')))
  destination = join(root, '含 空格🙂.md')
  vi.mocked(fs.open).mockImplementation(real.open)
  vi.mocked(fs.rename).mockImplementation(real.rename)
  vi.mocked(fs.link).mockImplementation(real.link)
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }) })
const save = (guard = async () => {}) => saveMarkdownFile('新内容🙂', async () => destination, guard)

 describe('Markdown 安全发布', () => {
  it('取消不创建文件，错误扩展名与相对路径不落盘', async () => {
    expect(await saveMarkdownFile('内容', async () => null, async () => {})).toBe(false)
    await expect(saveMarkdownFile('内容', async () => join(root, 'keep.txt'), async () => {})).rejects.toThrow('Markdown')
    await expect(saveMarkdownFile('内容', async () => 'relative.md', async () => {})).rejects.toThrow('绝对路径')
    expect(await fs.readdir(root)).toEqual([])
  })
  it('新建完整文件并清理临时目录，覆盖不修改原文件的其他硬链接', async () => {
    expect(await save()).toBe(true)
    expect(await fs.readFile(destination, 'utf8')).toBe('新内容🙂')
    const other = join(root, 'original.md')
    await fs.link(destination, other)
    expect(await saveMarkdownFile('短', async () => destination, async () => {})).toBe(true)
    expect(await fs.readFile(destination, 'utf8')).toBe('短')
    expect(await fs.readFile(other, 'utf8')).toBe('新内容🙂')
    if (process.platform !== 'win32') expect((await fs.stat(destination)).mode & 0o777).toBe(0o600)
    expect((await fs.readdir(root)).sort()).toEqual(['original.md', '含 空格🙂.md'].sort())
  })
  it.each(['darwin', 'win32'])('%s 拒绝符号链接、悬空链接和目录', async platform => {
    const outside = join(root, 'outside.txt')
    await fs.writeFile(outside, '保留')
    await fs.symlink(outside, destination, 'file')
    vi.stubGlobal('process', Object.create(process, { platform: { value: platform } }))
    await expect(save()).rejects.toThrow('普通文件')
    expect(await fs.readFile(outside, 'utf8')).toBe('保留')
    await fs.unlink(outside)
    await expect(save()).rejects.toThrow('普通文件')
    await fs.unlink(destination); await fs.mkdir(destination)
    await expect(save()).rejects.toThrow('普通文件')
  })
  it.each(['write', 'sync', 'close', 'rename'] as const)('%s 失败保留旧文件并清理本次临时内容', async operation => {
    await fs.writeFile(destination, '原文不可丢失')
    if (operation === 'rename') vi.mocked(fs.rename).mockRejectedValueOnce(new Error('发布失败'))
    else vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const file = await real.open(...args)
      if (operation === 'write') vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
        await real.writeFile(file, '不完整内容'); throw new Error('写入失败')
      })
      if (operation === 'sync') vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('同步失败'))
      if (operation === 'close') {
        const close = file.close.bind(file)
        vi.spyOn(file, 'close').mockImplementationOnce(async () => { await close(); throw new Error('关闭失败') })
      }
      return file
    })
    await expect(save()).rejects.toThrow('失败')
    expect(await fs.readFile(destination, 'utf8')).toBe('原文不可丢失')
    expect(await fs.readdir(root)).toEqual(['含 空格🙂.md'])
  })
  it('新文件安全发布不支持或失败时不回退为覆盖', async () => {
    vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error('硬链接不可用'), { code: 'ENOTSUP' }))
    await expect(save()).rejects.toThrow('硬链接不可用')
    expect(await fs.readdir(root)).toEqual([])
    expect(fs.rename).not.toHaveBeenCalled()
  })
  it.each([false, true])('发布前撤权不改目标（目标已存在=%s）', async exists => {
    if (exists) await fs.writeFile(destination, '原文')
    let checks = 0
    await expect(save(async () => { if (++checks === 3) throw new Error('已撤权') })).rejects.toThrow('已撤权')
    expect(await fs.readdir(root)).toEqual(exists ? ['含 空格🙂.md'] : [])
    if (exists) expect(await fs.readFile(destination, 'utf8')).toBe('原文')
  })
  it.each(['replace', 'modify', 'delete', 'symlink'] as const)('准备期间目标被 %s 时拒绝发布', async change => {
    const outside = join(root, 'outside.txt')
    await fs.writeFile(outside, '外部原文'); await fs.writeFile(destination, '原文')
    let checks = 0
    await expect(save(async () => {
      if (++checks !== 3) return
      if (change === 'modify') await fs.writeFile(destination, '其他写入者的内容')
      else {
        await fs.unlink(destination)
        if (change === 'replace') await fs.writeFile(destination, '其他写入者的内容')
        if (change === 'symlink') await fs.symlink(outside, destination, 'file')
      }
    })).rejects.toThrow()
    expect(await fs.readFile(outside, 'utf8')).toBe('外部原文')
    if (change === 'modify' || change === 'replace') expect(await fs.readFile(destination, 'utf8')).toBe('其他写入者的内容')
    expect((await fs.readdir(root)).some(name => name.startsWith('.pinekin-export-'))).toBe(false)
  })
  it('新路径在最终发布瞬间被占用时，不覆盖竞争者的文件', async () => {
    vi.mocked(fs.link).mockImplementationOnce(async (existing, target) => {
      await fs.writeFile(target, '竞争者内容')
      return real.link(existing, target)
    })
    await expect(save()).rejects.toThrow()
    expect(await fs.readFile(destination, 'utf8')).toBe('竞争者内容')
    expect(await fs.readdir(root)).toEqual(['含 空格🙂.md'])
  })
  it('覆盖发布瞬间换成符号链接，也不会写穿链接目标', async () => {
    const outside = join(root, 'outside.txt')
    await fs.writeFile(outside, '外部原文'); await fs.writeFile(destination, '旧内容')
    vi.mocked(fs.rename).mockImplementationOnce(async (source, target) => {
      await fs.unlink(target); await fs.symlink(outside, target, 'file')
      return real.rename(source, target)
    })
    // 某些 Windows 文件系统可能拒绝替换链接；两种结果都不能改写链接目标。
    const result = await save().then(() => true, () => false)
    expect(await fs.readFile(outside, 'utf8')).toBe('外部原文')
    if (result) expect(await fs.readFile(destination, 'utf8')).toBe('新内容🙂')
    expect((await fs.readdir(root)).some(name => name.startsWith('.pinekin-export-'))).toBe(false)
  })
  it('所选父目录的链接在准备期间重定向时拒绝，不写另一个目录', async () => {
    const first = join(root, 'first'), second = join(root, 'second'), alias = join(root, 'alias')
    await fs.mkdir(first); await fs.mkdir(second); await fs.symlink(first, alias, 'junction')
    destination = join(alias, 'context.md')
    let checks = 0
    await expect(save(async () => {
      if (++checks === 3) { await fs.unlink(alias); await fs.symlink(second, alias, 'junction') }
    })).rejects.toThrow('目录')
    expect(await fs.readdir(first)).toEqual([]); expect(await fs.readdir(second)).toEqual([])
  })
  it('父目录被替换后拒绝发布，清理不删除替换目录中的无关文件', async () => {
    const parent = join(root, 'selected'), moved = join(root, 'moved')
    await fs.mkdir(parent)
    destination = join(parent, 'context.md')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let checks = 0, stagingName = ''
    await expect(save(async () => {
      if (++checks !== 3) return
      stagingName = (await fs.readdir(parent))[0]
      await fs.rename(parent, moved)
      await fs.mkdir(join(parent, stagingName), { recursive: true })
      await fs.writeFile(join(parent, stagingName, 'unrelated.txt'), '不可删除')
    })).rejects.toThrow('目录已变化')
    expect(await fs.readFile(join(parent, stagingName, 'unrelated.txt'), 'utf8')).toBe('不可删除')
    expect(await fs.readFile(join(moved, stagingName, 'content.md'), 'utf8')).toBe('新内容🙂')
    expect(warn).toHaveBeenCalled()
  })
  it('临时目录被替换后不发布、不清理替代目录，即使原文件被移入其中', async () => {
    const moved = join(root, 'moved-staging')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let checks = 0, staging = ''
    await expect(save(async () => {
      if (++checks !== 3) return
      staging = join(root, (await fs.readdir(root))[0])
      await fs.rename(staging, moved)
      await fs.mkdir(staging)
      await fs.rename(join(moved, 'content.md'), join(staging, 'content.md'))
      await fs.writeFile(join(staging, 'unrelated.txt'), '不可删除')
    })).rejects.toThrow('临时目录已变化')
    expect(await fs.readFile(join(staging, 'unrelated.txt'), 'utf8')).toBe('不可删除')
    expect(await fs.readFile(join(staging, 'content.md'), 'utf8')).toBe('新内容🙂')
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(warn).toHaveBeenCalled()
  })
  it.each([false, true])('清理不递归删除临时目录中额外出现的文件（撤权=%s）', async revoked => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let checks = 0, unrelated = ''
    const pending = save(async () => {
      if (++checks !== 3) return
      unrelated = join(root, (await fs.readdir(root))[0], 'unrelated.txt')
      await fs.writeFile(unrelated, '不可删除')
      if (revoked) throw new Error('已撤权')
    })
    if (revoked) await expect(pending).rejects.toThrow('已撤权')
    else await expect(pending).resolves.toBe(true)
    expect(await fs.readFile(unrelated, 'utf8')).toBe('不可删除')
    expect(warn).toHaveBeenCalled()
  })
  it('Windows 写句柄关闭时合法更新时间戳仍能保存，完整回读内容', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const file = await real.open(...args)
      const close = file.close.bind(file)
      vi.spyOn(file, 'close').mockImplementationOnce(async () => {
        await close()
        await fs.utimes(args[0], new Date('2026-01-01'), new Date('2026-01-01'))
      })
      return file
    })
    await expect(save()).resolves.toBe(true)
    expect(await fs.readFile(destination, 'utf8')).toBe('新内容🙂')
    expect(await fs.readdir(root)).toEqual(['含 空格🙂.md'])
  })
  it('允许关闭时更新时间戳不等于允许同长度内容篡改', async () => {
    await fs.writeFile(destination, '旧文件')
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const file = await real.open(...args)
      const close = file.close.bind(file)
      vi.spyOn(file, 'close').mockImplementationOnce(async () => {
        await close()
        await fs.writeFile(args[0], '坏内容🙂')
      })
      return file
    })
    await expect(save()).rejects.toThrow('临时文件已变化')
    expect(await fs.readFile(destination, 'utf8')).toBe('旧文件')
    expect(await fs.readdir(root)).toEqual(['含 空格🙂.md'])
  })
  it('同名临时文件被替换时拒绝发布且不删除替换文件', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let checks = 0, temporary = ''
    await expect(save(async () => {
      if (++checks !== 3) return
      temporary = join(root, (await fs.readdir(root))[0], 'content.md')
      await fs.rename(temporary, join(root, 'original-staging.md'))
      await fs.writeFile(temporary, '新内容🙂')
    })).rejects.toThrow('临时文件已变化')
    expect(await fs.readFile(temporary, 'utf8')).toBe('新内容🙂')
    expect(warn).toHaveBeenCalled()
  })
  it.each(['', '长内容🙂'.repeat(20000)])('支持空内容和跨多个回读块的完整内容（%#）', async text => {
    await expect(saveMarkdownFile(text, async () => destination, async () => {})).resolves.toBe(true)
    expect(await fs.readFile(destination, 'utf8')).toBe(text)
    expect(await fs.readdir(root)).toEqual(['含 空格🙂.md'])
  })
  it.each(['eof', 'error'] as const)('回读遇到 %s 时拒绝发布、保留原件并清理临时内容', async mode => {
    await fs.writeFile(destination, '旧文件')
    let opens = 0
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await real.open(...args)
      if (++opens === 2) {
        const read = vi.spyOn(file, 'read')
        if (mode === 'eof') read.mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) })
        else read.mockRejectedValueOnce(new Error('回读失败'))
      }
      return file
    })
    await expect(save()).rejects.toThrow(mode === 'eof' ? '临时文件已变化' : '回读失败')
    expect(await fs.readFile(destination, 'utf8')).toBe('旧文件')
    expect(await fs.readdir(root)).toEqual(['含 空格🙂.md'])
  })
  it('回读完成后撤权仍不发布', async () => {
    let checks = 0
    await expect(save(async () => { if (++checks === 4) throw new Error('已撤权') })).rejects.toThrow('已撤权')
    expect(await fs.readdir(root)).toEqual([])
  })
  it('回读完成后临时文件变化仍不发布', async () => {
    let checks = 0
    await expect(save(async () => {
      if (++checks === 4) await fs.writeFile(join(root, (await fs.readdir(root))[0], 'content.md'), '回读后被更改')
    })).rejects.toThrow('临时文件已变化')
    expect(await fs.readdir(root)).toEqual([])
  })
  it('拒绝本应用对同一路径并发发布，第一次完成后可重试', async () => {
    let release!: () => void
    let ready!: () => void
    const prepared = new Promise<void>(resolve => { ready = resolve })
    let checks = 0
    const pending = save(async () => {
      if (++checks === 3) { ready(); await new Promise<void>(resolve => { release = resolve }) }
    })
    await prepared
    try { await expect(save()).rejects.toThrow('正在保存') } finally { release() }
    await expect(pending).resolves.toBe(true)
    await expect(save()).resolves.toBe(true)
  })
})
