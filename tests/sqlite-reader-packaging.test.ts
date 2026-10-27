import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('Windows SQLite 组件构建与分发契约', () => {
  it('测试、生产构建与开发入口先构建固定版本原生组件', () => {
    expect(pkg.scripts['build:sqlite-reader']).toBe('node scripts/build-sqlite-reader.mjs')
    for (const name of ['predev', 'prebuild', 'pretest', 'pretest:coverage']) expect(pkg.scripts[name]).toBe('npm run build:sqlite-reader')
  })
  it('NSIS 将当前架构组件放在 asar 外的固定 native 路径', () => {
    expect(pkg.build.win.extraResources).toContainEqual({ from: 'resources/native/win32-${arch}/pinekin-sqlite.exe', to: 'native/pinekin-sqlite.exe' })
  })
  it('源码下载固定版本、校验 SHA-256，Windows 不依赖用户安装 sqlite 或 PowerShell', () => {
    const script = readFileSync(new URL('../scripts/build-sqlite-reader.mjs', import.meta.url), 'utf8')
    expect(script).toContain("const version = '3540100'")
    expect(script).toContain("const checksum = '0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9'")
    expect(script).toContain('digest(archive) !== checksum')
    expect(script).toContain('SQLITE_OMIT_LOAD_EXTENSION')
    expect(script).not.toMatch(/powershell|sqlite3\.exe/)
  })
  it('Windows 编译命令保留 cmd 引号并在读取中文路径前切换 UTF-8 代码页', () => {
    const script = readFileSync(new URL('../scripts/build-sqlite-reader.mjs', import.meta.url), 'utf8')
    expect(script).toContain('windowsVerbatimArguments: true')
    expect(script).toContain('@chcp 65001 >nul')
  })
})
