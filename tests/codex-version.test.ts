import { expect, it } from 'vitest'
import { codexVersionSchema, parseCodexVersion } from '../src/core/codex-version'
it.each(['0.163.0', '0.163.0-alpha.10.2', '0.164.0-rc.1+desktop.2'])('保留 Codex 包内实际版本 %s，兼容性仍由历史预演决定', version => {
  expect(parseCodexVersion(`codex-cli ${version}\n`)).toBe(version)
  expect(codexVersionSchema.parse(version)).toBe(version)
})
it.each(['codex-cli dev', 'another-tool 0.163.0', 'codex-cli 0.163.0;touch /tmp/evil', 'codex-cli 0.163.0\nextra', 'codex-cli 0.163.0-alpha/other'])('拒绝无法识别的版本输出并保留具体诊断：%s', output => {
  expect(() => parseCodexVersion(output)).toThrow('版本输出')
})
