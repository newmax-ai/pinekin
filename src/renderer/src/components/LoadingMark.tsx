import './LoadingMark.css'

/** 三枚圆点依次等比放大、缩小；纯 CSS 驱动，不创建计时器或逐帧状态。 */
export function LoadingMark({ label = '加载中' }: { label?: string }) {
  return <span className="loading-mark" role="img" aria-label={label}><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /></span>
}
