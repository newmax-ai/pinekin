import { afterEach, expect, it, vi } from 'vitest'
import { registerCodexTargetIpc } from '../src/main/codex-target-ipc'
import { HandoffService } from '../src/main/handoff-service'
import { registerHandoffIpc } from '../src/main/handoff-ipc'
import type { PreparedHandoff } from '../src/core/handoff'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { DatabaseSync } from 'node:sqlite'
import { codexMeta, codexMessage, codexFixture } from './fixtures/codex'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('从来源重新读取全部 101 条与完整长消息，阅读过哪个片段不影响接续，原件不变', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-transfer-source-'))); roots.push(root)
  const text = '开始🙂' + ' '.repeat(33_000) + '结束'
  const messages = Array.from({ length: 101 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'assistant' | 'user', content: i ? `消息${i}` : text }))
  const bytes = codexFixture([codexMeta(), ...messages.map(m => codexMessage(m.role, [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content }]))])
  const path = join(root, 'synthetic.jsonl'); await writeFile(path, bytes)
  const browser = new SourceBrowser(join(root, 'pinekin'))
  const connection = await browser.connect('codex', root); await browser.waitForScan(connection.id)
  const entry = (await browser.page({})).items[0]
  const first = await browser.read(entry.id)
  await browser.read(entry.id, first.window!.next)
  const transfer = await browser.transfer(entry.id)
  expect(transfer.messages).toEqual(messages)
  expect(transfer.warnings).toEqual(expect.arrayContaining(first.warnings))
  const copyFile = vi.fn()
  const service = new HandoffService({ getEntry: id => browser.getEntry(id),
    transfer: (id, guard) => browser.transfer(id, guard), copyFile, save: async () => false })
  const handlers = new Map<string, (event: object, ...args: unknown[]) => Promise<unknown>>()
  registerHandoffIpc({ handle: (name, handler) => { handlers.set(name, handler) }, assertSender: () => {}, service })
  const prepared = await handlers.get('pinekin:handoff-file-prepare')!({}, entry.id) as PreparedHandoff
  await handlers.get('pinekin:handoff-file-deliver')!({}, prepared.token, 'copy-file')
  expect(copyFile).toHaveBeenCalledOnce()
  expect(copyFile.mock.calls[0][0]).toContain('101 条消息')
  expect(copyFile.mock.calls[0][0]).toContain(JSON.stringify(text))
  expect(copyFile.mock.calls[0][0]).toContain('消息100')
  expect(copyFile.mock.calls[0][0]).not.toContain('目标：')
  expect(await readFile(path)).toEqual(bytes)
  await browser.disconnect(connection.id)
  await expect(browser.transfer(entry.id)).rejects.toThrow()
  await expect(service.deliver(prepared.token, 'copy-file')).rejects.toThrow()
  expect(copyFile).toHaveBeenCalledOnce()
})
it.runIf(process.platform === 'darwin')('NewMax 数据库长消息中间的全空白片段不丢失，内部续轮不混入，来源不写入', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-transfer-db-'))); roots.push(root)
  const path = join(root, 'newmax.db'), db = new DatabaseSync(path)
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,forked_from_id TEXT,is_private INTEGER,message_count INTEGER);
    CREATE TABLE messages(seq INTEGER,id TEXT,conversation_id TEXT,role TEXT,content TEXT,timestamp INTEGER,data TEXT);`)
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run('one', '合成接续', 'app', 1000, 2000, null, 0, 3)
  const text = '开始🙂' + ' '.repeat(33_000) + '结束'
  const messages = [{ role: 'user', content: text }, { role: 'user', content: '内部任务'.repeat(5000), taskContinuationTurn: true }, { role: 'assistant', content: '正常回答' }]
  messages.forEach((message, index) => {
    const value = { ...message, id: `m${index}`, timestamp: 2000 }
    db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(index, value.id, 'one', value.role, value.content, 2000, JSON.stringify(value))
  })
  db.close()
  const before = await readFile(path), browser = new SourceBrowser(join(root, 'pinekin'))
  const connection = await browser.connect('newmax', path); await browser.waitForScan(connection.id)
  const entry = (await browser.page({})).items[0]
  expect((await browser.transfer(entry.id)).messages).toEqual([{ role: 'user', content: text }, { role: 'assistant', content: '正常回答' }])
  expect(await readFile(path)).toEqual(before)
})
it.runIf(process.platform === 'darwin').each([false, true])('真实来源读取链路：分页及提交复核期间其他会话持续写入；所选正文变化=%s', async chosenChanges => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-transfer-live-db-'))); roots.push(root)
  const path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
  const browser = new SourceBrowser(join(root, 'pinekin'))
  let connection: { id: string } | undefined
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,forked_from_id TEXT,is_private INTEGER,message_count INTEGER);
      CREATE TABLE messages(seq INTEGER,id TEXT,conversation_id TEXT,role TEXT,content TEXT,timestamp INTEGER,data TEXT);`)
    const text = '开始🙂' + ' '.repeat(33_000) + '结束'
    for (const id of ['chosen', 'other']) {
      db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run(id, id, 'app', 1000, 2000, null, 0, 1)
      const message = { id: `${id}-m`, role: 'user', content: text, timestamp: 2000 }
      db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(0, message.id, id, message.role, text, 2000, JSON.stringify(message))
    }
    connection = await browser.connect('newmax', path); await browser.waitForScan(connection.id)
    const entry = (await browser.page({})).items.find(item => item.title === 'chosen')!
    const read = browser.read.bind(browser)
    const reader = vi.spyOn(browser, 'read').mockImplementation(async (...args) => {
      const result = await read(...args)
      // 每页的普通读取与接续原文投影之间发生无关提交，不能靠碰巧没有写入才通过。
      db.exec("UPDATE conversations SET updated_at=updated_at+1 WHERE id='other'")
      return result
    })
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    let committed = false
    registerCodexTargetIpc({
      handle: (channel, handler) => { handlers.set(channel, handler) }, assertSender: () => {}, source: browser,
      setup: { inspect: vi.fn(), confirm: vi.fn() }, projects: { list: vi.fn(), choose: vi.fn(), resolve: vi.fn() },
      target: { rollback: vi.fn(), continue: async (_id, transfer, guard) => {
        expect(transfer.messages).toEqual([{ role: 'user', content: text }])
        if (chosenChanges) {
          const changed = text.slice(0, -2) + '变化'
          db.prepare("UPDATE messages SET content=?,data=json_set(data,'$.content',?) WHERE id='chosen-m'").run(changed, changed)
        }
        // 对应目标事务的开始、预演后、发布前及发布后的四次校验。
        for (let phase = 0; phase < 4; phase++) await guard!()
        committed = true
        return { status: 'created', receipt: 'synthetic', threadId: 'synthetic', app: 'Codex', messageCount: 1, opened: false }
      } },
    })
    const request = handlers.get('pinekin:source-actions-continue-codex')!({}, entry.id, { kind: 'standalone' })
    if (chosenChanges) await expect(request).rejects.toThrow('来源正文已变化')
    else await expect(request).resolves.toMatchObject({ status: 'created', messageCount: 1 })
    expect(committed).toBe(!chosenChanges)
    expect(reader.mock.calls.length).toBeGreaterThanOrEqual(4)
  } finally {
    if (connection) await browser.disconnect(connection.id)
    db.close()
  }
})
