// 主题切换（三态：跟随系统 / 浅色 / 深色）：写 <html data-theme> 与 localStorage['theme']
// 深色由 index.css 的 @custom-variant dark 驱动（配合 data-theme 属性）
import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'

type Theme = 'system' | 'light' | 'dark'

const THEME_KEY = 'theme'

const THEME_LABEL: Record<Theme, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

/** 读取本地保存的主题，无值或非法时回退「跟随系统」 */
function readTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY)
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
}

/** 「跟随系统」时移除 data-theme，交给 CSS 的媒体查询决定明暗 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // 跟随系统时，系统切换明暗要同步更新图标
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    function handleChange(event: MediaQueryListEvent) {
      setSystemDark(event.matches)
    }
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  const isDark = theme === 'dark' || (theme === 'system' && systemDark)
  const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'

  function handleClick() {
    setTheme(next)
    localStorage.setItem(THEME_KEY, next)
  }

  const Icon = theme === 'system' ? Monitor : isDark ? Moon : Sun

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`当前主题：${THEME_LABEL[theme]}，点击切换到「${THEME_LABEL[next]}」`}
      aria-label={`切换主题，当前为${THEME_LABEL[theme]}`}
      className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl dark:bg-ink-soft dark:text-gray-300"
    >
      <Icon className="h-4 w-4" />
      <span className="hidden sm:inline">{THEME_LABEL[theme]}</span>
    </button>
  )
}

export default ThemeToggle
