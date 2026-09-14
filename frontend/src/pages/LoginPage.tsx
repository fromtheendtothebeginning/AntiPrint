// 登录 / 注册 / anticraft 登录页：成功后写入令牌与用户缓存，管理员跳管理页、普通用户跳提交页
// 表现层：Tailwind（暖色仪表盘）+ lucide-react 图标，未登录布局下的居中卡片
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, CheckCircle2, Loader2, LogIn, Printer, ShieldCheck, UserPlus } from 'lucide-react'
import { api, getErrorMessage, setToken, setUser } from '../api'
import TextField from '../components/TextField'
import type { AnticraftOauthStatus, User } from '../types/api'

type Tab = 'login' | 'register' | 'anticraft'

/** 自动建号后停留展示成功提示的时长（毫秒） */
const AUTO_REGISTERED_NOTICE_MS = 1500

/** 在 anticraft 后台登记「回调地址」时要填的地址（后端 OAuth 回调，不是前端落地页） */
const OAUTH_CALLBACK_PATH = '/api/oauth/anticraft/callback'

/** 主按钮配方（AGENTS.md「前端约定」）；整宽按钮再补 w-full justify-center */
const BTN_PRIMARY =
  'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60'

interface LoginPageProps {
  /** 登录成功后把用户写回 App 状态 */
  onLogin: (user: User) => void
}

function LoginPage({ onLogin }: LoginPageProps) {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  /** null 表示状态未知（加载中或查询失败），此时不拦截跳转，由后端给出提示 */
  const [oauthStatus, setOauthStatus] = useState<AnticraftOauthStatus | null>(null)

  // 查询是否已配置 anticraft 绑定应用：未配置时禁用跳转按钮并给出配置指引
  useEffect(() => {
    let active = true
    api
      .getAnticraftOauthStatus()
      .then((status) => {
        if (active) setOauthStatus(status)
      })
      .catch(() => {
        if (active) setOauthStatus(null)
      })
    return () => {
      active = false
    }
  }, [])

  function switchTab(next: Tab) {
    setTab(next)
    setError('')
    setNotice('')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')
    const name = username.trim()
    if (!name || !password) {
      setError('请填写用户名和密码')
      return
    }
    if (tab === 'register') {
      if (name.length < 2) {
        setError('用户名至少 2 个字符')
        return
      }
      if (password.length < 6) {
        setError('密码至少 6 位')
        return
      }
    }

    setLoading(true)
    try {
      let result: { token: string; user: User }
      let autoRegistered = false
      if (tab === 'anticraft') {
        const data = await api.loginAnticraft(name, password)
        result = data
        autoRegistered = data.auto_registered
      } else {
        result = tab === 'login' ? await api.login(name, password) : await api.register(name, password)
      }
      setToken(result.token)
      setUser(result.user)
      // onLogin 会立刻触发 App 的路由重定向，因此自动建号时先展示提示再跳转
      if (autoRegistered) {
        setNotice('已自动创建 AntiPrint 账号')
        window.setTimeout(() => {
          onLogin(result.user)
          navigate(result.user.role === 'admin' ? '/admin' : '/submit', { replace: true })
        }, AUTO_REGISTERED_NOTICE_MS)
        return
      }
      onLogin(result.user)
      navigate(result.user.role === 'admin' ? '/admin' : '/submit', { replace: true })
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  /** 发起授权：必须走浏览器整页跳转（后端 302 到 anticraft 授权页），不能用 fetch */
  function handleOauthLogin() {
    window.location.href = `/api/oauth/anticraft/start?origin=${encodeURIComponent(window.location.origin)}`
  }

  const submitLabel = tab === 'login' ? '登录' : tab === 'register' ? '注册并登录' : 'anticraft 登录'
  const loadingLabel = tab === 'register' ? '注册中…' : '登录中…'
  /** 已确认未配置绑定应用时禁用跳转按钮（状态未知则仍可尝试） */
  const oauthDisabled = oauthStatus !== null && !oauthStatus.enabled
  /** Tab 与主按钮的图标（禁止 emoji，一律 lucide 简笔图标） */
  const SubmitIcon = tab === 'register' ? UserPlus : tab === 'anticraft' ? ShieldCheck : LogIn

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="mx-auto w-full max-w-md rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-white shadow-lg shadow-brand/25">
            <Printer className="h-6 w-6" />
          </span>
          <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">AntiPrint · 远程打印</h1>
          <p className="text-xs leading-relaxed text-gray-400">
            上传文件并填写配送地址，管理员审核后由本机打印代理静默出纸
          </p>
        </div>

        {/* Tab 用 role="tab"（不是 button）：测试脚本靠它把 Tab 与文案相同的主按钮区分开 */}
        <div className="mb-5 flex gap-1 rounded-xl bg-gray-100 p-1 dark:bg-white/5" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'login'}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-all duration-200 ${
              tab === 'login'
                ? 'bg-white font-semibold text-brand shadow-sm dark:bg-white/10'
                : 'font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
            onClick={() => switchTab('login')}
          >
            <LogIn className="h-4 w-4" />
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'register'}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-all duration-200 ${
              tab === 'register'
                ? 'bg-white font-semibold text-brand shadow-sm dark:bg-white/10'
                : 'font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
            onClick={() => switchTab('register')}
          >
            <UserPlus className="h-4 w-4" />
            注册
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'anticraft'}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-all duration-200 ${
              tab === 'anticraft'
                ? 'bg-white font-semibold text-brand shadow-sm dark:bg-white/10'
                : 'font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
            onClick={() => switchTab('anticraft')}
          >
            <ShieldCheck className="h-4 w-4" />
            anticraft 登录
          </button>
        </div>

        {notice && (
          <p className="mb-4 flex items-start gap-2 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{notice}</span>
          </p>
        )}

        {tab === 'anticraft' && (
          <div className="mb-4 space-y-3">
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={oauthDisabled}
              onClick={handleOauthLogin}
            >
              <ShieldCheck className="h-4 w-4" />
              用 anticraft 登录（跳转授权）
            </button>
            {oauthDisabled && (
              <p className="flex items-start gap-2 rounded-xl bg-amber/15 px-4 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  尚未配置 anticraft 绑定应用：请管理员在 anticraft 后台登记本应用（回调地址填{' '}
                  <code className="break-all rounded bg-white/60 px-1 py-0.5 font-mono text-[11px] dark:bg-white/10">{`${window.location.origin}${OAUTH_CALLBACK_PATH}`}</code>
                  ），再把 client_id / client_secret 填进「打印设置」
                </span>
              </p>
            )}
            <div className="flex items-center gap-2.5 text-xs text-gray-400">
              <span className="h-px flex-1 bg-gray-200 dark:bg-white/10" />
              <span>备用方式：不走跳转，直接用 anticraft 账号密码登录</span>
              <span className="h-px flex-1 bg-gray-200 dark:bg-white/10" />
            </div>
          </div>
        )}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <TextField
            label="用户名"
            id="login-username"
            name="username"
            value={username}
            autoComplete="username"
            placeholder="请输入用户名"
            disabled={loading}
            onChange={(event) => setUsername(event.target.value)}
          />
          <TextField
            label="密码"
            id="login-password"
            name="password"
            type="password"
            value={password}
            autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
            placeholder="请输入密码"
            disabled={loading}
            onChange={(event) => setPassword(event.target.value)}
          />

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </p>
          )}

          <button type="submit" className={BTN_PRIMARY} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {loadingLabel}
              </>
            ) : (
              <>
                <SubmitIcon className="h-4 w-4" />
                {submitLabel}
              </>
            )}
          </button>
        </form>

        {tab === 'login' && <p className="mt-5 text-center text-xs text-gray-400">管理员默认账号：admin / admin123</p>}
        {tab === 'register' && (
          <p className="mt-5 text-center text-xs text-gray-400">注册后自动登录；提交的任务需管理员审核通过后才会打印</p>
        )}
        {tab === 'anticraft' && (
          <p className="mt-5 text-center text-xs text-gray-400">
            使用 anticraft.top 账号登录；AntiPrint 没有该账号时会自动创建，密码与 anticraft 保持一致
          </p>
        )}
      </div>
    </div>
  )
}

export default LoginPage
