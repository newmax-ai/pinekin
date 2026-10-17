// 显式授权的开发入口；不注册后台扫描，不加载或执行来源目录中的代码。
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const { values } = parseArgs({ options: {
  source: { type: 'string' }, input: { type: 'string' }, destination: { type: 'string' },
  'source-version': { type: 'string' }, limit: { type: 'string', default: '10' }, confirm: { type: 'boolean', default: false },
} })
if (!values.source || !values.input || !values.destination) {
  console.error('用法：npm run import:local -- --source newmax|claude-code|codex --input <明确授权的文件或日志目录> --destination <Pinekin档案目录> [--source-version 1.1.22] [--limit 1..20] [--confirm]')
  process.exitCode = 1
} else {
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
    appType: 'custom', server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true } })
  try {
    const { importLocal } = await server.ssrLoadModule('/src/main/local-import.ts')
    const report = await importLocal({ source: values.source, input: values.input, destination: values.destination,
      sourceVersion: values['source-version'], limit: Number(values.limit), confirm: values.confirm })
    console.log(JSON.stringify(report, null, 2))
    if (!values.confirm) console.log('仅预演，没有保存会话。核对统计后，显式加 --confirm 才会写入 Pinekin；不会修改来源。')
  } catch (error) {
    console.error('本地批次未完成；未覆盖已有档案。请检查授权路径、版本、格式与档案完整性。')
    // 只输出安全错误类别，不回显私人源路径、正文或底层 JSON 错误片段。
    console.error(error instanceof Error ? error.name : 'UnknownError')
    process.exitCode = 1
  } finally { await server.close() }
}
