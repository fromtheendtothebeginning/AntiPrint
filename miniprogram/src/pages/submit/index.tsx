// 提交页：选文件（聊天文件 / 相册图片）→ 打印设置 → 配送方式与地址 → 底部固定提交条
// 小程序一次只能上传一个文件，所以一次提交 = 一个文件（web 端可多选）
import * as React from 'react'
import api, { insufficientBalance, stageFile, dropStagedFile } from '../../api'
import type { InsufficientBalanceDetail } from '../../api'
import { Alert, Badge, Btn, Card, Field, PageHeader, Row, Segmented, Stepper } from '../../components'
import { createPage, go } from '../../page'
import { billingHint, formatMoney, formatSize, onShow, toast } from '../../util'
import { DELIVER, PICKUP, describePrintOptions } from '@shared/constants'
import type { DeliveryMode, Job, Profile } from '@shared/types/api'

const MAX_FILE_MB = 10

/** 图片缩略图的填充方式：mode 是小程序 <image> 的属性，React 的 DOM 类型里没有，透传过去 */
const IMG_MODE = { mode: 'aspectFill' } as unknown as React.ImgHTMLAttributes<HTMLImageElement>

interface PickedFile {
  path: string
  name: string
  size: number
}

function SubmitPage() {
  const [profile, setProfile] = React.useState<Profile | null>(null)
  const [file, setFile] = React.useState<PickedFile | null>(null)
  const [copies, setCopies] = React.useState(1)
  const [pages, setPages] = React.useState('')   // 页面范围，如 1-3,5（留空 = 全部）
  const [mode, setMode] = React.useState<DeliveryMode>(DELIVER)
  const [address, setAddress] = React.useState('')
  const [note, setNote] = React.useState('')
  const [error, setError] = React.useState('')
  const [paywall, setPaywall] = React.useState<InsufficientBalanceDetail | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<Job | null>(null)

  // 我的配置里的默认配送方式 / 默认地址带出来（用户没改过才覆盖）
  const touched = React.useRef(false)

  // tabBar 页切换不会重建页面：提交成功后离开再回来，要回到「填表单」的第一屏。
  // 只清「成功态」——正在填写的内容不动（免得选文件后被后台切换弄丢）。
  const resultRef = React.useRef<Job | null>(null)
  resultRef.current = result
  React.useEffect(() => {
    onShow(() => {
      if (resultRef.current) reset()
    })
    return () => onShow(null)
  }, [])

  React.useEffect(() => {
    api
      .getProfile()
      .then((data) => {
        setProfile(data)
        if (!touched.current) {
          setMode(data.default_delivery || DELIVER)
          setAddress(data.default_address || '')
        }
      })
      .catch((err) => setError(err.message || '读取我的配置失败'))
  }, [])

  const pick = (picked: PickedFile) => {
    if (picked.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`文件超过 ${MAX_FILE_MB}MB 限制`)
      return
    }
    setError('')
    setFile(picked)
  }

  /** 从聊天记录里选文件（PDF / Word / PPT / 图片） */
  const chooseFromChat = () => {
    wx.chooseMessageFile({
      count: 1,
      // type: 'all' = 从所有文件选择（图片/视频也能选到；视频服务端会拒绝并给出明确提示）
      // 注意：type: 'file' 的官方定义是「除了图片和视频之外的其它文件」，用它反而选不到图片
      type: 'all',
      extension: ['pdf', 'png', 'jpg', 'jpeg', 'docx', 'doc', 'pptx', 'ppt'],
      success: (res) => {
        const item = res.tempFiles[0]
        if (item) pick({ path: item.path, name: item.name, size: item.size })
      },
      fail: () => undefined,
    })
  }

  /** 拍照或从相册选图片（手机里的图片没有文件名，给一个可读的时间戳名字） */
  const chooseImage = () => {
    const done = (tempPath: string, size: number) => {
      const ext = (/\.(\w+)$/.exec(tempPath) || [])[1] || 'jpg'
      pick({ path: tempPath, name: `照片-${Date.now()}.${ext}`, size })
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        success: (res) => {
          const item = res.tempFiles[0]
          if (item) done(item.tempFilePath, item.size)
        },
        fail: () => undefined,
      })
      return
    }
    wx.chooseImage({
      count: 1,
      sourceType: ['album', 'camera'],
      success: (res) => {
        const path = res.tempFilePaths[0]
        if (path) done(path, 0)
      },
      fail: () => undefined,
    })
  }

  /** 提交前预览自己选的文件（本地临时路径，直接交给小程序文档/图片预览） */
  const previewLocal = async () => {
    if (!file) return
    wx.showLoading({ title: '正在打开…', mask: true })
    try {
      await api.openLocalFile(file.path, file.name)
    } catch (err) {
      toast(err instanceof Error ? err.message : '无法预览该文件')
    } finally {
      wx.hideLoading()
    }
  }

  const submit = async () => {
    if (!file) {
      setError('请先选择要打印的文件')
      return
    }
    const range = pages.trim()
    if (range && (!/^[0-9,\-]+$/.test(range) || range.length > 64)) {
      setError('页面范围只能填数字、逗号与短横线，例如 1-3,5')
      return
    }
    if (mode === DELIVER && !address.trim()) {
      setError('选择配送时请填写配送地址')
      return
    }
    setBusy(true)
    setError('')
    setPaywall(null)
    const staged = stageFile(file.path, file.name)
    try {
      const job = await api.submitJob({
        filePath: staged,
        address: address.trim(),
        mode,
        note: note.trim(),
        copies,
        pages,
      })
      setResult(job)
      toast('提交成功，等待管理员审核')
    } catch (err) {
      const detail = insufficientBalance(err)
      if (detail) setPaywall(detail)
      else setError(err instanceof Error ? err.message : '提交失败，请稍后重试')
    } finally {
      dropStagedFile(staged)
      setBusy(false)
    }
  }

  const isImage = !!file && /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)

  const reset = () => {
    setFile(null)
    setResult(null)
    setNote('')
    setCopies(1)
    setPages('')
  }

  // ── 提交成功 ──
  if (result) {
    return (
      <div>
        <PageHeader title="提交成功" subtitle="管理员审核通过后由打印代理静默出纸" pill={`任务 #${result.id}`} />
        <div className="wrap wrap-pull">
          <Card title="任务信息" extra={<Badge status={result.status} />}>
            <Row label="文件">
              <span className="ellipsis">{result.files.map((item) => item.filename).join('、')}</span>
            </Row>
            <Row label="打印设置">{describePrintOptions(result.print_options, result.copies) || 'A4 · 全部页面'}</Row>
            <Row label="配送方式">{result.delivery_mode === DELIVER ? '配送上门' : '到打印点自取'}</Row>
            {result.address ? <Row label="配送地址">{result.address}</Row> : null}
            <Row label="本次扣费" strong>
              {formatMoney(result.charge)} 元
            </Row>
          </Card>

          <Alert kind="info">审核通过后会自动出纸；进度可以在「我的任务」里随时查看（那里也能预览文件）。</Alert>

          <div className="mt">
            <Btn block onClick={() => go('/jobs')}>
              查看我的任务
            </Btn>
            <Btn block kind="secondary" onClick={reset}>
              再提交一份
            </Btn>
          </div>
        </div>
      </div>
    )
  }

  // ── 填写表单 ──
  return (
    <div>
      <PageHeader title="提交打印" subtitle="选文件 → 设置 → 配送方式" pill={billingHint(profile)} />

      <div className="wrap wrap-pull wrap-with-bar">
        <Card title="打印文件" extra={file ? '可重新选择' : 'PDF / 图片 / Word / PPT'}>
          {file ? (
            <div>
              <div className="file-item">
                {isImage ? <img className="thumb" src={file.path} {...IMG_MODE} /> : null}
                <div className="grow">
                  <div className="file-name ellipsis">{file.name}</div>
                  <div className="muted">
                    {formatSize(file.size)} · {isImage ? '图片直接打印' : 'Word/PPT 由服务端转成 PDF'}
                  </div>
                </div>
              </div>
              {/* 预览/移除做成整行按钮，别让人找不到 */}
              <div className="btn-row mt">
                <Btn kind="primary" size="sm" onClick={previewLocal}>
                  预览文件
                </Btn>
                <Btn kind="secondary" size="sm" onClick={() => setFile(null)}>
                  移除
                </Btn>
              </div>
            </div>
          ) : (
            <div className="empty">还没有选择文件（不超过 {MAX_FILE_MB}MB）</div>
          )}
          <div className="mt">
            <Btn kind="secondary" block onClick={chooseFromChat}>
              选择文件（聊天记录里选）
            </Btn>
            <Btn kind="secondary" block onClick={chooseImage}>
              拍照或从相册选图片
            </Btn>
          </div>
          <div className="field-hint">
            手机里的文件：先在微信里发给「文件传输助手」，再点上面第一个按钮从聊天记录里选
            （微信没有开放「浏览手机文件系统」的接口）。
          </div>
        </Card>

        <Card title="打印设置" extra="纸张固定 A4">
          <Field label="份数" hint="与页面范围一起决定计费张数">
            <Stepper value={copies} min={1} max={99} onChange={setCopies} />
          </Field>
          <Field label="页面范围" hint="留空打印全部页面；支持 1-3,5 这种写法" last>
            <input
              className="input"
              value={pages}
              onChange={(e) => setPages(e.target.value)}
              placeholder="如 1-3,5（留空 = 全部）"
            />
          </Field>
        </Card>

        <Card title="配送与备注">
          <Field label="配送方式">
            <Segmented<DeliveryMode>
              value={mode}
              onChange={(value) => {
                touched.current = true
                setMode(value)
              }}
              options={[
                { value: DELIVER, label: '配送上门' },
                { value: PICKUP, label: '到打印点自取' },
              ]}
            />
          </Field>
          <Field label={mode === DELIVER ? '配送地址（必填）' : '取件地点（可留空）'}>
            <input
              className="input"
              value={address}
              onChange={(e) => {
                touched.current = true
                setAddress(e.target.value)
              }}
              placeholder={mode === DELIVER ? '如：24 号楼 1016' : '如：打印点位置（可留空）'}
            />
          </Field>
          <Field label="备注（可留空）" last>
            <textarea
              className="textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="如：单面打印、急件等"
            />
          </Field>
        </Card>

        {paywall ? (
          <Alert kind="error">
            余额不足：应付 {paywall.cost} 元，当前余额 {paywall.balance} 元（付款码暂未开放，请联系管理员充值）
          </Alert>
        ) : null}
        {error ? <Alert kind="error">{error}</Alert> : null}
      </div>

      <div className="bottom-bar">
        <Btn block disabled={busy} onClick={submit}>
          {busy ? '正在提交…' : file ? `提交打印任务 · ${copies} 份 A4${pages.trim() ? ` · 第 ${pages.trim()} 页` : ''}` : '提交打印任务'}
        </Btn>
      </div>
    </div>
  )
}

export default function createApp() {
  return createPage(window, document, <SubmitPage />)
}
