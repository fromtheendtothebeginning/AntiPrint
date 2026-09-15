# constants.py — 状态字符串与上传扩展名黑白名单（前端 src/constants.ts 需与本文件同步）

# ── 任务状态机（固定中文字符串，改动必须前后端同步）──
# 待审核 → 已通过 → 打印中 → 已打印 →（按配送方式）待配送 / 待取件 → 已完成
#          ↗（重试）  ↘（失败）打印失败
# 待审核 → 已驳回 →（本人重提）→ 待审核
S_PENDING = "待审核"
S_APPROVED = "已通过"
S_PRINTING = "打印中"
S_PRINTED = "已打印"
S_REJECTED = "已驳回"
S_FAILED = "打印失败"
S_AWAIT_DELIVERY = "待配送"
S_AWAIT_PICKUP = "待取件"
S_DONE = "已完成"

STATUSES = (
    S_PENDING, S_APPROVED, S_PRINTING, S_PRINTED, S_REJECTED, S_FAILED,
    S_AWAIT_DELIVERY, S_AWAIT_PICKUP, S_DONE,
)

# ── 配送方式（用户在提交页选，默认取用户配置里的 default_delivery）──
DELIVER = "配送"      # 打印好后要送到配送地址
PICKUP = "取件"       # 用户自己来取
DELIVERY_MODES = (DELIVER, PICKUP)

# ── 打印设置（提交页可选；取值直接对应 SumatraPDF -print-settings 的参数，代理侧原样拼进命令）──
# 注：目标机型 HP LaserJet Professional P1106 是黑白激光、无自动双面单元，
#     因此不提供「双面」「彩色」选项（2026-09-15 按用户要求移除）。
PRINT_PAPER = ("A4", "A3", "A5", "B5", "Letter", "Legal")    # 纸张大小
PRINT_NUP = ("1,1", "2,1", "1,2", "2,2", "3,3", "4,4")       # 每张纸排几页（行,列）
PRINT_SCALE = ("fit", "noscale", "shrink")                   # 适应纸张 / 实际大小 / 缩小到可打印区域
PRINT_COPIES_MAX = 99
PAGE_RANGE_MAX_LEN = 64                                      # 页面范围形如 1-3,5,8-

# 打印完成后的交接流转（管理员在任务队列里勾选）：
#   已打印 →（配送单）待配送 /（取件单）待取件 → 已完成
# 值 = 该目标状态要求的配送方式（None = 不限）；配送单不能进「待取件」，反之亦然
HANDOVER_NEXT = {
    S_PRINTED: {S_AWAIT_DELIVERY: DELIVER, S_AWAIT_PICKUP: PICKUP},
    S_AWAIT_DELIVERY: {S_DONE: None},
    S_AWAIT_PICKUP: {S_DONE: None},
}

# 可静默打印的白名单：PDF 与图片（Office 转换未定，一律拒绝）
PRINTABLE_EXT = {".pdf", ".png", ".jpg", ".jpeg"}

# 危险类型黑名单：可执行/脚本/网页/含宏 Office 等，命中直接 400
DANGEROUS_EXT = {
    ".exe", ".dll", ".bat", ".cmd", ".com", ".msi", ".scr", ".pif",
    ".sh", ".bash", ".ps1", ".vbs", ".js", ".jse", ".wsf",
    ".hta", ".html", ".htm", ".svg", ".xml",
    ".php", ".php3", ".php5", ".asp", ".aspx", ".jsp", ".cgi",
    ".jar", ".apk", ".reg", ".py", ".rb", ".pl",
    ".docm", ".xlsm", ".pptm", ".mht", ".mhtml",
}
