import { Worker } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { ModuleKind, transpileModule } from 'typescript'
import { describe, expect, it } from 'vitest'
import { sourceMessageParts, sourcePromptTitle } from '../src/core/source-presentation'

// Worker 载入真实生产模块及其共用依赖，不能把带 import 的函数 toString 后孤立执行。
const compile = (file: string) => transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText

describe('来源文字包装的边界', () => {
  it('预算内的大量空行和不完整任务包装不会阻塞解析线程', async () => {
    const content = 'Task: x' + '\n'.repeat(180_000) + 'not a browser task'
    const result = await new Promise<unknown>((resolve, reject) => {
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
        const context={}; new Function('exports',workerData.context)(context);
        const presentation={}; new Function('exports','require',workerData.presentation)(presentation,()=>context);
        parentPort.postMessage(presentation.sourceMessageParts(workerData.content,'claude-code','user'));`,
      { eval: true, workerData: { content, context: compile('../src/core/source-user-content.ts'), presentation: compile('../src/core/source-presentation.ts') } })
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('包装识别超过两秒，可能发生正则回溯阻塞')) }, 2000)
      worker.once('message', value => { clearTimeout(timer); resolve(value) })
      worker.once('error', error => { clearTimeout(timer); reject(error) })
    })
    expect(result).toEqual({ primary: content, context: '' })
  })
  it('多行任务保留正文但标题只取有效首行，不吞掉普通未完成的包装', () => {
    const text = 'Task: 检查按钮\n也检查键盘\n\nCurrent URL: https://example.test/page\n\nPage snapshot:\n合成页面'
    expect(sourceMessageParts(text, 'claude-code', 'user')).toEqual({ primary: '检查按钮\n也检查键盘', context: 'Current URL: https://example.test/page\n\nPage snapshot:\n合成页面' })
    expect(sourcePromptTitle(text, 'claude-code')).toBe('检查按钮')
    for (const content of ['Task: 测试\nCurrent URL: https://example.test\n\nPage snapshot:\n缺少分隔', 'Task: 测试\n\nCurrent URL: https://example.test\n没有快照', 'Task: 测试\n\nCurrent URL: javascript:alert(1)\n\nPage snapshot:\n不识别']) {
      expect(sourceMessageParts(content, 'claude-code', 'user')).toEqual({ primary: content, context: '' })
    }
  })
  it('标题含省略号最多 200 个 Unicode 字符（满足会话标题 schema），超出才加省略号', () => {
    const line = (count: number) => '合成'.repeat(count / 2)
    expect(sourcePromptTitle(line(150), 'claude-code')).toBe(line(150))
    expect(sourcePromptTitle(line(200), 'claude-code')).toBe(line(200))
    expect(sourcePromptTitle(line(202), 'claude-code')).toBe(line(198) + '合…')
    expect(Array.from(sourcePromptTitle(line(400), 'claude-code'))).toHaveLength(200)
    expect(Array.from(sourcePromptTitle('😀'.repeat(201), 'codex'))).toHaveLength(200)
    expect(sourcePromptTitle('😀'.repeat(201), 'codex').endsWith('😀…')).toBe(true)
  })
  it('只有代码围栏没有文本时标题为空，普通代码首行不被误当成上下文包装', () => {
    expect(sourcePromptTitle('```xml\n<environment_context>代码示例</environment_context>\n```', 'codex')).toBe('<environment_context>代码示例</environment_context>')
    expect(sourcePromptTitle('```\n```', 'claude-code')).toBe('')
  })
})
