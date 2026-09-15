// 文件预览弹窗（共用）：PDF 用 iframe、图片用 img、其它类型提示下载
// 两种用法：
//   1) 远程文件：给 jobId + fileId，组件自己带 Bearer 取 blob（管理端队列 / 用户「我的任务」）
//      Office（Word/PPT）服务端下发的就是转换后的 PDF，这里按 PDF 渲染即可
//   2) 本地文件：给 localUrl（提交前预览所选文件，由调用方 createObjectURL 并负责回收）
import { useEffect, useRef, useState } from 'react'
import { Download, LoaderCircle, TriangleAlert } from 'lucide-react'
import { api, getErrorMessage } from '../api'
import { previewKind } from '../constants'
import Modal from './Modal'

interface FilePreviewProps {
  open: boolean
  filename: string
  /** 远程文件：与 fileId 一起给出，组件内部取 blob（接口需要 Bearer） */
  jobId?: number
  fileId?: number
  /** 本地文件：提交前预览用，与 jobId 二选一（调用方负责 createObjectURL/revoke） */
  localUrl?: string
  onClose: () => void
}

/** 预览方式：PDF / 图片 / 其它（Word/PPT 由服务端转成 PDF，走 PDF 分支） */
function fileKind(filename: string): 'pdf' | 'image' | 'other' {
  return previewKind(filename)
}

function FilePreview({ open, filename, jobId, fileId, localUrl, onClose }: FilePreviewProps) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const urlRef = useRef<string | null>(null)
  // 请求序号：快速切换文件时丢弃过期响应，避免串图与临时地址泄漏
  const seqRef = useRef(0)

  function releaseUrl() {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }

  useEffect(() => {
    if (!open) return
    // 本地文件直接用它自己的地址；远程文件按需取 blob
    if (localUrl) {
      releaseUrl()
      setUrl(localUrl)
      setError('')
      setLoading(false)
      return
    }
    if (!jobId || !fileId) return
    const seq = seqRef.current + 1
    seqRef.current = seq
    releaseUrl()
    setUrl('')
    setError('')
    setLoading(true)
    api
      .fetchFileBlob(jobId, fileId)
      .then((blob) => {
        if (seqRef.current !== seq) return
        const objectUrl = URL.createObjectURL(blob)
        urlRef.current = objectUrl
        setUrl(objectUrl)
        setLoading(false)
      })
      .catch((err) => {
        if (seqRef.current !== seq) return
        setError(getErrorMessage(err))
        setLoading(false)
      })
    return () => {
      // 关闭 / 切换文件 / 卸载时释放临时地址
      seqRef.current += 1
      releaseUrl()
    }
  }, [open, jobId, fileId, localUrl])

  const kind = fileKind(filename)

  return (
    <Modal open={open} title={`预览：${filename}`} size="lg" onClose={onClose}>
      {loading && (
        <p className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          正在加载文件…
        </p>
      )}

      {!loading && error && (
        <p className="flex items-start gap-2 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      {!loading && !error && url && kind === 'pdf' && (
        <iframe className="h-[60vh] w-full rounded-xl lg:h-[80vh] border border-gray-100 dark:border-white/10" src={url} title={filename} />
      )}

      {!loading && !error && url && kind === 'image' && (
        <img className="mx-auto max-h-[60vh] rounded-xl lg:max-h-[80vh]" src={url} alt={filename} />
      )}

      {!loading && !error && url && kind === 'other' && (
        <p className="rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-600 dark:bg-white/5 dark:text-gray-300">
          该文件类型不支持在线预览，请点击「下载文件」查看。
        </p>
      )}

      {!loading && !error && url && (
        <div className="mt-4 flex justify-end">
          <a
            className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2 text-sm font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl dark:bg-white/5 dark:text-gray-300"
            href={url}
            download={filename}
          >
            <Download className="h-4 w-4" />
            下载文件
          </a>
        </div>
      )}
    </Modal>
  )
}

export default FilePreview
