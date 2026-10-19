// 手动验收已运行的主 dev；不启动浏览器、不连接或修改外部客户端数据。
// 用法：node verification/workbuddy-live.mjs <回环 CDP 地址> <来源会话 ID> [截图路径]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [endpoint, sessionId, screenshot, expectedQuestion] = process.argv.slice(2)
assert(endpoint && sessionId, '必须提供现有主 dev 的回环 CDP 地址和来源会话 ID')
const url = new URL(endpoint)
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '仅允许连接本机主 dev')
const targets = await fetch(new URL('/json/list', url)).then(response => response.json())
const pages = targets.filter(target => target.type === 'page' && /^http:\/\/localhost:5173\//.test(target.url))
assert.equal(pages.length, 1, '必须只有一个匹配的主 dev 页面')
const socket = new WebSocket(pages[0].webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let sequence = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (!message.id || !pending.has(message.id)) return
  const { resolve, reject, timeout } = pending.get(message.id)
  clearTimeout(timeout); pending.delete(message.id)
  if (message.error) reject(new Error(message.error.message))
  else resolve(message.result)
})
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description)
  return result.result.value
}
async function waitFor(expression, description) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await evaluate(expression)
    if (value) return value
    await delay(125)
  }
  throw new Error(`等待失败：${description}`)
}
try {
  await waitFor('!!window.staithe?.sources && !!document.querySelector(".source-list-heading")', '主 dev 就绪')
  const entry = await evaluate(`(async () => {
    const page = await window.staithe.sources.page({ source: 'workbuddy', limit: 50 });
    const entry = page.items.find(item => item.sourceSessionId === ${JSON.stringify(sessionId)});
    if (!entry) throw new Error('已授权 WorkBuddy 列表中找不到指定会话');
    return { id: entry.id, title: entry.title, availability: entry.availability };
  })()`)
  assert(!entry.title.endsWith('.jsonl'), '目录标题仍是文件名')
  assert.notEqual(entry.availability, 'unreadable', '目录仍报告不可读')
  const exportModule = '/@fs' + process.cwd().replaceAll('\\', '/') + '/src/core/source-transcript.ts'
  const projection = await evaluate(`(async () => {
    const content = await window.staithe.sources.read(${JSON.stringify(entry.id)});
    const user = content.session.messages.find(message => message.role === 'user')?.content ?? '';
    const { buildSourceTranscript } = await import(${JSON.stringify(exportModule)});
    const text = buildSourceTranscript(content).text;
    const injected = value => /<(?:system-reminder|identify_context|user_info|session_metadata|user_query)\\b/.test(value);
    return { userText: user, userLength: Array.from(user).length, readingContainsRuntime: injected(user), exportContainsRuntime: injected(text) };
  })()`)
  assert(projection.userText, '净化后没有真实用户问题')
  assert.equal(projection.readingContainsRuntime, false, '主进程仍返回运行时提示包装')
  assert.equal(projection.exportContainsRuntime, false, '复制导出仍包含运行时提示包装')
  if (expectedQuestion) assert.equal(projection.userText, expectedQuestion, '实际用户问题被误删或改写')
  await evaluate(`(() => {
    const toggle = document.querySelector('button[aria-label="展开侧栏"]');
    toggle?.click();
    const source = [...document.querySelectorAll('.nav-item')].find(button => button.textContent.includes('WorkBuddy'));
    if (!source) throw new Error('WorkBuddy 导航不存在');
    source.click();
  })()`)
  await waitFor(`document.querySelector('.source-list-heading h2')?.textContent === 'WorkBuddy' && [...document.querySelectorAll('.session-card h3')].some(node => node.textContent === ${JSON.stringify(entry.title)})`, 'WorkBuddy 列表标题')
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.session-card')].find(button => button.querySelector('h3')?.textContent === ${JSON.stringify(entry.title)});
    if (!card) throw new Error('指定会话卡片不存在');
    card.click();
  })()`)
  await waitFor(`document.querySelector('.detail-title-group h2')?.textContent === ${JSON.stringify(entry.title)} && document.querySelectorAll('.messages article.message').length === 7`, '标题和七条正文')
  const reading = await evaluate(`({
    titleMatches: document.querySelector('.detail-title-group h2')?.textContent === ${JSON.stringify(entry.title)},
    messages: document.querySelectorAll('.messages article.message').length,
    assistants: document.querySelectorAll('.messages article.message.assistant').length,
    finalAnswerPresent: !!document.querySelector('.messages article.message:last-of-type .message-body')?.textContent.trim(),
    endMarkerPresent: !!document.querySelector('.conversation-end'),
    counts: document.querySelector('.detail-meta')?.textContent,
    readError: [...document.querySelectorAll('.detail .empty-state, .detail [role="alert"]')].some(node => /无法读取|重复 ID|读取失败/.test(node.textContent)),
    unsafeElements: document.querySelectorAll('.messages script, .messages iframe').length
  })`)
  assert.equal(reading.readError, false)
  assert.equal(reading.assistants, 6)
  assert.equal(reading.finalAnswerPresent, true)
  assert.equal(reading.endMarkerPresent, true)
  assert.equal(reading.unsafeElements, 0)
  assert.match(reading.counts, /7 条来源消息/)
  assert.match(reading.counts, /22 项工具活动/)
  await evaluate(`document.querySelector('button[aria-label="搜索"]').click()`)
  await waitFor('!!document.querySelector(\'input[aria-label="搜索会话"]\')', '搜索输入框')
  await evaluate(`document.querySelector('input[aria-label="搜索会话"]').focus()`)
  await send('Input.insertText', { text: entry.title })
  await waitFor(`[...document.querySelectorAll('.search-result')].some(node => node.textContent.includes(${JSON.stringify(entry.title)}))`, '真实标题搜索结果')
  await evaluate(`(() => {
    const result = [...document.querySelectorAll('.search-result')].find(node => node.textContent.includes(${JSON.stringify(entry.title)}));
    result.click();
  })()`)
  await waitFor(`!document.querySelector('input[aria-label="搜索会话"]') && document.querySelectorAll('.messages article.message').length === 7`, '从搜索结果重新打开正文')
  await evaluate(`(() => { const viewport = document.querySelector('.messages'); viewport.scrollTop = 0; })()`)
  await delay(200)
  if (screenshot) {
    const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await mkdir(dirname(screenshot), { recursive: true })
    await writeFile(screenshot, Buffer.from(image.data, 'base64'), { mode: 0o600 })
  }
  console.log(JSON.stringify({ passed: true, ...projection, ...reading, titleSearchPassed: true, reopenedFromSearch: true, screenshot: screenshot ?? null }, null, 2))
} finally {
  // 仅断开调试 WebSocket，不发送 Browser.close，不关闭用户窗口。
  for (const { timeout } of pending.values()) clearTimeout(timeout)
  socket.close()
}
