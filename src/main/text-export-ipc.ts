import { sourceTextSchema } from '../core/source-transcript'
import { saveMarkdownFile } from './save-markdown'

export function registerTextExportIpc<Event>(deps: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => Promise<boolean>): void
  assertSender(event: Event): void
  choose(): Promise<string | null>
}) {
  let choosing = false
  deps.handle('pinekin:source-actions-export-text', async (event, ...args) => {
    deps.assertSender(event)
    if (args.length !== 1) throw new Error('文本导出参数数量无效。')
    const text = sourceTextSchema.parse(args[0])
    if (choosing) throw new Error('已有文本导出正在处理，请稍候。')
    choosing = true
    try {
      return await saveMarkdownFile(text, deps.choose, async () => { deps.assertSender(event) })
    } finally { choosing = false }
  })
}
