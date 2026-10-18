import { vi } from 'vitest'
import type { SourceBrowserAPI } from '../../src/core/sources'
export function mockSourcesAPI(): SourceBrowserAPI {
  return { connections: vi.fn().mockResolvedValue([]), autoConnect: vi.fn().mockResolvedValue({ connections: [], warnings: [] }), connect: vi.fn().mockResolvedValue(null), refresh: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(),
    page: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, hasMore: false, connections: [] }), read: vi.fn() }
}
