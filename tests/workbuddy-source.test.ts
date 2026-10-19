import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { autoConnectSource, sourceCandidates, type SourceLocationContext } from '../src/main/source-discovery'
import type { BrowsableSource } from '../src/core/sources'
import { readSourceLog } from '../src/main/source-log-reader'
import { workbuddyFixture, workbuddyRecord } from './fixtures/workbuddy'

const roots: string[] = [], workbuddy = 'workbuddy' as BrowsableSource, cursor = { offset: 0, textOffset: 0 }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(text = workbuddyFixture()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-workbuddy-'))); roots.push(root)
  const context: SourceLocationContext = { home: join(root, 'home'), appData: join(root, 'appData'), platform: 'darwin', env: {} }
  const projects = join(context.home, '.workbuddy', 'projects'), logs = join(projects, 'synthetic-project')
  await mkdir(logs, { recursive: true })
  const path = join(logs, 'synthetic-workbuddy.jsonl'), meta = path.replace(/\.jsonl$/, '.meta.json')
  await writeFile(path, text)
  return { root, context, projects, logs, path, meta, browser: new SourceBrowser(join(root, 'pinekin')) }
}
async function read(text = workbuddyFixture()) {
  const { logs, path } = await setup(text)
  return readSourceLog(path, logs, 'workbuddy', cursor, () => true)
}

describe('WorkBuddy 独立来源读取', () => {
  it('只定位官方 WorkBuddy 根，不把独立 CodeBuddy 默认目录误作来源', async () => {
    const { context } = await setup()
    expect(sourceCandidates(workbuddy, context)).toEqual([join(context.home, '.workbuddy', 'projects')])
    context.env.WORKBUDDY_CONFIG_DIR = '/synthetic/workbuddy'
    expect(sourceCandidates(workbuddy, context)).toEqual(['/synthetic/workbuddy/projects'])
    context.env.CODEBUDDY_CONFIG_DIR = '/synthetic/independent-codebuddy'
    expect(sourceCandidates(workbuddy, context)).toEqual(['/synthetic/workbuddy/projects'])
    context.env.WORKBUDDY_CONFIG_DIR = 'relative'
    expect(() => sourceCandidates(workbuddy, context)).toThrow('绝对路径')
  })
  it('从 projects 普通主会话提取标题、搜索、分段阅读；只持久化授权，原件不变', async () => {
    const { browser, context, root, path, meta } = await setup()
    await writeFile(meta, JSON.stringify({ isForkedCompactionSession: false }))
    const before = await readFile(path, 'utf8'), beforeMeta = await readFile(meta, 'utf8')
    const result = await autoConnectSource(browser, workbuddy, context)
    expect(result.connections).toHaveLength(1); expect(result.warnings).toEqual([])
    const page = await browser.page({ source: workbuddy, query: '合成 WorkBuddy 会话' })
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({ source: 'workbuddy', sourceSessionId: 'synthetic-workbuddy' })
    const content = await browser.read(page.items[0].id)
    expect(content.session.messages).toEqual([{ role: 'user', content: '合成 WorkBuddy 问题' }, { role: 'assistant', content: '合成 WorkBuddy 答复' }])
    expect(content.session.source).toBe('workbuddy')
    expect(content.window).toMatchObject({ totalMessages: 2, hasMore: false })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await readFile(meta, 'utf8')).toBe(beforeMeta)
    expect(await readdir(join(root, 'pinekin'))).toEqual(['connections.json'])
    const restarted = new SourceBrowser(join(root, 'pinekin'))
    await restarted.restoreConnections(); await restarted.waitForScan(result.connections[0].id)
    expect((await restarted.page({})).total).toBe(1)
    await browser.disconnect(result.connections[0].id)
    await expect(browser.read(page.items[0].id)).rejects.toThrow()
  })
  it('不递归读取 subagents 或工具输出，也不读取其他数据库与凭据', async () => {
    const { browser, context, logs } = await setup()
    await mkdir(join(logs, 'synthetic-workbuddy', 'subagents'), { recursive: true })
    await writeFile(join(logs, 'synthetic-workbuddy', 'subagents', 'agent-one.jsonl'), '不要解析')
    await writeFile(join(logs, 'credentials.json'), '不要解析')
    await autoConnectSource(browser, workbuddy, context)
    expect((await browser.page({})).total).toBe(1)
  })
  it('排除工具、推理、系统与隐藏输入，保留普通文字及不可信标签原文', async () => {
    const text = workbuddyFixture([
      workbuddyRecord('u', undefined, 'user', '<script>不要执行</script>'),
      { id: 'call', parentId: 'u', timestamp: 1792368000000, type: 'function_call', name: 'shell', arguments: '不要执行' },
      { id: 'result', parentId: 'call', timestamp: 1792368000000, type: 'function_call_output', output: '不要显示成提问' },
      { id: 'thought', parentId: 'result', timestamp: 1792368000000, type: 'reasoning', content: [{ type: 'reasoning_text', text: '隐藏推理' }] },
      workbuddyRecord('injected', 'thought', 'user', '内部提示', { providerData: { skipRun: true, isMeta: true } }),
      workbuddyRecord('a', 'injected', 'assistant', '正常回答'),
    ])
    const content = await read(text)
    expect(content.session.messages).toEqual([{ role: 'user', content: '<script>不要执行</script>' }, { role: 'assistant', content: '正常回答' }])
    expect(content.presentation).toMatchObject({ textMessages: 2, toolCalls: 1, toolResults: 1 })
  })
  it('支持无 parentId 的旧式独立追加记录，不把 Claude parentUuid 当成 WorkBuddy 链', async () => {
    const content = await read(workbuddyFixture([
      workbuddyRecord('u', undefined, 'user', '首问'), workbuddyRecord('a', undefined, 'assistant', '答复'),
    ]))
    expect(content.session.messages).toHaveLength(2)
    await expect(read('{"uuid":"x","parentUuid":null,"type":"user","message":{"role":"user","content":"不是WorkBuddy"}}\n')).rejects.toThrow()
  })
  it('自定义标题优先于 ai-title 和 topic，缺失时取真实首问', async () => {
    const content = await read(workbuddyFixture([
      workbuddyRecord('injected', undefined, 'user', '不作为标题', { providerData: { isMeta: true } }),
      workbuddyRecord('u', 'injected', 'user', '真实首问\n下一行'),
      { type: 'topic', id: 'topic', topic: '主题' }, { type: 'ai-title', id: 'ai', aiTitle: '自动标题' },
      { type: 'custom-title', id: 't1', customTitle: '旧标题' }, { type: 'custom-title', id: 't2', customTitle: '新标题' },
    ]))
    expect(content.session.title).toBe('新标题')
    const fallback = await read(workbuddyFixture([workbuddyRecord('u', undefined, 'user', '真实首问\n下一行')]))
    expect(fallback.session.title).toBe('真实首问')
  })
  it.each(['logical-parent', 'fork-meta', 'runtime-id', 'resend', 'content-filter', 'compact'])('目录前置排除已知未支持边界 %s', async kind => {
    const records: Record<string, unknown>[] = [workbuddyRecord('u', undefined, 'user', '问题')]
    if (kind === 'logical-parent') records[0].logicalParentId = 'external'
    if (kind === 'runtime-id') records[0].sessionId = 'different-runtime-id'
    if (kind === 'resend') records.push({ id: 'fork', type: 'resend-fork-notice', parentId: 'u' })
    if (kind === 'content-filter') records[0].providerData = { contentFilterNotice: true }
    if (kind === 'compact') records[0].providerData = { agent: 'compact', isCompactInternal: true }
    const { browser, context, meta } = await setup(workbuddyFixture(records))
    if (kind === 'fork-meta') await writeFile(meta, '{"isForkedCompactionSession":true}')
    await autoConnectSource(browser, workbuddy, context)
    expect((await browser.page({})).total).toBe(0)
    expect((await browser.connections())[0].total).toBe(0)
  })
  it('行内元数据也不能绕过分叉门禁，侧车后续变化会重新判定来源', async () => {
    const { browser, context, meta, path } = await setup()
    const result = await autoConnectSource(browser, workbuddy, context)
    expect((await browser.page({})).total).toBe(1)
    await writeFile(meta, '{"isForkedCompactionSession":true}')
    await browser.check({ mode: 'manual' })
    expect((await browser.page({})).total).toBe(0)
    await rm(meta)
    await writeFile(path, workbuddyFixture([
      workbuddyRecord('u', undefined, 'user', '问题'),
      { id: 'meta', type: 'session-meta', sessionId: 'synthetic-workbuddy', meta: { isForkedCompactionSession: true } },
    ]))
    await browser.refresh(result.connections[0].id); await browser.waitForScan(result.connections[0].id)
    expect((await browser.page({})).total).toBe(0)
  })
  it('长消息按 Unicode 续读，新增或改变侧车也使旧快照失效', async () => {
    const text = '汉😀'.repeat(9000)
    const { logs, path, meta } = await setup(workbuddyFixture([workbuddyRecord('u', undefined, 'user', text)]))
    const first = await readSourceLog(path, logs, 'workbuddy', cursor, () => true)
    const second = await readSourceLog(path, logs, 'workbuddy', first.window.next!, () => true)
    expect(first.session.messages[0].content + second.session.messages[0].content).toBe(text)
    await writeFile(meta, '{"isForkedCompactionSession":false}')
    await expect(readSourceLog(path, logs, 'workbuddy', first.window.next!, () => true)).rejects.toThrow('已变化')
  })
  it.each(['broken-json', 'duplicate', 'missing-parent', 'mixed-role', 'unknown'])('损坏与未知格式 %s 保留错误与重试，不伪装成空列表', async kind => {
    let text = workbuddyFixture()
    if (kind === 'broken-json') text += '{broken\n'
    if (kind === 'duplicate') text = workbuddyFixture([workbuddyRecord('u', undefined, 'user', '问题'), workbuddyRecord('u', 'u', 'assistant', '答复')])
    if (kind === 'missing-parent') text = workbuddyFixture([workbuddyRecord('u', 'external', 'user', '问题')])
    if (kind === 'mixed-role') text = workbuddyFixture([workbuddyRecord('u', undefined, 'alien', '问题')])
    if (kind === 'unknown') text = workbuddyFixture([{ id: 'x', type: 'alien' }])
    const { browser, context } = await setup(text)
    await autoConnectSource(browser, workbuddy, context)
    const page = await browser.page({})
    expect(page.total).toBe(1); expect(page.items[0].availability).toBe('unreadable')
    await expect(browser.read(page.items[0].id)).rejects.toThrow()
  })
  it.each(['link', 'directory', 'invalid', 'large'])('侧车 %s 不越权读取也不忽略失败', async kind => {
    const { browser, context, meta, root } = await setup()
    if (kind === 'link') { const target = join(root, 'outside-meta.json'); await writeFile(target, '{}'); await symlink(target, meta) }
    if (kind === 'directory') await mkdir(meta)
    if (kind === 'invalid') await writeFile(meta, 'not json')
    if (kind === 'large') await writeFile(meta, ' '.repeat(65 * 1024))
    await autoConnectSource(browser, workbuddy, context)
    const page = await browser.page({})
    expect(page.total).toBe(1); expect(page.items[0].availability).toBe('unreadable')
    await expect(browser.read(page.items[0].id)).rejects.toThrow()
  })
})
