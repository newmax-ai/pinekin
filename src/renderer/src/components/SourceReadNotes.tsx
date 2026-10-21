import { useId } from 'react'
import { DsDialog, DsDialogHeader } from './ui'
import { ScrollArea } from './ScrollArea'
import './SourceReadNotes.css'

// 只归类解析器已知的会话级提示，不用泛化关键词猜测正文是否完整。
// 固定读取边界、正常上下文过滤及所有未归类说明仍完整保留在按需弹窗中。
const integrityNotices: { matches: RegExp; text: string }[] = [
  { matches: /^(日志包含回退|包含已回退消息)/, text: '此会话含回退记录，当前文本可能包含已撤销的历史。' },
  { matches: /^(日志包含上下文压缩|压缩摘要与 replacement_history)/, text: '此会话含上下文压缩记录，当前文本不代表完整有效上下文。' },
  { matches: /^存在加密(消息内容|内容)/, text: '部分内容已加密，仅展示已有明文和占位符。' },
  { matches: /^(消息阶段或完成状态|存在非 completed 的消息完成状态|助手消息阶段（)/, text: '部分回答的完成状态无法确认，不应视为完整答复。' },
  { matches: /^(子会话只显示|子会话仅展示|这是子会话当前文件)/, text: '仅展示此子会话自身记录，继承上下文可能缺失。' },
  { matches: /^(当前父链之外的|单链未包含全部分支或尾部状态)/, text: '仅展示当前消息链，其他分支记录未包含。' },
  { matches: /^(未映射内容块：|未映射响应项：|存在未映射的|推理、工具和多模态块未作为问答展示|媒体不映射到当前档案)/, text: '部分非文本或未知格式内容未展示，完整内容请在来源中查看。' },
]

export function SourceReadNotice({ warnings }: { warnings: string[] }) {
  const notices = integrityNotices.filter(notice => warnings.some(warning => notice.matches.test(warning)))
  if (!notices.length) return null
  return <div className="source-update-notice source-read-notice" role="status" aria-label="内容完整性提示">
    <ul>{notices.map(notice => <li key={notice.text}>{notice.text}</li>)}</ul>
  </div>
}

export function SourceReadNotesDialog({ warnings, onDismiss, returnFocus }: {
  warnings: string[]; onDismiss: () => void; returnFocus: HTMLElement | null
}) {
  const titleId = useId()
  return <DsDialog titleId={titleId} onDismiss={onDismiss} busy={false} returnFocus={returnFocus}>
    <DsDialogHeader titleId={titleId} title="读取说明" closeLabel="关闭读取说明" onDismiss={onDismiss} />
    <ScrollArea className="dialog-content source-read-notes" role="region" aria-label="读取说明内容" tabIndex={0}>
      <p>此视图仅展示可读取的文本与活动预览，不等于完整原生会话恢复。</p>
      {warnings.length > 0 && <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    </ScrollArea>
  </DsDialog>
}
