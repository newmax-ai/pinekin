import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HANDOFF_FILE_BYTES } from '../core/handoff'

// 剪贴板引用的文件必须保持可读，不随窗口关闭或新一次复制自动删除。
export const HANDOFF_STORAGE_BYTES = 256 * 1024 * 1024
const storageFull = '接续文件副本空间已满，请通过「更多 → 保存完整接续文件」保存到自选位置。'

/** 使用 Electron 44 的原生格式桥，不把文件 URL 当作普通文字粘贴。 */
export function fileClipboardData(path: string, platform: string): Record<string, string> {
  if (platform !== 'darwin') throw new Error('当前系统暂不支持复制文件，请通过「更多 → 保存完整接续文件」后手动添加。')
  if (!isAbsolute(path) || extname(path) !== '.md') throw new Error('无效的接续文件路径。')
  return { 'electron application/osclipboard;format="public.file-url"': pathToFileURL(path).href }
}

/** root 只由主进程 userData 决定；成功副本持久保留，失败只删除本次新建文件。 */
export async function copyHandoffFile(text: string, root: string,
  writeClipboard: (data: Record<string, string>) => Promise<void>, assertAllowed: () => Promise<void>, platform = process.platform) {
  const path = join(root, `pinekin-handoff-${randomUUID()}.md`)
  const data = fileClipboardData(path, platform)
  const size = Buffer.byteLength(text)
  if (size > HANDOFF_FILE_BYTES) throw new Error('接续文件超过 Pinekin 64 MiB 文件预算，未复制。')
  await assertAllowed()
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  const directory = await lstat(root)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('接续文件目录无效。')
  if (process.platform !== 'win32') await chmod(root, 0o700)
  const entries = await readdir(root)
  if (entries.length >= 1024) throw new Error(storageFull)
  let used = 0
  for (const entry of entries) {
    const info = await lstat(join(root, entry))
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('接续文件目录包含非普通文件，请检查后重试。')
    used += info.size
    if (used + size > HANDOFF_STORAGE_BYTES) throw new Error(storageFull)
  }
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600)
  let published = false
  try {
    try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
    await assertAllowed()
    await writeClipboard(data)
    published = true
  } finally { if (!published) await unlink(path).catch(() => {}) }
}

/** 完整接续文件与当前文本导出共用安全发布，不直接截断用户文件。 */
export { saveMarkdownFile as saveHandoffFile } from './save-markdown'
