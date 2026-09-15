// 后端接口类型定义（与 backend 的 schema 手工同步，改一端必须同步另一端）

export type Role = 'user' | 'admin' | 'root'

export interface User {
  id: number
  username: string
  role: Role
  /** 账号来源（如 anticraft）；早期本地账号可能没有该字段 */
  source?: string
}

/** 配送方式：用户提交时选（默认取用户配置），决定打印完成后进「待配送」还是「待取件」 */
export type DeliveryMode = '配送' | '取件'

/** 任务状态：固定中文字面量，前后端共享，勿改字面量 */
export type JobStatus =
  | '待审核'
  | '已通过'
  | '打印中'
  | '已打印'
  | '已驳回'
  | '打印失败'
  | '待配送'
  | '待取件'
  | '已完成'

/** 任务的打印设置（后端 print_options；空对象/缺字段表示用打印机驱动默认值） */
export interface PrintOptions {
  copies?: number
  duplex?: 'simplex' | 'duplexlong' | 'duplexshort'
  paper?: string
  pages?: string
  nup?: string
  scale?: 'fit' | 'noscale' | 'shrink'
  color?: 'monochrome' | 'color'
}

export interface JobFile {
  id: number
  filename: string
  size: number
  sha256: string
  /** 该文件自己的打印设置（后端已解析成 dict；缺省表示按任务级默认处理） */
  print_options?: PrintOptions
}

export interface Job {
  id: number
  user_id: number
  username?: string
  status: JobStatus
  address: string
  note: string | null
  reject_reason: string | null
  print_error: string | null
  copies: number
  /** 配送方式：配送 / 取件（取件单地址可为空） */
  delivery_mode: DeliveryMode
  created_at: string
  updated_at: string
  printed_at: string | null
  /** 交接完成（标记为「已完成」）的时间 */
  finished_at: string | null
  /** 打印设置（份数/双面/纸张/页面范围/每面页数/缩放/颜色） */
  print_options?: PrintOptions
  files: JobFile[]
}

/** 用户配置：默认配送地址与默认配送方式，以及 anticraft 绑定状态 */
export interface Profile {
  id: number
  username: string
  role: Role
  source: string
  anticraft_bound: boolean
  anticraft_id: number | null
  default_address: string
  default_delivery: DeliveryMode
}

export interface Agent {
  id: number
  name: string
  version: string | null
  printers: string[]
  launcher: string | null
  last_seen: string | null
}

export interface Settings {
  launcher: string
  printer_name: string
  copies: string
  dry_run: string
  agent_token: string
  /** anticraft 登录使用的服务地址，默认 https://anticraft.top */
  anticraft_base: string
  /** anticraft 绑定应用 client_id（空串表示未配置） */
  anticraft_client_id: string
  /** anticraft 绑定应用 client_secret：后端只回掩码 ******，未配置时为空串 */
  anticraft_client_secret: string
  /** 允许发起授权的来源白名单（逗号分隔，如 http://127.0.0.1:8301,http://localhost:3010） */
  anticraft_origins: string
  /** anticraft 管理员用户名（逗号分隔）：这些账号用 anticraft 登录/绑定时本地给 admin */
  anticraft_admin_users: string
}

/** anticraft 授权码登录的配置状态：enabled 为 false 时登录页禁用跳转按钮 */
export interface AnticraftOauthStatus {
  enabled: boolean
  base: string
}

/** 用户管理页的行（root/管理员可见） */
export interface AdminUserRow {
  id: number
  username: string
  role: Role
  source: string
  anticraft_id: number | null
  created_at: string
  job_count: number
}
