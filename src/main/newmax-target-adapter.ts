import { entryIdSchema } from '../core/sources'
import { continueDestinationSchema } from '../core/source-actions'
import type { NativeTargetAdapter } from './native-targets'
import type { SourceBrowser } from './source-browser'
import type { NewMaxTarget } from './newmax-target'

export function createNewMaxTargetAdapter({ source, target }: {
  source: Pick<SourceBrowser, 'getEntry' | 'read' | 'transfer'>
  target: Pick<NewMaxTarget, 'configured' | 'inspect' | 'configure' | 'listProjects' | 'chooseProject' | 'continue' | 'rollback'>
}): NativeTargetAdapter {
  const checkSource = async (id: string, guard: () => void) => { guard(); await source.getEntry(id); guard() }
  return {
    id: 'newmax', destinationKind: 'workspace',
    configured: () => target.configured(),
    inspect: (mode, guard) => target.inspect(mode, guard),
    configure: (token, guard) => target.configure(token, guard),
    async listProjects(rawId, guard) {
      const id = entryIdSchema.parse(rawId); await checkSource(id, guard)
      const result = await target.listProjects(id, guard); await checkSource(id, guard)
      return result
    },
    async chooseProject(rawId, projectId, guard) {
      const id = entryIdSchema.parse(rawId); await checkSource(id, guard)
      const result = await target.chooseProject(id, projectId, guard); await checkSource(id, guard)
      return result
    },
    async continue(rawId, rawDestination, guard) {
      guard(); const id = entryIdSchema.parse(rawId), destination = continueDestinationSchema.parse(rawDestination)
      const transfer = await source.transfer(id, guard)
      return target.continue(id, transfer, async () => {
        await checkSource(id, guard)
        await source.read(id, { offset: 0, textOffset: 0, snapshot: transfer.snapshot }); guard()
      }, destination.kind === 'project' ? destination.token : undefined, guard)
    },
    async rollback(receipt, guard) { await target.rollback(receipt, guard) },
  }
}
