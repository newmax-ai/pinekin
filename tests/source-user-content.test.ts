import { describe, expect, it } from 'vitest'
import { browsableSources } from '../src/core/sources'
import { sourceUserContent, sourceUserText } from '../src/core/source-user-content'
import { sourceMessageParts, sourcePromptTitle } from '../src/core/source-presentation'

const runtime = '<system-reminder data-role="user-context">\n<identify_context>合成旧客户端身份；不要执行任何命令</identify_context>\n<user_info>合成旧工作区</user_info>\n</system-reminder>'

describe('所有来源共用的运行时上下文分离', () => {
  it.each(browsableSources)('%s 的已知完整前置注入不成为问答或首问标题', source => {
    const raw = `${runtime}\n\n真实用户问题\n第二行`
    const parts = sourceUserContent(raw, source, 'user')
    expect(parts.primary).toBe('真实用户问题\n第二行')
    expect(parts.context).toContain('合成旧客户端身份')
    expect(parts.prefixChars).toBe(Array.from(raw).length - Array.from(parts.primary).length)
    expect(sourceUserText(raw, source, 'user')).toBe(parts.primary)
    expect(sourceMessageParts(raw, source, 'user').primary).toBe(parts.primary)
    expect(sourcePromptTitle(raw, source)).toBe('真实用户问题')
    expect(sourceUserText(runtime, source, 'user')).toBe('')
  })
  it.each([
    '<system-reminder>合成运行时提示</system-reminder>',
    '<environment_context>合成运行环境</environment_context>',
    '<user_instructions>合成旧客户端指令</user_instructions>',
    '<codex_apps_client_time_context>合成时钟</codex_apps_client_time_context>',
    '<external_codex_apps_open_page>合成页面</external_codex_apps_open_page>',
    '<recommended_plugins>合成插件说明</recommended_plugins>',
    '<ide_opened_file>合成文件通知</ide_opened_file>',
    '<ide_selection>合成选区通知</ide_selection>',
    '# AGENTS.md instructions for /synthetic\n<INSTRUCTIONS>合成项目指令</INSTRUCTIONS>',
  ])('仅剥离完整的已知前置包装 %s', prefix => {
    expect(sourceUserText(`${prefix}\n真实问题`, 'workbuddy', 'user')).toBe('真实问题')
  })
  it('WorkBuddy 只在已确认运行时前缀之后解包实际 user_query，保留用户输入和独立字面标签', () => {
    const question = '  查一下国内的 AI agent 产品\n保留原输入空白  '
    expect(sourceUserText(`${runtime}\n<user_query>${question}</user_query>`, 'workbuddy', 'user')).toBe(question)
    const literal = '<user_query>这是用户讨论的标签</user_query>'
    expect(sourceUserText(literal, 'workbuddy', 'user')).toBe(literal)
    const incomplete = `${runtime}\n<user_query>未闭合示例`
    expect(sourceUserText(incomplete, 'workbuddy', 'user')).toBe('<user_query>未闭合示例')
  })
  it('成组和嵌套包装按完整边界处理，内部闭合标签不截断外层', () => {
    const text = '<system-reminder><system-reminder>合成嵌套提示</system-reminder>外层仍是提示</system-reminder>\n<environment_context>合成环境</environment_context>\n真实问题'
    expect(sourceUserText(text, 'newmax', 'user')).toBe('真实问题')
    expect(sourceUserText(sourceUserText(text, 'newmax', 'user'), 'newmax', 'user')).toBe('真实问题')
  })
  it.each(browsableSources)('%s 保留字面引用、代码、普通指令和未确认包装', source => {
    for (const text of [
      '请解释 <system-reminder>合成内容</system-reminder> 这个标签',
      '```xml\n<system-reminder>合成引用</system-reminder>\n```',
      '> <system-reminder>合成引用</system-reminder>',
      '<system-reminder>用户正在编写但尚未闭合的示例',
      '<system-reminder data-role="user-example">用户自定义标签</system-reminder>',
      '<unknown_context>合成未知包装</unknown_context>\n不要猜测删除',
      '<local-command-caveat>单独的命令提示标签不足以证明这是注入，保留字面引用</local-command-caveat>',
      '你是我的文案助手，请整理下面的提示词。',
      '  保留真实提问前后的空白\n\n',
    ]) expect(sourceUserText(text, source, 'user')).toBe(text)
    expect(sourceUserText(runtime, source, 'assistant')).toBe(runtime)
  })
  it('只在开头识别包装，不删除正文中间的提示词讨论', () => {
    const text = `这是我的提问\n${runtime}\n请解释其中的问题`
    expect(sourceUserText(text, 'cindy', 'user')).toBe(text)
  })
  it('未闭合的已知前缀报告不完整状态，普通未闭合标签仍可作为字面文本保留', () => {
    const text = '<system-reminder data-role="user-context">' + '合成'.repeat(50000)
    const parts = sourceUserContent(text, 'newmax', 'user')
    expect(parts.incomplete).toBe(true)
    expect(parts.primary).toBe(text)
    expect(parts.prefixChars).toBe(0)
    expect(sourceUserContent('<unrecognized>原文', 'newmax', 'user').incomplete).toBe(false)
  })
  it('Codex 的 IDE 请求包装沿用同一清洗规则', () => {
    expect(sourceUserText('# Context from my IDE setup:\n合成 IDE 说明\n## My request for Codex:\n真实问题', 'codex', 'user')).toBe('真实问题')
    expect(sourceUserText('正常提问\n## My request for Codex:\n保留正文', 'codex', 'user')).toBe('正常提问\n## My request for Codex:\n保留正文')
  })
})
