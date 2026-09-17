// 我的任务：任务卡片（状态徽章 + 进度步骤 + 文件 + 提示 + 操作），15 秒自动刷新 + 下拉刷新
import * as React from 'react'
import api from '../../api'
import { Alert, Badge, Btn, Card, Empty, PageHeader, Row, Steps } from '../../components'
import { createPage, go } from '../../page'
import { canWithdraw, confirm, deliveryText, formatTime, jobSteps, onRefresh, shortTime, toast, toastError } from '../../util'
import {
  STATUS_AWAIT_DELIVERY,
  STATUS_AWAIT_PICKUP,
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_REJECTED,
  STATUS_WITHDRAWN,
  describePrintOptions,
} from '@shared/constants'
import type { Job } from '@shared/types/api'

const REFRESH_INTERVAL = 15000

function MyJobsPage() {
  const [jobs, setJobs] = React.useState<Job[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')

  const load = React.useCallback(async () => {
    try {
      const list = await api.listMyJobs()
      setJobs(list)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '任务列表加载失败')
    } finally {
      setLoading(false)
      wx.stopPullDownRefresh()
    }
  }, [])

  React.useEffect(() => {
    load()
    const timer = setInterval(load, REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [load])

  // 下拉刷新（页面配置里开了 pullDownRefresh）
  React.useEffect(() => {
    onRefresh(load)
    return () => onRefresh(null)
  }, [load])

  /** 出纸前可以自己撤单（服务端还会再校验一次状态） */
  const withdraw = async (job: Job) => {
    const ok = await confirm(`撤回任务 #${job.id}`, '撤回后该任务标记为「已撤回」，需要重新提交才能打印。', '确认撤回')
    if (!ok) return
    try {
      await api.withdrawJob(job.id)
      toast(`任务 #${job.id} 已撤回`)
      load()
    } catch (err) {
      toastError(err)
    }
  }

  const preview = async (job: Job, fileId: number) => {
    const file = job.files.find((item) => item.id === fileId)
    if (!file) return
    wx.showLoading({ title: '正在打开…', mask: true })
    try {
      await api.openJobFile(job.id, file)
    } catch (err) {
      toastError(err)
    } finally {
      wx.hideLoading()
    }
  }

  const renderJob = (job: Job) => {
    const steps = jobSteps(job)
    return (
      <div className="job-card" key={job.id}>
        <div className="job-head">
          <div className="job-no">任务 #{job.id}</div>
          <Badge status={job.status} />
        </div>
        <div className="job-meta">
          {deliveryText(job)} · 提交 {shortTime(job.created_at)}
        </div>

        {steps.length ? <Steps items={steps} /> : null}

        <div className="divider" />

        {job.files.map((file) => (
          <div className="file-item" key={file.id}>
            <div className="grow" onClick={() => preview(job, file.id)}>
              <div className="file-name ellipsis">{file.filename}</div>
              <div className="muted">{describePrintOptions(file.print_options, job.copies)}</div>
            </div>
            <Btn kind="ghost" size="sm" onClick={() => preview(job, file.id)}>
              预览文件
            </Btn>
          </div>
        ))}

        {job.note ? (
          <div className="mt">
            <Row label="备注">{job.note}</Row>
          </div>
        ) : null}
        {job.printed_at ? (
          <div className="mt">
            <Row label="出纸时间">{formatTime(job.printed_at)}</Row>
          </div>
        ) : null}

        {job.reject_reason ? (
          <div className="mt">
            <Alert kind="error">驳回理由：{job.reject_reason}</Alert>
          </div>
        ) : null}
        {job.print_error ? (
          <div className="mt">
            <Alert kind="error">打印错误：{job.print_error}</Alert>
          </div>
        ) : null}
        {job.status === STATUS_AWAIT_DELIVERY ? (
          <div className="mt">
            <Alert kind="info">已打印完成，等待管理员配送</Alert>
          </div>
        ) : null}
        {job.status === STATUS_AWAIT_PICKUP ? (
          <div className="mt">
            <Alert kind="info">已打印完成，请到打印点自取</Alert>
          </div>
        ) : null}
        {job.status === STATUS_DONE && job.finished_at ? (
          <div className="mt">
            <Alert kind="ok">完成于 {formatTime(job.finished_at)}</Alert>
          </div>
        ) : null}
        {job.status === STATUS_FAILED ? (
          <div className="mt">
            <Alert kind="info">打印失败：已通知管理员重新入队</Alert>
          </div>
        ) : null}
        {job.status === STATUS_REJECTED ? (
          <div className="mt">
            <Alert kind="info">可修改文件后重新提交一份</Alert>
          </div>
        ) : null}
        {job.status === STATUS_WITHDRAWN ? (
          <div className="mt">
            <Alert kind="info">已撤回：需要重新提交才能打印</Alert>
          </div>
        ) : null}

        {canWithdraw(job) ? (
          <div className="job-actions">
            <Btn kind="secondary" size="sm" onClick={() => withdraw(job)}>
              撤回
            </Btn>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="我的任务" subtitle="下拉可刷新 · 15 秒自动更新" pill={jobs.length ? `共 ${jobs.length} 个任务` : '还没有任务'} />

      <div className="wrap wrap-pull">
        {error ? <Alert kind="error">{error}</Alert> : null}
        {loading && !jobs.length ? <Empty text="正在加载…" /> : null}
        {!loading && !jobs.length ? (
          <Card>
            <Empty text="还没有打印任务" />
            <div className="mt">
              <Btn block onClick={() => go('/submit')}>
                去提交打印
              </Btn>
            </div>
          </Card>
        ) : null}
        {jobs.map(renderJob)}
      </div>
    </div>
  )
}

export default function createApp() {
  return createPage(window, document, <MyJobsPage />)
}
