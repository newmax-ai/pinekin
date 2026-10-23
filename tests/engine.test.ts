import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { defaultLocations, engineSources, listSessions, PinekinUnsupportedError, readTranscript, workingDirectoryWithin, type SessionRef } from '../src/engine'
import { codexFixture, codexMessage, codexMeta, codexRecord } from './fixtures/codex'
import { qwenFixture, qwenRecord } from './fixtures/qwen'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function temp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-engine-'))); roots.push(root)
  return root
}
async function collect(iterable: AsyncIterable<SessionRef>) {
  const items: SessionRef[] = []
  for await (const item of iterable) items.push(item)
  return items.sort((a, b) => a.path.localeCompare(b.path))
}

const structuredCodex = () => codexFixture([
  codexMeta(),
  codexMessage('developer', [{ type: 'input_text', text: '开发者指令不进入记录' }]),
  codexMessage('user', [{ type: 'input_text', text: '<environment_context>\n<cwd>/synthetic/project</cwd>\n</environment_context>' }]),
  codexMessage('user', [{ type: 'input_text', text: '帮我修复合成测试' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]),
  codexRecord('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: '先看测试' }], encrypted_content: 'synthetic' }, '2026-10-16T00:00:01.000Z'),
  codexRecord('response_item', { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"npm test"}' }, '2026-10-16T00:00:02.000Z'),
  codexRecord('response_item', { type: 'function_call_output', call_id: 'call-1', output: '1 failed' }, '2026-10-16T00:00:03.000Z'),
  codexRecord('response_item', { type: 'custom_tool_call', call_id: 'call-2', name: 'apply_patch', input: '*** Begin Patch' }),
  codexRecord('response_item', { type: 'custom_tool_call_output', call_id: 'call-2', output: { content: 'patch rejected', success: false } }),
  codexRecord('event_msg', { type: 'agent_message', message: '事件副本不重复导入' }),
  codexMessage('assistant', [{ type: 'output_text', text: '已修复。' }], { id: 'answer-1', phase: 'final_answer' }),
  codexRecord('compacted', { message: '压缩摘要' }),
  codexMessage('user', [{ type: 'input_text', text: '再跑一次' }], {}),
  codexMessage('assistant', [{ type: 'output_text', text: '通过了。' }], { id: 'answer-2' }),
])

describe('Pinekin Engine 能力清单与位置', () => {
  it('只声明已结构化验证的来源，返回副本不可被调用方篡改', () => {
    const list = engineSources()
    expect(list.map(item => item.source)).toEqual(['codex', 'qwen-code'])
    expect(list.every(item => item.structured && item.workingDirectory)).toBe(true)
    list[0].verifiedPlatforms.push('win32')
    expect(engineSources()[0].verifiedPlatforms).not.toContain('win32')
  })
  it('默认位置与 Pinekin App 一致，环境变量不是绝对路径时不猜测', () => {
    const context = { home: '/synthetic/home', env: {} }
    expect(defaultLocations('codex', context)).toEqual(['/synthetic/home/.codex/sessions', '/synthetic/home/.codex/archived_sessions'])
    expect(defaultLocations('qwen-code', { ...context, env: { QWEN_HOME: '/synthetic/qwen' } })).toEqual(['/synthetic/qwen/projects'])
    expect(defaultLocations('codex', { ...context, env: { CODEX_HOME: 'relative' } })).toEqual([])
    expect(() => defaultLocations('cindy' as never)).toThrow('不支持的来源')
  })
  it('工作目录归属按路径边界判断，不把同名前缀当成子目录', () => {
    expect(workingDirectoryWithin('/repo/app', '/repo/app', 'linux')).toBe(true)
    expect(workingDirectoryWithin('/repo/app/packages/a', '/repo/app', 'linux')).toBe(true)
    expect(workingDirectoryWithin('/repo/app-old', '/repo/app', 'linux')).toBe(false)
    expect(workingDirectoryWithin('/repo', '/repo/app', 'linux')).toBe(false)
    expect(workingDirectoryWithin('/Repo/App', '/repo/app', 'darwin')).toBe(true)
    expect(workingDirectoryWithin('/Repo/App', '/repo/app', 'linux')).toBe(false)
    expect(workingDirectoryWithin('C:\\Repo\\App\\src', 'c:\\repo\\app', 'win32')).toBe(true)
  })
})

describe('Pinekin Engine：Codex', () => {
  async function setup() {
    const home = join(await temp(), '.codex')
    const day = join(home, 'sessions', '2026', '10', '16')
    await mkdir(day, { recursive: true }); await mkdir(join(home, 'archived_sessions'), { recursive: true })
    return { home, day, roots: defaultLocations('codex', { home: join(home, '..'), env: {} }) }
  }

  it('列出会话只读首行：带工作目录、子会话标记、不支持原因，跳过符号链接与非 rollout 文件', async () => {
    const { home, day, roots } = await setup()
    await writeFile(join(day, 'rollout-a.jsonl'), structuredCodex())
    await writeFile(join(home, 'archived_sessions', 'rollout-b.jsonl'), codexFixture([codexMeta({ id: '0199e6ba-0000-7000-8000-000000000002', session_id: undefined, parent_thread_id: '0199e6ba-0000-7000-8000-000000000001' }), codexMessage()]))
    await writeFile(join(day, 'rollout-c.jsonl'), codexFixture([codexMeta({ id: '0199e6ba-0000-7000-8000-000000000003', session_id: undefined, forked_from_id: '0199e6ba-0000-7000-8000-000000000001' })]))
    await writeFile(join(day, 'rollout-d.jsonl'), '{"not":"meta"}\n')
    await writeFile(join(day, 'history.jsonl'), structuredCodex())
    await symlink(join(day, 'rollout-a.jsonl'), join(day, 'rollout-link.jsonl'))
    const items = await collect(listSessions('codex', { roots }))
    expect(items.map(item => item.path.split('/').pop())).toEqual(['rollout-b.jsonl', 'rollout-a.jsonl', 'rollout-c.jsonl', 'rollout-d.jsonl'])
    const [subagent, main, forked, broken] = items
    expect(main).toMatchObject({ source: 'codex', sessionId: '0199e6ba-0000-7000-8000-000000000001', workingDirectory: '/synthetic/project', kind: 'conversation', compressed: false })
    expect(main.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(main.unsupportedReason).toBeUndefined()
    expect(subagent.kind).toBe('subagent')
    expect(forked.unsupportedReason).toContain('跨文件继承')
    expect(broken.unsupportedReason).toContain('session_meta')
    await expect(readTranscript(forked)).rejects.toBeInstanceOf(PinekinUnsupportedError)
  })

  it('输出结构化记录：思考、工具调用与结果并入助手回合，剥离注入上下文与开发者消息', async () => {
    const { day, roots } = await setup()
    await writeFile(join(day, 'rollout-a.jsonl'), structuredCodex())
    const [ref] = await collect(listSessions('codex', { roots }))
    const transcript = await readTranscript(ref)
    expect(transcript).toMatchObject({ format: 'pinekin.transcript', version: 1, source: 'codex', kind: 'conversation',
      title: '帮我修复合成测试', workingDirectory: '/synthetic/project', sourceVersion: '0.0.0-synthetic', revision: ref.revision })
    expect(transcript.messages.map(message => `${message.id}:${message.role}`)).toEqual(['u0:user', 'a0:assistant', 'u1:user', 'a1:assistant'])
    expect(transcript.messages[0].blocks).toEqual([{ type: 'text', text: '帮我修复合成测试' }, { type: 'attachment', kind: 'image', note: '图片附件未随记录迁移' }])
    expect(transcript.messages[1].blocks).toEqual([
      { type: 'thinking', text: '先看测试' },
      { type: 'tool_call', id: 'call-1', name: 'exec_command', input: '{"cmd":"npm test"}' },
      { type: 'tool_result', callId: 'call-1', output: '1 failed' },
      { type: 'tool_call', id: 'call-2', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'tool_result', callId: 'call-2', output: 'patch rejected', isError: true },
      { type: 'text', text: '已修复。' },
    ])
    expect(transcript.messages[1].timestamp).toBe('2026-10-16T00:00:03.000Z')
    expect(JSON.stringify(transcript)).not.toContain('开发者指令')
    expect(JSON.stringify(transcript)).not.toContain('事件副本')
    expect(transcript.warnings.join('')).toContain('压缩')
  })

  it('读取 Zstandard 压缩日志，并在列表阶段只解压首行', async () => {
    const { day, roots } = await setup()
    await writeFile(join(day, 'rollout-z.jsonl.zst'), zstdCompressSync(structuredCodex()))
    const [ref] = await collect(listSessions('codex', { roots }))
    expect(ref).toMatchObject({ compressed: true, workingDirectory: '/synthetic/project' })
    expect((await readTranscript(ref)).messages).toHaveLength(4)
  })

  it('超长工具输出截断并标记，不丢弃整条会话', async () => {
    const { day, roots } = await setup()
    await writeFile(join(day, 'rollout-a.jsonl'), codexFixture([codexMeta(), codexMessage(),
      codexRecord('response_item', { type: 'function_call_output', call_id: 'x', output: 'y'.repeat(70_000) })]))
    const [ref] = await collect(listSessions('codex', { roots }))
    const result = (await readTranscript(ref)).messages[1].blocks[0]
    expect(result).toMatchObject({ type: 'tool_result', truncated: true })
    expect(result.type === 'tool_result' && result.output.length).toBe(64_000)
  })

  it('没有真实用户消息的日志不伪造会话；取消信号立即生效', async () => {
    const { day, roots } = await setup()
    await writeFile(join(day, 'rollout-a.jsonl'), codexFixture([codexMeta(), codexMessage('assistant', [{ type: 'output_text', text: '只有答复' }])]))
    const [ref] = await collect(listSessions('codex', { roots }))
    await expect(readTranscript(ref)).rejects.toBeInstanceOf(PinekinUnsupportedError)
    const controller = new AbortController(); controller.abort()
    await expect(readTranscript(ref, { signal: controller.signal })).rejects.toThrow()
    await expect(collect(listSessions('codex', { roots, signal: controller.signal }))).rejects.toThrow('取消')
  })

  it('来源目录不存在时返回空列表，相对路径直接拒绝', async () => {
    expect(await collect(listSessions('codex', { roots: [join(await temp(), 'missing')] }))).toEqual([])
    await expect(collect(listSessions('codex', { roots: ['relative'] }))).rejects.toThrow('绝对路径')
  })
})

describe('Pinekin Engine：Qwen Code', () => {
  async function setup(text: string) {
    const home = await temp()
    const chats = join(home, '.qwen', 'projects', '-synthetic-project', 'chats')
    await mkdir(chats, { recursive: true })
    await mkdir(join(home, '.qwen', 'projects', '-synthetic-project', 'tool-output'), { recursive: true })
    await writeFile(join(home, '.qwen', 'projects', '-synthetic-project', 'tool-output', 'out.jsonl'), text)
    await writeFile(join(chats, 'synthetic-qwen.jsonl'), text)
    return defaultLocations('qwen-code', { home, env: {} })
  }

  it('只列出 chats 下的会话，输出思考、工具调用和结果，跳过非真实用户输入', async () => {
    const roots = await setup(qwenFixture([
      qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '请检查合成项目' }] }),
      qwenRecord('a', 'u', 'assistant', { role: 'model', parts: [{ text: '先想想', thought: true }, { functionCall: { id: 'c1', name: 'read_file', args: { path: 'a.ts' } } }] }),
      qwenRecord('r', 'a', 'tool_result', { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'read_file', response: { output: '文件内容' } } }] }),
      qwenRecord('n', 'r', 'user', { role: 'user', parts: [{ text: '定时任务注入' }] }, { provenance: 'cron' }),
      qwenRecord('b', 'n', 'assistant', { role: 'model', parts: [{ text: '合成答复' }] }),
      qwenRecord('title', 'b', 'system', undefined, { subtype: 'custom_title', systemPayload: { customTitle: '合成千问会话' } }),
    ]))
    const items = await collect(listSessions('qwen-code', { roots }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ sessionId: 'synthetic-qwen', workingDirectory: '/synthetic/project', kind: 'conversation' })
    const transcript = await readTranscript(items[0])
    expect(transcript.title).toBe('合成千问会话')
    expect(transcript.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(transcript.messages[1].blocks).toEqual([
      { type: 'thinking', text: '先想想' },
      { type: 'tool_call', id: 'c1', name: 'read_file', input: '{"path":"a.ts"}' },
      { type: 'tool_result', callId: 'c1', output: '文件内容' },
      { type: 'text', text: '合成答复' },
    ])
    expect(JSON.stringify(transcript)).not.toContain('定时任务注入')
  })

  it('多分支与压缩会话明确拒绝，不混合旁支', async () => {
    const roots = await setup(qwenFixture([
      qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '问题' }] }),
      qwenRecord('a', 'u', 'assistant', { role: 'model', parts: [{ text: '答复一' }] }),
      qwenRecord('b', 'u', 'assistant', { role: 'model', parts: [{ text: '答复二' }] }),
    ]))
    const [ref] = await collect(listSessions('qwen-code', { roots }))
    await expect(readTranscript(ref)).rejects.toThrow('多分支')
    const compressed = await setup(qwenFixture([
      qwenRecord('u', null, 'user', { role: 'user', parts: [{ text: '问题' }] }),
      qwenRecord('c', 'u', 'system', undefined, { subtype: 'chat_compression' }),
    ]))
    const [other] = await collect(listSessions('qwen-code', { roots: compressed }))
    await expect(readTranscript(other)).rejects.toBeInstanceOf(PinekinUnsupportedError)
  })
})
