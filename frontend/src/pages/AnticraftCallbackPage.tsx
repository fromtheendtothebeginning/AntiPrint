// anticraft 授权回调落地页（公开页，无需登录）：用一次性 ticket 换本地登录态
// 后端授权成功后 302 到 /login/anticraft/callback?ticket=..，失败则带 ?error=<中文消息>
// 响应里的 bound 为 true 时是「我的配置 → 绑定 anticraft」的回跳，展示绑定成功并回 /profile
// 表现层：Tailwind（暖色仪表盘）+ lucide-react 图标，未登录布局下的居中卡片
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AlertCircle, CheckCircle2, Loader2, LogIn } from 'lucide-react'
import { api, getErrorMessage, setToken, setUser } from '../api'
import type { User } from '../types/api'

/** 成功后停留展示成功卡片的时长（毫秒），随后按角色跳转（绑定回跳则进「我的配置」） */
const SUCCESS_REDIRECT_MS = 1200

type Status = 'pending' | 'ok' | 'error'

/** 图标底色按状态取语义色：等待=主色、成功=翠绿、失败=红 */
const ICON_TONE: Record<Status, string> = {
  pending: 'bg-brand/10 text-brand',
  ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  error: 'bg-red-500/10 text-red-600 dark:text-red-400',
}

interface AnticraftCallbackPageProps {
  /** 兑换成功后把用户写回 App 状态，否则路由守卫会把随后的跳转打回登录页 */
  onLogin: (user: User) => void
}

function AnticraftCallbackPage({ onLogin }: AnticraftCallbackPageProps) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const errorParam = (searchParams.get('error') ?? '').trim()
  const ticket = (searchParams.get('ticket') ?? '').trim()

  /** 票据只能兑换一次：React 18 开发模式下 useEffect 会跑两次，用标志位拦截第二次 */
  const startedRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const [status, setStatus] = useState<Status>(() => (errorParam || !ticket ? 'error' : 'pending'))
  const [errorText, setErrorText] = useState(() => errorParam || (ticket ? '' : '缺少登录票据，请重新登录'))
  const [profile, setProfile] = useState<User | null>(null)
  const [autoRegistered, setAutoRegistered] = useState(false)
  /** true = 本次是「我的配置 → 绑定 anticraft」的回跳（后端返回 bound） */
  const [bound, setBound] = useState(false)

  useEffect(() => {
    // 只有落地时带 ticket 才兑换；带 error 或没有票据的情况直接展示提示，不做任何请求
    if (startedRef.current || errorParam || !ticket) return
    startedRef.current = true
    api
      .exchangeAnticraftTicket(ticket)
      .then((data) => {
        setToken(data.token)
        setUser(data.user)
        setProfile(data.user)
        setAutoRegistered(data.auto_registered)
        const isBound = data.bound === true
        setBound(isBound)
        setStatus('ok')
        // 先停留展示成功卡片，再把用户写回 App 状态：绑定回跳到「我的配置」，登录按角色跳转
        timerRef.current = window.setTimeout(() => {
          onLogin(data.user)
          navigate(isBound ? '/profile' : data.user.role === 'admin' ? '/admin' : '/submit', {
            replace: true,
          })
        }, SUCCESS_REDIRECT_MS)
      })
      .catch((err: unknown) => {
        setStatus('error')
        setErrorText(getErrorMessage(err))
      })
  }, [errorParam, ticket, navigate, onLogin])

  // 卸载时清掉跳转定时器，避免用户中途离开后又被拉回跳转目标
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-2xl bg-white p-6 text-center shadow-xl shadow-black/[0.04] dark:bg-ink-soft">
        <span
          className={`flex h-12 w-12 items-center justify-center rounded-2xl ${ICON_TONE[status]}`}
          aria-hidden="true"
        >
          {status === 'pending' ? (
            <Loader2 className="h-6 w-6 animate-spin" />
          ) : status === 'ok' ? (
            <CheckCircle2 className="h-6 w-6" />
          ) : (
            <AlertCircle className="h-6 w-6" />
          )}
        </span>

        {status === 'pending' && (
          <>
            <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">正在登录…</h1>
            <p className="text-sm text-gray-400">正在用 anticraft 授权票据换取登录状态，请稍候</p>
          </>
        )}

        {status === 'ok' && profile && bound && (
          <>
            <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">anticraft 账号绑定成功</h1>
            <p className="text-sm text-gray-400">已绑定到当前 AntiPrint 账号</p>
          </>
        )}

        {status === 'ok' && profile && !bound && (
          <>
            <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">登录成功</h1>
            <p className="text-sm text-gray-400">已登录为 {profile.username}</p>
            {autoRegistered && <p className="text-sm text-gray-400">已自动创建 AntiPrint 账号</p>}
            <p className="text-sm text-gray-400">正在进入{profile.role === 'admin' ? '管理后台' : '提交打印页'}…</p>
          </>
        )}

        {status === 'error' && (
          <>
            <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">登录失败</h1>
            <p className="flex w-full items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-left text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{errorText}</span>
            </p>
            <Link
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl dark:bg-white/5 dark:text-gray-300"
              to="/login"
            >
              <LogIn className="h-4 w-4" />
              返回登录
            </Link>
          </>
        )}
      </div>
    </div>
  )
}

export default AnticraftCallbackPage
