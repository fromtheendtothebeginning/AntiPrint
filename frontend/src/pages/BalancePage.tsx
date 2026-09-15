// 我的余额：余额、账号类型（免费/计费）、单价与最近的扣费/退费流水
// 付款码/充值暂未实现——这里明确提示「充值暂未开放」，避免用户找不到入口
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BadgeCheck, Coins, Info, LoaderCircle, Receipt, Wallet } from 'lucide-react'
import { api, getErrorMessage } from '../api'
import { formatTime } from '../constants'
import type { BalanceInfo } from '../types/api'

const CARD = 'rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft'
const ALERT_INFO = 'flex items-start gap-2 rounded-xl bg-amber/15 px-4 py-3 text-sm text-amber-700 dark:text-amber'
const ALERT_ERROR =
  'flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400'
const BTN_PRIMARY =
  'inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-xl'

/** 金额展示：0.1 → ¥0.10；负数（扣费）带符号 */
export function formatMoney(value: number | string | null | undefined): string {
  const amount = Number(value ?? 0)
  if (Number.isNaN(amount)) return '¥0.00'
  return `${amount < 0 ? '-' : ''}¥${Math.abs(amount).toFixed(2)}`
}

function BalancePage() {
  const [info, setInfo] = useState<BalanceInfo | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setInfo(await api.getBalance())
      setError('')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className={`${CARD} flex items-center justify-center gap-2 py-16 text-sm text-gray-400`}>
        <LoaderCircle className="h-4 w-4 animate-spin" />
        正在读取余额…
      </div>
    )
  }

  if (error && !info) {
    return <p className={ALERT_ERROR}>{error}</p>
  }

  const logs = info?.logs ?? []

  return (
    <div className="space-y-5">
      <section className={`${CARD} flex flex-wrap items-center gap-5`}>
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand/10 text-brand-dark dark:text-brand">
          <Wallet className="h-6 w-6" />
        </span>
        <div className="min-w-[180px] flex-1">
          <p className="text-xs text-gray-400">当前余额</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-gray-800 dark:text-gray-100">
            {formatMoney(info?.balance)}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          {info?.billable ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-clay/10 px-2.5 py-1 text-xs font-medium text-clay">
              <Coins className="h-3.5 w-3.5" />
              计费账号 · {info.price}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand-dark dark:text-brand">
              <BadgeCheck className="h-3.5 w-3.5" />
              免费账号 · {info?.free_reason || '免打印费'}
            </span>
          )}
          <p className="text-xs text-gray-400">
            {info?.billable ? '提交任务时按「张数 × 单价」从余额扣除' : '免打印费，提交任务不扣余额'}
          </p>
        </div>
      </section>

      <p className={ALERT_INFO}>
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        充值功能暂未开放（付款码待实现）：余额不足时提交任务会提示付款码占位页。需要余额请联系管理员代记。
      </p>

      <section className={CARD}>
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
          <Receipt className="h-5 w-5 text-brand" />
          消费记录
        </h2>
        <p className="mt-1 text-xs text-gray-400">最近 50 条：打印扣费、驳回/撤回退费、管理员调账</p>

        {logs.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white/60 px-6 py-12 text-center text-sm text-gray-400 dark:border-white/10 dark:bg-white/5">
            <Receipt className="h-5 w-5" />
            <p>还没有余额变动记录</p>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 dark:border-white/10">
                  <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">时间</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">说明</th>
                  <th className="whitespace-nowrap px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-400">金额</th>
                  <th className="whitespace-nowrap px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-400">变动后余额</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const delta = Number(log.delta ?? 0)
                  return (
                    <tr key={log.id} className="border-b border-gray-50 last:border-0 dark:border-white/5">
                      <td className="whitespace-nowrap px-4 py-2.5 text-sm text-gray-500 dark:text-gray-400">
                        {formatTime(log.created_at)}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-300">
                        {log.reason}
                        {log.job_id ? <span className="ml-1 text-xs text-gray-400">任务 #{log.job_id}</span> : null}
                        {log.actor ? <span className="ml-1 text-xs text-gray-400">（{log.actor}）</span> : null}
                      </td>
                      <td
                        className={`whitespace-nowrap px-4 py-2.5 text-right text-sm font-medium ${
                          delta < 0 ? 'text-clay' : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {delta > 0 ? '+' : ''}
                        {formatMoney(delta)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-sm text-gray-500 dark:text-gray-400">
                        {formatMoney(log.balance_after)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="flex flex-wrap gap-3">
        <Link className={BTN_PRIMARY} to="/submit">
          <Coins className="h-4 w-4" />
          去提交打印
        </Link>
      </div>
    </div>
  )
}

export default BalancePage
