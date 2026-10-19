import { z } from 'zod'
import { entryIdSchema } from '../core/sources'
import type { SourceBrowser } from './source-browser'
import type { CodexTarget } from './codex-target'
import type { CodexProjectSelection } from './codex-project'
import { codexSetupModeSchema, type CodexTargetSetup } from './codex-target-setup'

const destinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('standalone') }),
  z.strictObject({ kind: z.literal('project'), token: z.uuid() }),
])
interface Dependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => Promise<unknown>): void
  assertSender(event: Event): void
  setup: Pick<CodexTargetSetup, 'inspect' | 'confirm'>
  target: Pick<CodexTarget, 'continue' | 'rollback'>
  source: Pick<SourceBrowser, 'transfer' | 'getEntry' | 'read'>
  projects: Pick<CodexProjectSelection, 'list' | 'choose' | 'resolve'>
}
export function registerCodexTargetIpc<Event>(deps: Dependencies<Event>) {
  deps.handle('pinekin:source-actions-inspect-codex', async (event, rawMode) => {
    deps.assertSender(event)
    const mode = codexSetupModeSchema.parse(rawMode === undefined ? 'automatic' : rawMode)
    const result = await deps.setup.inspect(mode, () => deps.assertSender(event))
    deps.assertSender(event)
    return result
  })
  deps.handle('pinekin:source-actions-configure-codex', async (event, rawToken) => {
    deps.assertSender(event)
    return deps.setup.confirm(z.uuid().parse(rawToken), () => deps.assertSender(event))
  })
  deps.handle('pinekin:source-actions-list-codex-projects', async (event, rawId) => {
    deps.assertSender(event)
    const id = entryIdSchema.parse(rawId)
    await deps.source.getEntry(id)
    deps.assertSender(event)
    const result = await deps.projects.list(id, () => deps.assertSender(event))
    await deps.source.getEntry(id)
    deps.assertSender(event)
    return result
  })
  deps.handle('pinekin:source-actions-choose-codex-project', async (event, rawId, rawProjectId) => {
    deps.assertSender(event)
    const id = entryIdSchema.parse(rawId), projectId = rawProjectId === undefined ? undefined : z.uuid().parse(rawProjectId)
    await deps.source.getEntry(id)
    deps.assertSender(event)
    const result = projectId === undefined ? await deps.projects.choose(id, () => deps.assertSender(event))
      : await deps.projects.choose(id, () => deps.assertSender(event), projectId)
    await deps.source.getEntry(id)
    deps.assertSender(event)
    return result
  })
  deps.handle('pinekin:source-actions-continue-codex', async (event, rawId, rawDestination) => {
    deps.assertSender(event)
    const id = entryIdSchema.parse(rawId), destination = destinationSchema.parse(rawDestination)
    // 没有选择时不默认创建；项目路径只从主进程保存的选择器令牌解析。
    const project = destination.kind === 'project' ? await deps.projects.resolve(id, destination.token) : undefined
    deps.assertSender(event)
    const transfer = await deps.source.transfer(id, () => deps.assertSender(event))
    return deps.target.continue(id, transfer, async () => {
      deps.assertSender(event)
      await deps.source.getEntry(id)
      await deps.source.read(id, { offset: 0, textOffset: 0, snapshot: transfer.snapshot })
      deps.assertSender(event)
    }, project)
  })
  deps.handle('pinekin:source-actions-rollback-transfer', async (event, rawId) => {
    deps.assertSender(event)
    await deps.target.rollback(z.uuid().parse(rawId), () => deps.assertSender(event))
  })
}
