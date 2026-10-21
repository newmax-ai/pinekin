import { useEffect, useId, useRef, useState } from 'react'
import { DesignIcon, DsButton, DsDialog, DsDialogHeader, DsDialogPresence } from './ui'
import { ScrollArea } from './ScrollArea'
import './SourceReadNotes.css'

// 只归类解析器已知的会话级提示，不用泛化关键词猜测正文是否完整。
// 固定读取边界、正常上下文过滤及所有未归类说明仍完整保留在按需弹窗中。
const integrityNotices: { matches: RegExp; label: string; text: string }[] = [
  { matches: /^(日志包含回退|包含已回退消息)/, label: '含回退记录', text: '此会话含回退记录，当前文本可能包含已撤销的历史。' },
  { matches: /^(日志包含上下文压缩|压缩摘要与 replacement_history)/, label: '上下文有压缩', text: '此会话含上下文压缩记录，当前文本不代表完整有效上下文。' },
  { matches: /^存在加密(消息内容|内容)/, label: '含加密内容', text: '部分内容已加密，仅展示已有明文和占位符。' },
  { matches: /^(消息阶段或完成状态|存在非 completed 的消息完成状态|助手消息阶段（)/, label: '回答可能不完整', text: '部分回答可能不完整，来源记录不足以判断是否已完整结束。' },
  { matches: /^(子会话只显示|子会话仅展示|这是子会话当前文件)/, label: '继承上下文可能缺失', text: '仅展示此子会话自身记录，继承上下文可能缺失。' },
  { matches: /^(当前父链之外的|单链未包含全部分支或尾部状态)/, label: '仅当前消息链', text: '仅展示当前消息链，其他分支记录未包含。' },
  { matches: /^(未映射内容块：|未映射响应项：|存在未映射的|推理、工具和多模态块未作为问答展示|媒体不映射到当前档案)/, label: '部分内容未展示', text: '部分非文本或未知格式内容未展示，完整内容请在来源中查看。' },
]

function getIntegrityNotices(warnings: string[]) {
  return integrityNotices.filter(notice => warnings.some(warning => notice.matches.test(warning)))
}

export function SourceReadNotice({ warnings, disabled = false }: { warnings: string[]; disabled?: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { setOpen(false) }, [warnings, disabled])
  const notices = getIntegrityNotices(warnings)
  if (!notices.length) return null
  const label = notices.length === 1 ? notices[0].label : '有内容需留意'
  return <>
    <span className="source-read-notice" role="status" aria-label="内容完整性提示">
      <button ref={trigger} type="button" className="source-read-notice-trigger" disabled={disabled}
        aria-label={`${label}，查看读取说明`} aria-haspopup="dialog" aria-expanded={open && !disabled}
        onClick={() => setOpen(true)}><DesignIcon name="info" size={12} /><span>{label}</span></button>
    </span>
    <DsDialogPresence>{open && !disabled && <SourceReadNotesDialog warnings={warnings}
      returnFocus={trigger.current} onDismiss={() => setOpen(false)} />}</DsDialogPresence>
  </>
}

export function SourceReadNotesDialog({ warnings, onDismiss, returnFocus }: {
  warnings: string[]; onDismiss: () => void; returnFocus: HTMLElement | null
}) {
  const titleId = useId()
  const rawNotesId = useId()
  const [expanded, setExpanded] = useState(false)
  const notices = getIntegrityNotices(warnings)
  return <DsDialog titleId={titleId} onDismiss={onDismiss} busy={false} returnFocus={returnFocus} animateHeight>
    <DsDialogHeader titleId={titleId} title="读取说明" closeLabel="关闭读取说明" onDismiss={onDismiss} />
    <ScrollArea className="dialog-content source-read-notes" lang="zh-CN" role="region" aria-label="读取说明内容" tabIndex={0}>
      <p className="dialog-description">此视图仅展示可读取的文本与活动预览，不等于完整原生会话恢复。</p>
      {notices.length > 0 && <section className="source-read-notes-summary" aria-label="内容完整性说明">
        <h3>需要留意</h3>
        {notices.map(notice => <p key={notice.label}>{notice.text}</p>)}
      </section>}
      {warnings.length > 0 && <div className="source-read-notes-details">
        <DsButton variant="ghost" size="small" className="source-read-notes-toggle"
          aria-label={expanded ? '收起原始读取说明' : '展开原始读取说明'} aria-expanded={expanded} aria-controls={rawNotesId}
          onClick={() => setExpanded(value => !value)}>原始读取说明<DesignIcon name="chevron-down" size={14} /></DsButton>
        <div id={rawNotesId} className="source-read-notes-raw" role="region" aria-label="原始读取说明" hidden={!expanded}>
          {warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        </div>
      </div>}
    </ScrollArea>
  </DsDialog>
}
