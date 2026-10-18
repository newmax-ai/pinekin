import { useEffect, useState } from 'react'

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const pad = (value: number) => String(value).padStart(2, '0')

export function formatSessionTime(dateTime: string, now: number): { label: string; full: string } {
  const date = new Date(dateTime), timestamp = date.getTime()
  if (!Number.isFinite(timestamp)) return { label: '时间未知', full: '时间未知' }

  const dateLabel = `${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const full = `${date.getFullYear()}年${dateLabel} ${clock}:${pad(date.getSeconds())}`
  const elapsed = now - timestamp
  let label: string
  // 不足一分钟的时钟误差视为刚刚；更远的未来时间保留原时刻，不伪装成过去。
  if (elapsed <= -minute) label = full
  else if (elapsed < minute) label = '刚刚'
  else if (elapsed < hour) label = `${Math.floor(elapsed / minute)}分钟前`
  else if (elapsed < day) label = `${Math.floor(elapsed / hour)}小时前`
  else if (elapsed < 7 * day) label = `${Math.floor(elapsed / day)}天前`
  else label = `${date.getFullYear() === new Date(now).getFullYear() ? '' : `${date.getFullYear()}年`}${dateLabel} ${clock}`
  return { label, full }
}

// 每个列表共用一个时钟，不为每张卡片创建计时器，也不重新读取来源数据。
export function useCurrentTime() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const update = () => setNow(Date.now())
    const onVisible = () => { if (document.visibilityState === 'visible') update() }
    const timer = window.setInterval(update, minute)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return now
}

export function SessionTime({ dateTime, now }: { dateTime: string; now: number }) {
  const { label, full } = formatSessionTime(dateTime, now)
  return <time dateTime={label === '时间未知' ? undefined : dateTime} title={full} aria-label={full}>{label}</time>
}
