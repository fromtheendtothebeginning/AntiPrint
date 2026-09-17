// API 文档：正文是 Markdown（存在服务端 settings 里），管理员可以在本页直接编辑保存。
// 渲染走 marked + DOMPurify（文档由管理员编写，仍然消毒一遍再插进 DOM）。
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BookOpen, Check, Eye, LoaderCircle, Pencil, RotateCcw, Save, X } from 'lucide-react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { api, getErrorMessage } from '../api'
import { formatTime } from '../constants'
import type { ApiDocs } from '../types/api'

const CARD = 'rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft'
const ALERT_ERROR =
  'flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400'
const ALERT_INFO = 'flex items-start gap-2 rounded-xl bg-amber/15 px-4 py-3 text-sm text-amber-700 dark:text-amber'
const BTN_PRIMARY =
  'inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:-translate-y-0.5 hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0'
const BTN_GHOST =
  'inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 transition-colors hover:bg-warm dark:border-white/10 dark:bg-ink-soft dark:text-gray-300 dark:hover:bg-white/5'
const TEXTAREA =
  'w-full resize-y rounded-xl border border-gray-200 bg-white p-4 font-mono text-[13px] leading-relaxed text-gray-700 outline-none transition-colors focus:border-brand dark:border-white/10 dark:bg-ink dark:text-gray-200'

function ApiDocsPage({ isAdmin }: { isAdmin: boolean }) {
  const [docs, setDocs] = useState<ApiDocs | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  const load = async () => {
    try {
      const data = await api.getApiDocs()
      setDocs(data)
      setDraft(data.content)
      setError('')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  // 渲染 Markdown：opens new window? 不需要；表格（apidocs 里有参数表）要开 gfm
  const html = useMemo(() => {
    if (!docs) return ''
    const raw = marked.parse(docs.content, { gfm: true, breaks: false }) as string
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] })
  }, [docs])

  const save = async (content: string, reset = false) => {
    setSaving(true)
    setNotice('')
    try {
      const data = await api.saveApiDocs(content)
      setDocs(data)
      setDraft(data.content)
      setEditing(false)
      setNotice(reset ? '已恢复出厂文档' : '文档已保存，所有用户看到的就是这一版')
      window.setTimeout(() => setNotice(''), 4000)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className={`${CARD} flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400`}>
        <LoaderCircle className="h-5 w-5 animate-spin text-brand" />
        正在加载文档…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className={ALERT_ERROR} role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-xl bg-brand/10 px-4 py-3 text-sm text-brand dark:text-brand">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <div className={`${CARD} flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <BookOpen className="h-5 w-5" />
          </span>
          <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100">
              {docs?.custom ? '本站自定义文档' : '出厂默认文档'}
            </div>
            <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {docs?.custom && docs.updated_at
                ? `最后更新：${docs.updated_by || '管理员'} · ${formatTime(docs.updated_at)}`
                : '管理员还没有改过，这里显示的是随版本发布的默认文档'}
            </div>
          </div>
        </div>
        {isAdmin && !editing && (
          <div className="flex items-center gap-2">
            <button className={BTN_PRIMARY} onClick={() => { setDraft(docs?.content ?? ''); setEditing(true) }}>
              <Pencil className="h-4 w-4" />
              编辑文档
            </button>
            {docs?.custom && (
              <button
                className={BTN_GHOST}
                disabled={saving}
                onClick={() => void save('', true)}
                title="丢掉自定义内容，回到随版本发布的默认文档"
              >
                <RotateCcw className="h-4 w-4" />
                恢复默认
              </button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <div className={`${CARD} space-y-3`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100">编辑 Markdown</div>
            <div className="flex items-center gap-2">
              <button className={BTN_GHOST} onClick={() => setEditing(false)} disabled={saving}>
                <X className="h-4 w-4" />
                取消
              </button>
              <button className={BTN_PRIMARY} onClick={() => void save(draft)} disabled={saving}>
                {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
          <div className={ALERT_INFO}>
            <Eye className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              支持标准 Markdown（标题、表格、代码块、列表）。保存后所有登录用户立即看到这一版；
              点「恢复默认」可以回到随版本发布的文档。
            </span>
          </div>
          <textarea
            className={TEXTAREA}
            rows={22}
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="text-xs text-gray-500 dark:text-gray-400">
            当前 {draft.length} 字（上限 200000 字）
          </div>
        </div>
      ) : (
        <div className={`${CARD} md-body`} dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}

export default ApiDocsPage
