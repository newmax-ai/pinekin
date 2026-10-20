import { z } from 'zod'
import { entryIdSchema } from '../core/sources'
import { continueDestinationSchema } from '../core/source-actions'
import type { SourceBrowser } from './source-browser'
import type { CodexTarget } from './codex-target'
import type { CodexProjectSelection } from './codex-project'
import type { NativeTargetAdapter } from './native-targets'
import { codexSetupModeSchema, type CodexTargetSetup } from './codex-target-setup'

interface Dependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => Promise<unknown>): void
  assertSender(event: Event): void
  setup: Pick<CodexTargetSetup, 'inspect' | 'confirm'>
  target: Pick<CodexTarget, 'continue' | 'rollback'>
  configured?(): Promise<boolean>
  source: Pick<SourceBrowser, 'transfer' | 'getEntry' | 'read'>
  projects: Pick<CodexProjectSelection, 'list' | 'choose' | 'resolve'>
}
export function registerCodexTargetIpc<Event>(deps: Dependencies<Event>): NativeTargetAdapter {
  // 新旧具名 IPC 共用同一原生事务，不能让通用目标绕开项目令牌或来源快照门禁。
  const adapter: NativeTargetAdapter = {
    id: 'codex', configured: () => deps.configured?.() ?? Promise.resolve(false),
    rollback: (receipt, assertAllowed) => deps.target.rollback(z.uuid().parse(receipt), assertAllowed),
    async inspect(rawMode, assertAllowed) {
      assertAllowed()
      const mode = codexSetupModeSchema.parse(rawMode === undefined ? 'automatic' : rawMode)
      const result = await deps.setup.inspect(mode, assertAllowed)
      assertAllowed()
      return result
    },
    async configure(rawToken, assertAllowed) {
      assertAllowed()
      return deps.setup.confirm(z.uuid().parse(rawToken), assertAllowed)
    },
    async listProjects(rawId, assertAllowed) {
      assertAllowed()
      const id = entryIdSchema.parse(rawId)
      await deps.source.getEntry(id)
      assertAllowed()
      const result = await deps.projects.list(id, assertAllowed)
      await deps.source.getEntry(id)
      assertAllowed()
      return result
    },
    async chooseProject(rawId, rawProjectId, assertAllowed) {
      assertAllowed()
      const id = entryIdSchema.parse(rawId), projectId = rawProjectId === undefined ? undefined : z.uuid().parse(rawProjectId)
      await deps.source.getEntry(id)
      assertAllowed()
      const result = projectId === undefined ? await deps.projects.choose(id, assertAllowed) : await deps.projects.choose(id, assertAllowed, projectId)
      await deps.source.getEntry(id)
      assertAllowed()
      return result
    },
    async continue(rawId, rawDestination, assertAllowed) {
      assertAllowed()
      const id = entryIdSchema.parse(rawId), destination = continueDestinationSchema.parse(rawDestination)
      // 没有选择时不默认创建；项目路径只从主进程保存的选择器令牌解析。
      const project = destination.kind === 'project' ? await deps.projects.resolve(id, destination.token) : undefined
      assertAllowed()
      const transfer = await deps.source.transfer(id, assertAllowed)
      return deps.target.continue(id, transfer, async () => {
        assertAllowed()
        await deps.source.getEntry(id)
        await deps.source.read(id, { offset: 0, textOffset: 0, snapshot: transfer.snapshot })
        assertAllowed()
      }, project)
    },
  }
  deps.handle('pinekin:source-actions-inspect-codex', async (event, mode) => adapter.inspect(mode as Parameters<typeof adapter.inspect>[0], () => deps.assertSender(event)))
  deps.handle('pinekin:source-actions-configure-codex', async (event, token) => adapter.configure(token as string, () => deps.assertSender(event)))
  deps.handle('pinekin:source-actions-list-codex-projects', async (event, id) => adapter.listProjects(id as string, () => deps.assertSender(event)))
  deps.handle('pinekin:source-actions-choose-codex-project', async (event, id, projectId) => adapter.chooseProject(id as string, projectId as string | undefined, () => deps.assertSender(event)))
  deps.handle('pinekin:source-actions-continue-codex', async (event, id, destination) => adapter.continue(id as string, destination as Parameters<typeof adapter.continue>[1], () => deps.assertSender(event)))
  deps.handle('pinekin:source-actions-rollback-transfer', async (event, rawId) => {
    deps.assertSender(event)
    await deps.target.rollback(z.uuid().parse(rawId), () => deps.assertSender(event))
  })
  return adapter
}
