import type { ElectronApplication, Page, TestInfo } from '@playwright/test'

// Electron 的手工 context 不会自动使用 Playwright 的 use.trace。
export async function startElectronDiagnostics(app: ElectronApplication, enabled: boolean): Promise<void> {
  if (enabled) await app.context().tracing.start({ screenshots: true, snapshots: true })
}

async function renderState(page: Page): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      page.evaluate(() => new Promise(resolve => {
        let frames = 0, lastFrame = 0, request = 0
        const started = performance.now()
        const tick = (time: number) => { frames++; lastFrame = time; request = requestAnimationFrame(tick) }
        request = requestAnimationFrame(tick)
        setTimeout(() => {
          cancelAnimationFrame(request)
          resolve({ frames, elapsed: performance.now() - started, lastFrame, visibility: document.visibilityState,
            focused: document.hasFocus(), viewport: { width: innerWidth, height: innerHeight },
            animations: document.getAnimations().map(animation => ({ playState: animation.playState, currentTime: animation.currentTime })),
            controls: [...document.querySelectorAll('.nav-item, .search-trigger, .session-card, dialog')].slice(0, 60).map(element => {
              const { x, y, width, height } = element.getBoundingClientRect()
              return { label: element.getAttribute('aria-label') ?? element.textContent?.slice(0, 80), x, y, width, height }
            }) })
        }, 250)
      })),
      // 不依赖 renderer 时钟；页面挂起或测试暂停时钟时也能完成 teardown。
      new Promise(resolve => { timer = setTimeout(() => resolve({ error: '绘制状态采样超过 1500ms，页面或测试时钟可能暂停' }), 1500) }),
    ])
  } catch (error) { return { error: String(error) } }
  finally { clearTimeout(timer) }
}

export async function finishElectronDiagnostics(app: ElectronApplication, info: TestInfo, enabled: boolean): Promise<void> {
  if (!enabled) return
  if (info.status === info.expectedStatus) {
    await app.context().tracing.stop()
    return
  }
  try {
    const states = await Promise.all(app.windows().map(renderState))
    await info.attach('electron-render-state', { body: Buffer.from(JSON.stringify(states, null, 2)), contentType: 'application/json' })
  } finally {
    const path = info.outputPath('electron-trace.zip')
    await app.context().tracing.stop({ path })
    await info.attach('electron-trace', { path, contentType: 'application/zip' })
  }
}
