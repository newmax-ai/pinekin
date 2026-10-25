import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
import type { ElectronApplication, TestInfo } from '@playwright/test'
import { startElectronDiagnostics, finishElectronDiagnostics } from './support/electron-diagnostics'

function fixture(status = 'failed', expectedStatus = 'passed') {
  const tracing = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) }
  const page = { evaluate: vi.fn<(callback: () => Promise<unknown>) => Promise<unknown>>().mockResolvedValue({ frames: 0, visibility: 'visible' }) }
  const app = { context: () => ({ tracing }), windows: () => [page] } as unknown as ElectronApplication
  const info = { status, expectedStatus, outputPath: (name: string) => `/synthetic/${name}`, attach: vi.fn().mockResolvedValue(undefined) } as unknown as TestInfo
  return { tracing, page, app, info }
}

describe('Electron 手工 context 的失败诊断', () => {
  it('本机未启用时不采集，不访问桌面', async () => {
    const { app, info, tracing, page } = fixture()
    await startElectronDiagnostics(app, false)
    await finishElectronDiagnostics(app, info, false)
    expect(tracing.start).not.toHaveBeenCalled()
    expect(tracing.stop).not.toHaveBeenCalled()
    expect(page.evaluate).not.toHaveBeenCalled()
  })
  it('CI 显式启动包含快照的 trace', async () => {
    const { app, tracing } = fixture()
    await startElectronDiagnostics(app, true)
    expect(tracing.start).toHaveBeenCalledWith({ screenshots: true, snapshots: true })
  })
  it.each(['failed', 'timedOut', 'interrupted'])('%s 时同时保留 trace 和绘制状态', async status => {
    const { app, info, tracing } = fixture(status)
    await finishElectronDiagnostics(app, info, true)
    expect(tracing.stop).toHaveBeenCalledWith({ path: '/synthetic/electron-trace.zip' })
    expect(info.attach).toHaveBeenCalledWith('electron-trace', { path: '/synthetic/electron-trace.zip', contentType: 'application/zip' })
    expect(info.attach).toHaveBeenCalledWith('electron-render-state', expect.objectContaining({ contentType: 'application/json' }))
  })
  it('成功时丢弃 trace，不触发页面诊断', async () => {
    const { app, info, tracing, page } = fixture('passed')
    await finishElectronDiagnostics(app, info, true)
    expect(tracing.stop).toHaveBeenCalledWith()
    expect(page.evaluate).not.toHaveBeenCalled()
    expect(info.attach).not.toHaveBeenCalled()
  })
  it('renderer 暂停时用 Node 限时结束采样，不挂住 teardown', async () => {
    vi.useFakeTimers()
    const { app, info, tracing, page } = fixture()
    page.evaluate.mockReturnValue(new Promise(() => {}))
    const finishing = finishElectronDiagnostics(app, info, true)
    await vi.advanceTimersByTimeAsync(1500)
    await finishing
    expect(tracing.stop).toHaveBeenCalled()
    const call = vi.mocked(info.attach).mock.calls.find(([name]) => name === 'electron-render-state')!
    expect(String(call[1]!.body)).toContain('1500ms')
  })
  it('采样真实回调的帧数、动画与控件几何，不改变窗口状态', async () => {
    vi.useFakeTimers()
    const { app, info, page } = fixture()
    let frame: ((time: number) => void) | undefined
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: (time: number) => void) => { frame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', cancel)
    vi.stubGlobal('innerWidth', 1380); vi.stubGlobal('innerHeight', 900)
    vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => false,
      getAnimations: () => [{ playState: 'running', currentTime: 10 }],
      querySelectorAll: () => [{ getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }),
        getAttribute: () => null, textContent: '连接 App' }] })
    page.evaluate.mockImplementation(callback => callback())
    const finishing = finishElectronDiagnostics(app, info, true)
    frame!(16)
    await vi.advanceTimersByTimeAsync(250)
    await finishing
    const call = vi.mocked(info.attach).mock.calls.find(([name]) => name === 'electron-render-state')!
    expect(JSON.parse(String(call[1]!.body))[0]).toMatchObject({ frames: 1, focused: false,
      viewport: { width: 1380, height: 900 }, animations: [{ playState: 'running', currentTime: 10 }],
      controls: [{ label: '连接 App', x: 1, y: 2, width: 3, height: 4 }] })
    expect(cancel).toHaveBeenCalledWith(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('页面已退出时保留诊断错误，仍尝试保存 trace', async () => {
    const { app, info, tracing, page } = fixture()
    page.evaluate.mockRejectedValue(new Error('页面已关闭'))
    await finishElectronDiagnostics(app, info, true)
    expect(tracing.stop).toHaveBeenCalled()
    const call = vi.mocked(info.attach).mock.calls.find(([name]) => name === 'electron-render-state')!
    expect(String(call[1]!.body)).toContain('页面已关闭')
  })
})
