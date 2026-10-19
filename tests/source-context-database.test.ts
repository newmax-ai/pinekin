import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceBrowser } from '../src/main/source-browser'
import { createCindySchema } from './fixtures/cindy-database'
import { buildSourceTranscript } from '../src/core/source-transcript'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(source: 'newmax' | 'cindy', text: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinekin-context-db-'))); roots.push(root)
  const path = join(root, 'synthetic.db'), db = new DatabaseSync(path)
  const runtime = '<system-reminder data-role="user-context">合成旧身份，不是用户问题</system-reminder>'
  const messages = [{ role: 'user', content: text }, { role: 'user', content: runtime }, { role: 'assistant', content: '合成答复' }]
  if (source === 'newmax') {
    db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,forked_from_id TEXT,is_private INTEGER,message_count INTEGER);
      CREATE TABLE messages(seq INTEGER,id TEXT,conversation_id TEXT,role TEXT,content TEXT,timestamp INTEGER,data TEXT);`)
    db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run('synthetic', '合成净化会话', 'app', 1000, 2000, null, 0, messages.length)
    for (const [index, message] of messages.entries()) {
      const value = { ...message, id: `m${index}`, timestamp: 1500 }
      db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(index, value.id, 'synthetic', value.role, value.content, 1500, JSON.stringify(value))
    }
  } else {
    createCindySchema(db)
    db.prepare('INSERT INTO sessions(id,title,updated_at) VALUES(?,?,?)').run('synthetic', '合成净化会话', 2000)
    for (const [index, message] of messages.entries()) db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,NULL)').run(`m${index}`, 'synthetic', message.role,
      message.role === 'user' ? JSON.stringify({ text: message.content, files: ['/synthetic/not-read'] }) : message.content, 1500)
  }
  db.close()
  const before = await readFile(path), browser = new SourceBrowser(join(root, 'pinekin'))
  const connection = await browser.connect(source, path); await browser.waitForScan(connection.id)
  const entry = (await browser.page({ source })).items[0]
  return { path, before, browser, entry }
}

describe.each(['newmax', 'cindy'] as const)('%s 数据库到接续的真实合成链路', source => {
  it('默认阅读、复制导出和完整接续使用同一已净化文字，纯提示记录不进入问答', async () => {
    const raw = '<system-reminder data-role="user-context">合成隐藏运行环境</system-reminder>\n真实用户问题'
    const { path, before, browser, entry } = await setup(source, raw)
    const content = await browser.read(entry.id)
    const expected = [{ role: 'user', content: '真实用户问题' }, { role: 'assistant', content: '合成答复' }]
    expect(content.session.messages).toEqual(expected)
    expect((await browser.transfer(entry.id)).messages).toEqual(expected)
    const transcript = buildSourceTranscript(content)
    expect(transcript.text).not.toMatch(/合成隐藏运行环境|合成旧身份/)
    expect(transcript.text).toContain('真实用户问题')
    expect(await readFile(path)).toEqual(before)
  })
  it('大于正文窗口的包装与 Unicode 正文完整续读，保留原始游标和全空白片段', async () => {
    const question = '开始😀' + ' '.repeat(33000) + '结束', prefix = '<system-reminder data-role="user-context">' + '合成环境'.repeat(5000) + '</system-reminder>\n'
    const { path, before, browser, entry } = await setup(source, prefix + question)
    let content = await browser.read(entry.id), combined = '', turns = 0
    for (;;) {
      combined += content.session.messages.filter(message => message.role === 'user').map(message => message.content).join('')
      expect(JSON.stringify(content.session.messages)).not.toContain('合成环境')
      if (!content.window?.next) break
      expect(++turns).toBeLessThan(10)
      content = await browser.read(entry.id, content.window.next)
    }
    expect(combined.replaceAll(' ', '')).toBe('开始😀结束')
    // 阅读视图可略过全空白片段，接续必须从原始位置重新拼回全部空白。
    expect((await browser.transfer(entry.id)).messages).toEqual([{ role: 'user', content: question }, { role: 'assistant', content: '合成答复' }])
    expect(await readFile(path)).toEqual(before)
  })
  it('预算恰好截在第二个上下文起始标签中间时必须阻断，不能将后半标签和内部指令带出', async () => {
    const first = '<system-reminder>' + 'x'.repeat(65495) + '</system-reminder>'
    expect(first.length).toBe(65530)
    const text = first + '<system-reminder>合成内部指令</system-reminder>\n真实问题'
    const { browser, entry } = await setup(source, text)
    await expect(browser.read(entry.id)).rejects.toThrow(/上下文.*预算/)
    await expect(browser.transfer(entry.id)).rejects.toThrow(/上下文.*预算/)
  })
  it('未知及不完整标签、用户代码讨论不因开头形似标签而删除', async () => {
    const text = '```xml\n<system-reminder>这是用户代码示例</system-reminder>\n```\n请解释这段代码'
    const { browser, entry } = await setup(source, text)
    expect((await browser.read(entry.id)).session.messages[0].content).toBe(text)
    expect((await browser.transfer(entry.id)).messages[0].content).toBe(text)
  })
})
