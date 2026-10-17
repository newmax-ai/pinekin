import { describe, expect, it } from 'vitest'
import { parseArchive } from '../src/main/imports'
import { cindyLocalFixture, cindyLocalSnapshot } from './fixtures/cindy-local'

describe('Cindy 本地只读快照', () => {
  it('保留桌面时间线传入顺序，解码用户对象且不显示推理与工具状态', async () => {
    const parsed = await parseArchive(cindyLocalFixture())
    expect(parsed).toMatchObject({ adapterId: 'cindy-local-snapshot', originalSessionId: 'synthetic-cindy', sourceVersion: '0.1.97', session: { source: 'cindy', demo: false } })
    expect(parsed.session.messages).toEqual([{ role: 'user', content: '合成用户问题' }, { role: 'assistant', content: '合成助手回答' }])
    expect(parsed.warnings.join('\n')).toMatch(/快照/)
    expect(parsed.warnings.join('\n')).toMatch(/不是.*分享包/)
  })
  it.each([{ source: 'bot' }, { parentSessionId: 'parent' }, { remoteHostId: 'remote' }, { orcaRole: 'worker' }, { status: 'deleted' }])('拒绝来源边界 %j', async change => {
    const snapshot = cindyLocalSnapshot(); Object.assign(snapshot.session, change)
    await expect(parseArchive(Buffer.from(JSON.stringify(snapshot)))).rejects.toThrow()
  })
  it('只显示未清空、未回退消息，原快照仍包含全部已读取记录', async () => {
    const snapshot = cindyLocalSnapshot()
    const extra = { ...snapshot.messages[0], id: 'later', createdAt: snapshot.session.updatedAt + 1, content: '保留的普通文本' }
    Object.assign(snapshot.session, { clearedAt: snapshot.session.createdAt })
    snapshot.messages.push(extra, { ...extra, id: 'rewound', rewindAt: null })
    Object.assign(snapshot.messages.at(-1)!, { rewindAt: extra.createdAt + 1 })
    expect((await parseArchive(Buffer.from(JSON.stringify(snapshot)))).session.messages).toEqual([{ role: 'user', content: '保留的普通文本' }])
  })
  it('附件或未知对象不串入正文、不跟随路径，空或重复记录被拒绝', async () => {
    const snapshot = cindyLocalSnapshot()
    snapshot.messages[0].content = JSON.stringify({ text: '只保留文字', files: [{ path: '/never/read' }] })
    expect((await parseArchive(Buffer.from(JSON.stringify(snapshot)))).warnings.join('\n')).toMatch(/附件/)
    snapshot.messages[0].content = JSON.stringify({ unknown: true })
    expect((await parseArchive(Buffer.from(JSON.stringify(snapshot)))).warnings.join('\n')).toMatch(/未映射/)
    snapshot.messages.push(snapshot.messages[0])
    await expect(parseArchive(Buffer.from(JSON.stringify(snapshot)))).rejects.toThrow()
    snapshot.messages = []
    await expect(parseArchive(Buffer.from(JSON.stringify(snapshot)))).rejects.toThrow()
  })
  it('未知快照或客户端版本不被冒认为已验证', async () => {
    for (const change of [{ version: 2 }, { sourceVersion: '999.0' }]) {
      await expect(parseArchive(Buffer.from(JSON.stringify({ ...cindyLocalSnapshot(), ...change })))).rejects.toThrow()
    }
  })
})
