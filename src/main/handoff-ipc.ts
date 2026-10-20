import type { HandoffService } from './handoff-service'

interface Dependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => Promise<unknown>): void
  assertSender(event: Event): void
  service: Pick<HandoffService, 'prepare' | 'deliver' | 'discard'>
}
export function registerHandoffIpc<Event>({ handle, assertSender, service }: Dependencies<Event>) {
  const actions: Record<string, { count: number; run(args: unknown[], guard: () => void): unknown }> = {
    prepare: { count: 1, run: ([id], guard) => service.prepare(id, guard) },
    deliver: { count: 2, run: ([token, action], guard) => service.deliver(token, action, guard) },
    discard: { count: 1, run: ([token]) => service.discard(token) },
  }
  for (const [name, action] of Object.entries(actions)) handle(`pinekin:handoff-file-${name}`, async (event, ...args) => {
    const guard = () => assertSender(event)
    guard()
    if (args.length !== action.count) throw new Error('无效的文件交接参数。')
    const result = await action.run(args, guard)
    guard()
    return result
  })
}
