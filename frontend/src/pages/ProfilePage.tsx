// 我的配置页：默认配送方式 / 默认配送地址 / anticraft 账号绑定
// 表现层：Tailwind（暖色仪表盘）+ lucide-react 图标；卡片、按钮、提示条配方见 AGENTS.md「前端约定」
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MapPin,
  PackageCheck,
  RefreshCw,
  Save,
  ShieldCheck,
  ShieldOff,
  Truck,
  Unlink,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api, getErrorMessage } from '../api'
import Modal from '../components/Modal'
import TextField from '../components/TextField'
import { DELIVER, PICKUP } from '../constants'
import type { DeliveryMode } from '../constants'
import type { AnticraftOauthStatus, Profile } from '../types/api'

/** 「已保存 / 已解绑」提示的停留时长（毫秒） */
const NOTICE_MS = 3000

/** 配送方式选项：值就是提交页使用的字面量（与后端 constants.py 同步），副标题说明各自含义 */
const DELIVERY_OPTIONS: { value: DeliveryMode; hint: string; Icon: LucideIcon }[] = [
  { value: DELIVER, hint: '打印完送到地址', Icon: Truck },
  { value: PICKUP, hint: '自己来取', Icon: PackageCheck },
]

// 全站统一配方（AGENTS.md「前端约定」）：主按钮 / 次按钮 / 危险按钮 / 语义提示条
const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60'
const BTN_SECONDARY =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/5 dark:text-gray-300'
const BTN_DANGER =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-clay px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-clay/25 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60'
const ALERT_ERROR = 'flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400'
const ALERT_OK =
  'flex items-start gap-2 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400'
const ALERT_WARN = 'flex items-start gap-2 rounded-xl bg-amber/15 px-4 py-3 text-sm text-amber-700 dark:text-amber'

/** 内容卡片（配方同上，页面内三块共用） */
const CARD = 'rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft'
/** 加载中 / 加载失败时的空状态容器 */
const EMPTY_CARD =
  'mx-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white/60 px-6 py-16 text-center text-sm text-gray-400 dark:border-white/10 dark:bg-white/5'

interface SectionHeaderProps {
  Icon: LucideIcon
  title: string
  subtitle?: string
  /** 图标底色：默认主色，绑定状态按语义色覆盖 */
  tone?: string
}

/** 卡片标题行：方形图标 + 标题 + 说明（与提交页的卡片头一致） */
function SectionHeader({ Icon, title, subtitle, tone = 'bg-brand/10 text-brand-dark dark:text-brand' }: SectionHeaderProps) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">{title}</h2>
        {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
      </div>
    </div>
  )
}

function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)

  // 默认配送配置表单（两块共用一个保存按钮）
  const [address, setAddress] = useState('')
  const [delivery, setDelivery] = useState<DeliveryMode>(DELIVER)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveNotice, setSaveNotice] = useState('')

  // anticraft 绑定
  const [oauthStatus, setOauthStatus] = useState<AnticraftOauthStatus | null>(null)
  const [binding, setBinding] = useState(false)
  const [bindError, setBindError] = useState('')
  const [bindNotice, setBindNotice] = useState('')
  const [unbindOpen, setUnbindOpen] = useState(false)
  const [unbindPassword, setUnbindPassword] = useState('')
  const [unbindError, setUnbindError] = useState('')
  const [unbinding, setUnbinding] = useState(false)

  /** 拉取当前配置，并同步到表单（后端存的是「配送 / 取件」字面量） */
  const loadProfile = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getProfile()
      setProfile(data)
      setAddress(data.default_address)
      setDelivery(data.default_delivery === PICKUP ? PICKUP : DELIVER)
      setLoadError('')
    } catch (err) {
      setLoadError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadProfile()
  }, [loadProfile])

  // 是否已配置 anticraft 绑定应用：未知（加载中 / 查询失败）时不拦跳转，由后端返回中文提示
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

  // 保存 / 解绑提示几秒后自动消失
  useEffect(() => {
    if (!saveNotice && !bindNotice) return
    const timer = window.setTimeout(() => {
      setSaveNotice('')
      setBindNotice('')
    }, NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [saveNotice, bindNotice])

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setSaveError('')
    setSaveNotice('')
    try {
      const data = await api.saveProfile({
        default_address: address.trim(),
        default_delivery: delivery,
      })
      setProfile(data)
      setAddress(data.default_address)
      setDelivery(data.default_delivery === PICKUP ? PICKUP : DELIVER)
      setSaveNotice('已保存')
    } catch (err) {
      setSaveError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  /** 发起绑定：先领一次性票据，再整页跳转授权（后端 302 到 anticraft，fetch 走不通） */
  async function handleBind() {
    setBinding(true)
    setBindError('')
    setBindNotice('')
    try {
      const ticket = await api.anticraftBindTicket()
      window.location.href =
        '/api/oauth/anticraft/start?origin=' +
        encodeURIComponent(window.location.origin) +
        '&bind_ticket=' +
        encodeURIComponent(ticket)
    } catch (err) {
      setBindError(getErrorMessage(err))
      setBinding(false)
    }
  }

  function openUnbind() {
    setUnbindPassword('')
    setUnbindError('')
    setUnbindOpen(true)
  }

  /** 解除绑定：必须同时设置本地密码，否则授权建号的账号解绑后无法登录 */
  async function handleUnbind() {
    const password = unbindPassword.trim()
    if (password.length < 6) {
      setUnbindError('请设置至少 6 位的本地密码（解绑后用它登录）')
      return
    }
    setUnbinding(true)
    setUnbindError('')
    try {
      const data = await api.unbindAnticraft(password)
      setProfile(data)
      setUnbindOpen(false)
      setUnbindPassword('')
      setBindNotice('已解除 anticraft 绑定，请用新设置的密码登录')
    } catch (err) {
      setUnbindError(getErrorMessage(err))
    } finally {
      setUnbinding(false)
    }
  }

  if (loading) {
    return (
      <section className={EMPTY_CARD}>
        <Loader2 className="h-6 w-6 animate-spin" />
        正在加载配置…
      </section>
    )
  }

  if (!profile) {
    return (
      <section className={EMPTY_CARD}>
        <AlertCircle className="h-6 w-6 text-clay" />
        <p className="text-clay">{loadError || '加载配置失败，请重试'}</p>
        <button type="button" className={BTN_SECONDARY} onClick={() => void loadProfile()}>
          <RefreshCw className="h-4 w-4" />
          重新加载
        </button>
      </section>
    )
  }

  /** 已确认未配置绑定应用时禁用绑定按钮（状态未知则仍可尝试） */
  const bindDisabled = binding || (oauthStatus !== null && !oauthStatus.enabled)

  return (
    <>
      <div className="mx-auto w-full max-w-2xl space-y-6">
        {/* 默认配送配置：配送方式与地址共用「保存配置」 */}
        <form className="space-y-6" onSubmit={handleSave}>
          <section className={CARD}>
            <SectionHeader
              Icon={Truck}
              title="默认配送方式"
              subtitle="提交打印时会按这里的默认值预填，单次提交仍可改"
            />
            <div
              className="flex gap-1 rounded-xl bg-gray-100 p-1 dark:bg-white/5"
              role="radiogroup"
              aria-label="默认配送方式"
            >
              {DELIVERY_OPTIONS.map(({ value, hint, Icon }) => {
                const active = delivery === value
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={saving}
                    onClick={() => setDelivery(value)}
                    className={`flex flex-1 flex-col items-center gap-0.5 rounded-lg px-3 py-2.5 text-sm transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 ${
                      active
                        ? 'bg-white font-semibold text-brand shadow-sm dark:bg-white/10'
                        : 'font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Icon className="h-4 w-4" />
                      {value}
                    </span>
                    <span className="text-xs font-normal text-gray-400">{hint}</span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className={CARD}>
            <SectionHeader Icon={MapPin} title="默认配送地址" />
            <TextField
              label="默认配送地址"
              name="default_address"
              value={address}
              placeholder="例如：三教 305 教室靠窗第一排 / 5 号宿舍楼 402"
              disabled={saving}
              onChange={(event) => setAddress(event.target.value)}
            />
            <p className="mt-1.5 text-xs text-gray-400">提交打印时自动填入；选「取件」时可不填</p>

            {saveError && (
              <p className={`mt-4 ${ALERT_ERROR}`}>
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{saveError}</span>
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button type="submit" className={BTN_PRIMARY} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    保存中…
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    保存配置
                  </>
                )}
              </button>
              {saveNotice && (
                <span role="status" className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  {saveNotice}
                </span>
              )}
            </div>
          </section>
        </form>

        {/* anticraft 账号绑定 */}
        <section className={CARD}>
          <SectionHeader
            Icon={profile.anticraft_bound ? ShieldCheck : ShieldOff}
            title="anticraft 账号绑定"
            subtitle="绑定后可用 anticraft 账号一键登录本站"
            tone={
              profile.anticraft_bound
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-brand/10 text-brand-dark dark:text-brand'
            }
          />

          {profile.anticraft_bound ? (
            <div className="space-y-4">
              <p className={ALERT_OK}>
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  已绑定 anticraft 账号
                  <span className="mt-1 block text-xs opacity-80">
                    anticraft 用户 ID：{profile.anticraft_id ?? '—'}
                  </span>
                </span>
              </p>
              <p className="text-xs text-gray-400">绑定后可从这里登录</p>
              <button type="button" className={BTN_SECONDARY} onClick={openUnbind}>
                <Unlink className="h-4 w-4" />
                解除绑定
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">绑定后可用 anticraft 账号一键登录本站</p>
              <button type="button" className={BTN_PRIMARY} disabled={bindDisabled} onClick={handleBind}>
                {binding ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在跳转…
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-4 w-4" />
                    绑定 anticraft 账号
                  </>
                )}
              </button>

              {bindDisabled && !binding && (
                <p className={ALERT_WARN}>
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>尚未配置 anticraft 绑定应用，请管理员在「管理设置」里填写 client_id / client_secret</span>
                </p>
              )}
              {bindError && (
                <p className={ALERT_ERROR}>
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{bindError}</span>
                </p>
              )}
              {bindNotice && (
                <p role="status" className={ALERT_OK}>
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{bindNotice}</span>
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      <Modal
        open={unbindOpen}
        title="解除 anticraft 绑定"
        danger
        onClose={() => setUnbindOpen(false)}
        footer={
          <>
            <button type="button" className={BTN_SECONDARY} disabled={unbinding} onClick={() => setUnbindOpen(false)}>
              取消
            </button>
            <button type="button" className={BTN_DANGER} disabled={unbinding} onClick={handleUnbind}>
              {unbinding ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  解绑中…
                </>
              ) : (
                <>
                  <Unlink className="h-4 w-4" />
                  确认解绑
                </>
              )}
            </button>
          </>
        }
      >
        <p>解绑后无法再用 anticraft 账号进入本站，请设置一个新的本地密码（至少 6 位），解绑后用它在本站登录。</p>
        <TextField
          label="新的本地密码"
          type="password"
          autoComplete="new-password"
          placeholder="至少 6 位"
          value={unbindPassword}
          disabled={unbinding}
          onChange={(event) => setUnbindPassword(event.target.value)}
        />
        {unbindError && (
          <p className={ALERT_ERROR}>
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{unbindError}</span>
          </p>
        )}
      </Modal>
    </>
  )
}

export default ProfilePage
