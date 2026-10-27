#!/usr/bin/env python3
"""从北邮官方校徽生成安卓通知图标（单色 alpha 剪影）。

素材来源（官方渠道）：
  1. `https://www.bupt.edu.cn/bygk/zjby/bywh.htm` 页面上的校徽 PNG
     → 下载为 `.assets/crest/crest.png`（271x271，navy 墨迹 + 透明底）。**本脚本只用这份。**
  2. `https://www.bupt.edu.cn/images/zdsc.zip` 北邮 VI 源文件包（44MB，PSD/PDF）
     → 只作为「素材确属官方旗舰」的凭据，用完即删，不入库。

为什么只输出白色 + alpha：
  安卓对通知小图标（setSmallIcon）**只取 alpha 通道**，颜色一律丢弃并强制
  单色着色。所以这里每个像素都必须是白色，信息全在 alpha 里。

为什么不做二值化、不做膨胀：
  实测官方徽标的内环是「一整块实心图形 + 留白缺口」，不是细线条。做形态学
  膨胀会把缺口填死，24dp 下退化成一块无意义的色块。保留 LANCZOS 抗锯齿的
  柔和 alpha，缩小后是干净的微缩徽标。

用法：
  python scripts/make-crest-icon.py            # 导出到 android/res/drawable-*/
  python scripts/make-crest-icon.py --preview  # 额外导出对比图到 .assets/crest/out/
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / '.assets/crest/crest.png'
OUT = ROOT / '.assets/crest/out'

# 官方图 271x271，实测几何
CX = CY = 135.0
R_OUT = 134.0        # 外圆描边中心
R_IN = 105.5         # 内圆描边中心
TEXT_BAND = (109.0, 131.0)  # 环形文字所在的带子（两圆之间）

# 各密度下 24dp 对应的像素边长
DENSITIES = {
    'mdpi': 24,
    'hdpi': 36,
    'xhdpi': 48,
    'xxhdpi': 72,
    'xxxhdpi': 96,
}

# 启动图标是 48dp（legacy icon，系统再套自己的形状遮罩）
LAUNCHER_DENSITIES = {
    'mdpi': 48,
    'hdpi': 72,
    'xhdpi': 96,
    'xxhdpi': 144,
    'xxxhdpi': 192,
}

# 官方校徽实测主墨色（271px 母图上取不透明深色像素的中位数）
NAVY = (1, 58, 137)
WHITE = (255, 255, 255)


def load_ink():
    """官方 PNG → alpha 0..1 浮点阵（不透明且偏深的像素视为墨迹）。"""
    a = np.array(Image.open(SRC).convert('RGBA')).astype(float)
    rgb_sum = a[:, :, :3].sum(axis=2)
    opaque = a[:, :, 3] / 255.0
    # navy 的 RGB 和约 196，白约 765；取中间值避免把描边抗锯齿边当墨
    dark = np.clip((650 - rgb_sum) / 200.0, 0.0, 1.0)
    return opaque * dark


def radius_map(shape):
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    return np.hypot(xx - CX, yy - CY)


def drop_ring_text(ink):
    """抹掉两圆之间的环形文字，保留两条圆本身。"""
    r = radius_map(ink.shape)
    band = (r > TEXT_BAND[0]) & (r < TEXT_BAND[1])
    return ink * (1.0 - band)


def union_circles(ink):
    """按实测半径把两条圆补回来，避免去文字时把圆也啃掉一块。"""
    r = radius_map(ink.shape)
    ring_out = np.clip(1.5 - np.abs(r - R_OUT), 0.0, 1.0)
    ring_in = np.clip(1.2 - np.abs(r - R_IN), 0.0, 1.0)
    return np.maximum(ink, np.maximum(ring_out, ring_in))


def crop_center(ink, radius):
    """以圆心裁一个正方形，只留 radius 内的内容。"""
    x0, y0 = int(round(CX - radius)), int(round(CY - radius))
    size = int(round(radius * 2))
    return ink[y0:y0 + size, x0:x0 + size]


def to_rgba(alpha):
    """0..1 alpha → 白色 RGBA（RGB 恒 255，信息只在 alpha）。"""
    a = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    out = np.zeros((*alpha.shape, 4), dtype=np.uint8)
    out[:, :, :3] = 255
    out[:, :, 3] = a
    return Image.fromarray(out, 'RGBA')


def fit_square(img, size, fill=0.88):
    """把图缩放进 size×size 的画布，四周留白避免贴边被切。"""
    inner = max(1, int(round(size * fill)))
    scaled = img.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    off = (size - inner) // 2
    canvas.alpha_composite(scaled, (off, off))
    return canvas


def build_variants(ink):
    """三种构图。a=完整徽（去文字），b=内环徽标（带内圆），c=纯徽标无圆。

    c 会把内圆那条 1.5px 细环**整条剔掉**：母图 271px 里 1.5px 的描边压到 24dp
    只剩 0.13px，抗锯齿后变成断断续续的碎弧——比没有还难看。实测过，只有剔干净
    才是干净的剪影。
    """
    clean = union_circles(drop_ring_text(ink))
    r = radius_map(clean.shape)
    return {
        'a-full': clean,
        'b-inner': crop_center(clean, 108),
        'c-mark': crop_center(clean * (r <= R_IN - 3.5), 103),
    }


def export_res(variants, name='c-mark'):
    """导出到 android/res/drawable-<density>/ic_crest_mono.png。

    放 drawable 而不是 mipmap：mipmap 是留给启动图标的（R.mipmap.*），
    通知小图标用 R.drawable.* 引用是安卓的惯例，两者生成的资源 id 命名空间不同。
    """
    src = variants[name]
    base = to_rgba(src)
    # 只留徽标主体的版本四周不需要留那么多空，尽量撑满 24dp
    fill = 0.96 if name == 'c-mark' else 0.88
    for dens, px in DENSITIES.items():
        d = ROOT / f'android/res/drawable-{dens}'
        d.mkdir(parents=True, exist_ok=True)
        fit_square(base, px, fill).save(d / 'ic_crest_mono.png')
    # 高分辨率版本留作预览与其它用途
    fit_square(base, 192, fill).save(OUT / 'ic_crest_mono-192.png')
    print(f'导出 {name}: {", ".join(f"{k}={v}px" for k, v in DENSITIES.items())}')


def tint(alpha, rgb):
    """0..1 alpha → 指定颜色的 RGBA。同一份形状既能做白色剪影也能做藏青墨迹。"""
    a = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    out = np.zeros((*alpha.shape, 4), dtype=np.uint8)
    out[:, :, 0], out[:, :, 1], out[:, :, 2] = rgb
    out[:, :, 3] = a
    return Image.fromarray(out, 'RGBA')


def export_launcher(variants, name='c-mark', fill=0.62):
    """藏青底 + 白色徽标 → android/res/mipmap-<density>/ic_launcher.png

    ★ 为什么必须换启动图标：ColorOS 的通知卡片左侧取的是**应用图标**，
    不是 setSmallIcon 那个通知小图标（真机实测：改 smallIcon 后该位置仍是
    绿底白日历的旧 launcher）。所以想让校徽出现在那里，只有换启动图标一条路。
    """
    base = tint(variants[name], WHITE)
    for dens, px in LAUNCHER_DENSITIES.items():
        d = ROOT / f'android/res/mipmap-{dens}'
        d.mkdir(parents=True, exist_ok=True)
        canvas = Image.new('RGBA', (px, px), (*NAVY, 255))
        inner = max(1, int(round(px * fill)))
        canvas.alpha_composite(
            base.resize((inner, inner), Image.LANCZOS),
            ((px - inner) // 2, (px - inner) // 2))
        canvas.save(d / 'ic_launcher.png')
    print(f'导出启动图标: {", ".join(f"{k}={v}px" for k, v in LAUNCHER_DENSITIES.items())}')


def export_preview(variants):
    """深/浅底、多倍率拼一张，肉眼验收 24dp 到底能不能认出来。"""
    OUT.mkdir(parents=True, exist_ok=True)
    order = ['a-full', 'b-inner', 'c-mark']
    sizes = [24, 36, 48]
    zoom = 6
    cell = 48 * zoom
    pad = 16
    W = pad + len(order) * (cell * len(sizes) + pad * 2)
    H = pad * 2 + 2 * (cell + 28) + 8
    sheet = Image.new('RGBA', (W, H), (18, 18, 18, 255))
    d = ImageDraw.Draw(sheet)
    for row, (bg, tag) in enumerate([((18, 18, 18, 255), '深色'), ((246, 246, 246, 255), '浅色')]):
        y0 = pad + row * (cell + 28)
        d.rectangle([0, y0 - 18, W, y0 + cell + 6], fill=bg)
        for ci, key in enumerate(order):
            x = pad + ci * (cell * len(sizes) + pad * 2)
            d.text((x, y0 - 14), f'{key} / {tag}', fill=(150, 150, 150, 255))
            xx = x
            for s in sizes:
                icon = fit_square(to_rgba(variants[key]), s)
                if bg[0] > 128:  # 浅底上白图标看不见，换成黑色展示
                    a = icon.split()[3]
                    icon = Image.merge('RGBA', (Image.new('L', icon.size, 0),) * 3 + (a,))
                big = icon.resize((s * zoom, s * zoom), Image.NEAREST)
                sheet.alpha_composite(big, (xx, y0))
                d.text((xx, y0 + s * zoom + 2), f'{s}px', fill=(110, 110, 110, 255))
                xx += s * zoom + 12
    sheet.save(OUT / '_preview.png')
    print('预览图', OUT / '_preview.png')


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', action='store_true', help='额外导出对比图')
    ap.add_argument('--variant', default='c-mark', choices=['a-full', 'b-inner', 'c-mark'])
    args = ap.parse_args(argv)
    if not SRC.exists():
        print(f'缺少素材 {SRC}', file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    variants = build_variants(load_ink())
    export_res(variants, args.variant)
    export_launcher(variants, args.variant)
    if args.preview:
        export_preview(variants)
    return 0


if __name__ == '__main__':
    sys.exit(main())
