// 用户管理（admin 与 root 可见）：账号操作中心——加/收管理员（仅 root）、免费账户开关、调整余额、删除账号（余额为 0，仅 root）
import { useCallback, useEffect, useState } from 'react'
import {
  BadgeCheck,
  Coins,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserCog,
  Users,
} from 'lucide-react'
import { api, getErrorMessage } from '../api'
import Modal from '../components/Modal'
import { ROLE_LABEL } from '../constants'
import type { AdminUserRow } from '../types/api'

const CARD = 'rounded-2xl bg-white p-6 shadow-xl shadow-black/[0.04] dark:bg-ink-soft'
const BTN_PRIMARY =
  'inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-xs font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:bg-brand-dark hover:shadow-xl hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60'
const BTN_SECONDARY =
  'inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2 text-xs font-medium text-gray-600 shadow-lg shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/5 dark:text-gray-300'
const TH = 'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400'
const TD = 'px-4 py-4 text-sm text-gray-600 dark:text-gray-300'
const BTN_DANGER =
  'inline-flex items-center gap-1.5 rounded-xl bg-clay px-4 py-2 text-xs font-medium text-white shadow-lg shadow-clay/25 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60'
const LABEL = 'mt-3 mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400'
const INPUT =
  'w-full rounded-xl border border-gray-200 bg-warm px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 dark:border-white/10 dark:bg-white/5 dark:text-gray-100'

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
  /** 我的角色：加/收管理员与删除只对 root 开放，界面上要区分 */
  const [myRole, setMyRole] = useState('user')
  /** 免费白名单（settings.free_users）：在这页按账号开关 */
  const [whitelist, setWhitelist] = useState<string[]>([])
  /** 批量添加白名单的输入（一行一个 / 逗号分隔）+ 忙碌态 */
  const [batchText, setBatchText] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  /** 删除账号确认弹窗 */
  const [deleteTarget, setDeleteTarget] = useState<AdminUserRow | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  /** 调账弹窗：目标账号与金额（正数加钱、负数扣钱） */
  const [balanceTarget, setBalanceTarget] = useState<AdminUserRow | null>(null)
  const [balanceDelta, setBalanceDelta] = useState('')
  const [balanceNote, setBalanceNote] = useState('')
  const [balanceBusy, setBalanceBusy] = useState(false)
  const [balanceError, setBalanceError] = useState('')

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

  /** 白名单与我的角色：决定每行显示「设为免费 / 取消免费」以及能否加管理员 / 删除 */
  const loadContext = useCallback(async () => {
    try {
      const data = await api.getSettings()
      setWhitelist(
        (data.settings.free_users || '')
          .split(/[,，;；\s]+/)
          .map((name) => name.trim())
          .filter(Boolean),
      )
    } catch {
      // 读不到就当成空名单，不影响页面其它部分
    }
    try {
      const profile = await api.me()
      setMyRole(profile.role)
      setMe(profile.id)
    } catch {
      setMe(null)
    }
  }, [])

  /** 该账号是不是免费（管理员/root、anticraft、白名单三者之一） */
  function freeReasonOf(row: AdminUserRow): string {
    if (row.role === 'root') return '超级管理员免打印费'
    if (row.role === 'admin') return '管理员免打印费'
    if (row.source === 'anticraft') return 'anticraft 账号免打印费'
    if (whitelist.includes(row.username)) return '在免费白名单里'
    return ''
  }

  /** 名单里还没注册的名字：预登记用的——他们用这个名字注册/登录后自动就是免费账号 */
  const usersByName = new Map(users.map((row) => [row.username, row]))
  const pendingNames = whitelist.filter((name) => !usersByName.has(name))

  /** 批量把名字加进白名单（一行一个 / 逗号分隔；长度不合规的忽略并提示） */
  async function addWhitelistBatch() {
    const raw = batchText
      .split(/[\n,，;；]+/)
      .map((name) => name.trim())
      .filter(Boolean)
    if (raw.length === 0) return
    const invalid = raw.filter((name) => name.length < 3 || name.length > 32)
    const valid = Array.from(new Set(raw.filter((name) => name.length >= 3 && name.length <= 32)))
    const added = valid.filter((name) => !whitelist.includes(name))
    const dup = valid.length - added.length
    if (added.length === 0) {
      setError(`没有新增：${dup ? `${dup} 个已在名单里` : ''}${invalid.length ? `${dup ? '，' : ''}${invalid.length} 个名字长度不合规（需 3~32 字符）` : ''}`)
      return
    }
    setBatchBusy(true)
    setError('')
    try {
      const saved = await api.saveSettings({ free_users: [...whitelist, ...added].join(',') })
      setWhitelist(
        (saved.free_users || '')
          .split(/[,，;；\s]+/)
          .map((name) => name.trim())
          .filter(Boolean),
      )
      setBatchText('')
      setNotice(
        `已加入 ${added.length} 个账号到免费白名单` +
          (dup ? `（${dup} 个已在名单里）` : '') +
          (invalid.length ? `；${invalid.length} 个名字长度不合规已忽略：${invalid.slice(0, 3).join('、')}${invalid.length > 3 ? '…' : ''}` : '') +
          '。还没注册的名字会在注册/登录后自动成为免费账号。',
      )
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBatchBusy(false)
    }
  }

  /** 按用户名把某个名字移出白名单（预登记名单里点 ✕ 用） */
  async function removeWhitelistName(name: string) {
    setActingId(-1)
    setError('')
    try {
      const saved = await api.saveSettings({ free_users: whitelist.filter((item) => item !== name).join(',') })
      setWhitelist(
        (saved.free_users || '')
          .split(/[,，;；\s]+/)
          .map((item) => item.trim())
          .filter(Boolean),
      )
      setNotice(`已把 ${name} 移出免费白名单`)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setActingId(null)
    }
  }

  /** 加入 / 移出免费白名单（写入 settings.free_users，即时生效） */
  async function toggleFree(row: AdminUserRow) {
    const inList = whitelist.includes(row.username)
    const names = inList ? whitelist.filter((name) => name !== row.username) : [...whitelist, row.username]
    setActingId(row.id)
    setError('')
    try {
      const saved = await api.saveSettings({ free_users: names.join(',') })
      setWhitelist(
        (saved.free_users || '')
          .split(/[,，;；\s]+/)
          .map((name) => name.trim())
          .filter(Boolean),
      )
      setNotice(inList ? `已把 ${row.username} 移出免费白名单（提交任务开始扣余额）` : `已把 ${row.username} 加入免费白名单（提交任务不扣余额）`)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setActingId(null)
    }
  }

  /** 删除账号（护栏：余额为 0、不能删自己/root；服务端也会再校验一次） */
  async function submitDelete() {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError('')
    try {
      await api.deleteUser(deleteTarget.id)
      setNotice(`已删除账号 ${deleteTarget.username}（任务与流水保留）`)
      setDeleteTarget(null)
      await load()
    } catch (err) {
      setDeleteError(getErrorMessage(err))
    } finally {
      setDeleteBusy(false)
    }
  }

  useEffect(() => {
    void load()
    void loadContext()
  }, [load, loadContext])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(timer)
  }, [notice])

  /** root 给账号加减余额（充值暂未实现，先手工记账） */
  async function submitBalance() {
    if (!balanceTarget) return
    const amount = Number(balanceDelta)
    if (!balanceDelta.trim() || Number.isNaN(amount) || amount === 0) {
      setBalanceError('请输入不为 0 的金额（正数加钱，负数扣钱）')
      return
    }
    setBalanceBusy(true)
    setBalanceError('')
    try {
      const balance = await api.adjustBalance(balanceTarget.id, balanceDelta.trim(), balanceNote.trim() || undefined)
      setNotice(`已调整 ${balanceTarget.username} 的余额，当前 ${Number(balance).toFixed(2)} 元`)
      setBalanceTarget(null)
      setBalanceDelta('')
      setBalanceNote('')
      await load()
    } catch (err) {
      setBalanceError(getErrorMessage(err))
    } finally {
      setBalanceBusy(false)
    }
  }

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

      {/* 批量加免费账号：可以先登记还没注册的名字，他们注册/登录后自动免费 */}
      <div className={CARD}>
        <div className="flex items-center gap-2">
          <BadgeCheck className="h-5 w-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">批量添加免费账号</h2>
            <p className="text-xs text-gray-400">
              一行一个（或用逗号分隔），可以直接写<strong>还没注册的用户名</strong>——他们用这个名字注册/登录后自动就是免费账号
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-start">
          <textarea
            id="batch-free-users"
            className={`${INPUT} min-h-[96px] font-mono text-xs`}
            placeholder={'例如：\nalice\nbob\n2026新生A'}
            value={batchText}
            onChange={(event) => setBatchText(event.target.value)}
          />
          <button
            type="button"
            className={`${BTN_PRIMARY} lg:mt-1`}
            disabled={batchBusy || !batchText.trim()}
            onClick={() => void addWhitelistBatch()}
          >
            {batchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            批量加入白名单
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          名字长度需 3~32 字符；已在名单或与已有账号重复的会自动跳过。加进名单后，账号列表里对应行的「免费」徽章会亮起。
        </p>

        {/* 预登记的名单：还没注册的名字单独列出来，方便核对与移除 */}
        {pendingNames.length > 0 && (
          <div className="mt-4 rounded-2xl bg-warm px-4 py-3 dark:bg-white/5">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
              名单里还没注册的名字（{pendingNames.length}）——注册后自动免费
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {pendingNames.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-xs font-medium text-gray-600 shadow-sm shadow-black/5 dark:bg-ink-soft dark:text-gray-300"
                >
                  {name}
                  <button
                    type="button"
                    className="text-gray-400 transition-colors hover:text-clay"
                    aria-label={`从白名单移除 ${name}`}
                    disabled={actingId !== null || batchBusy}
                    onClick={() => void removeWhitelistName(name)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

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
            <table className="w-full min-w-[1040px]">
              <thead>
                <tr className="border-b border-gray-100 dark:border-white/10">
                  <th className={TH}>用户名</th>
                  <th className={TH}>角色</th>
                  <th className={TH}>账号来源</th>
                  <th className={TH}>anticraft 绑定</th>
                  <th className={TH}>余额</th>
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
                  const freeReason = freeReasonOf(row)
                  const inWhitelist = whitelist.includes(row.username)
                  const hasBalance = Number(row.balance ?? 0) !== 0
                  const canManageRole = myRole === 'root'
                  return (
                    <tr
                      key={row.id}
                      className="group border-b border-gray-50 transition-colors hover:bg-warm dark:border-white/5 dark:hover:bg-white/5"
                    >
                      <td className={`${TD} font-medium text-gray-800 dark:text-gray-100`}>
                        <span className="whitespace-nowrap">{row.username}</span>
                        {isSelf && <span className="ml-2 text-xs text-gray-400">（我）</span>}
                        {freeReason && (
                          <span
                            className="ml-2 inline-flex items-center gap-1 rounded-lg bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand-dark dark:text-brand"
                            title={freeReason}
                          >
                            <BadgeCheck className="h-3 w-3" />
                            免费
                          </span>
                        )}
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
                      <td className={`${TD} whitespace-nowrap font-medium text-gray-700 dark:text-gray-200`}>
                        {Number(row.balance ?? 0).toFixed(2)} 元
                      </td>
                      <td className={TD}>{row.job_count}</td>
                      <td className={`${TD} text-gray-400`}>{row.created_at?.replace('T', ' ') ?? '—'}</td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <div className="flex items-center gap-2">
                          {/* 免费账户：进/出白名单（管理员与 anticraft 账号本身就免费，这里不给开关） */}
                          {row.role === 'root' || row.role === 'admin' || row.source === 'anticraft' ? (
                            <span className="text-xs text-gray-400" title={freeReason}>
                              自带免费
                            </span>
                          ) : (
                            <button
                              type="button"
                              className={inWhitelist ? BTN_SECONDARY : BTN_PRIMARY}
                              disabled={busy}
                              onClick={() => void toggleFree(row)}
                            >
                              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BadgeCheck className="h-3.5 w-3.5" />}
                              {inWhitelist ? '取消免费' : '设为免费'}
                            </button>
                          )}

                          {/* 加 / 收管理员：只有 root 能动 */}
                          {isRoot ? (
                            <span className="text-xs text-gray-400">不可修改</span>
                          ) : isSelf ? (
                            <span className="text-xs text-gray-400">不能改自己</span>
                          ) : row.role === 'admin' ? (
                            <button
                              type="button"
                              className={BTN_SECONDARY}
                              disabled={busy || !canManageRole}
                              title={canManageRole ? '' : '只有超级管理员能改角色'}
                              onClick={() => void changeRole(row, 'user')}
                            >
                              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
                              收回管理员
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={BTN_PRIMARY}
                              disabled={busy || !canManageRole}
                              title={canManageRole ? '' : '只有超级管理员能改角色'}
                              onClick={() => void changeRole(row, 'admin')}
                            >
                              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                              设为管理员
                            </button>
                          )}

                          <button
                            type="button"
                            className={BTN_SECONDARY}
                            disabled={busy}
                            onClick={() => {
                              setBalanceTarget(row)
                              setBalanceDelta('')
                              setBalanceNote('')
                              setBalanceError('')
                            }}
                          >
                            <Coins className="h-3.5 w-3.5" />
                            调整余额
                          </button>

                          {/* 删除：管理员/root 都能删；余额必须为 0（服务端也会再校验） */}
                          {!isSelf && !isRoot && (
                            <button
                              type="button"
                              className={BTN_DANGER}
                              disabled={busy || hasBalance}
                              title={hasBalance ? '余额不为 0：先在「调整余额」里扣到 0 再删除' : '删除账号'}
                              onClick={() => {
                                setDeleteTarget(row)
                                setDeleteError('')
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              删除
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* root 调账：充值暂未实现，先由管理员手工记账 */}
      <Modal
        open={balanceTarget !== null}
        title={balanceTarget ? `调整余额：${balanceTarget.username}` : '调整余额'}
        size="sm"
        onClose={() => setBalanceTarget(null)}
        footer={
          <>
            <button
              type="button"
              className={`${BTN_SECONDARY} flex-1 justify-center sm:flex-none`}
              onClick={() => setBalanceTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              className={`${BTN_PRIMARY} flex-1 justify-center sm:flex-none`}
              disabled={balanceBusy}
              onClick={() => void submitBalance()}
            >
              {balanceBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Coins className="h-3.5 w-3.5" />}
              确认调整
            </button>
          </>
        }
      >
        <p className="text-sm text-gray-500 dark:text-gray-400">
          当前余额{' '}
          <span className="font-medium text-gray-700 dark:text-gray-200">
            {Number(balanceTarget?.balance ?? 0).toFixed(2)} 元
          </span>
          。正数加钱、负数扣钱（最多两位小数，单次不超过 10000 元）；每次调整都会记进该账号的消费记录。
        </p>
        {balanceError && (
          <p className="mt-3 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">{balanceError}</p>
        )}
        <label className={LABEL} htmlFor="balance-delta">
          金额（元）
        </label>
        <input
          id="balance-delta"
          className={INPUT}
          value={balanceDelta}
          placeholder="例如 5 或 -2.5"
          onChange={(event) => setBalanceDelta(event.target.value)}
        />
        <label className={LABEL} htmlFor="balance-note">
          备注（可选）
        </label>
        <input
          id="balance-note"
          className={INPUT}
          value={balanceNote}
          placeholder="例如 现金充值 / 误扣返还"
          onChange={(event) => setBalanceNote(event.target.value)}
        />
      </Modal>

      {/* 删除账号确认（仅 root；余额为 0 才能删） */}
      <Modal
        open={deleteTarget !== null}
        title={deleteTarget ? `删除账号：${deleteTarget.username}` : '删除账号'}
        size="sm"
        danger
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <button
              type="button"
              className={`${BTN_SECONDARY} flex-1 justify-center sm:flex-none`}
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              className={`${BTN_DANGER} flex-1 justify-center sm:flex-none`}
              disabled={deleteBusy}
              onClick={() => void submitDelete()}
            >
              {deleteBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              确认删除
            </button>
          </>
        }
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          账号 <strong>{deleteTarget?.username}</strong> 会被删除，之后无法登录；
          <strong>他提交过的 {deleteTarget?.job_count ?? 0} 个任务与余额流水会保留</strong>（任务列表里提交人显示为空）。
        </p>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          余额必须为 0 才能删除（当前 {Number(deleteTarget?.balance ?? 0).toFixed(2)} 元）——钱没结清就删会丢账。
          需要保留打印记录的话，建议先「取消免费 / 收回管理员」而不是删除。
        </p>
        {deleteError && (
          <p className="mt-3 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">{deleteError}</p>
        )}
      </Modal>
    </div>
  )
}

export default UsersPage
