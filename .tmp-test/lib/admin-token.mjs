// 测试用：管理员登录令牌缓存（10 分钟内复用）
//
// 为什么需要：登录接口有 IP 限速（10 次/分钟，见 AGENTS.md），
// 每个 UI 用例都要给测试账号充值、都要登一次管理员，连跑几个用例就会 429。
// JWT 本身 24 小时有效，这里把它缓存到 .tmp-test/.admin-token.json 复用。
import fs from 'node:fs'
import path from 'node:path'

const CACHE = path.join(import.meta.dirname, '..', '.admin-token.json')
const TTL_MS = 10 * 60 * 1000

export async function adminTokenCached(api) {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
    if (cached.token && Date.now() - cached.ts < TTL_MS) {
      // 抽查一次是否还能用（限速 10/分钟，抽查用 GET 不算登录）
      const probe = await fetch(`${api}/api/settings`, { headers: { Authorization: 'Bearer ' + cached.token } })
      if (probe.ok) return cached.token
    }
  } catch {
    // 缓存不存在或已失效，往下走重新登录
  }
  const res = await fetch(`${api}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })
  const data = await res.json()
  if (!data.token) throw new Error('管理员登录失败：' + JSON.stringify(data).slice(0, 120))
  fs.writeFileSync(CACHE, JSON.stringify({ token: data.token, ts: Date.now() }))
  return data.token
}
