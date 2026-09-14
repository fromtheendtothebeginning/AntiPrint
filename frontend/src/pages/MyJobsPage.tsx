// 我的任务：任务列表（15 秒自动刷新）+ 已驳回任务改后重新提交
// 表现层为 Tailwind CSS v4 暖色仪表盘风格（配方见 AGENTS.md「前端约定」），图标统一 lucide-react
import { useCallback, useEffect, useState } from 'react'
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Inbox,
  LoaderCircle,
  MapPin,
  PackageOpen,
  Paperclip,
  RefreshCw,
  Truck,
} from 'lucide-react'
import { api, getErrorMessage } from '../api'
import FileChips from '../components/FileChips'
import Modal from '../components/Modal'
import TextField from '../components/TextField'
import {
  DELIVER,
  PICKUP,
  STATUS_AWAIT_DELIVERY,
  STATUS_AWAIT_PICKUP,
  STATUS_DONE,
  STATUS_REJECTED,
  formatTime,
  statusBadge,
} from '../constants'
import type { Job } from '../types/api'

const REFRESH_INTERVAL = 15000

/** 按钮配方：从 AGENTS.md「前端约定」照抄，保证与全站一致 */
const BTN_PRIMARY =
  'inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:bg-brand-dark hover:shadow-xl hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60'
const BTN_SECONDARY =
  'inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl dark:bg-ink-soft dark:text-gray-300'
const ALERT_ERROR = 'flex items-start gap-2 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay'
/** 中性提示条：用于打印完成后的交接提示（非错误，不用红色） */
const ALERT_INFO =
  'flex items-start gap-2 rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-600 dark:bg-white/5 dark:text-gray-300'
const INPUT =
  'min-h-[96px] w-full resize-y rounded-xl border border-gray-200 bg-warm px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 dark:border-white/10 dark:bg-white/5 dark:text-gray-100'

function MyJobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 重新提交弹窗状态
  const [resubmitJob, setResubmitJob] = useState<Job | null>(null)
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  const [modalError, setModalError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const list = await api.listMineJobs()
      setJobs(list)
      setError('')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      void load()
    }, REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [load])

  function openResubmit(job: Job) {
    setResubmitJob(job)
    setAddress(job.address)
    setNote(job.note ?? '')
    setModalError('')
  }

  function closeResubmit() {
    setResubmitJob(null)
    setModalError('')
  }

  async function submitResubmit() {
    if (!resubmitJob) return
    const nextAddress = address.trim()
    if (!nextAddress) {
      setModalError('配送地址不能为空')
      return
    }
    // 只提交发生变化的字段，未修改的字段保持后端原值
    const payload: { address?: string; note?: string } = {}
    if (nextAddress !== resubmitJob.address) payload.address = nextAddress
    if (note.trim() !== (resubmitJob.note ?? '')) payload.note = note.trim()

    setBusy(true)
    setModalError('')
    try {
      await api.resubmit(resubmitJob.id, payload)
      closeResubmit()
      await load()
    } catch (err) {
      setModalError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-400">
          列表每 15 秒自动刷新；被驳回的任务可修改地址或备注后重新提交
        </p>
        <button type="button" className={BTN_SECONDARY} onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" />
          刷新
        </button>
      </div>

      {error && (
        <p className={ALERT_ERROR}>
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-gray-400">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          正在加载任务列表…
        </p>
      ) : jobs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white/60 px-6 py-16 text-center text-sm text-gray-400 dark:border-white/10 dark:bg-white/5">
          <Inbox className="h-6 w-6" />
          <p>还没有提交过打印任务，去「提交打印」上传第一份文件吧</p>
        </div>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => (
            <article
              key={job.id}
              className="rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl dark:bg-ink-soft"
            >
              <header className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-medium text-gray-700 dark:text-gray-200">
                    #{job.id}
                  </span>
                  <span className={statusBadge(job.status)}>{job.status}</span>
                </div>
                <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                  <Clock className="h-3.5 w-3.5" />
                  提交于 {formatTime(job.created_at)}
                </span>
              </header>

              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <dt className="flex w-24 shrink-0 items-center gap-1.5 text-gray-400">
                    <Paperclip className="h-3.5 w-3.5 shrink-0" />
                    文件
                  </dt>
                  <dd className="min-w-0 flex-1">
                    <FileChips
                      files={job.files.map((file) => ({ name: file.filename, size: file.size }))}
                    />
                  </dd>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <dt className="w-24 shrink-0 text-gray-400">配送方式</dt>
                  <dd className="flex min-w-0 flex-1 items-center gap-1.5 text-gray-700 dark:text-gray-200">
                    {job.delivery_mode === PICKUP ? (
                      <PackageOpen className="h-4 w-4 shrink-0 text-gray-400" />
                    ) : (
                      <Truck className="h-4 w-4 shrink-0 text-gray-400" />
                    )}
                    {job.delivery_mode === PICKUP ? PICKUP : DELIVER}
                  </dd>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <dt className="flex w-24 shrink-0 items-center gap-1.5 text-gray-400">
                    <MapPin className="h-3.5 w-3.5 shrink-0" />
                    配送地址
                  </dt>
                  <dd className="min-w-0 flex-1 text-gray-700 dark:text-gray-200">
                    {job.delivery_mode === PICKUP && !job.address ? (
                      <span className="text-gray-400">自取（未填地址）</span>
                    ) : (
                      job.address
                    )}
                  </dd>
                </div>
                {job.note && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    <dt className="w-24 shrink-0 text-gray-400">备注</dt>
                    <dd className="min-w-0 flex-1 text-gray-700 dark:text-gray-200">{job.note}</dd>
                  </div>
                )}
              </dl>

              {job.status === STATUS_REJECTED && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-clay/10 px-4 py-3">
                  <p className="flex items-start gap-2 text-sm text-clay">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    驳回理由：{job.reject_reason || '管理员未填写理由'}
                  </p>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2 text-sm font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl dark:bg-ink-soft dark:text-gray-300"
                    onClick={() => openResubmit(job)}
                  >
                    <RefreshCw className="h-4 w-4" />
                    修改后重新提交
                  </button>
                </div>
              )}

              {job.print_error && (
                <p className="mt-4 flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  打印错误：{job.print_error}
                </p>
              )}

              {/* 打印完成后的交接提示（中性色，与红色错误条区分；徽章配色由 statusBadge 负责） */}
              {job.status === STATUS_AWAIT_DELIVERY && (
                <p className={`mt-4 ${ALERT_INFO}`}>
                  <Truck className="mt-0.5 h-4 w-4 shrink-0" />
                  已打印完成，等待管理员配送
                </p>
              )}

              {job.status === STATUS_AWAIT_PICKUP && (
                <p className={`mt-4 ${ALERT_INFO}`}>
                  <PackageOpen className="mt-0.5 h-4 w-4 shrink-0" />
                  已打印完成，请到打印点自取
                </p>
              )}

              {job.status === STATUS_DONE && job.finished_at && (
                <p className={`mt-4 ${ALERT_INFO}`}>
                  <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  完成于 {formatTime(job.finished_at)}
                </p>
              )}
            </article>
          ))}
        </div>
      )}

      <Modal
        open={resubmitJob !== null}
        title={resubmitJob ? `修改后重新提交 · 任务 #${resubmitJob.id}` : '修改后重新提交'}
        onClose={closeResubmit}
        footer={
          <>
            <button type="button" className={BTN_SECONDARY} onClick={closeResubmit}>
              取消
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => void submitResubmit()}
              disabled={busy}
            >
              {busy ? (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  提交中…
                </>
              ) : (
                '重新提交'
              )}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-400">重新提交后任务回到「待审核」，需要管理员再次审核。</p>
          <TextField
            label="配送地址"
            name="resubmit-address"
            value={address}
            placeholder="请填写新的配送地址"
            disabled={busy}
            onChange={(event) => setAddress(event.target.value)}
          />
          <div>
            <label
              className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-200"
              htmlFor="resubmit-note"
            >
              备注（可选）
            </label>
            <textarea
              id="resubmit-note"
              className={INPUT}
              value={note}
              placeholder="例如：已转成 PDF、单面打印等"
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {modalError && (
            <p className={ALERT_ERROR}>
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              {modalError}
            </p>
          )}
        </div>
      </Modal>
    </div>
  )
}

export default MyJobsPage
