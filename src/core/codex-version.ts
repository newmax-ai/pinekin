import { z } from 'zod'

// 桌面正式发行包也可能内置带 alpha/rc 标签的 CLI；是否兼容仍以隔离回读验证为准。
export const codexVersionSchema = z.string().max(128).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
export function parseCodexVersion(output: string): string {
  const match = /^codex-cli (\S+)\s*$/.exec(output)
  const result = codexVersionSchema.safeParse(match?.[1])
  if (!result.success) throw new Error(`无法识别 Codex 版本输出：${JSON.stringify(output.slice(0, 160))}`)
  return result.data
}
