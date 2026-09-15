// 已选文件 chip 列表：文件名 + 大小格式化 + 可选删除按钮
import { Eye, FileText, Trash2 } from 'lucide-react'

/** 只依赖文件名与大小，File 与后端 JobFile 都能直接适配 */
export interface FileItem {
  name: string
  size: number
}

interface FileChipsProps {
  files: FileItem[]
  /** 传入时每个 chip 显示删除按钮 */
  onRemove?: (index: number) => void
  /** 传入时文件名为可点击的预览按钮 */
  onPreview?: (index: number) => void
  disabled?: boolean
}

/** 把字节数格式化为 B / KB / MB 展示 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function FileChips({ files, onRemove, onPreview, disabled = false }: FileChipsProps) {
  if (files.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-2">
      {files.map((file, index) => (
        <li
          key={`${file.name}-${index}`}
          className="flex max-w-full items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs dark:border-white/10 dark:bg-white/5"
        >
          <FileText className="h-4 w-4 shrink-0 text-brand-dark dark:text-brand" />
          {onPreview ? (
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 rounded-lg px-1 py-0.5 font-medium text-gray-700 transition-colors hover:bg-brand/10 hover:text-brand-dark disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-200 dark:hover:text-brand"
              title="点击预览"
              aria-label={`预览 ${file.name}`}
              disabled={disabled}
              onClick={() => onPreview(index)}
            >
              <Eye className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{file.name}</span>
            </button>
          ) : (
            <span
              className="min-w-0 truncate font-medium text-gray-700 dark:text-gray-200"
              title={file.name}
            >
              {file.name}
            </span>
          )}
          <span className="shrink-0 text-gray-400">{formatSize(file.size)}</span>
          {onRemove && (
            <button
              type="button"
              className="shrink-0 rounded-lg p-1 text-gray-400 transition-colors hover:bg-clay/10 hover:text-clay focus:outline-none focus:ring-2 focus:ring-clay/30 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={`移除 ${file.name}`}
              title="移除"
              disabled={disabled}
              onClick={() => onRemove(index)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

export default FileChips
