import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_BYTES } from '../src/core/session'
import { SourceBrowser } from '../src/main/source-browser'
import { readSourceDatabase } from '../src/main/source-sqlite'
import { createCindySchema } from './fixtures/cindy-database'

type Source = 'newmax' | 'cindy'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(source: Source) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-window-'))); roots.push(root)
  const path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
  if (source === 'cindy') createCindySchema(db)
  else db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,forked_from_id TEXT,is_private INTEGER,message_count INTEGER);
    CREATE TABLE messages(seq INTEGER,id TEXT,conversation_id TEXT,role TEXT,content TEXT,timestamp INTEGER,data TEXT);
    CREATE TABLE credentials(secret TEXT); INSERT INTO credentials VALUES('NEVER_PROJECT_CREDENTIALS');`)
  return { root, path, db, browser: new SourceBrowser(join(root, 'data')) }
}
function seed(db: DatabaseSync, source: Source, id: string, count = 1, content = '合成预算文本') {
  db.exec('BEGIN')
  if (source === 'newmax') {
    db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run(id, id, 'app', 1000, 2000, null, 0, count)
    const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)')
    for (let seq = 0; seq < count; seq++) {
      const message = { id: `${id}-${seq}`, role: 'user', content, timestamp: 1500 }
      insert.run(seq, message.id, id, message.role, content, message.timestamp, JSON.stringify(message))
    }
  } else {
    db.prepare('INSERT INTO sessions(id,title,updated_at) VALUES(?,?,?)').run(id, id, 2000)
    const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,NULL)')
    for (let seq = 0; seq < count; seq++) insert.run(`${id}-${seq}`, id, 'user', content, 1500)
  }
  db.exec('COMMIT')
}
async function connect(browser: SourceBrowser, source: Source, path: string) {
  const connection = await browser.connect(source, path); await browser.waitForScan(connection.id)
  return browser.page({})
}

describe.each(['newmax', 'cindy'] as const)('%s 大会话按窗口读取而不是过滤', source => {
  it('超过 5 MiB 或 10000 条仍出现在列表、搜索与计数中，点击不消失', async () => {
    const { path, db, browser } = await setup(source)
    seed(db, source, 'normal')
    seed(db, source, 'too-many', 10_001)
    seed(db, source, 'too-large', 1, 'X'.repeat(MAX_BYTES + 1))
    db.close()
    const before = await readFile(path)
    const projection = await readSourceDatabase(path, source)
    expect(JSON.stringify(projection)).not.toMatch(/合成预算文本|NEVER_PROJECT|XXXX/)
    const page = await connect(browser, source, path)
    expect(page.total).toBe(3)
    for (const item of (await browser.page({ query: 'too-' })).items) {
      const content = await browser.read(item.id)
      expect(content.session.messages.length).toBeGreaterThan(0)
      expect(content.session.messages.length).toBeLessThanOrEqual(100)
      expect(content.window?.hasMore).toBe(true)
      expect(JSON.stringify(content).length).toBeLessThan(200_000)
      expect((await browser.page({})).total).toBe(3)
      expect((await browser.check({ mode: 'manual', selectedId: item.id })).selected?.availability).toBe('readable')
      if (item.sourceSessionId === 'too-many') {
        expect(content.window?.totalMessages).toBe(10_001)
        const last = await browser.read(item.id, { offset: 10_000, textOffset: 0, snapshot: content.window!.snapshot })
        expect(last.session.messages).toHaveLength(1)
        expect(last.window?.hasMore).toBe(false)
      }
    }
    expect((await readFile(path)).equals(before)).toBe(true)
  })
  it('长消息逐段保留完整 Unicode，续读不重复、不漏尾部及后续消息', async () => {
    const { path, db, browser } = await setup(source)
    const text = '😀中文'.repeat(12_000) + '\n末尾唯一标记'
    seed(db, source, 'long', 2, text)
    db.close()
    const item = (await connect(browser, source, path)).items[0]
    let content = await browser.read(item.id), combined = '', turns = 0
    for (;;) {
      combined += content.session.messages.map(message => message.content).join('')
      expect(content.session.messages.every(message => Array.from(message.content).length <= 16_384)).toBe(true)
      if (!content.window?.next) break
      expect(++turns).toBeLessThan(10)
      content = await browser.read(item.id, content.window.next)
    }
    expect(combined).toBe(text + text)
    expect((await browser.page({})).total).toBe(1)
  })
  it('先提取用户展示文本再切片，不显示隐藏提示词、附件或对 JSON 文本二次解码', async () => {
    const { path, db, browser } = await setup(source)
    seed(db, source, 'display')
    const text = JSON.stringify({ text: '保持这段 JSON 原文' }) + '😀'.repeat(20_000)
    if (source === 'newmax') {
      db.prepare('UPDATE messages SET content=?,data=?').run('HIDDEN_PROMPT'.repeat(30_000), JSON.stringify({ id: 'display-0', role: 'user', content: 'HIDDEN_PROMPT'.repeat(30_000), timestamp: 1500, displayContent: text }))
    } else db.prepare('UPDATE messages SET content=?').run(JSON.stringify({ text, attachments: ['HIDDEN_ATTACHMENT'] }))
    db.close()
    const item = (await connect(browser, source, path)).items[0]
    const first = await browser.read(item.id), last = await browser.read(item.id, first.window!.next)
    expect(first.session.messages[0].content + last.session.messages[0].content).toBe(text)
    expect(JSON.stringify(first) + JSON.stringify(last)).not.toMatch(/HIDDEN_PROMPT|HIDDEN_ATTACHMENT/)
  })
  it('正文含 NUL 时不得把其后的文本静默丢弃，会话仍保留重试', async () => {
    const { path, db, browser } = await setup(source)
    seed(db, source, 'nul', 1, '前面\u0000后面的文本'); db.close()
    const item = (await connect(browser, source, path)).items[0]
    await expect(browser.read(item.id)).rejects.toThrow(/空字符/)
    expect((await browser.page({})).total).toBe(1)
  })
  it('正文改变而目录元数据不变时拒绝混合旧窗口，但会话仍可重读', async () => {
    const { path, db, browser } = await setup(source)
    try {
      seed(db, source, 'changing', 101)
      const item = (await connect(browser, source, path)).items[0]
      const initial = await browser.read(item.id)
      if (source === 'newmax') db.exec("UPDATE messages SET content='更新',data=json_set(data,'$.content','更新')")
      else db.exec("UPDATE messages SET content='更新'")
      await expect(browser.read(item.id, initial.window!.next)).rejects.toThrow(/变化|更新/)
      expect((await browser.page({})).total).toBe(1)
      expect((await browser.read(item.id)).session.messages[0].content).toBe('更新')
    } finally { db.close() }
  })
})

it('Cindy 仍只投影当前普通问答，不读取清空前、回退、工具及其他会话', async () => {
  const { path, db, browser } = await setup('cindy')
  seed(db, 'cindy', 'current')
  seed(db, 'cindy', 'unsupported', 1, 'X'.repeat(MAX_BYTES + 1))
  db.exec("UPDATE sessions SET cleared_at=1200 WHERE id='current'; UPDATE sessions SET source='bot' WHERE id='unsupported'")
  const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)')
  const huge = 'X'.repeat(MAX_BYTES + 1)
  insert.run('old', 'current', 'user', huge, 1000, null)
  insert.run('rewound', 'current', 'assistant', huge, 1500, 1600)
  insert.run('tool', 'current', 'tool_result', huge, 1500, null)
  db.close()
  const page = await connect(browser, 'cindy', path)
  expect(page).toMatchObject({ total: 1, items: [{ sourceSessionId: 'current' }] })
  expect((await browser.read(page.items[0].id)).session.messages).toEqual([{ role: 'user', content: '合成预算文本' }])
})

it('分页参数经过验证，不允许 SQL 字符串、负数、超范围和无快照续读', async () => {
  const { path, db, browser } = await setup('newmax')
  seed(db, 'newmax', 'one'); db.close()
  const item = (await connect(browser, 'newmax', path)).items[0]
  for (const cursor of [{ offset: -1 }, { offset: '0;DROP TABLE messages' }, { textOffset: Number.MAX_VALUE }, { offset: 1 }, { unexpected: true }]) {
    await expect(browser.read(item.id, cursor as never)).rejects.toThrow()
  }
  expect((await browser.read(item.id)).session.messages).toHaveLength(1)
})
