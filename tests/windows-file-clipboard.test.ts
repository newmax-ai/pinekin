import { describe, expect, it, vi } from 'vitest'
import { writeWindowsFileClipboard } from '../src/main/windows-file-clipboard'

const path = 'C:\\Users\\测试 用户\\AppData\\Roaming\\Pinekin\\clipboard-handoffs\\pinekin-handoff-1.md'
const env = { SystemRoot: 'C:\\Windows', Path: 'C:\\evil', PATHEXT: '.EXE' }

describe('Windows 文件剪贴板', () => {
  it('用系统目录里的 Windows PowerShell 写 CF_HDROP，路径只经环境变量传递', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    await writeWindowsFileClipboard(path, { run, env })
    expect(run).toHaveBeenCalledOnce()
    const [file, args, options] = run.mock.calls[0]
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive']))
    const script = args[args.indexOf('-Command') + 1] as string
    expect(script).toContain('Set-Clipboard -LiteralPath $env:PINEKIN_CLIPBOARD_FILE')
    expect(args.join(' ')).not.toContain(path)
    expect(options.env.PINEKIN_CLIPBOARD_FILE).toBe(path)
    expect(options).toMatchObject({ windowsHide: true, timeout: expect.any(Number) })
  })
  it('拒绝相对路径、非 Markdown 文件和 UNC 路径，不启动进程', async () => {
    const run = vi.fn()
    for (const bad of ['relative.md', 'C:\\x\\a.txt', '\\\\server\\share\\a.md', '']) await expect(writeWindowsFileClipboard(bad, { run, env })).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
  it('缺少系统目录时不退回 PATH 搜索', async () => {
    const run = vi.fn()
    await expect(writeWindowsFileClipboard(path, { run, env: {} })).rejects.toThrow('系统目录')
    expect(run).not.toHaveBeenCalled()
  })
  it('进程失败或超时给出可读错误，不泄露路径与 stderr 原文', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('boom ' + path), { stderr: '拒绝访问 ' + path, killed: true }))
    const message = await writeWindowsFileClipboard(path, { run, env }).then(() => '', (error: Error) => error.message)
    expect(message).toContain('无法写入文件剪贴板')
    expect(message).toContain('保存完整接续文件')
    expect(message).not.toContain('测试 用户')
  })
})
