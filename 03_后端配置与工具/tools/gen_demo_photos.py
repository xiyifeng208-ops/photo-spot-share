"""生成 6 张"示例样张"，给演示数据用（没有真实照片时不至于让卡片全空着）。

用法：
    python tools/gen_demo_photos.py [输出目录]

输出：默认写到 work/demo-photos/，文件名与演示机位一一对应。
拿到真实照片后，把照片丢进同一个目录再跑 tools/import-demo-photos.mjs 即可覆盖。

这些是**风格化示意图**，不是真实照片，右下角会标注"示例样张"。
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ROOT = 项目根（outputs/photo-spot-share），演示照片放在会话根目录的 work/ 下（不进版本库）
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent.parent / "work" / "demo-photos"

W, H = 1200, 900

# (关键词, 主标题, 副标题, 天空渐变起止色, 剪影色, 场景)
# 关键词会写进文件名（01-外滩.jpg），导入脚本按它匹配机位标题
SCENES = [
    ("外滩", "外滩 三件套压角", "日落 · 长焦", (255, 176, 118), (58, 44, 66), "skyline"),
    ("武康大楼", "武康大楼 街角对称", "上午 · 标准焦段", (186, 214, 238), (86, 76, 70), "corner"),
    ("西湖", "西湖 断桥晨雾", "日出 · 长焦", (226, 232, 214), (120, 132, 118), "lake"),
    ("李子坝", "李子坝 轻轨穿楼", "下午 · 标准焦段", (208, 214, 226), (74, 78, 88), "tower"),
    ("陆家嘴", "陆家嘴 天桥车流长曝", "夜景 · 超广角", (28, 34, 62), (18, 20, 32), "night"),
    ("洱海", "洱海 日出礁石", "日出 · 航拍", (255, 214, 170), (92, 96, 110), "lake"),
]


def font(size: int):
    for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def gradient(top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(image)
    for y in range(H):
        t = y / (H - 1)
        draw.line(
            [(0, y), (W, y)],
            fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return image


def draw_scene(draw: ImageDraw.ImageDraw, kind: str, silhouette: tuple[int, int, int]) -> None:
    horizon = int(H * 0.62)
    if kind == "skyline":
        draw.rectangle([0, horizon, W, H], fill=silhouette)
        for x, w, h in ((80, 90, 260), (200, 70, 380), (300, 110, 300), (440, 60, 470),
                        (520, 130, 250), (680, 80, 330), (790, 100, 420), (920, 70, 280), (1020, 90, 360)):
            draw.rectangle([x, horizon + (300 - h), x + w, horizon + 300], fill=silhouette)
    elif kind == "night":
        draw.rectangle([0, horizon + 40, W, H], fill=silhouette)
        for x, w, h in ((60, 110, 520), (220, 90, 620), (360, 140, 460), (560, 120, 700),
                        (740, 100, 540), (900, 130, 640), (1060, 90, 480)):
            draw.rectangle([x, H - h, x + w, H], fill=silhouette)
        for i in range(220):
            x = (i * 97) % W
            y = (i * 53) % 260 + 40
            draw.point((x, y), fill=(255, 236, 180))
    elif kind == "corner":
        draw.polygon([(0, H), (0, horizon + 60), (W, horizon - 40), (W, H)], fill=silhouette)
        draw.rectangle([120, horizon - 240, 520, horizon + 60], fill=silhouette)
    elif kind == "tower":
        draw.rectangle([0, horizon + 60, W, H], fill=silhouette)
        draw.rectangle([430, 120, 780, H], fill=silhouette)
        draw.rectangle([380, 300, 830, 360], fill=tuple(min(255, c + 26) for c in silhouette))
    else:  # lake
        draw.rectangle([0, horizon, W, H], fill=silhouette)
        draw.ellipse([-200, horizon - 40, 500, horizon + 90], fill=tuple(min(255, c + 18) for c in silhouette))
        draw.line([(0, horizon + 150), (W, horizon + 130)], fill=(255, 255, 255), width=6)
        draw.line([(0, horizon + 210), (W, horizon + 195)], fill=(255, 255, 255), width=3)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    title_font = font(46)
    sub_font = font(26)
    tag_font = font(20)

    for index, (keyword, title, subtitle, sky, silhouette, kind) in enumerate(SCENES, start=1):
        image = gradient(sky, tuple(max(0, c - 40) for c in sky))
        draw = ImageDraw.Draw(image)
        draw_scene(draw, kind, silhouette)

        # 半透明标题条
        bar = Image.new("RGBA", (W, 150), (0, 0, 0, 110))
        image.paste(Image.alpha_composite(image.crop((0, H - 150, W, H)).convert("RGBA"), bar).convert("RGB"), (0, H - 150))

        draw = ImageDraw.Draw(image)
        draw.text((48, H - 118), title, font=title_font, fill=(255, 255, 255))
        draw.text((48, H - 58), subtitle, font=sub_font, fill=(226, 232, 240))
        draw.text((W - 170, 40), "示例样张", font=tag_font, fill=(255, 255, 255))

        path = OUT_DIR / f"{index:02d}-{keyword}.jpg"
        image.save(path, quality=88)
        print(f"生成 {path}  ({path.stat().st_size // 1024} KB)")

    print(f"\n共 {len(SCENES)} 张，输出目录：{OUT_DIR}")
    print("有真实照片时，把它们覆盖到同名文件再跑 tools/import-demo-photos.mjs 即可。")


if __name__ == "__main__":
    main()
