// 登录页：账号密码登录 / 注册（anticraft 跳转授权在小程序里走不通，这里只做本机账号）
import * as React from 'react'
import api, { SERVER } from '../../api'
import { Alert, Btn, Card, Field, PageHeader, Segmented } from '../../components'
import { createPage, go } from '../../page'
import { friendlyError } from '../../util'

type Mode = 'login' | 'register'

function LoginPage() {
  const [mode, setMode] = React.useState<Mode>('login')
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  // 已经登录（缓存里有令牌）就直接进提交页，别让用户再登一次
  React.useEffect(() => {
    if (api.token) go('/submit')
  }, [])

  const submit = async () => {
    if (!username.trim() || !password) {
      setError('请填写用户名和密码')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (mode === 'login') await api.login(username.trim(), password)
      else await api.register(username.trim(), password)
      go('/submit')
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="AntiPrint 远程打印"
        subtitle="提交文件 · 管理员审核 · 静默出纸"
        pill="登录后即可提交打印任务"
        logo
      />

      <div className="wrap wrap-pull">
        <Card>
          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'login', label: '登录' },
              { value: 'register', label: '注册' },
            ]}
          />

          <div className="mt">
            <Field label="用户名">
              <input
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
              />
            </Field>

            <Field label="密码" last>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
              />
            </Field>
          </div>

          {mode === 'register' ? (
            <div className="mt">
              <Alert kind="info">新账号余额为 0，需要管理员充值或加入免费名单后才能提交打印任务。</Alert>
            </div>
          ) : null}

          {error ? (
            <div className="mt">
              <Alert kind="error">{error}</Alert>
            </div>
          ) : null}

          <div className="mt">
            <Btn block disabled={busy} onClick={submit}>
              {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
            </Btn>
          </div>
        </Card>

        <Card title="服务器">
          <div className="text ellipsis">{SERVER}</div>
          <div className="field-hint">地址固定指向线上站点，无需（也不能）修改。</div>
        </Card>
      </div>
    </div>
  )
}

export default function createApp() {
  return createPage(window, document, <LoginPage />, { auth: false })
}
