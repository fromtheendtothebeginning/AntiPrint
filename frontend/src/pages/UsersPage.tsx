// 用户管理（仅超级管理员 root 可用）：查看账号并把普通用户提拔为管理员 / 收回管理员
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, ShieldCheck, ShieldOff, UserCog, Users } from 'lucide-react'
import { api, getErrorMessage } from '../api'
import { ROLE_LABEL } from '../constants'
import type { AdminUserRow } from '../types/api'

const CARD = 'rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft'
const BTN_PRIMARY =
  'inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-xs font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:bg-brand-dark hover:shadow-xl hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60'
const BTN_SECONDARY =
  'inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2 text-xs font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/5 dark:text-gray-300'
const TH = 'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400'
const TD = 'px-4 py-4 text-sm text-gray-600 dark:text-gray-300'

/** 角色徽章：root=青绿实底、admin=青绿浅底、user=中性 */
function roleBadge(role: string): string {
  const base = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium'
  if (role === 'root') return `${base} bg-brand text-white shadow-sm shadow-brand/25`
  if (role === 'admin') return `${base} bg-brand/10 text-brand-dark dark:text-brand`
  return `${base} bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400`
}

function UsersPage() {
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [actingId, setActingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [me, setMe] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const list = await api.listUsers()
      setUsers(list)
      setError('')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void api
      .me()
      .then((profile) => setMe(profile.id))
      .catch(() => setMe(null))
  }, [load])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(timer)
  }, [notice])

  async function changeRole(row: AdminUserRow, role: 'user' | 'admin') {
    setActingId(row.id)
    setError('')
    try {
      await api.setUserRole(row.id, role)
      setNotice(`已把 ${row.username} 设为「${ROLE_LABEL[role] ?? role}」`)
      await load()
    } catch (err) {
      setError(getErrorMessage(err))
      await load()
    } finally {
      setActingId(null)
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="flex items-start gap-2 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay">{error}</p>
      )}
      {notice && (
        <p className="flex items-start gap-2 rounded-xl bg-brand/10 px-4 py-3 text-sm text-brand-dark dark:text-brand">
          {notice}
        </p>
      )}

      <div className={CARD}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-gray-400" />
            <div>
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">账号（{users.length}）</h2>
              <p className="text-xs text-gray-400">
                角色层级：普通用户 &lt; 管理员 &lt; 超级管理员；只有超级管理员能改角色
              </p>
            </div>
          </div>
          <button type="button" className={BTN_SECONDARY} onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            刷新
          </button>
        </div>

        {loading ? (
          <p className="py-10 text-center text-sm text-gray-400">正在加载账号…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr className="border-b border-gray-100 dark:border-white/10">
                  <th className={TH}>用户名</th>
                  <th className={TH}>角色</th>
                  <th className={TH}>账号来源</th>
                  <th className={TH}>anticraft 绑定</th>
                  <th className={TH}>任务数</th>
                  <th className={TH}>注册时间</th>
                  <th className={TH}>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((row) => {
                  const isSelf = row.id === me
                  const isRoot = row.role === 'root'
                  const busy = actingId === row.id
                  return (
                    <tr
                      key={row.id}
                      className="group border-b border-gray-50 transition-colors hover:bg-warm dark:border-white/5 dark:hover:bg-white/5"
                    >
                      <td className={`${TD} font-medium text-gray-800 dark:text-gray-100`}>
                        {row.username}
                        {isSelf && <span className="ml-2 text-xs text-gray-400">（我）</span>}
                      </td>
                      <td className={TD}>
                        <span className={roleBadge(row.role)}>
                          <UserCog className="h-3.5 w-3.5" />
                          {ROLE_LABEL[row.role] ?? row.role}
                        </span>
                      </td>
                      <td className={TD}>{row.source === 'anticraft' ? 'anticraft' : '本站注册'}</td>
                      <td className={TD}>
                        {row.anticraft_id ? (
                          <span className="text-gray-500 dark:text-gray-400">已绑定（ID {row.anticraft_id}）</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className={TD}>{row.job_count}</td>
                      <td className={`${TD} text-gray-400`}>{row.created_at?.replace('T', ' ') ?? '—'}</td>
                      <td className={TD}>
                        {isRoot ? (
                          <span className="text-xs text-gray-400">不可修改</span>
                        ) : isSelf ? (
                          <span className="text-xs text-gray-400">不能改自己</span>
                        ) : row.role === 'admin' ? (
                          <button
                            type="button"
                            className={BTN_SECONDARY}
                            disabled={busy}
                            onClick={() => void changeRole(row, 'user')}
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
                            收回管理员
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={BTN_PRIMARY}
                            disabled={busy}
                            onClick={() => void changeRole(row, 'admin')}
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                            设为管理员
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default UsersPage
