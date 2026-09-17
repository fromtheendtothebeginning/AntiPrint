// 接口层：与 web 端 frontend/src/api.ts 同样的「唯一出口」用法，
// 但小程序里没有 fetch/FormData/Blob —— 全部走 wx.request / wx.uploadFile / wx.downloadFile。
// 类型与常量直接复用 web 端源码（webpack 别名 @shared → ../frontend/src），web 端代码不改动。
import type { DeliveryMode, Job, JobFile, Profile, BalanceInfo } from '@shared/types/api'

/**
 * 后端地址：**固定指向线上站点，不提供任何修改入口**
 * （用户端不该关心部署在哪；本机联调时直接改这里的常量再构建）
 */
export const SERVER = 'https://print.anticraft.top'

const TOKEN_KEY = 'antiprint_token'
const USER_KEY = 'antiprint_user'

export interface User {
  id: number
  username: string
  role: string
}

/** 带状态码的错误（与 web 端 ApiError 用法一致：余额不足要读 detail 里的结构化信息） */
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

/** 402 余额不足时后端给的明细（与 web 端 SubmitPage 读的是同一份结构） */
export interface InsufficientBalanceDetail {
  code: string
  message: string
  cost: string
  balance: string
  sheets: number
}

/** 取到结构化明细就返回它，否则返回 null */
export function insufficientBalance(error: unknown): InsufficientBalanceDetail | null {
  if (!(error instanceof ApiError) || error.status !== 402) return null
  const detail = error.detail as { code?: string } | null
  if (!detail || detail.code !== 'insufficient_balance') return null
  return detail as InsufficientBalanceDetail
}

function readError(payload: unknown, fallback: string): { message: string; detail: unknown } {
  if (payload && typeof payload === 'object') {
    const detail = (payload as { detail?: unknown }).detail
    if (typeof detail === 'string' && detail.trim()) return { message: detail, detail }
    if (detail && typeof detail === 'object') {
      const message = (detail as { message?: unknown }).message
      if (typeof message === 'string' && message.trim()) return { message, detail }
    }
  }
  return { message: fallback, detail: null }
}

/** 把上传文件的本地路径换成「原名」路径（wx.uploadFile 用路径最后一段当文件名） */
export function stageFile(tempPath: string, name: string): string {
  const safe = (name || '').replace(/[\\/:*?"<>|]+/g, '_').trim() || '未命名'
  const target = `${wx.env.USER_DATA_PATH}/${safe}`
  try {
    wx.getFileSystemManager().copyFileSync(tempPath, target)
    return target
  } catch (error) {
    // 复制失败（空间不足等）就用临时路径上传：文件名会变成临时名，但不影响打印
    return tempPath
  }
}

/** 上传完把暂存文件删掉，别把用户文件空间撑满 */
export function dropStagedFile(path: string): void {
  if (!path.startsWith(wx.env.USER_DATA_PATH)) return
  try {
    wx.getFileSystemManager().unlinkSync(path)
  } catch (error) {
    // 删不掉就算了（下次同名会被覆盖）
  }
}

class Api {
  token = ''
  user: User | null = null
  /** 服务器地址固定（见 SERVER 常量），保留字段是为了调用处读起来顺 */
  readonly server = SERVER
  /** 登录态过期（401）时的回调：由 page.ts 挂上「回登录页」 */
  onAuthExpired: (() => void) | null = null

  /** 从本地缓存恢复登录态（小程序里 localStorage 的等价物是 wx.getStorageSync） */
  restoreToken() {
    this.token = wx.getStorageSync(TOKEN_KEY) || ''
    this.user = wx.getStorageSync(USER_KEY) || null
  }

  logout() {
    this.token = ''
    this.user = null
    wx.removeStorageSync(TOKEN_KEY)
    wx.removeStorageSync(USER_KEY)
  }

  private saveAuth(token: string, user: User) {
    this.token = token
    this.user = user
    wx.setStorageSync(TOKEN_KEY, token)
    wx.setStorageSync(USER_KEY, user)
  }

  /** JSON 请求（对应 web 端 request()）；401 统一清登录态 */
  request<T>(path: string, options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const header: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.token) header.Authorization = `Bearer ${this.token}`
      wx.request({
        url: this.server + path,
        method: options.method || 'GET',
        header,
        data: options.body as WechatMiniprogram.IAnyObject | undefined,
        success: (res) => {
          if (res.statusCode === 401) {
            this.logout()
            if (this.onAuthExpired) this.onAuthExpired()
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res.data as T)
            return
          }
          const { message, detail } = readError(res.data, `请求失败（HTTP ${res.statusCode}）`)
          reject(new ApiError(message, res.statusCode, detail))
        },
        fail: (err) => reject(new Error(`网络请求失败：${err.errMsg || '请检查服务器地址与网络'}`)),
      })
    })
  }

  /** 上传（对应 web 端的多部分表单）；小程序一次只能传一个文件 */
  upload<T>(path: string, filePath: string, formData: Record<string, string> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const header: Record<string, string> = {}
      if (this.token) header.Authorization = `Bearer ${this.token}`
      wx.uploadFile({
        url: this.server + path,
        filePath,
        name: 'files',      // 后端表单字段名
        formData,
        header,
        success: (res) => {
          if (res.statusCode === 401) {
            this.logout()
            if (this.onAuthExpired) this.onAuthExpired()
          }
          let payload: unknown = res.data
          try {
            payload = JSON.parse(res.data)
          } catch (error) {
            // 服务端返回的不是 JSON，按原文提示
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(payload as T)
            return
          }
          const { message, detail } = readError(payload, `上传失败（HTTP ${res.statusCode}）`)
          reject(new ApiError(message, res.statusCode, detail))
        },
        fail: (err) => reject(new Error(`上传失败：${err.errMsg || '网络异常'}`)),
      })
    })
  }

  // ── 账号 ──

  async login(username: string, password: string): Promise<User> {
    const data = await this.request<{ token: string; user: User }>('/api/login', {
      method: 'POST',
      body: { username, password },
    })
    this.saveAuth(data.token, data.user)
    return data.user
  }

  async register(username: string, password: string): Promise<User> {
    const data = await this.request<{ token: string; user: User }>('/api/register', {
      method: 'POST',
      body: { username, password },
    })
    this.saveAuth(data.token, data.user)
    return data.user
  }

  async me(): Promise<User> {
    return this.request<User>('/api/me')
  }

  // ── 配置 / 余额 ──

  async getProfile(): Promise<Profile> {
    const data = await this.request<{ profile: Profile }>('/api/profile')
    return data.profile
  }

  /** 保存默认配送方式与地址（提交页会自动带出来） */
  async saveProfile(payload: { default_address: string; default_delivery: DeliveryMode }): Promise<Profile> {
    const data = await this.request<{ profile: Profile }>('/api/profile', { method: 'PUT', body: payload })
    return data.profile
  }

  async getBalance(): Promise<BalanceInfo> {
    return this.request<BalanceInfo>('/api/balance')
  }

  // ── 任务 ──

  async listMyJobs(): Promise<Job[]> {
    const data = await this.request<{ jobs: Job[] }>('/api/jobs/mine')
    return data.jobs
  }

  async withdrawJob(jobId: number): Promise<Job> {
    const data = await this.request<{ job: Job }>(`/api/jobs/${jobId}/withdraw`, { method: 'POST' })
    return data.job
  }

  /**
   * 提交打印任务。后端只支持「建单时一次带上文件」，所以小程序按单文件提交
   * （web 端一次最多 5 个文件，小程序要打多份就分多次提交）。
   */
  async submitJob(options: {
    filePath: string
    address: string
    mode: DeliveryMode
    note?: string
    copies?: number
    /** 纸张固定 A4（机型与业务都只支持 A4） */
    paper?: string
    /** 页面范围，如 1-3,5（留空 = 全部页面） */
    pages?: string
    /** 每张纸排几页（"行,列"，如 1,1 / 2,1 / 2,2）；白名单见 backend/constants.PRINT_NUP */
    nup?: string
    /** 缩放：fit 适应纸张 / noscale 实际大小 / shrink 缩小到可打印区域 */
    scale?: string
  }): Promise<Job> {
    const formData: Record<string, string> = {
      address: options.address || '',
      delivery_mode: options.mode,
      note: options.note || '',
      copies: String(options.copies || 1),
      paper: options.paper || 'A4',
      nup: options.nup || '1,1',
      scale: options.scale || 'fit',
    }
    if (options.pages && options.pages.trim()) formData.pages = options.pages.trim()
    const data = await this.upload<{ job: Job }>('/api/jobs', options.filePath, formData)
    return data.job
  }

  /** 提交前预览本地选中的文件：图片走 previewImage，其余（PDF/Office）走 openDocument */
  async openLocalFile(filePath: string, filename: string): Promise<void> {
    const name = filename || ''
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
      await new Promise<void>((resolve, reject) => {
        wx.previewImage({
          urls: [filePath],
          success: () => resolve(),
          fail: (err) => reject(new Error(`无法预览该图片：${err.errMsg || '格式不支持'}`)),
        })
      })
      return
    }
    // openDocument 只认这几种 fileType，其它交给小程序按内容判断
    const KNOWN_TYPES = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf']
    const extension = ((/\.(\w+)$/.exec(name) || [])[1] || '').toLowerCase()
    const fileType = (KNOWN_TYPES as string[]).includes(extension)
      ? (extension as 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx' | 'pdf')
      : undefined
    await new Promise<void>((resolve, reject) => {
      wx.openDocument({
        filePath,
        fileType,
        showMenu: true,
        success: () => resolve(),
        fail: (err) => reject(new Error(`无法预览该文件：${err.errMsg || '格式不支持'}`)),
      })
    })
  }

  // ── 文件 ──

  /** 下载任务文件到本地临时目录（小程序不能内嵌 PDF，用 wx.openDocument 打开） */
  downloadJobFile(jobId: number, fileId: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      wx.downloadFile({
        url: `${this.server}/api/jobs/${jobId}/files/${fileId}`,
        header: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        success: (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.tempFilePath)
          else reject(new Error(`下载失败（HTTP ${res.statusCode}）`))
        },
        fail: (err) => reject(new Error(`下载失败：${err.errMsg || '网络异常'}`)),
      })
    })
  }

  /**
   * 打开任务文件：Office 会被后端转成 PDF 再下发。
   * PDF/Office 走 wx.openDocument，图片走 wx.previewImage（openDocument 不支持图片）。
   */
  async openJobFile(jobId: number, file: JobFile): Promise<void> {
    const path = await this.downloadJobFile(jobId, file.id)
    const name = file.filename || ''
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
      await new Promise<void>((resolve, reject) => {
        wx.previewImage({
          urls: [path],
          success: () => resolve(),
          fail: (err) => reject(new Error(`无法预览该图片：${err.errMsg || '格式不支持'}`)),
        })
      })
      return
    }
    await new Promise<void>((resolve, reject) => {
      wx.openDocument({
        filePath: path,
        fileType: /\.(docx?|pptx?)$/i.test(name) ? 'pdf' : (name.toLowerCase().endsWith('.pdf') ? 'pdf' : undefined),
        showMenu: true,
        success: () => resolve(),
        fail: (err) => reject(new Error(`无法预览该文件：${err.errMsg || '格式不支持'}`)),
      })
    })
  }
}

const api = new Api()
export default api
