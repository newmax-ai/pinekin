import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveCodexApplication, resolveCodexBinary } from '../src/main/codex-target-runtime'
import { CodexTargetSetup, checkCodexDirectory } from '../src/main/codex-target-setup'
import { SourceActions } from '../src/main/source-actions'

it('真实系统协议关联的应用包可被识别，合成数据位置可确认且不触发写入', async () => {
  const requestedApp = process.env.PINEKIN_CODEX_TEST_APP
  if (!requestedApp) throw new Error('必须显式指定获准只读核验的应用包位置；不读取真实会话或凭据。')
  const execute = promisify(execFile)
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    'ObjC.import("AppKit"); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("codex://")); JSON.stringify({path: ObjC.unwrap(u.path) || null});'], { timeout: 10_000, maxBuffer: 16_384 })
  const associated = JSON.parse(stdout).path
  expect(associated).toBe(requestedApp)
  const application = await resolveCodexApplication(associated)
  const { stdout: name } = await execute('/usr/bin/plutil', ['-extract', 'CFBundleName', 'raw', '-o', '-', join(application.path, 'Contents/Info.plist')], { timeout: 5000, maxBuffer: 16_384 })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-installed-app-contract-')))
  try {
    const home = join(root, 'synthetic-home'); await mkdir(home)
    const forbidden = async (): Promise<never> => { throw new Error('识别阶段不得选择文件、配置或创建目标。') }
    const setup = new CodexTargetSetup({ platform: 'darwin', defaultHome: home, locationSource: 'default', saved: async () => undefined,
      application: async () => ({ name: name.trim(), path: application.path }), resolveBinary: resolveCodexBinary, checkDirectory: checkCodexDirectory,
      chooseApplication: forbidden, chooseDirectory: forbidden, configure: forbidden })
    const preview = await setup.inspect('automatic')
    expect(preview?.token).toBeTruthy()
    expect(preview?.reason).toBeUndefined()
    expect(preview?.applicationName).toBe(name.trim())
    expect(preview?.applicationPath).toBe(associated)
    const id = 'a'.repeat(64), threadId = '0199e6ba-0000-7000-8000-000000000001', opened: string[] = []
    const actions = new SourceActions({ getEntry: async () => ({ id, source: 'codex', connectionId: '11111111-1111-4111-8111-111111111111',
      title: '合成定位', updatedAt: '2026-10-19T00:00:00Z', sourceSessionId: threadId, availability: 'readable', project: '' }),
      handler: async () => { await resolveCodexApplication(associated); return 'Codex' }, openExternal: async url => { opened.push(url) } })
    expect((await actions.inspect(id)).original.available).toBe(true)
    await actions.openOriginal(id)
    expect(opened).toEqual([`codex://threads/${threadId}`])
    const report = { applicationName: name.trim(), ...application, canConfirm: !!preview?.token, syntheticOriginalOpen: opened[0], realSessionDataRead: false, realSessionDataWritten: false }
    if (process.env.PINEKIN_CODEX_DIAGNOSTIC_REPORT) await writeFile(process.env.PINEKIN_CODEX_DIAGNOSTIC_REPORT, JSON.stringify(report, null, 2) + '\n')
    console.info('本机应用包识别通过', report)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20_000)
