// 统一文本输入框：可选 label 与错误提示，其余属性透传给原生 input
import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes } from 'react'
import { CircleAlert } from 'lucide-react'

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, id, className, ...rest },
  ref,
) {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  return (
    <div>
      {label && (
        <label
          className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-200"
          htmlFor={fieldId}
        >
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={fieldId}
        className={`w-full rounded-xl border bg-warm px-4 py-2.5 text-sm text-gray-800 transition-colors placeholder:text-gray-400 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/5 dark:text-gray-100 ${
          error
            ? 'border-clay focus:border-clay focus:ring-clay/30'
            : 'border-gray-200 focus:border-brand focus:ring-brand/30 dark:border-white/10'
        }${className ? ` ${className}` : ''}`}
        {...rest}
      />
      {error && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-clay">
          <CircleAlert className="h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  )
})

export default TextField
