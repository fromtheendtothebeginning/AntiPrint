// 拖拽 / 点击选择文件，已选文件用 FileChips 展示
import { useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react'
import { UploadCloud } from 'lucide-react'
import FileChips from './FileChips'

interface DropZoneProps {
  files: File[]
  onChange: (files: File[]) => void
  /** 传给原生 input 的 accept，如 "application/pdf,image/*" */
  accept?: string
  multiple?: boolean
  /** 区域下方的提示文案（格式要求、数量限制等） */
  hint?: string
  /** 传入时已选文件名可点击预览（提交前预览用） */
  onPreview?: (index: number) => void
}

function DropZone({ files, onChange, accept, multiple = true, hint, onPreview }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

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

  return (
    <div className="space-y-3">
      <div
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
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-dark dark:text-brand">
          <UploadCloud className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
          点击选择文件，或将文件拖拽到这里
        </p>
        {hint && <p className="text-xs text-gray-400">{hint}</p>}
      </div>
      {/* 真实文件输入框：视觉隐藏但保留在 DOM 里（自动化测试靠它 setInputFiles） */}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={accept}
        multiple={multiple}
        onChange={handleInputChange}
      />
      <FileChips
        files={files}
        onRemove={(index) => onChange(files.filter((_, current) => current !== index))}
        onPreview={onPreview}
      />
    </div>
  )
}

export default DropZone
