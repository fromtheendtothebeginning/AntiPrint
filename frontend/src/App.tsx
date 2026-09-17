// 应用外壳：暖色仪表盘风格（侧栏 + 吸顶栏 + 路由表 + 登录守卫）
// 风格参考见 AGENTS.md「前端风格（暖色仪表盘）」一节；页面统一用 Tailwind 工具类
import { useCallback, useEffect, useRef, useState } from 'react'
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
import {
  BookOpen,
  Download,
  FileText,
  ListChecks,
  LogOut,
  PanelLeft,
  Printer,
  Settings,
  ShieldCheck,
  Upload,
  User,
  UserCog,
  Wallet,
} from 'lucide-react'
import {
  AVATAR_EVENT,
  api,
  clearToken,
  getToken,
  getUser,
  setOnAuthExpired,
  setUser as persistUser,
} from './api'
import ThemeToggle from './components/ThemeToggle'
import LoginPage from './pages/LoginPage'
import AnticraftCallbackPage from './pages/AnticraftCallbackPage'
import SubmitPage from './pages/SubmitPage'
import MyJobsPage from './pages/MyJobsPage'
import BalancePage from './pages/BalancePage'
import ProfilePage from './pages/ProfilePage'
import QueuePage from './pages/QueuePage'
import AdminPage from './pages/AdminPage'
import UsersPage from './pages/UsersPage'
import ApiDocsPage from './pages/ApiDocsPage'
import VprinterPage from './pages/VprinterPage'
import type { LucideIcon } from 'lucide-react'
import { ROLE_LABEL } from './constants'
import type { User as UserType } from './types/api'

/** 顶栏标题：与参考实现的 pageMeta 同款映射 */
const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  '/submit': { title: '提交打印', subtitle: '上传文件、选择配送方式并填写地址，管理员审核通过后由本机打印代理出纸' },
  '/mine': { title: '我的任务', subtitle: '查看自己提交的打印任务与审核、打印、交接进度' },
  '/vprinter': { title: '虚拟打印机', subtitle: '下载桌面客户端：在任意软件里 Ctrl+P 选「AntiPrint-1.0.0」就等于提交打印任务' },
  '/apidocs': { title: 'API 文档', subtitle: '打印 API 的参数、错误码与 Python 示例（管理员可直接在页面上编辑）' },
  '/balance': { title: '我的余额', subtitle: '账户余额、单价与打印扣费 / 退费记录（充值暂未开放）' },
  '/profile': { title: '我的配置', subtitle: '默认配送地址与配送方式，以及 anticraft 账号绑定' },
  '/queue': { title: '任务队列', subtitle: '审核打印任务，并在出纸后勾选待配送 / 待取件与完成' },
  '/admin': { title: '管理设置', subtitle: '按二级菜单分栏：打印设置 / 打印计费 / 免费白名单 / 管理员名单 / anticraft 绑定 / 打印代理' },
  '/users': { title: '用户管理', subtitle: '账号操作中心：加/收管理员（仅 root）、免费账户开关、调整余额、删除账号（余额为 0，仅 root）' },
}

interface RequireAuthProps {
  user: UserType | null
  /** 仅管理员（admin 或 root）可访问 */
  admin?: boolean
  /** 仅超级管理员（root）可访问 */
  root?: boolean
  /** 登录态还在水合中（有 token 但 /api/me 未返回）：先显示加载态，别跳登录页 */
  hydrating?: boolean
  children: ReactNode
}

/** 简单的路由守卫：未登录跳登录页，权限不足回提交页 */
function RequireAuth({ user, admin = false, root = false, hydrating = false, children }: RequireAuthProps) {
  // 刷新/深链进入时 user 还在异步水合（用 token 调 /api/me）：先等它，不然会先跳登录页、
  // 水合完再命中 /login 的「已登录回角色主页」逻辑，把用户原本要去的页面丢掉（曾导致刷新 /users 落到 /queue）
  if (hydrating && !user) {
    return <p className="py-24 text-center text-sm text-gray-400">正在加载…</p>
  }
  if (!user) return <Navigate to="/login" replace />
  if (admin && user.role !== 'admin' && user.role !== 'root') return <Navigate to="/submit" replace />
  if (root && user.role !== 'root') return <Navigate to="/submit" replace />
  return <>{children}</>
}

function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const [user, setUser] = useState<UserType | null>(getUser)
  /** 侧栏头像（objectURL；没设置头像时用首字母占位） */
  const [avatarUrl, setAvatarUrl] = useState('')
  const avatarUrlRef = useRef<string | null>(null)

  /** 有 token 但用户信息还没取回来：这段时间不跳转，等水合完成 */
  const [hydrating, setHydrating] = useState(() => !!getToken() && !getUser())
  // 小屏（<1024px）默认收起侧栏（抽屉），大屏默认展开
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 1024,
  )
  const [notice, setNotice] = useState('')
  /** 挂在 <Routes> 上的 key：点当前页的导航项时 +1，让页面重挂载回到初始状态（见 renderNavLink） */
  const [pageNonce, setPageNonce] = useState(0)

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
      .finally(() => {
        if (active) setHydrating(false)
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

  /** 拉一次自己的头像（换/删头像时会再调一次） */
  const refreshAvatar = useCallback(() => {
    const id = user?.id
    if (!id) {
      if (avatarUrlRef.current) {
        URL.revokeObjectURL(avatarUrlRef.current)
        avatarUrlRef.current = null
      }
      setAvatarUrl('')
      return
    }
    void api
      .fetchAvatarBlob(id)
      .then((blob) => {
        if (avatarUrlRef.current) URL.revokeObjectURL(avatarUrlRef.current)
        avatarUrlRef.current = URL.createObjectURL(blob)
        setAvatarUrl(avatarUrlRef.current)
      })
      .catch(() => setAvatarUrl(''))
  }, [user?.id])

  // 登录用户变化时拉一次自己的头像（接口要 Bearer，所以 blob → objectURL）
  useEffect(() => {
    refreshAvatar()
    // 我在「我的配置」里换了头像 → 这里立刻重拉，不用等刷新
    window.addEventListener(AVATAR_EVENT, refreshAvatar)
    return () => window.removeEventListener(AVATAR_EVENT, refreshAvatar)
  }, [refreshAvatar])

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
    <Routes key={pageNonce}>
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
          <RequireAuth user={user} hydrating={hydrating}>
            <SubmitPage />
          </RequireAuth>
        }
      />
      <Route
        path="/mine"
        element={
          <RequireAuth user={user} hydrating={hydrating}>
            <MyJobsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/balance"
        element={
          <RequireAuth user={user} hydrating={hydrating}>
            <BalancePage />
          </RequireAuth>
        }
      />
      <Route
        path="/profile"
        element={
          <RequireAuth user={user} hydrating={hydrating}>
            <ProfilePage />
          </RequireAuth>
        }
      />
      <Route
        path="/vprinter"
        element={
          <RequireAuth user={user} hydrating={hydrating}>
            <VprinterPage />
          </RequireAuth>
        }
      />
      <Route
        path="/apidocs"
        element={
          <RequireAuth user={user} hydrating={hydrating}>
            <ApiDocsPage isAdmin={(user?.role ?? 'user') !== 'user'} />
          </RequireAuth>
        }
      />
      <Route
        path="/queue"
        element={
          <RequireAuth user={user} hydrating={hydrating} admin>
            <QueuePage />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAuth user={user} hydrating={hydrating} admin>
            <AdminPage />
          </RequireAuth>
        }
      />
      <Route
        path="/users"
        element={
          <RequireAuth user={user} hydrating={hydrating} admin>
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
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-6 md:py-4">
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
        <main className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">{routes}</main>
        {toast}
      </div>
    )
  }

  const meta = PAGE_META[location.pathname] ?? PAGE_META['/submit']

  // bottom: true 的项贴侧栏底部显示（用户卡片上方），其余按顺序排在顶部
  const navItems = [
    { to: '/submit', label: '提交打印', Icon: Upload, admin: false },
    { to: '/mine', label: '我的任务', Icon: FileText, admin: false },
    { to: '/vprinter', label: '虚拟打印机', Icon: Download, admin: false },
    { to: '/apidocs', label: 'API 文档', Icon: BookOpen, admin: false },
    { to: '/queue', label: '任务队列', Icon: ListChecks, admin: true },
    { to: '/balance', label: '我的余额', Icon: Wallet, admin: false, bottom: true },
    { to: '/profile', label: '我的配置', Icon: UserCog, admin: false, bottom: true },
    { to: '/admin', label: '管理设置', Icon: Settings, admin: true, bottom: true },
    { to: '/users', label: '用户管理', Icon: ShieldCheck, admin: true, bottom: true },
  ].filter((item) => {
    if ('root' in item && item.root) return user.role === 'root'
    if (item.admin) return user.role === 'admin' || user.role === 'root'
    return true
  })
  const mainNav = navItems.filter((item) => !item.bottom)
  const bottomNav = navItems.filter((item) => item.bottom)

  /** 侧栏导航项（顶部与底部两组共用同一套样式与收起逻辑） */
  const renderNavLink = ({ to, label, Icon }: { to: string; label: string; Icon: LucideIcon }) => (
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
      onClick={() => {
        // 小屏是抽屉：点完导航就收起，免得挡住内容
        if (window.innerWidth < 1024) setSidebarOpen(false)
        // 点的就是当前这一页 → 当成「重新进入」：换掉路由树上的 key 让页面重挂载、回到初始状态。
        // 典型场景：提交完停在「提交成功」卡片上，再点「提交打印」应该回到干净的第一步；
        // react-router 对「同一个地址」不会重挂载，不这样处理状态会一直留着。
        setPageNonce((value) => (location.pathname === to ? value + 1 : 0))
      }}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      <span className="whitespace-nowrap font-medium">{label}</span>
    </NavLink>
  )

  return (
    <div className="min-h-screen">
      {/* 侧栏：小屏是抽屉（z-50，压在吸顶栏与遮罩之上），lg 起常驻 */}
      <aside
        className={`fixed left-0 top-0 z-50 h-full w-60 overflow-hidden border-r border-gray-200/60 bg-white transition-transform duration-300 dark:border-white/10 dark:bg-ink-soft lg:transition-[width] ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } ${sidebarOpen ? 'lg:w-60' : 'lg:w-0 lg:translate-x-0'}`}
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

          <nav className="flex-1 space-y-1">{mainNav.map(renderNavLink)}</nav>

          {/* 配置类入口固定在侧栏底部（用户卡片上方），与日常操作分开 */}
          <nav className="space-y-1">{bottomNav.map(renderNavLink)}</nav>

          <div className="mt-6 border-t border-gray-100 pt-6 dark:border-white/10">
            <div className="flex items-center gap-3 px-2">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-xl object-cover" />
              ) : (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber text-sm font-semibold uppercase text-white">
                  {user.username.slice(0, 1)}
                </span>
              )}
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

      {/* 小屏抽屉打开时的遮罩：点击即收起。
          z 必须比吸顶栏（z-30）高，否则顶栏会压在遮罩之上、抽屉滑过时不被压暗，
          看起来就是「导航栏与侧边栏互相覆盖」；侧栏本身 z-50 再压在遮罩之上。 */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
          aria-hidden
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 主区 */}
      <div className={`transition-all duration-300 ${sidebarOpen ? 'lg:ml-60' : 'lg:ml-0'}`}>
        <header className="sticky top-0 z-30 border-b border-gray-200/50 bg-warm/80 backdrop-blur-md dark:border-white/10 dark:bg-warm-dark/80">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8 md:py-4">
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
                <p className="hidden text-xs text-gray-400 sm:block">{meta.subtitle}</p>
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

        <main className="px-4 py-5 md:px-8 md:py-6">{routes}</main>
      </div>

      {toast}
    </div>
  )
}

export default App
