// 全站唯一请求出口：统一携带 Bearer 令牌、统一拦截 401 过期、统一转换为中文错误
import type {
  BalanceInfo,
  AdminUserRow,
  Agent,
  AnticraftOauthStatus,
  DeliveryMode,
  Job,
  JobStatus,
  Profile,
  Settings,
  User,
} from './types/api'

const TOKEN_KEY = 'token'
const USER_KEY = 'user'

/**
 * 这些路径的 401 表示凭据 / 票据本身错误（不是登录过期），
 * 不能触发「登录已过期」拦截去清空本地登录态；新增登录类接口时要同步补进这里。
 */
const NO_EXPIRY_PATHS = ['/api/login', '/api/login/anticraft', '/api/oauth/anticraft/exchange']

let onAuthExpired: (() => void) | null = null

/** 头像变更事件名：我的配置页换/删头像后广播，侧栏（App）监听到就重新拉一次 */
export const AVATAR_EVENT = 'antiprint:avatar-changed'

/** 广播头像已变更 */
export function notifyAvatarChanged(): void {
  window.dispatchEvent(new Event(AVATAR_EVENT))
}

/** 注册登录过期回调（App 挂载时注册；401 时清空本地登录态后触发） */
export function setOnAuthExpired(cb: (() => void) | null): void {
  onAuthExpired = cb
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

/** 清空本地登录态（令牌 + 用户缓存） */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export function getUser(): User | null {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<User>
    if (typeof parsed?.username === 'string' && (parsed.role === 'user' || parsed.role === 'admin')) {
      return parsed as User
    }
  } catch {
    // 缓存损坏时当作未登录处理
  }
  return null
}

export function setUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

/** 请求选项：body 为 FormData 时按 multipart 提交，其余对象按 JSON 提交 */
export interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

export interface JobListResponse {
  jobs: Job[]
}

export interface QueueResponse {
  jobs: Job[]
  agents: Agent[]
  agent_online: boolean
}

export interface SettingsResponse {
  settings: Settings
  agents: Agent[]
  agent_online: boolean
}

/** anticraft 登录的响应：auto_registered 为 true 表示本次登录顺带创建了 AntiPrint 账号 */
export interface AnticraftLoginResponse {
  token: string
  user: User
  auto_registered: boolean
  source: string
}

/** 授权码模式回调的兑换结果（后端不返回 source 字段） */
export interface AnticraftExchangeResponse {
  token: string
  user: User
  auto_registered: boolean
  /** true = 本次是「我的配置 → 绑定 anticraft」的回跳，落地页显示绑定成功而不是登录成功 */
  bound?: boolean
}

/** 保存设置的请求体（后端按 k/v 字符串存储；client_secret 传空串或掩码表示不修改） */
export interface SettingsPayload {
  launcher?: string
  printer_name?: string
  copies?: string
  dry_run?: string
  anticraft_base?: string
  anticraft_client_id?: string
  anticraft_client_secret?: string
  anticraft_origins?: string
  anticraft_admin_users?: string
  /** 每张打印单价（元，0 ~ 100） */
  print_price?: string
  /** 免费打印白名单（用户名，逗号分隔） */
  free_users?: string
  /** 是否打印任务信息页（'true' / 'false'） */
  cover_page?: string
}

/** 用户配置的请求体（默认地址 / 默认配送方式） */
export interface ProfilePayload {
  default_address?: string
  default_delivery?: DeliveryMode
}

/** 重新提交时允许修改的字段（只提交发生变化的字段，未变化则不传，避免覆盖） */
export interface ResubmitPayload {
  address?: string
  note?: string
}

/** 读取后端错误信息：优先 detail / message 里的中文，兜底给通用中文文案 */
/** 带状态码与原始 detail 的错误：余额不足（402）等场景需要读结构化字段 */
export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(message: string, status: number, detail: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

async function readErrorDetail(res: Response): Promise<{ message: string; detail: unknown }> {
  try {
    const data: unknown = await res.json()
    if (data && typeof data === 'object') {
      const raw = (data as { detail?: unknown; message?: unknown }).detail ?? (data as { message?: unknown }).message
      if (typeof raw === 'string' && raw.trim()) return { message: raw, detail: raw }
      if (raw && typeof raw === 'object') {
        const message = (raw as { message?: unknown }).message
        if (typeof message === 'string' && message.trim()) return { message, detail: raw }
      }
      if (Array.isArray(raw) && raw.length > 0) return { message: '请求参数有误，请检查后重试', detail: raw }
    }
  } catch {
    // 响应体不是 JSON，走下面的兜底文案
  }
  return { message: `请求失败（HTTP ${res.status}）`, detail: null }
}

/** 发送请求并统一处理鉴权头与 401（登录接口本身除外） */
async function rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (options.body instanceof FormData) {
    // 交给浏览器自动带 multipart boundary，不能手写 Content-Type
    body = options.body
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(path, { method: options.method ?? 'GET', headers, body, signal: options.signal })
  } catch {
    throw new Error('网络请求失败，请确认后端服务已启动')
  }

  // 登录类接口返回 401 表示账号密码 / 票据错误，不能当作「登录已过期」清空本地登录态
  const isLoginPath = NO_EXPIRY_PATHS.includes(path)
  if (res.status === 401 && !isLoginPath) {
    clearToken()
    onAuthExpired?.()
  }
  return res
}

/** 通用 JSON 请求；失败时抛出带中文信息的 Error */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await rawRequest(path, options)
  if (!res.ok) {
    const { message, detail } = await readErrorDetail(res)
    throw new ApiError(message, res.status, detail)
  }
  if (res.status === 204) return undefined as T
  try {
    return (await res.json()) as T
  } catch {
    throw new Error('服务器返回了无法解析的数据')
  }
}

/** 把任意异常转换为可直接展示的中文提示 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return '操作失败，请稍后重试'
}

export const api = {
  /** 登录：成功返回令牌与用户信息；失败后端返回 401 中文提示 */
  async login(username: string, password: string): Promise<{ token: string; user: User }> {
    return request<{ token: string; user: User }>('/api/login', { method: 'POST', body: { username, password } })
  },

  /** 注册：成功后直接返回令牌与用户信息，相当于自动登录 */
  async register(username: string, password: string): Promise<{ token: string; user: User }> {
    return request<{ token: string; user: User }>('/api/register', { method: 'POST', body: { username, password } })
  },

  /**
   * 用 anticraft 账号登录：AntiPrint 没有该账号时后端自动创建（auto_registered 为 true）。
   * 失败时后端返回中文 detail：401 账号密码错误、409 用户名被本地账号占用、502 连不上 anticraft
   */
  async loginAnticraft(username: string, password: string): Promise<AnticraftLoginResponse> {
    return request<AnticraftLoginResponse>('/api/login/anticraft', {
      method: 'POST',
      body: { username, password },
    })
  },

  /** 是否已配置 anticraft 绑定应用（公开接口，登录页据此决定能否跳转授权） */
  async getAnticraftOauthStatus(): Promise<AnticraftOauthStatus> {
    return request<AnticraftOauthStatus>('/api/oauth/anticraft/status')
  },

  /**
   * 授权回调页用一次性 ticket 换本地登录态。
   * 票据 2 分钟内有效且只能用一次，失效时后端返回 400 中文 detail
   */
  async exchangeAnticraftTicket(ticket: string): Promise<AnticraftExchangeResponse> {
    return request<AnticraftExchangeResponse>('/api/oauth/anticraft/exchange', {
      method: 'POST',
      body: { ticket },
    })
  },

  /** 校验当前令牌是否有效，并返回最新的用户信息 */
  async me(): Promise<User> {
    return request<User>('/api/me')
  },

  /** 我的任务列表 */
  async listMineJobs(): Promise<Job[]> {
    const data = await request<JobListResponse>('/api/jobs/mine')
    return data.jobs
  },

  /** 管理端：全部任务 + 代理信息 */
  async listAllJobs(): Promise<QueueResponse> {
    return request<QueueResponse>('/api/jobs')
  },

  /** 单个任务详情（含文件列表） */
  async getJob(id: number): Promise<Job> {
    const data = await request<{ job: Job }>(`/api/jobs/${id}`)
    return data.job
  },

  /** 管理员同意，任务进入打印队列 */
  async approve(id: number): Promise<Job> {
    const data = await request<{ job: Job }>(`/api/jobs/${id}/approve`, { method: 'POST' })
    return data.job
  },

  /** 管理员驳回（理由必填） */
  async reject(id: number, reason: string): Promise<Job> {
    const data = await request<{ job: Job }>(`/api/jobs/${id}/reject`, { method: 'POST', body: { reason } })
    return data.job
  },

  /** 提交人对已驳回任务改后重新提交 */
  async resubmit(id: number, payload: ResubmitPayload = {}): Promise<Job> {
    const data = await request<{ job: Job }>(`/api/jobs/${id}/resubmit`, { method: 'POST', body: payload })
    return data.job
  },

  /** 管理员对打印失败任务重新入队 */
  async retry(id: number): Promise<Job> {
    const data = await request<{ job: Job }>(`/api/jobs/${id}/retry`, { method: 'POST' })
    return data.job
  },

  /** 提交人撤回自己的任务（仅待审核 / 已通过，即尚未出纸） */
  async withdrawJob(id: number): Promise<Job> {
    const data = await request<{ job: Job }>(`/api/jobs/${id}/withdraw`, { method: 'POST' })
    return data.job
  },

  /** 管理员重新打印：把已出纸/已结束的任务重新入队（清掉上次打印痕迹） */
  async reprintJob(id: number): Promise<Job> {
    const data = await request<{ job: Job }>(`/api/jobs/${id}/reprint`, { method: 'POST' })
    return data.job
  },

  /** 管理员交接流转：已打印 → 待配送/待取件 → 已完成（后端校验配送方式是否匹配） */
  async advance(id: number, to: JobStatus): Promise<Job> {
    const data = await request<{ job: Job }>(`/api/jobs/${id}/advance`, { method: 'POST', body: { to } })
    return data.job
  },

  /** 用户配置（默认地址 / 默认配送方式 / anticraft 绑定状态） */
  async getProfile(): Promise<Profile> {
    const data = await request<{ profile: Profile }>('/api/profile')
    return data.profile
  },

  /** 保存用户配置 */
  async saveProfile(payload: ProfilePayload): Promise<Profile> {
    const data = await request<{ profile: Profile }>('/api/profile', { method: 'PUT', body: payload })
    return data.profile
  },

  /** 领「绑定 anticraft」的一次性票据（浏览器跳转带不了 Bearer，用它标记要绑到哪个账号） */
  async anticraftBindTicket(): Promise<string> {
    const data = await request<{ ticket: string }>('/api/profile/anticraft/bind-ticket', { method: 'POST' })
    return data.ticket
  },

  /** 解除 anticraft 绑定；必须同时设置本地密码，否则授权建号的账号会无法登录 */
  async unbindAnticraft(password: string): Promise<Profile> {
    const data = await request<{ profile: Profile }>('/api/profile/anticraft/unbind', {
      method: 'POST',
      body: { password },
    })
    return data.profile
  },

  /** 管理员删除任务 */
  async deleteJob(id: number): Promise<void> {
    await request<{ ok: boolean }>(`/api/jobs/${id}`, { method: 'DELETE' })
  },

  /** 用户列表（管理员可看；改角色需要 root） */
  async listUsers(): Promise<AdminUserRow[]> {
    const data = await request<{ users: AdminUserRow[] }>('/api/users')
    return data.users
  },

  /** root 把用户设为普通用户 / 管理员 */
  async setUserRole(userId: number, role: 'user' | 'admin'): Promise<void> {
    await request<{ ok: boolean }>(`/api/users/${userId}/role`, { method: 'POST', body: { role } })
  },

  /** 管理端读取系统设置与代理信息 */
  async getSettings(): Promise<SettingsResponse> {
    return request<SettingsResponse>('/api/settings')
  },

  /** 管理端保存系统设置 */
  async saveSettings(payload: SettingsPayload): Promise<Settings> {
    const data = await request<{ settings: Settings }>('/api/settings', { method: 'POST', body: payload })
    return data.settings
  },

  /** 上传/更换头像（png/jpg/gif/webp，≤2MB） */
  async uploadAvatar(file: File): Promise<Profile> {
    const form = new FormData()
    form.append('file', file, file.name)
    const data = await request<{ profile: Profile }>('/api/profile/avatar', { method: 'POST', body: form })
    return data.profile
  },

  /** 移除自己的头像（清 users.avatar 并删文件） */
  async removeAvatar(): Promise<Profile> {
    const data = await request<{ profile: Profile }>('/api/profile/avatar', { method: 'DELETE' })
    return data.profile
  },

  /** 取某人的头像图：接口需要 Bearer，所以拿 Blob 再由调用方 createObjectURL */
  async fetchAvatarBlob(userId: number): Promise<Blob> {
    const res = await rawRequest(`/api/users/${userId}/avatar`)
    if (!res.ok) throw new Error('没有头像')
    return res.blob()
  },

  /** 我的余额（含最近的扣费/退费流水） */
  async getBalance(): Promise<BalanceInfo> {
    return request<BalanceInfo>('/api/balance')
  },

  /** root 删除账号（余额必须为 0；任务与流水保留） */
  async deleteUser(userId: number): Promise<void> {
    await request<{ ok: boolean }>(`/api/users/${userId}`, { method: 'DELETE' })
  },

  /** root 给账号加/减余额（充值暂未实现，先手工记账） */
  async adjustBalance(userId: number, delta: string, note?: string): Promise<string> {
    const data = await request<{ balance: string }>(`/api/users/${userId}/balance`, {
      method: 'POST',
      body: { delta, note },
    })
    return data.balance
  },

  /** 管理端重置代理令牌，返回新令牌 */
  async rotateAgentToken(): Promise<string> {
    const data = await request<{ agent_token: string }>('/api/settings/rotate-agent-token', { method: 'POST' })
    return data.agent_token
  },

  /** 管理端断开 / 重新连接打印代理（断开期间代理的注册、心跳、领取、回报一律 403） */
  async setAgentLink(connected: boolean): Promise<SettingsResponse> {
    return request<SettingsResponse>('/api/settings/agent-link', { method: 'POST', body: { connected } })
  },

  /** 提交打印任务（multipart：address 必填、note 可选、files 可多个） */
  async submitJob(formData: FormData): Promise<Job> {
    const data = await request<{ job: Job }>('/api/jobs', { method: 'POST', body: formData })
    return data.job
  },

  /** 取任务文件内容：接口需要 Bearer，因此用 fetch 拿 Blob 再由调用方 createObjectURL */
  async fetchFileBlob(jobId: number, fileId: number, download = false): Promise<Blob> {
    const path = `/api/jobs/${jobId}/files/${fileId}${download ? '?download=1' : ''}`
    const res = await rawRequest(path)
    if (!res.ok) throw new Error((await readErrorDetail(res)).message)
    return res.blob()
  },

  /** 提交前预览 Word/PPT：服务端转成 PDF 返回（结果按内容缓存，提交时命中同一份） */
  async convertOfficePreview(file: File): Promise<Blob> {
    const form = new FormData()
    form.append('file', file, file.name)
    const res = await rawRequest('/api/preview/office', { method: 'POST', body: form })
    if (!res.ok) throw new Error((await readErrorDetail(res)).message)
    return res.blob()
  },
}
