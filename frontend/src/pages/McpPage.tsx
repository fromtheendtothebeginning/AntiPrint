// MCP 接入：生成长期 API 令牌 + 用户端/管理端两套接入教程
// 用户端（antiprint-user-mcp）：查余额、看任务、提交打印、撤回、充值
// 管理端（antiprint-mcp）：审核、交接、用户与设置（仅管理员令牌可用）
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  Plug,
  ShieldCheck,
  Terminal,
  Trash2,
  UserRound,
} from 'lucide-react'
import { api, getErrorMessage } from '../api'
import type { ApiToken } from '../types/api'

const CARD = 'rounded-2xl bg-white p-5 shadow-xl shadow-black/[0.04] dark:bg-ink-soft sm:p-6'
const ALERT_ERROR =
  'flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400'
const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand/25 transition-all duration-200 hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60'
const BTN_GHOST =
  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-gray-500 transition-colors hover:bg-warm hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-100'

const USER_TOOLS: { name: string; text: string }[] = [
  { name: 'whoami', text: '确认令牌对应的账号' },
  { name: 'my_balance', text: '余额、单价与扣费流水' },
  { name: 'list_my_jobs', text: '我的任务列表（可按状态筛选）' },
  { name: 'get_my_job', text: '单个任务详情' },
  { name: 'submit_print_job', text: '读本机文件提交打印（自动扣费 + 进队列）' },
  { name: 'withdraw_my_job', text: '撤回未出纸的任务并退费' },
  { name: 'recharge', text: '创建支付宝充值订单' },
  { name: 'check_recharge', text: '查充值是否到账' },
]

const ADMIN_TOOLS: { name: string; text: string }[] = [
  { name: 'submit_print_job', text: '提交打印并自动入队（管理员免费）' },
  { name: 'list_jobs / get_job', text: '任务队列与详情' },
  { name: 'approve_job / reject_job', text: '审核通过 / 驳回退费' },
  { name: 'retry_job / reprint_job', text: '重试 / 重新打印' },
  { name: 'advance_job / withdraw_job', text: '交接流转 / 代用户撤回' },
  { name: 'delete_job', text: '删除任务与文件' },
  { name: 'list_users / adjust_balance', text: '用户列表 / 调账' },
  { name: 'set_user_role / delete_user', text: '改角色 / 删账号（root）' },
  { name: 'get_settings / update_settings', text: '打印设置与白名单' },
  { name: 'set_agent_connected', text: '断开 / 恢复打印代理' },
]

/** 带复制按钮的代码块 */
function Snippet({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // 非 https / 老浏览器：让用户手动选中
    }
  }
  return (
    <div className="overflow-hidden rounded-xl border border-gray-100 dark:border-white/10">
      <div className="flex items-center justify-between gap-2 bg-warm/70 px-3 py-1.5 dark:bg-white/5">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{title}</span>
        <button type="button" className={BTN_GHOST} onClick={() => void copy()}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto bg-[#fbfaf8] px-3 py-3 text-[12px] leading-relaxed text-gray-700 dark:bg-ink dark:text-gray-200">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function Step({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{title}</div>
        <div className="space-y-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">{children}</div>
      </div>
    </div>
  )
}

interface McpPageProps {
  /** 当前账号角色：管理员才显示「管理端」教程 */
  role?: string
}

function McpPage({ role = 'user' }: McpPageProps) {
  const isAdmin = role === 'admin' || role === 'root'
  const [tab, setTab] = useState<'user' | 'admin'>('user')
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tokenName, setTokenName] = useState('')
  const [creating, setCreating] = useState(false)
  const [freshToken, setFreshToken] = useState('')
  const [busyId, setBusyId] = useState(0)

  const load = useCallback(async () => {
    try {
      setTokens(await api.listTokens())
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const flash = (text: string) => {
    setNotice(text)
    window.setTimeout(() => setNotice(''), 3000)
  }

  const create = async () => {
    setCreating(true)
    setError('')
    try {
      const data = await api.createToken(tokenName.trim() || (isAdmin ? '管理端 MCP' : '用户端 MCP'))
      setFreshToken(data.token)
      setTokenName('')
      setTokens((prev) => [data.token_info, ...prev])
      flash('令牌已生成，请立即复制保存（之后只显示前缀）')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (token: ApiToken) => {
    if (!window.confirm(`撤销令牌「${token.name}」？使用它的 MCP 客户端会立即断开。`)) return
    setBusyId(token.id)
    try {
      await api.revokeToken(token.id)
      setTokens((prev) => prev.filter((item) => item.id !== token.id))
      flash('令牌已撤销')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusyId(0)
    }
  }

  const serverCommand = tab === 'admin' ? 'antiprint-mcp' : 'antiprint-user-mcp'

  const localConfig = useMemo(
    () =>
      JSON.stringify(
        {
          base_url: window.location.origin,
          token: freshToken || 'ap_在这里粘贴刚生成的令牌',
        },
        null,
        2,
      ),
    [freshToken],
  )

  /** 一条 PowerShell 命令写入配置文件：用户复制粘贴即可，不用自己新建文件 */
  const writeConfigCmd = useMemo(
    () => `@'\n${localConfig}\n'@ | Set-Content -Encoding utf8 "$env:USERPROFILE\\.antiprint-mcp.json"`,
    [localConfig],
  )

  /** 方式 A：配置写在文件里，客户端只填启动命令 */
  const clientConfigFile = useMemo(
    () => JSON.stringify({ mcpServers: { antiprint: { command: serverCommand } } }, null, 2),
    [serverCommand],
  )

  /** 方式 B：不写配置文件，地址与令牌直接写在客户端 env 里 */
  const clientConfigEnv = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            antiprint: {
              command: serverCommand,
              env: {
                ANTIPRINT_BASE_URL: window.location.origin,
                ANTIPRINT_TOKEN: freshToken || 'ap_在这里粘贴刚生成的令牌',
              },
            },
          },
        },
        null,
        2,
      ),
    [serverCommand, freshToken],
  )

  /** 方式 C：PATH 里找不到命令时，直接用 python -m 启动模块 */
  const clientConfigModule = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            antiprint: {
              command: 'python',
              args: ['-m', tab === 'admin' ? 'antiprint_mcp.server' : 'antiprint_mcp.user_server'],
            },
          },
        },
        null,
        2,
      ),
    [tab],
  )

  const activeTokens = tokens.filter((token) => !token.revoked_at)

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

      <div className={`${CARD} flex flex-col gap-4 sm:flex-row sm:items-start`}>
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <Plug className="h-6 w-6" />
        </span>
        <div className="space-y-1">
          <div className="text-sm font-medium text-gray-800 dark:text-gray-100">
            让 AI 客户端直接操作 AntiPrint
          </div>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
            本站提供 MCP 服务：在 Trae / Cursor / Claude Desktop 里接上后，可以直接对 AI 说
            「帮我提交 D:\a.pdf 打印、双面不用、取件」「看看我有哪些任务」。
            用户端能查余额、提交打印、撤回与充值；管理员令牌还能用审核、交接、调账等管理工具。
          </p>
        </div>
      </div>

      {/* 令牌：明文只显示一次 */}
      <div className={CARD}>
        <div className="mb-3 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-brand" />
          <div className="text-sm font-medium text-gray-800 dark:text-gray-100">1. 生成 API 令牌</div>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          MCP 用长期令牌代替网页登录（24 小时后过期的网页登录态不适合填进客户端配置）。
          令牌等同于密码，别发到群聊或截图里；泄露了就点「撤销」。
        </p>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={tokenName}
            onChange={(event) => setTokenName(event.target.value)}
            placeholder={isAdmin ? '备注，例如：家里的 Trae' : '备注，例如：我的电脑'}
            maxLength={64}
            className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition-colors focus:border-brand dark:border-white/10 dark:bg-ink dark:text-gray-100"
          />
          <button type="button" className={BTN_PRIMARY} disabled={creating} onClick={() => void create()}>
            {creating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            生成令牌
          </button>
        </div>

        {freshToken && (
          <div className="mt-3 space-y-2 rounded-xl border border-amber/40 bg-amber/10 p-3">
            <div className="text-xs font-medium text-gray-700 dark:text-gray-200">
              新令牌（只显示这一次，请立即复制）
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-white/80 px-2.5 py-2 font-mono text-xs text-gray-800 dark:bg-ink dark:text-gray-100">
                {freshToken}
              </code>
              <button
                type="button"
                className={BTN_GHOST}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(freshToken)
                    flash('令牌已复制')
                  } catch {
                    flash('复制失败，请手动选中复制')
                  }
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                复制
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              离开本页后只能看到前缀；丢了就撤销重发，下面教程里的示例会自动换成这枚令牌。
            </p>
          </div>
        )}

        <div className="mt-3 space-y-2">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              正在读取令牌…
            </div>
          ) : activeTokens.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500">还没有令牌。</p>
          ) : (
            activeTokens.map((token) => (
              <div
                key={token.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-100 px-3 py-2 dark:border-white/10"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-gray-700 dark:text-gray-200">{token.name}</div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">
                    <span className="font-mono">{token.prefix}…</span>
                    {' · 创建于 '}
                    {String(token.created_at || '').replace('T', ' ').slice(0, 16)}
                    {token.last_used_at
                      ? ` · 最近使用 ${String(token.last_used_at).replace('T', ' ').slice(0, 16)}`
                      : ' · 还没被使用过'}
                  </div>
                </div>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-60"
                  disabled={busyId === token.id}
                  onClick={() => void revoke(token)}
                >
                  {busyId === token.id ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  撤销
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 教程：用户端 / 管理端 */}
      <div className={CARD}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Terminal className="h-4 w-4 text-brand" />
          <div className="mr-auto text-sm font-medium text-gray-800 dark:text-gray-100">2. 接入教程</div>
          <div className="flex rounded-xl bg-warm p-1 dark:bg-white/5">
            <button
              type="button"
              onClick={() => setTab('user')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === 'user' ? 'bg-white text-brand shadow-sm dark:bg-ink-soft' : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              <UserRound className="h-3.5 w-3.5" />
              用户端
            </button>
            <button
              type="button"
              onClick={() => setTab('admin')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === 'admin' ? 'bg-white text-brand shadow-sm dark:bg-ink-soft' : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              管理端
            </button>
          </div>
        </div>

        {tab === 'admin' && !isAdmin && (
          <div className="mb-4 flex items-start gap-2 rounded-xl bg-amber/10 px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
            <span>管理端工具只对管理员令牌生效：普通账号调用会被后端以 403 拒绝。配置方法可以先看，权限需要管理员账号。</span>
          </div>
        )}

        <div className="mb-4 rounded-xl bg-brand/[0.07] px-4 py-3 text-xs leading-relaxed text-gray-600 dark:bg-brand/10 dark:text-gray-300">
          <span className="font-medium text-gray-800 dark:text-gray-100">最短路径：</span>
          第 1 步安装（只需一次）→ 在上方生成令牌 → 复制第 2 步的 PowerShell 命令执行（自动写好配置文件）→
          把第 3 步「方式 A」的 JSON 粘进 Trae → 刷新工具列表。装好之后不用手动新建任何文件。
        </div>

        <div className="space-y-5">
          <Step index={1} title="安装 MCP 服务（Python 3.10+，只需一次）">
            <Snippet
              title="命令行（Windows 用 python -m pip 也可以）"
              code={`pip install "git+https://github.com/miemiejack8899-source/antiprint.git#subdirectory=mcp"`}
            />
            <Snippet
              title="检查是否装好 / 命令在哪里"
              code={`pip show antiprint-mcp
where.exe antiprint-mcp
where.exe antiprint-user-mcp`}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              看到 <code className="font-mono">Version: 0.2.0</code> 就是装好了；
              <code className="font-mono">where.exe</code> 输出的路径（形如{' '}
              <code className="font-mono">C:\...\Scripts\antiprint-mcp.exe</code>）可以直接填到第 3 步的{' '}
              <code className="font-mono">command</code>，这样最稳，不怕 PATH 找不到。
            </p>
          </Step>

          <Step index={2} title="把令牌写进配置（二选一）">
            <p>
              推荐：直接复制下面这条命令，在 <strong>PowerShell</strong> 里回车。它会自动创建并写好配置文件
              （<code className="font-mono">C:\Users\你\.antiprint-mcp.json</code>），不用自己新建文件：
            </p>
            <Snippet title="一条命令写入配置（PowerShell，含你的令牌）" code={writeConfigCmd} />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              也可以手动编辑那个文件，内容就是下面这段 JSON；或者跳过这一步，改用第 3 步的「方式 B」，
              把同样的地址与令牌写在客户端的 <code className="font-mono">env</code> 里。
              改完不用重启 MCP，下次调用会自动读到新配置。
            </p>
            <Snippet title="配置文件内容（手动方式）" code={localConfig} />
          </Step>

          <Step index={3} title="在 AI 客户端里添加 MCP 服务">
            <p>
              Trae：「设置 → MCP → 添加」，粘贴下面的 JSON；Cursor 写进{' '}
              <code className="font-mono">~/.cursor/mcp.json</code>；Claude Desktop 写进{' '}
              <code className="font-mono">%APPDATA%\Claude\claude_desktop_config.json</code>。
            </p>
            <p>
              <strong>方式 A（推荐，配合第 2 步）</strong>：只填启动命令，地址与令牌从配置文件读取。
            </p>
            <Snippet title="mcpServers（方式 A：读配置文件）" code={clientConfigFile} />
            <p>
              <strong>方式 B（不写配置文件）</strong>：把地址与令牌直接写进 <code className="font-mono">env</code>。
            </p>
            <Snippet title="mcpServers（方式 B：env 传参）" code={clientConfigEnv} />
            <p>
              <strong>方式 C（PATH 里找不到命令时）</strong>：用 <code className="font-mono">python -m</code> 启动，
              不依赖 Scripts 目录是否在 PATH 里。
            </p>
            <Snippet title="mcpServers（方式 C：python -m）" code={clientConfigModule} />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Windows 提示「找不到命令」：把 <code className="font-mono">command</code> 换成第 1 步{' '}
              <code className="font-mono">where.exe</code> 输出的绝对路径，JSON 里的反斜杠要写成{' '}
              <code className="font-mono">\\</code>（例如{' '}
              <code className="font-mono">"C:\\Users\\你\\AppData\\...\\antiprint-mcp.exe"</code>）。
            </p>
          </Step>

          <Step index={4} title="验证，并试打一单">
            <p>
              在客户端里刷新 MCP 工具列表，应该能看到{' '}
              {tab === 'admin' ? '18' : '8'} 个工具。先对 AI 说：
            </p>
            <Snippet
              title="测试话术（可直接复制）"
              code={tab === 'admin' ? '先调用 whoami 确认账号，再调用 list_jobs 看我有哪些任务。' : '先调用 whoami 确认账号，再调用 list_my_jobs 看我的任务和余额。'}
            />
            <p>连接正常后，再试一次提交打印（把路径换成你电脑上的真实文件）：</p>
            <Snippet
              title="提交打印测试"
              code={'调用 submit_print_job，把 E:\\你的文件.pdf 打印 1 份，取件，提交后告诉我任务号和余额。'}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              成功时返回里会有一句「任务 #xx 已提交，当前状态「待审核」，本单费用 x 元，余额 x 元」；
              到网站「我的任务」能立刻看到这条待审核任务。
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(tab === 'admin' ? ADMIN_TOOLS : USER_TOOLS).map((tool) => (
                <div
                  key={tool.name}
                  className="rounded-xl border border-gray-100 px-3 py-2 dark:border-white/10"
                >
                  <div className="break-all font-mono text-xs text-brand">{tool.name}</div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{tool.text}</div>
                </div>
              ))}
            </div>
          </Step>
        </div>
      </div>

      <div className={CARD}>
        <div className="mb-3 text-sm font-medium text-gray-800 dark:text-gray-100">常见问题</div>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium text-gray-700 dark:text-gray-200">提交打印时文件从哪来？</dt>
            <dd className="mt-0.5 text-gray-600 dark:text-gray-300">
              直接从运行 MCP 服务的这台电脑上读本地路径（PDF / 图片 / Word / PPT，单个 ≤10MB，最多 5 个）。
              <span className="font-medium text-gray-700 dark:text-gray-200">
                提交时服务端自动按「张数 × 单价」扣余额，并立刻把任务放进「待审核」队列
              </span>
              （管理员 / 白名单 / anticraft 账号免费不扣）；余额不足会直接报错，账上没钱就先充值或改用即时付款。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-700 dark:text-gray-200">401 / 403 怎么办？</dt>
            <dd className="mt-0.5 text-gray-600 dark:text-gray-300">
              401 是令牌无效或已撤销：重新生成并更新配置。403 是权限不够：管理工具要用管理员账号的令牌，
              另外未绑定手机号的账号不能提交任务和充值。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-700 dark:text-gray-200">令牌能同时给用户端和管理端用吗？</dt>
            <dd className="mt-0.5 text-gray-600 dark:text-gray-300">
              能。两端的服务读同一份配置；能做什么由令牌对应账号的角色决定，普通账号调管理工具会被拒绝。
            </dd>
          </div>
        </dl>
      </div>
    </div>
  )
}

export default McpPage
