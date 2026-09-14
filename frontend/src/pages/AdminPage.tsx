// 管理设置页：打印代理状态、打印参数、anticraft 绑定应用与代理令牌（任务队列已移到「任务队列」页）
// 表现层用 Tailwind CSS v4 + lucide-react（暖色仪表盘配方见 AGENTS.md「前端约定」）
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  Copy,
  ListChecks,
  Loader2,
  Printer,
  RefreshCw,
  RotateCcw,
  Settings,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { api, getErrorMessage } from '../api'
import type { SettingsPayload } from '../api'
import Modal from '../components/Modal'
import TextField from '../components/TextField'
import { formatTime } from '../constants'
import type { Agent, Settings as SettingsData } from '../types/api'

const REFRESH_INTERVAL = 15000
/** 目标打印机下拉里的「手动输入」选项值 */
const CUSTOM_PRINTER = '__custom__'
/** 与后端 SECRET_MASK 一致：client_secret 已配置时只回显该掩码，提交掩码表示不修改 */
const MASKED_SECRET = '******'

/* ---------- 样式配方（照 AGENTS.md「前端约定」，保证与全站一致） ---------- */
const CARD = 'rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft'
const LABEL = 'mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400'
const INPUT =
  'w-full rounded-xl border border-gray-200 bg-warm px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 dark:border-white/10 dark:bg-white/5 dark:text-gray-100'
const HINT = 'mt-1.5 text-xs text-gray-400'
const BTN_PRIMARY =
  'inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60'
const BTN_SECONDARY =
  'inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/5 dark:text-gray-300'
const BTN_DANGER =
  'inline-flex items-center gap-1.5 rounded-xl bg-clay px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-clay/25 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60'
// 小号按钮：令牌区用（配方同上，只缩小尺寸，避免同组工具类互相覆盖）
const BTN_SM_SECONDARY =
  'inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/5 dark:text-gray-300'
const BTN_SM_DANGER =
  'inline-flex items-center gap-1 rounded-lg bg-clay px-3 py-1.5 text-xs font-medium text-white shadow-lg shadow-clay/25 transition-all duration-200 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60'
const ALERT_ERROR =
  'flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400'
const ALERT_OK = 'flex items-start gap-2 rounded-xl bg-brand/10 px-4 py-3 text-sm text-brand-dark dark:text-brand'
const ALERT_WARN = 'flex items-start gap-2 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay'

/** 设置里的布尔值以字符串存储，兼容常见写法 */
function isEnabled(value: string | null | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

function AdminPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentOnline, setAgentOnline] = useState(false)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')

  // 设置表单
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [launcher, setLauncher] = useState('sumatra')
  const [printerName, setPrinterName] = useState('')
  const [customPrinter, setCustomPrinter] = useState(false)
  const [copies, setCopies] = useState('1')
  const [dryRun, setDryRun] = useState(false)
  const [anticraftBase, setAnticraftBase] = useState('')
  const [anticraftClientId, setAnticraftClientId] = useState('')
  const [anticraftClientSecret, setAnticraftClientSecret] = useState('')
  const [anticraftOrigins, setAnticraftOrigins] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [rotating, setRotating] = useState(false)

  /** 只刷新代理状态（心跳 / 打印机列表），不碰表单里可能未保存的改动 */
  const loadAgentStatus = useCallback(async () => {
    try {
      const data = await api.getSettings()
      setAgents(data.agents)
      setAgentOnline(data.agent_online)
      setError('')
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }, [])

  /** 读取设置与代理状态（同时用于表单回显与「刷新」按钮） */
  const loadSettings = useCallback(async () => {
    try {
      const data = await api.getSettings()
      const printers = Array.from(new Set(data.agents.flatMap((agent) => agent.printers)))
      const saved = data.settings
      setSettings(saved)
      setLauncher(saved.launcher || 'sumatra')
      setPrinterName(saved.printer_name ?? '')
      setCustomPrinter(!!saved.printer_name && !printers.includes(saved.printer_name))
      setCopies(saved.copies || '1')
      setDryRun(isEnabled(saved.dry_run))
      setAnticraftBase(saved.anticraft_base ?? '')
      setAnticraftClientId(saved.anticraft_client_id ?? '')
      // 后端只回掩码，未配置时是空串；直接把返回值作为输入框初始内容
      setAnticraftClientSecret(saved.anticraft_client_secret ?? '')
      setAnticraftOrigins(saved.anticraft_origins ?? '')
      setAgents(data.agents)
      setAgentOnline(data.agent_online)
      setSettingsError('')
      setError('')
    } catch (err) {
      setSettingsError(getErrorMessage(err))
    }
  }, [])

  // 首次加载设置（含代理状态）+ 每 15 秒只刷新代理状态（卸载时清理定时器）
  useEffect(() => {
    void loadSettings()
    const timer = setInterval(() => {
      void loadAgentStatus()
    }, REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [loadSettings, loadAgentStatus])

  // 提示 4 秒后自动消失
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  // 复制成功反馈 2 秒后复位
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  /** 刷新：重新读取设置与代理状态；15 秒轮询只刷新代理状态 */
  async function handleRefresh() {
    setRefreshing(true)
    await loadSettings()
    setRefreshing(false)
  }

  async function handleSaveSettings() {
    const copiesValue = copies.trim()
    const parsed = Number(copiesValue)
    if (!copiesValue || !Number.isInteger(parsed) || parsed < 1) {
      setSettingsError('份数必须是大于 0 的整数')
      return
    }
    const anticraftValue = anticraftBase.trim()
    const payload: SettingsPayload = {
      launcher,
      printer_name: printerName.trim(),
      copies: copiesValue,
      dry_run: dryRun ? 'true' : 'false',
    }
    // 服务地址没改动就不提交，避免用空值覆盖后端已有配置
    if (anticraftValue !== (settings?.anticraft_base ?? '')) payload.anticraft_base = anticraftValue
    // 同上：只提交发生变化的字段
    const clientIdValue = anticraftClientId.trim()
    if (clientIdValue !== (settings?.anticraft_client_id ?? '')) payload.anticraft_client_id = clientIdValue
    // client_secret 后端只回掩码：只有用户真的输入了新值才提交（掩码与空串都不提交）
    const secretValue = anticraftClientSecret.trim()
    if (secretValue && secretValue !== MASKED_SECRET) payload.anticraft_client_secret = secretValue
    const originsValue = anticraftOrigins.trim()
    if (originsValue !== (settings?.anticraft_origins ?? '')) payload.anticraft_origins = originsValue

    setSaving(true)
    setSettingsError('')
    try {
      const saved = await api.saveSettings(payload)
      setSettings(saved)
      setAnticraftBase(saved.anticraft_base ?? '')
      setAnticraftClientId(saved.anticraft_client_id ?? '')
      // 保存后只保留「已配置」的掩码状态：POST 返回的是明文（GET 返回掩码），一律不把明文留在表单里
      setAnticraftClientSecret(saved.anticraft_client_secret ? MASKED_SECRET : '')
      setAnticraftOrigins(saved.anticraft_origins ?? '')
      setNotice('设置已保存，将在代理下次心跳时下发')
    } catch (err) {
      setSettingsError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleCopyToken() {
    const token = settings?.agent_token ?? ''
    if (!token) return
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
    } catch {
      setSettingsError('复制失败，请手动选择令牌文本复制')
    }
  }

  async function handleRotateToken() {
    setRotating(true)
    try {
      const token = await api.rotateAgentToken()
      setSettings((prev) => (prev ? { ...prev, agent_token: token } : prev))
      setRotateOpen(false)
      setNotice('代理令牌已重置，请把新令牌写入打印代理配置')
    } catch (err) {
      setSettingsError(getErrorMessage(err))
    } finally {
      setRotating(false)
    }
  }

  // 代理上报的本地打印机队列（去重）
  const printerOptions = Array.from(new Set(agents.flatMap((agent) => agent.printers)))

  return (
    <div className="space-y-6">
      {error && (
        <p className={ALERT_ERROR}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
      {notice && (
        <p className={ALERT_OK}>
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          {notice}
        </p>
      )}

      {/* 打印代理状态：红绿圆点 + 在线/离线文案，离线时给出警示 */}
      <section className={`${CARD} flex flex-wrap items-center gap-4`}>
        <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
          {agentOnline && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          )}
          <span
            className={`relative inline-flex h-3 w-3 rounded-full ${agentOnline ? 'bg-emerald-500' : 'bg-red-500'}`}
          />
        </span>
        <div className="min-w-[220px] flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            {agentOnline ? (
              <Wifi className="h-4 w-4 text-emerald-500" />
            ) : (
              <WifiOff className="h-4 w-4 text-red-500" />
            )}
            {agentOnline ? '打印代理在线' : '打印代理离线'}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            {agents.length === 0
              ? '尚未注册任何打印代理'
              : agents
                  .map(
                    (agent) =>
                      `${agent.name}${agent.version ? ` v${agent.version}` : ''} · 最后心跳 ${formatTime(agent.last_seen)} · 共 ${agent.printers.length} 台打印机`,
                  )
                  .join('；')}
          </p>
        </div>
        <button
          type="button"
          className={BTN_SM_SECONDARY}
          onClick={() => void handleRefresh()}
          disabled={refreshing}
        >
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          刷新
        </button>
        {!agentOnline && (
          <p className={`${ALERT_WARN} w-full`}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            代理离线时任务会堆积在队列中，审核通过后需等代理上线才会出纸
          </p>
        )}
      </section>

      {/* 打印设置 */}
      <section className={CARD}>
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
          <Settings className="h-5 w-5 text-brand" />
          打印设置
        </h2>

        {/* 出纸后的交接流转在「任务队列」页完成 */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-warm px-4 py-3 dark:bg-white/5">
          <p className="text-xs text-gray-400">
            打印成功的任务去「任务队列」页勾选「待配送 / 待取件」与「已完成」
          </p>
          <Link className={BTN_PRIMARY} to="/queue">
            <ListChecks className="h-4 w-4" />
            任务队列
          </Link>
        </div>

        {settingsError && (
          <p className={`${ALERT_ERROR} mt-4`}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {settingsError}
          </p>
        )}

        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="setting-launcher">
              启动器
            </label>
            <select
              id="setting-launcher"
              className={INPUT}
              value={launcher}
              onChange={(event) => setLauncher(event.target.value)}
            >
              <option value="sumatra">SumatraPDF</option>
              <option value="default">系统默认关联程序</option>
            </select>
          </div>

          <div>
            <label className={LABEL} htmlFor="setting-copies">
              份数
            </label>
            <input
              id="setting-copies"
              className={INPUT}
              type="number"
              min={1}
              value={copies}
              onChange={(event) => setCopies(event.target.value)}
            />
          </div>

          <div className="md:col-span-2">
            <label
              className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400"
              htmlFor="setting-printer"
            >
              <Printer className="h-3.5 w-3.5" />
              目标打印机
            </label>
            <select
              id="setting-printer"
              className={INPUT}
              value={customPrinter ? CUSTOM_PRINTER : printerName}
              onChange={(event) => {
                const value = event.target.value
                if (value === CUSTOM_PRINTER) {
                  setCustomPrinter(true)
                  return
                }
                setCustomPrinter(false)
                setPrinterName(value)
              }}
            >
              <option value="">（跟随代理本机默认打印机）</option>
              {printerOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              <option value={CUSTOM_PRINTER}>手动输入打印机名称…</option>
            </select>
            {customPrinter && (
              <div className="mt-3">
                <TextField
                  label="打印机名称"
                  name="printer-name"
                  value={printerName}
                  placeholder="例如：HP LaserJet Professional P1106"
                  onChange={(event) => setPrinterName(event.target.value)}
                />
              </div>
            )}
            <p className={HINT}>下拉选项来自代理上报的本机打印队列；名称需与 Windows 中的队列名完全一致</p>
          </div>

          <div className="md:col-span-2">
            <label className={LABEL} htmlFor="setting-anticraft-base">
              anticraft 服务地址
            </label>
            <input
              id="setting-anticraft-base"
              className={INPUT}
              value={anticraftBase}
              placeholder="https://anticraft.top"
              onChange={(event) => setAnticraftBase(event.target.value)}
            />
            <p className={HINT}>用于「anticraft 登录」，默认 https://anticraft.top</p>
          </div>

          <div>
            <label className={LABEL} htmlFor="setting-anticraft-client-id">
              anticraft 绑定应用 client_id
            </label>
            <input
              id="setting-anticraft-client-id"
              className={INPUT}
              value={anticraftClientId}
              onChange={(event) => setAnticraftClientId(event.target.value)}
            />
            <p className={HINT}>在 anticraft 后台「绑定应用」登记本应用后获得</p>
          </div>

          <div>
            <label className={LABEL} htmlFor="setting-anticraft-client-secret">
              anticraft 绑定应用 client_secret
            </label>
            <input
              id="setting-anticraft-client-secret"
              className={INPUT}
              type="password"
              autoComplete="new-password"
              value={anticraftClientSecret}
              onChange={(event) => setAnticraftClientSecret(event.target.value)}
              // 聚焦时清掉掩码占位，避免用户在原掩码后面接着输入
              onFocus={() => {
                if (anticraftClientSecret === MASKED_SECRET) setAnticraftClientSecret('')
              }}
            />
            <p className={HINT}>只在服务端使用；已配置时显示为 ******，留空表示不修改</p>
          </div>

          <div className="md:col-span-2">
            <label className={LABEL} htmlFor="setting-anticraft-origins">
              允许的授权来源
            </label>
            <input
              id="setting-anticraft-origins"
              className={INPUT}
              value={anticraftOrigins}
              placeholder="http://127.0.0.1:8301,http://localhost:3010"
              onChange={(event) => setAnticraftOrigins(event.target.value)}
            />
            <p className={HINT}>
              逗号分隔，需与 anticraft 登记的「回调地址」前缀一致，如 http://127.0.0.1:8301,http://localhost:3010
            </p>
          </div>
        </div>

        <label className="mt-5 inline-flex cursor-pointer items-center gap-2.5 rounded-xl bg-warm px-4 py-3 text-sm text-gray-700 dark:bg-white/5 dark:text-gray-300">
          <input
            type="checkbox"
            className="h-4 w-4 accent-brand"
            checked={dryRun}
            onChange={(event) => setDryRun(event.target.checked)}
          />
          <span>演练模式（不真实出纸）</span>
        </label>

        <div className="mt-5 rounded-2xl border border-gray-100 bg-warm p-4 dark:border-white/10 dark:bg-white/5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">代理令牌</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code
              className="min-w-0 flex-1 select-all truncate rounded-xl bg-white px-3 py-2 font-mono text-xs text-gray-600 shadow-sm dark:bg-ink dark:text-gray-300"
              title={settings?.agent_token || '（暂未生成）'}
            >
              {settings?.agent_token || '（暂未生成）'}
            </code>
            <button
              type="button"
              className={BTN_SM_SECONDARY}
              disabled={!settings?.agent_token}
              onClick={() => void handleCopyToken()}
            >
              <Copy className="h-3.5 w-3.5" />
              {copied ? '已复制' : '复制'}
            </button>
            <button
              type="button"
              className={BTN_SM_DANGER}
              disabled={!settings?.agent_token}
              onClick={() => setRotateOpen(true)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重置令牌
            </button>
          </div>
          <p className={HINT}>
            打印代理用该令牌（请求头 X-Agent-Token）领取与回报任务，重置后需同步更新代理配置
          </p>
        </div>

        <div className="mt-6 flex justify-end">
          <button type="button" className={BTN_PRIMARY} onClick={() => void handleSaveSettings()} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                保存中…
              </>
            ) : (
              <>
                <Check className="h-4 w-4" />
                保存设置
              </>
            )}
          </button>
        </div>
      </section>

      {/* 重置令牌确认弹窗 */}
      <Modal
        open={rotateOpen}
        title="重置代理令牌"
        onClose={() => setRotateOpen(false)}
        danger
        size="sm"
        footer={
          <>
            <button type="button" className={BTN_SECONDARY} onClick={() => setRotateOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className={BTN_DANGER}
              disabled={rotating}
              onClick={() => void handleRotateToken()}
            >
              {rotating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  重置中…
                </>
              ) : (
                '确认重置'
              )}
            </button>
          </>
        }
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          重置后旧令牌立即失效，打印代理会暂时无法领取任务，需要把新令牌写入代理配置后才能恢复。
        </p>
      </Modal>
    </div>
  )
}

export default AdminPage
