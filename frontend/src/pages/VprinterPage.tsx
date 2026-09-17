// 虚拟打印机：安装包下载 + 使用方法说明（用户端）
// 只有 Windows x86-64 的 zip 安装包开放下载（后端 downloads.py 的清单说了算，这里不硬编码）
import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Download, Info, LoaderCircle, Printer } from 'lucide-react'
import { api, getErrorMessage } from '../api'
import { AppleIcon, LinuxIcon, WindowsIcon } from '../components/OsIcons'
import type { DownloadPackage } from '../types/api'

const CARD = 'rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft'
const ALERT_ERROR =
  'flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400'
const BTN_PRIMARY =
  'inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:-translate-y-0.5 hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0'

/** 每个平台：品牌图标 + 品牌色小方块（深色模式各自换一种可读的色） */
const PLATFORM_STYLE: Record<string, { Icon: typeof WindowsIcon; tile: string; glyph: string }> = {
  'windows-x64': { Icon: WindowsIcon, tile: 'bg-[#0078D4]/10 dark:bg-[#0078D4]/20', glyph: 'text-[#0078D4]' },
  macos: { Icon: AppleIcon, tile: 'bg-gray-900/10 dark:bg-white/10', glyph: 'text-gray-900 dark:text-gray-100' },
  linux: { Icon: LinuxIcon, tile: 'bg-[#FCC624]/25 dark:bg-[#FCC624]/15', glyph: 'text-[#a9781a] dark:text-[#FCC624]' },
}

const STEPS: { title: string; body: string }[] = [
  {
    title: '1. 下载并解压',
    body: '下载下面的 zip，解压到任意文件夹（例如 D:\\AntiPrintVPrinter）。绿色版：不用安装，文件也不往系统里塞东西，数据和配置都放在这个文件夹里，拷走文件夹就等于拷走配置。',
  },
  {
    title: '2. 双击 exe 启动',
    body: '双击 AntiPrintVPrinter.exe：右下角出现托盘图标，配置界面会自己弹出来。首次使用请在「网站账号」页填服务器地址（默认已填本站）、你的账号密码，点「测试连接」确认能登录，再点「保存并应用」。',
  },
  {
    title: '3. 装一台「虚拟打印机」',
    body: '在「运行状态」页点「一键安装打印机队列」（会弹一次 UAC 要管理员权限）。装好后，任何软件的打印对话框里都会多出一台叫 AntiPrint-1.0.0 的打印机。',
  },
  {
    title: '4. 打印 = 提交任务',
    body: '在 Word / WPS / 浏览器里按 Ctrl+P，打印机选「AntiPrint-1.0.0」，点打印。程序会自动把内容转成 PDF 并提交到本站（等价于在网页上传文件），托盘悬停文字会显示「已提交任务 #…」。之后管理员审核通过，就会由接打印机的那台机器出纸，按你的默认配送方式配送或等你自取。',
  },
]

function VprinterPage() {
  const [packages, setPackages] = useState<DownloadPackage[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState(0)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        setPackages(await api.getDownloads())
      } catch (err) {
        setError(getErrorMessage(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const download = async (pkg: DownloadPackage) => {
    setBusy(pkg.id)
    setProgress(0)
    setNotice('')
    try {
      const { blob, filename } = await api.downloadPackage(pkg.id, setProgress)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setNotice(`已开始保存 ${filename}（${pkg.size_text}）。解压后双击 exe 即用。`)
      window.setTimeout(() => setNotice(''), 6000)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy('')
      setProgress(0)
    }
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
        <div className="flex items-start gap-2 rounded-xl bg-brand/10 px-4 py-3 text-sm text-brand">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <div className={`${CARD} flex items-start gap-3`}>
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <Printer className="h-6 w-6" />
        </span>
        <div className="space-y-1">
          <div className="text-sm font-medium text-gray-800 dark:text-gray-100">不用上传，直接「打印」</div>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
            装上这个客户端后，你的电脑上会多出一台叫 <span className="font-medium">AntiPrint-1.0.0</span> 的虚拟打印机。
            在任意软件里 <kbd className="rounded border border-gray-300 px-1 text-xs dark:border-white/20">Ctrl</kbd> +{' '}
            <kbd className="rounded border border-gray-300 px-1 text-xs dark:border-white/20">P</kbd> 选它，内容就会自动转成 PDF
            提交到本站 —— 和在这里网页上传文件是一回事，照样走「管理员审核 → 出纸 → 配送/自取」，也照常按张计费。
          </p>
        </div>
      </div>

      <div className={CARD}>
        <div className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-100">下载安装包</div>
        {loading ? (
          <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
            <LoaderCircle className="h-5 w-5 animate-spin text-brand" />
            正在读取安装包信息…
          </div>
        ) : (
          <div className="space-y-3">
            {packages.map((pkg) => {
              const style = PLATFORM_STYLE[pkg.id] ?? PLATFORM_STYLE['windows-x64']
              const Icon = style.Icon
              const downloadable = pkg.open && pkg.ready
              return (
                <div
                  key={pkg.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-100 p-4 dark:border-white/10"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${style.tile} ${style.glyph}`}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
                        {pkg.label}
                        {pkg.version && (
                          <span className="rounded-md bg-brand/10 px-1.5 py-0.5 text-xs text-brand">v{pkg.version}</span>
                        )}
                        {!pkg.open && (
                          <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-white/10 dark:text-gray-400">
                            暂未开放
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {pkg.requirements}
                        {pkg.size_text ? ` · ${pkg.size_text}` : ''}
                        {pkg.arch ? ` · ${pkg.arch}` : ''}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{pkg.note}</div>
                      {downloadable && pkg.sha256 && (
                        <div className="mt-1 break-all font-mono text-[11px] text-gray-400 dark:text-gray-500">
                          SHA-256 {pkg.sha256.slice(0, 16)}…{pkg.sha256.slice(-8)}
                        </div>
                      )}
                    </div>
                  </div>
                  {downloadable ? (
                    <button className={BTN_PRIMARY} disabled={busy === pkg.id} onClick={() => void download(pkg)}>
                      {busy === pkg.id ? (
                        <>
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                          下载中 {progress}%
                        </>
                      ) : (
                        <>
                          <Download className="h-4 w-4" />
                          下载 zip
                        </>
                      )}
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {pkg.open ? '服务器上还没放安装包' : '这个平台的安装包还在准备中'}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div className="mt-4 flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            下载需要登录（安装包只发给本站用户）。装好后用它打印同样需要你的账号密码，提交的任务记在你名下、照常计费。
          </span>
        </div>
      </div>

      <div className={CARD}>
        <div className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-100">怎么用（四步）</div>
        <div className="space-y-4">
          {STEPS.map((step) => (
            <div key={step.title} className="flex gap-3">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand" />
              <div>
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{step.title}</div>
                <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={CARD}>
        <div className="mb-3 text-sm font-medium text-gray-800 dark:text-gray-100">常见问题</div>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium text-gray-700 dark:text-gray-200">打印了但网站上看不到任务？</dt>
            <dd className="mt-0.5 text-gray-600 dark:text-gray-300">
              打开配置界面「运行状态」页看队列与后台服务状态：提示「队列还没安装」就点「一键安装打印机队列」；
              「守护进程：未运行」就在托盘图标右键点「重启后台服务」。黄色提示条里的话照着做基本都能解决。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-700 dark:text-gray-200">右下角找不到图标？</dt>
            <dd className="mt-0.5 text-gray-600 dark:text-gray-300">
              Windows 11 会把它收进「显示隐藏的图标」里，拖出来固定即可；也可以直接双击 exe 打开配置界面
              （手动打开时界面会自己弹出来）。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-700 dark:text-gray-200">怎么彻底退出/开机自动启动？</dt>
            <dd className="mt-0.5 text-gray-600 dark:text-gray-300">
              托盘图标右键「退出」会连配置界面一起关掉；点配置界面窗口的 × 会问你是「只关界面」还是「退出程序」。
              想开机自动跑：配置界面底部勾「开机自动启动」（勾上即生效）。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-700 dark:text-gray-200 mb-1">想自己写脚本提交？</dt>
            <dd className="text-gray-600 dark:text-gray-300">
              直接调打印 API 即可，参数与 Python 示例见「API 文档」页。
            </dd>
          </div>
        </dl>
      </div>
    </div>
  )
}

export default VprinterPage
