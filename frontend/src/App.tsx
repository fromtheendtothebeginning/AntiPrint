// 应用外壳：暖色仪表盘风格（侧栏 + 吸顶栏 + 路由表 + 登录守卫）
// 风格参考见 AGENTS.md「前端风格（暖色仪表盘）」一节；页面统一用 Tailwind 工具类
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import { FileText, ListChecks, LogOut, PanelLeft, Printer, Settings, ShieldCheck, Upload, User, UserCog } from 'lucide-react'
import { api, clearToken, getToken, getUser, setOnAuthExpired, setUser as persistUser } from './api'
import ThemeToggle from './components/ThemeToggle'
import LoginPage from './pages/LoginPage'
import AnticraftCallbackPage from './pages/AnticraftCallbackPage'
import SubmitPage from './pages/SubmitPage'
import MyJobsPage from './pages/MyJobsPage'
import ProfilePage from './pages/ProfilePage'
import QueuePage from './pages/QueuePage'
import AdminPage from './pages/AdminPage'
import UsersPage from './pages/UsersPage'
import { ROLE_LABEL } from './constants'
import type { User as UserType } from './types/api'

/** 顶栏标题：与参考实现的 pageMeta 同款映射 */
const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  '/submit': { title: '提交打印', subtitle: '上传文件、选择配送方式并填写地址，管理员审核通过后由本机打印代理出纸' },
  '/mine': { title: '我的任务', subtitle: '查看自己提交的打印任务与审核、打印、交接进度' },
  '/profile': { title: '我的配置', subtitle: '默认配送地址与配送方式，以及 anticraft 账号绑定' },
  '/queue': { title: '任务队列', subtitle: '审核打印任务，并在出纸后勾选待配送 / 待取件与完成' },
  '/admin': { title: '管理设置', subtitle: '打印代理状态、打印参数、anticraft 绑定应用与代理令牌' },
  '/users': { title: '用户管理', subtitle: '查看账号，并把普通用户提拔为管理员（仅超级管理员）' },
}

interface RequireAuthProps {
  user: UserType | null
  /** 仅管理员（admin 或 root）可访问 */
  admin?: boolean
  /** 仅超级管理员（root）可访问 */
  root?: boolean
  children: ReactNode
}

/** 简单的路由守卫：未登录跳登录页，权限不足回提交页 */
function RequireAuth({ user, admin = false, root = false, children }: RequireAuthProps) {
  if (!user) return <Navigate to="/login" replace />
  if (admin && user.role !== 'admin' && user.role !== 'root') return <Navigate to="/submit" replace />
  if (root && user.role !== 'root') return <Navigate to="/submit" replace />
  return <>{children}</>
}

function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const [user, setUser] = useState<UserType | null>(getUser)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [notice, setNotice] = useState('')

  // 挂载时若已有令牌，调 me() 验活并刷新用户信息
  useEffect(() => {
    if (!getToken()) return
    let active = true
    api
      .me()
      .then((profile) => {
        if (!active) return
        persistUser(profile)
        setUser(profile)
      })
      .catch(() => {
        // 401 已由 api 统一清空登录态并触发过期回调，这里无需重复处理
      })
    return () => {
      active = false
    }
  }, [])

  // 全局登录过期处理：清状态 + 回登录页 + 提示
  useEffect(() => {
    setOnAuthExpired(() => {
      setUser(null)
      setNotice('登录已过期，请重新登录')
      navigate('/login', { replace: true })
    })
    return () => setOnAuthExpired(null)
  }, [navigate])

  // 提示 4 秒后自动消失
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const handleLogin = useCallback((profile: UserType) => {
    persistUser(profile)
    setUser(profile)
  }, [])

  const handleLogout = useCallback(() => {
    clearToken()
    setUser(null)
    navigate('/login', { replace: true })
  }, [navigate])

  const routes = (
    <Routes>
      <Route
        path="/login"
        element={
          user ? (
            <Navigate to={user.role === 'root' || user.role === 'admin' ? '/queue' : '/submit'} replace />
          ) : (
            <LoginPage onLogin={handleLogin} />
          )
        }
      />
      {/* anticraft 授权回调页：公开页面，已登录用户也能落地（不会命中 /login 的重定向，路径是精确匹配） */}
      <Route
        path="/login/anticraft/callback"
        element={<AnticraftCallbackPage onLogin={handleLogin} />}
      />
      <Route
        path="/submit"
        element={
          <RequireAuth user={user}>
            <SubmitPage />
          </RequireAuth>
        }
      />
      <Route
        path="/mine"
        element={
          <RequireAuth user={user}>
            <MyJobsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/profile"
        element={
          <RequireAuth user={user}>
            <ProfilePage />
          </RequireAuth>
        }
      />
      <Route
        path="/queue"
        element={
          <RequireAuth user={user} admin>
            <QueuePage />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAuth user={user} admin>
            <AdminPage />
          </RequireAuth>
        }
      />
      <Route
        path="/users"
        element={
          <RequireAuth user={user} root>
            <UsersPage />
          </RequireAuth>
        }
      />
      <Route path="/" element={<Navigate to="/submit" replace />} />
      <Route path="*" element={<Navigate to="/submit" replace />} />
    </Routes>
  )

  const toast = notice && (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-gray-800 px-4 py-2.5 text-sm text-white shadow-2xl"
    >
      {notice}
    </div>
  )

  // 未登录：不显示侧栏，只保留品牌条 + 主题开关（登录/回调页落地）
  if (!user) {
    return (
      <div className="min-h-screen">
        <header className="sticky top-0 z-30 border-b border-gray-200/50 bg-warm/80 backdrop-blur-md dark:border-white/10 dark:bg-warm-dark/80">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link className="flex items-center gap-3" to="/">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-white">
                <Printer className="h-5 w-5" />
              </span>
              <span className="text-lg font-semibold text-gray-800 dark:text-gray-100">
                AntiPrint · 远程打印
              </span>
            </Link>
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-10">{routes}</main>
        {toast}
      </div>
    )
  }

  const meta = PAGE_META[location.pathname] ?? PAGE_META['/submit']

  const navItems = [
    { to: '/submit', label: '提交打印', Icon: Upload, admin: false },
    { to: '/mine', label: '我的任务', Icon: FileText, admin: false },
    { to: '/profile', label: '我的配置', Icon: UserCog, admin: false },
    { to: '/queue', label: '任务队列', Icon: ListChecks, admin: true },
    { to: '/admin', label: '管理设置', Icon: Settings, admin: true },
    { to: '/users', label: '用户管理', Icon: ShieldCheck, root: true },
  ].filter((item) => {
    if ('root' in item && item.root) return user.role === 'root'
    if (item.admin) return user.role === 'admin' || user.role === 'root'
    return true
  })

  return (
    <div className="min-h-screen">
      {/* 侧栏 */}
      <aside
        className={`fixed left-0 top-0 z-40 h-full overflow-hidden border-r border-gray-200/60 bg-white transition-all duration-300 dark:border-white/10 dark:bg-ink-soft ${
          sidebarOpen ? 'w-60' : 'w-0'
        }`}
      >
        <div className="flex h-full w-60 flex-col p-6">
          <div className="mb-10 flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white">
              <Printer className="h-5 w-5" />
            </span>
            <span className="whitespace-nowrap text-lg font-semibold text-gray-800 dark:text-gray-100">
              AntiPrint
            </span>
          </div>

          <nav className="flex-1 space-y-1">
            {navItems.map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm transition-all duration-200 ${
                    isActive
                      ? 'bg-brand font-medium text-white shadow-lg shadow-brand/25'
                      : 'text-gray-500 hover:bg-warm hover:text-gray-800 hover:shadow-sm dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-100'
                  }`
                }
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                <span className="whitespace-nowrap font-medium">{label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="mt-6 border-t border-gray-100 pt-6 dark:border-white/10">
            <div className="flex items-center gap-3 px-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber text-sm font-semibold uppercase text-white">
                {user.username.slice(0, 1)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-gray-700 dark:text-gray-200" title={user.username}>
                  {user.username}
                </div>
                <div className="truncate text-xs text-gray-400">
                  {ROLE_LABEL[user.role] ?? '普通用户'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <div className={`transition-all duration-300 ${sidebarOpen ? 'ml-60' : 'ml-0'}`}>
        <header className="sticky top-0 z-30 border-b border-gray-200/50 bg-warm/80 backdrop-blur-md dark:border-white/10 dark:bg-warm-dark/80">
          <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 md:px-8">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => setSidebarOpen((prev) => !prev)}
                aria-label="折叠或展开侧栏"
                className="rounded-xl p-2 text-gray-500 transition-all duration-200 hover:bg-white hover:shadow-sm dark:text-gray-400 dark:hover:bg-white/5"
              >
                <PanelLeft className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100">{meta.title}</h1>
                <p className="text-xs text-gray-400">{meta.subtitle}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="hidden items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-medium text-gray-600 shadow-lg shadow-black/5 sm:inline-flex dark:bg-ink-soft dark:text-gray-300">
                <User className="h-4 w-4" />
                {user.username}
              </span>
              <ThemeToggle />
              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl dark:bg-ink-soft dark:text-gray-300"
              >
                <LogOut className="h-4 w-4" />
                退出
              </button>
            </div>
          </div>
        </header>

        <main className="px-6 py-6 md:px-8">{routes}</main>
      </div>

      {toast}
    </div>
  )
}

export default App
