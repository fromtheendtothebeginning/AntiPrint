"""生成站点图标（favicon）——与侧栏 logo 完全一致：
   品牌绿圆角方块（36×36、圆角 12，对应 Tailwind 的 h-9 w-9 rounded-xl bg-brand）
   + lucide-react 的 Printer 图标（h-5 w-5，白色描边、圆头圆角）

产物：
   favicon.svg           现代浏览器（矢量）
   favicon.ico           老浏览器 / Windows 快捷方式（内嵌 16/32/48 PNG）
   apple-touch-icon.png  iOS 主屏（180px）
纯标准库实现（zlib + struct 手写 PNG/ICO，不引 Pillow、不起浏览器）。

改图标后重跑：backend\\.venv\\Scripts\\python.exe frontend/scripts/make_favicon.py
"""
import math
import pathlib
import struct
import zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "public"
OUT.mkdir(parents=True, exist_ok=True)

BRAND = (0x4A, 0x9D, 0x9A, 255)      # --color-brand #4a9d9a
WHITE = (255, 255, 255, 255)

# ── 与 lucide-react v1.46.0 的 printer.mjs 完全相同的三条路径 ──
LUCIDE_PATHS = (
    "M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2",
    "M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6",
)
LUCIDE_RECT = {"x": 6, "y": 14, "width": 12, "height": 8, "rx": 1}

# 侧栏 logo 的排版：36px 方块里放 20px 图标 → 图标占 20/36，居中偏移 8
BOX = 36.0
GLYPH = 20.0
SCALE = GLYPH / 24.0                 # lucide 图标本身是 24 网格
OFFSET = (BOX - GLYPH) / 2.0
STROKE = 2.0                         # lucide 默认 stroke-width


def _to_box(x, y):
    """lucide 24 网格坐标 → 36 网格坐标（与 SVG 里的 translate/scale 一致）"""
    return OFFSET + x * SCALE, OFFSET + y * SCALE


def _arc(cx, cy, r, start_deg, end_deg, steps=12):
    """按角度采样圆弧（y 向下坐标系，角度用 atan2(dy, dx)）"""
    pts = []
    for i in range(steps + 1):
        angle = math.radians(start_deg + (end_deg - start_deg) * i / steps)
        pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return pts


def lucide_printer_paths():
    """把 lucide 的三条路径各自展开成折线（直线 + 四分之一圆角）。
    三条必须彼此独立——连成一条会在形状之间画出多余的对角线（踩过）。"""
    pts = []
    # 路径一：机身轮廓（左→下→上→右，含 4 个 r=2 圆角）
    pts += [(6, 18), (4, 18)]
    pts += _arc(4, 16, 2, 90, 180)
    pts += [(2, 11)]
    pts += _arc(4, 11, 2, 180, 270)
    pts += [(20, 9)]
    pts += _arc(20, 11, 2, 270, 360)
    pts += [(22, 16)]
    pts += _arc(20, 16, 2, 0, 90)
    pts += [(18, 18)]
    paths = [pts]

    # 路径二：上方进纸的纸
    pts = [(6, 9), (6, 3)]
    pts += _arc(7, 3, 1, 180, 270)
    pts += [(17, 2)]
    pts += _arc(17, 3, 1, 270, 360)
    pts += [(18, 9)]
    paths.append(pts)

    # 路径三：出纸口的方框（rect x=6 y=14 w=12 h=8 rx=1）
    pts = []
    x0, y0 = LUCIDE_RECT["x"], LUCIDE_RECT["y"]
    x1, y1 = x0 + LUCIDE_RECT["width"], y0 + LUCIDE_RECT["height"]
    r = LUCIDE_RECT["rx"]
    pts += [(x0 + r, y0), (x1 - r, y0)]
    pts += _arc(x1 - r, y0 + r, r, 270, 360)
    pts += [(x1, y1 - r)]
    pts += _arc(x1 - r, y1 - r, r, 0, 90)
    pts += [(x0 + r, y1)]
    pts += _arc(x0 + r, y1 - r, r, 90, 180)
    pts += [(x0, y0 + r)]
    pts += _arc(x0 + r, y0 + r, r, 180, 270)
    paths.append(pts)
    return [[_to_box(x, y) for x, y in path] for path in paths]


GLYPH_PATHS = lucide_printer_paths()
HALF_STROKE = (STROKE / 2.0) * SCALE


def _seg_distance(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def on_glyph(px, py):
    """点是否落在 lucide 图标的描边上（到各条折线的距离 ≤ 半个描边宽）"""
    for path in GLYPH_PATHS:
        for i in range(len(path) - 1):
            ax, ay = path[i]
            bx, by = path[i + 1]
            if _seg_distance(px, py, ax, ay, bx, by) <= HALF_STROKE:
                return True
    return False


def inside_background(px, py):
    """品牌绿圆角方块：36×36、圆角 12（对应 rounded-xl）"""
    radius = 12.0
    if not (0 <= px <= BOX and 0 <= py <= BOX):
        return False
    # 只在点所在的那个角落做圆角判定（拿所有角一起比会把中间区域也判成外面）
    if px < radius and py < radius:
        return math.hypot(px - radius, py - radius) <= radius
    if px > BOX - radius and py < radius:
        return math.hypot(px - (BOX - radius), py - radius) <= radius
    if px < radius and py > BOX - radius:
        return math.hypot(px - radius, py - (BOX - radius)) <= radius
    if px > BOX - radius and py > BOX - radius:
        return math.hypot(px - (BOX - radius), py - (BOX - radius)) <= radius
    return True


def pixel(x, y, size):
    """按 36 网格反算像素中心，4×4 超采样抗锯齿"""
    samples = 4
    r = g = b = a = 0
    for sx in range(samples):
        for sy in range(samples):
            px = (x + (sx + 0.5) / samples) * BOX / size
            py = (y + (sy + 0.5) / samples) * BOX / size
            if not inside_background(px, py):
                color = (0, 0, 0, 0)
            elif on_glyph(px, py):
                color = WHITE
            else:
                color = BRAND
            r += color[0]; g += color[1]; b += color[2]; a += color[3]
    n = samples * samples
    return (r // n, g // n, b // n, a // n)


def make_png(size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(pixel(x, y, size))

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    return png


def make_ico(sizes):
    """ICO 内嵌 PNG（Vista 以后都支持）"""
    images = [(size, make_png(size)) for size in sizes]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + entries + blobs


# ── SVG：与侧栏 logo 同款（品牌方块 + lucide Printer 白色描边） ──
svg_paths = "\n".join(f'  <path d="{d}" />' for d in LUCIDE_PATHS)
SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {BOX:g} {BOX:g}" role="img" aria-label="AntiPrint">
  <!-- 与侧栏 logo 一致：bg-brand 圆角方块 + lucide Printer（h-5 w-5 白色描边） -->
  <rect width="{BOX:g}" height="{BOX:g}" rx="12" fill="#4a9d9a"/>
  <g transform="translate({OFFSET:g},{OFFSET:g}) scale({SCALE:.6f})"
     fill="none" stroke="#ffffff" stroke-width="{STROKE:g}" stroke-linecap="round" stroke-linejoin="round">
{svg_paths}
    <rect x="{LUCIDE_RECT['x']}" y="{LUCIDE_RECT['y']}" width="{LUCIDE_RECT['width']}" height="{LUCIDE_RECT['height']}" rx="{LUCIDE_RECT['rx']}" />
  </g>
</svg>
"""

(OUT / "favicon.svg").write_text(SVG, encoding="utf-8")
(OUT / "favicon.ico").write_bytes(make_ico([16, 32, 48]))
(OUT / "apple-touch-icon.png").write_bytes(make_png(180))
for name in ("favicon.svg", "favicon.ico", "apple-touch-icon.png"):
    print(f"  {name}: {(OUT / name).stat().st_size} 字节")
