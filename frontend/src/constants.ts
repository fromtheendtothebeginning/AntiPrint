// 全站共享常量与轻量格式化助手（状态字符串与 backend/constants.py 同步维护，勿改字面量）

import type { JobStatus, PrintOptions } from './types/api'

export const STATUS_PENDING: JobStatus = '待审核'
export const STATUS_APPROVED: JobStatus = '已通过'
export const STATUS_PRINTING: JobStatus = '打印中'
export const STATUS_PRINTED: JobStatus = '已打印'
export const STATUS_REJECTED: JobStatus = '已驳回'
export const STATUS_FAILED: JobStatus = '打印失败'
export const STATUS_AWAIT_DELIVERY: JobStatus = '待配送'
export const STATUS_AWAIT_PICKUP: JobStatus = '待取件'
export const STATUS_DONE: JobStatus = '已完成'
export const STATUS_WITHDRAWN: JobStatus = '已撤回'

/** 配送方式（与 backend/constants.py 同步） */
export const DELIVER = '配送'
export const PICKUP = '取件'
export type DeliveryMode = typeof DELIVER | typeof PICKUP

/** 需先转 PDF 的 Office 类型（与 backend/constants.py 的 OFFICE_EXT 同步）：服务端转换后再预览/打印 */
const OFFICE_RE = /\.(docx?|pptx?)$/i

/** 是否是 Word / PPT 文件（预览与提交时要在服务端先转 PDF） */
export function isOfficeFile(filename: string): boolean {
  return OFFICE_RE.test(filename || '')
}

/**
 * 预览方式：PDF / 图片 / 其它。
 * Office（Word/PPT）由服务端转成 PDF 后下发，因此一律按 PDF 预览；
 * 提交页对未上传的 Office 文件也按 PDF 处理（预览地址来自 /api/preview/office）。
 */
export function previewKind(filename: string): 'pdf' | 'image' | 'other' {
  const lower = (filename || '').toLowerCase()
  if (lower.endsWith('.pdf') || OFFICE_RE.test(lower)) return 'pdf'
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(lower)) return 'image'
  return 'other'
}

/** 徽章基础样式：同色 10% 底 + 本色字（配合下方配色，全站统一） */
export const BADGE_BASE =
  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium'

/** 状态徽章配色：待审核=琥珀、已通过=青绿、打印中=灰青、已打印=翠绿、已驳回=陶土、打印失败=红、待配送=天蓝、待取件=紫、已完成=中性灰 */
const STATUS_BADGE_CLASS: Record<JobStatus, string> = {
  [STATUS_PENDING]: 'bg-amber/15 text-amber-700 dark:text-amber',
  [STATUS_APPROVED]: 'bg-brand/10 text-brand-dark dark:text-brand',
  [STATUS_PRINTING]: 'bg-slate-teal/15 text-slate-teal',
  [STATUS_PRINTED]: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  [STATUS_REJECTED]: 'bg-clay/10 text-clay',
  [STATUS_FAILED]: 'bg-red-500/10 text-red-600 dark:text-red-400',
  [STATUS_AWAIT_DELIVERY]: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  [STATUS_AWAIT_PICKUP]: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  [STATUS_DONE]: 'bg-gray-200/70 text-gray-600 dark:bg-white/10 dark:text-gray-300',
  [STATUS_WITHDRAWN]: 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400',
}

/** 返回状态徽章使用的 Tailwind 类名；未知状态退回灰底，避免样式丢失 */
export function statusBadge(status: JobStatus): string {
  return `${BADGE_BASE} ${STATUS_BADGE_CLASS[status] ?? 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400'}`
}

/** 把后端返回的时间字符串格式化为本地可读时间；无法解析时原样返回 */
export function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** 角色文案（与后端 auth.require_admin / require_root 对应） */
export const ROLE_LABEL: Record<string, string> = {
  user: '普通用户',
  admin: '管理员',
  root: '超级管理员',
}

// ── 打印设置（与 backend/constants.py 的白名单一一对应；双面/彩色因机型不支持已移除）──
export const PAPER_OPTIONS = ['A4', 'A3', 'A5', 'B5', 'Letter', 'Legal']
export const NUP_OPTIONS = [
  { value: '1,1', label: '1 页/张' },
  { value: '2,1', label: '2 页/张（左右）' },
  { value: '1,2', label: '2 页/张（上下）' },
  { value: '2,2', label: '4 页/张' },
  { value: '3,3', label: '9 页/张' },
  { value: '4,4', label: '16 页/张' },
]
export const SCALE_OPTIONS = [
  { value: 'fit', label: '适应纸张' },
  { value: 'noscale', label: '实际大小' },
  { value: 'shrink', label: '缩小到可打印区域' },
]

const SCALE_LABEL: Record<string, string> = Object.fromEntries(SCALE_OPTIONS.map((o) => [o.value, o.label]))

/** 把任务的打印设置汇总成一行中文（任务列表 / 成功卡片共用；无设置时给「默认」说明） */
export function describePrintOptions(options?: PrintOptions | null, copies?: number): string {
  const o = options ?? {}
  const parts: string[] = []
  const total = copies ?? o.copies ?? 1
  if (Number(total) > 1) parts.push(`${total} 份`)
  if (o.paper) parts.push(o.paper)
  if (o.pages) parts.push(`第 ${o.pages} 页`)
  if (o.nup && o.nup !== '1,1') {
    const [rows, cols] = o.nup.split(',').map((n) => Number(n) || 1)
    parts.push(`每张 ${rows * cols} 页`)
  }
  if (o.scale && SCALE_LABEL[o.scale]) parts.push(SCALE_LABEL[o.scale])
  return parts.length ? parts.join(' · ') : '驱动默认'
}
