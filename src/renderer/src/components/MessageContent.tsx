import { ScrollArea } from './ScrollArea'

interface Block { kind: 'text' | 'code'; content: string; language?: string }

// 只识别成对的行首代码围栏。所有内容仍是 React 文本，不解析 HTML、链接或图片。
function blocks(content: string): Block[] {
  const lines = content.split('\n')
  const result: Block[] = []
  let text: string[] = []
  let code: string[] | null = null
  let fence = ''
  let opening = ''
  let language = ''
  function flushText() {
    if (text.length) result.push({ kind: 'text', content: text.join('\n') })
    text = []
  }
  for (const line of lines) {
    if (code) {
      const trimmed = line.trimEnd()
      if (trimmed.length >= fence.length && [...trimmed].every(char => char === fence[0])) {
        flushText()
        result.push({ kind: 'code', content: code.join('\n'), language })
        code = null
      } else code.push(line)
    } else {
      const match = /^(`{3,}|~{3,})([\w+.-]*)\s*$/.exec(line)
      if (match) { fence = match[1]; language = match[2]; opening = line; code = [] }
      else text.push(line)
    }
  }
  if (code) text.push(opening, ...code)
  flushText()
  return result
}

export function MessageContent({ content }: { content: string }) {
  if (!content) return <p className="muted">这条消息没有文本内容</p>
  return <>{blocks(content).map((block, index) => block.kind === 'code'
    ? <div className="code-block" key={index}><div className="code-label"><span>{block.language || '纯文本'}</span><span>只读代码</span></div><ScrollArea as="pre" tabIndex={0}><code>{block.content}</code></ScrollArea></div>
    : <p key={index}>{block.content}</p>)}</>
}
