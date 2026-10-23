import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'

const saving = new Set<string>()
const changed = '保存目标已变化，请重新选择位置后重试。'
const sameIdentity = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino
const sameFile = (left: BigIntStats, right: BigIntStats) => sameIdentity(left, right)
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs

async function destinationState(path: string) {
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('只允许导出到普通文件，不允许符号链接。')
    return info
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function assertDirectory(path: string, expected: BigIntStats | undefined, message: string) {
  const current = await lstat(path, { bigint: true })
  if (!expected || !current.isDirectory() || current.isSymbolicLink() || !sameIdentity(expected, current)) {
    throw new Error(message)
  }
}

/** 写句柄关闭后只沿用身份与长度；时间戳可能在 Windows 关闭时才更新。 */
async function verifyTemporary(path: string, written: BigIntStats, text: string) {
  const error = '临时文件已变化，未发布。'
  const ready = await destinationState(path)
  const expected = Buffer.from(text, 'utf8')
  if (!ready || !sameIdentity(written, ready) || ready.size !== BigInt(expected.length)) throw new Error(error)
  const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    const opened = await file.stat({ bigint: true })
    if (!opened.isFile() || !sameFile(ready, opened)) throw new Error(error)
    // 限量分块回读，不因被替换或增长的文件而无限分配内存或读取。
    const buffer = Buffer.alloc(Math.min(expected.length, 64 * 1024))
    for (let offset = 0; offset < expected.length;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, expected.length - offset), offset)
      if (!bytesRead || !buffer.subarray(0, bytesRead).equals(expected.subarray(offset, offset + bytesRead))) throw new Error(error)
      offset += bytesRead
    }
    if (!sameFile(ready, await file.stat({ bigint: true }))) throw new Error(error)
  } finally { await file.close() }
  const current = await destinationState(path)
  if (!current || !sameFile(ready, current)) throw new Error(error)
  return current
}

/** 不递归清理；无法确认仍为本次创建的对象时，保留文件交由用户检查。 */
async function cleanupStaging(parent: string, parentInfo: BigIntStats, staging: string, stagingInfo: BigIntStats | undefined, temporaryInfo: BigIntStats | undefined) {
  const checkDirectories = async () => {
    await assertDirectory(parent, parentInfo, '保存目录已变化。')
    await assertDirectory(staging, stagingInfo, '临时目录已变化。')
  }
  await checkDirectories()
  const temporary = join(staging, 'content.md')
  const current = await destinationState(temporary)
  if (current) {
    if (!temporaryInfo || !sameIdentity(temporaryInfo, current)) throw new Error('临时文件已变化。')
    await unlink(temporary)
  }
  await checkDirectories()
  await rmdir(staging)
}

/** 只接受系统文件框返回的路径；不打开或截断已有目标，避免写穿最终链接。 */
export async function saveMarkdownFile(text: string, choose: () => Promise<string | null>, assertAllowed: () => Promise<void>) {
  await assertAllowed()
  const selected = await choose()
  await assertAllowed()
  if (!selected) return false
  if (!isAbsolute(selected)) throw new Error('保存位置必须是绝对路径。')
  if (extname(selected).toLowerCase() !== '.md') throw new Error('请选择 Markdown 文件（.md），不会覆盖其他格式文件。')

  // 固定已解析的父目录，后续不再沿用户选择的目录链接写入；发布前仍检查其映射和身份。
  const parent = await realpath(dirname(selected)), target = join(parent, basename(selected))
  const parentInfo = await lstat(parent, { bigint: true })
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('保存目录无效。')
  const key = process.platform === 'win32' ? target.toLowerCase() : target
  if (saving.has(key)) throw new Error('该位置正在保存，请稍候重试。')
  saving.add(key)
  let staging: string | undefined
  let stagingInfo: BigIntStats | undefined, temporaryInfo: BigIntStats | undefined
  try {
    const before = await destinationState(target)
    staging = await mkdtemp(join(parent, '.pinekin-export-'))
    stagingInfo = await lstat(staging, { bigint: true })
    await assertDirectory(staging, stagingInfo, '临时目录已变化，未发布。')
    const temporary = join(staging, 'content.md')
    const file = await open(temporary, 'wx', 0o600)
    let written: BigIntStats
    try {
      temporaryInfo = await file.stat({ bigint: true })
      await file.writeFile(text, 'utf8')
      await file.sync()
      written = await file.stat({ bigint: true })
    } finally { await file.close() }

    await assertAllowed()
    await assertDirectory(parent, parentInfo, '保存目录已变化，请重新选择位置。')
    await assertDirectory(staging, stagingInfo, '临时目录已变化，未发布。')
    const verified = await verifyTemporary(temporary, written, text)
    // 回读期间也可能撤权或更换目录／目标，发布前再次复核。
    await assertAllowed()
    await assertDirectory(parent, parentInfo, '保存目录已变化，请重新选择位置。')
    await assertDirectory(staging, stagingInfo, '临时目录已变化，未发布。')
    if (await realpath(dirname(selected)) !== parent) throw new Error('保存目录已变化，请重新选择位置。')
    const current = await destinationState(target)
    if (before ? !current || !sameFile(before, current) : !!current) throw new Error(changed)
    const ready = await destinationState(temporary)
    if (!ready || !sameFile(verified, ready)) throw new Error('临时文件已变化，未发布。')

    // rename 替换目录项，不通过目标链接写入；失败不删旧文件，也不回退为 truncate/copy。
    // Node 没有跨平台的“仅当 inode 未变时替换”API，不承诺抵御最后检查之后的恶意目录竞争。
    if (before) await rename(temporary, target)
    // 新文件用原子不覆盖发布，避免检查后出现的另一文件被 rename 覆盖；不支持硬链接时明确失败。
    else await link(temporary, target)
    return true
  } finally {
    try {
      if (staging) await cleanupStaging(parent, parentInfo, staging, stagingInfo, temporaryInfo)
    } catch {
      // 发布已完成时不能谎报保存失败；失败时也不能让清理异常遮盖原始原因。
      console.warn('Pinekin 保存临时目录未清理：无法确认对象身份或删除失败，请检查所选目录及已移动目录中的 .pinekin-export-*。')
    } finally { saving.delete(key) }
  }
}
