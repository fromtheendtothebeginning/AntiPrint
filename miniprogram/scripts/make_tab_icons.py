"""生成小程序底部 tabBar 图标（4 个 × 未选中/选中 = 8 张 81×81 PNG）。

图标与品牌同色系：未选中 #8a8a86（灰）、选中 #4a9d9a（品牌青绿），透明底。
纯标准库（zlib + struct 手写 PNG，不引 Pillow）。

标的四个图标（24 网格里手绘，风格贴近 lucide 线性图标）：
  submit  提交打印 —— 向上箭头 + 托盘（上传）
  jobs    我的任务 —— 文档 + 三条文本线
  balance 我的余额 —— 圆币 + ¥
  profile 我的配置 —— 三条滑杆 + 圆点

产物：miniprogram/tabbar/{submit,jobs,balance,profile}[-on].png
改图标后重跑：backend\\.venv\\Scripts\\python.exe miniprogram/scripts/make_tab_icons.py
"""
import math
import pathlib
import struct
import zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "tabbar"
OUT.mkdir(parents=True, exist_ok=True)

SIZE = 81                 # 微信推荐 81×81
GRID = 24.0               # 设计网格（lucide 同款）
GLYPH = 60.0              # 图标实际占的像素（81 里留边）
SCALE = GLYPH / GRID
OFFSET = (SIZE - GLYPH) / 2.0
STROKE = 2.0 * SCALE      # 线宽（2 个网格单位）
NORMAL = (0x8A, 0x8A, 0x86, 255)
SELECTED = (0x4A, 0x9D, 0x9A, 255)


def to_px(x, y):
    return OFFSET + x * SCALE, OFFSET + y * SCALE


def dist_to_segment(px, py, x0, y0, x1, y1):
    dx, dy = x1 - x0, y1 - y0
    length2 = dx * dx + dy * dy
    if length2 == 0:
        return math.hypot(px - x0, py - y0)
    t = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / length2))
    return math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))


def dist_to_round_rect(px, py, x0, y0, x1, y1, radius):
    cx = max(x0 + radius, min(px, x1 - radius))
    cy = max(y0 + radius, min(py, y1 - radius))
    outside = math.hypot(px - cx, py - cy) if (px < x0 + radius or px > x1 - radius) and (py < y0 + radius or py > y1 - radius) else 0.0
    if outside:
        return outside - radius
    inner_x = min(px - x0, x1 - px)
    inner_y = min(py - y0, y1 - py)
    return -min(inner_x, inner_y)


def make_shape(name):
    """返回 (是否命中轮廓) 的判定函数，坐标在 24 网格里"""
    segments = []
    circles = []
    boxes = []
    dots = []

    if name == "submit":
        # 向上箭头 + 托盘
        segments += [((12, 15), (12, 4))]
        segments += [((6.5, 9.5), (12, 4)), ((17.5, 9.5), (12, 4))]
        segments += [((5, 16), (5, 20)), ((5, 20), (19, 20)), ((19, 20), (19, 16))]
    elif name == "jobs":
        boxes.append((5, 3, 19, 21, 2.2))
        segments += [((8.5, 9), (15.5, 9)), ((8.5, 12.5), (15.5, 12.5)), ((8.5, 16), (13, 16))]
    elif name == "balance":
        circles.append((12, 12, 9.0))
        # ¥：两撇 + 一竖 + 两横
        segments += [((8.6, 8), (12, 11.6)), ((15.4, 8), (12, 11.6))]
        segments += [((12, 11.6), (12, 17.5))]
        segments += [((8.6, 13.4), (15.4, 13.4)), ((8.6, 15.8), (15.4, 15.8))]
    elif name == "profile":
        segments += [((4, 7), (20, 7)), ((4, 12.5), (20, 12.5)), ((4, 18), (20, 18))]
        dots += [(9, 7, 2.6), (15, 12.5, 2.6), (9, 18, 2.6)]
    else:
        raise SystemExit(f"未知图标：{name}")

    def hit(px, py):
        for (x0, y0), (x1, y1) in segments:
            ax, ay = to_px(x0, y0)
            bx, by = to_px(x1, y1)
            if dist_to_segment(px, py, ax, ay, bx, by) <= STROKE / 2:
                return True
        for cx, cy, r in circles:
            ax, ay = to_px(cx, cy)
            if abs(math.hypot(px - ax, py - ay) - r * SCALE) <= STROKE / 2:
                return True
        for x0, y0, x1, y1, radius in boxes:
            ax, ay = to_px(x0, y0)
            bx, by = to_px(x1, y1)
            if abs(dist_to_round_rect(px, py, ax, ay, bx, by, radius * SCALE)) <= STROKE / 2:
                return True
        for cx, cy, r in dots:
            ax, ay = to_px(cx, cy)
            if math.hypot(px - ax, py - ay) <= r * SCALE:
                return True
        return False

    return hit


def render(name, color):
    hit = make_shape(name)
    samples = 4
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)
        for x in range(SIZE):
            covered = 0
            for sx in range(samples):
                for sy in range(samples):
                    px = x + (sx + 0.5) / samples
                    py = y + (sy + 0.5) / samples
                    if hit(px, py):
                        covered += 1
            alpha = int(255 * covered / (samples * samples))
            raw.extend(bytes((color[0], color[1], color[2], alpha)))

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    return png


for icon in ("submit", "jobs", "balance", "profile"):
    (OUT / f"{icon}.png").write_bytes(render(icon, NORMAL))
    (OUT / f"{icon}-on.png").write_bytes(render(icon, SELECTED))
    print(f"  tabbar/{icon}.png + {icon}-on.png")

print(f"\n图标已生成到 {OUT}")
