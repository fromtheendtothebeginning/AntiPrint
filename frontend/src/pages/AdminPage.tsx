// 管理设置页：打印代理状态、打印参数、anticraft 绑定应用与代理令牌（任务队列已移到「任务队列」页）
// 表现层用 Tailwind CSS v4 + lucide-react（暖色仪表盘配方见 AGENTS.md「前端约定」）
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  Coins,
  Copy,
  Link2,
  ListChecks,
  Loader2,
  Plus,
  Trash2,
  Plug,
  Printer,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Unplug,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { api, getErrorMessage } from '../api'
import type { SettingsPayload } from '../api'
import Modal from '../components/Modal'
import TextField from '../components/TextField'
import { ROLE_LABEL, formatTime } from '../constants'
import type { AdminUserRow, Agent, Settings as SettingsData } from '../types/api'

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
const TH = 'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400'
const TD = 'px-4 py-3 text-sm text-gray-600 dark:text-gray-300'

/** 二级菜单：管理页按功能分栏，避免一屏堆到底 */
const TABS = [
  { key: 'printer', label: '打印设置', Icon: Printer },
  { key: 'billing', label: '打印计费', Icon: Coins },
  { key: 'whitelist', label: '免费白名单', Icon: BadgeCheck },
  { key: 'admins', label: '管理员名单', Icon: ShieldCheck },
  { key: 'anticraft', label: 'anticraft 绑定', Icon: Link2 },
  { key: 'agent', label: '打印代理', Icon: Wifi },
] as const
type AdminTab = (typeof TABS)[number]['key']

/** 逗号分隔的名字 → 数组（去空、去重） */
function parseNames(value: string): string[] {
  return Array.from(new Set(value.split(/[,，;；\s]+/).map((name) => name.trim()).filter(Boolean)))
}

/** 设置里的布尔值以字符串存储，兼容常见写法 */
function isEnabled(value: string | null | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

function AdminPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentOnline, setAgentOnline] = useState(false)
  /** 代理连接开关（'0' = 已被管理员断开）：断开时代理所有请求 403 */
  const [agentEnabled, setAgentEnabled] = useState(true)
  const [agentLinkBusy, setAgentLinkBusy] = useState(false)
  /** 断开连接确认弹窗（重新连接不需要确认） */
  const [disconnectOpen, setDisconnectOpen] = useState(false)
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
  const [anticraftAdminUsers, setAnticraftAdminUsers] = useState('')
  /** 每张打印单价（元）与免费白名单（用户名，逗号分隔） */
  const [printPrice, setPrintPrice] = useState('0.1')
  /** 当前二级菜单 */
  const [tab, setTab] = useState<AdminTab>('printer')
  /** 用户表：名单里的名字对不对得上账号，一眼能看出来 */
  const [userRows, setUserRows] = useState<AdminUserRow[]>([])
  const [newFreeUser, setNewFreeUser] = useState('')
  const [newAdminUser, setNewAdminUser] = useState('')
  const [listBusy, setListBusy] = useState(false)
  const [freeUsers, setFreeUsers] = useState('')
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
      setAgentEnabled(isEnabled(data.settings.agent_enabled))
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
      setAnticraftAdminUsers(saved.anticraft_admin_users ?? '')
      setPrintPrice(saved.print_price || '0.1')
      setFreeUsers(saved.free_users ?? '')
      setAnticraftClientId(saved.anticraft_client_id ?? '')
      // 后端只回掩码，未配置时是空串；直接把返回值作为输入框初始内容
      setAnticraftClientSecret(saved.anticraft_client_secret ?? '')
      setAnticraftOrigins(saved.anticraft_origins ?? '')
      setAgents(data.agents)
      setAgentOnline(data.agent_online)
      setAgentEnabled(isEnabled(data.settings.agent_enabled))
      setSettingsError('')
      setError('')
    } catch (err) {
      setSettingsError(getErrorMessage(err))
    }
  }, [])

  // 首次加载设置（含代理状态）+ 每 15 秒只刷新代理状态（卸载时清理定时器）
  useEffect(() => {
    void loadSettings()
    // 名单表格要把用户名和真实账号对应起来（写错的名字不会生效）
    void api
      .listUsers()
      .then((list) => setUserRows(list))
      .catch(() => undefined)
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

  /** 断开 / 重新连接打印代理：成功后用返回的最新状态刷新代理区 */
  async function handleAgentLink(connected: boolean) {
    setAgentLinkBusy(true)
    setNotice('')
    try {
      const data = await api.setAgentLink(connected)
      setAgents(data.agents)
      setAgentOnline(data.agent_online)
      setAgentEnabled(isEnabled(data.settings.agent_enabled))
      setSettings((prev) => (prev ? { ...prev, agent_enabled: data.settings.agent_enabled } : prev))
      setNotice(
        connected
          ? '打印代理已重新连接，代理会在下个心跳（最多 30 秒）内自动恢复领任务'
          : '已断开打印代理：它不会再领取任务，已通过的任务会排队等待，恢复后自动继续',
      )
      setError('')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setAgentLinkBusy(false)
      setDisconnectOpen(false)
    }
  }

  /** 刷新：重新读取设置与代理状态；15 秒轮询只刷新代理状态 */
  async function handleRefresh() {
    setRefreshing(true)
    await loadSettings()
    setRefreshing(false)
  }

  /** 名单类设置（免费白名单 / anticraft 管理员名单）：直接提交新的一份逗号分隔值 */
  async function saveNames(field: 'free_users' | 'anticraft_admin_users', names: string[]) {
    setListBusy(true)
    setSettingsError('')
    try {
      const value = names.join(',')
      const saved = await api.saveSettings(
        field === 'free_users' ? { free_users: value } : { anticraft_admin_users: value },
      )
      setFreeUsers(saved.free_users ?? '')
      setAnticraftAdminUsers(saved.anticraft_admin_users ?? '')
      setSettings(saved)
      setNotice('名单已保存')
    } catch (err) {
      setSettingsError(getErrorMessage(err))
    } finally {
      setListBusy(false)
    }
  }

  /** 名单里追加一个名字（重复/为空直接忽略） */
  async function addName(field: 'free_users' | 'anticraft_admin_users', raw: string) {
    const name = raw.trim()
    if (!name) return
    const current = parseNames(field === 'free_users' ? freeUsers : anticraftAdminUsers)
    if (current.includes(name)) {
      setSettingsError(`${name} 已在名单里`)
      return
    }
    await saveNames(field, [...current, name])
    if (field === 'free_users') setNewFreeUser('')
    else setNewAdminUser('')
  }

  /** 名单里移除一个名字 */
  async function removeName(field: 'free_users' | 'anticraft_admin_users', name: string) {
    const current = parseNames(field === 'free_users' ? freeUsers : anticraftAdminUsers)
    await saveNames(field, current.filter((item) => item !== name))
  }

  /** 名单数组与「用户名 → 账号」索引：表格用，写错的名字一眼看出来 */
  const freeNames = parseNames(freeUsers)
  const adminNames = parseNames(anticraftAdminUsers)
  const usersByName = new Map(userRows.map((row) => [row.username, row]))

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
      copies: copiesValue,
      dry_run: dryRun ? 'true' : 'false',
    }
    // 打印机名称为空时不提交（避免把「跟随代理默认」写成一个空值覆盖后端配置）
    if (printerName.trim()) payload.printer_name = printerName.trim()
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
    const adminUsersValue = anticraftAdminUsers.trim()
    if (adminUsersValue !== (settings?.anticraft_admin_users ?? '')) payload.anticraft_admin_users = adminUsersValue
    const priceValue = printPrice.trim() || '0.1'
    if (priceValue !== (settings?.print_price ?? '')) payload.print_price = priceValue
    const freeUsersValue = freeUsers.trim()
    if (freeUsersValue !== (settings?.free_users ?? '')) payload.free_users = freeUsersValue

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

      {/* 二级菜单：各功能分栏，避免一屏堆到底 */}
      <nav className="flex flex-wrap gap-2" aria-label="管理设置子菜单">
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            aria-current={tab === key ? 'page' : undefined}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition-all duration-200 ${
              tab === key
                ? 'bg-brand text-white shadow-lg shadow-brand/25'
                : 'bg-white text-gray-500 shadow-sm shadow-black/5 hover:-translate-y-0.5 hover:bg-warm dark:bg-ink-soft dark:text-gray-400 dark:hover:bg-white/5'
            }`}
            onClick={() => setTab(key)}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </nav>

      {/* 打印代理状态：圆点 + 在线/离线/已断开文案；可在此断开或重新连接代理 */}
{tab === 'agent' && (
        <>
      <section className={`${CARD} flex flex-wrap items-center gap-4`}>
        <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
          {agentOnline && agentEnabled && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          )}
          <span
            className={`relative inline-flex h-3 w-3 rounded-full ${
              !agentEnabled ? 'bg-gray-400' : agentOnline ? 'bg-emerald-500' : 'bg-red-500'
            }`}
          />
        </span>
        <div className="min-w-[220px] flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            {!agentEnabled ? (
              <Unplug className="h-4 w-4 text-gray-400" />
            ) : agentOnline ? (
              <Wifi className="h-4 w-4 text-emerald-500" />
            ) : (
              <WifiOff className="h-4 w-4 text-red-500" />
            )}
            {!agentEnabled ? '打印代理已断开' : agentOnline ? '打印代理在线' : '打印代理离线'}
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
        {agentEnabled ? (
          <button
            type="button"
            className={BTN_SM_DANGER}
            disabled={agentLinkBusy}
            onClick={() => setDisconnectOpen(true)}
          >
            {agentLinkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
            断开连接
          </button>
        ) : (
          <button
            type="button"
            className={BTN_SM_SECONDARY}
            disabled={agentLinkBusy}
            onClick={() => void handleAgentLink(true)}
          >
            {agentLinkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
            重新连接
          </button>
        )}
        {!agentEnabled && (
          <p className={`${ALERT_WARN} w-full`}>
            <Unplug className="mt-0.5 h-4 w-4 shrink-0" />
            已断开：打印代理的注册、心跳、领取任务、下载文件与回报都会被拒绝（本机代理进程仍在运行，只是连不上服务端）。
            已通过的任务只是排队等待，点「重新连接」后最多 30 秒自动恢复。
          </p>
        )}
        {agentEnabled && !agentOnline && (
          <p className={`${ALERT_WARN} w-full`}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            代理离线时任务会堆积在队列中，审核通过后需等代理上线才会出纸
          </p>
        )}
      </section>

        </>
      )}
      
      {/* 断开连接确认（可逆操作，但会停止出纸，所以二次确认） */}
      <Modal
        open={disconnectOpen}
        title="断开打印代理连接"
        size="sm"
        danger
        onClose={() => setDisconnectOpen(false)}
        footer={
          <>
            <button type="button" className={BTN_SM_SECONDARY} onClick={() => setDisconnectOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className={BTN_SM_DANGER}
              disabled={agentLinkBusy}
              onClick={() => void handleAgentLink(false)}
            >
              {agentLinkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
              断开连接
            </button>
          </>
        }
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          断开后，打印代理的<strong>注册、心跳、领取任务、下载文件、回报结果</strong>都会被服务端拒绝，
          期间<strong>不会有任何任务出纸</strong>，已通过的任务只是排队等待。
        </p>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          本机代理进程不受影响、会继续轮询；随时可以在本页点「重新连接」恢复（最多 30 秒生效）。
        </p>
      </Modal>

{tab === 'printer' && (
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
              {/* 虚拟队列会让 SumatraPDF 的 -silent 卡到 90 秒超时、任务判失败，这里明确警告 */}
              {/print to pdf|onenote|xps|fax/i.test(printerName) && (
                <p className="mt-2 flex items-start gap-2 rounded-xl bg-clay/10 px-3 py-2 text-xs text-clay">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  这是虚拟打印机队列，静默打印会卡满 90 秒后判失败；请选择真实打印机（如 HP LaserJet Professional P1106）。
                </p>
              )}
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
      )}

      {tab === 'billing' && (
        <section className={CARD}>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
            <Coins className="h-5 w-5 text-brand" />
            打印计费
          </h2>
          <p className={HINT}>
            管理员/root、anticraft 账号与白名单（见「免费白名单」）免费；其余账号按「张数 × 单价」从余额扣除
            （张数 = PDF 页数 ÷ 每张页数 × 份数）。提交时扣、驳回/撤回自动退；充值功能暂未开放，余额由管理员在「用户管理」里手工调整。
          </p>

          {settingsError && (
            <p className={`${ALERT_ERROR} mt-4`}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {settingsError}
            </p>
          )}

          <div className="mt-5 max-w-sm">
            <label className={LABEL} htmlFor="settings-price">
              单价（元/张）
            </label>
            <input
              id="settings-price"
              className={INPUT}
              value={printPrice}
              placeholder="0.1"
              onChange={(event) => setPrintPrice(event.target.value)}
            />
            <p className={HINT}>默认 0.1 元；0 ~ 100 之间，最多两位小数</p>
          </div>

          <div className="mt-6 flex justify-end">
            <button type="button" className={BTN_PRIMARY} onClick={() => void handleSaveSettings()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              保存设置
            </button>
          </div>
        </section>
      )}

      {tab === 'whitelist' && (
        <section className={CARD}>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
            <BadgeCheck className="h-5 w-5 text-brand" />
            免费白名单
          </h2>
          <p className={HINT}>
            名单里的账号提交打印任务不扣余额（管理员/root、anticraft 账号本身就免费）。增删即时生效，不需要点「保存设置」。
          </p>

          {settingsError && (
            <p className={`${ALERT_ERROR} mt-4`}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {settingsError}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              className={`${INPUT} max-w-xs`}
              value={newFreeUser}
              placeholder="输入要免打印费的用户名"
              onChange={(event) => setNewFreeUser(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void addName('free_users', newFreeUser)
                }
              }}
            />
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={listBusy || !newFreeUser.trim()}
              onClick={() => void addName('free_users', newFreeUser)}
            >
              {listBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              添加
            </button>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[440px]">
              <thead>
                <tr className="border-b border-gray-100 dark:border-white/10">
                  <th className={TH}>用户名</th>
                  <th className={TH}>账号</th>
                  <th className={TH}>操作</th>
                </tr>
              </thead>
              <tbody>
                {freeNames.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-sm text-gray-400">
                      白名单为空：所有计费账号提交任务都会扣余额
                    </td>
                  </tr>
                )}
                {freeNames.map((name) => {
                  const row = usersByName.get(name)
                  return (
                    <tr key={name} className="border-b border-gray-50 last:border-0 dark:border-white/5">
                      <td className={`${TD} font-medium text-gray-800 dark:text-gray-100`}>{name}</td>
                      <td className={TD}>
                        {row ? (
                          <span className="text-gray-500 dark:text-gray-400">
                            已注册 · {ROLE_LABEL[row.role] ?? row.role}
                            {row.source === 'anticraft' ? ' · anticraft' : ''}
                          </span>
                        ) : (
                          <span className="text-clay">本站没有这个账号（不会生效）</span>
                        )}
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <button
                          type="button"
                          className={BTN_SM_DANGER}
                          disabled={listBusy}
                          onClick={() => void removeName('free_users', name)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          移除
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'admins' && (
        <section className={CARD}>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
            <ShieldCheck className="h-5 w-5 text-brand" />
            管理员名单
          </h2>
          <p className={HINT}>
            这些 <strong>anticraft 用户名</strong>用 anticraft 登录或绑定时，在 AntiPrint 里直接获得管理员权限
            （anticraft 开放接口不返回角色，所以用这份名单；用密码登录时会优先采用 anticraft 返回的角色）。增删即时生效。
          </p>

          {settingsError && (
            <p className={`${ALERT_ERROR} mt-4`}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {settingsError}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              className={`${INPUT} max-w-xs`}
              value={newAdminUser}
              placeholder="输入 anticraft 用户名"
              onChange={(event) => setNewAdminUser(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void addName('anticraft_admin_users', newAdminUser)
                }
              }}
            />
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={listBusy || !newAdminUser.trim()}
              onClick={() => void addName('anticraft_admin_users', newAdminUser)}
            >
              {listBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              添加
            </button>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[440px]">
              <thead>
                <tr className="border-b border-gray-100 dark:border-white/10">
                  <th className={TH}>anticraft 用户名</th>
                  <th className={TH}>本账号</th>
                  <th className={TH}>操作</th>
                </tr>
              </thead>
              <tbody>
                {adminNames.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-sm text-gray-400">
                      名单为空：anticraft 登录的账号一律是普通用户
                    </td>
                  </tr>
                )}
                {adminNames.map((name) => {
                  const row = usersByName.get(name)
                  return (
                    <tr key={name} className="border-b border-gray-50 last:border-0 dark:border-white/5">
                      <td className={`${TD} font-medium text-gray-800 dark:text-gray-100`}>{name}</td>
                      <td className={TD}>
                        {row ? (
                          <span className="text-gray-500 dark:text-gray-400">
                            已注册 · {ROLE_LABEL[row.role] ?? row.role}
                            {row.anticraft_id ? ` · 绑定 ID ${row.anticraft_id}` : ''}
                          </span>
                        ) : (
                          <span className="text-gray-400">本站还没有对应账号（等他首次登录/绑定）</span>
                        )}
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <button
                          type="button"
                          className={BTN_SM_DANGER}
                          disabled={listBusy}
                          onClick={() => void removeName('anticraft_admin_users', name)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          移除
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'anticraft' && (
        <section className={CARD}>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
            <Link2 className="h-5 w-5 text-brand" />
            anticraft 账号绑定
          </h2>
          <p className={HINT}>
            在 anticraft 后台「绑定应用」登记本应用（client_id / client_secret / 精确回调地址）后填在这里，
            用户就能用「跳转授权」登录或绑定 anticraft 账号。
          </p>

          {settingsError && (
            <p className={`${ALERT_ERROR} mt-4`}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {settingsError}
            </p>
          )}

          <div className="mt-5 grid gap-5 md:grid-cols-2">
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
              <p className={HINT}>本机联调可填 http://localhost:3000，线上填 https://anticraft.top</p>
            </div>

            <div>
              <label className={LABEL} htmlFor="setting-anticraft-client-id">
                client_id
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
                client_secret
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

          <div className="mt-6 flex justify-end">
            <button type="button" className={BTN_PRIMARY} onClick={() => void handleSaveSettings()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              保存设置
            </button>
          </div>
        </section>
      )}

      {tab === 'agent' && (
        <section className={CARD}>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
            <Wifi className="h-5 w-5 text-brand" />
            代理令牌
          </h2>
          <p className={HINT}>
            打印代理用该令牌（请求头 X-Agent-Token）领取与回报任务；重置后需同步更新每台代理的 config.json。
          </p>

          <div className="mt-4 rounded-2xl border border-gray-100 bg-warm p-4 dark:border-white/10 dark:bg-white/5">
            <div className="flex flex-wrap items-center gap-2">
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
          </div>
        </section>
      )}

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
