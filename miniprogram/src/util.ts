// 页面公共小工具：时间/金额格式化、状态徽章配色、进度步骤、提示与刷新约定
// 状态字面量与打印选项文案复用 web 端（@shared/constants），这里只做「小程序表现层」的事
import {
  STATUS_PENDING,
  STATUS_APPROVED,
  STATUS_PRINTING,
  STATUS_PRINTED,
  STATUS_REJECTED,
  STATUS_FAILED,
  STATUS_AWAIT_DELIVERY,
  STATUS_AWAIT_PICKUP,
  STATUS_DONE,
  STATUS_WITHDRAWN,
  DELIVER,
} from '@shared/constants'
import type { Job, JobStatus, Profile } from '@shared/types/api'

/** 状态徽章配色（与 web 端 6+4 个状态一一对应，这里用 wxss 类名而非 Tailwind） */
const STATUS_CLASS: Record<string, string> = {
  [STATUS_PENDING]: 'badge badge-amber',
  [STATUS_APPROVED]: 'badge badge-brand',
  [STATUS_PRINTING]: 'badge badge-slate',
  [STATUS_PRINTED]: 'badge badge-emerald',
  [STATUS_REJECTED]: 'badge badge-clay',
  [STATUS_FAILED]: 'badge badge-red',
  [STATUS_AWAIT_DELIVERY]: 'badge badge-sky',
  [STATUS_AWAIT_PICKUP]: 'badge badge-violet',
  [STATUS_DONE]: 'badge badge-gray',
  [STATUS_WITHDRAWN]: 'badge badge-gray',
}

export function statusClass(status: JobStatus | string): string {
  return STATUS_CLASS[status] || 'badge badge-gray'
}

/** 出纸前提交人可以自己撤单（与后端 constants.USER_WITHDRAWABLE 一致） */
export function canWithdraw(job: Job): boolean {
  return job.status === STATUS_PENDING || job.status === STATUS_APPROVED
}

export interface StepItem {
  label: string
  state: 'done' | 'now' | 'todo'
}

/**
 * 任务进度（提交 → 审核 → 打印 → 交接）；已驳回/已撤回/打印失败这些支线不给进度条。
 * 返回空数组表示「不显示进度条」。
 */
export function jobSteps(job: Job): StepItem[] {
  const done = (label: string): StepItem => ({ label, state: 'done' })
  const now = (label: string): StepItem => ({ label, state: 'now' })
  const todo = (label: string): StepItem => ({ label, state: 'todo' })

  switch (job.status) {
    case STATUS_PENDING:
      return [done('已提交'), now('审核中'), todo('打印'), todo('交接')]
    case STATUS_APPROVED:
      return [done('已提交'), done('已通过'), now('待打印'), todo('交接')]
    case STATUS_PRINTING:
      return [done('已提交'), done('已通过'), now('打印中'), todo('交接')]
    case STATUS_PRINTED:
      return [done('已提交'), done('已通过'), done('已出纸'), now('待交接')]
    case STATUS_AWAIT_DELIVERY:
      return [done('已提交'), done('已通过'), done('已出纸'), now('待配送')]
    case STATUS_AWAIT_PICKUP:
      return [done('已提交'), done('已通过'), done('已出纸'), now('待取件')]
    case STATUS_DONE:
      return [done('已提交'), done('已通过'), done('已出纸'), done('已完成')]
    default:
      return []
  }
}

/**
 * 时间格式化：不用 toLocaleString（小程序 JSCore 不一定有 Intl），手工拼 YYYY-MM-DD HH:mm
 * 注意：这里不复用 web 端的 formatTime，就是因为它依赖 Intl。
 */
export function formatTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(String(value).replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 短时间（列表里用）：09/16 12:45 */
export function shortTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(String(value).replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 文件大小：不超过 1MB 用 KB，超过用 MB */
export function formatSize(size?: number): string {
  const bytes = Number(size) || 0
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 金额：统一保留两位小数（后端返回的是字符串形式的元） */
export function formatMoney(value?: number | string | null): string {
  const yuan = Number(value)
  if (Number.isNaN(yuan)) return '0.00'
  return yuan.toFixed(2)
}

/** 「配送 · 地址」这类一行摘要（取件单地址可能为空） */
export function deliveryText(job: Job): string {
  const address = (job.address || '').trim()
  if (job.delivery_mode === DELIVER) return address ? `配送 · ${address}` : '配送（地址待补）'
  return address ? `取件 · ${address}` : '到打印点自取'
}

/** 计费提示：免费账号说明原因，计费账号显示单价与余额（与 web 端提交页同一套文案） */
export function billingHint(profile: Profile | null): string {
  if (!profile) return ''
  if (!profile.billable) return `免费账号${profile.free_reason ? `（${profile.free_reason}）` : ''}`
  return `按 ${profile.price} 计费 · 当前余额 ${formatMoney(profile.balance)} 元`
}

/** 轻提示（小程序原生 toast；文案太长会自动换行显示） */
export function toast(title: string): void {
  wx.showToast({ title, icon: 'none', duration: 2000 })
}

/** 错误提示统一走这里：ApiError 的 message 已是后端的中文原因 */
export function toastError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  wx.showToast({ title: message, icon: 'none', duration: 2500 })
}

/** 二次确认弹窗（Promise 化，和 web 端 Modal 确认的用法对齐） */
export function confirm(title: string, content: string, confirmText = '确定'): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      confirmText,
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false),
    })
  })
}

// ── 下拉刷新：页面把刷新函数注册进来，页面入口统一接 wx 的 onPullDownRefresh ──
let refreshHandler: (() => void) | null = null

export function onRefresh(fn: (() => void) | null): void {
  refreshHandler = fn
}

export function triggerRefresh(): void {
  if (refreshHandler) refreshHandler()
  else wx.stopPullDownRefresh()
}

// ── 界面字号缩放（「我的配置」里可选 标准/大/特大）：存在本地，进每个页面时套用 ──
export type UiScale = 'std' | 'lg' | 'xl'

const SCALE_KEY = 'antiprint_scale'

export function getUiScale(): UiScale {
  const saved = wx.getStorageSync(SCALE_KEY)
  return saved === 'lg' || saved === 'xl' ? saved : 'std'
}

export function setUiScale(scale: UiScale): void {
  wx.setStorageSync(SCALE_KEY, scale)
}

// ── 页面重新显示（wxshow）：tabBar 页用 switchTab 切换时**不会销毁页面实例**，
//    需要自己在这里把「上一次的结束态」清掉（例：提交成功页切回来要回到表单首页）──
let showHandler: (() => void) | null = null

export function onShow(fn: (() => void) | null): void {
  showHandler = fn
}

export function triggerShow(): void {
  if (showHandler) showHandler()
}

/** 错误提示：401 / 网络失败时给出可操作的一句话 */
export function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}
