// 通用弹窗：遮罩点击关闭、Esc 关闭、打开时自动聚焦；危险操作把焦点落在取消按钮上
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /** 底部操作区（通常放「取消 / 确认」按钮） */
  footer?: ReactNode
  size?: 'sm' | 'lg'
  /** 危险操作：焦点默认落在取消（关闭）按钮上，避免回车误确认 */
  danger?: boolean
}

/** 面板宽度：不传 size 用 max-w-md（AGENTS.md 弹窗配方），sm 更窄、lg 更宽 */
const SIZE_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
}

function Modal({ open, title, onClose, children, footer, size, danger = false }: ModalProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Esc 关闭；打开期间锁定页面滚动
  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  // 挂载时聚焦
  useEffect(() => {
    if (!open) return
    if (danger) cancelRef.current?.focus()
    else sheetRef.current?.focus()
  }, [open, danger])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={sheetRef}
        className={`max-h-[85vh] w-full overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl focus:outline-none dark:bg-ink-soft ${
          SIZE_CLASS[size ?? 'md']
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
          <button
            ref={cancelRef}
            type="button"
            className="-mr-1 -mt-1 shrink-0 rounded-xl p-2 text-gray-400 transition-colors hover:bg-warm hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand/30 dark:hover:bg-white/5 dark:hover:text-gray-200"
            aria-label="取消"
            title="取消"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 text-sm text-gray-600 dark:text-gray-300">{children}</div>
        {footer && (
          <div className="mt-6 flex flex-wrap items-center justify-end gap-3">{footer}</div>
        )}
      </div>
    </div>
  )
}

export default Modal
