// 任务队列（管理员）：审核任务、预览文件，并在出纸后勾选「待配送 / 待取件」与「已完成」
// 结构自 AdminPage 的队列部分迁出并增强（状态筛选 + 配送方式 + 交接勾选）；
// 表现层为 Tailwind CSS v4 暖色仪表盘风格（配方见 AGENTS.md「前端约定」），图标统一 lucide-react
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ChevronRight,
  ClipboardList,
  Eye,
  Inbox,
  ListChecks,
  Loader2,
  MapPin,
  RefreshCw,
  RotateCcw,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { api, getErrorMessage } from '../api'
import { formatSize } from '../components/FileChips'
import Modal from '../components/Modal'
import {
  describePrintOptions,
  BADGE_BASE,
  DELIVER,
  PICKUP,
  STATUS_APPROVED,
  STATUS_AWAIT_DELIVERY,
  STATUS_AWAIT_PICKUP,
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_PENDING,
  STATUS_PRINTED,
  STATUS_PRINTING,
  STATUS_REJECTED,
  formatTime,
  previewKind,
  statusBadge,
} from '../constants'
import type { DeliveryMode, Job, JobFile, JobStatus } from '../types/api'

const REFRESH_INTERVAL = 15000
/** 状态筛选里的「全部」 */
const FILTER_ALL = 'all'
type StatusFilter = typeof FILTER_ALL | JobStatus

/** 筛选项顺序与状态机流转顺序一致（全部 + 9 个状态） */
const FILTERS: StatusFilter[] = [
  FILTER_ALL,
  STATUS_PENDING,
  STATUS_APPROVED,
  STATUS_PRINTING,
  STATUS_PRINTED,
  STATUS_REJECTED,
  STATUS_FAILED,
  STATUS_AWAIT_DELIVERY,
  STATUS_AWAIT_PICKUP,
  STATUS_DONE,
]

/* ---------- 样式配方（照 AGENTS.md「前端约定」，保证与全站一致） ---------- */
const CARD = 'rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft'
const TH = 'whitespace-nowrap px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400'
const TD = 'px-4 py-2.5 align-middle text-sm text-gray-600 dark:text-gray-300'
const TD_NOWRAP = `${TD} whitespace-nowrap`
/** 抽屉底部的大按钮：≥44px 高、两列排布，手机上手好点 */
const BTN_PRIMARY_ROW =
  'inline-flex min-h-[44px] flex-1 basis-[45%] items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium shadow-lg transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60'
const BTN_SM_PRIMARY =
  'inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:-translate-y-0.5 hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60'
const BTN_SM_SECONDARY =
  'inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/5 dark:text-gray-300'
const BTN_SECONDARY =
  'inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/5 dark:text-gray-300'
const BTN_DANGER =
  'inline-flex items-center gap-1.5 rounded-xl bg-clay px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-clay/25 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60'
const INPUT =
  'w-full rounded-xl border border-gray-200 bg-warm px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 dark:border-white/10 dark:bg-white/5 dark:text-gray-100'
const LABEL = 'mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400'
const ALERT_ERROR = 'flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400'
const ALERT_OK = 'flex items-start gap-2 rounded-xl bg-brand/10 px-4 py-3 text-sm text-brand-dark dark:text-brand'
/** 未选中的筛选 chip：中性灰，与状态徽章的彩色底形成对比 */
const CHIP_MUTED = `${BADGE_BASE} cursor-pointer bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200/70 dark:bg-white/10 dark:text-gray-400 dark:hover:bg-white/20`
/** 「全部」选中态：主色系（与「已通过」徽章同款配色） */
const CHIP_ALL_ACTIVE = `${BADGE_BASE} bg-brand/10 text-brand-dark dark:text-brand`
/** 交接勾选：label 包 input，可见文字供 Playwright / 无障碍按文本定位 */
const CHECK_LABEL =
  'inline-flex items-center gap-2 rounded-xl bg-warm px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors dark:bg-white/5 dark:text-gray-300'

/** 弹窗底部的按钮：移动端撑满一行、字大一号，方便手指点按 */
const MODAL_BTN = 'flex-1 sm:flex-none justify-center'
/** 文件与设置弹窗的「知道了」按钮：主色大按钮，移动端整行宽 */
const BTN_PRIMARY_WIDE =
  'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto'

const shorten = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

/** 行内紧凑时间：2026/09/15 12:43:32 → 09/15 12:43（完整值放 title；解析失败原样返回） */
function shortTime(value: string | null): string {
  const full = formatTime(value)
  const matched = full.match(/^\d{4}\/(\d{2}\/\d{2})\s+(\d{2}:\d{2})/)
  return matched ? `${matched[1]} ${matched[2]}` : full
}

/** 抽屉收起动画时长（ms）：与 index.css 的 sheet-down 对齐，播完再卸载 */
const SHEET_EXIT_MS = 230

/** 可「重新打印」的状态（与后端 constants.ADMIN_REPRINTABLE 一致）；打印失败另有「重新入队」 */
const REPRINTABLE: JobStatus[] = [STATUS_PRINTED, STATUS_AWAIT_DELIVERY, STATUS_AWAIT_PICKUP, STATUS_DONE]

/** 配送方式徽章配色：配送=主色系（青绿）、取件=紫罗兰色系 */
const MODE_BADGE: Record<DeliveryMode, string> = {
  [DELIVER]: `${BADGE_BASE} bg-brand/10 text-brand-dark dark:text-brand`,
  [PICKUP]: `${BADGE_BASE} bg-violet-500/10 text-violet-600 dark:text-violet-400`,
}

/** 按扩展名决定预览方式：PDF / 图片 / 其它（Word/PPT 由服务端转成 PDF，走 PDF 分支） */
function fileKind(filename: string): 'pdf' | 'image' | 'other' {
  return previewKind(filename)
}

/** 交接勾选的目标状态：已打印按配送方式给「待配送 / 待取件」，待配送/待取件给「已完成」，其余无勾选项 */
function handoverTarget(job: Job): JobStatus | null {
  if (job.status === STATUS_PRINTED) {
    return job.delivery_mode === PICKUP ? STATUS_AWAIT_PICKUP : STATUS_AWAIT_DELIVERY
  }
  if (job.status === STATUS_AWAIT_DELIVERY || job.status === STATUS_AWAIT_PICKUP) return STATUS_DONE
  return null
}

interface PreviewState {
  filename: string
  url: string
  kind: 'pdf' | 'image' | 'other'
  loading: boolean
  error: string
}

function QueuePage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** 正在执行操作的任务号：期间禁用该行的按钮与交接勾选，避免重复提交 */
  const [actingId, setActingId] = useState(0)
  const [filter, setFilter] = useState<StatusFilter>(FILTER_ALL)

  // 驳回弹窗
  /** 删除确认弹窗的目标任务 */
  const [deleteJob, setDeleteJob] = useState<Job | null>(null)
  /** 手机端「文件与设置」弹窗的目标任务（桌面端不需要，列里直接显示） */
  const [filesJob, setFilesJob] = useState<Job | null>(null)
  /** 手机端任务详情抽屉（点行打开）：详情 + 底部固定操作按钮 */
  const [detailId, setDetailId] = useState(0)
  /** 抽屉里显示的任务：关闭时先留着内容把收起动画播完（detailId 归零后它才清空） */
  const [sheetJob, setSheetJob] = useState<Job | null>(null)
  const [sheetClosing, setSheetClosing] = useState(false)
  const [rejectJob, setRejectJob] = useState<Job | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectError, setRejectError] = useState('')
  const [rejectBusy, setRejectBusy] = useState(false)

  // 文件预览
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  /** 预览请求序号：快速切换文件时丢弃过期的响应，避免串图与临时地址泄漏 */
  const previewSeqRef = useRef(0)

  function releasePreviewUrl() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
  }

  // 卸载时释放预览产生的 objectURL，避免内存泄漏
  useEffect(() => {
    return () => {
      releasePreviewUrl()
    }
  }, [])

  const loadQueue = useCallback(async () => {
    try {
      const data = await api.listAllJobs()
      setJobs(data.jobs)
      setError('')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次加载 + 每 15 秒刷新队列（卸载时清理定时器）
  useEffect(() => {
    void loadQueue()
    const timer = setInterval(() => {
      void loadQueue()
    }, REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [loadQueue])

  // 提示 4 秒后自动消失
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  async function handleRefresh() {
    setRefreshing(true)
    await loadQueue()
    setRefreshing(false)
  }

  /** 抽屉里点操作：先关抽屉（队列会自己刷新，避免遮住结果提示） */
  async function runFromSheet(action: () => Promise<void>) {
    setDetailId(0)
    await action()
  }

  /** 统一处理任务操作：请求 → 提示 → 刷新队列 */
  async function runAction(id: number, action: () => Promise<unknown>, message: string) {
    setActingId(id)
    setNotice('')
    try {
      await action()
      setNotice(message)
      await loadQueue()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setActingId(0)
    }
  }

  async function handleApprove(job: Job) {
    await runAction(job.id, () => api.approve(job.id), `任务 #${job.id} 已同意，等待打印代理出纸`)
  }

  /** 管理员重新打印：把已出纸/已结束的任务重新入队（清掉上次打印痕迹） */
  async function handleReprint(job: Job) {
    await runAction(job.id, () => api.reprintJob(job.id), `任务 #${job.id} 已重新入队打印`)
  }

  /** 管理员删除任务（含上传文件，弹窗二次确认） */
  async function handleDelete() {
    if (!deleteJob) return
    const id = deleteJob.id
    setActingId(id)
    try {
      await api.deleteJob(id)
      setDeleteJob(null)
      setNotice(`任务 #${id} 已删除`)
      await loadQueue()
    } catch (err) {
      setError(getErrorMessage(err))
      setDeleteJob(null)
      await loadQueue()
    } finally {
      setActingId(0)
    }
  }

  async function handleRetry(job: Job) {
    await runAction(job.id, () => api.retry(job.id), `任务 #${job.id} 已重新入队`)
  }

  /**
   * 交接勾选：成功后刷新并提示；
   * 失败（400 配送方式不匹配 / 409 状态已变化）展示后端中文 detail 后同样刷新，以服务端状态为准
   */
  async function handleAdvance(job: Job, target: JobStatus) {
    setActingId(job.id)
    setError('')
    setNotice('')
    try {
      await api.advance(job.id, target)
      setNotice(`任务 #${job.id} 已标记为${target}`)
    } catch (err) {
      setError(getErrorMessage(err))
    }
    await loadQueue()
    setActingId(0)
  }

  function openReject(job: Job) {
    setRejectJob(job)
    setRejectReason('')
    setRejectError('')
  }

  function closeReject() {
    setRejectJob(null)
    setRejectReason('')
    setRejectError('')
  }

  async function submitReject() {
    if (!rejectJob) return
    const reason = rejectReason.trim()
    if (!reason) {
      setRejectError('请填写驳回理由')
      return
    }
    setRejectBusy(true)
    setRejectError('')
    try {
      await api.reject(rejectJob.id, reason)
      const id = rejectJob.id
      closeReject()
      setNotice(`任务 #${id} 已驳回`)
      await loadQueue()
    } catch (err) {
      setRejectError(getErrorMessage(err))
    } finally {
      setRejectBusy(false)
    }
  }

  /** 预览：文件接口需要 Bearer，因此用 fetch 取 Blob 再生成临时地址 */
  async function openPreview(job: Job, file: JobFile) {
    const seq = previewSeqRef.current + 1
    previewSeqRef.current = seq
    releasePreviewUrl()
    setPreview({
      filename: file.filename,
      url: '',
      kind: fileKind(file.filename),
      loading: true,
      error: '',
    })
    try {
      const blob = await api.fetchFileBlob(job.id, file.id)
      if (previewSeqRef.current !== seq) return
      const url = URL.createObjectURL(blob)
      previewUrlRef.current = url
      setPreview((prev) => (prev ? { ...prev, url, loading: false } : prev))
    } catch (err) {
      if (previewSeqRef.current !== seq) return
      setPreview((prev) => (prev ? { ...prev, loading: false, error: getErrorMessage(err) } : prev))
    }
  }

  function closePreview() {
    previewSeqRef.current += 1
    releasePreviewUrl()
    setPreview(null)
  }

  // 筛选只作用于前端已拉到的列表
  const visibleJobs = filter === FILTER_ALL ? jobs : jobs.filter((job) => job.status === filter)

  // 点行 → 打开抽屉（内容按 id 从最新列表取，15 秒刷新后也是新的）；
  // 关闭 → 先播 220ms 收起动画，再清空内容
  useEffect(() => {
    if (detailId) {
      setSheetJob(jobs.find((item) => item.id === detailId) ?? null)
      setSheetClosing(false)
      return
    }
    if (!sheetJob) return
    setSheetClosing(true)
    const timer = setTimeout(() => {
      setSheetJob(null)
      setSheetClosing(false)
    }, SHEET_EXIT_MS)
    return () => clearTimeout(timer)
  }, [detailId, jobs, sheetJob])

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

      <section className={CARD}>
        {/* 顶部工具条：状态筛选 chips + 刷新 */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((value) => {
              const active = filter === value
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(value)}
                  className={
                    active
                      ? value === FILTER_ALL
                        ? CHIP_ALL_ACTIVE
                        : statusBadge(value)
                      : CHIP_MUTED
                  }
                >
                  {value === FILTER_ALL ? '全部' : value}
                </button>
              )
            })}
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
        </div>

        <p className="mb-4 text-xs text-gray-400">
          共 {visibleJobs.length} 条任务（列表每 15 秒自动刷新；出纸后按配送方式勾选交接状态）
          <span className="lg:hidden">　·　左右滑动查看完整表格</span>
        </p>

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载任务列表…
          </p>
        ) : visibleJobs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white/60 px-6 py-16 text-center text-sm text-gray-400 dark:border-white/10 dark:bg-white/5">
            <Inbox className="h-6 w-6" />
            <p>{jobs.length === 0 ? '暂无打印任务' : '没有符合筛选条件的任务'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            {/* 固定列宽（table-fixed）：除「文件与设置」吃剩余宽度外都是定宽，
                配合各列的 truncate 保证数据行永远单行；只有收货地址列允许换行。
                列宽按各列内容的下限取（任务 210 / 地址 220 / 状态 195 / 操作 285） */}
            <table className="w-full min-w-[920px] table-fixed md:min-w-[1210px]">
              <colgroup>
                <col className="w-[210px]" />
                {/* 手机端只放一个图标按钮，桌面端继续吃掉剩余宽度 */}
                <col className="w-[92px] md:w-auto" />
                <col className="w-[220px]" />
                <col className="w-[195px]" />
                <col className="w-[285px]" />
              </colgroup>
              <thead>
                <tr className="border-b border-gray-100 dark:border-white/10">
                  <th className={TH}>任务</th>
                  <th className={TH}>文件与设置</th>
                  <th className={TH}>配送方式与地址</th>
                  <th className={TH}>状态</th>
                  <th className={TH}>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleJobs.map((job) => {
                  const target = handoverTarget(job)
                  const rowBusy = actingId === job.id
                  const reason =
                    job.status === STATUS_REJECTED
                      ? job.reject_reason
                      : job.status === STATUS_FAILED
                        ? job.print_error
                        : ''
                  return (
                    <tr
                      key={job.id}
                      className="group cursor-pointer border-b border-gray-50 transition-colors last:border-0 hover:bg-warm md:cursor-default dark:border-white/5 dark:hover:bg-white/5"
                      onClick={() => {
                        // 手机端（<md）：点整行弹出任务详情抽屉，操作按钮在抽屉底部
                        if (window.innerWidth < 768) setDetailId(job.id)
                      }}
                    >
                      {/* 任务号 + 提交人 + 提交时间：压在一行（提交人过长省略，完整值悬停看） */}
                      <td className={TD_NOWRAP}>
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 font-mono text-xs font-semibold text-gray-700 dark:text-gray-200">
                            #{job.id}
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200"
                            title={job.username || ''}
                          >
                            {job.username || `用户 #${job.user_id}`}
                          </span>
                          <span className="shrink-0 text-xs text-gray-400" title={formatTime(job.created_at)}>
                            {shortTime(job.created_at)}
                          </span>
                        </div>
                      </td>

                      {/* 文件 + 该文件自己的打印设置：平铺一行（多文件并列，超出部分省略号） */}
                      <td className={TD_NOWRAP}>
                        {job.files.length === 0 ? (
                          <span className="text-xs text-gray-400">无文件</span>
                        ) : (
                          <>
                            {/* 手机端（<md）：只显示一个带数量的图标，点了弹出文件与设置明细 */}
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 rounded-lg bg-warm px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-brand/10 hover:text-brand-dark md:hidden dark:bg-white/5 dark:text-gray-300"
                              aria-label={`查看文件与设置（${job.files.length} 个文件）`}
                              onClick={(event) => {
                                event.stopPropagation()      // 别把行点击一起触发（会同时弹出详情抽屉）
                                setFilesJob(job)
                              }}
                            >
                              <ClipboardList className="h-4 w-4" />
                              {job.files.length}
                            </button>
                          <div className="hidden items-center gap-x-3 md:flex">
                            {job.files.map((file) => {
                              const summary = describePrintOptions(
                                file.print_options ?? job.print_options,
                                file.print_options?.copies ?? job.copies,
                              )
                              return (
                                <span key={file.id} className="inline-flex min-w-0 max-w-[320px] items-center gap-1.5">
                                  <button
                                    type="button"
                                    className="inline-flex min-w-0 items-center gap-1 text-xs font-medium text-brand underline-offset-2 hover:underline"
                                    title={`点击预览：${file.filename}`}
                                    onClick={() => void openPreview(job, file)}
                                  >
                                    <Eye className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{file.filename}</span>
                                  </button>
                                  <span className="shrink-0 text-xs text-gray-400">{formatSize(file.size)}</span>
                                  {summary !== '驱动默认' && (
                                    <span className="min-w-0 truncate text-xs text-gray-400" title={summary}>
                                      · {summary}
                                    </span>
                                  )}
                                </span>
                              )
                            })}
                          </div>
                          </>
                        )}
                      </td>

                      {/* 配送方式 + 地址：方式用徽章，地址是唯一允许换行的内容（长地址最多两三行） */}
                      <td className={TD}>
                        <div className="flex items-start gap-2">
                          <span className={`${MODE_BADGE[job.delivery_mode]} shrink-0`}>{job.delivery_mode}</span>
                          <span className="min-w-0 flex-1 break-words text-sm text-gray-700 dark:text-gray-200">
                            {job.address.trim() ? (
                              job.address
                            ) : (
                              <span className="text-xs text-gray-400">
                                {job.delivery_mode === PICKUP ? '自取（未填地址）' : '未填地址'}
                              </span>
                            )}
                          </span>
                        </div>
                      </td>

                      {/* 状态：徽章 + 驳回理由/打印错误（截断成一行，完整内容悬停可见） */}
                      <td className={TD_NOWRAP}>
                        <div className="flex items-center gap-2">
                          <span className={`${statusBadge(job.status)} shrink-0`}>{job.status}</span>
                          {reason && (
                            <span
                              className="min-w-0 truncate text-xs text-red-600 dark:text-red-400"
                              title={`${job.status === STATUS_REJECTED ? '理由' : '错误'}：${reason}`}
                            >
                              {shorten(reason, 8)}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 操作：全部挤在一行不换行（预览走左侧文件名） */}
                      <td className={TD}>
                        {/* 手机端：操作搬到详情抽屉底部，这里只给一个箭头提示可点 */}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-lg bg-warm px-2.5 py-1.5 text-xs font-medium text-gray-600 md:hidden dark:bg-white/5 dark:text-gray-300"
                          aria-label="查看任务详情与操作"
                          onClick={(event) => {
                            event.stopPropagation()
                            setDetailId(job.id)
                          }}
                        >
                          详情
                          <ChevronRight className="h-4 w-4" />
                        </button>
                        <div className="hidden items-center gap-1.5 whitespace-nowrap md:flex">
                          {job.status === STATUS_PENDING && (
                            <>
                              <button
                                type="button"
                                className={BTN_SM_PRIMARY}
                                disabled={rowBusy}
                                onClick={() => void handleApprove(job)}
                              >
                                <Check className="h-3.5 w-3.5" />
                                同意
                              </button>
                              <button
                                type="button"
                                className={BTN_SM_SECONDARY}
                                disabled={rowBusy}
                                onClick={() => openReject(job)}
                              >
                                <X className="h-3.5 w-3.5" />
                                驳回
                              </button>
                            </>
                          )}
                          {job.status === STATUS_FAILED && (
                            <button
                              type="button"
                              className={BTN_SM_SECONDARY}
                              disabled={rowBusy}
                              onClick={() => void handleRetry(job)}
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                              重新入队
                            </button>
                          )}
                          {REPRINTABLE.includes(job.status) && (
                            <button
                              type="button"
                              className={BTN_SM_SECONDARY}
                              disabled={rowBusy}
                              onClick={() => void handleReprint(job)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              重新打印
                            </button>
                          )}
                          {target && (
                            <label
                              className={`${CHECK_LABEL} ${
                                rowBusy
                                  ? 'cursor-not-allowed opacity-60'
                                  : 'cursor-pointer hover:bg-brand/10 hover:text-brand-dark dark:hover:bg-white/10'
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-brand"
                                checked={false}
                                disabled={rowBusy}
                                onChange={() => void handleAdvance(job, target)}
                              />
                              <span>{target}</span>
                            </label>
                          )}
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-lg bg-clay/10 px-2.5 py-1.5 text-xs font-medium text-clay transition-colors hover:bg-clay/20 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={rowBusy}
                            onClick={() => setDeleteJob(job)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 手机端任务详情抽屉：点行（或「详情」）打开；详情可滚动、操作固定在底部拇指区 */}
      {sheetJob && (
        <div
          className={`fixed inset-0 z-50 md:hidden ${sheetClosing ? 'pointer-events-none' : ''}`}
        >
          <div
            className={`absolute inset-0 bg-black/40 backdrop-blur-sm motion-reduce:animate-none ${
              sheetClosing ? 'animate-fade-out' : 'animate-fade-in'
            }`}
            aria-hidden
            onClick={() => setDetailId(0)}
          />
          <div
            className={`absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-2xl bg-white shadow-2xl motion-reduce:animate-none dark:bg-ink-soft ${
              sheetClosing ? 'animate-sheet-down' : 'animate-sheet-up'
            }`}
          >
            {/* 头部：任务号 + 状态 + 关闭 */}
            <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-white/10">
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-sm font-semibold text-gray-700 dark:text-gray-200">#{sheetJob.id}</span>
                <span className={statusBadge(sheetJob.status)}>{sheetJob.status}</span>
              </div>
              <button
                type="button"
                className="shrink-0 rounded-xl p-2 text-gray-400 transition-colors hover:bg-warm dark:hover:bg-white/5"
                aria-label="关闭详情"
                onClick={() => setDetailId(0)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* 详情（可滚动） */}
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
              <div className="flex items-start gap-2 text-gray-600 dark:text-gray-300">
                <User className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1 break-all">
                  {sheetJob.username || `用户 #${sheetJob.user_id}`}
                </span>
              </div>
              <div className="flex items-start gap-2 text-gray-600 dark:text-gray-300">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1">提交时间 {formatTime(sheetJob.created_at)}</span>
              </div>
              <div className="flex items-start gap-2 text-gray-600 dark:text-gray-300">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1">
                  <span className={`${MODE_BADGE[sheetJob.delivery_mode]} mr-2 align-middle`}>
                    {sheetJob.delivery_mode}
                  </span>
                  <span className="align-middle break-words">
                    {sheetJob.address.trim() ? sheetJob.address : '未填地址'}
                  </span>
                </span>
              </div>
              {sheetJob.note && (
                <p className="rounded-xl bg-warm px-3 py-2 text-xs text-gray-500 dark:bg-white/5 dark:text-gray-400">
                  备注：{sheetJob.note}
                </p>
              )}
              {/* 文件与设置：点文件名预览 */}
              <div className="rounded-xl bg-warm px-3 py-2 dark:bg-white/5">
                <p className="mb-1.5 text-xs text-gray-400">文件与打印设置（点文件名预览）</p>
                <ul className="space-y-1.5">
                  {sheetJob.files.map((file) => (
                    <li key={file.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-1.5 text-left text-sm font-medium text-brand underline-offset-2 hover:underline"
                        onClick={() => void openPreview(sheetJob, file)}
                      >
                        <Eye className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 truncate">{file.filename}</span>
                      </button>
                      <p className="text-xs text-gray-400">
                        {formatSize(file.size)} ·{' '}
                        {describePrintOptions(file.print_options ?? sheetJob.print_options, file.print_options?.copies ?? sheetJob.copies)}
                      </p>
                    </li>
                  ))}
                  {sheetJob.files.length === 0 && <li className="text-xs text-gray-400">无文件</li>}
                </ul>
              </div>
              {sheetJob.status === STATUS_REJECTED && sheetJob.reject_reason && (
                <p className="rounded-xl bg-clay/10 px-3 py-2 text-xs text-clay">驳回理由：{sheetJob.reject_reason}</p>
              )}
              {sheetJob.status === STATUS_FAILED && sheetJob.print_error && (
                <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                  打印错误：{sheetJob.print_error}
                </p>
              )}
            </div>

            {/* 操作：固定在抽屉底部（贴近屏幕下沿，拇指够得到）；按钮大、可换行 */}
            <div
              className="flex flex-wrap gap-2 border-t border-gray-100 px-4 py-3 dark:border-white/10"
              style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
            >
              {sheetJob.status === STATUS_PENDING && (
                <>
                  <button
                    type="button"
                    className={`${BTN_PRIMARY_ROW} bg-brand text-white shadow-brand/25`}
                    disabled={actingId === sheetJob.id}
                    onClick={() => void runFromSheet(() => handleApprove(sheetJob))}
                  >
                    <Check className="h-4 w-4" />
                    同意
                  </button>
                  <button
                    type="button"
                    className={`${BTN_PRIMARY_ROW} bg-clay text-white shadow-clay/25`}
                    disabled={actingId === sheetJob.id}
                    onClick={() => {
                      setDetailId(0)
                      openReject(sheetJob)
                    }}
                  >
                    <X className="h-4 w-4" />
                    驳回
                  </button>
                </>
              )}
              {sheetJob.status === STATUS_FAILED && (
                <button
                  type="button"
                  className={`${BTN_PRIMARY_ROW} bg-brand text-white shadow-brand/25`}
                  disabled={actingId === sheetJob.id}
                  onClick={() => void runFromSheet(() => handleRetry(sheetJob))}
                >
                  <RefreshCw className="h-4 w-4" />
                  重新入队
                </button>
              )}
              {REPRINTABLE.includes(sheetJob.status) && (
                <button
                  type="button"
                  className={`${BTN_PRIMARY_ROW} bg-white text-gray-700 shadow-black/5 dark:bg-white/10 dark:text-gray-200`}
                  disabled={actingId === sheetJob.id}
                  onClick={() => void runFromSheet(() => handleReprint(sheetJob))}
                >
                  <RotateCcw className="h-4 w-4" />
                  重新打印
                </button>
              )}
              {handoverTarget(sheetJob) && (
                <button
                  type="button"
                  className={`${BTN_PRIMARY_ROW} bg-brand text-white shadow-brand/25`}
                  disabled={actingId === sheetJob.id}
                  onClick={() => void runFromSheet(() => handleAdvance(sheetJob, handoverTarget(sheetJob) as JobStatus))}
                >
                  <ListChecks className="h-4 w-4" />
                  标记为「{handoverTarget(sheetJob)}」
                </button>
              )}
              <button
                type="button"
                className={`${BTN_PRIMARY_ROW} bg-clay/10 text-clay shadow-none`}
                disabled={actingId === sheetJob.id}
                onClick={() => {
                  setDetailId(0)
                  setDeleteJob(sheetJob)
                }}
              >
                <Trash2 className="h-4 w-4" />
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 驳回弹窗 */}
      {/* 删除确认（不可恢复：连上传文件一起删） */}
      <Modal
        open={deleteJob !== null}
        title={deleteJob ? `删除任务 #${deleteJob.id}` : '删除任务'}
        onClose={() => setDeleteJob(null)}
        danger
        size="sm"
        footer={
          <>
            <button type="button" className={`${BTN_SECONDARY} ${MODAL_BTN}`} onClick={() => setDeleteJob(null)}>
              取消
            </button>
            <button
              type="button"
              className={`${BTN_DANGER} ${MODAL_BTN}`}
              disabled={actingId === (deleteJob?.id ?? 0)}
              onClick={() => void handleDelete()}
            >
              {actingId === (deleteJob?.id ?? 0) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              确认删除
            </button>
          </>
        }
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          删除后任务记录与上传文件都会消失，<strong>不可恢复</strong>；如果只是想再打一份，请用「重新打印」。
        </p>
      </Modal>

      <Modal
        open={rejectJob !== null}
        title={rejectJob ? `驳回任务 #${rejectJob.id}` : '驳回任务'}
        onClose={closeReject}
        danger
        footer={
          <>
            <button type="button" className={`${BTN_SECONDARY} ${MODAL_BTN}`} onClick={closeReject}>
              取消
            </button>
            <button
              type="button"
              className={`${BTN_DANGER} ${MODAL_BTN}`}
              disabled={rejectBusy || !rejectReason.trim()}
              onClick={() => void submitReject()}
            >
              {rejectBusy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  提交中…
                </>
              ) : (
                '确认驳回'
              )}
            </button>
          </>
        }
      >
        <p className="text-sm text-gray-500 dark:text-gray-400">
          驳回理由会展示给提交人，请说明需要修改的内容（必填）。
        </p>
        <div className="mt-4">
          <label className={LABEL} htmlFor="reject-reason">
            驳回理由
          </label>
          <textarea
            id="reject-reason"
            className={`${INPUT} resize-y`}
            rows={4}
            value={rejectReason}
            placeholder="例如：文件包含无法静默打印的格式，请转成 PDF 后重新提交"
            disabled={rejectBusy}
            onChange={(event) => setRejectReason(event.target.value)}
          />
        </div>
        {rejectError && (
          <p className={`${ALERT_ERROR} mt-3`}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {rejectError}
          </p>
        )}
      </Modal>

      {/* 文件预览弹窗 */}
      <Modal
        open={preview !== null}
        title={preview ? `预览 · ${preview.filename}` : '预览'}
        onClose={closePreview}
        size="lg"
        footer={
          <>
            {preview?.url && (
              <a className={BTN_SECONDARY} href={preview.url} download={preview.filename}>
                下载文件
              </a>
            )}
            <button type="button" className={BTN_SECONDARY} onClick={closePreview}>
              关闭
            </button>
          </>
        }
      >
        {preview?.loading && (
          <p className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载文件…
          </p>
        )}
        {preview?.error && (
          <p className={ALERT_ERROR}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {preview.error}
          </p>
        )}
        {preview?.url && preview.kind === 'pdf' && (
          <iframe
            className="h-[70vh] w-full rounded-xl border border-gray-100 bg-warm dark:border-white/10 dark:bg-white/5"
            src={preview.url}
            title={preview.filename}
          />
        )}
        {preview?.url && preview.kind === 'image' && (
          <img className="mx-auto max-h-[70vh] rounded-xl object-contain" src={preview.url} alt={preview.filename} />
        )}
        {preview?.url && preview.kind === 'other' && (
          <p className="text-sm text-gray-400">该文件类型不支持在线预览，请点击「下载文件」查看。</p>
        )}
      </Modal>

      {/* 手机端「文件与设置」明细弹窗：点行里的图标打开，文件名可直接预览 */}
      <Modal
        open={filesJob !== null}
        title={filesJob ? `任务 #${filesJob.id} 的文件与设置` : '文件与设置'}
        onClose={() => setFilesJob(null)}
        footer={
          <button type="button" className={BTN_PRIMARY_WIDE} onClick={() => setFilesJob(null)}>
          知道了
          </button>
        }
      >
        <ul className="space-y-3">
          {(filesJob?.files ?? []).map((file) => {
            const summary = describePrintOptions(
              file.print_options ?? filesJob?.print_options,
              file.print_options?.copies ?? filesJob?.copies,
            )
            return (
              <li key={file.id} className="rounded-xl bg-warm px-3 py-2.5 dark:bg-white/5">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-sm font-medium text-brand underline-offset-2 hover:underline"
                  onClick={() => {
                    const target = filesJob
                    setFilesJob(null)          // 先关明细弹窗，再开预览弹窗，避免两层叠加
                    if (target) void openPreview(target, file)
                  }}
                >
                  <Eye className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">{file.filename}</span>
                </button>
                <p className="mt-1 text-xs text-gray-400">
                  {formatSize(file.size)} · {summary}
                </p>
              </li>
            )
          })}
          {(filesJob?.files.length ?? 0) === 0 && <li className="text-sm text-gray-400">该任务没有文件</li>}
        </ul>
        <p className="mt-3 text-xs text-gray-400">点文件名可预览；关闭弹窗后仍可在行内对任务做同意 / 驳回 / 删除等操作。</p>
      </Modal>
    </div>
  )
}

export default QueuePage
