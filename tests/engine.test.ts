import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { defaultLocations, engineSources, listSessions, PinekinUnsupportedError, readTranscript, workingDirectoryWithin, type SessionRef } from '../src/engine'
import { codexFixture, codexMessage, codexMeta, codexRecord } from './fixtures/codex'
import { qwenFixture, qwenRecord } from './fixtures/qwen'
import { workbuddyAssistantBlocksFixture, workbuddyFixture, workbuddyRecord } from './fixtures/workbuddy'
import { ENGINE_LIMITS, TranscriptBuilder } from '../src/engine/blocks'

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
    expect(list.map(item => item.source)).toEqual(['codex', 'qwen-code', 'workbuddy', 'deepseek'])
    expect(list.every(item => item.structured)).toBe(true)
    // WorkBuddy 会话没有可信工作目录，只能作为全局来源；其余来源按工作目录归属工作区。
    expect(list.map(item => [item.source, item.scope, item.workingDirectory])).toEqual([
      ['codex', 'workspace', true], ['qwen-code', 'workspace', true], ['workbuddy', 'global', false], ['deepseek', 'workspace', true],
    ])
    list[0].verifiedPlatforms.push('win32')
    expect(engineSources()[0].verifiedPlatforms).not.toContain('win32')
  })
  it('默认位置与 Pinekin App 一致，环境变量不是绝对路径时不猜测', () => {
    const context = { home: join(tmpdir(), 'synthetic', 'home'), env: {} }
    const qwen = join(tmpdir(), 'synthetic', 'qwen'), workbuddy = join(tmpdir(), 'synthetic', 'wb')
    expect(defaultLocations('codex', context)).toEqual([join(context.home, '.codex', 'sessions'), join(context.home, '.codex', 'archived_sessions')])
    expect(defaultLocations('qwen-code', { ...context, env: { QWEN_HOME: qwen } })).toEqual([join(qwen, 'projects')])
    expect(defaultLocations('workbuddy', context)).toEqual([join(context.home, '.workbuddy', 'projects')])
    expect(defaultLocations('workbuddy', { ...context, env: { WORKBUDDY_CONFIG_DIR: workbuddy, CODEBUDDY_CONFIG_DIR: join(tmpdir(), 'synthetic', 'cb') } })).toEqual([join(workbuddy, 'projects')])
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
    expect(items.map(item => basename(item.path))).toEqual(['rollout-b.jsonl', 'rollout-a.jsonl', 'rollout-c.jsonl', 'rollout-d.jsonl'])
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

describe('Pinekin Engine：WorkBuddy', () => {
  async function setup(files: Record<string, string>, sidecars: Record<string, string> = {}) {
    const home = await temp()
    const projects = join(home, '.workbuddy', 'projects')
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(projects, name)), { recursive: true })
      await writeFile(join(projects, name), text)
    }
    for (const [name, text] of Object.entries(sidecars)) await writeFile(join(projects, name), text)
    return { projects, roots: defaultLocations('workbuddy', { home, env: {} }) }
  }
  const session = (id = 'synthetic-workbuddy') => workbuddyFixture([
    { ...workbuddyRecord('u', undefined, 'user', '请整理合成周报'), sessionId: id },
    { id: 't0', parentId: 'u', timestamp: 1792368001000, type: 'reasoning', content: [], sessionId: id },
    { ...workbuddyRecord('a', 't0', 'assistant', '我先读取合成文件', { providerData: { messageId: 'p1' } }), timestamp: 1792368002000, sessionId: id },
    { id: 'a', parentId: 't0', timestamp: 1792368003000, type: 'function_call', providerData: { messageId: 'p1' }, callId: 'c1', name: 'read_file', arguments: '{"path":"a.md"}', sessionId: id },
    { id: 'r1', parentId: 'a', timestamp: 1792368004000, type: 'function_call_result', callId: 'c1', result: '合成文件内容', sessionId: id },
    { ...workbuddyRecord('b', 'r1', 'assistant', '周报已整理'), timestamp: 1792368005000, sessionId: id },
    { type: 'custom-title', timestamp: 1792368006000, customTitle: '合成周报会话', sessionId: id },
  ])

  it('只列出项目目录下的主会话：无工作目录、跳过云缓存/子目录/根级文件，侧车分叉标记提前拒绝', async () => {
    const { projects, roots } = await setup({
      'Users-synthetic-WorkBuddy-task-1/synthetic-workbuddy.jsonl': session(),
      'Users-synthetic-WorkBuddy-task-1/subagents/child.jsonl': session('child'),
      'Users-synthetic-WorkBuddy-task-1/notes.txt': '不是日志',
      'Users-synthetic-WorkBuddy-task-2/forked.jsonl': session('forked'),
      'cloud/user-1/cloud.jsonl': session('cloud'),
      'stray.jsonl': session('stray'),
    }, { 'Users-synthetic-WorkBuddy-task-2/forked.meta.json': JSON.stringify({ forkedFrom: 'other', ignored: '不读取的字段' }) })
    const items = await collect(listSessions('workbuddy', { roots }))
    expect(items.map(item => relative(projects, item.path))).toEqual([
      join('Users-synthetic-WorkBuddy-task-1', 'synthetic-workbuddy.jsonl'), join('Users-synthetic-WorkBuddy-task-2', 'forked.jsonl'),
    ])
    expect(items[0]).toMatchObject({ source: 'workbuddy', sessionId: 'synthetic-workbuddy', kind: 'conversation', compressed: false })
    expect(items[0].workingDirectory).toBeUndefined()
    expect(items[0].unsupportedReason).toBeUndefined()
    expect(items[1].unsupportedReason).toContain('分叉')
    await expect(readTranscript(items[1])).rejects.toBeInstanceOf(PinekinUnsupportedError)
  })

  it('侧车变化会改变修订号，日志未变也会重新同步', async () => {
    const { projects, roots } = await setup({ 'task/s.jsonl': session('s') })
    const [before] = await collect(listSessions('workbuddy', { roots }))
    await writeFile(join(projects, 'task', 's.meta.json'), '{}')
    const [after] = await collect(listSessions('workbuddy', { roots }))
    expect(after.revision).not.toBe(before.revision)
  })

  it('输出文本、工具调用和结果；推理与辅助记录不进入，标题优先自定义标题', async () => {
    const { roots } = await setup({ 'task/synthetic-workbuddy.jsonl': session() })
    const [ref] = await collect(listSessions('workbuddy', { roots }))
    const transcript = await readTranscript(ref)
    expect(transcript).toMatchObject({ format: 'pinekin.transcript', source: 'workbuddy', sessionId: 'synthetic-workbuddy', title: '合成周报会话' })
    expect(transcript.workingDirectory).toBeUndefined()
    expect(transcript.messages.map(message => [message.id, message.role])).toEqual([['u0', 'user'], ['a0', 'assistant']])
    expect(transcript.messages[0].blocks).toEqual([{ type: 'text', text: '请整理合成周报' }])
    expect(transcript.messages[1].blocks).toEqual([
      { type: 'text', text: '我先读取合成文件' },
      { type: 'tool_call', id: 'c1', name: 'read_file', input: '{"path":"a.md"}' },
      { type: 'tool_result', callId: 'c1', output: '合成文件内容' },
      { type: 'text', text: '周报已整理' },
    ])
    expect(transcript.createdAt).toBe(new Date(1792368000000).toISOString())
    // 更新时间取最后一个正文节点，标题等辅助记录不算。
    expect(transcript.updatedAt).toBe(new Date(1792368005000).toISOString())
  })

  it('同一助手节点拆成文本与多个工具块的完整日志可读，工具结果成对', async () => {
    const { roots } = await setup({ 'task/synthetic-workbuddy.jsonl': workbuddyAssistantBlocksFixture() })
    const [ref] = await collect(listSessions('workbuddy', { roots }))
    const transcript = await readTranscript(ref)
    expect(transcript.title).toBe('合成 WorkBuddy 会话')
    const blocks = transcript.messages.flatMap(message => message.blocks)
    expect(blocks.filter(block => block.type === 'tool_call')).toHaveLength(11)
    expect(blocks.filter(block => block.type === 'tool_result')).toHaveLength(11)
    expect(blocks.filter(block => block.type === 'text').map(block => block.text)).toEqual([
      '合成 WorkBuddy 问题', ...Array.from({ length: 5 }, (_, index) => `合成助手说明 ${index + 1}`), '合成 WorkBuddy 答复',
    ])
  })

  it('运行时注入不冒充用户，用户前置上下文只保留真实请求', async () => {
    const context = '<system-reminder data-role="user-context">\n运行时身份\n</system-reminder>\n<user_query>\n真实合成请求\n</user_query>'
    const { roots } = await setup({ 'task/synthetic-workbuddy.jsonl': workbuddyFixture([
      workbuddyRecord('u0', undefined, 'user', context),
      workbuddyRecord('u1', 'u0', 'user', '内部注入', { providerData: { isMeta: true } }),
      workbuddyRecord('a', 'u1', 'assistant', '合成答复'),
    ]) })
    const [ref] = await collect(listSessions('workbuddy', { roots }))
    const transcript = await readTranscript(ref)
    expect(transcript.messages[0].blocks).toEqual([{ type: 'text', text: '真实合成请求' }])
    expect(JSON.stringify(transcript)).not.toContain('内部注入')
    expect(JSON.stringify(transcript)).not.toContain('运行时身份')
  })

  it('压缩、逻辑父链和多分支明确拒绝为不支持，结构损坏保留普通错误供重试', async () => {
    const own = (id: string) => ({ sessionId: id })
    const compact = workbuddyFixture([workbuddyRecord('u', undefined, 'user', '问题', own('compact')), workbuddyRecord('a', 'u', 'assistant', '答复', { logicalParentId: 'x', ...own('compact') })])
    const branch = workbuddyFixture([workbuddyRecord('u', undefined, 'user', '问题', own('branch')), workbuddyRecord('a', 'u', 'assistant', '答复一', own('branch')), workbuddyRecord('b', 'u', 'assistant', '答复二', own('branch'))])
    const broken = '{"id":"u","type":"message"\n'
    const { roots } = await setup({ 'task/compact.jsonl': compact, 'task/branch.jsonl': branch, 'task/broken.jsonl': broken })
    const byName = Object.fromEntries((await collect(listSessions('workbuddy', { roots }))).map(item => [item.sessionId, item]))
    await expect(readTranscript(byName.compact)).rejects.toThrow(PinekinUnsupportedError)
    await expect(readTranscript(byName.compact)).rejects.toThrow('逻辑父链')
    await expect(readTranscript(byName.branch)).rejects.toThrow('父链')
    const error = await readTranscript(byName.broken).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PinekinUnsupportedError)
  })

  it('文件名与运行时会话 ID 不同视为子会话，不支持', async () => {
    const { roots } = await setup({ 'task/other-name.jsonl': session('synthetic-workbuddy') })
    const [ref] = await collect(listSessions('workbuddy', { roots }))
    await expect(readTranscript(ref)).rejects.toBeInstanceOf(PinekinUnsupportedError)
  })

  it('只有辅助记录或没有真实用户消息的日志不伪造会话；取消信号立即生效', async () => {
    const { roots } = await setup({ 'task/only-title.jsonl': workbuddyFixture([{ type: 'custom-title', timestamp: 1792368000000, customTitle: '空会话' }]) })
    const [ref] = await collect(listSessions('workbuddy', { roots }))
    await expect(readTranscript(ref)).rejects.toBeInstanceOf(PinekinUnsupportedError)
    const live = await setup({ 'task/synthetic-workbuddy.jsonl': session() })
    const [good] = await collect(listSessions('workbuddy', { roots: live.roots }))
    const controller = new AbortController(); controller.abort()
    await expect(readTranscript(good, { signal: controller.signal })).rejects.toThrow('取消')
  })

  it('目录不存在返回空列表；符号链接的项目目录不进入', async () => {
    const home = await temp()
    expect(await collect(listSessions('workbuddy', { roots: defaultLocations('workbuddy', { home, env: {} }) }))).toEqual([])
    const outside = await temp()
    await writeFile(join(outside, 'leak.jsonl'), session('leak'))
    const projects = join(home, '.workbuddy', 'projects')
    await mkdir(projects, { recursive: true })
    await symlink(outside, join(projects, 'linked'))
    expect(await collect(listSessions('workbuddy', { roots: [projects] }))).toEqual([])
  })
})

describe('Pinekin Engine：体量上限', () => {
  const at = '2026-10-16T00:00:00.000Z'
  it('消息条数超限属于同一份日志的确定结果，抛出不支持而不是普通错误', () => {
    const builder = new TranscriptBuilder()
    const fill = () => { for (let index = 0; index <= ENGINE_LIMITS.messages; index++) builder.user(at, [{ type: 'text', text: 'x' }]) }
    expect(fill).toThrow(PinekinUnsupportedError)
  })

  it('累计字符超出内存预算同样抛出不支持，且不返回局部结果', () => {
    const builder = new TranscriptBuilder()
    const text = 'x'.repeat(ENGINE_LIMITS.textChars)
    const fill = () => { for (let index = 0; index <= ENGINE_LIMITS.totalChars / ENGINE_LIMITS.textChars; index++) builder.assistant(at, { type: 'text', text }) }
    expect(fill).toThrow(PinekinUnsupportedError)
    expect(fill).toThrow(/内存预算/)
  })
})
