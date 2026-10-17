import type { Source } from '../../../core/types'
import { DesignIcon } from './ui'

// 仅打包已核对的静态素材；来源枚举不能指定远程 URL 或加载导入包中的图片。
const icons: Record<Exclude<Source, 'other'>, string> = {
  newmax: new URL('../assets/clients/newmax.svg', import.meta.url).href,
  'claude-code': new URL('../assets/clients/claude.svg', import.meta.url).href,
  codex: new URL('../assets/clients/openai.svg', import.meta.url).href,
  cindy: new URL('../assets/clients/cindy.png', import.meta.url).href,
  deepseek: new URL('../assets/clients/deepseek.svg', import.meta.url).href,
}

export function SourceIcon({ source, size = 18 }: { source: Source; size?: number }) {
  return <span className="source-icon" data-source={source} aria-hidden="true" style={{ width: size, height: size }}>
    {source === 'other' ? <DesignIcon name="archive" size={size} /> : <img src={icons[source]} alt="" draggable={false} />}
  </span>
}
