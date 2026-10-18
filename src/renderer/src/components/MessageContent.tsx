import { Fragment, useMemo, type ReactNode } from 'react'
import { Lexer, type MarkedToken, type Token } from 'marked'
import { decodeHTMLStrict } from 'entities'
import { ScrollArea } from './ScrollArea'
import './MessageContent.css'

const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

function textValue(token: Token): string {
  // Marked 会预解码部分数字实体；从 raw 解码一次，避免把 &#38;lt; 二次解码成 <。
  if (token.type === 'text' && !token.escaped && !token.tokens) return decodeHTMLStrict(token.raw)
  return 'text' in token ? token.text : token.raw
}

function plainText(tokens: Token[]): string {
  return tokens.map(token => {
    if (token.type === 'br') return '\n'
    if (token.type === 'link' && token.autolink) return token.text
    return 'tokens' in token && token.tokens ? plainText(token.tokens) : textValue(token)
  }).join('')
}

function renderTokens(tokens: Token[]): ReactNode {
  return tokens.map((token, index) => <Fragment key={index}>{renderToken(token)}</Fragment>)
}

function renderToken(token: Token): ReactNode {
  // 使用未注册扩展的 Lexer，仅接受内建 token。未知类型也只能退回 React 文本。
  const node = token as MarkedToken
  switch (node.type) {
    case 'space':
    case 'def':
      return null
    case 'heading': {
      const Heading = headings[node.depth - 1] ?? 'h6'
      return <Heading>{renderTokens(node.tokens)}</Heading>
    }
    case 'paragraph':
      return <p>{renderTokens(node.tokens)}</p>
    case 'text':
      return node.tokens ? renderTokens(node.tokens) : textValue(node)
    case 'escape':
      return node.text
    case 'html':
      // HTML 源码可读，但从不进入 HTML parser、innerHTML 或 DOM 属性。
      return node.block ? <p className="markdown-raw-html">{node.raw}</p> : node.raw
    case 'strong':
      return <strong>{renderTokens(node.tokens)}</strong>
    case 'em':
      return <em>{renderTokens(node.tokens)}</em>
    case 'del':
      return <del>{renderTokens(node.tokens)}</del>
    case 'codespan':
      return <code className="markdown-inline-code">{node.text}</code>
    case 'code':
      return <div className="code-block"><div className="code-label"><span>{node.lang?.trim().split(/\s+/, 1)[0] || '纯文本'}</span><span>只读代码</span></div><ScrollArea as="pre" tabIndex={0}><code>{node.text}</code></ScrollArea></div>
    case 'blockquote':
      return <blockquote>{renderTokens(node.tokens)}</blockquote>
    case 'list': {
      const items = node.items.map((item, index) => <li key={index}>{renderTokens(item.tokens)}</li>)
      return node.ordered ? <ol start={typeof node.start === 'number' ? node.start : 1}>{items}</ol> : <ul>{items}</ul>
    }
    case 'list_item':
      return <li>{renderTokens(node.tokens)}</li>
    case 'checkbox':
      return <span className="markdown-task-state" role="img" aria-label={node.checked ? '已完成' : '未完成'}>{node.checked ? '[x]' : '[ ]'} </span>
    case 'table':
      return <ScrollArea className="markdown-table" tabIndex={0} role="region" aria-label="Markdown 表格"><table>
        <thead><tr>{node.header.map((cell, index) => <th key={index} scope="col" style={{ textAlign: cell.align ?? undefined }}>{renderTokens(cell.tokens)}</th>)}</tr></thead>
        <tbody>{node.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} style={{ textAlign: cell.align ?? undefined }}>{renderTokens(cell.tokens)}</td>)}</tr>)}</tbody>
      </table></ScrollArea>
    case 'link':
      // 尚无授权外链 API：完全不创建 a/href/onClick，包括安全 URL 和自动链接。
      return <span>{node.autolink ? node.text : renderTokens(node.tokens)}</span>
    case 'image':
      // 不创建 img/src，也不将 URL 放入任何 DOM 属性；本地与 data URL 同样禁止。
      return <span className="markdown-image-alt">{plainText(node.tokens) || '图片'}</span>
    case 'br':
      return <br />
    case 'hr':
      return <hr />
    default:
      return token.raw
  }
}

export function MessageContent({ content }: { content: string }) {
  const rendered = useMemo(() => {
    try {
      return renderTokens(Lexer.lex(content, { gfm: true, breaks: false, pedantic: false }))
    } catch {
      // 异常输入不能使整段会话不可读；回退同样只插入 React 文本。
      return <p>{content}</p>
    }
  }, [content])
  if (!content.trim()) return <p className="muted">这条消息没有文本内容</p>
  return <div className="message-markdown">{rendered}</div>
}
