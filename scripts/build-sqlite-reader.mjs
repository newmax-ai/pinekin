import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, chmod, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'

// 官方 amalgamation 含 SQLite 与 SHA3 扩展源码，固定版本与整个包哈希；运行时不下载。
const version = '3540100'
const checksum = '0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, 'node_modules/.cache/pinekin-sqlite')
const output = join(root, `resources/native/${process.platform}-${process.arch}`)
const executable = join(output, `pinekin-sqlite${process.platform === 'win32' ? '.exe' : ''}`)
const source = join(root, 'native/sqlite-reader.c')
const digest = value => createHash('sha256').update(value).digest('hex')
const buildKey = digest(Buffer.concat([await readFile(source), await readFile(fileURLToPath(import.meta.url)), Buffer.from(`${checksum}:${process.platform}:${process.arch}`)]))
if (!['darwin', 'win32'].includes(process.platform)) {
  console.log('SQLite 原生组件：当前平台尚未支持，未构建。')
  process.exit(0)
}
try {
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  if (manifest.buildKey === buildKey && digest(await readFile(executable)) === manifest.sha256) {
    console.log('SQLite 只读组件：固定源码与产物校验通过，复用构建。')
    process.exit(0)
  }
} catch { /* 缺少或过期的构建重新生成，不回退到系统 sqlite3。 */ }
await mkdir(cache, { recursive: true })
await mkdir(output, { recursive: true })
const archivePath = join(cache, `sqlite-amalgamation-${version}.zip`)
let archive
try { archive = await readFile(archivePath) } catch { /* 首次构建下载。 */ }
if (!archive || digest(archive) !== checksum) {
  const download = await mkdtemp(join(cache, 'download-'))
  const response = await fetch(`https://www.sqlite.org/2026/sqlite-amalgamation-${version}.zip`, { signal: AbortSignal.timeout(60_000), redirect: 'error' })
  if (!response.ok) throw new Error(`SQLite 官方源码下载失败：${response.status}`)
  archive = Buffer.from(await response.arrayBuffer())
  if (archive.length > 8 * 1024 * 1024 || digest(archive) !== checksum) throw new Error('SQLite 官方源码哈希不匹配，拒绝构建')
  const downloaded = join(download, 'sqlite.zip')
  await writeFile(downloaded, archive, { flag: 'wx' })
  // 下载位于单独的新目录；解析与编译脚本不从下载目录运行。
  await writeFile(archivePath, archive)
}
const extracted = await mkdtemp(join(cache, 'source-'))
const files = new Map()
await new Promise((resolveArchive, reject) => {
  yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error)
    zip.on('error', reject)
    zip.on('end', resolveArchive)
    zip.on('entry', entry => {
      const name = entry.fileName.replace(`sqlite-amalgamation-${version}/`, '')
      if (!['sqlite3.c', 'sqlite3.h', 'sqlite3ext.h', 'shell.c'].includes(name)) { zip.readEntry(); return }
      if (entry.uncompressedSize > 16 * 1024 * 1024 || files.has(name)) { zip.close(); reject(new Error('SQLite 源码包结构异常')); return }
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError) { reject(streamError); return }
        const chunks = []
        stream.on('data', chunk => chunks.push(chunk))
        stream.on('error', reject)
        stream.on('end', () => { files.set(name, Buffer.concat(chunks)); zip.readEntry() })
      })
    })
    zip.readEntry()
  })
})
if (files.size !== 4) throw new Error('SQLite 源码包缺少必要文件')
for (const [name, content] of files) await writeFile(join(extracted, name), content, { flag: 'wx' })
// 只编译官方 SHA3 扩展，不引入 shell、文件读写、动态加载扩展或用户启动脚本。
const shell = files.get('shell.c').toString('utf8')
const begin = '/************************* Begin ext/misc/shathree.c ******************/'
const end = '/************************* End ext/misc/shathree.c ********************/'
const start = shell.indexOf(begin), stop = shell.indexOf(end)
if (start < 0 || stop <= start) throw new Error('SQLite 官方 SHA3 扩展边界不匹配')
await writeFile(join(extracted, 'shathree.c'), '#include "sqlite3ext.h"\ntypedef sqlite3_uint64 u64;\n' + shell.slice(start + begin.length, stop), { flag: 'wx' })
const build = await mkdtemp(join(cache, 'build-'))
const target = join(build, process.platform === 'win32' ? 'pinekin-sqlite.exe' : 'pinekin-sqlite')
const defines = ['SQLITE_CORE', 'SQLITE_OMIT_LOAD_EXTENSION', 'SQLITE_TEMP_STORE=3', 'SQLITE_THREADSAFE=0', 'SQLITE_DQS=0', 'SQLITE_MAX_MMAP_SIZE=0']
const sources = [source, join(extracted, 'sqlite3.c'), join(extracted, 'shathree.c')]
if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw new Error('Windows SQLite 组件目前只构建 x64，不冒充 ARM64 支持')
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (!existsSync(vswhere)) throw new Error('需要 Visual Studio C++ Build Tools；未回退到不安全读取')
  const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim()
  if (!installation) throw new Error('未找到 Windows x64 C++ 编译工具')
  const vcvars = join(installation, 'VC/Auxiliary/Build/vcvars64.bat')
  const quote = value => {
    if (/["\r\n%]/.test(value)) throw new Error('原生构建路径包含不支持的命令字符')
    return `"${value}"`
  }
  const flags = ['/nologo', '/O2', '/MT', '/utf-8', ...defines.map(value => `/D${value}`), '/DSQLITE_WIN32_HAS_ANSI=0', `/I${quote(extracted)}`, ...sources.map(quote), `/Fe:${quote(target)}`]
  const script = join(build, 'compile.cmd')
  await writeFile(script, `@chcp 65001 >nul\r\n@call ${quote(vcvars)} >nul\r\n@if errorlevel 1 exit /b %errorlevel%\r\n@chcp 65001 >nul\r\ncl ${flags.join(' ')}\r\n@exit /b %errorlevel%\r\n`)
  // cmd 使用自己的引号规则，不能套用 C argv 的反斜杠转义；/s 消去最外层引号。
  execFileSync(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `""${script}""`], {
    cwd: build, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true,
  })
} else {
  execFileSync('/usr/bin/clang', ['-O2', ...defines.map(value => `-D${value}`), '-I', extracted, ...sources, '-o', target], { cwd: build, stdio: 'inherit' })
}
const protocol = execFileSync(target, ['--version'], { encoding: 'utf8', windowsHide: true }).trim()
if (protocol !== 'pinekin-readonly-v1 SQLite 3.54.1') throw new Error('SQLite 组件协议或版本不匹配')
await chmod(target, 0o755)
await rename(target, executable)
await writeFile(join(output, 'manifest.json'), JSON.stringify({ buildKey, sha256: digest(await readFile(executable)), protocol }, null, 2) + '\n')
console.log(`SQLite 只读组件已构建：${process.platform}-${process.arch} (${protocol})`)
