// 我的余额：色带 + 余额大字 / 账号类型与单价 / 最近流水（充值暂未开放，由管理员调账）
import * as React from 'react'
import api from '../../api'
import { Alert, Btn, Card, Empty, PageHeader } from '../../components'
import { createPage } from '../../page'
import { formatMoney, formatTime, onRefresh } from '../../util'
import type { BalanceInfo } from '@shared/types/api'

function BalancePage() {
  const [info, setInfo] = React.useState<BalanceInfo | null>(null)
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const data = await api.getBalance()
      setInfo(data)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '余额加载失败')
    } finally {
      setLoading(false)
      wx.stopPullDownRefresh()
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  React.useEffect(() => {
    onRefresh(load)
    return () => onRefresh(null)
  }, [load])

  const kind = info
    ? info.billable
      ? '按张计费'
      : `免费${info.free_reason ? `（${info.free_reason}）` : ''}`
    : ''

  return (
    <div>
      <PageHeader title="我的余额" subtitle="充值暂未开放 · 余额由管理员调整" pill="下拉可刷新" />

      <div className="wrap wrap-pull">
        {error ? <Alert kind="error">{error}</Alert> : null}

        <Card>
          {loading && !info ? (
            <Empty text="正在加载…" />
          ) : info ? (
            <div>
              <div className="muted">当前余额（元）</div>
              <div className="balance-amount">{formatMoney(info.balance)}</div>
              <div className="divider" />
              <div className="row">
                <div className="row-label">打印单价</div>
                <div className="row-value">{info.price}</div>
              </div>
              <div className="row">
                <div className="row-label">账号类型</div>
                <div className="row-value">{kind}</div>
              </div>
            </div>
          ) : null}
          <div className="mt">
            <Btn kind="secondary" size="sm" block onClick={load}>
              刷新余额
            </Btn>
          </div>
        </Card>

        <Card title="消费记录" extra={info && info.logs.length ? `最近 ${info.logs.length} 条` : ''}>
          {info && info.logs.length ? (
            info.logs.map((log, index) => {
              const delta = Number(log.delta)
              const last = index === info.logs.length - 1
              return (
                <div className={`log-item${last ? ' log-item-last' : ''}`} key={log.id}>
                  <div className="grow">
                    <div className="text ellipsis">{log.reason}</div>
                    <div className="muted">
                      {formatTime(log.created_at)}
                      {log.job_id ? ` · 任务 #${log.job_id}` : ''}
                      {log.actor ? ` · ${log.actor}` : ''}
                    </div>
                  </div>
                  <div className={`log-delta${delta < 0 ? ' log-delta-minus' : ''}`}>
                    {delta > 0 ? '+' : ''}
                    {formatMoney(delta)}
                  </div>
                </div>
              )
            })
          ) : (
            <Empty text="还没有余额变动记录" />
          )}
        </Card>

        <Card>
          <div className="tiny">提交任务时先扣费；驳回、撤回、删除未出纸的任务会自动退回并记录在上面的流水里。</div>
        </Card>
      </div>
    </div>
  )
}

export default function createApp() {
  return createPage(window, document, <BalancePage />)
}
