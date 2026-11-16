// 我的余额：余额、账号类型（免费/计费）、单价与最近的扣费/退费流水
// 付费账号可通过支付宝充值，支付结果由后端回调/查单确认后自动入账
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  BadgeCheck,
  CheckCircle2,
  Coins,
  CreditCard,
  Gift,
  Info,
  LoaderCircle,
  Receipt,
  Wallet,
} from 'lucide-react'
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
  const [amount, setAmount] = useState('10')
  const [paying, setPaying] = useState(false)
  const [pending, setPending] = useState<{
    out_trade_no: string
    amount: string
    credit_amount?: string
  } | null>(null)
  const [payError, setPayError] = useState('')
  const [paySuccess, setPaySuccess] = useState('')
  const [canceling, setCanceling] = useState(false)

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

  // 从支付宝收银台跳回：接上订单号继续轮询（支付结果仍以服务端回调/查单为准）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const outTradeNo = params.get('out_trade_no')
    const pay = params.get('pay')
    if (outTradeNo && (pay === 'return' || pay === 'success')) {
      setPending({ out_trade_no: outTradeNo, amount: '' })
      if (pay === 'success') setPaySuccess('支付已完成，正在确认到账…')
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  // 轮询待支付订单：2 秒一次，最多 5 分钟
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    const tick = async () => {
      try {
        const { order, balance } = await api.getPaymentOrder(pending.out_trade_no)
        if (cancelled) return
        if (order.status === 'paid') {
          setPending(null)
          setPayError('')
          setPaySuccess(`充值成功，当前余额 ${formatMoney(balance)}`)
          void load()
        } else if (order.status === 'closed' || order.status === 'failed') {
          setPending(null)
          setPayError('该充值订单已关闭，请重新发起')
        }
      } catch (err) {
        if (!cancelled) setPayError(getErrorMessage(err))
      }
    }
    void tick()
    const timer = window.setInterval(tick, 2000)
    const timeout = window.setTimeout(() => {
      setPending(null)
      setPayError('支付等待超时；如果已经付款，请稍后刷新余额或联系管理员')
    }, 5 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearTimeout(timeout)
    }
  }, [pending, load])

  const startRecharge = async () => {
    setPayError('')
    setPaySuccess('')
    const value = Number(amount)
    if (!Number.isFinite(value) || value < 1 || value > 50) {
      setPayError('充值金额需在 1 ~ 50 元之间')
      return
    }
    // 先同步开窗，避免 await 之后被浏览器当成弹窗拦截
    const payWindow = window.open('', '_blank')
    setPaying(true)
    try {
      const result = await api.createRecharge(value.toFixed(2))
      setPending({
        out_trade_no: result.out_trade_no,
        amount: result.amount,
        credit_amount: result.credit_amount,
      })
      if (payWindow) {
        payWindow.location.href = result.pay_url
      } else {
        window.location.href = result.pay_url
      }
    } catch (err) {
      if (payWindow) payWindow.close()
      setPayError(getErrorMessage(err))
    } finally {
      setPaying(false)
    }
  }

  const checkPayment = async () => {
    if (!pending) return
    try {
      const { order, balance } = await api.getPaymentOrder(pending.out_trade_no)
      if (order.status === 'paid') {
        setPending(null)
        setPayError('')
        setPaySuccess(`充值成功，当前余额 ${formatMoney(balance)}`)
        void load()
      } else {
        setPayError('还没有查到到账，请完成支付后再试')
      }
    } catch (err) {
      setPayError(getErrorMessage(err))
    }
  }

  const cancelPending = async () => {
    if (!pending) return
    setPayError('')
    setCanceling(true)
    try {
      const result = await api.cancelRechargeOrder(pending.out_trade_no)
      setPending(null)
      if (result.canceled) {
        setPaySuccess('订单已取消')
      } else {
        // 取消前查单发现已经支付：后端已自动入账
        setPaySuccess(`充值成功，当前余额 ${formatMoney(result.balance)}`)
      }
      void load()
    } catch (err) {
      setPayError(getErrorMessage(err))
    } finally {
      setCanceling(false)
    }
  }

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
  const bonusPercent = info?.recharge_bonus_percent ?? 0
  const amountNumber = Number(amount)
  const creditPreview =
    Number.isFinite(amountNumber) && amountNumber > 0
      ? amountNumber * (1 + bonusPercent / 100)
      : 0

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

      {info?.billable && info.recharge_enabled ? (
        <section className={CARD}>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
            <CreditCard className="h-5 w-5 text-brand" />
            充值余额
          </h2>
          <p className="mt-1 text-xs text-gray-400">
            支付宝扫码支付，到账后自动加到余额（单笔 1~50 元）
          </p>

          {bonusPercent > 0 && (
            <div className="mt-4 rounded-2xl bg-gradient-to-r from-amber-400/25 via-orange-300/15 to-rose-400/25 p-4 ring-1 ring-amber-400/30">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber">
                <Gift className="h-4 w-4" />
                充值余额加赠 {bonusPercent}%
              </p>
              <p className="mt-1 text-xs text-amber-700/80 dark:text-amber/80">
                充 10 元到账 15 元，多充多送；余额可用于所有打印任务。
              </p>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {(info.recharge_amounts?.length ? info.recharge_amounts : [10, 20, 30, 50]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setAmount(String(value))}
                className={`rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
                  Number(amount) === value
                    ? 'border-brand bg-brand/10 text-brand-dark dark:text-brand'
                    : 'border-gray-200 text-gray-600 hover:border-brand/50 dark:border-white/10 dark:text-gray-300'
                }`}
              >
                {value} 元
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              type="number"
              min={1}
              max={50}
              step={0.01}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="w-32 rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:border-white/10 dark:bg-white/5"
              aria-label="充值金额"
            />
            <button
              type="button"
              onClick={() => void startRecharge()}
              disabled={paying || Boolean(pending)}
              className="inline-flex items-center gap-2 rounded-xl bg-[#1677ff] px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-[#1677ff]/25 transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#0e5fd8] disabled:translate-y-0 disabled:opacity-60"
            >
              {paying ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
              支付宝充值
            </button>
          </div>

          {bonusPercent > 0 && creditPreview > 0 && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber">
              本次到账 <strong>{creditPreview.toFixed(2)} 元</strong>
              （含赠送 {(creditPreview - amountNumber).toFixed(2)} 元）
            </p>
          )}

          {payError ? <p className={`${ALERT_ERROR} mt-4`}>{payError}</p> : null}
          {paySuccess ? (
            <p className="mt-4 flex items-start gap-2 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              {paySuccess}
            </p>
          ) : null}

          {pending ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-brand/5 px-4 py-3 text-sm text-gray-600 dark:bg-white/5 dark:text-gray-300">
              <span className="flex items-center gap-2">
                <LoaderCircle className="h-4 w-4 animate-spin text-brand" />
                订单 {pending.out_trade_no}
                {pending.amount ? ` · 支付 ${pending.amount} 元` : ''}
                {pending.credit_amount ? ` · 到账 ${pending.credit_amount} 元` : ''} 等待支付
              </span>
              <button
                type="button"
                onClick={() => void checkPayment()}
                className="rounded-lg border border-brand/40 px-3 py-1.5 text-xs font-medium text-brand-dark hover:bg-brand/10 dark:text-brand"
              >
                我已完成支付
              </button>
              <button
                type="button"
                onClick={() => void cancelPending()}
                disabled={canceling}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-60 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/5"
              >
                {canceling ? '取消中…' : '取消订单'}
              </button>
            </div>
          ) : null}
        </section>
      ) : (
        <p className={ALERT_INFO}>
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          {info?.billable
            ? '充值暂未开放：余额不足时提交任务会提示付款，需要余额请联系管理员代记。'
            : '免费账号无需充值，提交任务不扣余额。'}
        </p>
      )}

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
