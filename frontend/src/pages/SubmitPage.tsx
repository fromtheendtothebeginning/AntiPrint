// 提交打印页：选择文件 + 配送方式（配送 / 取件）+ 地址或取件备注 + 备注，提交成功展示任务号与状态
// 表现层为 Tailwind CSS v4 暖色仪表盘风格（配方见 AGENTS.md「前端约定」），图标统一 lucide-react
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { CircleAlert, CircleCheckBig, FileText, LoaderCircle, Printer, Store, Truck, Upload, UserCog } from 'lucide-react'
import { api, getErrorMessage } from '../api'
import DropZone from '../components/DropZone'
import TextField from '../components/TextField'
import FileChips from '../components/FileChips'
import {
  DELIVER,
  NUP_OPTIONS,
  PAPER_OPTIONS,
  PICKUP,
  SCALE_OPTIONS,
  describePrintOptions,
  statusBadge,
} from '../constants'
import type { DeliveryMode, Job } from '../types/api'

const MAX_FILES = 5
const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPT = 'application/pdf,image/png,image/jpeg'
/** 配送方式选项：取值就是后端 delivery_mode 的字面量 */
const MODE_OPTIONS: DeliveryMode[] = [DELIVER, PICKUP]

/** 打印设置里的小控件统一样式（数字框/文本框/下拉共用） */
const SELECT_CLASS =
  'w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-gray-100'

function SubmitPage() {
  const [files, setFiles] = useState<File[]>([])
  const [mode, setMode] = useState<DeliveryMode>(DELIVER)
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  // 打印设置：默认给确定值（单面 / A4 / 黑白 / 1 页每张 / 适应纸张 / 1 份），不依赖驱动默认
  const [copies, setCopies] = useState('1')
  const [paper, setPaper] = useState('A4')
  const [pages, setPages] = useState('')
  const [nup, setNup] = useState('1,1')
  const [scale, setScale] = useState('fit')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<Job | null>(null)
  /** 「我的配置」的默认值已回填（用于提示这一行） */
  const [fromProfile, setFromProfile] = useState(false)
  /** 用户已手动改过表单：默认值只在未改动时回填，避免覆盖已输入的内容 */
  const touchedRef = useRef(false)

  // 进入页面读取「我的配置」的默认配送方式与默认地址；读取失败静默忽略，不阻断提交
  useEffect(() => {
    let active = true
    api
      .getProfile()
      .then((profile) => {
        if (!active || touchedRef.current) return
        setMode(profile.default_delivery)
        if (profile.default_address) setAddress(profile.default_address)
        setFromProfile(true)
      })
      .catch(() => {
        // 读不到就沿用空表单，用户照常手填
      })
    return () => {
      active = false
    }
  }, [])

  /** 取件时不要求地址，输入框改成地点备注 */
  const isPickup = mode === PICKUP

  /** 过滤超限文件并裁剪数量，同时给出中文提示 */
  function handleFiles(next: File[]) {
    const oversized = next.filter((file) => file.size > MAX_FILE_SIZE)
    const accepted = next.filter((file) => file.size <= MAX_FILE_SIZE)
    if (oversized.length > 0) {
      setError(`文件「${oversized[0].name}」超过 10MB，未加入列表`)
    } else if (accepted.length > MAX_FILES) {
      setError(`最多上传 ${MAX_FILES} 个文件，多余的已自动忽略`)
    } else {
      setError('')
    }
    setFiles(accepted.slice(0, MAX_FILES))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (files.length === 0) {
      setError('请先选择要打印的文件')
      return
    }
    const trimmedAddress = address.trim()
    // 取件单地址可为空，只作为取件地点备注
    if (!isPickup && !trimmedAddress) {
      setError('请填写配送地址')
      return
    }

    const formData = new FormData()
    formData.append('delivery_mode', mode)
    formData.append('address', trimmedAddress)
    formData.append('copies', copies || '1')
    formData.append('paper', paper)
    formData.append('nup', nup)
    formData.append('scale', scale)
    if (pages.trim()) formData.append('pages', pages.trim())
    if (note.trim()) formData.append('note', note.trim())
    for (const file of files) formData.append('files', file)

    setError('')
    setSubmitting(true)
    try {
      const job = await api.submitJob(formData)
      setCreated(job)
      setFiles([])
      setAddress('')
      setNote('')
      setPages('')
      setCopies('1')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (created) {
    return (
      <section className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 rounded-2xl bg-white p-8 text-center shadow-xl shadow-black/[0.04] dark:bg-ink-soft">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10 text-brand-dark dark:text-brand">
          <CircleCheckBig className="h-7 w-7" />
        </span>
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">提交成功</h2>
        <p className="text-sm text-gray-400">
          任务已创建，等待管理员审核，审核通过后由打印代理出纸。
        </p>
        <ul className="w-full space-y-3 rounded-xl bg-warm p-5 text-left text-sm dark:bg-white/5">
          <li className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-gray-400">任务号</span>
            <strong className="font-mono text-gray-700 dark:text-gray-200">#{created.id}</strong>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-gray-400">状态</span>
            <span className={statusBadge(created.status)}>{created.status}</span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-gray-400">配送方式</span>
            <span className="font-medium text-gray-700 dark:text-gray-200">{created.delivery_mode}</span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-gray-400">打印设置</span>
            <span className="text-right font-medium text-gray-700 dark:text-gray-200">
              {describePrintOptions(created.print_options, created.copies)}
            </span>
          </li>
          {created.address && (
            <li className="flex items-start justify-between gap-3">
              <span className="shrink-0 text-gray-400">
                {created.delivery_mode === PICKUP ? '取件地点备注' : '配送地址'}
              </span>
              <span className="min-w-0 text-right text-gray-700 dark:text-gray-200">
                {created.address}
              </span>
            </li>
          )}
          <li className="space-y-2">
            <span className="text-gray-400">文件</span>
            <FileChips
              files={created.files.map((file) => ({ name: file.filename, size: file.size }))}
            />
          </li>
        </ul>
        <button
          type="button"
          onClick={() => setCreated(null)}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:bg-brand-dark hover:shadow-xl hover:-translate-y-0.5"
        >
          <Upload className="h-4 w-4" />
          再提交一单
        </button>
      </section>
    )
  }

  return (
    <form className="grid items-start gap-5 md:grid-cols-2" onSubmit={handleSubmit}>
      <section className="rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-dark dark:text-brand">
            <FileText className="h-[18px] w-[18px]" />
          </span>
          <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">打印文件</h2>
        </div>
        <DropZone
          files={files}
          onChange={handleFiles}
          accept={ACCEPT}
          multiple
          hint="支持 PDF / 图片，单文件 ≤10MB，最多 5 个"
        />
      </section>

      <section className="space-y-5 rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft">
        {/* 配送方式：配送 = 送到地址；取件 = 出纸后自己来取（地址变成可选的地点备注） */}
        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-200">
            配送方式
          </legend>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {MODE_OPTIONS.map((value) => {
              const active = mode === value
              const Icon = value === DELIVER ? Truck : Store
              return (
                <label
                  key={value}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-4 py-3 text-sm transition-all duration-200 ${
                    active
                      ? 'border-brand bg-brand/10 font-medium text-brand-dark dark:text-brand'
                      : 'border-gray-200 bg-warm text-gray-600 hover:border-brand/50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    className="h-4 w-4 accent-brand"
                    name="delivery-mode"
                    value={value}
                    checked={active}
                    disabled={submitting}
                    onChange={() => {
                      touchedRef.current = true
                      setMode(value)
                    }}
                  />
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{value === DELIVER ? `${DELIVER}（送到地址）` : `${PICKUP}（自己来取）`}</span>
                </label>
              )
            })}
          </div>
        </fieldset>

        {/* 打印设置：份数 / 单双面 / 纸张 / 颜色 / 页面范围 / 每张页数 / 缩放，随任务下发给打印代理 */}
        <div className="rounded-xl border border-gray-100 bg-warm/60 p-4 dark:border-white/10 dark:bg-white/5">
          <div className="mb-3 flex items-center gap-2">
            <Printer className="h-4 w-4 text-gray-400" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">打印设置</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">份数</span>
              <input
                type="number"
                min={1}
                max={99}
                className={SELECT_CLASS}
                value={copies}
                disabled={submitting}
                onChange={(event) => setCopies(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">纸张大小</span>
              <select
                className={SELECT_CLASS}
                value={paper}
                disabled={submitting}
                onChange={(event) => setPaper(event.target.value)}
              >
                {PAPER_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">页面范围（可选）</span>
              <input
                className={SELECT_CLASS}
                placeholder="例如 1-3,5（留空=全部）"
                value={pages}
                disabled={submitting}
                onChange={(event) => setPages(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">每张纸页数</span>
              <select
                className={SELECT_CLASS}
                value={nup}
                disabled={submitting}
                onChange={(event) => setNup(event.target.value)}
              >
                {NUP_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">缩放</span>
              <select
                className={SELECT_CLASS}
                value={scale}
                disabled={submitting}
                onChange={(event) => setScale(event.target.value)}
              >
                {SCALE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-3 text-xs text-gray-400">
            以上设置对本次任务的所有文件生效；本机打印机为黑白激光、无自动双面（A4）
          </p>
        </div>

        <TextField
          label={isPickup ? '取件地点备注（可选）' : '配送地址'}
          name="address"
          value={address}
          placeholder={
            isPickup
              ? '例如：三教 305 讲台旁 / 联系我取件的时间'
              : '例如：三教 305 教室靠窗第一排 / 5 号宿舍楼 402'
          }
          disabled={submitting}
          onChange={(event) => {
            touchedRef.current = true
            setAddress(event.target.value)
          }}
        />

        {fromProfile && (
          <p className="flex items-center gap-1.5 text-xs text-gray-400">
            <UserCog className="h-3.5 w-3.5 shrink-0" />
            <span>
              默认值来自
              <Link
                className="mx-0.5 font-medium text-brand underline-offset-2 hover:underline"
                to="/profile"
              >
                我的配置
              </Link>
              ，提交前可随时修改
            </span>
          </p>
        )}

        <div>
          <label
            className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-200"
            htmlFor="submit-note"
          >
            备注（可选）
          </label>
          <textarea
            id="submit-note"
            className="min-h-[96px] w-full resize-y rounded-xl border border-gray-200 bg-warm px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 dark:border-white/10 dark:bg-white/5 dark:text-gray-100"
            value={note}
            placeholder="例如：单面打印、需要装订、联系电话等"
            disabled={submitting}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        {error && (
          <p className="flex items-start gap-2 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:bg-brand-dark hover:shadow-xl hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? (
            <>
              <LoaderCircle className="h-4 w-4 animate-spin" />
              提交中…
            </>
          ) : (
            <>
              <Upload className="h-4 w-4" />
              提交打印任务
            </>
          )}
        </button>
      </section>
    </form>
  )
}

export default SubmitPage
