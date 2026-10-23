#!/usr/bin/env node
// 构建 Pinekin Engine：单文件 ESM + 公共类型声明 + 带 SHA-256 的清单。
// 产物在 dist/engine/，供 NewMax 等宿主按固定版本内置；不发布到任何 registry。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'rolldown'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist', 'engine')
const typesOut = join(out, '.types')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

await build({
  input: join(root, 'src/engine/index.ts'),
  platform: 'node',
  // zod 由宿主提供（同一主版本），Node 内置模块不打包。
  external: [/^node:/, 'zod'],
  output: { file: join(out, 'index.js'), format: 'esm', minify: false },
  logLevel: 'warn',
})

const tsconfig = join(root, 'tsconfig.engine.json')
await writeFile(tsconfig, JSON.stringify({
  extends: './tsconfig.json',
  compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: typesOut, rootDir: 'src', types: ['node'] },
  include: ['src/engine/index.ts'],
}, null, 2))
try {
  execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', tsconfig], { cwd: root, stdio: 'inherit' })
} finally {
  await rm(tsconfig, { force: true })
}
// 公共声明只依赖 engine/ 下的三个文件；其余内部模块的声明不随包分发。
for (const name of ['index.d.ts', 'types.d.ts', 'blocks.d.ts']) await copyFile(join(typesOut, 'engine', name), join(out, name))
await rm(typesOut, { recursive: true, force: true })

const source = await readFile(join(root, 'src/engine/index.ts'), 'utf8')
const engineVersion = /ENGINE_VERSION = '([^']+)'/.exec(source)?.[1]
if (!engineVersion) throw new Error('未找到 ENGINE_VERSION')
const git = args => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() } catch { return '' } }
const files = {}
for (const name of (await readdir(out)).sort()) files[name] = createHash('sha256').update(await readFile(join(out, name))).digest('hex')
const manifest = {
  name: '@newmax-ai/pinekin-engine', engineVersion, transcript: { format: 'pinekin.transcript', version: 1 },
  sourceCommit: git(['rev-parse', 'HEAD']),
  // 工作区有未提交的引擎改动时明确标记，宿主不能把它当作已发布版本。
  sourceDirty: git(['status', '--porcelain', '--', 'src/engine', 'src/main', 'src/core']) !== '',
  peerDependencies: { zod: '^4' }, files,
}
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Pinekin Engine ${engineVersion} → ${out}`)
