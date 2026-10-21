import { Toast, type ToastMessage } from './Toast'

type UpdateState = 'updated' | 'reading' | 'jump'
const labels: Record<UpdateState, string> = { updated: '此对话有更新', reading: '读取中…', jump: '跳到新增消息' }

export function SourceUpdatePill({ state, onRead, onJump, onDismiss, notice }: {
  state?: UpdateState; onRead(): void; onJump(): void; onDismiss?(): void; notice?: ToastMessage
}) {
  const update: ToastMessage | undefined = state ? {
    text: labels[state], state, busy: state === 'reading',
    actionLabel: state === 'jump' ? labels.jump : '查看更新',
    dismissLabel: '关闭更新提示', onDismiss,
    onClick: state === 'jump' ? onJump : onRead,
  } : undefined
  return <Toast message={notice ?? update} className={notice ? 'source-actions-feedback' : ''} />
}
