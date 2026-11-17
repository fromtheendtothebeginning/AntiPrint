// 后端接口类型定义（与 backend 的 schema 手工同步，改一端必须同步另一端）

export type Role = 'user' | 'admin' | 'root'

export interface User {
  id: number
  username: string
  role: Role
  /** 账号来源（如 anticraft）；早期本地账号可能没有该字段 */
  source?: string
  /** 已绑定的手机号（11 位，空串 = 未绑定） */
  phone?: string
  /** 手机号是否已通过短信验证；未验证的账号不能提交任务/充值 */
  phone_verified?: boolean
}

/** 配送方式：用户提交时选（默认取用户配置），决定打印完成后进「待配送」还是「待取件」 */
export type DeliveryMode = '配送' | '取件'

/** 任务状态：固定中文字面量，前后端共享，勿改字面量 */
export type JobStatus =
  | '待支付'
  | '待审核'
  | '已通过'
  | '打印中'
  | '已打印'
  | '已驳回'
  | '打印失败'
  | '待配送'
  | '待取件'
  | '已完成'
  | '已撤回'

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
  /** 本单实际扣费（元，0 = 免费账号或已退费） */
  charge?: number | string
  /** 支付方式：balance = 余额扣费；alipay = 即时付款 */
  pay_method?: 'balance' | 'alipay'
  files: JobFile[]
}

/** 提交打印任务的返回（即时付款时带收银台地址） */
export interface SubmitJobResult {
  job: Job
  charge: string
  balance: string
  pay_mode: 'balance' | 'instant'
  out_trade_no?: string
  pay_url?: string
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
  /** 账户余额（元） */
  balance: number | string
  /** 是否要花钱打印（管理员/anticraft/白名单为 false） */
  billable: boolean
  /** 免费原因（免费账号才有） */
  free_reason: string
  /** 当前单价展示文本，如「0.1 元/张」 */
  price: string
  /** 头像文件名（空串 = 没设置，用首字母占位） */
  avatar: string
  /** 已绑定手机号（空串 = 未绑定） */
  phone: string
  /** 手机号是否已通过短信验证 */
  phone_verified: boolean
}

/** 余额流水（扣费/退费/管理员调账） */
export interface BalanceLog {
  id: number
  delta: number | string
  balance_after: number | string
  reason: string
  job_id: number | null
  actor: string | null
  created_at: string
}

/** 我的余额页数据 */
export interface BalanceInfo {
  balance: number | string
  billable: boolean
  free_reason: string
  price: string
  logs: BalanceLog[]
  /** 充值是否已开放（支付宝已配置或本地 mock 模式） */
  recharge_enabled: boolean
  /** 快捷充值档位（元） */
  recharge_amounts: number[]
  /** 充值赠送比例（50 = 充 10 到账 15） */
  recharge_bonus_percent: number
  /** 可用支付渠道 */
  pay_channels: string[]
}

/** 充值订单 */
export interface PaymentOrder {
  id: number
  out_trade_no: string
  user_id: number
  amount: number | string
  channel: string
  status: 'pending' | 'paid' | 'closed' | 'failed' | string
  provider_txn_id: string | null
  paid_at: string | null
  created_at: string
  updated_at: string
}

/** 创建充值订单的返回 */
export interface RechargeResult {
  out_trade_no: string
  amount: string
  /** 实际到账金额（含赠送） */
  credit_amount: string
  bonus_percent: number
  pay_url: string
  mock: boolean
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
  /** 打印代理连接开关：'1' = 已连接（默认），'0' = 管理员在管理设置里断开了代理 */
  agent_enabled: string
  /** 每张打印单价（元） */
  print_price: string
  /** 免费打印白名单（用户名，逗号分隔） */
  free_users: string
  /** 是否在每次出纸前先打一张任务信息页：'1' = 打（默认），'0' = 不打 */
  cover_page: string
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
  /** 账户余额（元） */
  balance: number | string
  /** 已绑定手机号（空/缺省 = 未绑定） */
  phone?: string | null
  /** 手机号验证时间（空 = 未验证） */
  phone_verified_at?: string | null
}

/** API 文档页（管理员可在页面上直接改，正文是 Markdown） */
export interface ApiDocs {
  content: string
  /** false = 用的是出厂默认文档（管理员没改过） */
  custom: boolean
  updated_at: string
  updated_by: string
}

/** 虚拟打印机安装包（一个平台一条） */
export interface DownloadPackage {
  id: string
  label: string
  arch: string
  requirements: string
  note: string
  /** 是否已开放下载（暂未开放的平台只有说明） */
  open: boolean
  /** 服务器上是否真的放了这个包 */
  ready: boolean
  filename: string
  version: string
  size: number
  size_text: string
  sha256: string
  updated_at: number
}

/** MCP / 脚本用的长期 API 令牌（库里只存哈希，明文只在生成时返回一次） */
export interface ApiToken {
  id: number
  user_id: number
  name: string
  /** 展示前缀（ap_ 开头的前 12 位），用来区分不同令牌 */
  prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  username?: string
}
