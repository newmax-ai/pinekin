import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { defaultLocations, engineSources, listSessions, PinekinUnsupportedError, readTranscript, type SessionRef } from '../src/engine'
import { deepseekFixture, deepseekRecords } from './fixtures/deepseek'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function setup(records = deepseekRecords(), name = 'session.jsonl') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-deepseek-')))
  dirs.push(root)
  const path = join(root, name)
  const text = deepseekFixture(records)
  await writeFile(path, name.endsWith('.jsonl') ? text : zstdCompressSync(text))
  return { root, path }
}
async function collect(root: string, signal?: AbortSignal) {
  const refs: SessionRef[] = []
  for await (const ref of listSessions('deepseek', { roots: [root], signal })) refs.push(ref)
  return refs.sort((a, b) => a.path.localeCompare(b.path))
}

describe('Pinekin Engine：DeepSeek Harness', () => {
  it('声明独立的 Harness 来源，默认与 DSH_HOME 位置复用 App 规则', () => {
    expect(engineSources()).toContainEqual({ source: 'deepseek', name: 'DeepSeek Harness', discover: true, structured: true,
      workingDirectory: true, scope: 'workspace', verifiedPlatforms: ['darwin'] })
    const context = { home: '/synthetic/home', env: {} }
    expect(defaultLocations('deepseek', context)).toEqual(['/synthetic/home/.dsh/sessions'])
    expect(defaultLocations('deepseek', { ...context, env: { DSH_HOME: '~/custom-dsh' } })).toEqual(['/synthetic/home/custom-dsh/sessions'])
    expect(defaultLocations('deepseek', { ...context, env: { DSH_HOME: 'relative' } })).toEqual([])
  })

  it('列表保留头部 ID、修订号、绝对 cwd，只读日志且不访问附件或链接', async () => {
    const { root, path } = await setup()
    await writeFile(join(root, 'ignore.txt'), '不是会话')
    await symlink(path, join(root, 'link.jsonl'))
    await mkdir(join(root, 'subagents'))
    await writeFile(join(root, 'subagents', 'child.jsonl'), deepseekFixture())
    const refs = await collect(root)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ source: 'deepseek', sessionId: 'session-synthetic', workingDirectory: '/synthetic', kind: 'conversation', compressed: false })
    expect(refs[0].revision).toMatch(/^[a-f0-9]{64}$/)
  })

  it('输出完整问答文本和自定义标题，净化注入，不重复流式副本或把工具内容冒充答复', async () => {
    const { root } = await setup()
    const [ref] = await collect(root)
    const result = await readTranscript(ref)
    expect(result).toMatchObject({ format: 'pinekin.transcript', version: 1, source: 'deepseek', sessionId: 'session-synthetic',
      title: 'DeepSeek 合成会话', sourceVersion: 'session-v4', workingDirectory: '/synthetic', revision: ref.revision,
      createdAt: new Date(1_790_000_000_000).toISOString(), updatedAt: new Date(1_790_000_001_000).toISOString() })
    expect(result.messages).toEqual([
      { id: 'u0', role: 'user', timestamp: new Date(1_790_000_000_000).toISOString(), blocks: [{ type: 'text', text: '合成问题：整理项目计划' }] },
      { id: 'a0', role: 'assistant', timestamp: new Date(1_790_000_001_000).toISOString(), blocks: [{ type: 'text', text: '合成答复：先确认目标。' }] },
    ])
    expect(result.warnings.join('')).toContain('仅导入问答文本')
    expect(JSON.stringify(result.messages)).not.toMatch(/运行时注入|推理|不得执行|流式副本|工具结果/)
  })

  it.each(['permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced', 'turn/start', 'step/start', 'step/end', 'turn/end',
    'request/header', 'request/context', 'session/title-llm-request', 'tool/call', 'web/deepseek-search-llm-request', 'job/registered', 'job/settled', 'session/end-seed', 'system/message', 'developer/message'])('普通 %s 事件不伪造问答，也不能阻断独立会话文本导入', async type => {
    const original = deepseekRecords()
    const surface = type === 'system/message' || type === 'developer/message'
    const metadata = { type, time: 1_790_000_000_000, data: { ...(type === 'session/end-seed' ? {} : { ignored: '不应导入的辅助内容' }) }, ...(surface ? { surfaceOp: 'append' } : {}) }
    const records = [original[0], ...[metadata, ...original.slice(1)].map((row, seq) => ({ ...row, seq }))]
    const { root } = await setup(records)
    const [ref] = await collect(root)
    const result = await readTranscript(ref)
    expect(result.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(result.messages)).not.toContain('辅助内容')
  })

  it.each([
    { type: 'system/message', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, data: {} },
    { type: 'tool/result', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, data: {} },
    { type: 'developer/message', data: {} },
    { type: 'permission/preset', surfaceOp: 'append', data: {} },
    { type: 'request/header', sourceEventSeqs: [1], data: {} },
    { type: 'session/end-seed', data: { inherited: true } },
    { type: 'session/end-seed', data: { inherited: 'unknown' } },
  ])('被省略的事件也校验表面替换和继承边界：%j', async metadata => {
    const original = deepseekRecords()
    const records = [original[0], ...[metadata, ...original.slice(1)].map((row, seq) => ({ ...row, seq, time: 1_790_000_000_000 }))]
    const { root } = await setup(records)
    const [ref] = await collect(root)
    await expect(readTranscript(ref)).rejects.toBeInstanceOf(PinekinUnsupportedError)
  })

  it.each(['jsonl.zst', 'jsonl.zstd'])('流式读取 %s 压缩日志', async extension => {
    const { root } = await setup(deepseekRecords(), `session.${extension}`)
    const [ref] = await collect(root)
    expect(ref.compressed).toBe(true)
    expect((await readTranscript(ref)).messages).toHaveLength(2)
  })

  it.each([undefined, '', 'relative/path'])('没有可信 cwd（%s）时也保留全局可导入会话，不猜目录名', async cwd => {
    const records = deepseekRecords(); records[0] = { ...records[0], cwd }
    const { root } = await setup(records)
    const [ref] = await collect(root)
    expect(ref.workingDirectory).toBeUndefined()
    expect((await readTranscript(ref)).workingDirectory).toBeUndefined()
  })

  it.each([{ version: 5 }, { isSeeded: true }, { delegationDepth: 1 }])('已知不支持的头部 %j 提前标记且拒绝读取', async patch => {
    const records = deepseekRecords(); records[0] = { ...records[0], ...patch }
    const { root } = await setup(records)
    const [ref] = await collect(root)
    expect(ref.unsupportedReason).toContain('v4 独立主会话')
    await expect(readTranscript(ref)).rejects.toBeInstanceOf(PinekinUnsupportedError)
  })

  it.each(['sequence', 'duplicate', 'role', 'replace', 'text', 'unknown-event'])('拒绝 %s，不返回局部文本', async fault => {
    const records = deepseekRecords()
    if (fault === 'sequence') records[2] = { ...records[2], seq: 99 }
    if (fault === 'duplicate') records[4] = { ...records[4], data: { message: { id: 'u1', role: 'assistant', content: [{ type: 'text', text: '重复' }] } } }
    if (fault === 'role') records[4] = { ...records[4], data: { message: { id: 'a1', role: 'user', content: [{ type: 'text', text: '错误角色' }] } } }
    if (fault === 'replace') records[4] = { ...records[4], surfaceOp: 'replace' }
    if (fault === 'text') records[4] = { ...records[4], data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text' }] } } }
    if (fault === 'unknown-event') records[5] = { ...records[5], type: 'session/rollback' }
    const { root } = await setup(records)
    const [ref] = await collect(root)
    await expect(readTranscript(ref)).rejects.toThrow()
  })

  it('列表不能把无法解码的首行永久记为不支持，读取仍抛普通错误以便下次重试', async () => {
    const { root, path } = await setup(deepseekRecords(), 'session.jsonl.zst')
    await writeFile(path, Buffer.from('损坏压缩流'))
    const [ref] = await collect(root)
    expect(ref.unsupportedReason).toBeUndefined()
    let error: unknown
    try { await readTranscript(ref) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PinekinUnsupportedError)
  })

  it('没有标题时取首条真实用户文本，长文本不使用 App 分页预览截断', async () => {
    const records = deepseekRecords().slice(0, 2)
    const text = '合成正文'.repeat(6_000)
    records[1] = { ...records[1], data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }
    const { root } = await setup(records)
    const [ref] = await collect(root)
    const result = await readTranscript(ref)
    expect(result.title).toContain('合成正文')
    expect(result.messages[0].blocks).toEqual([{ type: 'text', text }])
    await expect(readTranscript({ ...ref, sessionId: 'wrong-session' })).rejects.toThrow('身份')
  })

  it('损坏压缩流不是空会话，读取失败可重试', async () => {
    const { root, path } = await setup(deepseekRecords(), 'session.jsonl.zst')
    const [ref] = await collect(root)
    await writeFile(path, Buffer.from('损坏压缩流'))
    await expect(readTranscript(ref)).rejects.toThrow()
  })

  it('全为注入或空问答时不伪造可导入对话；空目录、取消和越界读取保持失败关闭', async () => {
    const records = deepseekRecords().slice(0, 2)
    records[1] = { ...records[1], data: { id: 'u1', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '注入' }] } }
    const { root } = await setup(records)
    const [ref] = await collect(root)
    await expect(readTranscript(ref)).rejects.toBeInstanceOf(PinekinUnsupportedError)
    await expect(readTranscript({ ...ref, root: join(root, 'other') })).rejects.toThrow()
    expect(await collect(join(root, 'missing'))).toEqual([])
    const controller = new AbortController(); controller.abort()
    await expect(collect(root, controller.signal)).rejects.toThrow('取消')
    await expect(readTranscript(ref, { signal: controller.signal })).rejects.toThrow()
  })
})
