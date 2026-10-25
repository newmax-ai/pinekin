import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadConfig(ci: boolean) {
  vi.stubEnv('CI', ci ? 'true' : '')
  vi.resetModules()
  return (await import('../playwright.config')).default
}

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('桌面 E2E 执行预算与诊断', () => {
  it('CI 全局预算在步骤超时前结束，保留单用例原有超时及串行隔离', async () => {
    const config = await loadConfig(true)
    expect(config.globalTimeout).toBe(25 * 60_000)
    expect(config.timeout).toBe(30_000)
    expect(config.workers).toBe(1)
    expect(config.fullyParallel).toBe(false)
  })
  it('始终保留可上传的 JSON 结果，本地不强制全局时间预算', async () => {
    const config = await loadConfig(false)
    expect(config.globalTimeout).toBeUndefined()
    expect(config.reporter).toEqual([
      ['list'], ['json', { outputFile: 'test-results/e2e-report.json' }],
    ])
  })
})
