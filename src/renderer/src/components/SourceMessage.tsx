import { useState, type ReactNode } from 'react'
import type { Message, Source } from '../../../core/types'
import type { SourcePresentation } from '../../../core/sources'
import { sourceMessageParts } from '../../../core/source-presentation'
import { MessageContent } from './MessageContent'
import './SourceMessage.css'

function Disclosure({ label, children, defaultOpen = false }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return <details className="source-disclosure" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>{open && <div className="source-disclosure-body">{children}</div>}
  </details>
}

export function SourceMessage({ message, source, fragment = false }: { message: Message; source: Source; fragment?: boolean }) {
  const { primary, context } = sourceMessageParts(message.content, source, message.role)
  const long = primary.length > 4000
  return <>
    {primary && <MessageContent content={long ? primary.slice(0, 4000) + '\n…' : primary} />}
    {long && <Disclosure label={fragment ? '展开当前片段' : '展开完整消息'}><MessageContent content={primary} /></Disclosure>}
    {context && <Disclosure label={/^Page snapshot:/m.test(context) ? '页面上下文' : '附带上下文'}><MessageContent content={context} /></Disclosure>}
    {!primary && !context && <MessageContent content="" />}
  </>
}

export function SourceActivity({ presentation }: { presentation: SourcePresentation }) {
  const p = presentation
  if (!p.toolCalls && !p.toolResults && !p.attachments && !p.omittedRecords) return null
  return <section className="source-activity" aria-label="非文字活动">
    {(p.toolCalls > 0 || p.toolResults > 0) && <Disclosure defaultOpen={p.kind === 'browser-task' || p.textMessages <= 1} label={`工具活动 · ${p.toolCalls} 次调用 · ${p.toolResults} 条结果`}>
      <p className="privacy-note">以下是日志中的工具活动，不是助手文字答复；不会执行历史调用。</p>
      {p.activities.map((activity, index) => <Disclosure key={index} label={`${activity.kind === 'call' ? '调用' : '结果'} · ${activity.name}`}>
        <MessageContent content={activity.content} />{activity.truncated && <p className="privacy-note">预览已截断，完整内容保留在来源文件。</p>}
      </Disclosure>)}
      {p.activitiesTruncated && <p className="privacy-note">活动预览有数量和长度限制；上方显示的是日志统计总数。</p>}
    </Disclosure>}
    {p.attachments > 0 && <p className="privacy-note">{p.attachments} 项附件或非文本内容保留在原件，未加载图片和文件。</p>}
    {p.omittedRecords > 0 && <p className="privacy-note">{p.omittedRecords} 条推理、上下文或状态记录未作为问答展示。</p>}
    {!p.textMessages && <p className="privacy-note">此记录没有可显示的文字问答；已单独列出可识别的活动。</p>}
  </section>
}
