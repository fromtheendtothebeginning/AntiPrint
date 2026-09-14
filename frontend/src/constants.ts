// 全站共享常量与轻量格式化助手（状态字符串与 backend/constants.py 同步维护，勿改字面量）

import type { JobStatus } from './types/api'

export const STATUS_PENDING: JobStatus = '待审核'
export const STATUS_APPROVED: JobStatus = '已通过'
export const STATUS_PRINTING: JobStatus = '打印中'
export const STATUS_PRINTED: JobStatus = '已打印'
export const STATUS_REJECTED: JobStatus = '已驳回'
export const STATUS_FAILED: JobStatus = '打印失败'
export const STATUS_AWAIT_DELIVERY: JobStatus = '待配送'
export const STATUS_AWAIT_PICKUP: JobStatus = '待取件'
export const STATUS_DONE: JobStatus = '已完成'

/** 配送方式（与 backend/constants.py 同步） */
export const DELIVER = '配送'
export const PICKUP = '取件'
export type DeliveryMode = typeof DELIVER | typeof PICKUP

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
