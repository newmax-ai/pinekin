import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { readSourceLog } from '../src/main/source-log-reader'
import { workbuddyAssistantBlocksFixture, workbuddyFixture, workbuddyRecord } from './fixtures/workbuddy'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(text: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-workbuddy-blocks-')))
  roots.push(root)
  const path = join(root, 'synthetic-workbuddy.jsonl')
  await writeFile(path, text)
  return { root, path }
}
async function read(records: Record<string, unknown>[]) {
  const { root, path } = await setup(workbuddyFixture(records))
  return readSourceLog(path, root, 'workbuddy', { offset: 0, textOffset: 0 }, () => true)
}
const assistant = (extra: Record<string, unknown> = {}) => workbuddyRecord('a', 'u', 'assistant', '合成助手说明', {
  providerData: { messageId: 'provider-a' }, ...extra,
})
const call = (extra: Record<string, unknown> = {}) => ({
  id: 'a', parentId: 'u', timestamp: 1792368000000, type: 'function_call', callId: 'call-1', name: 'synthetic-tool', arguments: '不执行',
  providerData: { messageId: 'provider-a' }, ...extra,
})

describe('WorkBuddy 同一助手节点的多块记录', () => {
  it('完整合成 37 行日志在目录、搜索和正文一致，保留 7 条文本及 11 对工具计数', async () => {
    const text = workbuddyAssistantBlocksFixture()
    expect(text.trim().split('\n')).toHaveLength(37)
    const { root, path } = await setup(text)
    const data = join(root, 'pinekin'), browser = new SourceBrowser(data)
    const connection = await browser.connect('workbuddy', root)
    await browser.waitForScan(connection.id)
    const page = await browser.page({ source: 'workbuddy', query: '合成 WorkBuddy 会话' })
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({ title: '合成 WorkBuddy 会话', availability: 'unread' })
    const content = await browser.read(page.items[0].id)
    expect(content.session.title).toBe('合成 WorkBuddy 会话')
    expect(content.session.messages).toEqual([
      { role: 'user', content: '合成 WorkBuddy 问题' },
      ...Array.from({ length: 5 }, (_, index) => ({ role: 'assistant', content: `合成助手说明 ${index + 1}` })),
      { role: 'assistant', content: '合成 WorkBuddy 答复' },
    ])
    expect(content.presentation).toMatchObject({ textMessages: 7, toolCalls: 11, toolResults: 11, omittedRecords: 6 })
    expect(content.window).toMatchObject({ totalMessages: 7, hasMore: false })
    expect(await readFile(path, 'utf8')).toBe(text)
    expect(await readdir(data)).toEqual(['connections.json'])
  })
  it('同 ID 的多个工具块仅参与同一个父链节点，不吞掉前面的助手正文', async () => {
    const content = await read([
      workbuddyRecord('u', undefined, 'user', '合成提问'), assistant(), call(), call({ callId: 'call-2' }),
      { id: 'r1', parentId: 'a', timestamp: 1792368000000, type: 'function_call_result', callId: 'call-1' },
      { id: 'r2', parentId: 'r1', timestamp: 1792368000000, type: 'function_call_result', callId: 'call-2' },
      workbuddyRecord('last', 'r2', 'assistant', '合成最终答复'),
    ])
    expect(content.session.messages.map(message => message.content)).toEqual(['合成提问', '合成助手说明', '合成最终答复'])
    expect(content.presentation).toMatchObject({ toolCalls: 2, toolResults: 2 })
  })
  it('同一助手节点的多段文本、推理和工具块保持原顺序，不合并或覆盖文本', async () => {
    const content = await read([
      workbuddyRecord('u', undefined, 'user', '合成提问'), assistant(),
      { id: 'a', parentId: 'u', timestamp: 1792368000000, type: 'reasoning', providerData: { messageId: 'provider-a' }, content: [] },
      call(), assistant({ content: [{ type: 'output_text', text: '合成第二段 <script>不执行</script>' }] }),
      { id: 'r', parentId: 'a', timestamp: 1792368000000, type: 'function_call_result', callId: 'call-1' },
      workbuddyRecord('last', 'r', 'assistant', '合成最终答复'),
    ])
    expect(content.session.messages.map(message => message.content)).toEqual(['合成提问', '合成助手说明', '合成第二段 <script>不执行</script>', '合成最终答复'])
    expect(content.presentation).toMatchObject({ textMessages: 4, toolCalls: 1, toolResults: 1, omittedRecords: 1 })
  })
  it('同 ID 的长文本块各自按 Unicode 分页，续读不丢失后一个块', async () => {
    const long = '汉😀'.repeat(9000)
    const { root, path } = await setup(workbuddyFixture([
      workbuddyRecord('u', undefined, 'user', '合成提问'), assistant({ content: [{ type: 'output_text', text: long }] }),
      call(), assistant({ content: [{ type: 'output_text', text: '合成后续段落' }] }),
    ]))
    const first = await readSourceLog(path, root, 'workbuddy', { offset: 0, textOffset: 0 }, () => true)
    const second = await readSourceLog(path, root, 'workbuddy', first.window.next!, () => true)
    expect(first.window).toMatchObject({ totalMessages: 3, hasMore: true })
    expect(first.session.messages[1].content + second.session.messages[0].content).toBe(long)
    expect(second.session.messages[1].content).toBe('合成后续段落')
    expect(second.window.hasMore).toBe(false)
  })
  it.each(['parent', 'provider-message', 'user', 'result', 'call-replay', 'non-adjacent', 'metadata-id'])('重复 ID 冲突 %s 不静默去重或混合消息', async kind => {
    const records: Record<string, unknown>[] = [workbuddyRecord('u', undefined, 'user', '合成提问'), assistant()]
    if (kind === 'parent') records.push(call({ parentId: 'external' }))
    if (kind === 'provider-message') records.push(call({ providerData: { messageId: 'other-provider-message' } }))
    if (kind === 'user') records.push(workbuddyRecord('a', 'u', 'user', '不应成为同一助手节点'))
    if (kind === 'result') records.push({ id: 'a', parentId: 'u', timestamp: 1792368000000, type: 'function_call_result', callId: 'call-1' })
    if (kind === 'call-replay') records.push(call(), call())
    if (kind === 'non-adjacent') records.push(workbuddyRecord('next', 'a', 'user', '合成下一轮'), call())
    if (kind === 'metadata-id') records.push({ id: 'a', type: 'ai-title', aiTitle: '冲突标题' })
    await expect(read(records)).rejects.toThrow(/重复 ID/)
  })
  it('工具块不能借同 ID 绕过已知压缩与混合会话门禁', async () => {
    await expect(read([
      workbuddyRecord('u', undefined, 'user', '合成提问'), assistant(), call({ providerData: { agent: 'compact' } }),
    ])).rejects.toThrow('压缩')
    await expect(read([
      workbuddyRecord('u', undefined, 'user', '合成提问'), assistant(), call({ sessionId: 'different-session' }),
    ])).rejects.toThrow('混合多个会话 ID')
  })
})
