import type { NativeTargets } from './native-targets'

interface Dependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => Promise<unknown>): void
  assertSender(event: Event): void
  targets: Pick<NativeTargets, 'inspect' | 'configure' | 'listProjects' | 'chooseProject' | 'continue' | 'rollback'>
}
/** 参数由注册表严格验证；只暴露具名动作，不能传任意路径、URL、命令或历史载荷。 */
export function registerNativeTargetIpc<Event>({ handle, assertSender, targets }: Dependencies<Event>) {
  const guarded = (action: (args: unknown[], guard: () => void) => Promise<unknown>) => async (event: Event, ...args: unknown[]) => {
    const guard = () => assertSender(event)
    guard()
    const result = await action(args, guard)
    guard()
    return result
  }
  handle('pinekin:source-actions-inspect-target', guarded(([target, mode], guard) => targets.inspect(target, mode, guard)))
  handle('pinekin:source-actions-configure-target', guarded(([target, token], guard) => targets.configure(target, token, guard)))
  handle('pinekin:source-actions-list-target-projects', guarded(([target, id], guard) => targets.listProjects(id, target, guard)))
  handle('pinekin:source-actions-choose-target-project', guarded(([target, id, projectId], guard) => targets.chooseProject(id, target, projectId, guard)))
  handle('pinekin:source-actions-continue-target', guarded(([id, target, destination], guard) => targets.continue(id, target, destination, guard)))
  handle('pinekin:source-actions-rollback-target', guarded(([target, receipt], guard) => targets.rollback(target, receipt, guard)))
}
