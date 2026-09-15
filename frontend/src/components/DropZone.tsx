// 拖拽 / 点击选择文件。两种形态：
//   1) 默认：虚线投放区（点击或拖入选择文件），已选文件用 FileChips 展示
//   2) previewInline：选完文件后投放区**变成预览面板**（PDF 用 iframe、图片用 img），
//      面板里可以切换文件、继续添加、清空，并支持把文件直接拖进面板继续追加
// hideChips：只渲染投放区与隐藏 input，不渲染 FileChips（调用方自己画文件列表，如提交页）
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react'
import { Expand, Plus, Trash2, UploadCloud } from 'lucide-react'
import FileChips from './FileChips'

interface DropZoneProps {
  files: File[]
  onChange: (files: File[]) => void
  /** 传给原生 input 的 accept，如 "application/pdf,image/*" */
  accept?: string
  multiple?: boolean
  /** 区域下方的提示文案（格式要求、数量限制等） */
  hint?: string
  /** 放大查看（弹窗）；previewInline 时由面板上的按钮触发 */
  onPreview?: (index: number) => void
  /** 选完文件后把投放区换成预览面板（提交页启用） */
  previewInline?: boolean
  /** 为真时只渲染投放区与隐藏 input，不再渲染 FileChips（文件列表由调用方自己画） */
  hideChips?: boolean
}

/** 按扩展名决定内嵌预览方式 */
function fileKind(name: string): 'pdf' | 'image' | 'other' {
  const lower = (name || '').toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(lower)) return 'image'
  return 'other'
}

function DropZone({
  files,
  onChange,
  accept,
  multiple = true,
  hint,
  onPreview,
  previewInline = false,
  hideChips = false,
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [previewUrl, setPreviewUrl] = useState('')

  const activeFile = previewInline ? (files[activeIndex] ?? null) : null

  // 文件被移除后把当前预览项夹回有效范围
  useEffect(() => {
    if (activeIndex > files.length - 1) setActiveIndex(Math.max(0, files.length - 1))
  }, [files.length, activeIndex])

  // 当前预览文件的临时地址（切换文件或列表变化时重建，卸载时回收）
  useEffect(() => {
    if (!activeFile) {
      setPreviewUrl('')
      return
    }
    const url = URL.createObjectURL(activeFile)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [activeFile])

  /** 合并新选择的文件：单选直接替换，多选追加（同名同大小视为重复，忽略） */
  function addFiles(incoming: File[]) {
    if (incoming.length === 0) return
    if (!multiple) {
      onChange(incoming.slice(0, 1))
      return
    }
    const merged = [...files]
    for (const file of incoming) {
      const exists = merged.some((item) => item.name === file.name && item.size === file.size)
      if (!exists) merged.push(file)
    }
    onChange(merged)
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []))
    // 清空 value，保证再次选择同一个文件也能触发 change
    event.target.value = ''
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      inputRef.current?.click()
    }
  }

  const dragProps = {
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragging(true)
    },
    onDragLeave: () => setDragging(false),
    onDrop: handleDrop,
  }

  const kind = activeFile ? fileKind(activeFile.name) : 'other'

  return (
    <div className="space-y-3">
      {activeFile ? (
        // ── 预览形态：投放区变成预览面板（拖文件进来仍可继续追加） ──
        <div
          {...dragProps}
          className={`rounded-2xl border p-3 transition-all duration-200 ${
            dragging
              ? 'border-brand bg-brand/10'
              : 'border-gray-200 bg-warm dark:border-white/10 dark:bg-white/5'
          }`}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">
              已选 {files.length} 个文件 · 正在预览：
              <span className="font-medium text-gray-700 dark:text-gray-200">{activeFile.name}</span>
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              {onPreview && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-brand/10 hover:text-brand-dark dark:text-gray-400 dark:hover:text-brand"
                  onClick={() => onPreview(activeIndex)}
                >
                  <Expand className="h-3.5 w-3.5" />
                  放大查看
                </button>
              )}
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-brand/10 hover:text-brand-dark dark:text-gray-400 dark:hover:text-brand"
                onClick={() => inputRef.current?.click()}
              >
                <Plus className="h-3.5 w-3.5" />
                继续添加
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-clay/10 hover:text-clay dark:text-gray-400"
                onClick={() => onChange([])}
              >
                <Trash2 className="h-3.5 w-3.5" />
                清空
              </button>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-ink">
            {previewUrl && kind === 'pdf' && (
              <iframe className="h-[480px] w-full" src={previewUrl} title={activeFile.name} />
            )}
            {previewUrl && kind === 'image' && (
              <img className="mx-auto max-h-[480px]" src={previewUrl} alt={activeFile.name} />
            )}
            {previewUrl && kind === 'other' && (
              <p className="px-4 py-8 text-center text-xs text-gray-400">
                该文件类型不支持内嵌预览，提交后管理员可下载查看
              </p>
            )}
          </div>

          <p className="mt-2 text-xs text-gray-400">
            点下方文件名可切换预览；也可以继续把文件拖到这里添加
          </p>
        </div>
      ) : (
        // ── 投放形态：虚线投放区 ──
        <div
          {...dragProps}
          className={`flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-6 py-10 text-center transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand/30 ${
            dragging
              ? 'border-brand bg-brand/10'
              : 'border-gray-200 bg-warm hover:border-brand/60 hover:bg-brand/5 dark:border-white/10 dark:bg-white/5 dark:hover:border-brand/40'
          }`}
          role="button"
          tabIndex={0}
          aria-label="选择文件"
          onClick={() => inputRef.current?.click()}
          onKeyDown={handleKeyDown}
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-dark dark:text-brand">
            <UploadCloud className="h-5 w-5" />
          </span>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
            点击选择文件，或将文件拖拽到这里
          </p>
          {hint && <p className="text-xs text-gray-400">{hint}</p>}
        </div>
      )}

      {/* 真实文件输入框：视觉隐藏但保留在 DOM 里（自动化测试靠它 setInputFiles） */}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={accept}
        multiple={multiple}
        onChange={handleInputChange}
      />

      {!hideChips && (
        <FileChips
          files={files}
          onRemove={(index) => onChange(files.filter((_, current) => current !== index))}
          // previewInline 时点文件名切到那个文件的预览（而不是弹窗）
          onPreview={previewInline ? (index) => setActiveIndex(index) : onPreview}
        />
      )}
    </div>
  )
}

export default DropZone
