import { spawn, execFile } from 'node:child_process'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { parseCodexVersion } from '../core/codex-version'

const codexBundleSchema = z.object({ CFBundleIdentifier: z.literal('com.openai.codex'),
  CFBundleURLTypes: z.array(z.object({ CFBundleURLSchemes: z.array(z.string()) }))
    .refine(types => types.some(type => type.CFBundleURLSchemes.includes('codex'))),
})
function enclosingApplication(path: string): string | undefined {
  const boundary = path.indexOf('.app/Contents/')
  return boundary >= 0 ? path.slice(0, boundary + 4) : path.endsWith('.app') ? path : undefined
}
/** 显示名与安装目录可改名；以包标识、协议声明和包内固定 CLI 位置判定身份。 */
export async function resolveCodexApplication(selection: string) {
  const selected = await realpath(selection), application = enclosingApplication(selected)
  if (!application || !(await lstat(application)).isDirectory()) throw new Error('系统关联位置不是受支持的 Codex 应用包。')
  const metadata = join(application, 'Contents/Info.plist'), stat = await lstat(metadata)
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(metadata) !== metadata) throw new Error('应用包信息经过符号链接或越出程序范围。')
  if (stat.size > 256 * 1024) throw new Error('应用包信息超过识别上限。')
  let info: unknown
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/plutil', ['-convert', 'json', '-o', '-', metadata], { timeout: 5000, maxBuffer: 256 * 1024 })
    info = JSON.parse(stdout)
  } catch { throw new Error('无法解析应用包的 Info.plist，请检查安装包是否完整。') }
  if (!codexBundleSchema.safeParse(info).success) throw new Error('应用包身份或 codex 协议声明不匹配，不能作为 Codex 接续目标。')
  for (const relative of ['Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', 'Contents/Resources/codex', 'Contents/Resources/bin/codex']) {
    const candidate = join(application, relative)
    try {
      const file = await lstat(candidate)
      if (!file.isFile() || file.isSymbolicLink() || await realpath(candidate) !== candidate) throw new Error('内置 Codex 程序经过符号链接或越出程序范围。')
      return { path: application, binary: candidate, bundleId: 'com.openai.codex' as const }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  throw new Error('已找到 Codex 应用包，但未找到受支持的内置 CLI 布局；不会改用其他安装的程序。')
}
export async function resolveCodexBinary(selection: string): Promise<string> {
  const selected = await realpath(selection), stat = await lstat(selected)
  if (enclosingApplication(selected)) return (await resolveCodexApplication(selected)).binary
  if (stat.isFile()) return selected
  throw new Error('请选择 Codex 应用包或 Codex CLI 可执行文件。')
}

export function codexSandboxProfile(binary: string, root: string): string {
  for (const path of [binary, root]) if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error('Codex 验证路径无效。')
  return `(version 1)
(deny default)
(allow process-exec (literal ${JSON.stringify(binary)}))
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata file-test-existence)
(allow file-map-executable)
(allow process-info* (target same-sandbox))
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow file-read* (literal "/"))
(allow file-read* file-write-data (literal "/dev/zero") (subpath "/dev/fd"))
(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple") (subpath "/usr/share") (subpath "/private/preboot/Cryptexes") (subpath "/private/var/db/dyld")
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal ${JSON.stringify(binary)}) (subpath ${JSON.stringify(root)}))
(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(root)}))`
}
export function codexEnvironment(root: string): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), TMPDIR: join(root, 'tmp'),
    LANG: 'en_US.UTF-8', RUST_LOG: 'off', NO_COLOR: '1' }
}
async function isolated(binary: string, root: string) {
  if (process.platform !== 'darwin') throw new Error('当前 Codex 接续验证仅支持 macOS 隔离环境。')
  await Promise.all(['home', 'codex', 'tmp', 'workspace'].map(name => mkdir(join(root, name), { recursive: true, mode: 0o700 })))
  return { args: ['-p', codexSandboxProfile(binary, root), binary], options: { cwd: join(root, 'workspace'), env: codexEnvironment(root) } }
}
export async function codexVersion(binary: string, root: string): Promise<string> {
  const { args, options } = await isolated(binary, root)
  const { stdout } = await promisify(execFile)('/usr/bin/sandbox-exec', [...args, '--version'], { ...options, timeout: 10_000, maxBuffer: 64 * 1024 })
  return parseCodexVersion(stdout)
}
/** 只读 thread/read，不调用 thread/start、resume、turn/start；OS 沙箱拒绝网络和沙箱外配置。 */
export async function readCodexThread(binary: string, root: string, threadId: string): Promise<unknown> {
  const { args, options } = await isolated(binary, root)
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', [...args, 'app-server', '--listen', 'stdio://'], { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    let settled = false, buffer = '', count = 0, diagnostic = ''
    const timer = setTimeout(() => finish(new Error('Codex 历史验证超时，未创建目标会话。')), 20_000)
    function finish(error?: Error, result?: unknown) {
      if (settled) return
      settled = true; clearTimeout(timer); child.stdin.destroy(); child.kill('SIGKILL')
      if (error) reject(error); else resolve(result)
    }
    function send(value: unknown) { child.stdin.write(JSON.stringify(value) + '\n') }
    child.on('error', () => finish(new Error('无法启动隔离 Codex 验证程序。')))
    child.on('close', code => { if (!settled) finish(new Error(`Codex 验证进程提前退出（${code}）。${diagnostic.slice(0, 300)}`)) })
    child.stdin.on('error', () => finish(new Error('Codex 验证通道已关闭。')))
    child.stderr.on('data', chunk => { if (diagnostic.length < 2000) diagnostic += String(chunk) })
    child.stdout.on('data', chunk => {
      count += Buffer.byteLength(chunk, 'utf8')
      if (count > 96 * 1024 * 1024) { finish(new Error('Codex 回读超过验证预算。')); return }
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0 && !settled) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        let message: { id?: number; error?: unknown; result?: unknown }
        try { message = JSON.parse(line) } catch { finish(new Error('Codex 返回无效协议数据。')); return }
        if (message.id !== 1 && message.id !== 2) continue
        if (message.error) { finish(new Error('Codex 不支持此历史读取协议，未写入目标目录。')); return }
        if (message.id === 1) {
          send({ method: 'initialized', params: {} })
          send({ id: 2, method: 'thread/read', params: { threadId, includeTurns: true } })
        } else finish(undefined, message.result)
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'pinekin', version: '0.1.0' }, capabilities: { experimentalApi: true } } })
  })
}
