// 我的配置：账号信息 / 默认配送方式与地址（提交页会自动带出来）/ 服务器 / 退出登录
import * as React from 'react'
import api from '../../api'
import { Alert, Btn, Card, Field, PageHeader, Row, Segmented } from '../../components'
import { applyUiScale, createPage, goLogin } from '../../page'
import { confirm, formatMoney, getUiScale, setUiScale, toast } from '../../util'
import type { UiScale } from '../../util'
import { DELIVER, PICKUP, ROLE_LABEL } from '@shared/constants'
import type { DeliveryMode, Profile } from '@shared/types/api'

function ProfilePage() {
  const [profile, setProfile] = React.useState<Profile | null>(null)
  const [mode, setMode] = React.useState<DeliveryMode>(DELIVER)
  const [address, setAddress] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [dirty, setDirty] = React.useState(false)
  const [scale, setScale] = React.useState<UiScale>(getUiScale())

  React.useEffect(() => {
    api
      .getProfile()
      .then((data) => {
        setProfile(data)
        setMode(data.default_delivery || DELIVER)
        setAddress(data.default_address || '')
      })
      .catch((err) => setError(err instanceof Error ? err.message : '读取配置失败'))
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    if (mode === DELIVER && !address.trim()) {
      setError('默认方式为配送时，默认地址不能为空')
      return
    }
    setBusy(true)
    setError('')
    try {
      const data = await api.saveProfile({ default_address: address.trim(), default_delivery: mode })
      setProfile(data)
      setDirty(false)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    const ok = await confirm('退出登录', '退出后需要重新输入账号密码。', '退出')
    if (!ok) return
    api.logout()
    goLogin()
  }

  return (
    <div>
      <PageHeader
        title="我的配置"
        subtitle="默认配送方式与地址会带进提交页"
        pill={profile ? `${ROLE_LABEL[profile.role] || profile.role} · 余额 ${formatMoney(profile.balance)} 元` : ''}
      />

      <div className="wrap wrap-pull">
        {error ? <Alert kind="error">{error}</Alert> : null}

        <Card title="账号">
          {loading && !profile ? (
            <div className="muted">正在加载…</div>
          ) : profile ? (
            <div>
              <Row label="用户名">{profile.username}</Row>
              <Row label="角色">{ROLE_LABEL[profile.role] || profile.role}</Row>
              <Row label="账号来源">{profile.source === 'anticraft' ? 'anticraft 账号' : '本站账号'}</Row>
              <Row label="账号类型">{profile.billable ? `按张计费 · ${profile.price}` : `免费${profile.free_reason ? `（${profile.free_reason}）` : ''}`}</Row>
              {profile.anticraft_bound ? <Row label="anticraft 绑定">已绑定（ID {profile.anticraft_id ?? '—'}）</Row> : null}
            </div>
          ) : null}
        </Card>

        <Card title="默认配送">
          <Field label="配送方式">
            <Segmented<DeliveryMode>
              value={mode}
              onChange={(value) => {
                setMode(value)
                setDirty(true)
              }}
              options={[
                { value: DELIVER, label: '配送上门' },
                { value: PICKUP, label: '到打印点自取' },
              ]}
            />
          </Field>
          <Field label="默认地址" hint="选择「配送上门」时提交页会预填这个地址" last>
            <input
              className="input"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value)
                setDirty(true)
              }}
              placeholder="如：24 号楼 1016"
            />
          </Field>
          <div className="mt">
            <Btn block disabled={busy || !dirty} onClick={save}>
              {busy ? '正在保存…' : dirty ? '保存配置' : '已是最新'}
            </Btn>
          </div>
        </Card>

        <Card title="界面字号" extra="只影响显示，不影响打印">
          <Segmented<UiScale>
            value={scale}
            onChange={(value) => {
              setScale(value)
              setUiScale(value)
              applyUiScale()
            }}
            options={[
              { value: 'std', label: '标准' },
              { value: 'lg', label: '大' },
              { value: 'xl', label: '特大' },
            ]}
          />
          <div className="field-hint">看不清时调大一号；设置会记在本机，各页面都生效。</div>
        </Card>

        <Card title="服务器">
          <div className="text ellipsis">{api.server}</div>
          <div className="field-hint">换服务器地址请到登录页的「服务器地址」卡片修改。</div>
        </Card>

        <Card>
          <Btn kind="danger" block onClick={logout}>
            退出登录
          </Btn>
        </Card>
      </div>
    </div>
  )
}

export default function createApp() {
  return createPage(window, document, <ProfilePage />)
}
