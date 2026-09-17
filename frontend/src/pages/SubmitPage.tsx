// 提交打印页：两步向导 —— 第 1 步选文件并**逐文件**设置打印参数（右栏随设置实时预览），
// 第 2 步填配送方式与备注，提交成功展示任务号与状态。
// 每个文件带自己的打印设置，提交时按文件顺序打包成 settings JSON 数组；任务级打印字段不再使用。
// 表现层为 Tailwind CSS v4 暖色仪表盘风格（配方见 AGENTS.md「前端约定」），图标统一 lucide-react
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  CircleCheckBig,
  Eye,
  FileText,
  LoaderCircle,
  MousePointerClick,
  Printer,
  QrCode,
  Store,
  Trash2,
  Truck,
  Upload,
  UserCog,
} from 'lucide-react'
import { ApiError, api, getErrorMessage } from '../api'
import DropZone from '../components/DropZone'
import Modal from '../components/Modal'
import TextField from '../components/TextField'
import FileChips, { formatSize } from '../components/FileChips'
import {
  DELIVER,
  NUP_OPTIONS,
  PICKUP,
  SCALE_OPTIONS,
  describePrintOptions,
  isOfficeFile,
  previewKind,
  statusBadge,
} from '../constants'
import type { DeliveryMode, Job, PrintOptions } from '../types/api'

const MAX_FILES = 5
const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPT =
  'application/pdf,image/png,image/jpeg,' +
  '.doc,.docx,.ppt,.pptx,application/msword,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'application/vnd.ms-powerpoint,' +
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
/** 配送方式选项：取值就是后端 delivery_mode 的字面量 */
const MODE_OPTIONS: DeliveryMode[] = [DELIVER, PICKUP]

/** 打印设置里的小控件统一样式（数字框/文本框/下拉共用） */
const SELECT_CLASS =
  'w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-gray-100'

/** 主按钮（AGENTS.md「前端约定」配方） */
const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:bg-brand-dark hover:shadow-xl hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60'

/** 次按钮（AGENTS.md「前端约定」配方） */
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60 dark:bg-ink-soft dark:text-gray-300'

/** 单个文件的打印设置（份数存字符串，与输入框取值一致；提交时才转成数字） */
interface FileSettings {
  copies: string
  paper: string
  pages: string
  nup: string
  scale: string
}

const DEFAULT_SETTINGS: FileSettings = {
  copies: '1',
  paper: 'A4',
  pages: '',
  nup: '1,1',
  scale: 'fit',
}

/** 待提交的文件 + 它自己的打印设置（切换文件时各自的设置互不影响） */
interface PickedFile {
  file: File
  settings: FileSettings
}

/** 份数：空串 / 非法值一律回落到 1 */
function copiesOf(settings: FileSettings): number {
  return Math.max(1, Number(settings.copies) || 1)
}

/** 设置 → 后端的 PrintOptions 结构（页面范围为空时不传，交给代理按全部页处理） */
function toPrintOptions(settings: FileSettings): PrintOptions {
  return {
    copies: copiesOf(settings),
    paper: settings.paper,
    pages: settings.pages.trim() || undefined,
    nup: settings.nup,
    scale: settings.scale as PrintOptions['scale'],
  }
}

/** 从「页面范围」里取第一个页码（预览定位用）；取不到就当第 1 页 */
function firstPage(pages: string): number {
  const value = Number(pages.match(/\d+/)?.[0] ?? 1)
  return value > 0 ? value : 1
}

/** 每张纸上的页数（nup 形如 "2,2" = 2 行 × 2 列） */
function nupCount(nup: string): number {
  const [rows, cols] = nup.split(',').map((n) => Number(n) || 1)
  return rows * cols
}

/** 按扩展名决定内嵌预览方式（Word/PPT 由服务端转 PDF 后就按 PDF 预览） */
function fileKind(name: string): 'pdf' | 'image' | 'other' {
  return previewKind(name)
}

function SubmitPage() {
  /** 向导步骤：1 = 打印文件与设置，2 = 配送方式与备注 */
  const [step, setStep] = useState<1 | 2>(1)
  const [picked, setPicked] = useState<PickedFile[]>([])
  /** 当前选中（正在设置 / 预览）的文件下标 */
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<DeliveryMode>(DELIVER)
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<Job | null>(null)
  /** 「我的配置」的默认值已回填（用于提示这一行） */
  const [fromProfile, setFromProfile] = useState(false)
  /** 用户已手动改过表单：默认值只在未改动时回填，避免覆盖已输入的内容 */
  const touchedRef = useRef(false)
  /** 当前选中文件的本地预览地址（本页负责创建与回收） */
  const [previewUrl, setPreviewUrl] = useState('')
  /** 计费信息（余额/单价/是否免费）与本次扣费：免费账号不显示费用行 */
  const [bill, setBill] = useState<{ balance: string; price: string; billable: boolean; free_reason: string } | null>(null)
  const [charged, setCharged] = useState<{ charge: string; balance: string } | null>(null)
  /** 余额不足弹窗（付款码暂未实现，先给占位说明） */
  const [paywall, setPaywall] = useState<{ message: string; cost: string; balance: string } | null>(null)

  /** 当前选中的 Word/PPT 在服务端转成 PDF 后的预览地址（非 Office 文件为空） */
  const [officePreviewUrl, setOfficePreviewUrl] = useState('')
  const [officeConverting, setOfficeConverting] = useState(false)
  const [officeError, setOfficeError] = useState('')
  /** Office 预览请求序号：快速切换文件时丢弃过期响应 */
  const officeSeqRef = useRef(0)

  // 进入页面读取「我的配置」的默认配送方式与默认地址；读取失败静默忽略，不阻断提交
  useEffect(() => {
    let active = true
    void api
      .getBalance()
      .then((info) => {
        if (active) {
          setBill({ balance: String(info.balance), price: info.price, billable: info.billable, free_reason: info.free_reason })
        }
      })
      .catch(() => undefined)
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

  // 文件被删除后把选中下标夹回有效范围
  useEffect(() => {
    if (selectedIndex > picked.length - 1) setSelectedIndex(Math.max(0, picked.length - 1))
  }, [picked.length, selectedIndex])

  const selected = picked[selectedIndex] ?? null
  const selectedFile = selected?.file ?? null
  const settings = selected?.settings ?? DEFAULT_SETTINGS
  const kind = selectedFile ? fileKind(selectedFile.name) : 'other'
  const options = toPrintOptions(settings)
  const startPage = firstPage(settings.pages)
  const sheetsPerPage = nupCount(settings.nup)
  const scaleLabel =
    SCALE_OPTIONS.find((option) => option.value === settings.scale)?.label ?? settings.scale

  // 当前选中文件的临时地址：切换文件时重建，切换 / 卸载时回收
  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl('')
      return
    }
    const url = URL.createObjectURL(selectedFile)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [selectedFile])

  // Word/PPT：提交前先让服务端转成 PDF 再预览（结果按内容缓存，正式提交时命中同一份，不再转第二次）
  useEffect(() => {
    const seq = officeSeqRef.current + 1
    officeSeqRef.current = seq
    setOfficePreviewUrl('')
    setOfficeError('')
    if (!selectedFile || !isOfficeFile(selectedFile.name)) {
      setOfficeConverting(false)
      return
    }
    setOfficeConverting(true)
    api
      .convertOfficePreview(selectedFile)
      .then((blob) => {
        if (officeSeqRef.current !== seq) return
        setOfficePreviewUrl(URL.createObjectURL(blob))
        setOfficeConverting(false)
      })
      .catch((err) => {
        if (officeSeqRef.current !== seq) return
        setOfficeError(getErrorMessage(err))
        setOfficeConverting(false)
      })
  }, [selectedFile])

  // Office 转换出的临时地址：切换文件 / 卸载时回收
  useEffect(() => {
    if (!officePreviewUrl) return
    return () => URL.revokeObjectURL(officePreviewUrl)
  }, [officePreviewUrl])

  /** 取件时不要求地址，输入框改成地点备注 */
  const isPickup = mode === PICKUP

  /** 过滤超限文件并裁剪数量，同时给出中文提示；仍在列表里的文件保留它已有的打印设置 */
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
    const capped = accepted.slice(0, MAX_FILES)
    setPicked((prev) =>
      capped.map(
        (file) =>
          prev.find((item) => item.file === file) ??
          prev.find((item) => item.file.name === file.name && item.file.size === file.size) ?? {
            file,
            settings: { ...DEFAULT_SETTINGS },
          },
      ),
    )
  }

  /** 只改当前选中文件的设置，其它文件的设置保持不变 */
  function updateSettings(patch: Partial<FileSettings>) {
    setPicked((prev) =>
      prev.map((item, index) =>
        index === selectedIndex ? { ...item, settings: { ...item.settings, ...patch } } : item,
      ),
    )
  }

  function removeFile(index: number) {
    setPicked((prev) => prev.filter((_, current) => current !== index))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (picked.length === 0) {
      setError('请先选择要打印的文件')
      setStep(1)
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
    formData.append('note', note.trim())
    // 逐文件设置：数组顺序与 files 一一对应，每项键齐全（页面范围为空串也带上）
    formData.append(
      'settings',
      JSON.stringify(
        picked.map((item) => ({
          copies: copiesOf(item.settings),
          paper: item.settings.paper,
          pages: item.settings.pages.trim(),
          nup: item.settings.nup,
          scale: item.settings.scale,
        })),
      ),
    )
    for (const item of picked) formData.append('files', item.file)

    setError('')
    setSubmitting(true)
    try {
      const job = await api.submitJob(formData)
      setCreated(job)
      // 计费以服务端为准（张数 × 单价）：成功后刷新余额，成功卡片展示本次扣费与剩余余额
      const info = await api.getBalance().catch(() => null)
      if (info) {
        setBill({ balance: String(info.balance), price: info.price, billable: info.billable, free_reason: info.free_reason })
        setCharged({ charge: String(job.charge ?? 0), balance: String(info.balance) })
      }
      setPicked([])
      setSelectedIndex(0)
      setAddress('')
      setNote('')
      setStep(1)
    } catch (err) {
      // 余额不足（402）：弹「付款码（暂未实现）」占位，而不是干巴巴一行红字
      if (err instanceof ApiError && err.status === 402 && err.detail && typeof err.detail === 'object') {
        const detail = err.detail as { message?: string; cost?: string; balance?: string }
        setPaywall({
          message: detail.message || '余额不足，请先充值',
          cost: detail.cost || '0',
          balance: detail.balance || '0',
        })
      } else {
        setError(getErrorMessage(err))
      }
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
          {charged && (
            <li className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-gray-400">本次扣费</span>
              <span className="font-medium text-gray-700 dark:text-gray-200">
                {Number(charged.charge) > 0 ? `${Number(charged.charge).toFixed(2)} 元` : '免费'}
                <span className="ml-2 text-xs text-gray-400">余额 {Number(charged.balance).toFixed(2)} 元</span>
              </span>
            </li>
          )}
          {/* 打印设置逐个文件一行（每个文件可有自己的份数/纸张/页面范围等） */}
          <li className="space-y-2">
            <span className="text-gray-400">打印设置</span>
            <ul className="space-y-1.5">
              {created.files.map((file) => (
                <li key={file.id} className="text-gray-700 dark:text-gray-200">
                  <span className="break-all">{file.filename}</span>
                  {'：'}
                  <span className="font-medium">
                    {describePrintOptions(file.print_options, file.print_options?.copies)}
                  </span>
                </li>
              ))}
            </ul>
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
          className={PRIMARY_BUTTON}
        >
          <Upload className="h-4 w-4" />
          再提交一单
        </button>
      </section>
    )
  }

  // ── 第 2 步：配送方式与备注（第 1 步填的内容全部保留，返回即可继续改） ──
  if (step === 2) {
    return (
      <form className="mx-auto w-full max-w-2xl space-y-5" onSubmit={handleSubmit}>
        {/* 汇总：默认收起，展开可看每个文件及其打印设置 */}
        <section className="rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft">
          <details>
            <summary className="cursor-pointer text-sm font-medium text-gray-700 marker:text-gray-400 dark:text-gray-200">
              <span className="inline-flex items-center gap-2 align-middle">
                <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                已选 {picked.length} 个文件
              </span>
            </summary>
            <ul className="mt-3 space-y-2 border-t border-gray-100 pt-3 text-xs dark:border-white/10">
              {picked.map((item, index) => (
                <li
                  key={`${item.file.name}-${index}`}
                  className="flex items-start justify-between gap-3"
                >
                  <span className="min-w-0 truncate text-gray-600 dark:text-gray-300" title={item.file.name}>
                    {item.file.name}
                  </span>
                  <span className="shrink-0 text-gray-400">
                    {describePrintOptions(toPrintOptions(item.settings), copiesOf(item.settings))}
                  </span>
                </li>
              ))}
            </ul>
          </details>
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

          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={submitting}
              onClick={() => setStep(1)}
            >
              <ArrowLeft className="h-4 w-4" />
              返回修改打印设置
            </button>
            <button type="submit" className={`${PRIMARY_BUTTON} flex-1`} disabled={submitting}>
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
          </div>
        </section>

        {/* 余额不足：付款码暂未实现，先给占位说明（金额与余额都来自服务端 402 详情） */}
        <Modal
          open={paywall !== null}
          title="余额不足"
          size="sm"
          onClose={() => setPaywall(null)}
          footer={
            <>
              <button
                type="button"
                className={`${SECONDARY_BUTTON} flex-1 justify-center sm:flex-none`}
                onClick={() => setPaywall(null)}
              >
                知道了
              </button>
              <Link
                to="/balance"
                className={`${PRIMARY_BUTTON} flex-1 justify-center sm:flex-none`}
                onClick={() => setPaywall(null)}
              >
                去我的余额
              </Link>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">{paywall?.message}</p>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-warm px-4 py-3 text-sm dark:bg-white/5">
            <span className="text-gray-400">本单应付</span>
            <span className="font-semibold text-gray-800 dark:text-gray-100">
              {Number(paywall?.cost ?? 0).toFixed(2)} 元
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 rounded-xl bg-warm px-4 py-3 text-sm dark:bg-white/5">
            <span className="text-gray-400">当前余额</span>
            <span className="font-semibold text-gray-800 dark:text-gray-100">
              {Number(paywall?.balance ?? 0).toFixed(2)} 元
            </span>
          </div>
          {/* 付款码占位：付款功能未实现，先把位置留出来 */}
          <div className="mt-4 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-gray-200 px-6 py-8 text-center dark:border-white/10">
            <QrCode className="h-16 w-16 text-gray-300 dark:text-gray-600" />
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">付款码暂未开放</p>
            <p className="text-xs text-gray-400">
              充值功能待实现；当前可联系管理员代记余额，或让管理员把账号加入免费白名单。
            </p>
          </div>
        </Modal>
      </form>
    )
  }

  // ── 第 1 步：打印文件与设置 ──
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      {/* 左栏：上传区 + 文件行列表（点行即选中，右侧设置与预览跟着切换） */}
      <section className="rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-dark dark:text-brand">
            <FileText className="h-[18px] w-[18px]" />
          </span>
          <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">打印文件</h2>
        </div>

        <DropZone
          files={picked.map((item) => item.file)}
          onChange={handleFiles}
          accept={ACCEPT}
          multiple
          hideChips
          hint="支持 PDF / 图片 / Word / PPT，单文件 ≤10MB，最多 5 个（Word/PPT 会先转成 PDF）"
        />

        {picked.length > 0 && (
          <ul className="mt-4 space-y-2">
            {picked.map((item, index) => {
              const active = index === selectedIndex
              return (
                <li key={`${item.file.name}-${index}`}>
                  <div
                    id={`file-row-${index}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={active}
                    aria-label={`选中文件 ${item.file.name}`}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand/30 ${
                      active
                        ? 'border-brand bg-brand/10'
                        : 'border-gray-200 bg-white hover:border-brand/50 hover:bg-warm dark:border-white/10 dark:bg-white/5 dark:hover:border-brand/40'
                    }`}
                    onClick={() => setSelectedIndex(index)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedIndex(index)
                      }
                    }}
                  >
                    <FileText
                      className={`h-4 w-4 shrink-0 ${
                        active ? 'text-brand-dark dark:text-brand' : 'text-gray-400'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={`truncate text-sm ${
                          active
                            ? 'font-medium text-brand-dark dark:text-brand'
                            : 'text-gray-700 dark:text-gray-200'
                        }`}
                        title={item.file.name}
                      >
                        {item.file.name}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-gray-400">
                        <MousePointerClick className="h-3.5 w-3.5 shrink-0" />
                        <span>点击即选中</span>
                        <span>·</span>
                        <span>{formatSize(item.file.size)}</span>
                        <span>·</span>
                        <span>
                          {describePrintOptions(toPrintOptions(item.settings), copiesOf(item.settings))}
                        </span>
                      </p>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-clay/10 hover:text-clay focus:outline-none focus:ring-2 focus:ring-clay/30 disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`移除 ${item.file.name}`}
                      title="移除"
                      disabled={submitting}
                      onClick={(event) => {
                        // 删除按钮在可点击的行里，别让点击顺带切换选中项
                        event.stopPropagation()
                        removeFile(index)
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {error && (
          <p className="mt-4 flex items-start gap-2 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        )}
      </section>

      {/* 右栏：当前选中文件的打印设置 + 预览（设置只作用于选中的那个文件） */}
      <section className="space-y-4 rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft">
        {selectedFile ? (
          <>
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-dark dark:text-brand">
                <Printer className="h-[18px] w-[18px]" />
              </span>
              <h2 className="min-w-0 truncate text-sm font-medium text-gray-700 dark:text-gray-200">
                打印设置（针对{' '}
                <span className="text-brand-dark dark:text-brand">{selectedFile.name}</span>）
              </h2>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block" htmlFor="file-settings-copies">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">份数</span>
                <input
                  id="file-settings-copies"
                  type="number"
                  min={1}
                  max={99}
                  className={SELECT_CLASS}
                  value={settings.copies}
                  disabled={submitting}
                  onChange={(event) => updateSettings({ copies: event.target.value })}
                />
              </label>
              <label className="block" htmlFor="file-settings-paper">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">纸张大小</span>
                {/* 2026-09-16 起固定 A4：目标机型是 A4 黑白激光，纸张不再给选择 */}
                <div
                  id="file-settings-paper"
                  className={`${SELECT_CLASS} flex items-center text-gray-500 dark:text-gray-400`}
                >
                  A4（固定）
                </div>
              </label>
              <label className="block" htmlFor="file-settings-pages">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">页面范围</span>
                <input
                  id="file-settings-pages"
                  className={SELECT_CLASS}
                  placeholder="例如 1-3,5（留空=全部）"
                  value={settings.pages}
                  disabled={submitting}
                  onChange={(event) => updateSettings({ pages: event.target.value })}
                />
              </label>
              <label className="block" htmlFor="file-settings-nup">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">每张纸页数</span>
                <select
                  id="file-settings-nup"
                  className={SELECT_CLASS}
                  value={settings.nup}
                  disabled={submitting}
                  onChange={(event) => updateSettings({ nup: event.target.value })}
                >
                  {NUP_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block sm:col-span-2" htmlFor="file-settings-scale">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">缩放</span>
                <select
                  id="file-settings-scale"
                  className={SELECT_CLASS}
                  value={settings.scale}
                  disabled={submitting}
                  onChange={(event) => updateSettings({ scale: event.target.value })}
                >
                  {SCALE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* 预览：页面范围决定起始页；多页排版与缩放浏览器不做重排，只用文字提示 */}
            <div className="space-y-1">
              <p className="flex items-center gap-1.5 text-xs text-gray-400">
                <Eye className="h-3.5 w-3.5 shrink-0" />
                <span>
                  预览：{selectedFile.name}
                  {officePreviewUrl ? '（Word/PPT 已转 PDF）' : ''} · 第 {startPage} 页 ·{' '}
                  {describePrintOptions(options, options.copies)}
                </span>
              </p>
              {sheetsPerPage !== 1 && (
                <p className="text-xs text-amber-700 dark:text-amber">
                  打印时按 {sheetsPerPage} 页/张排版，预览为单页视图
                </p>
              )}
              {settings.scale !== 'fit' && (
                <p className="text-xs text-amber-700 dark:text-amber">
                  实际打印会按「{scaleLabel}」缩放
                </p>
              )}
              {bill?.billable && (
                <p className="flex items-center gap-1.5 text-xs text-gray-400">
                  <QrCode className="h-3.5 w-3.5" />
                  按 {bill.price} 计费（每张纸），提交时从余额扣除，当前余额 {Number(bill.balance).toFixed(2)} 元
                </p>
              )}
              {bill && !bill.billable && (
                <p className="text-xs text-gray-400">免费账号（{bill.free_reason || '免打印费'}），提交不扣费</p>
              )}
            </div>

            <div
              id="file-preview"
              className="h-[300px] w-full overflow-hidden rounded-xl border border-gray-200 bg-white sm:h-[480px] dark:border-white/10 dark:bg-ink"
            >
              {officeConverting && (
                <p className="flex h-full items-center justify-center gap-2 px-4 text-sm text-gray-400">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  正在把 Word/PPT 转成 PDF…
                </p>
              )}
              {!officeConverting && officeError && (
                <p className="px-4 py-8 text-center text-sm text-clay">{officeError}</p>
              )}
              {!officeConverting && !officeError && (officePreviewUrl || previewUrl) && kind === 'pdf' && (
                <iframe
                  className="h-full w-full"
                  src={`${officePreviewUrl || previewUrl}#page=${startPage}`}
                  title={selectedFile.name}
                />
              )}
              {!officeConverting && !officeError && !officePreviewUrl && previewUrl && kind === 'image' && (
                <img className="mx-auto max-h-[300px] sm:max-h-[480px]" src={previewUrl} alt={selectedFile.name} />
              )}
              {!officeConverting && !officeError && !officePreviewUrl && previewUrl && kind === 'other' && (
                <p className="px-4 py-8 text-center text-xs text-gray-400">该文件类型不支持内嵌预览</p>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200 bg-white/60 px-6 py-16 text-center text-sm text-gray-400 dark:border-white/10 dark:bg-white/5">
            <Printer className="h-6 w-6" />
            <p>还没有选择文件，先在左侧上传要打印的文件</p>
          </div>
        )}

        <div className="space-y-2">
          <button
            type="button"
            className={`${PRIMARY_BUTTON} w-full`}
            disabled={picked.length === 0}
            onClick={() => setStep(2)}
          >
            <ArrowRight className="h-4 w-4" />
            下一步：填写配送信息
          </button>
          {picked.length === 0 && (
            <p className="text-center text-xs text-gray-400">请先选择要打印的文件</p>
          )}
        </div>
      </section>
    </div>
  )
}

export default SubmitPage
